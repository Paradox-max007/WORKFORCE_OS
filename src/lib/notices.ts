// ============================================================================
// PULSE Workforce OS — Formal letters & notices (domain layer, pure functions)
// ----------------------------------------------------------------------------
// Everything needed to compose the three formal documents issued from the
// Notifications Hub:
//
//   • WARNING LETTER      (from any warning record — manual or auto-generated)
//   • TERMINATION LETTER  (own record type, created from the Letters tab)
//   • FINE NOTICE         (from any fine record)
//
// Pure functions only (no jsPDF / no DOM) so tests and the PDF renderer share
// exactly the same wording, reference codes and creator identification:
//
//   noticeRef()              WARN-1A2B3C4D / TERM-… / FINE-…
//   buildNoticeBody()        the formal letter paragraphs (custom body wins)
//   buildNoticeWhatsAppText() compact chat message for wa.me links
//   sanitizeWhatsAppNumber()  +966 5xx… → 9665xx… (editable in the send dialog)
//   noticeCreatorLine()      "Created by: <User Name>" / "Created by: System"
// ============================================================================

import type { EmployeeVM } from '@/lib/types';

export type NoticeKind = 'warning' | 'termination' | 'fine';
export type TerminationNoticeBasis = 'immediate' | 'with_notice' | 'payment_in_lieu';

export const NOTICE_KINDS: { kind: NoticeKind; label: string; title: string }[] = [
  { kind: 'warning', label: 'Warning Letter', title: 'WARNING LETTER' },
  { kind: 'termination', label: 'Termination Letter', title: 'TERMINATION LETTER' },
  { kind: 'fine', label: 'Fine Notice', title: 'FINE NOTICE' },
];

export const noticeTitle = (kind: NoticeKind): string =>
  NOTICE_KINDS.find((k) => k.kind === kind)?.title ?? 'NOTICE';

export const noticeLabel = (kind: NoticeKind): string =>
  NOTICE_KINDS.find((k) => k.kind === kind)?.label ?? 'Notice';

/** Letterhead company of every formal notice — the COMPANY NAME SET IN THE
 *  SITE SETTINGS (Admin → Site Settings → company name). Falls back to the
 *  app brand when nothing is set. */
export const DEFAULT_COMPANY_NAME = 'PULSE WORKFORCE OS LLC.';

export function noticeCompanyHeading(companyName: string | null | undefined): string {
  const name = companyName?.trim();
  return name || DEFAULT_COMPANY_NAME;
}

/** Short, stable document reference (mirrors LEAVE-XXXXXXXX on leave forms). */
export function noticeRef(kind: NoticeKind, recordId: string): string {
  const prefix = kind === 'warning' ? 'WARN' : kind === 'termination' ? 'TERM' : 'FINE';
  return `${prefix}-${(recordId || '').replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Creator identification — auto-generated records belong to the SYSTEM,
// custom/manual ones carry the issuing user's name
// ---------------------------------------------------------------------------
export function noticeCreatorLine(creatorName: string | null | undefined, isAuto = false): string {
  if (isAuto) return 'Created by: System (Auto-generated)';
  const name = creatorName?.trim();
  return name ? `Created by: ${name}` : 'Created by: System';
}

// ---------------------------------------------------------------------------
// Letter bodies
// ---------------------------------------------------------------------------
export const TERMINATION_BASIS_LABELS: Record<TerminationNoticeBasis, string> = {
  immediate: 'Immediate termination',
  with_notice: 'Termination with notice period',
  payment_in_lieu: 'Payment in lieu of notice',
};

export interface NoticeLetterData {
  kind: NoticeKind;
  /** the employee the notice is for (full details end up on the letter) */
  employee: EmployeeVM;
  /** underlying record id (reference code) */
  recordId: string;
  /** why the notice exists (the warning / fine / termination reason) */
  reason: string;
  /** ISO timestamp of the record */
  createdAt: string;
  /** display name of the issuing user (null → System) */
  creatorName: string | null | undefined;
  /** system-generated record (e.g. the 3+ absence auto-warning) */
  isAuto?: boolean;
  /** warnings: the absence dates that triggered the auto-warning */
  absentDates?: string[] | null;
  /** fines: the imposed amount (SAR) */
  amount?: number;
  /** termination: last working day */
  effectiveDate?: string | null;
  /** termination: contractual basis */
  noticeBasis?: TerminationNoticeBasis;
  /** termination: free-text body — when present it replaces the standard text */
  customBody?: string | null;
  /** issuing company for the letterhead — the Site Settings company name
   *  (filled in by the PDF generator / WhatsApp sender when the caller omits it) */
  companyName?: string | null;
}

const fmtDay = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB');
};

const salutation = (employee: EmployeeVM): string => {
  const parts = employee.full_name.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? employee.full_name;
  return `Dear Mr./Ms. ${last},`;
};

/** The formal letter paragraphs (custom body, when given, replaces them all). */
export function buildNoticeBody(data: NoticeLetterData): string[] {
  if (data.customBody && data.customBody.trim()) {
    return data.customBody.trim().split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  }
  switch (data.kind) {
    case 'warning': {
      const paras = [
        `${salutation(data.employee)}`,
        `This letter serves as a formal written warning regarding the following matter: ${data.reason.trim()}`,
      ];
      if (data.isAuto && data.absentDates && data.absentDates.length > 0) {
        paras.push(
          `Our attendance records show that you were marked absent, without approved leave, on the following date(s): `
          + `${data.absentDates.map((d) => fmtDay(d)).join(', ')}. This constitutes a violation of the company attendance policy.`,
        );
      }
      paras.push(
        'Please note that any repetition of such conduct may result in further disciplinary action, '
        + 'including financial penalties or termination of employment, in accordance with company policy '
        + 'and your employment contract.',
        'You are advised to show immediate and sustained improvement. Kindly acknowledge receipt of this '
        + 'letter by signing below.',
      );
      return paras;
    }
    case 'fine': {
      const amount = typeof data.amount === 'number' ? data.amount.toFixed(2) : '0.00';
      return [
        `${salutation(data.employee)}`,
        `This notice is to formally inform you that a fine of SAR ${amount} has been imposed on you for the following reason: ${data.reason.trim()}`,
        'The above amount will be deducted from your salary or other payments due to you, as per company '
        + 'policy and your employment contract.',
        'Kindly acknowledge receipt of this notice by signing below.',
      ];
    }
    case 'termination': {
      const basis = data.noticeBasis ?? 'with_notice';
      const basisText = basis === 'immediate'
        ? 'Your employment is terminated with immediate effect.'
        : basis === 'payment_in_lieu'
          ? 'In lieu of the applicable notice period, a payment in lieu of notice will be made to you as per your employment contract.'
          : 'You are required to serve the applicable notice period as per your employment contract.';
      // the issuing company from the Site Settings (the employee's stored
      // company is the secondary fallback); "the Company" when neither is set
      const named = (data.companyName ?? data.employee.company_name)?.trim();
      const employer = named || 'the Company';
      return [
        `${salutation(data.employee)}`,
        `We regret to inform you that your employment with ${employer} is hereby terminated, effective `
        + `${fmtDay(data.effectiveDate)}, for the following reason: ${data.reason.trim()}`,
        basisText,
        'Your final settlement, including any dues and end-of-service benefits, will be processed in '
        + 'accordance with company policy and applicable labour regulations. You are requested to return '
        + 'all company property in your possession and complete the clearance formalities before your '
        + 'final departure.',
        'We thank you for your services and wish you the best in your future endeavours.',
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------
/** "+966 512 34 567" / "0512 345 678" / "00971…" → wa.me diallable digits. */
export function sanitizeWhatsAppNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  // local Saudi mobile (05xxxxxxxx) → international 9665xxxxxxxx
  if (digits.startsWith('0')) digits = `966${digits.slice(1)}`;
  return digits || null;
}

/** Compact chat text for wa.me (kept well under URL limits). */
export function buildNoticeWhatsAppText(data: NoticeLetterData): string {
  const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  const lines = [
    `*${noticeCompanyHeading(data.companyName ?? data.employee.company_name)} — ${noticeTitle(data.kind)}*`,
    `To: ${data.employee.full_name} (${data.employee.employee_code})`,
    `Ref: ${noticeRef(data.kind, data.recordId)} · ${fmtDay(data.createdAt)}`,
  ];
  if (data.kind === 'fine' && typeof data.amount === 'number') {
    lines.push(`Amount: SAR ${data.amount.toFixed(2)}`);
  }
  if (data.kind === 'termination') {
    lines.push(`Effective: ${fmtDay(data.effectiveDate)} · ${TERMINATION_BASIS_LABELS[data.noticeBasis ?? 'with_notice']}`);
  }
  lines.push(`Reason: ${clip(data.reason.trim(), 220)}`);
  lines.push(noticeCreatorLine(data.creatorName, data.isAuto));
  return lines.join('\n');
}

/** File name for the generated PDF. */
export function noticePdfFilename(data: NoticeLetterData): string {
  const kind = data.kind === 'warning' ? 'warning-letter' : data.kind === 'termination' ? 'termination-letter' : 'fine-notice';
  const name = data.employee.full_name.replace(/\s+/g, '-').toLowerCase();
  return `${kind}-${name}-${(data.recordId || '').replace(/-/g, '').slice(0, 8).toLowerCase()}.pdf`;
}
