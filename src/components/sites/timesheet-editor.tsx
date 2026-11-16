'use client';

// ============================================================================
// PULSE Workforce OS — in-app Timesheet (Excel) editor
// ----------------------------------------------------------------------------
// Opens a timesheet XLSX / XLS / CSV straight from the site document store and
// makes it editable like a normal spreadsheet:
//
//   • formulas ( =SUM(A1:A31), =AVERAGE(...), =IF(...), 300+ Excel functions )
//     recalculate live in the grid
//   • multiple worksheets are preserved (tabs)
//   • saving writes values + formulas + merged cells back to the SAME month
//     slot in the document store (the original file is replaced)
//
// Internals: SheetJS (xlsx) parses/serialises the workbook; jspreadsheet CE
// (MIT) renders the editable grid with its built-in formula engine. The jSS
// data model keeps RAW cell content (formula strings), so saving is lossless
// for values & formulas; column widths and rich cell styling are simplified
// on save (SheetJS community edition does not serialise them) — hinted in
// the footer so nobody is surprised.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import jspreadsheet from 'jspreadsheet-ce';
import 'jspreadsheet-ce/dist/jspreadsheet.css';
import { Loader2, Save, Sheet as SheetIcon, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  uploadSiteDoc,
  type SiteDoc,
} from '@/lib/files/site-docs';
import { cn } from '@/lib/utils';

/** The jSS v4 API the editor relies on (the bundled typings are loose). */
interface JssInstance {
  destroy: () => void;
  options: { data: (string | number | boolean)[][] };
  getLabelFromCoords: (x: number, y: number) => string;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** worksheet → editable grid; formula cells keep their '=' source. */
function sheetToGrid(ws: XLSX.WorkSheet): (string | number | boolean)[][] {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  const grid: (string | number | boolean)[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: (string | number | boolean)[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (!cell) { row.push(''); continue; }
      if (cell.f) {
        row.push('=' + cell.f);
      } else if (cell.v instanceof Date) {
        row.push(cell.w ?? cell.v.toISOString().slice(0, 10));
      } else if (typeof cell.v === 'number' || typeof cell.v === 'boolean') {
        row.push(cell.v);
      } else {
        row.push(cell.w ?? cell.v ?? '');
      }
    }
    grid.push(row);
  }
  return grid;
}

/** Write the edited grid back into the ORIGINAL worksheet object, keeping
 *  !cols (widths) and !merges; the range grows/shrinks with the content. */
function gridToSheet(ws: XLSX.WorkSheet, grid: (string | number | boolean)[][], label: (x: number, y: number) => string): void {
  const orig = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  let maxR = 0;
  let maxC = 0;

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? [];
    for (let x = 0; x < row.length; x++) {
      const raw = row[x];
      const addr = XLSX.utils.encode_cell({ r: y, c: x });
      if (raw === '' || raw === null || raw === undefined) {
        delete ws[addr];
        continue;
      }
      if (typeof raw === 'string' && raw.trim().startsWith('=')) {
        // formula cell — store the live computed value as the cached result so
        // every viewer (including apps that do not auto-recalc) shows a number
        const shown = label(x, y) ?? '';
        const num = shown !== '' && !Number.isNaN(Number(shown.replace(/,/g, ''))) ? Number(shown.replace(/,/g, '')) : undefined;
        ws[addr] = num !== undefined
          ? { t: 'n', v: num, f: raw.trim().slice(1) }
          : { t: 's', v: shown || raw, f: raw.trim().slice(1) };
      } else if (typeof raw === 'number') {
        ws[addr] = { t: 'n', v: raw };
      } else if (typeof raw === 'boolean') {
        ws[addr] = { t: 'b', v: raw };
      } else {
        const s = String(raw);
        ws[addr] = s !== '' && !Number.isNaN(Number(s)) ? { t: 'n', v: Number(s) } : { t: 's', v: s };
      }
      if (y > maxR) maxR = y;
      if (x > maxC) maxC = x;
    }
  }

  // rows/columns removed in the grid must not survive in the old range
  for (let r = grid.length; r <= orig.e.r; r++) {
    for (let c = 0; c <= Math.max(maxC, orig.e.c); c++) delete ws[XLSX.utils.encode_cell({ r, c })];
  }
  const widest = grid.reduce((m, row) => Math.max(m, row.length), 0);
  for (let c = widest; c <= orig.e.c; c++) {
    for (let r = 0; r <= maxR; r++) delete ws[XLSX.utils.encode_cell({ r, c })];
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
}

export function TimesheetEditorDialog({
  doc,
  bytes,
  onClose,
  onSaved,
}: {
  doc: SiteDoc;
  /** the downloaded file bytes */
  bytes: ArrayBuffer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const workbook = useMemo(() => {
    try {
      return XLSX.read(new Uint8Array(bytes), { type: 'array' });
    } catch {
      return null;
    }
  }, [bytes]);

  const sheetNames = workbook?.SheetNames ?? [];
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const gridHostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<JssInstance | null>(null);

  /** write the live grid of the current sheet back into its worksheet */
  const syncActiveSheet = useCallback(() => {
    const inst = instanceRef.current;
    if (!workbook || !inst) return;
    const ws = workbook.Sheets[workbook.SheetNames[active]];
    if (!ws) return;
    gridToSheet(ws, inst.options.data, (x, y) => inst.getLabelFromCoords(x, y));
  }, [workbook, active]);

  // (re)build the grid whenever the dialog opens or the active sheet changes
  useEffect(() => {
    const host = gridHostRef.current;
    if (!workbook || !host || sheetNames.length === 0) return;
    const ws = workbook.Sheets[sheetNames[active]];
    if (!ws) return;

    const grid = sheetToGrid(ws);
    const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
    host.innerHTML = '';
    try {
      instanceRef.current = jspreadsheet(host, {
        data: grid,
        minDimensions: [Math.max(cols + 3, 10), Math.max(grid.length + 6, 24)],
        tableOverflow: true,
        tableWidth: '100%',
        tableHeight: '100%',
        // a small note is friendlier than silently overwriting the slot
        about: false,
        onchange: () => setDirty(true),
        oninsertrow: () => setDirty(true),
        oninsertcolumn: () => setDirty(true),
        ondeleterow: () => setDirty(true),
        ondeletecolumn: () => setDirty(true),
        onpaste: () => setDirty(true),
      }) as unknown as JssInstance;
    } catch {
      setError('This spreadsheet could not be opened in the editor.');
    }
    return () => {
      instanceRef.current = null;
      host.innerHTML = '';
    };
  }, [workbook, active, sheetNames.length]);

  const switchSheet = (idx: number) => {
    if (idx === active) return;
    syncActiveSheet();
    setActive(idx);
  };

  const save = async () => {
    if (!workbook) return;
    setSaving(true);
    setError(null);
    try {
      syncActiveSheet();
      const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      // always saved as .xlsx (legacy .xls / .csv become real xlsx) — the
      // upload replaces the slot, so a stale .xls twin is removed too
      const name = `timesheet-${doc.month}.xlsx`;
      const file = new File([out], name, { type: XLSX_MIME });
      await uploadSiteDoc(doc.siteId, doc.month, 'timesheet', file);
      setDirty(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the timesheet.');
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    syncActiveSheet(); // keep edits in the in-memory workbook while open
    onClose();
  };

  if (!workbook || sheetNames.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 text-center shadow-2xl">
          <TriangleAlert className="mx-auto size-10 text-amber-500" />
          <p className="mt-3 text-sm font-semibold">This file is not a readable spreadsheet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {doc.name} could not be parsed as XLSX / XLS / CSV. You can still download it.
          </p>
          <Button variant="outline" className="mt-4" onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-2 backdrop-blur-sm md:p-6" role="dialog" aria-label="Timesheet editor">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* header */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <SheetIcon className="size-5 shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" title={doc.name}>{doc.name}</p>
            <p className="text-[11px] text-muted-foreground">
              Editable spreadsheet — type formulas like <code className="rounded bg-muted px-1">=SUM(A1:A31)</code> and they recalculate live
            </p>
          </div>
          {sheetNames.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-background/60 p-1">
              {sheetNames.map((n, i) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => switchSheet(i)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                    i === active ? 'brand-gradient text-brand-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          {dirty && <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">unsaved</span>}
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={close} aria-label="Close editor">
            <X className="size-4" />
          </Button>
        </div>

        {/* the sheet — always paper-white so it reads like a real spreadsheet */}
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-100 p-2 dark:bg-neutral-900">
          <div className="mx-auto max-w-full rounded-lg bg-white text-black shadow-md [&_.jspreadsheet]:text-[13px]">
            <div ref={gridHostRef} />
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {error ? (
            <p className="min-w-0 flex-1 break-words rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</p>
          ) : (
            <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              Saving replaces this month&apos;s timesheet file — values, formulas and merged cells are kept; column widths and rich cell styling (colors/fonts) may simplify.
            </p>
          )}
          <Button variant="outline" onClick={close} disabled={saving}>Close</Button>
          <Button className="gap-2" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save &amp; Upload
          </Button>
        </div>
      </div>
    </div>
  );
}
