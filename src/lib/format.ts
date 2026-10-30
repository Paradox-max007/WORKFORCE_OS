// ============================================================================
// PULSE Workforce OS — formatting helpers
// ============================================================================

import { format, parseISO } from 'date-fns';

export const fmtDate = (iso: string | null | undefined, pattern = 'd MMM yyyy'): string => {
  if (!iso) return '—';
  try {
    const d = iso.length === 10 ? parseISO(iso) : new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return format(d, pattern);
  } catch {
    return '—';
  }
};

export const fmtDateTime = (iso: string | null | undefined): string => fmtDate(iso, 'd MMM yyyy · h:mm a');

export const fmtTimeAgo = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
};

export const fmtSar = (amount: number): string =>
  new Intl.NumberFormat('en-SA', { style: 'currency', currency: 'SAR', maximumFractionDigits: 2 }).format(amount);

export const initials = (name: string): string =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

/** days until renewal date (negative = already due) */
export const daysUntil = (iso: string): number =>
  Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
