'use client';

// ============================================================================
// PULSE Workforce OS — Attendance (Excel-style marking sheet, displayed SITEWISE)
// ----------------------------------------------------------------------------
// • The sheet is grouped per WORK SITE (attendance is marked sitewise) and each
//   section's crew is ALPHABETICAL. An "Unassigned / Idle" section (super
//   admins only) lists employees without a site.
// • Every cell is an always-editable input: type custom hours (e.g. 8, 10.5)
//   or "A" for absent, or clear it to unmark the day.
// • BULK DAY ENTRY: fill an entire day for a whole site crew in one action —
//   hours DEFAULT TO 10 but every value is editable before the save, and the
//   sheet cells stay editable any time afterwards.
// • SITE MOVES: an employee transferred mid-month (e.g. Site A → Site B on
//   the 25th) appears under BOTH sites for that month: under the site they
//   started the month at — BOTTOM of the crew, faded — with the days from the
//   move to the end of the month rendered as ONE merged cell showing the new
//   site, and under the new site — also bottom + faded — where the earlier
//   days merge into a cell showing the old site so the moved days can be
//   marked there. A day that was ALREADY marked before the move was recorded
//   stays with the old site: the move is then displayed from the next day
//   (25th already marked at Site A → Site B shows from the 26th). The
//   printable per-site sheet simply lists them under their new site,
//   alphabetically.
// • Each row shows the employee's TRADE (position) next to their ID.
// • Right side: TOTAL HOURS (sum of the row's cells) + ABSENCES count.
// • Normal admins only see — and can only mark — the sites assigned to them
//   by a super admin (Admin Management → Site Access).
// • Calendar view: per-employee month calendar with the same editing model.
// ============================================================================

import { motion } from 'framer-motion';
import {
  ArrowLeftRight, Building2, CalendarCheck, CalendarDays, CheckCheck, ChevronLeft, ChevronRight, Loader2, Search, Shield,
  Tent, UserX, Zap,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { EmptyState, SectionTitle, SkeletonRows } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Attendance, BulkAttendanceEntry, EmployeeVM, SiteTransfer, SiteWithCount } from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// ---------------------------------------------------------------------------
// Compact column widths (px) — the marking sheet must ALWAYS show Name +
// Trade + ALL 30/31 day columns (per the selected month/year) + Total H +
// Absent on laptop / desktop screens. Fixed columns take only the space they
// need; the day columns flex to share the leftover width. The table scrolls
// horizontally ONLY when the viewport is narrower than the computed minimum.
// MOBILE: only the Employee column stays pinned in place — Trade, all day
// columns, Total H and Absent scroll together, so every day cell stays
// reachable for marking (from `lg:` up Trade pins left and Total/Absent pin
// right again). (Literals in the sticky left/right classes must match these
// values.)
// ---------------------------------------------------------------------------
const EMP_COL_W = 150; // employee — avatar + name (+ camp tooltip) + employee ID
const TRADE_COL_W = 76; // trade
const TOTAL_COL_W = 54; // total hours
const ABSENT_COL_W = 48; // absent count
const DAY_MIN_W = 22; // per-day column minimum before scrolling kicks in

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
const dateToYMD = (d: Date): string => ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
const todayYMD = (): string => {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
};
const yesterdayYMD = (): string => {
  const t = new Date();
  t.setDate(t.getDate() - 1);
  return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
};
const formatDatePretty = (date: string): string => {
  const dt = new Date(`${date}T00:00:00`);
  return `${WEEKDAYS[dt.getDay()]}, ${dt.getDate()} ${MONTH_NAMES[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}`;
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

/** A run of days within the viewed month spent at one site (null = idle). */
interface MonthSegment {
  fromDay: number;
  toDay: number;
  siteId: string | null;
}

/** An employee's site timeline across the viewed month (from the transfer log). */
interface MonthTimeline {
  /** Site the employee was at on day 1 of the month — where their row lives. */
  homeSiteId: string | null;
  segments: MonthSegment[];
  /** True when at least one move happened inside this month. */
  transferred: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function AttendancePage() {
  const realtimeVersion = useRealtimeVersion(['attendance', 'employee', 'site', 'camp', 'admin_site', 'site_transfer']);
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';

  const now = new Date();
  const [monthKey, setMonthKey] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [view, setView] = useState<'sheet' | 'calendar'>('sheet');

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [transfers, setTransfers] = useState<SiteTransfer[] | null>(null);
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

  // bulk day entry state ("Bulk Day" dialog)
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDate, setBulkDate] = useState<string>(todayYMD());
  const [bulkSite, setBulkSite] = useState<string>('all'); // site id | 'all' | 'idle'
  const [bulkHours, setBulkHours] = useState('10'); // default hours for unmarked rows
  const [bulkValues, setBulkValues] = useState<Record<string, string>>({}); // empId → raw cell text
  const [bulkInclude, setBulkInclude] = useState<Record<string, boolean>>({}); // empId → checked
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkCalOpen, setBulkCalOpen] = useState(false); // date picker popover

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
        const [emps, sts, trs] = await Promise.all([
          dataApi.listEmployees(), dataApi.listSites(), dataApi.listSiteTransfers(),
        ]);
        if (!cancelled) { setEmployees(emps); setSites(sts); setTransfers(trs); }
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

  // ---- site-transfer timelines for the viewed month ---------------------------
  // Every recorded site move splits the month into segments. An employee moved
  // during the month gets a row in EVERY section they spent days at (bottom,
  // faded); each foreign segment renders as one merged cell showing that
  // site. Months before the move → old site as a normal row; months after →
  // new site as a normal row. IMPORTANT: a day that was already marked BEFORE
  // the move was recorded keeps its old-site marking — the move is then
  // displayed from the next unmarked day (marked on the 25th + moved on the
  // 25th → the sheet shows the move from the 26th only).
  const timelines = useMemo(() => {
    const byEmp = new Map<string, SiteTransfer[]>();
    (transfers ?? []).forEach((t) => {
      const arr = byEmp.get(t.employee_id) ?? [];
      arr.push(t);
      byEmp.set(t.employee_id, arr);
    });
    byEmp.forEach((arr) => arr.sort((a, b) =>
      a.effective_date === b.effective_date
        ? a.created_at.localeCompare(b.created_at)
        : a.effective_date < b.effective_date ? -1 : 1));

    // records by employee → date (created_at tells us whether the day was
    // marked at the old site BEFORE the move was recorded)
    const recBy = new Map<string, Map<string, Attendance>>();
    (records ?? []).forEach((r) => {
      let m = recBy.get(r.employee_id);
      if (!m) { m = new Map(); recBy.set(r.employee_id, m); }
      m.set(r.date, r);
    });

    const first = ymd(year, month, 1);
    const last = ymd(year, month, days);
    const map = new Map<string, MonthTimeline>();
    for (const emp of employees ?? []) {
      const ts = byEmp.get(emp.id);
      if (!ts || ts.length === 0) {
        map.set(emp.id, {
          homeSiteId: emp.current_site_id,
          segments: [{ fromDay: 1, toDay: days, siteId: emp.current_site_id }],
          transferred: false,
        });
        continue;
      }
      // site at day 1 = fold of every transfer already effective by then
      let site: string | null = ts[0].from_site_id ?? null;
      const moves: { day: number; to: string | null }[] = [];
      for (const t of ts) {
        if (t.effective_date <= first) site = t.to_site_id ?? null;
        else if (t.effective_date <= last) {
          // displayed move day: skip forward past days that were already
          // marked at the old site before this transfer was recorded
          let day = Number(t.effective_date.slice(8, 10));
          const empRecs = recBy.get(emp.id);
          if (empRecs) {
            while (day <= days) {
              const rec = empRecs.get(ymd(year, month, day));
              if (rec && rec.created_at <= t.created_at) day += 1;
              else break;
            }
          }
          if (day > days) continue; // whole month already marked at the old site
          moves.push({ day, to: t.to_site_id ?? null });
        }
      }
      const segments: MonthSegment[] = [{ fromDay: 1, toDay: days, siteId: site }];
      for (const mv of moves) {
        const cur = segments[segments.length - 1];
        if (mv.day <= cur.fromDay) { cur.siteId = mv.to; continue; } // same-day move → overwrite
        cur.toDay = mv.day - 1;
        segments.push({ fromDay: mv.day, toDay: days, siteId: mv.to });
      }
      map.set(emp.id, { homeSiteId: site, segments, transferred: moves.length > 0 });
    }
    return map;
  }, [employees, transfers, records, year, month, days]);

  // ---- sitewise sections --------------------------------------------------------
  // Alphabetical inside each section; employees moved mid-month get a row at
  // the BOTTOM of EVERY site they spent days at this month (faded), so their
  // marking cells stay reachable under both the old and the new site.
  const sections = useMemo<SiteSection[]>(() => {
    const q = debouncedSearch.toLowerCase().trim();
    const matches = (e: EmployeeVM) =>
      !q || `${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.nationality ?? ''}`.toLowerCase().includes(q);
    const byName = (a: EmployeeVM, b: EmployeeVM) => a.full_name.localeCompare(b.full_name);

    // admins only ever see their assigned sites' sections
    const siteList = (sites ?? []).filter(
      (s) => s.is_active && (assignedSiteIds === null || assignedSiteIds.has(s.id)),
    );
    const activeSiteIds = new Set(siteList.map((s) => s.id));

    // where do this employee's rows live for the viewed month? Every site with
    // at least one segment (moved employees → several sections, one row each).
    const placements = new Map<string, { sites: Set<string | null>; moved: boolean }>();
    for (const e of scoped) {
      const tl = timelines.get(e.id);
      if (!tl || !tl.transferred) {
        // no in-month move → exactly one row: at the site they started the
        // month at, falling back to the current site / idle when it's gone
        const home = tl?.homeSiteId ?? e.current_site_id;
        const site = home !== null && activeSiteIds.has(home)
          ? home
          : e.current_site_id !== null && activeSiteIds.has(e.current_site_id) ? e.current_site_id : null;
        placements.set(e.id, { sites: new Set([site]), moved: false });
        continue;
      }
      // moved during THIS month → one row per site spent days at
      const sitesSet = new Set<string | null>();
      tl.segments.forEach((sg) => {
        const s = sg.siteId ?? null;
        if (s !== null && !activeSiteIds.has(s)) return; // site since deleted/inactive
        sitesSet.add(s);
      });
      if (sitesSet.size === 0) sitesSet.add(null); // keep the row visible under idle
      placements.set(e.id, { sites: sitesSet, moved: true });
    }
    const rowSort = (a: EmployeeVM, b: EmployeeVM): number => {
      const ma = placements.get(a.id)?.moved ? 1 : 0;
      const mb = placements.get(b.id)?.moved ? 1 : 0;
      if (ma !== mb) return ma - mb; // moved rows sink to the bottom
      return byName(a, b);
    };

    const result: SiteSection[] = siteList
      .filter((s) => siteFilter === 'all' || s.id === siteFilter)
      .map((s) => ({
        key: s.id,
        title: s.name,
        client: s.client_name,
        emps: scoped
          .filter((e) => placements.get(e.id)?.sites.has(s.id) && matches(e))
          .sort(rowSort),
      }))
      .filter((sec) => sec.emps.length > 0);

    // idle employees — super admins only (admins can never mark them)
    if (isSuperAdmin && (siteFilter === 'all' || siteFilter === 'idle')) {
      const idle = scoped
        .filter((e) => placements.get(e.id)?.sites.has(null) && matches(e))
        .sort(rowSort);
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
  }, [sites, scoped, siteFilter, debouncedSearch, isSuperAdmin, timelines, assignedSiteIds]);

  // flat crew for the calendar view combobox (a moved employee sits in several
  // sections — the picker lists them once)
  const crew = useMemo(() => {
    const seen = new Set<string>();
    const out: EmployeeVM[] = [];
    sections.forEach((s) => s.emps.forEach((e) => {
      if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
    }));
    return out;
  }, [sections]);

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

  // Hours an employee spent at ONE particular site in the viewed month. Moved
  // employees have rows in several sections — each section band only counts
  // its own site's days, so nobody is double-counted across sections.
  const siteRowHours = (empId: string, siteKey: string | null): number => {
    const segs = timelines.get(empId)?.segments ?? null;
    let total = 0;
    const addDay = (d: number) => {
      const parsed = parseCell(cellText(empId, ymd(year, month, d)));
      if (parsed.kind === 'hours') total += parsed.hours ?? 0;
    };
    if (!segs) {
      for (let d = 1; d <= days; d++) addDay(d);
    } else {
      for (const sg of segs) {
        if ((sg.siteId ?? null) !== siteKey) continue;
        for (let d = sg.fromDay; d <= sg.toDay; d++) addDay(d);
      }
    }
    return Math.round(total * 100) / 100;
  };

  // ---- month navigation ----------------------------------------------------------
  const shiftMonth = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setMonthKey(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };

  // ===========================================================================
  // BULK DAY ENTRY — mark a whole day for an entire crew at once.
  // Unmarked employees are prefilled with the default hours (10), every value
  // is editable before saving, and the sheet cells remain editable any time.
  // ===========================================================================
  const defaultHoursText = (): string => {
    const p = parseCell(bulkHours);
    return p.kind === 'hours' ? String(p.hours) : '10';
  };

  // crew in the current bulk scope (respects admin site permissions AND the
  // site each employee was actually at on the picked date — a mid-month move
  // means the employee is bulk-markable at their old site for the days before
  // the move and at the new site afterwards)
  const bulkCrew = useMemo(() => {
    const sameMonth = bulkDate.slice(0, 7) === monthKey;
    const dayOf = Number(bulkDate.slice(8, 10));
    const siteOnDay = (e: EmployeeVM): string | null => {
      if (!sameMonth) return e.current_site_id;
      const segs = timelines.get(e.id)?.segments;
      if (!segs) return e.current_site_id;
      const sg = segs.find((x) => dayOf >= x.fromDay && dayOf <= x.toDay);
      return sg ? (sg.siteId ?? null) : e.current_site_id;
    };
    const arr = scoped.filter((e) => {
      if (bulkSite === 'all') return true;
      const want = bulkSite === 'idle' ? null : bulkSite;
      return siteOnDay(e) === want;
    });
    return [...arr].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [scoped, bulkSite, bulkDate, monthKey, timelines]);

  // prefill whenever the dialog opens, the date changes or fresh records arrive
  useEffect(() => {
    if (!bulkOpen) return;
    const def = defaultHoursText();
    const vals: Record<string, string> = {};
    const inc: Record<string, boolean> = {};
    scoped.forEach((e) => {
      const existing = recordToText(recordMap.get(`${e.id}|${bulkDate}`));
      vals[e.id] = existing !== '' ? existing : def;
      inc[e.id] = true;
    });
    setBulkValues(vals);
    setBulkInclude(inc);
  }, [bulkOpen, bulkDate, recordMap, scoped]);

  // live stats for the footer chips
  const bulkStats = useMemo(() => {
    let selected = 0, present = 0, absent = 0, changes = 0, invalid = 0;
    for (const emp of bulkCrew) {
      if (!bulkInclude[emp.id]) continue;
      selected += 1;
      const raw = (bulkValues[emp.id] ?? '').trim();
      const parsed = parseCell(raw);
      if (parsed.kind === 'invalid') invalid += 1;
      if (parsed.kind === 'hours') present += 1;
      if (parsed.kind === 'absent') absent += 1;
      const existing = recordToText(recordMap.get(`${emp.id}|${bulkDate}`));
      if (raw !== existing) changes += 1;
    }
    return { selected, present, absent, changes, invalid };
  }, [bulkCrew, bulkInclude, bulkValues, recordMap, bulkDate]);

  const bulkAllIncluded = bulkCrew.length > 0 && bulkCrew.every((e) => bulkInclude[e.id]);

  const toggleBulkAbsent = (empId: string) => {
    const cur = (bulkValues[empId] ?? '').trim().toLowerCase();
    if (cur === 'a') {
      const existing = recordToText(recordMap.get(`${empId}|${bulkDate}`));
      setBulkValues((v) => ({ ...v, [empId]: existing !== '' ? existing : defaultHoursText() }));
    } else {
      setBulkValues((v) => ({ ...v, [empId]: 'A' }));
    }
  };

  const applyBulkDefault = (all: boolean) => {
    const def = defaultHoursText();
    setBulkValues((prev) => {
      const next = { ...prev };
      for (const emp of bulkCrew) {
        if (!bulkInclude[emp.id]) continue; // skipped rows are never touched
        const existing = recordToText(recordMap.get(`${emp.id}|${bulkDate}`));
        if (all || existing === '') next[emp.id] = def;
      }
      return next;
    });
  };

  const onBulkDateChange = (d: string) => {
    setBulkDate(d);
    const mk = d.slice(0, 7);
    if (mk && mk !== monthKey) setMonthKey(mk); // keep the sheet on the day being bulk-filled
  };

  const openBulkDialog = (siteId: string = 'all') => {
    setBulkHours('10');
    setBulkDate(todayYMD());
    setBulkSite(siteId);
    setBulkOpen(true);
  };

  const saveBulkDay = async () => {
    for (const emp of bulkCrew) {
      if (!bulkInclude[emp.id]) continue;
      const raw = (bulkValues[emp.id] ?? '').trim();
      if (parseCell(raw).kind === 'invalid') {
        toast.error(`Invalid value for ${emp.full_name}`, { description: 'Enter hours (0–24, e.g. 8 or 10.5) or A for absent.' });
        return;
      }
    }
    const entries: BulkAttendanceEntry[] = [];
    for (const emp of bulkCrew) {
      if (!bulkInclude[emp.id]) continue;
      const raw = (bulkValues[emp.id] ?? '').trim();
      const existing = recordToText(recordMap.get(`${emp.id}|${bulkDate}`));
      if (raw === existing) continue; // untouched → skip
      entries.push({ employee_id: emp.id, date: bulkDate, value: raw });
    }
    if (entries.length === 0) {
      toast.info('Nothing to save', { description: 'No changes for this day.' });
      setBulkOpen(false);
      return;
    }
    setBulkSaving(true);
    try {
      await dataApi.bulkMarkAttendance(entries);
      // optimistic local sync (realtime refetch reconciles)
      setRecords((prev) => {
        const list = prev ? [...prev] : [];
        for (const entry of entries) {
          const parsed = parseCell(entry.value ?? '');
          const idx = list.findIndex((r) => r.employee_id === entry.employee_id && r.date === entry.date);
          if (parsed.kind === 'clear') {
            if (idx >= 0) list.splice(idx, 1);
            continue;
          }
          const rec: Attendance = idx >= 0
            ? { ...list[idx], status: parsed.kind === 'absent' ? 'absent' : 'present', hours: parsed.hours }
            : {
                id: `local-${entry.employee_id}-${entry.date}`, employee_id: entry.employee_id,
                date: entry.date, status: parsed.kind === 'absent' ? 'absent' : 'present',
                hours: parsed.hours, is_hidden: false, created_at: new Date().toISOString(),
              };
          if (idx >= 0) list[idx] = rec; else list.push(rec);
        }
        return list;
      });
      const absents = entries.filter((e) => (e.value ?? '').trim().toLowerCase() === 'a').length;
      toast.success(`Day saved — ${entries.length} employee${entries.length !== 1 ? 's' : ''} updated`, {
        description: absents > 0 ? `${absents} marked absent · every cell stays editable in the sheet.` : 'Every cell stays editable in the sheet.',
      });
      setBulkOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save bulk day');
    } finally {
      setBulkSaving(false);
    }
  };

  const loading = !employees || !records || !sites || !transfers || (!isSuperAdmin && assignedSiteIds === null);
  const calendarEmployee = crew.find((e) => e.id === calendarEmployeeId) ?? null;

  const dayColumns = useMemo(() => {
    // always show the FULL month (1 … last day): un-entered days stay blank,
    // future days are rendered but locked against editing.
    const cols: number[] = [];
    for (let d = 1; d <= days; d++) cols.push(d);
    return cols;
  }, [days]);

  // ---- one day cell (plain render fn — keeps input focus stable) ------------
  const renderDayCell = (emp: EmployeeVM, date: string, faded = false) => {
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
            className="flex h-8 w-full cursor-not-allowed items-center justify-center"
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
                'h-8 w-full bg-transparent text-center text-[11px] font-medium tabular-nums outline-none transition-colors',
                'hover:bg-brand/10 focus:bg-brand/15 focus:ring-1 focus:ring-brand/60 focus:ring-inset',
                isA && 'bg-rose-500/10 font-bold text-rose-500',
                value !== '' && !isA && 'text-foreground',
                busy && 'opacity-50',
                faded && 'opacity-60',
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
    const totalHours = section.emps.reduce(
      (sum, emp) => sum + siteRowHours(emp.id, section.isIdle ? null : section.key), 0,
    );
    const movedCount = section.emps.filter((e) => timelines.get(e.id)?.transferred).length;
    const siteNameOf = (siteId: string | null): string =>
      siteId ? (sites ?? []).find((s) => s.id === siteId)?.name ?? 'Former site' : 'Unassigned / Idle';
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
            {movedCount > 0 && (
              <span
                className="hidden items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-semibold text-brand sm:inline-flex"
                title="Employees moved to another site this month sit at the bottom of both crews (faded): mark them at the old site up to the move and at the new site afterwards — the moved days merge into one labelled cell on each row"
              >
                <ArrowLeftRight size={11} />
                {movedCount} moved
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2.5 text-[11px]"
              onClick={() => openBulkDialog(section.isIdle ? 'idle' : section.key)}
              title={`Bulk-fill a day for ${section.title} — hours default to 10`}
            >
              <Zap size={12} />
              Fill day
            </Button>
          </div>
        </div>

        {/* crew table — fits the FULL month (all columns) on desktop;
            horizontal scrolling only kicks in on smaller screens */}
        <div className="card-glow overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table
              className="w-full table-fixed border-collapse text-sm"
              style={{ minWidth: EMP_COL_W + TRADE_COL_W + TOTAL_COL_W + ABSENT_COL_W + dayColumns.length * DAY_MIN_W }}
            >
              <thead>
                <tr className="border-b bg-muted/60 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th
                    style={{ width: EMP_COL_W }}
                    className="sticky left-0 z-20 border-x border-foreground/15 bg-muted/60 px-2 py-2 font-medium"
                  >
                    Employee
                  </th>
                  <th
                    style={{ width: TRADE_COL_W }}
                    className="lg:sticky lg:left-[150px] z-20 border-x border-b border-foreground/15 bg-muted/60 px-2 py-2 font-medium"
                  >
                    Trade
                  </th>
                  {dayColumns.map((d) => {
                    const date = ymd(year, month, d);
                    const sun = isSunday(date);
                    const future = date > today;
                    return (
                      <th
                        key={d}
                        className={cn(
                          'border-x border-b border-foreground/15 px-0 py-2 text-center font-medium',
                          sun && 'bg-rose-500/[0.07] text-rose-500',
                          future && 'text-muted-foreground/50',
                        )}
                        title={`${MONTH_NAMES[month - 1]} ${d}${sun ? ' (Sunday)' : ''}${future ? ' — future (locked)' : ''}`}
                      >
                        <div className="text-[10px] leading-tight">{d}</div>
                        <div className={cn('text-[8px] font-normal normal-case leading-tight opacity-70', sun && 'text-rose-500')}>
                          {WEEKDAYS[new Date(`${date}T00:00:00`).getDay()]}
                        </div>
                      </th>
                    );
                  })}
                  <th
                    style={{ width: TOTAL_COL_W }}
                    className="lg:sticky lg:right-[48px] z-20 border-x border-b border-foreground/15 bg-muted/60 px-1 py-2 text-center font-medium text-emerald-500"
                  >
                    Total H
                  </th>
                  <th
                    style={{ width: ABSENT_COL_W }}
                    className="lg:sticky lg:right-0 z-20 border-l border-b border-foreground/15 bg-muted/60 px-1 py-2 text-center font-medium text-rose-500"
                  >
                    Absent
                  </th>
                </tr>
              </thead>
              <tbody>
                {section.emps.map((emp, i) => {
                  const totals = rowTotals(emp.id);
                  const tl = timelines.get(emp.id);
                  const moved = tl?.transferred ?? false;
                  // segment matching the section's site (or idle) → editable day
                  // cells; every other segment → ONE merged cell with the site name
                  const homeKey: string | null = section.isIdle ? null : section.key;
                  const segs: MonthSegment[] =
                    tl?.segments ?? [{ fromDay: 1, toDay: days, siteId: emp.current_site_id }];
                  const movedLabel = segs
                    .filter((sg) => (sg.siteId ?? null) !== homeKey)
                    .map((sg) => `${siteNameOf(sg.siteId)} · ${MONTH_NAMES[month - 1]} ${sg.fromDay}–${sg.toDay}`)
                    .join(' → ');
                  return (
                    <motion.tr
                      key={emp.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i * 0.02, 0.25), ease: EASE }}
                      className={cn('transition-colors', moved && 'bg-muted/25')}
                    >
                      {/* employee — avatar + name (camp as tooltip icon) + ID */}
                      <td className="sticky left-0 z-10 border-x border-b border-foreground/15 bg-card px-2 py-1.5">
                        <div className={cn('flex items-center gap-2', moved && 'opacity-60')}>
                          <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[9px] font-bold text-brand">
                            {emp.photo ? <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" /> : initials(emp.full_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[12px] font-medium leading-tight">
                              {emp.full_name}
                              {emp.camp_name && (
                                <span
                                  className="ml-1 inline-block align-middle text-amber-600 dark:text-amber-400"
                                  title={`Camp: ${emp.camp_name}${emp.camp_block ? ' · Block ' + emp.camp_block : ''}${emp.camp_room ? ' · Room ' + emp.camp_room : ''}`}
                                >
                                  <Tent size={9} className="inline" />
                                </span>
                              )}
                              {moved && (
                                <span
                                  className="ml-1 inline-block align-middle text-brand"
                                  title={`Moved this month: ${movedLabel}`}
                                >
                                  <ArrowLeftRight size={9} className="inline" />
                                </span>
                              )}
                            </p>
                            <p className="truncate font-mono text-[9px] leading-tight text-muted-foreground">{emp.employee_code}</p>
                          </div>
                        </div>
                      </td>
                      {/* trade — its own dedicated column (pins left from lg up) */}
                      <td className="lg:sticky lg:left-[150px] z-10 border-x border-b border-foreground/15 bg-card px-2 py-1.5">
                        <span
                          className={cn('block truncate text-[11px] font-medium text-foreground/80', moved && 'opacity-60')}
                          title={emp.position ?? undefined}
                        >
                          {emp.position ?? '—'}
                        </span>
                      </td>
                      {/* days — one editable cell per day for the segment(s) at this
                          site; moved-away segments merge into one labelled cell */}
                      {segs.map((seg, si) => {
                        const isHome = (seg.siteId ?? null) === homeKey;
                        if (isHome) {
                          const cells: ReactNode[] = [];
                          for (let d = seg.fromDay; d <= seg.toDay; d++) {
                            cells.push(renderDayCell(emp, ymd(year, month, d), moved));
                          }
                          return <Fragment key={`seg-${si}`}>{cells}</Fragment>;
                        }
                        const span = seg.toDay - seg.fromDay + 1;
                        const label = siteNameOf(seg.siteId);
                        // leading segment = where they came from; later = where they moved to
                        const tooltip = si === 0
                          ? `Was at ${label} until ${formatDatePretty(ymd(year, month, segs[si + 1]?.fromDay ?? days))}`
                          : `Moved to ${label} on ${formatDatePretty(ymd(year, month, seg.fromDay))}`;
                        return (
                          <td
                            key={`seg-${si}`}
                            colSpan={span}
                            className="border-x border-b border-foreground/15 bg-brand/[0.08] p-0"
                          >
                            <div
                              className="flex h-8 items-center justify-center gap-1 px-1"
                              title={tooltip}
                            >
                              <ArrowLeftRight size={10} className="shrink-0 text-brand" />
                              <span className="truncate text-[10px] font-semibold italic text-brand">{label}</span>
                            </div>
                          </td>
                        );
                      })}
                      {/* Total hours (pins right from lg up) */}
                      <td className="lg:sticky lg:right-[48px] z-10 border-x border-b border-foreground/15 bg-card px-1 py-1.5 text-center">
                        <span className={cn(
                          'inline-flex min-w-9 justify-center rounded-md bg-emerald-500/10 px-1 py-0.5 text-[11px] font-bold tabular-nums text-emerald-500',
                          moved && 'opacity-60',
                        )}>
                          {totals.hours}
                        </span>
                      </td>
                      {/* Absences (pins right from lg up) */}
                      <td className="lg:sticky lg:right-0 z-10 border-l border-b border-foreground/15 bg-card px-1 py-1.5 text-center">
                        <span
                          className={cn(
                            'inline-flex min-w-7 justify-center rounded-md px-1 py-0.5 text-[11px] font-bold tabular-nums',
                            totals.absents > 0 ? 'bg-rose-500/10 text-rose-500' : 'bg-muted text-muted-foreground',
                            moved && 'opacity-60',
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
            {movedCount > 0 && (
              <> · <span className="font-medium text-brand">{movedCount} moved mid-month → bottom row, faded — their row also appears under the site they moved to</span></>
            )}
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
            Sitewise Excel-style marking — type custom hours per day, or <span className="font-semibold text-rose-500">A</span> for absent.
            Bulk-fill a whole day in one go via <span className="font-semibold text-foreground">Bulk Day</span> (defaults to 10h).
            Employees moved mid-month appear under both sites — bottom of the crew, faded, moved days merged — so they stay markable at each site
            (a day already marked before the move keeps its original site).
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
            <Button
              className="h-10 gap-1.5"
              disabled={loading}
              onClick={() => openBulkDialog('all')}
            >
              <Zap size={15} />
              Bulk Day
            </Button>
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
          <span className="hidden items-center gap-1.5 lg:flex"><span className="size-2.5 rounded-sm bg-brand/15 ring-1 ring-brand/40" />Moved mid-month (faded)</span>
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
      {/* ============================ BULK DAY ENTRY DIALOG ============================ */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <Zap size={15} />
              </span>
              Bulk Day Entry
            </DialogTitle>
            <DialogDescription>
              Fill an entire day for a whole crew in one save — unmarked employees default to{' '}
              <span className="font-semibold text-foreground">10 hours</span>, and every value stays editable
              here and in the sheet at any time.
            </DialogDescription>
          </DialogHeader>

          {/* controls: date · site scope · default hours */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Date *</Label>
              <Popover open={bulkCalOpen} onOpenChange={setBulkCalOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-10 w-full justify-between bg-card font-normal" aria-label="Pick a date to bulk-fill">
                    <span className="truncate">{bulkDate ? formatDatePretty(bulkDate) : 'Pick a date'}</span>
                    <CalendarDays size={15} className="shrink-0 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    defaultMonth={bulkDate ? new Date(`${bulkDate}T00:00:00`) : new Date()}
                    selected={bulkDate ? new Date(`${bulkDate}T00:00:00`) : undefined}
                    onDayClick={(d) => {
                      onBulkDateChange(dateToYMD(d));
                      setBulkCalOpen(false);
                    }}
                    disabled={{ after: new Date() }}
                    captionLayout="dropdown"
                    fromYear={2020}
                    toYear={new Date().getFullYear()}
                    weekStartsOn={0}
                  />
                  <div className="flex gap-1.5 border-t p-2">
                    <Button
                      variant="outline" size="sm" className="h-7 flex-1 text-[11px]"
                      onClick={() => { onBulkDateChange(todayYMD()); setBulkCalOpen(false); }}
                    >
                      Today
                    </Button>
                    <Button
                      variant="outline" size="sm" className="h-7 flex-1 text-[11px]"
                      onClick={() => { onBulkDateChange(yesterdayYMD()); setBulkCalOpen(false); }}
                    >
                      Yesterday
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <p className="text-[10px] text-muted-foreground">Pick any past date to fill it</p>
            </div>
            <div className="space-y-1.5">
              <Label>Site scope</Label>
              <Select value={bulkSite} onValueChange={setBulkSite}>
                <SelectTrigger className="h-10 w-full bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All my sites</SelectItem>
                  {selectableSites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                  {isSuperAdmin && <SelectItem value="idle">Unassigned / Idle</SelectItem>}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                {isSuperAdmin ? 'All sites + idle crew' : 'Only your assigned sites'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-hours">Default hours</Label>
              <Input
                id="bulk-hours"
                inputMode="decimal"
                className="h-10 bg-card"
                placeholder="10"
                value={bulkHours}
                onChange={(e) => setBulkHours(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">Applied to unmarked employees</p>
            </div>
          </div>

          {/* list header: select-all + default re-apply */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
              <Checkbox
                checked={bulkAllIncluded}
                onCheckedChange={(c) =>
                  setBulkInclude(Object.fromEntries(bulkCrew.map((e) => [e.id, c === true])))
                }
                aria-label="Select all employees"
              />
              {bulkStats.selected}/{bulkCrew.length} selected
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="outline" size="sm" className="h-7 px-2.5 text-[11px]"
                disabled={bulkCrew.length === 0}
                onClick={() => applyBulkDefault(false)}
              >
                {defaultHoursText()}h → unmarked
              </Button>
              <Button
                variant="outline" size="sm" className="h-7 px-2.5 text-[11px]"
                disabled={bulkCrew.length === 0}
                onClick={() => applyBulkDefault(true)}
              >
                {defaultHoursText()}h → all
              </Button>
            </div>
          </div>

          {/* employee rows */}
          <div className="max-h-[44vh] space-y-1 overflow-y-auto rounded-xl border bg-card p-2">
            {bulkCrew.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                No employees in this scope — assign employees to a site first.
              </p>
            ) : (
              bulkCrew.map((emp) => {
                const raw = bulkValues[emp.id] ?? '';
                const parsed = parseCell(raw);
                const invalid = parsed.kind === 'invalid';
                const isA = parsed.kind === 'absent';
                const existing = recordToText(recordMap.get(`${emp.id}|${bulkDate}`));
                const changed = raw.trim() !== existing;
                const included = bulkInclude[emp.id] ?? false;
                return (
                  <div
                    key={emp.id}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-all',
                      included ? 'bg-card' : 'opacity-50',
                      invalid && 'border-rose-500/40',
                    )}
                  >
                    <Checkbox
                      checked={included}
                      onCheckedChange={(c) => setBulkInclude((v) => ({ ...v, [emp.id]: c === true }))}
                      aria-label={`Include ${emp.full_name}`}
                    />
                    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                      {emp.photo ? <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" /> : initials(emp.full_name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium leading-tight">{emp.full_name}</p>
                      <p className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
                        {emp.employee_code} · {emp.position ?? 'No trade'}
                      </p>
                    </div>
                    <span className="hidden shrink-0 rounded-full border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
                      {emp.site_name ?? 'Idle'}
                    </span>
                    <span className="w-[64px] shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                      {existing === '' ? 'unmarked' : `was ${existing}`}
                    </span>
                    <Input
                      value={raw}
                      onChange={(e) => setBulkValues((v) => ({ ...v, [emp.id]: e.target.value }))}
                      aria-label={`Hours for ${emp.full_name} on ${bulkDate}`}
                      className={cn(
                        'h-9 w-16 shrink-0 text-center font-semibold tabular-nums',
                        isA && 'bg-rose-500/10 text-rose-500',
                        invalid && 'border-rose-500/60 bg-rose-500/10 text-rose-500',
                      )}
                    />
                    <Button
                      variant="outline" size="icon"
                      className={cn(
                        'size-9 shrink-0 text-xs font-bold hover:bg-rose-500/10 hover:text-rose-500',
                        isA && 'border-rose-500/50 bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 hover:text-rose-500',
                      )}
                      onClick={() => toggleBulkAbsent(emp.id)}
                      aria-label={`Toggle absent for ${emp.full_name}`}
                      title="Toggle absent"
                    >
                      A
                    </Button>
                    {changed && (
                      <span className="size-1.5 shrink-0 rounded-full bg-amber-400" title="Changed from saved value" />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* footer: live summary + save */}
          <DialogFooter className="flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
                {bulkStats.selected} selected
              </span>
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 font-semibold tabular-nums text-emerald-500">
                {bulkStats.present} present
              </span>
              <span className={cn(
                'rounded-full border px-2 py-0.5 font-semibold tabular-nums',
                bulkStats.absent > 0
                  ? 'border-rose-500/25 bg-rose-500/10 text-rose-500'
                  : 'bg-muted text-muted-foreground',
              )}>
                {bulkStats.absent} absent
              </span>
              <span className={cn(
                'rounded-full border px-2 py-0.5 font-semibold tabular-nums',
                bulkStats.changes > 0
                  ? 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-muted text-muted-foreground',
              )}>
                {bulkStats.changes} change{bulkStats.changes !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkSaving}>
                Cancel
              </Button>
              <Button
                onClick={saveBulkDay}
                disabled={bulkSaving || bulkStats.invalid > 0 || bulkStats.changes === 0}
              >
                {bulkSaving ? <Loader2 size={15} className="animate-spin" /> : <CheckCheck size={15} />}
                {bulkStats.invalid > 0
                  ? `Fix ${bulkStats.invalid} invalid value${bulkStats.invalid !== 1 ? 's' : ''}`
                  : `Save Day${bulkStats.changes > 0 ? ` (${bulkStats.changes})` : ''}`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
