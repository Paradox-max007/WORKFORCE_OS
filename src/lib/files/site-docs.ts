// ============================================================================
// PULSE Workforce OS — Site documents (Timesheets / Time Cards) storage facade
// ----------------------------------------------------------------------------
// Per-site monthly documents shown on the Site Timesheets page:
//
//   time-card   — one PDF per month (the attendance time card)
//   timesheet   — one XLSX / PDF per month (the client timesheet)
//
// Both slots are OPTIONAL — an empty month is a perfectly normal state.
//
// Two interchangeable backends behind one interface:
//   PROD (Supabase configured) — Supabase Storage bucket 'site-timesheets'
//     (private; create it + its policies by running
//      supabase/migrations/20261116_site_timesheets_bucket.sql once).
//     Uploads/downloads go straight from the browser with the admin's
//     session; previews use 1-hour signed URLs.
//   DEMO — an IndexedDB "mini bucket" so the whole feature is usable in the
//     seeded demo (files stay in the browser, like the rest of the demo data).
//
// Object identity is the PATH, so re-uploading a slot replaces its file:
//   site_<siteId>/<YYYY-MM>/<kind><.ext>
// ============================================================================

import { isDemoMode } from '@/lib/data';
import { supabase } from '@/lib/supabase/client';

export type SiteDocKind = 'time-card' | 'timesheet';

export interface SiteDoc {
  siteId: string;
  /** 'YYYY-MM' */
  month: string;
  kind: SiteDocKind;
  /** original file name (as uploaded) */
  name: string;
  /** extension without the dot, lowercase (pdf / xlsx / xls / csv) */
  ext: string;
  mime: string;
  size: number;
  updatedAt: string;
  /** storage path (prod) or IndexedDB key (demo) */
  path: string;
}

export const SITE_DOC_BUCKET = 'site-timesheets';
export const MAX_SITE_DOC_SIZE = 25 * 1024 * 1024; // 25 MB

export const TIME_CARD_ACCEPT = '.pdf';
export const TIMESHEET_ACCEPT = '.pdf,.xlsx,.xls,.csv';

export function isEditableTimesheet(doc: SiteDoc): boolean {
  return doc.kind === 'timesheet' && ['xlsx', 'xls', 'csv'].includes(doc.ext);
}

/** 'YYYY-MM' from a site's created_at → … → current month, NEWEST first. */
export function monthsSince(startDate: string, now = new Date()): string[] {
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return [];
  const months: string[] = [];
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  const sy = start.getFullYear();
  const sm = start.getMonth() + 1;
  while ((y > sy) || (y === sy && m >= sm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y -= 1; }
    if (months.length > 240) break; // 20 years — sanity cap
  }
  return months;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
}

/** Friendly hint when Supabase storage rejects an operation because the
 *  bucket / policies from the migration file are not set up yet. */
export function storageSetupHint(message: string): string | null {
  if (/policy|rls|row-level|permission|not found|bucket/i.test(message)) {
    return `${message} — run supabase/migrations/20261116_site_timesheets_bucket.sql in the Supabase SQL editor (once), then retry.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DEMO backend — IndexedDB mini bucket
// ---------------------------------------------------------------------------
const IDB_NAME = 'pulse_site_docs';
const IDB_STORE = 'docs';
const IDB_VERSION = 1;

function idbKey(siteId: string, month: string, kind: SiteDocKind): string {
  return `site_${siteId}/${month}/${kind}`;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
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

interface DemoRecord {
  key: string;
  siteId: string;
  month: string;
  kind: SiteDocKind;
  name: string;
  ext: string;
  mime: string;
  size: number;
  updatedAt: string;
  blob: Blob;
}

function demoToDoc(r: DemoRecord): SiteDoc {
  return { siteId: r.siteId, month: r.month, kind: r.kind, name: r.name, ext: r.ext, mime: r.mime, size: r.size, updatedAt: r.updatedAt, path: r.key };
}

async function demoList(siteId: string): Promise<SiteDoc[]> {
  const all = await idbTx<DemoRecord[]>('readonly', (s) => s.getAll() as IDBRequest<DemoRecord[]>);
  return all.filter((r) => r.siteId === siteId).map(demoToDoc).sort((a, b) => b.month.localeCompare(a.month));
}

// ---------------------------------------------------------------------------
// PROD backend — Supabase Storage (private bucket, signed URLs)
// ---------------------------------------------------------------------------
function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : 'bin';
}

function kindOf(fileName: string): SiteDocKind | null {
  if (fileName.startsWith('time-card')) return 'time-card';
  if (fileName.startsWith('timesheet')) return 'timesheet';
  return null;
}

async function prodList(siteId: string, months: string[]): Promise<SiteDoc[]> {
  if (!supabase) return [];
  const folder = `site_${siteId}`;
  const settled = await Promise.all(months.map(async (month) => {
    const { data, error } = await supabase!.storage.from(SITE_DOC_BUCKET).list(`${folder}/${month}`, { limit: 10 });
    if (error || !data) return [] as SiteDoc[];
    return data
      .filter((f) => f.id !== null && kindOf(f.name) !== null)
      .map((f): SiteDoc => {
        const kind = kindOf(f.name)!;
        const dot = f.name.lastIndexOf('.');
        const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : 'bin';
        return {
          siteId,
          month,
          kind,
          name: `${kind === 'time-card' ? 'Time Card' : 'Timesheet'} ${month}.${ext}`,
          ext,
          mime: f.metadata?.mimetype ?? 'application/octet-stream',
          size: f.metadata?.size ?? 0,
          updatedAt: f.updated_at ?? '',
          path: `${folder}/${month}/${f.name}`,
        };
      });
  }));
  return settled.flat();
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/** All documents of one site (pass the months the page displays). */
export async function listSiteDocs(siteId: string, months: string[]): Promise<SiteDoc[]> {
  if (isDemoMode) return demoList(siteId);
  return prodList(siteId, months);
}

/** Upload (and REPLACE) one slot. The path is the identity, so a different
 *  extension overwrites the slot's previous file of another type. */
export async function uploadSiteDoc(
  siteId: string,
  month: string,
  kind: SiteDocKind,
  file: File,
): Promise<void> {
  if (file.size > MAX_SITE_DOC_SIZE) {
    throw new Error(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — the limit is 25 MB.`);
  }
  const ext = extOf(file.name);
  if (!ext || ext === 'bin') throw new Error('The file has no extension.');
  if (kind === 'time-card' && ext !== 'pdf') throw new Error('The time card must be a PDF file.');
  if (kind === 'timesheet' && !['pdf', 'xlsx', 'xls', 'csv'].includes(ext)) {
    throw new Error('The timesheet must be a PDF, XLSX, XLS or CSV file.');
  }

  if (isDemoMode) {
    const record: DemoRecord = {
      key: idbKey(siteId, month, kind),
      siteId, month, kind,
      name: file.name,
      ext,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      updatedAt: new Date().toISOString(),
      blob: file,
    };
    await idbTx('readwrite', (s) => s.put(record));
    return;
  }

  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const folder = `site_${siteId}`;
  const path = `${folder}/${month}/${kind}.${ext}`;

  // replace cleanly: drop the slot's previous file if it had another extension
  const { data: existing } = await supabase.storage.from(SITE_DOC_BUCKET).list(`${folder}/${month}`, { limit: 10 });
  const stale = (existing ?? [])
    .filter((f) => f.id !== null && kindOf(f.name) === kind && f.name !== `${kind}.${ext}`)
    .map((f) => `${folder}/${month}/${f.name}`);
  if (stale.length > 0) await supabase.storage.from(SITE_DOC_BUCKET).remove(stale);

  const { error } = await supabase.storage
    .from(SITE_DOC_BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: true });
  if (error) throw new Error(storageSetupHint(error.message) ?? error.message);
}

/** The file bytes (for the in-app Excel editor). */
export async function downloadSiteDoc(doc: SiteDoc): Promise<Blob> {
  if (isDemoMode) {
    const rec = await idbTx<DemoRecord | undefined>('readonly', (s) => s.get(doc.path) as IDBRequest<DemoRecord | undefined>);
    if (!rec) throw new Error('The file is no longer in the local demo store.');
    return rec.blob;
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { data, error } = await supabase.storage.from(SITE_DOC_BUCKET).download(doc.path);
  if (error || !data) throw new Error(storageSetupHint(error?.message ?? 'Download failed') ?? 'Download failed.');
  return data;
}

/** A URL the browser can open directly (preview iframe / download link).
 *  PROD: 1-hour signed URL (+download= name). DEMO: object URL. */
export async function siteDocUrl(doc: SiteDoc, downloadName?: string): Promise<string> {
  if (isDemoMode) {
    const blob = await downloadSiteDoc(doc);
    return URL.createObjectURL(blob);
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { data, error } = await supabase.storage
    .from(SITE_DOC_BUCKET)
    .createSignedUrl(doc.path, 3600, downloadName ? { download: downloadName } : undefined);
  if (error || !data?.signedUrl) {
    throw new Error(storageSetupHint(error?.message ?? 'Could not create a signed URL') ?? 'Could not create a signed URL');
  }
  return data.signedUrl;
}

/** Save edited timesheet bytes back to the same slot. */
export async function saveSiteDocBytes(
  doc: SiteDoc,
  bytes: ArrayBuffer,
  mime: string,
): Promise<void> {
  if (isDemoMode) {
    const rec = await idbTx<DemoRecord | undefined>('readonly', (s) => s.get(doc.path) as IDBRequest<DemoRecord | undefined>);
    if (!rec) throw new Error('The file is no longer in the local demo store.');
    rec.blob = new Blob([bytes], { type: mime });
    rec.size = rec.blob.size;
    rec.updatedAt = new Date().toISOString();
    await idbTx('readwrite', (s) => s.put(rec));
    return;
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { error } = await supabase.storage
    .from(SITE_DOC_BUCKET)
    .update(doc.path, bytes, { contentType: mime, upsert: true });
  if (error) throw new Error(storageSetupHint(error.message) ?? error.message);
}

/** Remove one slot's file. */
export async function deleteSiteDoc(doc: SiteDoc): Promise<void> {
  if (isDemoMode) {
    await idbTx('readwrite', (s) => s.delete(doc.path));
    return;
  }
  if (!supabase) throw new Error('Supabase is not configured on this server.');
  const { error } = await supabase.storage.from(SITE_DOC_BUCKET).remove([doc.path]);
  if (error) throw new Error(storageSetupHint(error.message) ?? error.message);
}
