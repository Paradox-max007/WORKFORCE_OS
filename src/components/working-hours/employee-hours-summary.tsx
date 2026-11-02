'use client';

// ============================================================================
// PULSE Workforce OS — Employee hours summary (Working Hours module)
// ----------------------------------------------------------------------------
// The selected employee's identity band + the three numbers management cares
// about: LIFETIME HOURS (opening balance + everything PULSE has tracked),
// the historical opening balance itself, and the tracked total.
// ============================================================================

import { motion } from 'framer-motion';
import { Building2, CalendarDays, Clock, Crown, History, MapPin } from 'lucide-react';
import { AnimatedCounter, EmployeeStatusBadge } from '@/components/shared/primitives';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { EmployeeWorkingHoursReport } from '@/lib/types';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function MiniStat({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-3.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className={cn('flex size-6 items-center justify-center rounded-md', tone)}>{icon}</span>
        <p className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-1.5 text-xl font-semibold tabular-nums">
        <AnimatedCounter value={value} decimals={2} />
        <span className="ml-1 text-xs font-normal text-muted-foreground">hrs</span>
      </p>
      {hint && <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

export function EmployeeHoursSummary({ report }: { report: EmployeeWorkingHoursReport }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="card-glow overflow-hidden rounded-2xl border bg-card"
    >
      {/* identity band */}
      <div className="flex flex-wrap items-center gap-4 border-b bg-muted/30 px-5 py-4">
        <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-brand/15 text-sm font-bold text-brand">
          {report.photo ? (
            <img src={report.photo} alt={report.fullName} className="size-full object-cover" />
          ) : (
            report.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{report.fullName}</h2>
            <EmployeeStatusBadge status={report.status} />
            {report.position && (
              <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {report.position}
              </span>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{report.employeeCode}</span>
            {report.siteName ? (
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} /> {report.siteName}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-500">
                <Building2 size={11} /> No site assigned
              </span>
            )}
            {report.joinDate && (
              <span className="inline-flex items-center gap-1">
                <CalendarDays size={11} /> Joined {fmtDate(report.joinDate)}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* lifetime total + split */}
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[1.2fr_1fr_1fr_1fr]">
        <div className="flex flex-col justify-center rounded-xl border border-brand/20 bg-brand/[0.05] p-4">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Clock size={12} className="text-brand" /> Total lifetime working hours
          </p>
          <p className="mt-1.5 text-4xl font-bold tracking-tight text-brand">
            <AnimatedCounter value={report.lifetimeHours} decimals={2} />
            <span className="ml-1.5 text-base font-semibold text-muted-foreground">hrs</span>
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Historical balance + attendance-recorded hours
          </p>
        </div>
        <MiniStat
          icon={<History size={13} />}
          label="Historical hours"
          value={report.openingHours}
          tone="bg-amber-500/10 text-amber-500"
          hint={report.openingHours > 0 ? 'Before PULSE tracking' : 'None recorded'}
        />
        <MiniStat
          icon={<CalendarDays size={13} />}
          label="Tracked hours"
          value={report.trackedHours}
          tone="bg-emerald-500/10 text-emerald-500"
          hint={`${report.monthlyBreakdown.length} month${report.monthlyBreakdown.length !== 1 ? 's' : ''} recorded`}
        />
        <MiniStat
          icon={<Crown size={13} />}
          label="Opening + tracked"
          value={report.openingHours + report.trackedHours}
          tone="bg-brand/10 text-brand"
          hint="Always reconciles with the lifetime total"
        />
      </div>

      {report.openingHours > 0 && (
        <p className="border-t bg-muted/20 px-5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          Includes a historical opening balance of{' '}
          <span className="font-semibold text-foreground">{report.openingHours.toLocaleString()} hrs</span>{' '}
          imported from before PULSE started tracking attendance — the monthly breakdown below covers tracked
          hours only (historical months/sites are unavailable and are never invented).
        </p>
      )}
    </motion.section>
  );
}
