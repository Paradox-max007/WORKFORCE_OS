'use client';

// ============================================================================
// PULSE Workforce OS — Payroll → Excel (.xlsx) export
// ----------------------------------------------------------------------------
// The Excel button on the Payroll page opens the PREVIEW page first: it renders
// the CURRENTLY FILTERED payroll rows (search / region / country / camp /
// trade / payment method / status) as a spreadsheet-styled table where columns
// can be toggled (all selected by default). Its Download button writes the
// .xlsx through THIS module. Both use the SAME column definition below, so the
// preview always matches the file.
//
// Column order mirrors the Payroll table: AMOUNT comes BEFORE ADVANCE.
// ============================================================================

import type { PayrollEmployeeVM } from '@/lib/types';
import { regionShortOfNationality } from '@/lib/nationality-groups';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** BALANCE = (time card hours − total hours) × effective rate − net payable.
 *  Effective rate = gross ÷ total hours (the blended rate actually used by
 *  the month's salary lines — handles mid-month trade / rate changes). */
export function payrollBalanceOf(e: PayrollEmployeeVM): number | null {
  if (e.time_card_hours == null) return null;
  const rate = e.total_hours > 0 ? e.gross_salary / e.total_hours : 0;
  return round2((e.time_card_hours - e.total_hours) * rate - e.net_salary);
}

/** The effective hourly rate behind the Balance column (gross ÷ total hours). */
export function payrollEffectiveRateOf(e: PayrollEmployeeVM): number {
  return e.total_hours > 0 ? e.gross_salary / e.total_hours : 0;
}

/** One Excel column — shared by the .xlsx writer and the preview page. */
export interface PayrollExportColumn {
  key: string;
  header: string;
  width: number; // Excel column width (characters)
  /** value extractor (string | number — exactly what lands in the cell) */
  value: (e: PayrollEmployeeVM) => string | number;
  /** numeric columns are right-aligned in the preview and get a number
   *  format in the file; they also receive a sum in the TOTAL row */
  numeric?: boolean;
  /** money columns use the #,##0.00 Excel format */
  money?: boolean;
  /** sum for the TOTAL row (numeric columns only) */
  total?: (rows: PayrollEmployeeVM[]) => number;
}

/** The single source of truth for the exported columns — Amount BEFORE
 *  Advance, exactly like the Payroll table. NATIONALITY sits right after
 *  Code; the time-card columns (Final Hours next to Total Hours, Balance
 *  after Net Payable) are included ONLY when time card hours exist —
 *  "only give that extra columns when time card hours were added".
 *  The Payroll page passes hasTimeCard; the preview derives it from rows. */
export function buildPayrollExportColumns(hasTimeCard: boolean): PayrollExportColumn[] {
  const columns: PayrollExportColumn[] = [
    {
      key: 'name', header: 'Employee Name', width: 26,
      value: (e) => e.full_name,
    },
    {
      key: 'code', header: 'Code', width: 15,
      value: (e) => e.employee_code,
    },
    {
      key: 'nationality', header: 'Nationality', width: 14,
      value: (e) => regionShortOfNationality(e.nationality),
    },
    {
      key: 'hours', header: 'Total Hours', width: 12, numeric: true,
      value: (e) => round2(e.total_hours),
      total: (rows) => round2(rows.reduce((n, e) => n + e.total_hours, 0)),
    },
  ];
  if (hasTimeCard) {
    columns.push(
      {
        key: 'final_hours', header: 'Final Hours', width: 12, numeric: true,
        // approved time card hours ('' → nothing entered, unlike 0 which
        // would read as "the client recorded zero hours")
        value: (e) => (e.time_card_hours != null ? round2(e.time_card_hours) : ''),
        total: (rows) => round2(rows.reduce((n, e) => n + (e.time_card_hours ?? 0), 0)),
      },
      {
        key: 'balance', header: 'Balance', width: 13, numeric: true, money: true,
        value: (e) => {
          const bal = payrollBalanceOf(e);
          return bal != null ? round2(bal) : '';
        },
        total: (rows) => round2(rows.reduce((n, e) => n + (payrollBalanceOf(e) ?? 0), 0)),
      },
    );
  }
  columns.push(
    {
      key: 'trade', header: 'Trade', width: 22,
      value: (e) => e.trade_name ?? '',
    },
    {
      key: 'payment', header: 'Payment Method', width: 17,
      value: (e) => (e.payment_type === 'card' ? e.card_type ?? 'Card'
        : e.payment_type === 'cash' ? 'Cash' : ''),
    },
    {
      key: 'amount', header: 'Amount', width: 14, numeric: true, money: true,
      value: (e) => round2(e.gross_salary),
      total: (rows) => round2(rows.reduce((n, e) => n + e.gross_salary, 0)),
    },
    {
      key: 'advance', header: 'Advance', width: 12, numeric: true, money: true,
      value: (e) => round2(e.advance),
      total: (rows) => round2(rows.reduce((n, e) => n + e.advance, 0)),
    },
    {
      key: 'deduction', header: 'Deduction', width: 12, numeric: true, money: true,
      // manual deduction + the AUTOMATIC absent deduction — exactly what the
      // Payroll table shows, so gross − advance − deduction − … reconciles
      // with Net Payable
      value: (e) => round2(e.deduction + (e.absent_deduction ?? 0)),
      total: (rows) => round2(rows.reduce((n, e) => n + e.deduction + (e.absent_deduction ?? 0), 0)),
    },
    {
      key: 'net', header: 'Net Payable', width: 14, numeric: true, money: true,
      value: (e) => round2(e.net_salary),
      total: (rows) => round2(rows.reduce((n, e) => n + e.net_salary, 0)),
    },
  );
  return columns;
}

/** Columns WITHOUT the time-card pair (legacy shape — use
 *  buildPayrollExportColumns(rows.some(e => e.time_card_hours != null)) to
 *  match the live Payroll table). */
export const PAYROLL_EXPORT_COLUMNS: PayrollExportColumn[] = buildPayrollExportColumns(false);

/** Excel sheet name, e.g. "Payroll Nov 2026" (≤ 31 chars, always safe). */
export function payrollExportSheetName(year: number, month: number): string {
  return `Payroll ${MONTH_NAMES[month - 1].slice(0, 3)} ${year}`;
}

/** Build the download filename from the period + active filter chips, e.g.
 *   Pulse_Payroll_November-2026_Trade-Electrician_Status-Paid_2026-11-11.xlsx */
export function payrollExportFileName(year: number, month: number, chips: string[]): string {
  const sanitize = (s: string) =>
    s.trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28);
  const parts = chips
    .map((c) => sanitize(c))
    .filter(Boolean)
    .map((c) => c.charAt(0).toUpperCase() + c.slice(1))
    .join('_')
    .slice(0, 60);
  const date = new Date().toISOString().slice(0, 10);
  return `Pulse_Payroll_${MONTH_NAMES[month - 1]}-${year}${parts ? '_' + parts : ''}_${date}.xlsx`;
}

/** Write the .xlsx — only the SELECTED columns land in the file, in the same
 *  order as the preview, with a bold TOTAL row at the bottom. */
export async function exportPayrollToXlsx(
  rows: PayrollEmployeeVM[],
  columns: PayrollExportColumn[],
  fileName: string,
  sheetName: string,
): Promise<void> {
  // dynamic import keeps SheetJS out of the main bundle
  const XLSX = await import('xlsx');

  const aoa: (string | number)[][] = [
    columns.map((c) => c.header),
    ...rows.map((e) => columns.map((c) => c.value(e))),
    // TOTAL row — label in the first column, sums under the numeric ones
    columns.map((c, i) => (i === 0 ? 'TOTAL' : c.total ? c.total(rows) : '')),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map((c) => ({ wch: c.width }));

  // Excel number formats: #,##0.00 for money (hours stay General — 0.##
  // would render 265 as "265." in Excel, unlike the preview)
  columns.forEach((c, ci) => {
    if (!c.money) return;
    for (let ri = 1; ri <= rows.length + 1; ri++) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
    }
  });

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: `PULSE Workforce OS — Payroll ${sheetName.slice(8)}`,
    Subject: 'Filtered payroll export',
  };
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, fileName);
}
