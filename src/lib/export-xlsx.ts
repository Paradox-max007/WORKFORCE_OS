'use client';

// ============================================================================
// PULSE Workforce OS — Employee directory → Excel (.xlsx) export
// ----------------------------------------------------------------------------
// Exports the CURRENTLY FILTERED employee list (search / status / nationality /
// camp / payment method) with a filename that mirrors the active filters, e.g.
//   Pulse_Employees_Camp-Sonapur-Labour-Camp_Nationality-Kenya_2026-10-29.xlsx
//
// The download now goes through a PREVIEW PAGE first: the Export Excel button
// opens the employee_export view which renders employeeExportRows() as a
// spreadsheet-styled table; its Download button calls exportEmployeesToXlsx().
// Both use the SAME column definition below, so the preview always matches
// the file byte-for-byte.
// ============================================================================

import type { EmployeeVM } from '@/lib/types';

/** One Excel column — shared by the .xlsx writer and the preview page. */
export interface ExportColumn {
  key: string;
  header: string;
  width: number; // Excel column width (characters)
  /** value extractor (string | number — exactly what lands in the cell) */
  value: (e: EmployeeVM, index: number) => string | number;
}

/** The single source of truth for the exported columns. */
export const EMPLOYEE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'sno', header: 'S.No', width: 6, value: (_e, i) => i + 1 },
  { key: 'code', header: 'Employee ID', width: 16, value: (e) => e.employee_code },
  { key: 'name', header: 'Full Name', width: 24, value: (e) => e.full_name },
  { key: 'nationality', header: 'Nationality', width: 18, value: (e) => e.nationality ?? '' },
  { key: 'position', header: 'Trade / Position', width: 20, value: (e) => e.position ?? '' },
  { key: 'company', header: 'Company', width: 18, value: (e) => e.company_name ?? '' },
  { key: 'site', header: 'Work Site', width: 26, value: (e) => e.site_name ?? 'Unassigned (Idle)' },
  { key: 'camp', header: 'Camp', width: 24, value: (e) => e.camp_name ?? '' },
  { key: 'block', header: 'Block', width: 8, value: (e) => e.camp_block ?? '' },
  { key: 'room', header: 'Room', width: 8, value: (e) => e.camp_room ?? '' },
  { key: 'phone', header: 'Phone', width: 18, value: (e) => e.phone ?? '' },
  { key: 'email', header: 'Email', width: 26, value: (e) => e.email ?? '' },
  { key: 'join', header: 'Join Date', width: 14, value: (e) => e.join_date ?? '' },
  { key: 'payment', header: 'Payment Method', width: 14, value: (e) => e.payment_type === 'card' ? 'Card' : e.payment_type === 'cash' ? 'Cash' : '' },
  { key: 'card', header: 'Card Type', width: 16, value: (e) => e.payment_type === 'card' ? e.card_type_name ?? '' : '' },
  { key: 'rating', header: 'Rating', width: 8, value: (e) => e.rating },
  { key: 'status', header: 'Status', width: 16, value: (e) => e.status },
];

/** Rows in export order — the preview table and the .xlsx share this. */
export function employeeExportRows(rows: EmployeeVM[]): Record<string, string | number>[] {
  return rows.map((e, i) => {
    const out: Record<string, string | number> = {};
    EMPLOYEE_EXPORT_COLUMNS.forEach((c) => { out[c.header] = c.value(e, i); });
    return out;
  });
}

/** Build the download filename from the active filter chips. */
export function employeeExportFileName(chips: string[]): string {
  const sanitize = (s: string) =>
    s.trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  const parts = chips
    .map((c) => sanitize(c))
    .filter(Boolean)
    .map((c) => c.charAt(0).toUpperCase() + c.slice(1))
    .join('_');
  const date = new Date().toISOString().slice(0, 10);
  return `Pulse_Employees${parts ? '_' + parts : ''}_${date}.xlsx`;
}

export async function exportEmployeesToXlsx(rows: EmployeeVM[], fileName: string): Promise<void> {
  // dynamic import keeps SheetJS out of the main bundle
  const XLSX = await import('xlsx');

  const data = employeeExportRows(rows);
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = EMPLOYEE_EXPORT_COLUMNS.map((c) => ({ wch: c.width }));

  const wb = XLSX.utils.book_new();
  wb.Props = { Title: 'PULSE Workforce OS — Employee Directory', Subject: 'Filtered employee export' };
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  XLSX.writeFile(wb, fileName);
}
