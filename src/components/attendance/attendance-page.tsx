'use client';

// ============================================================================
// PULSE Workforce OS — Attendance (Excel-style marking sheet, displayed SITEWISE)
// ----------------------------------------------------------------------------
// • The sheet is grouped per WORK SITE (attendance is marked sitewise) and each
//   section's crew is ALPHABETICAL. An "Unassigned / Idle" section (super
//   admins only) lists employees without a site.
// • Every cell is an always-editable input: type custom hours (e.g. 8, 10.5)
//   or "A" for absent, or clear it to unmark the day.
// • Each row shows the employee's TRADE (position) next to their ID.
// • Right side: TOTAL HOURS (sum of the row's cells) + ABSENCES count.
// • Normal admins only see — and can only mark — the sites assigned to them
//   by a super admin (Admin Management → Site Access).
// • Calendar view: per-employee month calendar with the same editing model.
// ============================================================================

import { motion } from 'framer-motion';
import {
  Building2, CalendarCheck, ChevronLeft, ChevronRight, Loader2, Search, Shield,
  Tent, UserX,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { EmptyState, SectionTitle, SkeletonRows } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Attendance, EmployeeVM, SiteWithCount } from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
const todayYMD = (): string => {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
};
const isSunday = (date: string): boolean => new Date(`${date}T00:00:00`).getDay() === 0;
const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate();

/** Parse a cell value → { kind, hours }. kind: 'absent' | 'hours' | 'clear' | 'invalid' */
function parseCell(raw: string): { kind: 'absent' | 'hours' | 'clear' | 'invalid'; hours: number | null } {
  const v = raw.trim();
  if (v === '') return { kind: 'clear', hours: null };
  if (v.toLowerCase() === 'a' || v.toLowerCase() === 'absent') return { kind: 'absent', hours: null };
  const n = Number(v);
  if (Number.isNaN(n) || !Number.isFinite(n) || n < 0 || n > 24) return { kind: 'invalid', hours: null };
  return { kind: 'hours', hours: Math.round(n * 100) / 100 };
}

// ---------------------------------------------------------------------------
// One site section type (header band + that site's crew table)
// ---------------------------------------------------------------------------
interface SiteSection {
  key: string;
  title: string;
  client: string | null;
  emps: EmployeeVM[];
  isIdle?: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function AttendancePage() {
  const realtimeVersion = useRealtimeVersion(['attendance', 'employee', 'site', 'camp', 'admin_site']);
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';

  const now = new Date();
  const [monthKey, setMonthKey] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [view, setView] = useState<'sheet' | 'calendar'>('sheet');

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [records, setRecords] = useState<Attendance[] | null>(null);
  const [assignedSiteIds, setAssignedSiteIds] = useState<Set<string> | null>(isSuperAdmin ? null : new Set());

  // filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [siteFilter, setSiteFilter] = useState<string>('all');

  // editing state: cellKey "empId|YYYY-MM-DD" → raw input text
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());

  // calendar view state
  const [calendarEmployeeId, setCalendarEmployeeId] = useState<string | null>(null);

  const [year, month] = useMemo(() => {
    const [y, m] = monthKey.split('-').map(Number);
    return [y, m];
  }, [monthKey]);

  const today = todayYMD();
  const days = daysInMonth(year, month);

  // ---- data loading ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [emps, sts] = await Promise.all([dataApi.listEmployees(), dataApi.listSites()]);
        if (!cancelled) { setEmployees(emps); setSites(sts); }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
    return () => { cancelled = true; };
  }, [realtimeVersion]);

  // admins: which sites they may mark (null = unrestricted super admin)
  useEffect(() => {
    if (isSuperAdmin) { setAssignedSiteIds(null); return; }
    if (!user) return;
    let cancelled = false;
    dataApi.getSiteAssignments(user.id)
      .then((ids) => { if (!cancelled) setAssignedSiteIds(new Set(ids)); })
      .catch(() => { if (!cancelled) setAssignedSiteIds(new Set()); });
    return () => { cancelled = true; };
  }, [user, isSuperAdmin, realtimeVersion]);

  useEffect(() => {
    let cancelled = false;
    dataApi.getMonthAttendance(monthKey)
      .then((rows) => { if (!cancelled) setRecords(rows); })
      .catch(() => { if (!cancelled) setRecords([]); });
    return () => { cancelled = true; };
  }, [monthKey, realtimeVersion]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ---- scoped crew (admins → their assigned sites only; super admins → all) ---
  const scoped = useMemo(() => {
    const list = (employees ?? []).filter((e) => e.status !== 'deleted');
    if (assignedSiteIds === null) return list;
    return list.filter((e) => e.current_site_id !== null && assignedSiteIds.has(e.current_site_id));
  }, [employees, assignedSiteIds]);

  // ---- sitewise sections (alphabetical inside each section) -------------------
  const sections = useMemo<SiteSection[]>(() => {
    const q = debouncedSearch.toLowerCase().trim();
    const matches = (e: EmployeeVM) =>
      !q || `${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.nationality ?? ''}`.toLowerCase().includes(q);
    const byName = (a: EmployeeVM, b: EmployeeVM) => a.full_name.localeCompare(b.full_name);

    const siteList = (sites ?? []).filter((s) => s.is_active);
    const result: SiteSection[] = siteList
      .filter((s) => siteFilter === 'all' || s.id === siteFilter)
      .map((s) => ({
        key: s.id,
        title: s.name,
        client: s.client_name,
        emps: scoped
          .filter((e) => e.current_site_id === s.id && matches(e))
          .sort(byName),
      }))
      .filter((sec) => sec.emps.length > 0);

    // idle employees — super admins only (admins can never mark them)
    if (isSuperAdmin && (siteFilter === 'all' || siteFilter === 'idle')) {
      const idle = scoped
        .filter((e) => !e.current_site_id && matches(e))
        .sort(byName);
      if (idle.length > 0) {
        result.push({
          key: '__idle__',
          title: 'Unassigned / Idle — no site',
          client: null,
          emps: idle,
          isIdle: true,
        });
      }
    }
    return result;
  }, [sites, scoped, siteFilter, debouncedSearch, isSuperAdmin]);

  // flat crew for the calendar view combobox
  const crew = useMemo(
    () => sections.flatMap((s) => s.emps),
    [sections],
  );

  // sites selectable in the filter (admins: only their assigned sites)
  const selectableSites = useMemo(() => {
    const active = (sites ?? []).filter((s) => s.is_active);
    if (assignedSiteIds === null) return active;
    return active.filter((s) => assignedSiteIds.has(s.id));
  }, [sites, assignedSiteIds]);

  // ---- record lookups ---------------------------------------------------------
  const recordMap = useMemo(() => {
    const map = new Map<string, Attendance>();
    (records ?? []).forEach((r) => map.set(`${r.employee_id}|${r.date}`, r));
    return map;
  }, [records]);

  const recordToText = (r: Attendance | undefined): string => {
    if (!r) return '';
    if (r.status === 'absent') return 'A';
    if (r.status === 'present' && r.hours != null) return String(r.hours);
    return '';
  };

  const cellText = (empId: string, date: string): string => {
    const key = `${empId}|${date}`;
    return edits[key] ?? recordToText(recordMap.get(key));
  };

  // ---- commit a cell ------------------------------------------------------------
  const commitCell = async (empId: string, date: string) => {
    const key = `${empId}|${date}`;
    const raw = edits[key];
    if (raw === undefined) return; // untouched

    const current = recordToText(recordMap.get(key));
    if (raw === current) { // no change → drop local edit
      setEdits((prev) => { const n = { ...prev }; delete n[key]; return n; });
      return;
    }

    const parsed = parseCell(raw);
    if (parsed.kind === 'invalid') {
      toast.error('Invalid value', { description: 'Enter hours (0–24, e.g. 8 or 10.5) or A for absent.' });
      setEdits((prev) => { const n = { ...prev }; delete n[key]; return n; });
      return;
    }

    setSavingKeys((prev) => new Set(prev).add(key));
    try {
      await dataApi.markAttendance(empId, date, parsed.kind === 'clear' ? '' : raw.trim());
      // optimistic local sync (realtime refetch will reconcile)
      setRecords((prev) => {
        const list = prev ?? [];
        const rest = list.filter((r) => !(r.employee_id === empId && r.date === date));
        if (parsed.kind === 'clear') return rest;
        const base = list.find((r) => r.employee_id === empId && r.date === date);
        return [...rest, {
          id: base?.id ?? `local-${key}`,
          employee_id: empId,
          date,
          status: parsed.kind === 'absent' ? 'absent' : 'present',
          hours: parsed.hours,
          is_hidden: false,
          created_at: base?.created_at ?? new Date().toISOString(),
        }];
      });
      setEdits((prev) => { const n = { ...prev }; delete n[key]; return n; });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
      setEdits((prev) => { const n = { ...prev }; delete n[key]; return n; });
    } finally {
      setSavingKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const setCell = (empId: string, date: string, value: string) => {
    const key = `${empId}|${date}`;
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  // ---- row totals (TOTAL HOURS + ABSENCES) ---------------------------------------
  const rowTotals = (empId: string): { hours: number; absents: number } => {
    let hours = 0;
    let absents = 0;
    for (let d = 1; d <= days; d++) {
      const date = ymd(year, month, d);
      const parsed = parseCell(cellText(empId, date));
      if (parsed.kind === 'hours') hours += parsed.hours ?? 0;
      if (parsed.kind === 'absent') absents += 1;
    }
    return { hours: Math.round(hours * 100) / 100, absents };
  };

  // ---- month navigation ----------------------------------------------------------
  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setMonthKey(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };

  const loading = !employees || !records || !sites || (!isSuperAdmin && assignedSiteIds === null);
  const calendarEmployee = crew.find((e) => e.id === calendarEmployeeId) ?? null;

  const dayColumns = useMemo(() => {
    // always show the FULL month (1 … last day): un-entered days stay blank,
    // future days are rendered but locked against editing.
    const cols: number[] = [];
    for (let d = 1; d <= days; d++) cols.push(d);
    return cols;
  }, [days]);

  // ---- one day cell (plain render fn — keeps input focus stable) ------------
  const renderDayCell = (emp: EmployeeVM, date: string) => {
    const key = `${emp.id}|${date}`;
    const value = cellText(emp.id, date);
    const busy = savingKeys.has(key);
    const sun = isSunday(date);
    const future = date > today;
    const isA = value.trim().toLowerCase() === 'a';
    return (
      <td
        key={key}
        className={cn(
          'border-x border-b border-foreground/15 p-0 text-center',
          sun && 'bg-rose-500/[0.05]',
          !sun && !future && date > new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) && 'bg-emerald-500/[0.04]',
          future && 'bg-muted/40',
        )}
      >
        {future ? (
          // future dates are visible but locked — nothing to mark yet
          <div
            className="flex h-9 w-10 cursor-not-allowed items-center justify-center"
            title={`${date} — future date, not editable yet`}
            aria-label={`${emp.full_name} — ${date} — future date, locked`}
          />
        ) : (
          <div className="relative">
            <input
              value={value}
              disabled={busy}
              onChange={(e) => setCell(emp.id, date, e.target.value)}
              onBlur={() => commitCell(emp.id, date)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              aria-label={`${emp.full_name} — ${date}`}
              className={cn(
                'h-9 w-10 bg-transparent text-center text-[12px] font-medium tabular-nums outline-none transition-colors',
                'hover:bg-brand/10 focus:bg-brand/15 focus:ring-1 focus:ring-brand/60 focus:ring-inset',
                isA && 'bg-rose-500/10 font-bold text-rose-500',
                value !== '' && !isA && 'text-foreground',
                busy && 'opacity-50',
              )}
            />
            {busy && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <Loader2 size={10} className="animate-spin text-brand" />
              </span>
            )}
          </div>
        )}
      </td>
    );
  };

  // ---- a full site section (table with that site's crew) ---------------------------
  const renderSheetSection = (section: SiteSection, index: number) => {
    const totalHours = section.emps.reduce((sum, emp) => sum + rowTotals(emp.id).hours, 0);
    return (
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: Math.min(index * 0.05, 0.3), ease: EASE }}
        className="space-y-2"
      >
        {/* section band */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-4 py-2.5">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg',
              section.isIdle ? 'bg-amber-500/10 text-amber-500' : 'bg-brand/10 text-brand',
            )}
          >
            {section.isIdle ? <UserX size={16} /> : <Building2 size={16} />}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{section.title}</h3>
            {section.client && (
              <p className="truncate text-[11px] text-muted-foreground">Client: {section.client}</p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] font-semibold tabular-nums',
                section.isIdle
                  ? 'border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'border border-brand/25 bg-brand/10 text-brand',
              )}
            >
              {section.emps.length} employee{section.emps.length !== 1 ? 's' : ''}
            </span>
            {section.emps.length > 0 && (
              <span className="hidden rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-500 sm:inline-flex">
                Site total: {Math.round(totalHours * 100) / 100}h
              </span>
            )}
          </div>
        </div>

        {/* crew table */}
        <div className="card-glow overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="sticky left-0 z-20 w-[240px] min-w-[240px] border-x border-foreground/15 bg-muted/60 px-4 py-2.5 font-medium">Employee</th>
                  <th className="sticky left-[240px] z-20 w-[120px] min-w-[120px] border-x border-b border-foreground/15 bg-muted/60 px-3 py-2.5 font-medium">Trade</th>
                  {dayColumns.map((d) => {
                    const date = ymd(year, month, d);
                    const sun = isSunday(date);
                    const future = date > today;
                    return (
                      <th
                        key={d}
                        className={cn(
                          'w-10 min-w-10 border-x border-b border-foreground/15 px-1 py-2.5 text-center font-medium',
                          sun && 'bg-rose-500/[0.07] text-rose-500',
                          future && 'text-muted-foreground/50',
                        )}
                        title={`${MONTH_NAMES[month - 1]} ${d}${sun ? ' (Sunday)' : ''}${future ? ' — future (locked)' : ''}`}
                      >
                        <div>{d}</div>
                        <div className={cn('text-[9px] font-normal normal-case opacity-70', sun && 'text-rose-500')}>
                          {WEEKDAYS[new Date(`${date}T00:00:00`).getDay()]}
                        </div>
                      </th>
                    );
                  })}
                  <th className="sticky right-[92px] z-20 w-[92px] border-x border-b border-foreground/15 bg-muted/60 px-2 py-2.5 text-center font-medium text-emerald-500">Total H</th>
                  <th className="sticky right-0 z-20 w-[92px] border-l border-b border-foreground/15 bg-muted/60 px-2 py-2.5 text-center font-medium text-rose-500">Absent</th>
                </tr>
              </thead>
              <tbody>
                {section.emps.map((emp, i) => {
                  const totals = rowTotals(emp.id);
                  return (
                    <motion.tr
                      key={emp.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i * 0.02, 0.25), ease: EASE }}
                      className="transition-colors"
                    >
                      {/* employee — stacked: name / employee ID / camp */}
                      <td className="sticky left-0 z-10 border-x border-b border-foreground/15 bg-card px-4 py-2">
                        <div className="flex items-center gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                            {emp.photo ? <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" /> : initials(emp.full_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium leading-tight">{emp.full_name}</p>
                            <p className="truncate font-mono text-[10px] leading-tight text-muted-foreground">{emp.employee_code}</p>
                            {emp.camp_name ? (
                              <p
                                className="inline-flex shrink-0 items-center gap-0.5 text-[10px] leading-tight text-amber-600 dark:text-amber-400"
                                title={`Camp: ${emp.camp_name}${emp.camp_block ? ' · Block ' + emp.camp_block : ''}${emp.camp_room ? ' · Room ' + emp.camp_room : ''}`}
                              >
                                <Tent size={9} className="inline" />
                                {emp.camp_name}
                              </p>
                            ) : (
                              <p className="text-[10px] leading-tight text-muted-foreground/60">No camp</p>
                            )}
                          </div>
                        </div>
                      </td>
                      {/* trade — its own dedicated column */}
                      <td className="sticky left-[240px] z-10 border-x border-b border-foreground/15 bg-card px-3 py-2">
                        <span className="truncate text-xs font-medium text-foreground/80">{emp.position ?? '—'}</span>
                      </td>
                      {dayColumns.map((d) => (
                        renderDayCell(emp, ymd(year, month, d))
                      ))}
                      {/* Total hours */}
                      <td className="sticky right-[92px] z-10 border-x border-b border-foreground/15 bg-card px-2 text-center">
                        <span className="inline-flex min-w-12 rounded-lg bg-emerald-500/10 px-1.5 py-1 text-[12px] font-bold tabular-nums text-emerald-500">
                          {totals.hours}
                        </span>
                      </td>
                      {/* Absences */}
                      <td className="sticky right-0 z-10 border-l border-b border-foreground/15 bg-card px-2 text-center">
                        <span
                          className={cn(
                            'inline-flex min-w-8 rounded-lg px-1.5 py-1 text-[12px] font-bold tabular-nums',
                            totals.absents > 0 ? 'bg-rose-500/10 text-rose-500' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {totals.absents}
                        </span>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
            {section.emps.length} employee{section.emps.length !== 1 ? 's' : ''} · alphabetical — every past cell is editable (hours e.g. 8, 10.5 or <span className="font-semibold text-rose-500">A</span>); future dates stay blank & locked
          </p>
        </div>
      </motion.section>
    );
  };

  return (
    <div className="mx-auto max-w-[1600px]">
      {/* header */}
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE }}>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Attendance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sitewise Excel-style marking — type custom hours per day, or <span className="font-semibold text-rose-500">A</span> for absent
          </p>
        </motion.div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={view} onValueChange={(v) => setView(v as 'sheet' | 'calendar')}>
            <TabsList>
              <TabsTrigger value="sheet"><CalendarCheck size={14} className="mr-1" />Sheet</TabsTrigger>
              <TabsTrigger value="calendar">Calendar</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="size-9" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <ChevronLeft size={16} />
            </Button>
            <Select value={MONTH_NAMES[month - 1]} onValueChange={(m) => setMonthKey(`${year}-${pad(MONTH_NAMES.indexOf(m) + 1)}`)}>
              <SelectTrigger className="h-9 w-32 bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={(y) => setMonthKey(`${y}-${pad(month)}`)}>
              <SelectTrigger className="h-9 w-[76px] bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline" size="icon" className="size-9"
              disabled={monthKey >= `${now.getFullYear()}-${pad(now.getMonth() + 1)}`}
              onClick={() => shiftMonth(1)} aria-label="Next month"
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </div>
      </div>

      {/* admin scope hint */}
      {!isSuperAdmin && assignedSiteIds !== null && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-brand/25 bg-brand/[0.06] px-3.5 py-2.5 text-xs text-muted-foreground">
          <Shield size={14} className="shrink-0 text-brand" />
          <span>
            You can only view and mark <span className="font-medium text-foreground">{assignedSiteIds.size} assigned site{assignedSiteIds.size !== 1 ? 's' : ''}</span> —
            ask a super admin to assign more via Admin Management → Site Access.
          </span>
        </div>
      )}

      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {view === 'sheet' && (
          <>
            <div className="relative min-w-52 flex-1 sm:max-w-xs">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search employees…"
                className="h-10 pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={siteFilter} onValueChange={setSiteFilter}>
              <SelectTrigger className="h-10 w-56 bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sites</SelectItem>
                {selectableSites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.employee_count})
                  </SelectItem>
                ))}
                {isSuperAdmin && (
                  <SelectItem value="idle">Unassigned / Idle only</SelectItem>
                )}
              </SelectContent>
            </Select>
          </>
        )}
        {view === 'calendar' && (
          <div className="min-w-64 flex-1 sm:max-w-sm">
            <EmployeeCombobox
              employees={crew}
              value={calendarEmployeeId}
              onChange={(id) => setCalendarEmployeeId(id)}
              placeholder="Select an employee to view their timesheet…"
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-rose-500/20 ring-1 ring-rose-500/40" />A = Absent</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-emerald-500/20 ring-1 ring-emerald-500/40" />Hours</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-rose-500/[0.06] ring-1 ring-border" />Sunday</span>
          <span className="hidden items-center gap-1.5 lg:flex"><span className="size-2.5 rounded-sm bg-muted/60 ring-1 ring-border/70" />Future (locked)</span>
        </div>
      </div>

      {/* ============================ SHEET VIEW (site sections) ============================ */}
      {view === 'sheet' && (
        loading ? (
          <SkeletonRows rows={8} />
        ) : !isSuperAdmin && assignedSiteIds !== null && assignedSiteIds.size === 0 ? (
          <EmptyState
            icon={<Shield size={22} />}
            title="No sites assigned to you yet"
            description="A super admin needs to assign you at least one site (Admin Management → Site Access) before you can mark attendance."
          />
        ) : sections.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck size={22} />}
            title={debouncedSearch || siteFilter !== 'all' ? 'No employees match your filters' : 'No site employees to mark'}
            description={debouncedSearch || siteFilter !== 'all'
              ? 'Try adjusting the search or site filter.'
              : 'Employees are grouped by their work site — assign employees to a site to start marking their attendance.'}
          />
        ) : (
          <div className="space-y-6">
            {sections.map((section, i) => (
              <Fragment key={section.key}>
                {renderSheetSection(section, i)}
              </Fragment>
            ))}
          </div>
        )
      )}

      {/* ============================ CALENDAR VIEW ============================ */}
      {view === 'calendar' && (
        loading ? (
          <div className="grid gap-3 sm:grid-cols-7">
            {Array.from({ length: 35 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
        ) : !calendarEmployee ? (
          <EmptyState
            icon={<CalendarCheck size={22} />}
            title="Select an employee"
            description="Pick an employee above to view and edit their monthly timesheet."
          />
        ) : (
          <motion.div
            key={calendarEmployee.id + monthKey}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="card-glow rounded-xl border bg-card p-5"
          >
            <SectionTitle
              title={`${calendarEmployee.full_name} — ${MONTH_NAMES[month - 1]} ${year}`}
              sub={`${calendarEmployee.employee_code} · ${calendarEmployee.position ?? 'No trade'}${calendarEmployee.site_name ? ' · ' + calendarEmployee.site_name : ' · Idle'}`}
            />
            <div className="mt-4 grid grid-cols-7 gap-1.5">
              {WEEKDAYS.map((w) => (
                <div key={w} className={cn('pb-1 text-center text-[11px] font-medium uppercase tracking-wide', w === 'Sun' ? 'text-rose-500' : 'text-muted-foreground')}>
                  {w}
                </div>
              ))}
              {Array.from({ length: new Date(year, month - 1, 1).getDay() }).map((_, i) => <div key={`pad-${i}`} />)}
              {Array.from({ length: days }).map((_, idx) => {
                const d = idx + 1;
                const date = ymd(year, month, d);
                const future = date > today;
                const sun = isSunday(date);
                const value = cellText(calendarEmployee.id, date);
                const parsed = parseCell(value);
                return (
                  <Popover key={d}>
                    <PopoverTrigger asChild>
                      <button
                        disabled={future}
                        className={cn(
                          'group relative flex h-16 flex-col items-center justify-center rounded-lg border text-sm transition-all',
                          future
                            ? 'cursor-not-allowed border-dashed opacity-40'
                            : 'hover:border-brand/50 hover:shadow-[0_4px_16px_-6px_var(--glow)]',
                          sun && 'border-rose-500/20 bg-rose-500/[0.05]',
                          !future && !sun && 'bg-card',
                          date === today && 'ring-2 ring-brand/50',
                        )}
                      >
                        <span className="absolute left-1.5 top-1 text-[10px] text-muted-foreground">{d}</span>
                        {parsed.kind === 'absent' ? (
                          <span className="text-lg font-bold text-rose-500">A</span>
                        ) : parsed.kind === 'hours' ? (
                          <span className="text-base font-semibold tabular-nums text-emerald-500">{parsed.hours}h</span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        )}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-56 p-3" align="center">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {calendarEmployee.full_name} · {date}{sun ? ' (Sunday)' : ''}
                      </p>
                      <Input
                        autoFocus
                        value={value}
                        disabled={future}
                        placeholder="Hours (8) or A"
                        onChange={(e) => setCell(calendarEmployee.id, date, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onBlur={() => commitCell(calendarEmployee.id, date)}
                        className="h-9 text-center font-semibold tabular-nums"
                      />
                      <div className="mt-2 grid grid-cols-4 gap-1">
                        {['8', '10', '12'].map((h) => (
                          <Button key={h} variant="outline" size="sm" className="h-7 px-0 text-xs" onClick={() => { setCell(calendarEmployee.id, date, h); setTimeout(() => commitCell(calendarEmployee.id, date), 0); }}>
                            {h}h
                          </Button>
                        ))}
                        <Button variant="outline" size="sm" className="h-7 px-0 text-xs font-bold text-rose-500" onClick={() => { setCell(calendarEmployee.id, date, 'A'); setTimeout(() => commitCell(calendarEmployee.id, date), 0); }}>
                          A
                        </Button>
                      </div>
                      <Button
                        variant="ghost" size="sm"
                        className="mt-1.5 w-full text-xs text-muted-foreground"
                        onClick={() => { setCell(calendarEmployee.id, date, ''); setTimeout(() => commitCell(calendarEmployee.id, date), 0); }}
                      >
                        Clear day
                      </Button>
                    </PopoverContent>
                  </Popover>
                );
              })}
            </div>

            {/* Month totals */}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
              {(() => {
                const totals = rowTotals(calendarEmployee.id);
                return (
                  <>
                    <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-1.5 text-sm font-semibold text-emerald-500">
                      Total Hours: {totals.hours}
                    </span>
                    <span className={cn(
                      'rounded-full border px-4 py-1.5 text-sm font-semibold',
                      totals.absents > 0 ? 'border-rose-500/25 bg-rose-500/10 text-rose-500' : 'border-border bg-muted text-muted-foreground',
                    )}>
                      Total Absent: {totals.absents}
                    </span>
                  </>
                );
              })()}
            </div>
          </motion.div>
        )
      )}
    </div>
  );
}
