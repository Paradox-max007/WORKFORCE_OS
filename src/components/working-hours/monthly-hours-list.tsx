'use client';

// ============================================================================
// PULSE Workforce OS — Monthly hours list (Working Hours module)
// ----------------------------------------------------------------------------
// Chronological month cards (newest first). Each card expands to its per-site
// breakdown; the latest month starts expanded. Totals reconcile by design:
// month total = Σ site totals, lifetime = opening + Σ month totals.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import { CalendarDays, ChevronRight, Clock } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/shared/primitives';
import { cn } from '@/lib/utils';
import type { WorkingHoursMonth } from '@/lib/types';
import { MonthlySiteBreakdown } from './monthly-site-breakdown';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const monthKey = (m: WorkingHoursMonth): string => `${m.year}-${m.month}`;

const fmtHrs = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The parent remounts this list per employee (key = employee id), so the
// "latest month expanded" default comes from the initial state — no effects.
// Realtime refreshes keep the currently expanded month because keys are
// date-based, not object-identity based.
export function MonthlyHoursList({ months }: { months: WorkingHoursMonth[] }) {
  const [openKey, setOpenKey] = useState<string | null>(months[0] ? monthKey(months[0]) : null);

  if (months.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays size={26} />}
        title="No attendance history yet"
        description="Hours appear here month by month as soon as attendance is marked for this employee. The historical opening balance is already included in the lifetime total above."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarDays size={15} className="text-brand" /> Monthly Working Hours
        </h3>
        <p className="text-[11px] text-muted-foreground">
          {months.length} month{months.length !== 1 ? 's' : ''} with recorded hours · newest first
        </p>
      </div>

      {months.map((m, idx) => {
        const key = monthKey(m);
        const open = openKey === key;
        return (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: Math.min(idx * 0.04, 0.3), ease: EASE }}
            className="card-glow overflow-hidden rounded-xl border bg-card"
          >
            <button
              type="button"
              onClick={() => setOpenKey(open ? null : key)}
              aria-expanded={open}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-brand/[0.04]"
            >
              <span className="flex size-9 shrink-0 flex-col items-center justify-center rounded-lg bg-brand/10 text-brand">
                <span className="text-[9px] font-bold uppercase leading-none">{MONTH_NAMES[m.month - 1].slice(0, 3)}</span>
                <span className="text-[11px] font-bold leading-tight">{m.year}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{MONTH_NAMES[m.month - 1]} {m.year}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {m.attendanceDays} day{m.attendanceDays !== 1 ? 's' : ''} with recorded hours ·{' '}
                  {m.sites.length} site{m.sites.length !== 1 ? 's' : ''}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-base font-bold tabular-nums">{fmtHrs(m.totalHours)}<span className="ml-1 text-[10px] font-medium text-muted-foreground">hrs</span></span>
                <span className="block text-[10px] text-muted-foreground">
                  ~{m.attendanceDays > 0 ? fmtHrs(Math.round((m.totalHours / m.attendanceDays) * 100) / 100) : '0'} h/day
                </span>
              </span>
              <ChevronRight
                size={15}
                className={cn('shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-90')}
              />
            </button>

            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="border-t bg-muted/20 p-3">
                    <MonthlySiteBreakdown sites={m.sites} monthTotal={m.totalHours} />
                    <p className="mt-2.5 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
                      <Clock size={10} />
                      Site totals sum to the month total — every day is attributed to the site the
                      employee belonged to on that date (mid-month transfers split automatically).
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}
