'use client';

// ============================================================================
// PULSE Workforce OS — Attendance module (day matrix + per-employee calendar)
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, ChevronsUpDown,
  List, Loader2, MapPin, Search, Users, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { EmptyState, PageHeader, SkeletonRows, SiteBadge } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dataApi } from '@/lib/data';
import { fmtDate, initials } from '@/lib/format';
import {
  ATTENDANCE_STATUSES,
  type Attendance,
  type AttendanceStatus,
  type EmployeeVM,
  type SiteWithCount,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { useRealtimeVersion } from '@/store/realtime';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

type ViewMode = 'list' | 'calendar';

const PAGE_SIZE = 20;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const MONTHS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

const NOW = new Date();
const TODAY_STR = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}`;
const CURRENT_MONTH_KEY = TODAY_STR.slice(0, 7);
const YEARS = [NOW.getFullYear() - 2, NOW.getFullYear() - 1, NOW.getFullYear(), NOW.getFullYear() + 1].map(String);

const pad2 = (n: number): string => String(n).padStart(2, '0');

const toYMDLocal = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

const daysInMonthOf = (y: number, m: number): number => new Date(y, m, 0).getDate();

/** Friday = day-of-week 5 (computed locally, as mandated) */
const isFridayOf = (y: number, m: number, d: number): boolean => new Date(y, m - 1, d).getDay() === 5;

const weekdayShort = (y: number, m: number, d: number): string => WEEKDAYS[new Date(y, m - 1, d).getDay()];

/** "Today" / "Yesterday" / "N days ago" for ≤6 days ago, else null */
const relativeLabel = (y: number, m: number, d: number): string | null => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(y, m - 1, d);
  const diff = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff >= 2 && diff <= 6) return `${diff} days ago`;
  return null;
};

const fmtHours = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const statusMeta = (s: AttendanceStatus): { value: AttendanceStatus; label: string; short: string; color: string } =>
  ATTENDANCE_STATUSES.find((x) => x.value === s) ?? { value: s, label: 'Not Marked', short: '–', color: '#a1a1aa' };

/** Colored square/chip classes per status (tokens from ATTENDANCE_STATUSES hues) */
const CELL_STYLE: Record<AttendanceStatus, string> = {
  present: 'border-emerald-500/35 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  absent: 'border-rose-500/35 bg-rose-500/15 text-rose-600 dark:text-rose-400',
  overtime: 'border-purple-500/35 bg-purple-500/15 text-purple-600 dark:text-purple-400',
  no_site: 'border-amber-500/35 bg-amber-500/15 text-amber-600 dark:text-amber-400',
  not_marked: 'border-border bg-muted/40 text-muted-foreground',
};

// ---------------------------------------------------------------------------
// Status popover target
// ---------------------------------------------------------------------------

interface PopoverTarget {
  employeeId: string;
  employeeName: string;
  date: string;
  status: AttendanceStatus;
  overtimeHours: number | null;
  top: number;
  left: number;
}

// ---------------------------------------------------------------------------
// Tiny animated status label (remounts on status change → scale pop)
// ---------------------------------------------------------------------------

function StatusLabel({ status }: { status: AttendanceStatus }) {
  return (
    <motion.span
      key={status}
      initial={{ scale: 0.55, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 26 }}
      className="flex items-center justify-center"
    >
      {statusMeta(status).short}
    </motion.span>
  );
}

// ---------------------------------------------------------------------------
// Matrix cell (small colored square with short label + tooltip)
// ---------------------------------------------------------------------------

function StatusSquare({
  status,
  title,
  onClick,
}: {
  status: AttendanceStatus;
  title: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const cls = cn(
    'flex size-7 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold transition-[transform,background-color,border-color,color] duration-200',
    CELL_STYLE[status],
    onClick
      ? 'cursor-pointer hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-90'
      : 'cursor-default',
  );

  if (!onClick) {
    return (
      <span title={title} aria-label={title} className={cls}>
        <StatusLabel status={status} />
      </span>
    );
  }
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={cls}>
      <StatusLabel status={status} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status popover (fixed-position, opened from a matrix/calendar cell)
// ---------------------------------------------------------------------------

function StatusPopover({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: PopoverTarget;
  busy: boolean;
  onClose: () => void;
  onConfirm: (status: AttendanceStatus, overtimeHours: number | null) => void;
}) {
  const [selected, setSelected] = useState<AttendanceStatus>(target.status);
  const [otValue, setOtValue] = useState<string>(target.overtimeHours ? fmtHours(target.overtimeHours) : '2');

  // Escape to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const top = target.top > 300 ? Math.max(8, target.top - 268) : target.top + 48;
  const left = Math.max(8, Math.min(target.left, vw - 236));

  const handleConfirm = () => {
    const hours =
      selected === 'overtime'
        ? Math.max(0, Math.min(24, Math.round((parseFloat(otValue) || 0) * 10) / 10))
        : null;
    onConfirm(selected, hours);
  };

  return (
    <>
      <div
        key="backdrop"
        role="presentation"
        aria-hidden="true"
        onMouseDown={onClose}
        className="fixed inset-0 z-[90]"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 6 }}
        transition={{ duration: 0.2, ease: EASE }}
        role="dialog"
        aria-label="Change attendance status"
        className="fixed z-[100] w-56 rounded-xl border bg-popover p-2 shadow-2xl"
        style={{ top, left }}
      >
        <div className="border-b px-2 pb-2 pt-1">
          <p className="truncate text-xs font-semibold">{target.employeeName}</p>
          <p className="text-[11px] text-muted-foreground">{fmtDate(target.date, 'EEEE, d MMM yyyy')}</p>
        </div>

        <div className="mt-1.5 flex flex-col gap-0.5">
          {ATTENDANCE_STATUSES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSelected(s.value)}
              aria-pressed={selected === s.value}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150',
                selected === s.value
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
              {selected === s.value && <Check size={14} className="ml-auto shrink-0 text-brand" />}
            </button>
          ))}
        </div>

        <AnimatePresence initial={false}>
          {selected === 'overtime' && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="px-2 pt-2">
                <Label htmlFor="ot-hours" className="text-[11px] text-muted-foreground">
                  Overtime Hours
                </Label>
                <Input
                  id="ot-hours"
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  value={otValue}
                  onChange={(e) => setOtValue(e.target.value)}
                  aria-label="Overtime hours"
                  className="mt-1 h-9"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">0–24 hours, half-hour steps.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-2 border-t pt-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={handleConfirm}
            className="h-8 w-full brand-gradient text-xs font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Save
          </Button>
        </div>
      </motion.div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Searchable site filter
// ---------------------------------------------------------------------------

function SiteFilterSelect({
  sites,
  value,
  onChange,
}: {
  sites: SiteWithCount[];
  value: string; // 'all' or site id
  onChange: (siteId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = sites.find((s) => s.id === value) ?? null;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Filter by site"
          className="h-10 w-full justify-between font-normal sm:w-52"
        >
          <span className="flex min-w-0 items-center gap-2">
            <MapPin
              size={14}
              className={cn('shrink-0', selected ? 'text-emerald-500' : 'text-muted-foreground')}
            />
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected ? selected.name : 'All Sites'}
            </span>
          </span>
          <ChevronsUpDown size={14} className="ml-auto shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search sites…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No sites found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all-sites__"
                onSelect={() => {
                  onChange('all');
                  setOpen(false);
                  setQuery('');
                }}
              >
                <MapPin size={13} className="shrink-0 opacity-60" />
                <span className="flex-1 font-medium">All Sites</span>
              </CommandItem>
              {sites.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`${s.name} ${s.client_name ?? ''} ${s.project_name ?? ''}`}
                  onSelect={() => {
                    onChange(s.id);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <MapPin size={13} className="shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="ml-2 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {s.employee_count}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function AttendancePage() {
  const version = useRealtimeVersion(['attendance', 'employee']);

  // ---- month navigation --------------------------------------------------------
  const [monthKey, setMonthKey] = useState<string>(CURRENT_MONTH_KEY);
  const [view, setView] = useState<ViewMode>('list');

  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const monthStr = pad2(month);
  const daysInMonth = daysInMonthOf(year, month);
  const isCurrentMonth = monthKey === CURRENT_MONTH_KEY;
  const monthLabel = MONTHS.find((m) => m.value === monthStr)?.label ?? '';

  // ---- data --------------------------------------------------------------------
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [attendance, setAttendance] = useState<Attendance[] | null>(null);

  // ---- filters / paging / calendar selection ------------------------------------
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [siteId, setSiteId] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [calendarEmployeeId, setCalendarEmployeeId] = useState<string | null>(null);

  // ---- status popover ------------------------------------------------------------
  const [popoverTarget, setPopoverTarget] = useState<PopoverTarget | null>(null);
  const [saving, setSaving] = useState(false);

  const loading = employees === null || attendance === null;

  // Fetch month attendance (server auto-creates missing records) + employees + sites
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [recs, emps, siteList] = await Promise.all([
        dataApi.getMonthAttendance(monthKey),
        dataApi.listEmployees(),
        dataApi.listSites(),
      ]);
      if (!cancelled) {
        setAttendance(recs);
        setEmployees(emps);
        setSites(siteList);
      }
    })().catch(() => {
      if (!cancelled) {
        setAttendance([]);
        setEmployees([]);
        setSites([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [monthKey, version]);

  // Debounced employee search (list view)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim().toLowerCase());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // ---- derived data ---------------------------------------------------------------

  const activeEmployees = useMemo(() => (employees ?? []).filter((e) => e.status === 'active'), [employees]);

  const siteOptions = useMemo(
    () => (sites ?? []).filter((s) => s.is_active || s.employee_count > 0),
    [sites],
  );

  const siteFiltered = useMemo(
    () => (siteId === 'all' ? activeEmployees : activeEmployees.filter((e) => e.current_site_id === siteId)),
    [activeEmployees, siteId],
  );

  const filtered = useMemo(() => {
    if (!debouncedSearch) return siteFiltered;
    return siteFiltered.filter((e) =>
      `${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.nationality ?? ''} ${e.site_name ?? ''}`
        .toLowerCase()
        .includes(debouncedSearch),
    );
  }, [siteFiltered, debouncedSearch]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const pageNumbers = useMemo(() => {
    const start = Math.max(1, Math.min(safePage - 2, totalPages - 4));
    const end = Math.min(totalPages, start + 4);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }, [safePage, totalPages]);

  // key = "employeeId|date"
  const attendanceMap = useMemo(() => {
    const map = new Map<string, Attendance>();
    for (const r of attendance ?? []) map.set(`${r.employee_id}|${r.date}`, r);
    return map;
  }, [attendance]);

  // Overtime totals per employee (sum of overtime hours this month)
  const otTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of attendance ?? []) {
      if (r.overtime_hours) map.set(r.employee_id, (map.get(r.employee_id) ?? 0) + r.overtime_hours);
    }
    return map;
  }, [attendance]);

  /** Default for missing records matches server auto-creation: present if the employee has a site, else no_site */
  const effectiveStatus = useCallback(
    (emp: EmployeeVM, dateStr: string): AttendanceStatus => {
      const rec = attendanceMap.get(`${emp.id}|${dateStr}`);
      if (rec && rec.status !== 'not_marked') return rec.status;
      return emp.current_site_id ? 'present' : 'no_site';
    },
    [attendanceMap],
  );

  // Current month: days 1→today, reversed (today leftmost). Past/future months: 1..last day.
  const displayDays = useMemo(() => {
    if (isCurrentMonth) {
      const today = Number(TODAY_STR.slice(8, 10));
      return Array.from({ length: today }, (_, i) => today - i);
    }
    return Array.from({ length: daysInMonth }, (_, i) => i + 1);
  }, [daysInMonth, isCurrentMonth]);

  // Calendar employee (all site-filtered employees are pickable, search inside the combobox)
  const calendarEmployee = useMemo(
    () => siteFiltered.find((e) => e.id === calendarEmployeeId) ?? siteFiltered[0] ?? null,
    [siteFiltered, calendarEmployeeId],
  );

  const calendarCells = useMemo(() => {
    const firstDow = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
    const cells: (number | null)[] = Array.from({ length: firstDow }, () => null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }, [year, month, daysInMonth]);

  // Per-status day counts for the calendar employee (non-future days only)
  const calendarCounts = useMemo(() => {
    const counts: Record<AttendanceStatus, number> = {
      present: 0, absent: 0, overtime: 0, no_site: 0, not_marked: 0,
    };
    if (calendarEmployee) {
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = toYMDLocal(year, month, d);
        if (dateStr > TODAY_STR) continue;
        counts[effectiveStatus(calendarEmployee, dateStr)] += 1;
      }
    }
    return counts;
  }, [calendarEmployee, daysInMonth, effectiveStatus, year, month]);

  const filtersActive = debouncedSearch.length > 0 || siteId !== 'all';

  const resetFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setSiteId('all');
    setPage(1);
  };

  // ---- month navigation handlers ---------------------------------------------------

  const goPrevMonth = () => {
    const d = new Date(year, month - 2, 1);
    setMonthKey(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  };

  const goNextMonth = () => {
    const d = new Date(year, month, 1);
    setMonthKey(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  };

  // ---- status marking ---------------------------------------------------------------

  const openCellPopover = useCallback(
    (emp: EmployeeVM, dateStr: string, rect: DOMRect) => {
      const rec = attendanceMap.get(`${emp.id}|${dateStr}`);
      setPopoverTarget({
        employeeId: emp.id,
        employeeName: emp.full_name,
        date: dateStr,
        status: rec && rec.status !== 'not_marked' ? rec.status : emp.current_site_id ? 'present' : 'no_site',
        overtimeHours: rec?.overtime_hours ?? null,
        top: rect.top,
        left: rect.left,
      });
    },
    [attendanceMap],
  );

  const handleCellClick = useCallback(
    (emp: EmployeeVM, dateStr: string) => (e: MouseEvent<HTMLButtonElement>) => {
      if (dateStr > TODAY_STR) return; // future dates are not editable
      openCellPopover(emp, dateStr, e.currentTarget.getBoundingClientRect());
    },
    [openCellPopover],
  );

  const handleMark = async (status: AttendanceStatus, overtimeHours: number | null) => {
    if (!popoverTarget) return;
    const target = popoverTarget;

    // Optimistic local update (upsert)
    let snapshot: Attendance[] = [];
    setAttendance((prev) => {
      snapshot = prev ?? [];
      const list = prev ?? [];
      const idx = list.findIndex((r) => r.employee_id === target.employeeId && r.date === target.date);
      const next: Attendance = {
        id: idx >= 0 ? list[idx].id : `optimistic-${target.employeeId}-${target.date}`,
        employee_id: target.employeeId,
        date: target.date,
        status,
        overtime_hours: status === 'overtime' ? overtimeHours : null,
        is_hidden: false,
        created_at: idx >= 0 ? list[idx].created_at : new Date().toISOString(),
      };
      if (idx >= 0) {
        const copy = [...list];
        copy[idx] = next;
        return copy;
      }
      return [...list, next];
    });

    setSaving(true);
    try {
      await dataApi.markAttendance(target.employeeId, target.date, status, overtimeHours);
      const meta = statusMeta(status);
      toast.success('Attendance updated', {
        description: `${target.employeeName} — ${meta.label}${status === 'overtime' && overtimeHours ? ` (${fmtHours(overtimeHours)}h)` : ''} on ${fmtDate(target.date)}`,
      });
      setPopoverTarget(null);
    } catch (err) {
      setAttendance(snapshot); // revert
      toast.error(err instanceof Error ? err.message : 'Failed to update attendance');
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const cellTitle = (emp: EmployeeVM, dateStr: string, status: AttendanceStatus, ot: number | null): string => {
    const meta = statusMeta(status);
    return `${emp.full_name} · ${dateStr} — ${meta.label}${status === 'overtime' && ot ? ` (${fmtHours(ot)}h)` : ''}`;
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Attendance"
        description="Track and manage daily employee attendance across all sites"
        actions={
          <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <TabsList className="h-10">
              <TabsTrigger value="list" className="gap-1.5 px-3">
                <List size={14} /> List
              </TabsTrigger>
              <TabsTrigger value="calendar" className="gap-1.5 px-3">
                <CalendarDays size={14} /> Calendar
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {/* ---- Month navigation + filters toolbar ---- */}
      <div className="card-glow flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={goPrevMonth}
              aria-label="Previous month"
              className="size-9"
            >
              <ChevronLeft size={16} />
            </Button>
            <div className="flex h-9 min-w-[148px] items-center justify-center gap-1.5 rounded-lg border bg-muted/40 px-3">
              <span className="text-sm font-semibold">{monthLabel}</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-sm tabular-nums text-muted-foreground">{year}</span>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={goNextMonth}
              disabled={isCurrentMonth}
              aria-label="Next month"
              className="size-9"
            >
              <ChevronRight size={16} />
            </Button>
          </div>

          <Select value={monthStr} onValueChange={(v) => setMonthKey(`${year}-${v}`)}>
            <SelectTrigger className="h-9 w-[6.75rem]" aria-label="Month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={String(year)} onValueChange={(v) => setMonthKey(`${v}-${monthStr}`)}>
            <SelectTrigger className="h-9 w-20" aria-label="Year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map((y) => (
                <SelectItem key={y} value={y}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
          <SiteFilterSelect
            sites={siteOptions}
            value={siteId}
            onChange={(v) => {
              setSiteId(v);
              setPage(1);
            }}
          />

          {view === 'list' && (
            <div className="relative min-w-[160px] flex-1 sm:max-w-xs">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employees…"
                aria-label="Search employees"
                className="h-10 pl-9 pr-9"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}

          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="text-muted-foreground">
              <X size={14} /> Reset
            </Button>
          )}
        </div>
      </div>

      {/* ---- View content (animated switch) ---- */}
      <AnimatePresence mode="wait">
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25, ease: EASE }}
        >
          {loading ? (
            <div className="card-glow rounded-xl border bg-card p-4">
              {view === 'list' ? (
                <SkeletonRows rows={6} />
              ) : (
                <div className="space-y-5">
                  <Skeleton className="h-11 w-full max-w-md" />
                  <div className="grid grid-cols-7 gap-1.5">
                    {Array.from({ length: 35 }).map((_, i) => (
                      <Skeleton key={i} className="h-20 rounded-lg" />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : view === 'list' ? (
            activeEmployees.length === 0 ? (
              <EmptyState
                icon={<Users size={22} />}
                title="No employees yet"
                description="Add employees to start tracking daily attendance."
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Users size={22} />}
                title="No matching employees"
                description="Try adjusting your search or site filter to find who you are looking for."
                action={
                  filtersActive ? (
                    <Button onClick={resetFilters} className="brand-gradient font-semibold text-white">
                      <X size={15} /> Reset Filters
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="card-glow overflow-hidden rounded-xl border bg-card">
                {/* Horizontal-scrolling day matrix */}
                <div className="overflow-x-auto" role="grid" aria-label="Attendance matrix">
                  <div className="min-w-max">
                    {/* Header row */}
                    <div role="row" className="flex items-center border-b bg-muted/50">
                      <div role="columnheader" className="sticky left-0 z-20 w-64 shrink-0 bg-muted/50 px-3 py-2.5">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Employee
                        </p>
                      </div>
                      {displayDays.map((day) => {
                        const fri = isFridayOf(year, month, day);
                        const rel = isCurrentMonth ? relativeLabel(year, month, day) : null;
                        return (
                          <div
                            key={day}
                            role="columnheader"
                            aria-label={`${day} ${monthLabel} — ${weekdayShort(year, month, day)}${rel ? ` (${rel})` : ''}`}
                            className={cn(
                              'w-14 shrink-0 px-0.5 py-2 text-center',
                              fri && 'bg-rose-500/[0.05]',
                              rel && 'bg-emerald-500/[0.04]',
                            )}
                          >
                            <p
                              className={cn(
                                'text-xs font-semibold tabular-nums',
                                fri ? 'text-rose-500' : 'text-foreground/80',
                              )}
                            >
                              {day}
                            </p>
                            <p
                              className={cn(
                                'mt-0.5 text-[9px] font-medium leading-tight',
                                rel ? 'font-semibold text-emerald-500' : 'text-muted-foreground/70',
                              )}
                            >
                              {rel ?? weekdayShort(year, month, day)}
                            </p>
                          </div>
                        );
                      })}
                      <div
                        role="columnheader"
                        className="sticky right-0 z-20 w-14 shrink-0 border-l bg-muted/50 px-2 py-2.5 text-center"
                      >
                        <p
                          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                          title="Total overtime hours this month"
                        >
                          OT
                        </p>
                      </div>
                    </div>

                    {/* Employee rows */}
                    <div className="divide-y divide-border/40">
                      {pageRows.map((emp, i) => {
                        const totalOT = otTotals.get(emp.id) ?? 0;
                        return (
                          <motion.div
                            key={emp.id}
                            role="row"
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: Math.min(i * 0.025, 0.3), duration: 0.3, ease: EASE }}
                            className="group flex transition-colors duration-150 hover:bg-muted/25"
                          >
                            {/* Sticky employee cell */}
                            <div className="sticky left-0 z-10 flex w-64 shrink-0 items-center gap-2.5 border-r border-border/40 bg-card px-3 py-2.5 transition-colors duration-150 group-hover:bg-muted/25">
                              <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[11px] font-bold text-brand">
                                {emp.photo ? (
                                  <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" />
                                ) : (
                                  initials(emp.full_name)
                                )}
                              </span>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{emp.full_name}</p>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                    {emp.employee_code}
                                  </span>
                                  <span className="min-w-0 overflow-hidden">
                                    <SiteBadge name={emp.site_name} />
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Day cells */}
                            {displayDays.map((day) => {
                              const dateStr = toYMDLocal(year, month, day);
                              const future = dateStr > TODAY_STR;
                              const status = effectiveStatus(emp, dateStr);
                              const rec = attendanceMap.get(`${emp.id}|${dateStr}`);
                              const fri = isFridayOf(year, month, day);
                              const rel = isCurrentMonth ? relativeLabel(year, month, day) : null;
                              return (
                                <div
                                  key={day}
                                  role="gridcell"
                                  className={cn(
                                    'flex w-14 shrink-0 items-center justify-center py-2',
                                    fri && 'bg-rose-500/[0.04]',
                                    rel && 'bg-emerald-500/[0.05]',
                                    future && 'opacity-50',
                                  )}
                                >
                                  <StatusSquare
                                    status={status}
                                    title={cellTitle(emp, dateStr, status, rec?.overtime_hours ?? null)}
                                    onClick={future ? undefined : handleCellClick(emp, dateStr)}
                                  />
                                </div>
                              );
                            })}

                            {/* Sticky overtime total */}
                            <div className="sticky right-0 z-10 flex w-14 shrink-0 items-center justify-center border-l border-border/40 bg-card px-2 transition-colors duration-150 group-hover:bg-muted/25">
                              {totalOT > 0 ? (
                                <span
                                  className="text-xs font-semibold tabular-nums text-purple-500"
                                  title={`${fmtHours(totalOT)} overtime hours in ${monthLabel}`}
                                >
                                  {fmtHours(totalOT)}h
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground/40">—</span>
                              )}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Legend + counter + pagination */}
                <div className="flex flex-col gap-3 border-t p-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {ATTENDANCE_STATUSES.map((s) => (
                      <span key={s.value} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
                        {s.label}
                      </span>
                    ))}
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="size-2.5 rounded-sm border border-rose-500/40 bg-rose-500/10" /> Friday
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="size-2.5 rounded-sm border border-emerald-500/40 bg-emerald-500/10" /> Last 7
                      days
                    </span>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">
                    Showing <span className="font-semibold text-foreground">{pageRows.length}</span> of{' '}
                    <span className="font-semibold text-foreground">{filtered.length}</span> employee(s)
                  </p>
                </div>

                {totalPages > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-1 border-t p-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="size-8 p-0"
                      disabled={safePage === 1}
                      onClick={() => setPage(1)}
                      aria-label="First page"
                    >
                      «
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="size-8 p-0"
                      disabled={safePage === 1}
                      onClick={() => setPage(safePage - 1)}
                      aria-label="Previous page"
                    >
                      ‹
                    </Button>
                    {pageNumbers.map((n) => (
                      <Button
                        key={n}
                        variant={n === safePage ? 'default' : 'outline'}
                        size="sm"
                        className={cn('size-8 p-0', n === safePage && 'brand-gradient text-white')}
                        onClick={() => setPage(n)}
                        aria-label={`Page ${n}`}
                        aria-current={n === safePage ? 'page' : undefined}
                      >
                        {n}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="size-8 p-0"
                      disabled={safePage === totalPages}
                      onClick={() => setPage(safePage + 1)}
                      aria-label="Next page"
                    >
                      ›
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="size-8 p-0"
                      disabled={safePage === totalPages}
                      onClick={() => setPage(totalPages)}
                      aria-label="Last page"
                    >
                      »
                    </Button>
                  </div>
                )}
              </div>
            )
          ) : (
            /* ---- Calendar view ---- */
            <div className="card-glow rounded-xl border bg-card p-4 md:p-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div className="w-full max-w-md">
                  <Label className="mb-2 block">Employee</Label>
                  <EmployeeCombobox
                    employees={siteFiltered}
                    value={calendarEmployee?.id ?? null}
                    onChange={(id) => {
                      if (id) setCalendarEmployeeId(id);
                    }}
                    placeholder="Select an employee…"
                    emptyText="No employees found."
                  />
                </div>

                {calendarEmployee && (
                  <div className="flex flex-wrap items-center gap-2">
                    <SiteBadge name={calendarEmployee.site_name} />
                    {ATTENDANCE_STATUSES.map((s) => (
                      <span
                        key={s.value}
                        className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
                        style={{
                          color: s.color,
                          borderColor: `${s.color}55`,
                          backgroundColor: `${s.color}14`,
                        }}
                      >
                        <span className="size-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                        <span className="font-semibold tabular-nums">{calendarCounts[s.value]}</span>
                        {s.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {calendarEmployee ? (
                <div className="mt-5 overflow-hidden rounded-xl border" role="grid" aria-label="Attendance calendar">
                  {/* Weekday header — Sunday first */}
                  <div className="grid grid-cols-7 gap-px bg-border/50">
                    {WEEKDAYS.map((wd) => (
                      <div
                        key={wd}
                        className={cn(
                          'bg-muted/50 py-2 text-center text-[11px] font-semibold uppercase tracking-wide',
                          wd === 'Fri' ? 'text-rose-500' : 'text-muted-foreground',
                        )}
                      >
                        {wd}
                      </div>
                    ))}
                  </div>

                  {/* Day cells */}
                  <div className="grid grid-cols-7 gap-px bg-border/50">
                    {calendarCells.map((day, idx) => {
                      if (day === null) {
                        return <div key={`empty-${idx}`} className="min-h-[76px] bg-muted/20 md:min-h-[88px]" />;
                      }
                      const dateStr = toYMDLocal(year, month, day);
                      const future = dateStr > TODAY_STR;
                      const isToday = dateStr === TODAY_STR;
                      const fri = isFridayOf(year, month, day);
                      const status = effectiveStatus(calendarEmployee, dateStr);
                      const rec = attendanceMap.get(`${calendarEmployee.id}|${dateStr}`);
                      const title = cellTitle(calendarEmployee, dateStr, status, rec?.overtime_hours ?? null);
                      return (
                        <div
                          key={day}
                          role="gridcell"
                          className={cn(
                            'flex min-h-[76px] flex-col bg-card p-1.5 md:min-h-[88px] md:p-2',
                            fri && 'bg-rose-500/[0.04]',
                            future && 'opacity-45',
                            isToday && 'ring-1 ring-inset ring-brand/50',
                          )}
                        >
                          <span
                            className={cn(
                              'mb-1 text-xs font-medium tabular-nums',
                              fri ? 'text-rose-500' : isToday ? 'font-bold text-brand' : 'text-muted-foreground',
                            )}
                          >
                            {day}
                          </span>

                          {future ? (
                            <div
                              title="Future date — not editable"
                              className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 text-[10px] text-muted-foreground/70"
                            >
                              —
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={handleCellClick(calendarEmployee, dateStr)}
                              title={title}
                              aria-label={title}
                              className={cn(
                                'flex flex-1 items-center justify-center rounded-lg border text-xs font-bold transition-[transform,background-color,border-color,color] duration-200 hover:scale-[1.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-95',
                                CELL_STYLE[status],
                              )}
                            >
                              <StatusLabel status={status} />
                            </button>
                          )}

                          {status === 'overtime' && rec?.overtime_hours != null && (
                            <span className="mt-0.5 truncate text-center text-[10px] font-semibold tabular-nums text-purple-500">
                              {fmtHours(rec.overtime_hours)}h
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="mt-5">
                  <EmptyState
                    icon={<Users size={22} />}
                    title="No employees found"
                    description={
                      siteId !== 'all'
                        ? 'No employees are assigned to the selected site. Try a different site filter.'
                        : 'Add employees to start tracking daily attendance.'
                    }
                  />
                </div>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ---- Fixed-position status popover ---- */}
      <AnimatePresence>
        {popoverTarget && (
          <StatusPopover
            key={`${popoverTarget.employeeId}-${popoverTarget.date}`}
            target={popoverTarget}
            busy={saving}
            onClose={() => setPopoverTarget(null)}
            onConfirm={handleMark}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
