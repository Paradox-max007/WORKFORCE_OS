'use client';

// ============================================================================
// PULSE Workforce OS — Excel export PREVIEW page (Employee directory)
// ----------------------------------------------------------------------------
// Clicking "Export Excel" on the Employees page no longer downloads directly —
// it opens THIS page first: a spreadsheet-styled preview of the exact .xlsx
// (same columns, same order, same values) with a Download button that saves
// the file. The column list lives in lib/export-xlsx.ts and is shared by both
// the preview and the writer, so what you see is what you download.
// ============================================================================

import { motion } from 'framer-motion';
import {
  ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Loader2, Table2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import {
  EMPLOYEE_EXPORT_COLUMNS, employeeExportRows, exportEmployeesToXlsx,
} from '@/lib/export-xlsx';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

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

export function EmployeeExportPreviewPage() {
  const exportPreview = useAppStore((s) => s.exportPreview);
  const navigateToEmployees = useAppStore((s) => s.navigateToEmployees);
  const [downloading, setDownloading] = useState(false);

  const rows = useMemo(
    () => (exportPreview ? employeeExportRows(exportPreview.rows) : []),
    [exportPreview],
  );

  const download = async (): Promise<void> => {
    if (!exportPreview) return;
    setDownloading(true);
    try {
      await exportEmployeesToXlsx(exportPreview.rows, exportPreview.fileName);
      toast.success('Excel downloaded', {
        description: `${exportPreview.rows.length} employee(s) → ${exportPreview.fileName}`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  if (!exportPreview || exportPreview.rows.length === 0) {
    return (
      <div className="mx-auto max-w-[1600px]">
        <EmptyState
          icon={<FileSpreadsheet size={22} />}
          title="Nothing to export"
          description="Go back to the Employees page, filter the list and click Export Excel to preview it here."
          action={
            <Button variant="outline" onClick={() => navigateToEmployees()}>
              <ArrowLeft size={15} className="mr-1.5" /> Back to Employees
            </Button>
          }
        />
      </div>
    );
  }

  const { fileName } = exportPreview;

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
          <Button variant="outline" size="sm" onClick={() => navigateToEmployees()} aria-label="Back to employees list">
            <ArrowLeft size={15} /> Employees
          </Button>
          <h1 className="mt-3 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
            <FileSpreadsheet size={20} className="text-emerald-600 dark:text-emerald-400" />
            Excel Export Preview
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Table2 size={13} /> {exportPreview.rows.length} employee{exportPreview.rows.length === 1 ? '' : 's'}
            </span>
            <span aria-hidden>·</span>
            <span>{EMPLOYEE_EXPORT_COLUMNS.length} columns</span>
            <span aria-hidden>·</span>
            <span className="font-mono text-xs" title={fileName}>{fileName}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <p className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
            <CheckCircle2 size={13} className="text-emerald-500" />
            The preview matches the file exactly
          </p>
          <Button
            onClick={() => { void download(); }}
            disabled={downloading}
            className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
            title={`Download ${fileName}`}
          >
            {downloading
              ? <Loader2 size={15} className="mr-1.5 animate-spin" />
              : <Download size={15} className="mr-1.5" />}
            Download Excel
          </Button>
        </div>
      </div>

      {/* the "sheet" — always light like a real Excel file, whatever the app theme */}
      <section className="card-glow overflow-hidden rounded-xl border bg-card">
        <div className="max-h-[calc(100vh-19rem)] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-20">
              {/* Excel column letters */}
              <tr className="bg-zinc-100 text-zinc-500">
                <th className="sticky left-0 z-10 w-10 border-b border-r border-zinc-300 bg-zinc-100 px-1 py-1 text-center text-[10px] font-semibold" aria-label="Row numbers" />
                {EMPLOYEE_EXPORT_COLUMNS.map((c, i) => (
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
                {EMPLOYEE_EXPORT_COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className="whitespace-nowrap border-b border-r border-emerald-900/40 px-3 py-2 text-left text-xs font-semibold"
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className={cn('bg-white text-zinc-800', r % 2 === 1 && 'bg-zinc-50/70')}>
                  <td className="sticky left-0 z-10 border-b border-r border-zinc-300 bg-zinc-100 px-1 py-1.5 text-center text-[10px] font-semibold text-zinc-500">
                    {r + 2}
                  </td>
                  {EMPLOYEE_EXPORT_COLUMNS.map((c) => {
                    const v = row[c.header];
                    const numeric = typeof v === 'number' || c.key === 'phone' || c.key === 'code' || c.key === 'rating';
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          'max-w-56 truncate whitespace-nowrap border-b border-r border-zinc-200 px-3 py-1.5',
                          numeric && 'font-mono text-xs tabular-nums',
                          c.key === 'status' && 'capitalize',
                        )}
                        title={String(v ?? '')}
                      >
                        {v === '' || v == null
                          ? <span className="text-zinc-300">—</span>
                          : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5 text-[11px] text-muted-foreground">
            <FileSpreadsheet size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
            Sheet “Employees” · {rows.length + 1} rows × {EMPLOYEE_EXPORT_COLUMNS.length} columns —
            review the data above, then press <b>Download Excel</b> to save the .xlsx.
        </p>
      </section>
    </motion.div>
  );
}
