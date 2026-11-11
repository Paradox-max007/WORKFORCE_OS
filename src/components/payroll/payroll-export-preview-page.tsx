'use client';

// ============================================================================
// PULSE Workforce OS — Excel export PREVIEW page (Payroll)
// ----------------------------------------------------------------------------
// Clicking "Excel" on the Payroll page opens THIS page: a spreadsheet-styled
// preview of the exact .xlsx for the CURRENTLY FILTERED rows of the selected
// period (search / region / country / camp / trade / payment method / status).
//
//   • COLUMN SELECTOR — every column starts SELECTED; deselect the ones you
//     don't want and the sheet (and the file) update instantly
//   • the column order mirrors the Payroll table — AMOUNT before ADVANCE
//   • a bold TOTAL row closes the sheet (hours / amount / advance / deduction
//     / net payable sums follow the selected columns)
//   • Download Excel writes the real .xlsx via lib/export-payroll-xlsx.ts —
//     the preview and the file share the SAME column definition, so what you
//     see is what you download
// ============================================================================

import { motion } from 'framer-motion';
import {
  ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Loader2, Table2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  PAYROLL_EXPORT_COLUMNS, exportPayrollToXlsx, payrollExportSheetName,
  type PayrollExportColumn,
} from '@/lib/export-payroll-xlsx';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtMoney = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtHrs = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** 0 → A, 1 → B, … 25 → Z, 26 → AA (Excel column letters) */
const colLetter = (i: number): string => {
  let s = '';
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
};

/** what the preview shows for a cell (numbers formatted like Excel renders
 *  them with the number format written into the file) */
const previewValue = (c: PayrollExportColumn, v: string | number): string => {
  if (v === '' || v == null) return '';
  if (typeof v !== 'number') return v;
  return c.money ? fmtMoney(v) : fmtHrs(v);
};

export function PayrollExportPreviewPage() {
  const preview = useAppStore((s) => s.payrollExportPreview);
  const navigateTo = useAppStore((s) => s.navigateTo);
  const [downloading, setDownloading] = useState(false);
  // every column selected by default — deselect the unwanted ones
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PAYROLL_EXPORT_COLUMNS.map((c) => [c.key, true])));

  const columns = useMemo(
    () => PAYROLL_EXPORT_COLUMNS.filter((c) => selected[c.key]),
    [selected],
  );

  const toggleColumn = (key: string): void => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const download = async (): Promise<void> => {
    if (!preview) return;
    if (columns.length === 0) {
      toast.error('Select at least one column', { description: 'Deselecting every column would export an empty sheet.' });
      return;
    }
    setDownloading(true);
    try {
      await exportPayrollToXlsx(
        preview.rows, columns, preview.fileName, payrollExportSheetName(preview.year, preview.month),
      );
      toast.success('Excel downloaded', {
        description: `${preview.rows.length} employee(s) · ${columns.length} column(s) → ${preview.fileName}`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  if (!preview || preview.rows.length === 0) {
    return (
      <div className="mx-auto max-w-[1600px]">
        <EmptyState
          icon={<FileSpreadsheet size={22} />}
          title="Nothing to export"
          description="Go back to the Payroll page, filter the table and click Excel to preview the sheet here."
          action={
            <Button variant="outline" onClick={() => navigateTo('payroll')}>
              <ArrowLeft size={15} className="mr-1.5" /> Back to Payroll
            </Button>
          }
        />
      </div>
    );
  }

  const { rows, year, month, fileName, filters, totalCount } = preview;
  const sheetName = payrollExportSheetName(year, month);
  const selectedCount = columns.length;
  const allSelected = selectedCount === PAYROLL_EXPORT_COLUMNS.length;

  // the TOTAL row — label in the first selected column, sums under the rest
  const totalCells = columns.map((c, i) =>
    (i === 0 ? 'TOTAL' : c.total ? previewValue(c, c.total(rows)) : ''));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto max-w-[1600px] space-y-4"
    >
      {/* header — stays at the top; Download is always reachable */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Button variant="outline" size="sm" onClick={() => navigateTo('payroll')} aria-label="Back to the payroll table">
            <ArrowLeft size={15} /> Payroll
          </Button>
          <h1 className="mt-3 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
            <FileSpreadsheet size={20} className="text-emerald-600 dark:text-emerald-400" />
            Excel Preview — Payroll {MONTH_NAMES[month - 1]} {year}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Table2 size={13} /> {rows.length} of {totalCount} employee{totalCount === 1 ? '' : 's'}
            </span>
            <span aria-hidden>·</span>
            <span>{selectedCount} of {PAYROLL_EXPORT_COLUMNS.length} columns</span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono text-xs" title={fileName}>{fileName}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <p className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
            <CheckCircle2 size={13} className="text-emerald-500" />
            The preview matches the file exactly
          </p>
          <Button
            onClick={() => { void download(); }}
            disabled={downloading || selectedCount === 0}
            title={selectedCount === 0
              ? 'Select at least one column'
              : `Download ${fileName}`}
            className="bg-[#217346] font-semibold text-white shadow-lg shadow-emerald-900/20 transition-transform hover:bg-[#1a5c38] active:scale-[0.98]"
          >
            {downloading
              ? <Loader2 size={15} className="mr-1.5 animate-spin" />
              : <Download size={15} className="mr-1.5" />}
            Download Excel
          </Button>
        </div>
      </div>

      {/* active filters — what shaped this sheet */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Filters applied:
        </span>
        {filters.length === 0 ? (
          <span className="rounded-full border border-border/60 bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground">
            none — every employee of {MONTH_NAMES[month - 1]} {year}
          </span>
        ) : filters.map((f) => (
          <span
            key={f}
            className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand"
          >
            {f}
          </span>
        ))}
      </div>

      {/* column selector — every column ON by default; click to deselect */}
      <section className="card-glow rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Columns in the Excel
          </p>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
            {selectedCount}/{PAYROLL_EXPORT_COLUMNS.length}
          </span>
          <button
            type="button"
            onClick={() => setSelected((prev) => {
              const next: Record<string, boolean> = {};
              PAYROLL_EXPORT_COLUMNS.forEach((c) => { next[c.key] = !allSelected; });
              return { ...prev, ...next };
            })}
            className="rounded-full border border-border/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {PAYROLL_EXPORT_COLUMNS.map((c, i) => {
            const on = !!selected[c.key];
            return (
              <label
                key={c.key}
                className={cn(
                  'flex cursor-pointer select-none items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  on
                    ? 'border-brand/40 bg-brand/10 text-foreground'
                    : 'border-border/60 bg-card text-muted-foreground line-through decoration-border',
                )}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={() => toggleColumn(c.key)}
                  aria-label={`Include the ${c.header} column in the Excel`}
                />
                <span className={cn('font-mono text-[10px] font-semibold', on ? 'text-brand' : 'text-muted-foreground/60')}>
                  {colLetter(i)}
                </span>
                {c.header}
              </label>
            );
          })}
        </div>
      </section>

      {/* the "sheet" — always light like a real Excel file, whatever the app theme */}
      <section className="card-glow overflow-hidden rounded-xl border bg-card">
        <div className="max-h-[calc(100vh-26rem)] min-h-64 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-20">
              {/* Excel column letters */}
              <tr className="bg-zinc-100 text-zinc-500">
                <th className="sticky left-0 z-10 w-10 border-b border-r border-zinc-300 bg-zinc-100 px-1 py-1 text-center text-[10px] font-semibold" aria-label="Row numbers" />
                {columns.map((c, i) => (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.header}
                    className="min-w-20 border-b border-r border-zinc-300 bg-zinc-100 px-2 py-1 text-center text-[10px] font-semibold uppercase"
                  >
                    {colLetter(i)}
                  </th>
                ))}
              </tr>
              {/* header row — the Excel-green band */}
              <tr className="bg-[#217346] text-white">
                <th className="sticky left-0 z-10 border-b border-r border-zinc-300 bg-zinc-100 px-1 py-2 text-center text-[10px] font-semibold text-zinc-500">1</th>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn(
                      'whitespace-nowrap border-b border-r border-emerald-900/40 px-3 py-2 text-xs font-semibold',
                      c.numeric && 'text-right',
                    )}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e, r) => (
                <tr key={e.id} className={cn('bg-white text-zinc-800', r % 2 === 1 && 'bg-zinc-50/70')}>
                  <td className="sticky left-0 z-10 border-b border-r border-zinc-300 bg-zinc-100 px-1 py-1.5 text-center text-[10px] font-semibold text-zinc-500">
                    {r + 2}
                  </td>
                  {columns.map((c) => {
                    const v = previewValue(c, c.value(e));
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          'max-w-56 truncate whitespace-nowrap border-b border-r border-zinc-200 px-3 py-1.5',
                          c.numeric && 'font-mono text-xs tabular-nums text-right',
                          c.key === 'code' && 'font-mono text-xs',
                        )}
                        title={v || undefined}
                      >
                        {v === ''
                          ? <span className="text-zinc-300">—</span>
                          : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* TOTAL row — bold, like an Excel subtotal band */}
              <tr className="bg-zinc-100 font-semibold text-zinc-900">
                <td className="sticky left-0 z-10 border-b border-r border-zinc-300 bg-zinc-100 px-1 py-2 text-center text-[10px] text-zinc-500">
                  {rows.length + 2}
                </td>
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      'whitespace-nowrap border-b border-r border-zinc-300 px-3 py-2 text-xs uppercase tracking-wide',
                      c.numeric && 'font-mono tabular-nums text-right',
                    )}
                  >
                    {totalCells[i] === '' ? '' : totalCells[i]}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5 text-[11px] text-muted-foreground">
          <FileSpreadsheet size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
          Sheet “{sheetName}” · {rows.length + 2} rows × {selectedCount} column{selectedCount === 1 ? '' : 's'} —
          deselect the columns you don&apos;t need, then press <b>Download Excel</b> to save the .xlsx.
        </p>
      </section>
    </motion.div>
  );
}
