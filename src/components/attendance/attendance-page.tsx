'use client';

// ============================================================================
// PULSE Workforce OS — Attendance (Excel-style marking sheet, displayed SITEWISE)
// ----------------------------------------------------------------------------
// • The sheet is grouped per WORK SITE (attendance is marked sitewise) and each
//   section's crew is ALPHABETICAL. An "Unassigned / Idle" section (super
//   admins only) lists employees without a site.
// • Every cell is an always-editable input: type custom hours (e.g. 8, 10.5),
//   "A" for absent, ANY OTHER FREE TEXT as a day marker (e.g. "OT", "H",
//   "travel") — free text is stored, shown in the cell and is NEVER counted
//   as absent — or clear it to unmark the day.
// • BULK DAY ENTRY: fill an entire day for a whole site crew in one action —
//   hours DEFAULT TO 10 but every value is editable before the save, and the
//   sheet cells stay editable any time afterwards.
// • SITE MOVES (DATE-EFFECTIVE, one shared engine): src/lib/site-timeline.ts —
//   mirrored by the emp_site_on_date() SQL function — decides which site an
//   employee belonged to on every date. An employee transferred mid-month
//   (e.g. Site A → Site B on the 25th) appears under BOTH sites for that
//   month: under the site they started the month at — BOTTOM of the crew,
//   faded — with the days from the move to the end of the month rendered as
//   ONE merged cell showing the new site, and under the new site — also
//   bottom + faded — where the earlier days merge into a cell showing the
//   old site so the moved days can be marked there. A day that was ALREADY
//   marked before the move was recorded stays with the old site: the move is
//   then displayed (and enforced by the marking RPCs) from the next unmarked
//   day (25th marked at 5 PM + moved on the 25th at 8 PM → Site B shows from
//   the 26th). Multiple transfers chain chronologically (A → B → C works).
//   The printable per-site sheet simply lists them under their current site,
//   alphabetically.
// • Each row shows the employee's TRADE (position) next to their ID.
// • Right side: TOTAL HOURS (sum of the row's cells) + ABSENCES count.
// • Normal admins only see — and can only mark — the sites assigned to them
//   by a super admin (Admin Management → Site Access).
// • Calendar view: per-employee month calendar with the same editing model.
// • KEYBOARD NAVIGATION (src/lib/grid-nav.ts): arrow keys and Enter move
//   between the day cells like a spreadsheet — ↑/↓ and Enter/Shift+Enter hop
//   between rows in the same day column, ←/→ step along the row when the
//   caret is at the edge of the value. Locked future dates and merged
//   moved-away segments are skipped automatically. The bulk-day dialog's
//   value cells support the same ↑/↓/Enter walking down the crew list.
// • SUPERVISORS (attendance markers): every site can name the person who
//   marks its attendance (Sites → site form → Supervisor), and admin accounts
//   assigned to the site (Admin Management → Site Access) count as markers too
//   — both sources are merged (deduped by name). Each site section shows a
//   "Supervised by" chip, and "View by Supervisors" at the top lists every
//   marker with the sites + crews they cover — expanding one shows their sites
//   and clicking a site jumps the sheet straight to it.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeftRight, Building2, CalendarCheck, CalendarDays, Check, CheckCheck, ChevronLeft, ChevronRight, Copy, ExternalLink, Link2, Loader2, Lock, MessageCircle, Search, Send, Shield,
  Tent, Unlock, UserCheck, UserX, Users, X, Zap,
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
import { gridCellKeyDown, type GridNavConfig } from '@/lib/grid-nav';
import {
  buildMonthTimeline,
  getEmployeeSiteForDate,
  indexRecords,
  type MonthSegment,
  type MonthTimeline,
  type SiteTimelineInput,
} from '@/lib/site-timeline';
import { cn } from '@/lib/utils';
import type { AdminSiteAssignment, Attendance, AttendanceShareLink, BulkAttendanceEntry, EmployeeVM, SiteTransfer, SiteWithCount } from '@/lib/types';
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

// keyboard navigation pools (arrow keys + Enter — see the file header)
const DAY_CELL_NAV: GridNavConfig = {
  // column = day of the month ("01"…"31"), row = the sheet row (<tr>)
  selector: 'input[data-day-col]',
  colOf: (el) => el.dataset.dayCol,
  rowOf: (el) => el.closest('tr'),
};
const BULK_VALUE_NAV: GridNavConfig = {
  // one value cell per employee row → a single vertical column
  selector: 'input[data-bulk-value]',
  colOf: () => 'v',
  rowOf: (el) => el.closest('[data-bulk-row]'),
};

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

// ---- shareable digital sheets (right sidebar) ------------------------------
const shareUrlOf = (token: string, siteName: string): string =>
  typeof window === 'undefined'
    ? `/share/${token}`
    : `${window.location.origin}/share/${token}?site=${encodeURIComponent(siteName)}`;

const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const monthLabel = (monthKey: string): string => {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

/** Parse a cell value → { kind, hours }. kind: 'absent' | 'hours' | 'text' | 'clear' | 'invalid'
 *  ONLY "A" is absent. Numbers 0–24 are hours. ANY other free text is a
 *  day marker — saved, displayed, never absent (present with no hours). */
function parseCell(raw: string): { kind: 'absent' | 'hours' | 'text' | 'clear' | 'invalid'; hours: number | null } {
  const v = raw.trim();
  if (v === '') return { kind: 'clear', hours: null };
  if (v.toLowerCase() === 'a') return { kind: 'absent', hours: null };
  const n = Number(v);
  if (!Number.isNaN(n) && Number.isFinite(n) && n >= 0 && n <= 24) {
    return { kind: 'hours', hours: Math.round(n * 100) / 100 };
  }
  if (v.length <= 40) return { kind: 'text', hours: null };
  return { kind: 'invalid', hours: null };
}

// ---------------------------------------------------------------------------
// One site section type (header band + that site's crew table)
// ---------------------------------------------------------------------------
interface SiteSection {
  key: string;
  title: string;
  client: string | null;
  /** attendance markers responsible for this site — the named marker plus any
   *  assigned admin accounts, joined with " · " (null = none assigned) */
  supervisor: string | null;
  emps: EmployeeVM[];
  isIdle?: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function AttendancePage() {
  const realtimeVersion = useRealtimeVersion(['attendance', 'employee', 'site', 'camp', 'admin_site', 'site_transfer', 'profiles', 'attendance_share_link']);
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';

  const now = new Date();
  const [monthKey, setMonthKey] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [view, setView] = useState<'sheet' | 'calendar'>('sheet');

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [transfers, setTransfers] = useState<SiteTransfer[] | null>(null);
  const [records, setRecords] = useState<Attendance[] | null>(null);
  // admin accounts assigned to mark specific sites (Admins → Site Access) —
  // merged with each site's named marker for "View by Supervisors"
  const [adminAssignments, setAdminAssignments] = useState<AdminSiteAssignment[] | null>(null);
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

  // "View by Supervisors" popover state
  const [supOpen, setSupOpen] = useState(false);
  const [expandedSupervisor, setExpandedSupervisor] = useState<string | null>(null);

  // shareable digital sheets — one-time links per site (right sidebar)
  const [shareLinks, setShareLinks] = useState<AttendanceShareLink[] | null>(null);
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [shareBusySite, setShareBusySite] = useState<string | null>(null);
  const [newLinkToken, setNewLinkToken] = useState<string | null>(null); // freshly generated → highlight
  const [grantingToken, setGrantingToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

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
        const [emps, sts, trs, asg] = await Promise.all([
          dataApi.listEmployees(), dataApi.listSites(), dataApi.listSiteTransfers(),
          // marker assignments are cosmetic for the drill-down — never block
          // the sheet if this call fails
          dataApi.listAdminSiteAssignments().catch(() => [] as AdminSiteAssignment[]),
        ]);
        if (!cancelled) {
          setEmployees(emps); setSites(sts); setTransfers(trs); setAdminAssignments(asg);
        }
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

  // ---- shareable links (right sidebar) ----------------------------------------
  // loaded on mount + whenever the realtime version bumps (a sheet submitted
  // from the field refreshes the list) + each time the sidebar opens
  useEffect(() => {
    let cancelled = false;
    dataApi.listAttendanceShareLinks()
      .then((links) => { if (!cancelled) setShareLinks(links); })
      .catch((err) => {
        // only surface errors when the user is actually looking at the list
        if (!cancelled && shareLinksOpen) {
          toast.error(err instanceof Error ? err.message : 'Failed to load links');
        }
      });
    return () => { cancelled = true; };
  }, [shareLinksOpen, realtimeVersion]);

  const createShareLink = async (section: SiteSection) => {
    if (section.isIdle || shareBusySite) return;
    setShareBusySite(section.key);
    try {
      const link = await dataApi.createAttendanceShareLink(section.key, monthKey);
      setShareLinks((prev) => [link, ...(prev ?? []).filter((l) => l.token !== link.token)]);
      setNewLinkToken(link.token);
      setShareLinksOpen(true);
      toast.success(`Link ready — ${section.title} · ${monthLabel(monthKey)}`, {
        description: 'Send it on WhatsApp — it opens the site\u2019s DAILY ATTENDANCE paper, where the supervisor signs each employee Present / Absent at the signature column. It locks once submitted (any admin can re-grant edit access).',
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create link');
    } finally {
      setShareBusySite(null);
    }
  };

  const grantShareEdit = async (link: AttendanceShareLink) => {
    setGrantingToken(link.token);
    try {
      await dataApi.grantAttendanceShareEdit(link.token);
      const links = await dataApi.listAttendanceShareLinks();
      setShareLinks(links);
      toast.success('Edit access granted', {
        description: `${link.site_name} — the link is editable again until the next submission.`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to grant edit access');
    } finally {
      setGrantingToken(null);
    }
  };

  const copyShareLink = async (link: AttendanceShareLink) => {
    try {
      await navigator.clipboard.writeText(shareUrlOf(link.token, link.site_name));
      setCopiedToken(link.token);
      setTimeout(() => setCopiedToken((t) => (t === link.token ? null : t)), 1600);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy — copy it from the address-style text instead');
    }
  };

  const sendShareLinkOnWhatsApp = (link: AttendanceShareLink) => {
    const url = shareUrlOf(link.token, link.site_name);
    const text = [
      'PULSE — Daily Attendance Paper',
      `${link.site_name} · ${monthLabel(link.month_key)}`,
      '',
      'Please sign every employee at the SIGNATURE column (Present / Absent) and submit the form:',
      url,
    ].join('\n');
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  };

  // ---- date-effective site timelines for the viewed month ---------------------
  // ONE shared engine (src/lib/site-timeline.ts — mirrored by the
  // emp_site_on_date() SQL function) decides which site an employee belonged
  // to on every day, so the marking sheet, Bulk Day Entry, demo permissions
  // and the Supabase RPCs can never disagree. Every recorded move splits the
  // month into segments; a day already marked at the OLD site before the move
  // was recorded keeps its old-site assignment — the move displays from the
  // next unmarked day (marked on the 25th + moved on the 25th at 8 PM → the
  // sheet shows the move from the 26th only). Months before the move → the
  // old site as a normal row; months after → the new site.
  const recordsByEmployee = useMemo(() => indexRecords(records ?? []), [records]);
  const timelines = useMemo(() => {
    const base: Omit<SiteTimelineInput, 'currentSiteId'> = {
      transfers: transfers ?? [],
      records: recordsByEmployee,
    };
    const map = new Map<string, MonthTimeline>();
    for (const emp of employees ?? []) {
      map.set(emp.id, buildMonthTimeline(emp.id, year, month, {
        ...base,
        currentSiteId: emp.current_site_id,
      }));
    }
    return map;
  }, [employees, transfers, recordsByEmployee, year, month]);

  // ---- scoped crew (admins → their assigned sites only; super admins → all) ---
  // Timeline-aware: a normal admin sees every employee who spent ANY day of the
  // viewed month at one of their sites — an employee moved mid-month stays
  // visible (and markable) at the old site for the days before the move even
  // though their current site is elsewhere now, and appears at the destination
  // immediately after the move.
  const scoped = useMemo(() => {
    const list = (employees ?? []).filter((e) => e.status !== 'deleted');
    if (assignedSiteIds === null) return list;
    return list.filter((e) => {
      const tl = timelines.get(e.id);
      if (!tl) {
        return e.current_site_id !== null && assignedSiteIds.has(e.current_site_id);
      }
      return tl.segments.some((sg) => sg.siteId !== null && assignedSiteIds.has(sg.siteId));
    });
  }, [employees, assignedSiteIds, timelines]);

  // sites selectable in the filter (admins: only their assigned sites)
  const selectableSites = useMemo(() => {
    const active = (sites ?? []).filter((s) => s.is_active);
    if (assignedSiteIds === null) return active;
    return active.filter((s) => assignedSiteIds.has(s.id));
  }, [sites, assignedSiteIds]);

  // ---- supervisors (attendance markers) — powers "View by Supervisors" ------
  // TWO sources are merged, deduped by name (case-insensitive):
  //   1. the site's named marker (Sites → site form → Supervisor text field)
  //   2. every admin account assigned to the site (Admins → Site Access) —
  //      assigning sites to supervisors there is the main workflow
  // → site id → ordered marker names (named marker first, then admins).
  const siteSupervisors = useMemo(() => {
    const map = new Map<string, string[]>();
    const seen = new Set<string>(); // "siteId|lowercase name" — dedupe
    const add = (siteId: string, name: string): void => {
      const raw = name.trim();
      if (!raw) return;
      const key = `${siteId}|${raw.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const names = map.get(siteId) ?? [];
      names.push(raw);
      map.set(siteId, names);
    };
    (sites ?? []).forEach((s) => add(s.id, s.supervisor ?? ''));
    (adminAssignments ?? []).forEach((a) => add(a.siteId, a.profileName));
    return map;
  }, [sites, adminAssignments]);

  // ---- sitewise sections --------------------------------------------------------
  // Alphabetical inside each section; employees moved mid-month get a row at
  // the BOTTOM of EVERY site they spent days at this month (faded), so their
  // marking cells stay reachable under both the old and the new site.
  const sections = useMemo<SiteSection[]>(() => {
    const q = debouncedSearch.toLowerCase().trim();
    // (search covers the trade too — the attendance table shows the employee's
    //  TRADE, falling back to the position when no trade is assigned)
    const matches = (e: EmployeeVM) =>
      !q || `${e.full_name} ${e.employee_code} ${e.trade_name ?? ''} ${e.position ?? ''} ${e.nationality ?? ''}`.toLowerCase().includes(q);
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
        supervisor: (siteSupervisors.get(s.id) ?? []).join(' · ') || null,
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
          supervisor: null,
          emps: idle,
          isIdle: true,
        });
      }
    }
    return result;
  }, [sites, scoped, siteFilter, debouncedSearch, isSuperAdmin, timelines, assignedSiteIds, siteSupervisors]);

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

  // groups the visible sites by marker so a super admin can see at a glance
  // who is tracking which site (admins only ever see their own assigned sites
  // here — selectableSites is already scope-limited)
  const supervisorGroups = useMemo(() => {
    const map = new Map<string, { key: string; name: string; sites: SiteWithCount[] }>();
    for (const s of selectableSites) {
      for (const name of siteSupervisors.get(s.id) ?? []) {
        const key = name.toLowerCase();
        const g = map.get(key);
        if (g) g.sites.push(s);
        else map.set(key, { key, name, sites: [s] });
      }
    }
    const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    const unassigned = selectableSites.filter((s) => (siteSupervisors.get(s.id) ?? []).length === 0);
    return { list, unassigned };
  }, [selectableSites, siteSupervisors]);

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
    if (r.note) return r.note; // free-text marker — shown as typed
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
      toast.error('Invalid value', { description: 'Enter hours (0–24, e.g. 8 or 10.5), A for absent, or any short free-text marker (max 40 characters). Only A counts as absent.' });
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
          note: parsed.kind === 'text' ? raw.trim() : null,
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

  // crew in the current bulk scope — the SAME shared date-effective engine as
  // the sheet decides each employee's site on the picked day (and the marking
  // RPCs enforce the identical rule on save): a mid-month move means the
  // employee is bulk-markable at their old site for the days before the move
  // and at the new site afterwards. Normal admins only ever get employees
  // sitting inside their assigned sites on that day (idle → super admins only).
  const bulkCrew = useMemo(() => {
    const siteOnDay = (e: EmployeeVM): string | null =>
      getEmployeeSiteForDate(e.id, bulkDate, {
        transfers: transfers ?? [],
        records: recordsByEmployee,
        currentSiteId: e.current_site_id,
      });
    const arr = scoped.filter((e) => {
      if (bulkSite === 'all') {
        if (assignedSiteIds === null) return true; // super admin → everyone
        const s = siteOnDay(e);
        return s !== null && assignedSiteIds.has(s);
      }
      const want = bulkSite === 'idle' ? null : bulkSite;
      return siteOnDay(e) === want;
    });
    return [...arr].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [scoped, bulkSite, bulkDate, transfers, recordsByEmployee, assignedSiteIds]);

  // prefill whenever the dialog opens, the date changes or fresh records arrive
  useEffect(() => {
    if (!bulkOpen) return;
    const def = defaultHoursText();
    const vals: Record<string, string> = {};
    const inc: Record<string, boolean> = {};
    bulkCrew.forEach((e) => {
      const existing = recordToText(recordMap.get(`${e.id}|${bulkDate}`));
      vals[e.id] = existing !== '' ? existing : def;
      inc[e.id] = true;
    });
    setBulkValues(vals);
    setBulkInclude(inc);
  }, [bulkOpen, bulkDate, recordMap, bulkCrew]);

  // live stats for the footer chips
  const bulkStats = useMemo(() => {
    let selected = 0, present = 0, absent = 0, text = 0, changes = 0, invalid = 0;
    for (const emp of bulkCrew) {
      if (!bulkInclude[emp.id]) continue;
      selected += 1;
      const raw = (bulkValues[emp.id] ?? '').trim();
      const parsed = parseCell(raw);
      if (parsed.kind === 'invalid') invalid += 1;
      if (parsed.kind === 'hours') present += 1;
      if (parsed.kind === 'absent') absent += 1;
      if (parsed.kind === 'text') text += 1;
      const existing = recordToText(recordMap.get(`${emp.id}|${bulkDate}`));
      if (raw !== existing) changes += 1;
    }
    return { selected, present, absent, text, changes, invalid };
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
    const t = todayYMD();
    setBulkDate(t);
    setBulkSite(siteId);
    // keep the sheet on the day being bulk-filled so the picked month's
    // records (and the date-effective engine's pre-marked-day walk) are live
    const mk = t.slice(0, 7);
    if (mk !== monthKey) setMonthKey(mk);
    setBulkOpen(true);
  };

  const saveBulkDay = async () => {
    for (const emp of bulkCrew) {
      if (!bulkInclude[emp.id]) continue;
      const raw = (bulkValues[emp.id] ?? '').trim();
      if (parseCell(raw).kind === 'invalid') {
        toast.error(`Invalid value for ${emp.full_name}`, { description: 'Enter hours (0–24, e.g. 8 or 10.5), A for absent, or any short free-text marker (max 40 characters). Only A counts as absent.' });
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
            ? { ...list[idx], status: parsed.kind === 'absent' ? 'absent' : 'present', hours: parsed.hours, note: parsed.kind === 'text' ? (entry.value ?? '').trim() : null }
            : {
                id: `local-${entry.employee_id}-${entry.date}`, employee_id: entry.employee_id,
                date: entry.date, status: parsed.kind === 'absent' ? 'absent' : 'present',
                hours: parsed.hours, note: parsed.kind === 'text' ? (entry.value ?? '').trim() : null,
                is_hidden: false, created_at: new Date().toISOString(),
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

  // share links grouped DATE-WISE (newest date first, newest link first
  // inside each group) — the structure of the right sidebar
  const linkGroups = useMemo(() => {
    const todayStr = todayYMD();
    const yestStr = yesterdayYMD();
    const groups: { key: string; label: string; links: AttendanceShareLink[] }[] = [];
    const byKey = new Map<string, { key: string; label: string; links: AttendanceShareLink[] }>();
    const sorted = [...(shareLinks ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const l of sorted) {
      const day = l.created_at.slice(0, 10);
      let g = byKey.get(day);
      if (!g) {
        const label = day === todayStr
          ? 'Today'
          : day === yestStr
            ? 'Yesterday'
            : new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
              });
        g = { key: day, label, links: [] };
        byKey.set(day, g);
        groups.push(g);
      }
      g.links.push(l);
    }
    return groups;
  }, [shareLinks]);

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
    const parsed = parseCell(value);
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
              data-day-col={date.slice(8)}
              onChange={(e) => setCell(emp.id, date, e.target.value)}
              onBlur={() => commitCell(emp.id, date)}
              onKeyDown={(e) => gridCellKeyDown(e, DAY_CELL_NAV)}
              aria-label={`${emp.full_name} — ${date}`}
              className={cn(
                'h-8 w-full bg-transparent text-center text-[11px] font-medium tabular-nums outline-none transition-colors',
                'hover:bg-brand/10 focus:bg-brand/15 focus:ring-1 focus:ring-brand/60 focus:ring-inset',
                isA && 'bg-rose-500/10 font-bold text-rose-500',
                parsed.kind === 'text' && 'bg-brand/[0.08] font-semibold text-brand',
                parsed.kind === 'hours' && 'text-foreground',
                value !== '' && parsed.kind !== 'hours' && parsed.kind !== 'text' && 'text-foreground',
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
            {section.supervisor && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-sky-600 dark:text-sky-400"
                title={`Attendance for ${section.title} is marked by ${section.supervisor} — change the named marker in Sites → Edit Site, or the assigned admins in Admin Management → Site Access`}
              >
                <UserCheck size={11} />
                <span className="max-w-56 truncate">Supervised by: {section.supervisor}</span>
              </span>
            )}
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
              disabled={shareBusySite === section.key}
              onClick={() => createShareLink(section)}
              title={`Generate a shareable DAILY ATTENDANCE paper for ${section.title} — ${MONTH_NAMES[month - 1]} ${year}. Send it on WhatsApp — the supervisor signs each employee at the signature column; it locks after submitting.`}
            >
              {shareBusySite === section.key
                ? <Loader2 size={12} className="animate-spin" />
                : <Send size={12} />}
              Send Link
            </Button>
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
                      {/* trade — its own dedicated column (pins left from lg up);
                          shows the employee's TRADE (kept in sync with the
                          Salary Sheet / Payroll trade dropdowns), falling back
                          to the position when no trade is assigned */}
                      <td className="lg:sticky lg:left-[150px] z-10 border-x border-b border-foreground/15 bg-card px-2 py-1.5">
                        <span
                          className={cn('block truncate text-[11px] font-medium text-foreground/80', moved && 'opacity-60')}
                          title={emp.trade_name ?? emp.position ?? undefined}
                        >
                          {emp.trade_name ?? emp.position ?? '—'}
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
            {section.emps.length} employee{section.emps.length !== 1 ? 's' : ''} · alphabetical — every past cell is editable (hours e.g. 8, 10.5 or <span className="font-semibold text-rose-500">A</span>); future dates stay blank & locked · <span className="font-medium text-foreground">arrow keys / Enter move between cells</span>
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
            Sitewise Excel-style marking — type custom hours per day, <span className="font-semibold text-rose-500">A</span> for absent, or any free-text marker (only <span className="font-semibold text-rose-500">A</span> counts as absent).
            Bulk-fill a whole day in one go via <span className="font-semibold text-foreground">Bulk Day</span> (defaults to 10h).
            <span className="font-semibold text-foreground"> Send Link</span> shares the site's DAILY ATTENDANCE paper on WhatsApp — the supervisor signs each employee Present / Absent at the signature column (no login) and the link locks once submitted. Marks land in this same sheet instantly.
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
            {/* View by Supervisors — who marks which site (drill-down:
                supervisor → their sites → click a site to show only it) */}
            <Popover
              open={supOpen}
              onOpenChange={(o) => {
                setSupOpen(o);
                if (!o) setExpandedSupervisor(null);
              }}
            >
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-10 gap-1.5" disabled={loading}>
                  <Users size={15} />
                  View by Supervisors
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-0">
                <div className="border-b px-3 py-2.5">
                  <p className="text-sm font-semibold">Attendance markers</p>
                  <p className="text-[11px] leading-tight text-muted-foreground">
                    Who marks which site — named markers (Sites form) and assigned admins (Admins → Site Access). Click a supervisor to see their sites, then a site to show it.
                  </p>
                </div>
                <div className="max-h-80 overflow-y-auto p-1.5">
                  {supervisorGroups.list.length === 0 && supervisorGroups.unassigned.length === 0 ? (
                    <p className="px-2.5 py-8 text-center text-xs text-muted-foreground">
                      No sites available yet.
                    </p>
                  ) : (
                    <>
                      {supervisorGroups.list.map((g) => {
                        const open = expandedSupervisor === g.key;
                        const crew = g.sites.reduce((n, s) => n + s.employee_count, 0);
                        return (
                          <div key={g.key} className="mb-1 overflow-hidden rounded-lg border bg-card">
                            <button
                              type="button"
                              onClick={() => setExpandedSupervisor(open ? null : g.key)}
                              aria-expanded={open}
                              className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-brand/[0.06]"
                            >
                              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                                {initials(g.name)}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium leading-tight">{g.name}</span>
                                <span className="block text-[10px] leading-tight text-muted-foreground">
                                  {g.sites.length} site{g.sites.length !== 1 ? 's' : ''} · {crew} employee{crew !== 1 ? 's' : ''}
                                </span>
                              </span>
                              <ChevronRight
                                size={14}
                                className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
                              />
                            </button>
                            {open && (
                              <div className="border-t bg-muted/30 p-1.5">
                                {g.sites.map((s) => (
                                  <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => {
                                      setSiteFilter(s.id);
                                      setSearch('');
                                      setSupOpen(false);
                                    }}
                                    className={cn(
                                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-brand/10',
                                      siteFilter === s.id && 'bg-brand/10 font-semibold text-brand',
                                    )}
                                    title={`Show only ${s.name} in the sheet`}
                                  >
                                    <Building2 size={12} className="shrink-0 text-muted-foreground" />
                                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                      {s.employee_count}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {supervisorGroups.unassigned.length > 0 && (
                        <div className="mb-1 overflow-hidden rounded-lg border border-dashed bg-card">
                          <button
                            type="button"
                            onClick={() => setExpandedSupervisor(expandedSupervisor === '__none__' ? null : '__none__')}
                            aria-expanded={expandedSupervisor === '__none__'}
                            className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-brand/[0.06]"
                          >
                            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                              <UserX size={13} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium leading-tight text-muted-foreground">
                                No supervisor assigned
                              </span>
                              <span className="block text-[10px] leading-tight text-muted-foreground">
                                {supervisorGroups.unassigned.length} site{supervisorGroups.unassigned.length !== 1 ? 's' : ''}
                              </span>
                            </span>
                            <ChevronRight
                              size={14}
                              className={cn(
                                'shrink-0 text-muted-foreground transition-transform',
                                expandedSupervisor === '__none__' && 'rotate-90',
                              )}
                            />
                          </button>
                          {expandedSupervisor === '__none__' && (
                            <div className="border-t bg-muted/30 p-1.5">
                              {supervisorGroups.unassigned.map((s) => (
                                <button
                                  key={s.id}
                                  type="button"
                                  onClick={() => {
                                    setSiteFilter(s.id);
                                    setSearch('');
                                    setSupOpen(false);
                                  }}
                                  className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-brand/10',
                                    siteFilter === s.id && 'bg-brand/10 font-semibold text-brand',
                                  )}
                                  title={`Show only ${s.name} in the sheet`}
                                >
                                  <Building2 size={12} className="shrink-0 text-muted-foreground" />
                                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                    {s.employee_count}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              className="h-10 gap-1.5"
              disabled={loading}
              onClick={() => setShareLinksOpen(true)}
              title="Every shared attendance paper link, stored date-wise — send on WhatsApp, copy, or re-grant edit access after a submission"
            >
              <Link2 size={15} />
              Links
              {(shareLinks ?? []).length > 0 && (
                <span className="rounded-full bg-brand/15 px-1.5 text-[10px] font-bold tabular-nums text-brand">
                  {shareLinks!.length}
                </span>
              )}
            </Button>
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
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand/15 ring-1 ring-brand/40" />Free text = marker (not absent)</span>
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
              sub={`${calendarEmployee.employee_code} · ${calendarEmployee.trade_name ?? calendarEmployee.position ?? 'No trade'}${calendarEmployee.site_name ? ' · ' + calendarEmployee.site_name : ' · Idle'}`}
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
                        ) : parsed.kind === 'text' ? (
                          <span className="max-w-full truncate px-1 text-[11px] font-semibold text-brand" title={value}>{value}</span>
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
                        placeholder="Hours, A or free text"
                        onChange={(e) => setCell(calendarEmployee.id, date, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onBlur={() => commitCell(calendarEmployee.id, date)}
                        className="h-9 text-center font-semibold tabular-nums"
                      />
                      <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                        Only <b className="text-rose-500">A</b> counts as absent — any other free text is saved as a day marker.
                      </p>
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
                const isText = parsed.kind === 'text';
                const existing = recordToText(recordMap.get(`${emp.id}|${bulkDate}`));
                const changed = raw.trim() !== existing;
                const included = bulkInclude[emp.id] ?? false;
                return (
                  <div
                    key={emp.id}
                    data-bulk-row=""
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
                        {emp.employee_code} · {emp.trade_name ?? emp.position ?? 'No trade'}
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
                      data-bulk-value=""
                      onChange={(e) => setBulkValues((v) => ({ ...v, [emp.id]: e.target.value }))}
                      onKeyDown={(e) => gridCellKeyDown(e, BULK_VALUE_NAV)}
                      aria-label={`Hours for ${emp.full_name} on ${bulkDate}`}
                      className={cn(
                        'h-9 w-20 shrink-0 text-center text-xs font-semibold tabular-nums',
                        isA && 'bg-rose-500/10 text-rose-500',
                        isText && 'bg-brand/10 text-brand',
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
              {bulkStats.text > 0 && (
                <span className="rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 font-semibold tabular-nums text-brand">
                  {bulkStats.text} text marker{bulkStats.text !== 1 ? 's' : ''}
                </span>
              )}
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

      {/* ============================ SHARE LINKS SIDEBAR (date-wise) ============================ */}
      <AnimatePresence>
        {shareLinksOpen && (
          <>
            <motion.div
              key="share-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]"
              onClick={() => setShareLinksOpen(false)}
              aria-hidden
            />
            <motion.aside
              key="share-sidebar"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.32, ease: EASE }}
              className="fixed inset-y-0 right-0 z-50 flex w-[min(94vw,390px)] flex-col border-l bg-card shadow-2xl"
              role="dialog"
              aria-label="Shared attendance sheet links"
            >
              {/* header */}
              <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                  <Send size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold leading-tight">Shared Paper Links</h3>
                  <p className="text-[11px] leading-tight text-muted-foreground">
                    One-time daily attendance papers, stored date-wise
                  </p>
                </div>
                <Button
                  variant="ghost" size="icon" className="size-8 shrink-0"
                  onClick={() => setShareLinksOpen(false)} aria-label="Close links sidebar"
                >
                  <X size={16} />
                </Button>
              </div>

              {/* body: date groups */}
              <div className="flex-1 overflow-y-auto p-3">
                {shareLinks === null ? (
                  <div className="space-y-2 p-1">
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-20 rounded-xl" />
                  </div>
                ) : linkGroups.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                    <span className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                      <Link2 size={20} />
                    </span>
                    <p className="text-sm font-medium">No links yet</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Click <span className="font-semibold text-foreground">Send Link</span> on any site section above —
                      the link opens that site's DAILY ATTENDANCE paper (signature-column marking), ready to send on WhatsApp.
                    </p>
                  </div>
                ) : (
                  linkGroups.map((g) => (
                    <div key={g.key} className="mb-4">
                      <p className="mb-1.5 flex items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {g.label}
                        <span className="rounded-full bg-muted px-1.5 py-0.5 tabular-nums">
                          {g.links.length}
                        </span>
                      </p>
                      <div className="space-y-2">
                        {g.links.map((l) => {
                          const isNew = l.token === newLinkToken;
                          const submitted = l.status === 'submitted';
                          return (
                            <motion.div
                              key={l.id}
                              initial={isNew ? { opacity: 0, y: -8, scale: 0.98 } : false}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              className={cn(
                                'rounded-xl border bg-card p-3',
                                isNew && 'border-brand/50 ring-2 ring-brand/25',
                              )}
                            >
                              {/* site + status */}
                              <div className="flex items-start gap-2">
                                <span className={cn(
                                  'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
                                  submitted ? 'bg-emerald-500/10 text-emerald-500' : 'bg-brand/10 text-brand',
                                )}>
                                  {submitted ? <Lock size={13} /> : <Building2 size={13} />}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-[13px] font-semibold leading-tight">{l.site_name}</p>
                                  <p className="text-[11px] leading-tight text-muted-foreground">
                                    {monthLabel(l.month_key)} · {fmtTime(l.created_at)}
                                    {l.created_by_name ? ` · by ${l.created_by_name}` : ''}
                                  </p>
                                </div>
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                                    submitted
                                      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                      : 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                                  )}
                                >
                                  {submitted ? 'Submitted' : 'Editable'}
                                </span>
                              </div>

                              {/* saved stamp (submitted links) */}
                              {submitted && l.submitted_at && (
                                <p className="mt-1.5 rounded-md bg-muted/60 px-2 py-1 text-[10.5px] leading-snug text-muted-foreground">
                                  Saved on <span className="font-semibold text-foreground">{fmtDateTime(l.submitted_at)}</span>
                                  {l.submit_count > 1 ? ` · submission #${l.submit_count}` : ''}
                                </p>
                              )}

                              {/* url (fresh links show it in full) */}
                              <p
                                className={cn(
                                  'mt-1.5 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground',
                                  isNew && 'text-foreground',
                                )}
                                title={shareUrlOf(l.token, l.site_name)}
                              >
                                {shareUrlOf(l.token, l.site_name)}
                              </p>

                              {/* actions */}
                              <div className="mt-2 flex items-center gap-1.5">
                                <Button
                                  size="sm"
                                  className="h-7 flex-1 gap-1 bg-[#25D366] px-2 text-[11px] font-semibold text-white hover:bg-[#1ebe57] hover:text-white"
                                  onClick={() => sendShareLinkOnWhatsApp(l)}
                                  title="Send the link + instructions on WhatsApp"
                                >
                                  <MessageCircle size={12} />
                                  WhatsApp
                                </Button>
                                <Button
                                  variant="outline" size="sm"
                                  className="h-7 gap-1 px-2 text-[11px]"
                                  onClick={() => copyShareLink(l)}
                                  title="Copy the link"
                                >
                                  {copiedToken === l.token ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                                  {copiedToken === l.token ? 'Copied' : 'Copy'}
                                </Button>
                                <Button
                                  variant="outline" size="sm"
                                  className="h-7 gap-1 px-2 text-[11px]"
                                  onClick={() => window.open(shareUrlOf(l.token, l.site_name), '_blank', 'noopener,noreferrer')}
                                  title={submitted ? 'Open the saved paper' : 'Open the daily attendance paper'}
                                >
                                  <ExternalLink size={12} />
                                  Open
                                </Button>
                                {submitted && (
                                  <Button
                                    variant="outline" size="sm"
                                    className="h-7 gap-1 px-2 text-[11px] font-semibold text-brand hover:bg-brand/10 hover:text-brand"
                                    disabled={grantingToken === l.token}
                                    onClick={() => grantShareEdit(l)}
                                    title="Let the supervisor edit this sheet again through the same link"
                                  >
                                    {grantingToken === l.token
                                      ? <Loader2 size={12} className="animate-spin" />
                                      : <Unlock size={12} />}
                                    Edit Access
                                  </Button>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* footer hint */}
              <div className="border-t bg-muted/40 px-4 py-3 text-[10.5px] leading-relaxed text-muted-foreground">
                One-time use: a link stays editable until its sheet is submitted — then it shows the
                saved sheet only. Need changes? Grant <span className="font-semibold text-foreground">Edit Access</span> and
                the same link opens editable again.
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
