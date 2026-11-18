// ============================================================================
// PULSE Workforce OS — Employee documents (Passport / Visa / Contract) vault
// ----------------------------------------------------------------------------
// Per-employee identity documents attached on the Add/Edit Employee form and
// shown (preview / print / replace / delete) on the Employee Details page.
//
//   passport  — passport scan (PDF or image)
//   visa      — visa / residence permit scan
//   contract  — employment contract scan
//
// SECURITY: every file is encrypted in the BROWSER with AES-256-GCM before it
// is written to storage, and decrypted only in memory for preview/print:
//   • the key lives in a one-row `document_vault_key` table (Supabase mode)
//     or the local demo store (demo mode) — never inside the bucket;
//   • the stored object is `iv(12 bytes) + ciphertext` under
//     emp_<employeeId>/<kind>.<ext>.bin — even a leaked storage URL or a
//     database dump of the bucket reveals nothing usable;
//   • the bucket itself is PRIVATE (policies for authenticated admins only —
//     run supabase/migrations/20261118b_employee_documents.sql once).
//
// Two interchangeable backends behind one interface (same shape as the site
// documents facade):
//   PROD — Supabase Storage bucket 'employee-documents'
//   DEMO — an IndexedDB "mini bucket" holding the same encrypted blobs
//
// Object identity is the PATH, so re-uploading a slot replaces its file.
// ============================================================================

import { isDemoMode } from '@/lib/data';
import { supabase } from '@/lib/supabase/client';

export type EmployeeDocKind = 'passport' | 'visa' | 'contract';

export interface EmployeeDoc {
  employeeId: string;
  kind: EmployeeDocKind;
  /** display name, e.g. "Passport (PDF)" */
  name: string;
  /** original extension without the dot, lowercase (pdf / jpg / png / webp) */
  ext: string;
  mime: string;
  /** original (plaintext) size in bytes — approximate in prod (ciphertext − 28) */
  size: number;
  updatedAt: string;
  /** storage path (prod) or IndexedDB key (demo) */
  path: string;
}

export const EMPLOYEE_DOC_BUCKET = 'employee-documents';
export const MAX_EMPLOYEE_DOC_SIZE = 15 * 1024 * 1024; // 15 MB (before encryption)
export const EMPLOYEE_DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp';

export const EMPLOYEE_DOC_KINDS: {
  kind: EmployeeDocKind;
  label: string;
  hint: string;
}[] = [
  { kind: 'passport', label: 'Passport', hint: 'Passport scan — auto-fills name, nationality, DOB & passport number' },
  { kind: 'visa', label: 'Visa / Permit', hint: 'Visa or residence permit — auto-fills position & nationality' },
  { kind: 'contract', label: 'Contract', hint: 'Employment contract — auto-fills position & join date' },
];

export function docKindLabel(kind: EmployeeDocKind): string {
  return EMPLOYEE_DOC_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'pdf': return 'application/pdf';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

export function isImageDoc(doc: Pick<EmployeeDoc, 'ext'>): boolean {
  return ['jpg', 'jpeg', 'png', 'webp'].includes(doc.ext.toLowerCase());
}

/** Friendly hint when Supabase storage rejects an operation because the
 *  bucket / policies / vault-key table from the migration are missing. */
export function docStorageSetupHint(message: string): string | null {
  if (/policy|rls|row-level|permission|not found|bucket/i.test(message)) {
    return `${message} — run supabase/migrations/20261118b_employee_documents.sql in the Supabase SQL editor (once), then retry.`;
  }
  if (/document_vault_key/i.test(message)) {
    return `${message} — the employee-documents migration creates this table; run supabase/migrations/20261118b_employee_documents.sql once.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// AES-256-GCM vault key — one key per organisation, stored OUTSIDE the bucket
// ---------------------------------------------------------------------------
const VAULT_KEY_LS = 'pulse_doc_vault_key_v1'; // demo mode only
let cachedKey: CryptoKey | null = null;

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** DEMO: the key lives in localStorage (the demo database is the browser). */
function demoVaultKey(): { key_b64: string } {
  const existing = localStorage.getItem(VAULT_KEY_LS);
  if (existing) return { key_b64: existing };
  const fresh = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  localStorage.setItem(VAULT_KEY_LS, fresh);
  return { key_b64: fresh };
}

/** PROD: one row in document_vault_key (id=1). Generated on first use; an
 *  insert race resolves into re-reading the winner's key. */
async function prodVaultKey(): Promise<{ key_b64: string }> {
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const read = async (): Promise<string | null> => {
    const { data, error } = await supabase!
      .from('document_vault_key')
      .select('key_b64')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(docStorageSetupHint(error.message) ?? error.message);
    return data?.key_b64 ?? null;
  };
  const existing = await read();
  if (existing) return { key_b64: existing };
  const fresh = b64encode(crypto.getRandomValues(new Uint8Array(32)));
  const { error: insertError } = await supabase!
    .from('document_vault_key')
    .insert({ id: 1, key_b64: fresh });
  if (insertError) {
    // another admin created it a moment ago — adopt theirs
    const winner = await read();
    if (winner) return { key_b64: winner };
    throw new Error(docStorageSetupHint(insertError.message) ?? insertError.message);
  }
  return { key_b64: fresh };
}

async function getVaultKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!('crypto' in globalThis) || !crypto.subtle) {
    throw new Error('This browser does not support Web Crypto — encrypted storage is unavailable.');
  }
  const { key_b64 } = isDemoMode ? demoVaultKey() : await prodVaultKey();
  cachedKey = await importAesKey(b64decode(key_b64));
  return cachedKey;
}

/** Encrypt file bytes → opaque Blob `iv ‖ ciphertext` (application/octet-stream). */
async function encryptFile(file: File): Promise<Blob> {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext as unknown as ArrayBuffer);
  return new Blob([iv as unknown as BlobPart, ciphertext], { type: 'application/octet-stream' });
}

/** Decrypt a stored Blob back to a usable file Blob (for preview / print). */
async function decryptBlob(stored: Blob, mime: string): Promise<Blob> {
  const key = await getVaultKey();
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.length <= 12) throw new Error('The stored document is damaged (too short to decrypt).');
  const iv = bytes.subarray(0, 12);
  const ciphertext = bytes.subarray(12);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
      key,
      ciphertext as unknown as ArrayBuffer,
    );
    return new Blob([plaintext], { type: mime });
  } catch {
    throw new Error('The document could not be decrypted — it was stored with a different vault key.');
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

function validateDocFile(file: File): string {
  const ext = extOf(file.name);
  if (!['pdf', 'jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    return 'Only PDF, JPG, PNG or WebP files can be attached.';
  }
  if (file.size > MAX_EMPLOYEE_DOC_SIZE) {
    return `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — the limit is 15 MB.`;
  }
  if (file.size === 0) return 'The file is empty.';
  return '';
}

// ---------------------------------------------------------------------------
// DEMO backend — IndexedDB mini bucket (same shape as the site-docs one)
// ---------------------------------------------------------------------------
const IDB_NAME = 'pulse_employee_docs';
const IDB_STORE = 'docs';
const IDB_VERSION = 1;

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
  });
}

function idbTx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openIdb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const req = run(tx.objectStore(IDB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB operation failed'));
    tx.oncomplete = () => db.close();
  }));
}

interface DemoDocRecord {
  key: string; // emp_<employeeId>/<kind>.<ext>.bin
  employeeId: string;
  kind: EmployeeDocKind;
  name: string;
  ext: string;
  mime: string;
  size: number; // original (plaintext) size
  updatedAt: string;
  blob: Blob; // ENCRYPTED bytes
}

function demoToDoc(r: DemoDocRecord): EmployeeDoc {
  return {
    employeeId: r.employeeId, kind: r.kind, name: r.name, ext: r.ext,
    mime: r.mime, size: r.size, updatedAt: r.updatedAt, path: r.key,
  };
}

async function demoList(employeeId: string): Promise<EmployeeDoc[]> {
  const all = await idbTx<DemoDocRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DemoDocRecord[]>);
  return all
    .filter((r) => r.employeeId === employeeId)
    .map(demoToDoc)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/** demo keys of the SAME kind with a different extension (replace cleanup) */
async function demoStaleKeys(employeeId: string, kind: EmployeeDocKind, keepKey: string): Promise<string[]> {
  const all = await idbTx<DemoDocRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DemoDocRecord[]>);
  return all.filter((r) => r.employeeId === employeeId && r.kind === kind && r.key !== keepKey).map((r) => r.key);
}

// ---------------------------------------------------------------------------
// PROD backend — Supabase Storage (private bucket) + folder listing
// ---------------------------------------------------------------------------
const kindFromFileName = (name: string): EmployeeDocKind | null => {
  if (name.startsWith('passport.')) return 'passport';
  if (name.startsWith('visa.')) return 'visa';
  if (name.startsWith('contract.')) return 'contract';
  return null;
};

async function prodList(employeeId: string): Promise<EmployeeDoc[]> {
  if (!supabase) return [];
  const folder = `emp_${employeeId}`;
  const { data, error } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).list(folder, { limit: 20 });
  if (error) throw new Error(docStorageSetupHint(error.message) ?? error.message);
  return (data ?? [])
    .filter((f) => f.id !== null && kindFromFileName(f.name) !== null)
    .map((f): EmployeeDoc => {
      const kind = kindFromFileName(f.name)!;
      const dot = f.name.indexOf('.');
      const ext = f.name.slice(dot + 1, f.name.length - 4); // strip trailing ".bin"
      const cipherSize = f.metadata?.size ?? 0;
      return {
        employeeId,
        kind,
        name: `${docKindLabel(kind)} (${ext.toUpperCase()})`,
        ext,
        mime: mimeForExt(ext),
        // ciphertext = iv(12) + tag(16) + plaintext → recover the original size
        size: Math.max(0, cipherSize - 28),
        updatedAt: f.updated_at ?? '',
        path: `${folder}/${f.name}`,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/** All encrypted documents of one employee. */
export async function listEmployeeDocs(employeeId: string): Promise<EmployeeDoc[]> {
  if (isDemoMode) return demoList(employeeId);
  return prodList(employeeId);
}

/** Upload (and REPLACE) one document slot — the file is encrypted first.
 *  A re-upload with a different extension drops the slot's stale object. */
export async function uploadEmployeeDoc(
  employeeId: string,
  kind: EmployeeDocKind,
  file: File,
): Promise<void> {
  const problem = validateDocFile(file);
  if (problem) throw new Error(problem);
  const ext = extOf(file.name);
  const encrypted = await encryptFile(file);

  if (isDemoMode) {
    const key = `emp_${employeeId}/${kind}.${ext}.bin`;
    for (const stale of await demoStaleKeys(employeeId, kind, key)) {
      await idbTx('readwrite', (s) => s.delete(stale));
    }
    const record: DemoDocRecord = {
      key,
      employeeId,
      kind,
      name: `${docKindLabel(kind)} (${ext.toUpperCase()})`,
      ext,
      mime: file.type || mimeForExt(ext),
      size: file.size,
      updatedAt: new Date().toISOString(),
      blob: encrypted,
    };
    await idbTx('readwrite', (s) => s.put(record));
    return;
  }

  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const folder = `emp_${employeeId}`;
  const path = `${folder}/${kind}.${ext}.bin`;

  // replace cleanly: drop the slot's previous object if it had another extension
  const { data: existing } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).list(folder, { limit: 20 });
  const stale = (existing ?? [])
    .filter((f) => f.id !== null && kindFromFileName(f.name) === kind && f.name !== `${kind}.${ext}.bin`)
    .map((f) => `${folder}/${f.name}`);
  if (stale.length > 0) await supabase.storage.from(EMPLOYEE_DOC_BUCKET).remove(stale);

  const { error } = await supabase.storage
    .from(EMPLOYEE_DOC_BUCKET)
    .upload(path, encrypted, { contentType: 'application/octet-stream', upsert: true });
  if (error) throw new Error(docStorageSetupHint(error.message) ?? error.message);
}

/** The DECRYPTED file bytes (preview / print / download). */
export async function downloadEmployeeDoc(doc: EmployeeDoc): Promise<Blob> {
  if (isDemoMode) {
    const rec = await idbTx<DemoDocRecord | undefined>('readonly', (s) => s.get(doc.path) as IDBRequest<DemoDocRecord | undefined>);
    if (!rec) throw new Error('The document is no longer in the local demo store.');
    return decryptBlob(rec.blob, rec.mime || mimeForExt(rec.ext));
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { data, error } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).download(doc.path);
  if (error || !data) throw new Error(docStorageSetupHint(error?.message ?? 'Download failed') ?? 'Download failed.');
  return decryptBlob(data, doc.mime || mimeForExt(doc.ext));
}

/** A browser-usable object URL of the DECRYPTED document (remember to revoke). */
export async function employeeDocUrl(doc: EmployeeDoc): Promise<{ url: string; revoke: () => void }> {
  const blob = await downloadEmployeeDoc(doc);
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/** Remove one document slot's stored object. */
export async function deleteEmployeeDoc(doc: EmployeeDoc): Promise<void> {
  if (isDemoMode) {
    await idbTx('readwrite', (s) => s.delete(doc.path));
    return;
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { error } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).remove([doc.path]);
  if (error) throw new Error(docStorageSetupHint(error.message) ?? error.message);
}
