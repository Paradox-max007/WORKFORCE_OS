'use client';

// ============================================================================
// PULSE Workforce OS — Employee directory → Excel (.xlsx) export
// ----------------------------------------------------------------------------
// Exports the CURRENTLY FILTERED employee list (search / status / nationality /
// camp) with a filename that mirrors the active filters, e.g.
//   Pulse_Employees_Camp-Sonapur-Labour-Camp_Nationality-Kenya_2026-10-29.xlsx
// ============================================================================

import type { EmployeeVM } from '@/lib/types';

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

  const data = rows.map((e, i) => ({
    'S.No': i + 1,
    'Employee ID': e.employee_code,
    'Full Name': e.full_name,
    'Nationality': e.nationality ?? '',
    'Trade / Position': e.position ?? '',
    'Company': e.company_name ?? '',
    'Work Site': e.site_name ?? 'Unassigned (Idle)',
    'Camp': e.camp_name ?? '',
    'Block': e.camp_block ?? '',
    'Room': e.camp_room ?? '',
    'Phone': e.phone ?? '',
    'Email': e.email ?? '',
    'Join Date': e.join_date ?? '',
    'Rating': e.rating,
    'Status': e.status,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 6 },   // S.No
    { wch: 16 },  // Employee ID
    { wch: 24 },  // Full Name
    { wch: 18 },  // Nationality
    { wch: 20 },  // Trade / Position
    { wch: 18 },  // Company
    { wch: 26 },  // Work Site
    { wch: 24 },  // Camp
    { wch: 8 },   // Block
    { wch: 8 },   // Room
    { wch: 18 },  // Phone
    { wch: 26 },  // Email
    { wch: 14 },  // Join Date
    { wch: 8 },   // Rating
    { wch: 16 },  // Status
  ];

  const wb = XLSX.utils.book_new();
  wb.Props = { Title: 'PULSE Workforce OS — Employee Directory', Subject: 'Filtered employee export' };
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  XLSX.writeFile(wb, fileName);
}
