'use client';

// ============================================================================
// PULSE Workforce OS — Attendance Record (dedicated per-employee calendar page)
// ----------------------------------------------------------------------------
// Clicking the DEDUCTION amount of an employee on the Payroll page opens THIS
// page. It shows the employee's payroll month as a real CALENDAR:
//
//   • header — employee NAME + CODE on top, photo, the payroll month and the
//     TOTAL HOURS, plus the full settlement breakdown (gross / advance /
//     manual deduction / ABSENT deduction / net)
//   • ABSENT DEDUCTION — the first N absences of the month are free, every
//     absence after those costs AED X (N and X CONFIGURABLE in Trade/Ded
//     Management → Deductions — fetched live via getDeductionSettings).
//     The calendar marks each chargeable absent day with a −X chip
//   • ONE CALENDAR PER SITE — an employee who worked at 2 sites in the month
//     gets 2 calendars. Days worked at THAT site are green; days worked at
//     another site are muted (the tooltip names the site); absences are red
//   • legend + a notice when the attendance changed after the payroll was
//     generated (drafts recalculate automatically on the Payroll page)
// ============================================================================

import { motion } from 'framer-motion';
import {
  ArrowLeft, CalendarDays, Clock, MapPin, UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { dataApi } from '@/lib/data';
import {
  DEFAULT_DEDUCTION_SETTINGS, type Attendance, type DeductionSettings,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const fmtMoney = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtHrs = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const ymd = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const initials = (name: string): string =>
  name.split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase();

/** one day cell of the calendar */
interface DayCell {
  day: number | null;           // null → leading blank cell
  record?: Attendance;          // attendance row of that date
  siteName?: string | null;     // site the day's priced line belongs to
  chargeable?: boolean;         // absent AND beyond the free allowance
}

export function AttendanceCalendarPage() {
  const payload = useAppStore((s) => s.attendanceCalendar);
  const navigateTo = useAppStore((s) => s.navigateTo);
  const [records, setRecords] = useState<Attendance[] | null>(null);
  // effective absent-deduction rule (Trade Management → Deductions); the
  // fallback keeps the page working when the RPC is unavailable
  const [rule, setRule] = useState<DeductionSettings>(DEFAULT_DEDUCTION_SETTINGS);

  useEffect(() => {
    let alive = true;
    dataApi.getDeductionSettings()
      .then((s) => { if (alive) setRule(s); })
      .catch(() => { /* keep the default rule */ });
    return () => { alive = false; };
  }, []);

  const { employee, year, month } = payload ?? {};
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  // the month's attendance for THIS employee (records of all sites)
  useEffect(() => {
    if (!employee) return;
    let alive = true;
    setRecords(null);
    dataApi.getMonthAttendance(monthKey)
      .then((all) => {
        if (alive) setRecords(all.filter((a) => a.employee_id === employee.employee_id));
      })
      .catch(() => { if (alive) setRecords([]); });
    return () => { alive = false; };
  }, [employee, monthKey]);

  // ---- per-day data ---------------------------------------------------------
  const recordsByDate = useMemo(() => {
    const map = new Map<string, Attendance>();
    records?.forEach((r) => map.set(r.date, r));
    return map;
  }, [records]);

  // date → site the day's priced salary line belongs to (from the payroll
  // payload — an employee who moved mid-month has lines under both sites)
  const lineSiteByDate = useMemo(() => {
    const map = new Map<string, string>();
    employee?.sites.forEach((s) => s.lines.forEach((l) => map.set(l.date, s.site_name)));
    return map;
  }, [employee]);

  const absentDates = useMemo(
    () => records
      ? records.filter((r) => r.status === 'absent').map((r) => r.date).sort()
      : [],
    [records],
  );
  // the first `absent_free_days` absences are free; every absence after
  // those costs `absent_deduction_amount` (Deduction Management)
  const chargeableDates = useMemo(
    () => new Set(absentDates.slice(rule.absent_free_days)),
    [absentDates, rule.absent_free_days],
  );
  const computedAbsentDeduction = round2(
    Math.max(absentDates.length - rule.absent_free_days, 0) * rule.absent_deduction_amount,
  );

  // ---- the month grid (Sunday-first weeks) ----------------------------------
  const weeks = useMemo<DayCell[][]>(() => {
    const daysInMonth = new Date(year!, month!, 0).getDate();
    const firstWeekday = new Date(year!, month! - 1, 1).getDay();
    const cells: DayCell[] = Array.from({ length: firstWeekday }, () => ({ day: null }));
    for (let d = 1; d <= daysInMonth; d++) {
      const date = ymd(year!, month!, d);
      cells.push({
        day: d,
        record: recordsByDate.get(date),
        siteName: lineSiteByDate.get(date) ?? null,
        chargeable: chargeableDates.has(date),
      });
    }
    while (cells.length % 7 !== 0) cells.push({ day: null });
    const rows: DayCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [year, month, recordsByDate, lineSiteByDate, chargeableDates]);

  if (!payload || !employee) {
    return (
      <div className="mx-auto max-w-[1600px]">
        <EmptyState
          icon={<CalendarDays size={22} />}
          title="No employee selected"
          description="Open the Payroll page and click a deduction amount to see that employee's attendance calendar."
          action={
            <Button variant="outline" onClick={() => navigateTo('payroll')}>
              <ArrowLeft size={15} className="mr-1.5" /> Back to Payroll
            </Button>
          }
        />
      </div>
    );
  }

  // one calendar per site the employee worked at that month (the payroll's
  // site buckets); idle employees without a single site row get one
  // "No site" calendar so the month is still visible
  const calendars = employee.sites.length > 0
    ? employee.sites.map((s) => ({ key: s.site_id ?? 'no-site', name: s.site_name, hours: s.total_hours }))
    : [{ key: 'no-site', name: 'No site — no tracked hours this month', hours: 0 }];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto max-w-[1600px] space-y-4"
    >
      {/* header — employee name + code on top, month, back to Payroll */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigateTo('payroll')} aria-label="Back to the payroll table">
            <ArrowLeft size={15} /> Payroll
          </Button>
          <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand/15 text-sm font-bold text-brand">
            {employee.photo
              ? <img src={employee.photo} alt="" className="size-full object-cover" />
              : initials(employee.full_name)}
          </span>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
              {employee.full_name}
              <span className="rounded-full border border-border/60 bg-card px-2.5 py-0.5 font-mono text-xs font-semibold text-muted-foreground">
                {employee.employee_code}
              </span>
            </h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
              <CalendarDays size={13} /> Attendance record — {MONTH_NAMES[month! - 1]} {year}
            </p>
          </div>
        </div>
        {/* settlement recap — right side on desktop, below on mobile */}
        <div className="card-glow shrink-0 rounded-xl border bg-card px-4 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-1">
            <RecapRow label="Total hours" value={`${fmtHrs(employee.total_hours)} h`} icon={<Clock size={12} />} />
            <RecapRow label="Gross" value={`AED ${fmtMoney(employee.gross_salary)}`} />
            <RecapRow label="Advance" value={employee.advance > 0 ? `AED ${fmtMoney(employee.advance)}` : '—'} />
            <RecapRow label="Deduction (manual)" value={employee.deduction > 0 ? `AED ${fmtMoney(employee.deduction)}` : '—'} />
            <RecapRow label="Absent deduction" value={employee.absent_deduction > 0 ? `AED ${fmtMoney(employee.absent_deduction)}` : '—'} />
            <RecapRow label="Net payable" value={`AED ${fmtMoney(employee.net_salary)}`} strong />
          </div>
        </div>
      </div>

      {/* absent deduction summary — the rule, live from the calendar data */}
      <section className="card-glow rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-red-500/10 text-red-500">
              <UserRound size={16} />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Absent days</p>
              <p className="text-lg font-bold tabular-nums">{absentDates.length}</p>
            </div>
          </div>
          <div className="hidden h-9 w-px bg-border/60 sm:block" aria-hidden />
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Chargeable absences</p>
            <p className="text-lg font-bold tabular-nums">
              {Math.max(absentDates.length - rule.absent_free_days, 0)}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                (first {rule.absent_free_days} free · AED {rule.absent_deduction_amount} each from the {ordinal(rule.absent_free_days + 1)})
              </span>
            </p>
          </div>
          <div className="hidden h-9 w-px bg-border/60 sm:block" aria-hidden />
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Absent deduction</p>
            <p className="text-lg font-bold tabular-nums text-red-500">
              AED {fmtMoney(employee.absent_deduction)}
            </p>
          </div>
          {computedAbsentDeduction !== employee.absent_deduction && records !== null && (
            <p className="w-full rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              Attendance changed after this payroll was generated
              (now {computedAbsentDeduction > employee.absent_deduction ? 'more' : 'fewer'} chargeable absences).
              Draft periods recalculate automatically the next time the Payroll page loads.
            </p>
          )}
        </div>
      </section>

      {/* one calendar per site */}
      <div className={cn('grid gap-4', calendars.length > 1 && 'lg:grid-cols-2')}>
        {calendars.map((site) => (
          <SiteCalendar
            key={site.key}
            siteName={site.name}
            siteHours={site.hours}
            weeks={weeks}
            dedAmount={rule.absent_deduction_amount}
          />
        ))}
      </div>

      {/* legend */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-muted-foreground">
        <Legend swatch="bg-emerald-500/15 border-emerald-500/40" label="Worked at this site (hours)" />
        <Legend swatch="bg-muted/50 border-border border-dashed" label="Worked at another site" />
        <Legend swatch="bg-red-500/15 border-red-500/40" label="Absent ('A')" />
        <Legend swatch="bg-red-500/25 border-red-500/50" label={`Chargeable (−AED ${rule.absent_deduction_amount})`} />
        <Legend swatch="bg-amber-500/15 border-amber-500/40" label="Marker (present, no tracked hours)" />
        <Legend swatch="bg-transparent border-border/40" label="Not marked" />
      </p>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------
function round2(n: number): number { return Math.round(n * 100) / 100; }

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

function RecapRow({ label, value, icon, strong }: {
  label: string; value: string; icon?: React.ReactNode; strong?: boolean;
}) {
  return (
    <p className="flex items-center justify-between gap-4 lg:justify-start lg:gap-3">
      <span className="flex items-center gap-1 text-muted-foreground">{icon}{label}</span>
      <span className={cn('font-mono tabular-nums', strong ? 'font-bold text-emerald-600 dark:text-emerald-400' : 'font-semibold')}>
        {value}
      </span>
    </p>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block size-3 rounded border', swatch)} aria-hidden />
      {label}
    </span>
  );
}

/** One site's calendar card — a full month grid for the employee */
function SiteCalendar({ siteName, siteHours, weeks, dedAmount }: {
  siteName: string;
  siteHours: number;
  weeks: DayCell[][];
  dedAmount: number;
}) {
  return (
    <section className="card-glow overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <MapPin size={14} className="shrink-0 text-brand" />
          <span className="truncate">{siteName}</span>
        </h2>
        <span className="shrink-0 rounded-full border border-border/60 bg-muted/50 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {fmtHrs(siteHours)} h this site
        </span>
      </header>

      <div className="p-3">
        {/* weekday header — Sunday first */}
        <div className="mb-1.5 grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((w, i) => (
            <p key={w} className={cn(
              'text-center text-[10px] font-semibold uppercase tracking-wide',
              (i === 0 || i === 6) ? 'text-muted-foreground/70' : 'text-muted-foreground',
            )}>
              {w}
            </p>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} className="mb-1.5 grid grid-cols-7 gap-1.5 last:mb-0">
            {week.map((cell, ci) => <DayCellView key={ci} cell={cell} siteName={siteName} dedAmount={dedAmount} />)}
          </div>
        ))}
      </div>
    </section>
  );
}

/** a single day cell — colour + content follow the day's attendance */
function DayCellView({ cell, siteName, dedAmount }: { cell: DayCell; siteName: string; dedAmount: number }) {
  if (cell.day == null) return <div aria-hidden />;

  const date = cell.day;
  const rec = cell.record;
  const absent = rec?.status === 'absent';
  const hours = rec?.hours != null && rec.hours > 0 ? rec.hours : null;
  // day worked at a DIFFERENT site? (priced line belongs to another calendar)
  const otherSite = hours != null && cell.siteName != null && cell.siteName !== siteName;
  const marker = !absent && hours == null && rec?.note ? rec.note : null;
  const notMarked = rec != null && !absent && hours == null && !marker;

  return (
    <div
      title={cellTitle({ date, rec, absent, hours, otherSite, cell, siteName, marker, dedAmount })}
      className={cn(
        'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border p-1 text-center transition-colors',
        absent && 'border-red-500/40 bg-red-500/10',
        absent && cell.chargeable && 'border-red-500/60 bg-red-500/20',
        !absent && hours != null && !otherSite && 'border-emerald-500/40 bg-emerald-500/10',
        !absent && hours != null && otherSite && 'border-dashed border-border bg-muted/40',
        marker && 'border-amber-500/40 bg-amber-500/10',
        notMarked && 'border-border/40 text-muted-foreground/50',
        !rec && 'border-transparent',
      )}
    >
      <p className={cn(
        'text-[10px] font-medium tabular-nums',
        absent ? 'text-red-500' : 'text-muted-foreground',
      )}>
        {date}
      </p>
      {absent ? (
        <p className="flex items-center gap-1">
          <span className="text-sm font-bold text-red-500">A</span>
          {cell.chargeable && (
            <span className="rounded bg-red-500 px-1 text-[9px] font-bold text-white">
              −{dedAmount}
            </span>
          )}
        </p>
      ) : hours != null ? (
        <p className={cn(
          'font-mono text-xs font-semibold tabular-nums',
          otherSite ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400',
        )}>
          {fmtHrs(hours)} h
        </p>
      ) : marker ? (
        <p className="max-w-full truncate text-[10px] font-semibold text-amber-600 dark:text-amber-400">
          {marker}
        </p>
      ) : notMarked ? (
        <p className="text-xs">–</p>
      ) : null}
    </div>
  );
}

/** tooltip text of a day cell */
function cellTitle({ date, rec, absent, hours, otherSite, cell, siteName, marker, dedAmount }: {
  date: number; rec?: Attendance; absent: boolean; hours: number | null;
  otherSite: boolean; cell: DayCell; siteName: string; marker: string | null;
  dedAmount: number;
}): string {
  const d = String(date).padStart(2, '0');
  if (absent) {
    return `${d} — Absent${cell.chargeable ? ` (chargeable −AED ${dedAmount})` : ' (free allowance — first absences cost nothing)'}`;
  }
  if (hours != null) {
    if (otherSite) return `${d} — ${fmtHrs(hours)} h worked at ${cell.siteName} (shown muted in the ${siteName} calendar)`;
    return `${d} — ${fmtHrs(hours)} h${rec?.note ? ` · ${rec.note}` : ''}`;
  }
  if (marker) return `${d} — present, marker "${marker}" (no tracked hours)`;
  if (rec) return `${d} — not marked`;
  return String(date);
}
