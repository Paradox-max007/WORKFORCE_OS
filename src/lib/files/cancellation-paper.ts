// ============================================================================
// PULSE Workforce OS — Cancellation paper vault
// ----------------------------------------------------------------------------
// The signed cancellation paper (PDF or image scan) attached to an APPROVED
// cancellation request, and shown on the cancelled employee's details page
// (view + download).
//
// SECURITY — identical scheme to the employee document vault
// (src/lib/files/employee-docs.ts), whose primitives are shared here:
//   • every file is encrypted in the BROWSER with AES-256-GCM before it is
//     written to storage, and decrypted only in memory for preview/download;
//   • the key lives in the one-row `document_vault_key` table (Supabase mode)
//     or the local demo store (demo mode) — never inside the bucket;
//   • the stored object is `iv(12 bytes) + ciphertext` under
//     cancel_<requestId>/paper.<ext>.bin in the PRIVATE 'employee-documents'
//     bucket — its policies (migrations/20261118b_employee_documents.sql) are
//     bucket-wide, so no extra migration is needed for the new folder scheme.
//
// Two interchangeable backends behind one interface:
//   PROD — Supabase Storage bucket 'employee-documents', folder cancel_<id>
//   DEMO — an IndexedDB "mini bucket" holding the same encrypted blobs
//
// Object identity is the PATH, so re-uploading replaces the paper.
// ============================================================================

import { isDemoMode } from '@/lib/data';
import { supabase } from '@/lib/supabase/client';
import {
  EMPLOYEE_DOC_BUCKET, MAX_EMPLOYEE_DOC_SIZE, decryptBlob, encryptFile,
  extOf, mimeForExt, validateDocFile,
} from '@/lib/files/employee-docs';

export interface CancellationPaper {
  requestId: string;
  /** display name, e.g. "Cancellation Paper (PDF)" */
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

export const CANCELLATION_PAPER_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp';
export const MAX_CANCELLATION_PAPER_SIZE = MAX_EMPLOYEE_DOC_SIZE; // 15 MB

// ---------------------------------------------------------------------------
// DEMO backend — IndexedDB mini bucket
// ---------------------------------------------------------------------------
const IDB_NAME = 'pulse_cancellation_papers';
const IDB_STORE = 'papers';
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

interface DemoPaperRecord {
  key: string; // cancel_<requestId>/paper.<ext>.bin
  requestId: string;
  name: string;
  ext: string;
  mime: string;
  size: number; // original (plaintext) size
  updatedAt: string;
  blob: Blob; // ENCRYPTED bytes
}

// ---------------------------------------------------------------------------
// PROD backend — Supabase Storage (private bucket), folder listing
// ---------------------------------------------------------------------------
const paperFileRe = /^paper\.([a-z0-9]+)\.bin$/;

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/** The paper attached to a cancellation request, or null when there is none. */
export async function getCancellationPaper(requestId: string): Promise<CancellationPaper | null> {
  if (isDemoMode) {
    const all = await idbTx<DemoPaperRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DemoPaperRecord[]>);
    const rec = all.find((r) => r.requestId === requestId);
    return rec
      ? { requestId, name: rec.name, ext: rec.ext, mime: rec.mime, size: rec.size, updatedAt: rec.updatedAt, path: rec.key }
      : null;
  }
  if (!supabase) return null;
  const folder = `cancel_${requestId}`;
  const { data, error } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).list(folder, { limit: 5 });
  if (error) throw new Error(error.message);
  const hit = (data ?? []).find((f) => f.id !== null && paperFileRe.test(f.name));
  if (!hit) return null;
  const ext = paperFileRe.exec(hit.name)![1];
  return {
    requestId,
    name: `Cancellation Paper (${ext.toUpperCase()})`,
    ext,
    mime: mimeForExt(ext),
    // ciphertext = iv(12) + tag(16) + plaintext → recover the original size
    size: Math.max(0, (hit.metadata?.size ?? 0) - 28),
    updatedAt: hit.updated_at ?? '',
    path: `${folder}/${hit.name}`,
  };
}

/** Upload (and REPLACE) the paper of an approved request — encrypted first. */
export async function uploadCancellationPaper(requestId: string, file: File): Promise<void> {
  const problem = validateDocFile(file);
  if (problem) throw new Error(problem);
  const ext = extOf(file.name);
  const encrypted = await encryptFile(file);

  if (isDemoMode) {
    const key = `cancel_${requestId}/paper.${ext}.bin`;
    // replace cleanly: drop any stored paper with a different extension
    const all = await idbTx<DemoPaperRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DemoPaperRecord[]>);
    for (const stale of all.filter((r) => r.requestId === requestId && r.key !== key)) {
      await idbTx('readwrite', (s) => s.delete(stale.key));
    }
    const record: DemoPaperRecord = {
      key,
      requestId,
      name: `Cancellation Paper (${ext.toUpperCase()})`,
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
  const folder = `cancel_${requestId}`;
  const path = `${folder}/paper.${ext}.bin`;

  // replace cleanly: drop the previous object if it had another extension
  const { data: existing } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).list(folder, { limit: 5 });
  const stale = (existing ?? [])
    .filter((f) => f.id !== null && paperFileRe.test(f.name) && f.name !== `paper.${ext}.bin`)
    .map((f) => `${folder}/${f.name}`);
  if (stale.length > 0) await supabase.storage.from(EMPLOYEE_DOC_BUCKET).remove(stale);

  const { error } = await supabase.storage
    .from(EMPLOYEE_DOC_BUCKET)
    .upload(path, encrypted, { contentType: 'application/octet-stream', upsert: true });
  if (error) throw new Error(error.message);
}

/** The DECRYPTED paper bytes (preview / download). */
export async function downloadCancellationPaper(paper: CancellationPaper): Promise<Blob> {
  if (isDemoMode) {
    const rec = await idbTx<DemoPaperRecord | undefined>('readonly', (s) => s.get(paper.path) as IDBRequest<DemoPaperRecord | undefined>);
    if (!rec) throw new Error('The cancellation paper is no longer in the local demo store.');
    return decryptBlob(rec.blob, rec.mime || mimeForExt(rec.ext));
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { data, error } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).download(paper.path);
  if (error || !data) throw new Error(error?.message ?? 'Download failed.');
  return decryptBlob(data, paper.mime || mimeForExt(paper.ext));
}

/** A browser-usable object URL of the DECRYPTED paper (remember to revoke). */
export async function cancellationPaperUrl(paper: CancellationPaper): Promise<{ url: string; revoke: () => void }> {
  const blob = await downloadCancellationPaper(paper);
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/** Remove the stored paper object (re-upload starts fresh). */
export async function deleteCancellationPaper(paper: CancellationPaper): Promise<void> {
  if (isDemoMode) {
    await idbTx('readwrite', (s) => s.delete(paper.path));
    return;
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { error } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).remove([paper.path]);
  if (error) throw new Error(error.message);
}
