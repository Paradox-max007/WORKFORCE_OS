// ============================================================================
// PULSE Workforce OS — PDF generation library (jsPDF + html2canvas-pro)
// ============================================================================

import jsPDF from 'jspdf';
import type { EmployeeVM, LeaveRequestVM } from '@/lib/types';

const BRAND = 'PULSE WORKFORCE OS';
const BRAND_SHORT = 'PULSE Workforce';
const BRAND_COLOR: [number, number, number] = [124, 58, 237]; // violet
const INK: [number, number, number] = [24, 24, 29];
const MUTED: [number, number, number] = [110, 110, 122];

// ---------------------------------------------------------------------------
// Employee CV / report PDF
// ---------------------------------------------------------------------------
export function generateEmployeeCvPdf(emp: EmployeeVM, asCv: boolean): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 16;
  let y = 0;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - 18) {
      doc.addPage();
      y = 20;
    }
  };

  const sectionTitle = (title: string) => {
    ensureSpace(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...BRAND_COLOR);
    doc.text(title.toUpperCase(), margin, y);
    y += 2;
    doc.setDrawColor(...BRAND_COLOR);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageW - margin, y);
    y += 6;
  };

  const kvRow = (key: string, value: string | null | undefined) => {
    ensureSpace(7);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    doc.text(key, margin + 2, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(value && value.trim() ? value : '—', margin + 62, y);
    y += 7;
  };

  // Header band
  doc.setFillColor(12, 12, 20);
  doc.rect(0, 0, pageW, asCv ? 30 : 34, 'F');
  doc.setFillColor(...BRAND_COLOR);
  doc.rect(0, asCv ? 30 : 34, pageW, 1.4, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text(emp.full_name, margin, asCv ? 13 : 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  if (asCv) {
    doc.setTextColor(196, 181, 253);
    doc.text(`${emp.position ?? 'Team Member'}  ·  ${emp.employee_code}`, margin, asCv ? 20 : 21);
  } else {
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.text(BRAND, margin, 9);
    doc.setFontSize(15);
    doc.text(emp.full_name, margin, 19);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(196, 181, 253);
    doc.setFontSize(9.5);
    doc.text(`Employee Details Report  ·  ${emp.employee_code}`, margin, 26);
  }
  y = asCv ? 40 : 44;

  sectionTitle('Personal Information');
  kvRow('Full Name', emp.full_name);
  kvRow('Employee ID', emp.employee_code);
  kvRow('Nationality', emp.nationality);
  kvRow('Date of Birth', emp.date_of_birth);
  kvRow('Phone', emp.phone);
  kvRow('Email', emp.email);
  kvRow('Emergency Contact', emp.emergency_contact);
  kvRow('Home Country Address', emp.address);
  y += 4;

  sectionTitle('Employment Information');
  kvRow('Position', emp.position);
  kvRow('Company', emp.company_name);
  kvRow('Join Date', emp.join_date);
  kvRow('Current Site', emp.site_name ?? 'Not Assigned');
  kvRow('Accommodation', emp.camp_name
    ? `${emp.camp_name}${emp.camp_block ? ` — Block ${emp.camp_block}` : ''}${emp.camp_room ? `, Room ${emp.camp_room}` : ''}`
    : 'No camp assigned');
  kvRow('Employment Status', emp.status === 'active' ? 'Active' : emp.status === 'pending_deletion' ? 'Pending Deletion' : 'Deleted');
  kvRow('Team Leader', emp.is_team_leader ? `Yes — of ${emp.leader_site_name ?? 'a site'}` : 'No');
  kvRow('Performance Rating', `${emp.rating.toFixed(1)} / 5.0`);
  y += 4;

  sectionTitle('Document Information');
  kvRow('Passport Number', emp.passport_number);
  kvRow('Passport Status', emp.passport_status ?? '—');
  kvRow('ID Number', emp.id_number);
  kvRow('ID Status', emp.id_status ?? '—');

  // Footer on every page
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`${BRAND_SHORT} · Employee: ${emp.full_name} (${emp.employee_code})`, margin, pageH - 8);
    doc.text(`Page ${i} of ${total}`, pageW - margin, pageH - 8, { align: 'right' });
  }
  return doc;
}

export const employeeCvFilename = (emp: EmployeeVM): string =>
  `CV_${emp.full_name.replace(/\s+/g, '_')}_${emp.employee_code}.pdf`;

export function downloadEmployeeCv(emp: EmployeeVM): void {
  generateEmployeeCvPdf(emp, true).save(employeeCvFilename(emp));
}

export function shareEmployeeCvViaWhatsApp(emp: EmployeeVM): void {
  generateEmployeeCvPdf(emp, true).save(employeeCvFilename(emp));
  window.open('https://wa.me/?text=Employee+details+attached', '_blank');
}

// ---------------------------------------------------------------------------
// Leave application PDF
// ---------------------------------------------------------------------------
export function generateLeavePdf(req: LeaveRequestVM): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 20;
  let y = 22;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...INK);
  doc.text('PULSE WORKFORCE OS LLC.', pageW / 2, y, { align: 'center' });
  y += 6;
  doc.setDrawColor(...BRAND_COLOR);
  doc.setLineWidth(0.8);
  doc.line(margin, y, pageW - margin, y);
  y += 10;

  doc.setFontSize(13);
  doc.text('LEAVE APPLICATION FORM', pageW / 2, y, { align: 'center' });
  y += 9;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(`Reference: LEAVE-${req.id.slice(0, 8).toUpperCase()}`, margin, y);
  doc.text(`Application Date: ${new Date(req.created_at).toLocaleDateString('en-GB')}`, pageW - margin, y, { align: 'right' });
  y += 6;
  doc.text(
    `Status: ${req.status.toUpperCase()}`,
    margin, y,
  );
  y += 10;

  const section = (title: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...BRAND_COLOR);
    doc.text(title, margin, y);
    y += 2;
    doc.setDrawColor(200, 200, 210);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 5;
  };
  const kv = (key: string, value: string | null | undefined) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    doc.text(key, margin + 2, y);
    doc.setTextColor(...INK);
    doc.text(value || '—', margin + 55, y);
    y += 6.5;
  };

  section('EMPLOYEE INFORMATION');
  kv('Name', req.employee_name);
  kv('Employee ID', req.employee_code);
  kv('Designation', req.employee_position);
  kv('Company', req.employee_company);
  kv('Contact', req.employee_phone);
  kv('Nationality', req.employee_nationality);
  y += 4;

  section('LEAVE DETAILS');
  kv('Leave Type', req.other_type_text || req.leave_type);
  kv('Start Date', new Date(req.start_date).toLocaleDateString('en-GB'));
  kv('End Date', new Date(req.end_date).toLocaleDateString('en-GB'));
  kv('Total Days', String(req.total_days));
  y += 4;

  section('REASON FOR LEAVE');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9.5);
  doc.setTextColor(...INK);
  const lines = doc.splitTextToSize(req.reason || '—', pageW - margin * 2 - 4) as string[];
  lines.forEach((l) => { doc.text(l, margin + 2, y); y += 6; });

  if (req.reviewed_by_name) {
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    doc.text(`${req.status === 'approved' ? 'Approved' : 'Rejected'} by: ${req.reviewed_by_name}`, margin + 2, y);
  }

  y = Math.max(y + 26, 240);
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + 65, y);
  doc.line(pageW - margin - 65, y, pageW - margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text('Employee Signature', margin + 2, y + 4.5);
  doc.text('HR / Office Admin', pageW - margin - 63, y + 4.5);

  doc.setFontSize(7.5);
  doc.text('This is a computer-generated document.', pageW / 2, 285, { align: 'center' });
  return doc;
}

export const leavePdfFilename = (req: LeaveRequestVM): string =>
  `leave-application-${req.employee_name.replace(/\s+/g, '-').toLowerCase()}-${req.id.slice(0, 8)}.pdf`;

export function downloadLeavePdf(req: LeaveRequestVM): void {
  generateLeavePdf(req).save(leavePdfFilename(req));
}

export function openLeavePrintWindow(req: LeaveRequestVM): void {
  const type = req.other_type_text || req.leave_type;
  const html = `<!doctype html><html><head><title>Leave Application</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;color:#18181b;margin:40px;max-width:640px}
    h1{font-size:18px;text-align:center;letter-spacing:1px}
    hr{border:none;border-top:2px solid #7c3aed;margin:14px 0}
    h2{font-size:11px;color:#7c3aed;letter-spacing:1px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:22px}
    p{font-size:12px;line-height:1.7}
    .row{display:flex;justify-content:space-between;font-size:12px;color:#666;margin:4px 0}
    .sig{margin-top:70px;display:flex;justify-content:space-between}
    .sig div{border-top:1px solid #333;width:200px;text-align:center;font-size:10px;color:#666;padding-top:4px}
  </style></head><body>
  <h1>PULSE WORKFORCE OS LLC.</h1><hr>
  <h1 style="font-size:14px">LEAVE APPLICATION FORM</h1>
  <div class="row"><span>Reference: LEAVE-${req.id.slice(0, 8).toUpperCase()}</span><span>Date: ${new Date(req.created_at).toLocaleDateString('en-GB')}</span></div>
  <div class="row"><span>Status: <b>${req.status.toUpperCase()}</b></span><span></span></div>
  <h2>EMPLOYEE INFORMATION</h2>
  <p><b>Name:</b> ${req.employee_name} &nbsp; <b>ID:</b> ${req.employee_code}<br/>
  <b>Designation:</b> ${req.employee_position ?? '—'} &nbsp; <b>Company:</b> ${req.employee_company ?? '—'}<br/>
  <b>Contact:</b> ${req.employee_phone ?? '—'} &nbsp; <b>Nationality:</b> ${req.employee_nationality ?? '—'}</p>
  <h2>LEAVE DETAILS</h2>
  <p><b>Leave Type:</b> ${type}<br/>
  <b>Start:</b> ${new Date(req.start_date).toLocaleDateString('en-GB')} &nbsp; <b>End:</b> ${new Date(req.end_date).toLocaleDateString('en-GB')} &nbsp; <b>Total Days:</b> ${req.total_days}</p>
  <h2>REASON FOR LEAVE</h2>
  <p><i>${req.reason}</i></p>
  ${req.reviewed_by_name ? `<p><b>${req.status === 'approved' ? 'Approved' : 'Rejected'} by:</b> ${req.reviewed_by_name}</p>` : ''}
  <div class="sig"><div>Employee Signature</div><div>HR / Office Admin</div></div>
  </body></html>`;
  const w = window.open('', '_blank', 'width=800,height=900');
  if (w) {
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 350);
  }
}

export async function shareLeaveViaWhatsApp(req: LeaveRequestVM): Promise<void> {
  const doc = generateLeavePdf(req);
  const blob = doc.output('blob');
  const file = new File([blob], leavePdfFilename(req), { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  const type = req.other_type_text || req.leave_type;
  const text = `Leave application for ${req.employee_name} (${type}, ${req.total_days} day(s)) — form attached.`;
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Leave Application', text });
      return;
    } catch { /* user cancelled → fall through */ }
  }
  doc.save(leavePdfFilename(req));
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// ---------------------------------------------------------------------------
// Attendance sheet export (html2canvas-pro at scale 2)
// ---------------------------------------------------------------------------
export async function exportElementToPdf(el: HTMLElement, filename: string): Promise<void> {
  const { default: html2canvas } = await import('html2canvas-pro');
  const canvas = await html2canvas(el, {
    scale: 2,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
  });
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW - 10;
  const imgH = (canvas.height * imgW) / canvas.width;
  let remaining = imgH;
  let position = 0;
  const img = canvas.toDataURL('image/jpeg', 0.92);

  pdf.addImage(img, 'JPEG', 5, 5, imgW, imgH);
  remaining -= pageH - 10;
  while (remaining > 0) {
    position += pageH - 10;
    pdf.addPage();
    pdf.addImage(img, 'JPEG', 5, 5 - position, imgW, imgH);
    remaining -= pageH - 10;
  }
  pdf.save(filename);
}

export function printElement(el: HTMLElement): void {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(`<!doctype html><html><head><title>Print</title>
    <style>@page{size:A4;margin:0}html,body{margin:0;padding:0;background:#fff}</style>
  </head><body>${el.outerHTML}</body></html>`);
  doc.close();
  const doPrint = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 4000);
  };
  if (iframe.contentWindow?.document.readyState === 'complete') setTimeout(doPrint, 300);
  else iframe.onload = () => setTimeout(doPrint, 300);
}
