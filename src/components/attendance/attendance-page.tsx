'use client';

// ============================================================================
// PULSE Workforce OS — Attendance (Excel-style marking sheet)
// ----------------------------------------------------------------------------
// • Every cell is an always-editable input: type custom hours (e.g. 8, 10.5)
//   or "A" for absent, or clear it to unmark the day.
// • Rows are ALPHABETICAL by employee name; the site filter narrows the sheet
//   to only that site's crew (still alphabetical).
// • Right side: TOTAL HOURS (sum of the row's cells) + ABSENCES count.
// • Calendar view: per-employee month calendar with the same editing model.
// ============================================================================

import { motion } from 'framer-motion';
import {
  CalendarCheck, ChevronLeft, ChevronRight, Loader2, Search, Tent,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
const isFriday = (date: string): boolean => new Date(`${date}T00:00:00`).getDay() === 5;
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
// Page
// ---------------------------------------------------------------------------
export function AttendancePage() {
  const realtimeVersion = useRealtimeVersion(['attendance', 'employee', 'site', 'camp']);

  const now = new Date();
  const [monthKey, setMonthKey] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [view, setView] = useState<'sheet' | 'calendar'>('sheet');

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [records, setRecords] = useState<Attendance[] | null>(null);

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
  const isCurrentMonth = monthKey === `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const isFutureMonth = monthKey > `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

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

  // ---- alphabetical crew (site filter narrows) --------------------------------
  const crew = useMemo(() => {
    const list = (employees ?? []).filter((e) => e.status !== 'deleted');
    const filtered = siteFilter === 'all' ? list : list.filter((e) => e.current_site_id === siteFilter);
    const q = debouncedSearch.toLowerCase().trim();
    const searched = q
      ? filtered.filter((e) =>
          `${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.nationality ?? ''}`.toLowerCase().includes(q))
      : filtered;
    return [...searched].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [employees, siteFilter, debouncedSearch]);

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

  const activeSites = useMemo(() => (sites ?? []).filter((s) => s.is_active), [sites]);
  const loading = !employees || !records || !sites;
  const calendarEmployee = crew.find((e) => e.id === calendarEmployeeId) ?? null;

  const dayColumns = useMemo(() => {
    const cols: number[] = [];
    const last = isCurrentMonth ? now.getDate() : isFutureMonth ? 0 : days;
    for (let d = 1; d <= last; d++) cols.push(d);
    return cols;
  }, [days, isCurrentMonth, isFutureMonth, now]);

  return (
    <div className="mx-auto max-w-[1600px]">
      {/* header */}
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE }}>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Attendance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Excel-style marking — type custom hours per day, or <span className="font-semibold text-rose-500">A</span> for absent
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
                {activeSites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.employee_count})
                  </SelectItem>
                ))}
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
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-rose-500/[0.06] ring-1 ring-border" />Friday</span>
        </div>
      </div>

      {/* ============================ SHEET VIEW ============================ */}
      {view === 'sheet' && (
        loading ? (
          <SkeletonRows rows={8} />
        ) : crew.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck size={22} />}
            title={debouncedSearch || siteFilter !== 'all' ? 'No employees match your filters' : 'No employees yet'}
            description={debouncedSearch || siteFilter !== 'all'
              ? 'Try adjusting the search or site filter.'
              : 'Add employees first to start marking attendance.'}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="card-glow overflow-hidden rounded-xl border bg-card"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="sticky left-0 z-20 min-w-[220px] bg-muted/60 px-4 py-2.5 font-medium">Employee</th>
                    {dayColumns.map((d) => {
                      const date = ymd(year, month, d);
                      const fri = isFriday(date);
                      return (
                        <th
                          key={d}
                          className={cn(
                            'w-10 min-w-10 px-1 py-2.5 text-center font-medium',
                            fri && 'bg-rose-500/[0.07] text-rose-500',
                          )}
                          title={`${MONTH_NAMES[month - 1]} ${d}${fri ? ' (Friday)' : ''}`}
                        >
                          <div>{d}</div>
                          <div className="text-[9px] font-normal normal-case opacity-70">
                            {WEEKDAYS[new Date(`${date}T00:00:00`).getDay()]}
                          </div>
                        </th>
                      );
                    })}
                    <th className="sticky right-[92px] z-20 w-[92px] bg-muted/60 px-2 py-2.5 text-center font-medium text-emerald-500">Total H</th>
                    <th className="sticky right-0 z-20 w-[92px] bg-muted/60 px-2 py-2.5 text-center font-medium text-rose-500">Absent</th>
                  </tr>
                </thead>
                <tbody>
                  {crew.map((emp, i) => {
                    const totals = rowTotals(emp.id);
                    return (
                      <motion.tr
                        key={emp.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.02, 0.3), ease: EASE }}
                        className="border-b border-border/40 transition-colors last:border-0 hover:bg-brand/[0.02]"
                      >
                        <td className="sticky left-0 z-10 bg-card px-4 py-2">
                          <div className="flex items-center gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                              {emp.photo ? <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" /> : initials(emp.full_name)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-medium">{emp.full_name}</p>
                              <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                                <span className="font-mono">{emp.employee_code}</span>
                                {emp.camp_name && (
                                  <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"><Tent size={9} className="inline" />{emp.camp_name}</span>
                                )}
                              </p>
                            </div>
                          </div>
                        </td>
                        {dayColumns.map((d) => {
                          const date = ymd(year, month, d);
                          const key = `${emp.id}|${date}`;
                          const value = cellText(emp.id, date);
                          const busy = savingKeys.has(key);
                          const fri = isFriday(date);
                          const withinLast7 = date > new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
                          const isA = value.trim().toLowerCase() === 'a';
                          return (
                            <td
                              key={d}
                              className={cn(
                                'p-0 text-center',
                                fri && 'bg-rose-500/[0.04]',
                                withinLast7 && !fri && 'bg-emerald-500/[0.04]',
                              )}
                            >
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
                            </td>
                          );
                        })}
                        {/* Total hours */}
                        <td className="sticky right-[92px] z-10 bg-card px-2 text-center">
                          <span className="inline-flex min-w-12 rounded-lg bg-emerald-500/10 px-1.5 py-1 text-[12px] font-bold tabular-nums text-emerald-500">
                            {totals.hours}
                          </span>
                        </td>
                        {/* Absences */}
                        <td className="sticky right-0 z-10 bg-card px-2 text-center">
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
              {crew.length} employee{crew.length !== 1 ? 's' : ''} · alphabetical
              {siteFilter !== 'all' && ' (filtered by site)'} · every cell is editable — click a cell and type hours (e.g. 8, 10.5) or A, then press Enter or click away
            </p>
          </motion.div>
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
              sub={`${calendarEmployee.employee_code}${calendarEmployee.site_name ? ' · ' + calendarEmployee.site_name : ' · Idle'}`}
            />
            <div className="mt-4 grid grid-cols-7 gap-1.5">
              {WEEKDAYS.map((w) => (
                <div key={w} className={cn('pb-1 text-center text-[11px] font-medium uppercase tracking-wide', w === 'Fri' ? 'text-rose-500' : 'text-muted-foreground')}>
                  {w}
                </div>
              ))}
              {Array.from({ length: new Date(year, month - 1, 1).getDay() }).map((_, i) => <div key={`pad-${i}`} />)}
              {Array.from({ length: days }).map((_, idx) => {
                const d = idx + 1;
                const date = ymd(year, month, d);
                const future = date > today;
                const fri = isFriday(date);
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
                          fri && 'border-rose-500/20 bg-rose-500/[0.04]',
                          !future && !fri && 'bg-card',
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
                        {calendarEmployee.full_name} · {date}{fri ? ' (Friday)' : ''}
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
