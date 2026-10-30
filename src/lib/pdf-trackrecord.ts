// ============================================================================
// PULSE Workforce OS — Track Record PDF export (html2canvas-pro → jsPDF)
// ----------------------------------------------------------------------------
// Reuses the shared exportElementToPdf pipeline from @/lib/pdf: the preview
// element is captured with html2canvas-pro at scale 2 on a white background,
// then the tall canvas image is sliced across A4 pages. The preview element
// must be attached to the (visible) DOM when this is called — it stays
// on-screen inside the share dialog for exactly that reason.
// ============================================================================

import { exportElementToPdf } from '@/lib/pdf';
import type { EmployeeVM } from '@/lib/types';

/**
 * Deterministic PDF filename: TrackRecord_<full name with underscores>_<code>.pdf
 */
export function trackRecordFilename(emp: EmployeeVM): string {
  return `TrackRecord_${emp.full_name.trim().replace(/\s+/g, '_')}_${emp.employee_code}.pdf`;
}

/**
 * Captures the rendered track record preview (header + month calendar cards
 * with their totals) and saves it as a multi-page A4 PDF. Long previews are
 * sliced across pages exactly like the attendance sheet export.
 */
export async function exportTrackRecordPdf(previewEl: HTMLElement, filename: string): Promise<void> {
  await exportElementToPdf(previewEl, filename);
}
