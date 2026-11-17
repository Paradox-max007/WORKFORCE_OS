// ============================================================================
// PULSE Workforce OS — Site document CONTENT extraction (Pebby's eyes)
// ----------------------------------------------------------------------------
// Turns an uploaded site document — a Timesheet (XLSX / XLS / CSV) or a Time
// Card / Timesheet PDF — into plain text Pebby can actually read, powering
// the [[LOOKUP]] doc-content=<site>:<YYYY-MM>:<slot> directive.
//
// Everything runs in the browser: the bytes come from the same storage facade
// the Site Timesheets page uses (Supabase bucket or the demo IndexedDB
// mini-bucket), nothing is sent anywhere else.
//
// Spreadsheets: SheetJS (values & cached formula results, formatted text).
// PDFs: pdf.js text layer (the same engine the in-app PDF viewer uses).
// Both are dynamically imported, so none of this weighs down the bundle
// until Pebby actually needs to read a file.
// ============================================================================

import { downloadSiteDoc, type SiteDoc } from '@/lib/files/site-docs';

/** keep every extraction comfortably inside one chat round-trip */
const MAX_CHARS = 9_000;
const MAX_SHEETS = 6;
const MAX_ROWS_PER_SHEET = 300;
const MAX_PDF_PAGES = 12;

function clip(text: string): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n…[truncated — the file is longer than the ${MAX_CHARS}-character read limit]`
    : text;
}

/** '45 KB' / '1.2 MB' */
function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Spreadsheets (xlsx / xls / csv) — SheetJS, values as formatted text
// ---------------------------------------------------------------------------
async function extractSpreadsheet(blob: Blob): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const parts: string[] = [];
  for (const name of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false, // formatted text (dates, currency) instead of raw numbers
      blankrows: false,
      defval: '',
    });
    const lines: string[] = [];
    for (const row of rows) {
      if (lines.length >= MAX_ROWS_PER_SHEET) {
        lines.push(`…[sheet truncated at ${MAX_ROWS_PER_SHEET} rows]`);
        break;
      }
      const cells = (Array.isArray(row) ? row : [row])
        .map((c) => String(c ?? '').trim())
        .filter(Boolean);
      if (cells.length > 0) lines.push(cells.join(' | '));
    }
    if (lines.length > 0) parts.push(`— sheet "${name}" —\n${lines.join('\n')}`);
  }
  if (parts.length === 0) return '(the workbook has no readable text content)';
  return clip(parts.join('\n\n'));
}

// ---------------------------------------------------------------------------
// PDFs — pdf.js text layer
// ---------------------------------------------------------------------------
async function extractPdf(blob: Blob): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  // the worker is served from /public (same setup as the PDF zoom viewer)
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const data = new Uint8Array(await blob.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const parts: string[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines: string[] = [];
    let line = '';
    for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length > 0) {
      parts.push(pdf.numPages > 1 ? `— page ${p} —\n${lines.join('\n')}` : lines.join('\n'));
    }
  }
  if (pageCount < pdf.numPages) {
    parts.push(`…[${pdf.numPages - pageCount} more page(s) not read — the limit is ${MAX_PDF_PAGES} pages]`);
  }
  if (parts.length === 0) {
    return '(the PDF has no text layer — it is probably a scan, so its content cannot be read)';
  }
  return clip(parts.join('\n\n'));
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/** Download one site document and extract its text content for Pebby. */
export async function extractSiteDocText(doc: SiteDoc): Promise<string> {
  const blob = await downloadSiteDoc(doc);
  if (doc.ext === 'pdf') return extractPdf(blob);
  if (doc.ext === 'xlsx' || doc.ext === 'xls' || doc.ext === 'csv') {
    return extractSpreadsheet(blob);
  }
  throw new Error(`.${doc.ext} files cannot be read as text`);
}

/** The [[LOOKUP]] doc-content result block the model receives. */
export function formatSiteDocContent(
  siteName: string,
  doc: SiteDoc,
  content: string,
): string {
  const kindLabel = doc.kind === 'time-card' ? 'Time Card' : 'Timesheet';
  return [
    `DOCUMENT CONTENT — ${kindLabel} of "${siteName}" for ${doc.month}`,
    `file: ${doc.name} · ${doc.ext.toUpperCase()} · ${fmtSize(doc.size)}${doc.updatedAt ? ` · updated ${doc.updatedAt.slice(0, 10)}` : ''}`,
    'Extracted text below — spreadsheet cells are joined with " | ", empty cells skipped, layout simplified. Read it carefully and answer the user\'s question from it.',
    content,
  ].join('\n');
}
