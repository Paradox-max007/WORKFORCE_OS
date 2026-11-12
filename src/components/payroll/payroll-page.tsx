'use client';

// ============================================================================
// PULSE Workforce OS — Payroll (consolidated payment view)
// ----------------------------------------------------------------------------
// Payroll NEVER calculates salaries. It renders the SAME get_salary_sheet
// calculation data the Salary Sheet uses (one shared engine, one source of
// truth) — one row per employee with hours and salary combined across ALL
// sites:
//
//   • every employee appears EXACTLY ONCE (multi-site hours consolidated)
//   • ADVANCE and DEDUCTION are always-visible table columns (no separate
//     edit button); in EDIT MODE they become inline inputs with immediate
//     save, and the TRADE column becomes a dropdown — picking a trade
//     overwrites the stored trade + assignment history and re-prices the
//     month, so every linked page (Salary Sheet, Employee Details,
//     Attendance page, Attendance PDF, …) updates together
//   • MARK PAID is active whenever the employee HAS a salary this month
//     (no finalized-period requirement); marking paid turns the employee's
//     rows green in every Salary Sheet section
//   • cards at the top: Paid salary (Σ net of paid) and Balance to pay
//     (Σ net of unpaid)
//   • SEARCH (name / employee ID / trade) plus FILTERS in the sticky bar —
//     the SAME set as the Employees page: region, country (cascading), camp,
//     trade, status (employee status + paid/unpaid) and PAYMENT METHOD
//     (cash / Lulu Cards / C3 Cards / any other card type in the DB / not
//     set). They narrow the table; the top cards stay period totals.
//     On screens < lg the six dropdowns collapse behind a FILTERS icon
//     (bottom sheet) so the sticky bar stays one compact row and never
//     covers the table on phones
//   • a STICKY-NOTE ICON next to every employee name opens a quick-notes
//     popover — notepad-style comments stored on the EMPLOYEE (not the
//     period) for quick future reference; the icon lights up amber and
//     shows the count when notes exist
//   • PAYMENT METHOD column right after Trade: “Cash”, or the CARD TYPE
//     only when the employee is paid by card (set on the Employee Details
//     page → Document Details)
//   • the AUDIT TRAIL is collapsed behind an expandable icon button; opening
//     it lists every audit entry, written with employee names & codes
//   • reverting a payment is super-admin only and audited with a reason
//   • EXCEL button (top bar) opens the export PREVIEW page with the CURRENTLY
//     FILTERED rows — there the columns can be toggled (all on by default)
//     before downloading the .xlsx (lib/export-payroll-xlsx.ts)
//   • column order: AMOUNT comes BEFORE ADVANCE (page table AND the Excel)
//   • ABSENT DEDUCTION — the first N absences of the month are free, every
//     absence after those costs AED X (N and X CONFIGURABLE in Trade/Ded
//     Management → Deductions); it is computed when the payroll is
//     generated (separate from the manual deduction) and shows inside the
//     Deduction column (red “A” chip). In EDIT MODE it is EDITABLE like a
//     normal deduction value: the amount typed here is stored as the ACTUAL
//     deduction (flagged) and has PRIORITY — regeneration keeps it instead
//     of recomputing the rule; the ↺ button returns it to the rule. The same
//     value flows into the Salary Sheet, the attendance record and the
//     Excel export. Clicking a deduction value opens the dedicated
//     ATTENDANCE CALENDAR page — one calendar per site, with the
//     employee name, code and total hours on top
//   • shares the selected month with the Salary Sheet (app store)
//   • BRANCH-WISE SEPARATION — a Branch dropdown in the top row (shared with
//     the Salary Sheet): picking a branch loads only THAT branch's payroll —
//     the rows, the top cards and the Excel export all follow the selection.
//     "No branch" = sites without an owner branch. Normal admins only ever
//     see their granted branches (+ directly assigned sites) — for them
//     "All branches" means their own allowance.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck, Banknote, CalendarDays, Check, ChevronDown, ChevronUp, Clock, CreditCard, Eye,
  FileSpreadsheet, GitBranch, History, ListFilter, Loader2, Lock, LockOpen, Pencil, PencilLine,
  RotateCcw, Scale, Search, StickyNote, Trash2, TriangleAlert, UserX, Users, Wallet, X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, SectionTitle } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  HoverCard, HoverCardContent, HoverCardTrigger,
} from '@/components/ui/hover-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { FinalizeDialog, ReopenDialog } from '@/components/salary-sheet/period-dialogs';
import { dataApi } from '@/lib/data';
import { payrollExportFileName } from '@/lib/export-payroll-xlsx';
import { fmtDate, fmtDateTime, fmtTimeAgo, initials } from '@/lib/format';
import { NATIONALITY_REGIONS, countriesByRegion } from '@/lib/nationality-groups';
import { cn } from '@/lib/utils';
import {
  type CardType, DEFAULT_DEDUCTION_SETTINGS, type DeductionSettings,
  type EmployeeNote, type PayrollEmployeeVM,
  type SalarySheetReport, type SiteWithCount, type Trade,
  type BranchWithCount,
} from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtMoney = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtHrs = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const round2 = (n: number): number => Math.round(n * 100) / 100;

const selectableYears = (): number[] => {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y];
};

/** sentinel for "no trade" in the edit-mode dropdown (Radix needs non-empty values) */
const NO_TRADE = '__none__';

const ROLE_LABEL: Record<string, string> = {
  standard: 'Standard', team_leader: 'Team Leader', supervisor: 'Supervisor',
};
const TIER_LABEL: Record<string, string> = {
  below_threshold: 'Below 1000 h / 6 months', qualified: 'Qualified', manual: 'Manual',
};

/** display names of the STATUS filter values (export chips + filter bar) */
const STATUS_LABELS: Record<string, string> = {
  paid: 'Paid', unpaid: 'Unpaid', active: 'Active', working: 'Working',
  idle: 'Idle', pending_deletion: 'Pending Deletion',
};

/** sentinel filter values */
const FILTER_ALL = 'all';
const FILTER_NONE = '__none__';

const lastDayOf = (year: number, month: number): string => {
  const d = new Date(year, month, 0); // month is 1-based; day 0 = last day of previous
  return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Qualification derivation (display only — the tier split itself was already
// computed chronologically by the calculation engine)
// ---------------------------------------------------------------------------
interface Qualification {
  qualified: boolean;
  date: string | null;
  reason: 'opening_balance' | 'thousand_hours' | 'six_months' | null;
}

const qualificationOf = (e: PayrollEmployeeVM, year: number, month: number): Qualification => {
  const monthEnd = lastDayOf(year, month);
  if (e.opening_lifetime_hours >= 1000) {
    return { qualified: true, date: e.join_date, reason: 'opening_balance' };
  }
  const candidates: { date: string; reason: Qualification['reason'] }[] = [];
  if (e.six_month_date) candidates.push({ date: e.six_month_date, reason: 'six_months' });
  if (e.threshold_date) candidates.push({ date: e.threshold_date, reason: 'thousand_hours' });
  candidates.sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = candidates[0];
  if (!first) return { qualified: false, date: null, reason: null };
  return { qualified: first.date <= monthEnd, date: first.date, reason: first.reason };
};

// ---------------------------------------------------------------------------
// The complete calculation breakdown panel (hover tooltip AND mobile dialog
// render this same component). All values come from the Salary Sheet records.
// ---------------------------------------------------------------------------
function CalculationPanel({ e, year, month }: {
  e: PayrollEmployeeVM; year: number; month: number;
}) {
  const qual = qualificationOf(e, year, month);

  // site distribution (idle / unassigned row when site_id is null)
  const siteRows = e.sites.map((s) => ({
    name: s.site_id == null ? 'Idle / unassigned' : s.site_name,
    hours: s.total_hours, below: s.below_threshold_hours, qualified: s.qualified_hours,
  }));
  if (siteRows.length === 0 && e.total_hours > 0) {
    siteRows.push({ name: 'Idle / unassigned', hours: e.total_hours, below: 0, qualified: 0 });
  }

  // salary lines grouped by site | role | tier | rate with their date span —
  // multiple groups = trade / role / rate changes during the month
  const groups: {
    key: string; site: string; role: string; tier: string; rate: number;
    hours: number; gross: number; from: string; to: string;
  }[] = [];
  e.sites.flatMap((s) => s.lines).forEach((l) => {
    const site = l.site_id == null ? 'Idle / unassigned' : l.site_name;
    const key = `${site}|${l.salary_role}|${l.experience_tier}|${l.hourly_rate}`;
    const g = groups.find((x) => x.key === key);
    if (g) {
      g.hours += l.hours; g.gross += l.gross_amount;
      if (l.date < g.from) g.from = l.date;
      if (l.date > g.to) g.to = l.date;
    } else {
      groups.push({
        key, site, role: l.salary_role, tier: l.experience_tier, rate: l.hourly_rate,
        hours: l.hours, gross: l.gross_amount, from: l.date, to: l.date,
      });
    }
  });
  groups.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const lineSum = round2(groups.reduce((n, g) => n + g.gross, 0));
  const reconciles = Math.abs(lineSum - e.gross_salary) < 0.011;

  return (
    <div className="space-y-4 text-sm">
      {/* header + qualification */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">{e.full_name}</p>
          <p className="font-mono text-xs text-muted-foreground">{e.employee_code}</p>
        </div>
        <span className={cn(
          'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
          qual.qualified
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500'
            : 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        )}>
          {qual.qualified ? 'Qualified' : 'Below 1000 h / 6 months'}
        </span>
      </div>

      <div className="rounded-lg border bg-muted/20 p-3 text-xs leading-relaxed">
        <p className="text-muted-foreground">
          Lifetime hours before this period: <span className="font-mono font-semibold text-foreground">{fmtHrs(e.opening_lifetime_hours)} h</span>
        </p>
        <p className="mt-1 text-muted-foreground">
          {qual.reason === 'opening_balance' && <>Opening balance already ≥ 1,000 h — qualified from day one.</>}
          {qual.reason === 'thousand_hours' && qual.date && <>1,000-hour threshold reached on <span className="font-semibold text-foreground">{fmtDate(qual.date)}</span>.</>}
          {qual.reason === 'six_months' && qual.date && <>Six-month anniversary reached on <span className="font-semibold text-foreground">{fmtDate(qual.date)}</span>.</>}
          {!qual.reason && <>Not yet qualified — 1,000 h / six months not reached in this period.</>}
        </p>
        <p className="mt-1 text-muted-foreground">
          This month: <span className="font-mono text-foreground">{fmtHrs(e.below_threshold_hours)} h</span> below 1000 h / 6 months ·
          {' '}<span className="font-mono text-foreground">{fmtHrs(e.qualified_hours)} h</span> qualified
        </p>
      </div>

      {/* site distribution */}
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Site distribution — total {fmtHrs(e.total_hours)} h
        </p>
        {siteRows.length > 0 ? (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="text-right">Below 1000h/6mo</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {siteRows.map((s, i) => (
                  <TableRow key={`${s.name}-${i}`}>
                    <TableCell className="py-1.5">{s.name}</TableCell>
                    <TableCell className="py-1.5 text-right font-mono">{fmtHrs(s.hours)}</TableCell>
                    <TableCell className="py-1.5 text-right font-mono text-muted-foreground">{fmtHrs(s.below)}</TableCell>
                    <TableCell className="py-1.5 text-right font-mono text-muted-foreground">{fmtHrs(s.qualified)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="py-1.5 font-semibold">Total</TableCell>
                  <TableCell className="py-1.5 text-right font-mono font-semibold">{fmtHrs(e.total_hours)}</TableCell>
                  <TableCell className="py-1.5 text-right font-mono font-semibold">{fmtHrs(e.below_threshold_hours)}</TableCell>
                  <TableCell className="py-1.5 text-right font-mono font-semibold">{fmtHrs(e.qualified_hours)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            No hours this period — idle employee.
          </p>
        )}
      </div>

      {/* salary breakdown */}
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Salary breakdown
        </p>
        {groups.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            No rated hours this month.
            {e.unassigned_hours > 0 && ` ${fmtHrs(e.unassigned_hours)} h have no trade assigned.`}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Rate category</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.key}>
                    <TableCell className="py-1.5">
                      {g.site}
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {g.from === g.to ? fmtDate(g.from) : `${fmtDate(g.from)} – ${fmtDate(g.to)}`}
                      </p>
                    </TableCell>
                    <TableCell className="py-1.5 text-xs">
                      {ROLE_LABEL[g.role] ?? g.role} — {TIER_LABEL[g.tier] ?? g.tier}
                    </TableCell>
                    <TableCell className="py-1.5 text-right font-mono">{fmtHrs(g.hours)}</TableCell>
                    <TableCell className="py-1.5 text-right font-mono">{fmtMoney(g.rate)}</TableCell>
                    <TableCell className="py-1.5 text-right font-mono">{fmtMoney(g.gross)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {e.unrated_hours > 0 && (
        <p className="flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert size={13} /> {fmtHrs(e.unrated_hours)} h have a trade but no effective rate — configure the rate in Trade/Ded Management.
        </p>
      )}

      {/* total + reconciliation */}
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Total gross salary</span>
          <span className="flex items-center gap-1.5 font-mono text-lg font-bold text-brand">
            AED {fmtMoney(e.gross_salary)}
            {reconciles && <Check size={14} className="text-emerald-500" />}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {reconciles
            ? `Reconciled — rate lines sum to AED ${fmtMoney(lineSum)} (matches the Salary Sheet).`
            : `Rate lines sum to AED ${fmtMoney(lineSum)} — check manual edits in the Salary Sheet.`}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Total Hours cell — hover tooltip (desktop) + tap dialog (mobile/touch)
// ---------------------------------------------------------------------------
function HoursCell({ e, year, month }: { e: PayrollEmployeeVM; year: number; month: number }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <HoverCard openDelay={150} closeDelay={120}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1 font-mono text-sm underline decoration-dotted underline-offset-4 hover:text-brand"
            aria-label={`Calculation details of ${e.full_name}`}
          >
            {fmtHrs(e.total_hours)} h
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="top" align="start"
          className="w-[min(580px,88vw)] max-h-[max(240px,min(calc(100vh-460px),560px))] overflow-y-auto border-2 border-brand/60 bg-zinc-100 shadow-xl dark:bg-zinc-900"
          collisionPadding={{ top: 200, right: 16, bottom: 16, left: 16 }}
        >
          <CalculationPanel e={e} year={year} month={month} />
        </HoverCardContent>
      </HoverCard>

      {/* mobile / touch path — same panel in a dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Calculation — {e.full_name}</DialogTitle>
            <DialogDescription>
              Complete site-hour distribution &amp; salary breakdown ({MONTH_NAMES[month - 1]} {year}).
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            <CalculationPanel e={e} year={year} month={month} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline settlement input (edit mode) — advance / deduction. Saves on blur /
// Enter; Escape reverts. Values are committed immediately (audited RPC).
// ---------------------------------------------------------------------------
function AdjustInput({ value, busy, onCommit, label }: {
  value: number;
  busy: boolean;
  onCommit: (next: number) => void;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  // adopt fresh stored values unless the user is typing
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = (): void => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      toast.error(`${label} must be 0 or more`);
      setText(String(value));
      return;
    }
    const next = round2(n);
    if (next !== value) onCommit(next);
    else setText(String(value));
  };

  return (
    <Input
      type="number" min={0} step="0.01" inputMode="decimal" disabled={busy}
      className="h-8 w-24 border-border/70 bg-card text-right font-mono text-xs"
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setText(String(value)); e.currentTarget.blur(); }
      }}
      aria-label={`${label} of this employee`}
    />
  );
}

// ---------------------------------------------------------------------------
// Sticky-note quick notes — notepad-style comments stored on the EMPLOYEE
// (not the payroll period). The icon next to the name opens a popover with
// the saved notes plus a textarea to add a new one; the icon lights up amber
// and shows the count when notes exist.
// ---------------------------------------------------------------------------
function EmployeeNotesCell({ employee, notes, onChanged }: {
  employee: PayrollEmployeeVM;
  notes: EmployeeNote[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      await dataApi.addEmployeeNote(employee.employee_id, t);
      setText('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the note');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await dataApi.deleteEmployeeNote(id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the note');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Quick notes about ${employee.full_name}`}
          title={notes.length > 0
            ? `${notes.length} note${notes.length === 1 ? '' : 's'} about ${employee.full_name} — click to read / add`
            : `Add a quick note about ${employee.full_name}`}
          className={cn(
            'relative inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors',
            notes.length > 0
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
              : 'border-border/60 bg-card text-muted-foreground/70 hover:text-brand',
          )}
        >
          <StickyNote size={13} />
          {notes.length > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-4 text-white">
              {notes.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={{ top: 90, right: 16, bottom: 16, left: 16 }}
        className="w-[min(340px,88vw)] border-2 border-brand/50 p-0 shadow-lg shadow-[var(--glow)]"
      >
        <div className="border-b border-brand/20 bg-brand/10 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <StickyNote size={14} className="text-brand" /> Quick notes
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {employee.full_name} · <span className="font-mono">{employee.employee_code}</span> — stored on the employee for future reference
          </p>
        </div>

        <div className="max-h-56 overflow-y-auto px-3 py-2">
          {notes.length === 0 ? (
            <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
              No notes yet — add the first sticky note below.
            </p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="group rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-2">
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{n.note}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="truncate text-[10px] text-muted-foreground">
                      {n.author_name ?? 'System'} · {fmtTimeAgo(n.created_at)}
                    </p>
                    <button
                      type="button"
                      onClick={() => { void remove(n.id); }}
                      disabled={busyId === n.id}
                      aria-label="Delete this note"
                      title="Delete this note"
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:text-rose-500 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      {busyId === n.id
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Trash2 size={11} />}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-brand/20 p-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); }
            }}
            placeholder="e.g. Advance every 20th · card renewed…"
            rows={2}
            className="resize-none border-brand/25 bg-card text-xs focus-visible:ring-brand/40"
            aria-label={`New note about ${employee.full_name}`}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground">⌘/Ctrl + Enter to save</p>
            <Button
              size="sm"
              onClick={() => { void add(); }}
              disabled={saving || text.trim() === ''}
              className="h-8 brand-gradient px-3 text-xs font-semibold text-white"
            >
              {saving ? <Loader2 size={12} className="mr-1 animate-spin" /> : <StickyNote size={12} className="mr-1" />}
              Add note
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Payment Method cell — “Cash”, or the CARD TYPE only when paid by card
// (the type itself is set on the Employee Details → Document Details card).
// ---------------------------------------------------------------------------
function PaymentMethodCell({ e }: { e: PayrollEmployeeVM }) {
  if (e.payment_type === 'card') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand"
        title={`Paid via card — ${e.card_type ?? 'card type not set'}`}
      >
        <CreditCard size={11} /> {e.card_type ?? 'Card'}
      </span>
    );
  }
  if (e.payment_type === 'cash') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-500"
        title="Paid in cash"
      >
        <Banknote size={11} /> Cash
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground" title="Payment method not set — add it on the Employee Details page">
      —
    </span>
  );
}

// ---------------------------------------------------------------------------
// Payment dialog (mark paid — records who and when). Settlement values are
// edited inline in the table; this dialog only confirms the payment.
// ---------------------------------------------------------------------------
function PaymentDialog({ employee, open, onOpenChange, onSaved }: {
  employee: PayrollEmployeeVM | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && employee) setNotes(employee.notes ?? '');
  }, [open, employee]);

  if (!employee) return null;

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      await dataApi.markPayrollPaid(employee.id, {
        advance: employee.advance,
        deduction: employee.deduction,
        notes: notes.trim() || null,
        paid: true,
      });
      toast.success('Marked as paid', {
        description: `${employee.full_name} — AED ${fmtMoney(employee.net_salary)}. Green in every Salary Sheet section.`,
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to record payment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark salary paid — {employee.full_name}</DialogTitle>
          <DialogDescription>
            Payment is recorded with your name and today&apos;s date. The employee&apos;s rows turn
            green in every Salary Sheet section. Paid records are protected from ordinary editing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Gross salary</span><span className="font-mono">AED {fmtMoney(employee.gross_salary)}</span></div>
            <div className="mt-0.5 flex justify-between"><span className="text-muted-foreground">− Advance</span><span className="font-mono">AED {fmtMoney(employee.advance)}</span></div>
            <div className="mt-0.5 flex justify-between"><span className="text-muted-foreground">− Deduction</span><span className="font-mono">AED {fmtMoney(employee.deduction)}</span></div>
            {(employee.absent_deduction ?? 0) > 0 && (
              <div className="mt-0.5 flex justify-between" title={`Absent deduction${employee.absent_deduction_edited ? ' — manually set in Edit mode (this value has priority over the rule)' : ' — from the attendance rule (editable in Edit mode)'}`}>
                <span className="text-red-500">− Absent deduction{employee.absent_deduction_edited ? ' (manual)' : ''}</span>
                <span className="font-mono text-red-500">AED {fmtMoney(employee.absent_deduction)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
              <span>Net salary payable</span><span className="font-mono text-emerald-500">AED {fmtMoney(employee.net_salary)}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Remarks</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remarks" className="h-11" />
            <p className="text-[11px] text-muted-foreground">
              Change the advance / deduction / absent deduction in the table (Edit mode) before confirming if needed.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : <BadgeCheck size={15} className="mr-1" />}
            Confirm &amp; Mark Paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Unpay dialog (super admin only — audited revert to unpaid)
// ---------------------------------------------------------------------------
function UnpayDialog({ employee, open, onOpenChange, onSaved }: {
  employee: PayrollEmployeeVM | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!employee) return null;

  const submit = async (): Promise<void> => {
    if (!reason.trim()) { toast.error('A reason is required to revert a paid salary'); return; }
    setBusy(true);
    try {
      await dataApi.unmarkPayrollPaid(employee.id, reason.trim());
      toast.success('Reverted to unpaid', {
        description: `${employee.full_name} — your reason was recorded in the audit log.`,
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revert');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revert to unpaid — {employee.full_name}?</DialogTitle>
          <DialogDescription>
            Super admin action — the revert is audited with your name, the reason and a timestamp.
            The green highlighting disappears from every Salary Sheet section.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Reason *</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Payment entered for the wrong employee" className="h-11" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy} variant="destructive" className="font-semibold">
            {busy ? <Loader2 size={15} className="mr-1 animate-spin" /> : <LockOpen size={15} className="mr-1" />}
            Revert to Unpaid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function PayrollPage() {
  const realtimeVersion = useRealtimeVersion(['payroll_period', 'payroll_employee', 'attendance', 'employee', 'trade_rate_history']);
  // branch/site scoping data — powers the BRANCH dropdown in the top row
  // (branch grants change → the dropdown and the scoped rows follow)
  const branchVersion = useRealtimeVersion(['site', 'branch', 'admin_branch', 'admin_site', 'profiles']);
  // separate counters — notes / card types must not reload the whole sheet
  const notesVersion = useRealtimeVersion(['employee_note']);
  const cardVersion = useRealtimeVersion(['card_type', 'employee']);
  const isSuperAdmin = useAuthStore((s) => s.user?.role) === 'super_admin';

  // SHARED payroll period — the Salary Sheet uses the same selection
  const year = useAppStore((s) => s.salaryPeriodYear);
  const month = useAppStore((s) => s.salaryPeriodMonth);
  const setSalaryPeriod = useAppStore((s) => s.setSalaryPeriod);
  // SHARED branch scope — the Salary Sheet uses the same selection
  const branchFilter = useAppStore((s) => s.salaryPeriodBranchId);
  const setBranchFilter = useAppStore((s) => s.setSalaryPeriodBranch);

  const [report, setReport] = useState<SalarySheetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  // effective absent-deduction rule (Trade Management → Deductions) — used
  // for the column tooltips / help texts; the amounts themselves come from
  // each settlement's stored absent_deduction
  const [dedSettings, setDedSettings] = useState<DeductionSettings>(DEFAULT_DEDUCTION_SETTINGS);

  const [payTarget, setPayTarget] = useState<PayrollEmployeeVM | null>(null);
  const [unpayTarget, setUnpayTarget] = useState<PayrollEmployeeVM | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  // ---- edit mode (trade dropdown + inline advance / deduction) -------------
  const [editMode, setEditMode] = useState(false);
  const [tradeOptions, setTradeOptions] = useState<Trade[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // ---- search + filters (they narrow the table only — the top cards stay
  //      period totals). SAME set as the Employees page: region → country
  //      (cascading), camp, trade, status (+ paid / unpaid) and payment
  //      method (cash / card type / not set). -------------------------------
  const [search, setSearch] = useState('');
  const [tradeFilter, setTradeFilter] = useState(FILTER_ALL);
  const [regionFilter, setRegionFilter] = useState(FILTER_ALL);
  const [countryFilter, setCountryFilter] = useState(FILTER_ALL);
  const [campFilter, setCampFilter] = useState(FILTER_ALL);
  const [statusFilter, setStatusFilter] = useState(FILTER_ALL);
  const [payFilter, setPayFilter] = useState(FILTER_ALL);
  // mobile (< lg): the six dropdown filters live in a bottom sheet behind a
  // filter icon in the sticky bar — open state lives here
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const navigateToPayrollExport = useAppStore((s) => s.navigateToPayrollExport);
  const navigateToAttendanceCalendar = useAppStore((s) => s.navigateToAttendanceCalendar);

  // ---- payment-method data (card types list + employee sticky notes) -------
  const [cardTypes, setCardTypes] = useState<CardType[]>([]);
  const [notes, setNotes] = useState<EmployeeNote[]>([]);

  // ---- branch-wise separation ----------------------------------------------
  // branches the viewer may access (super admin → all; normal admin → only
  // granted ones) + every site (for the site → owner-branch mapping)
  const [branches, setBranches] = useState<BranchWithCount[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  // normal admins: sites directly assigned to them (Admin Mgmt → Site Access)
  const [assignedSiteIds, setAssignedSiteIds] = useState<Set<string> | null>(
    isSuperAdmin ? null : new Set(),
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      dataApi.listBranches().catch(() => [] as BranchWithCount[]),
      dataApi.listSites().catch(() => [] as SiteWithCount[]),
    ]).then(([brs, sts]) => {
      if (!cancelled) { setBranches(brs); setSites(sts); }
    });
    return () => { cancelled = true; };
  }, [branchVersion]);

  useEffect(() => {
    if (isSuperAdmin) { setAssignedSiteIds(null); return; }
    const me = useAuthStore.getState().user;
    if (!me) return;
    let cancelled = false;
    dataApi.getSiteAssignments(me.id)
      .then((ids) => { if (!cancelled) setAssignedSiteIds(new Set(ids)); })
      .catch(() => { if (!cancelled) setAssignedSiteIds(new Set()); });
    return () => { cancelled = true; };
  }, [isSuperAdmin, branchVersion]);

  const loadNotes = (): void => {
    dataApi.listEmployeeNotes()
      .then(setNotes)
      .catch(() => setNotes([]));
  };

  useEffect(loadNotes, [notesVersion]);

  useEffect(() => {
    let cancelled = false;
    dataApi.listCardTypes()
      .then((rows) => { if (!cancelled) setCardTypes(rows); })
      .catch(() => { if (!cancelled) setCardTypes([]); });
    return () => { cancelled = true; };
  }, [cardVersion]);

  // SILENT REFRESH — the skeleton shows only for the FIRST load of a
  // period. Every later reload (trade picked, settlement saved, mark paid,
  // finalize/reopen, realtime bump) keeps the table mounted and updates the
  // rows IN PLACE, exactly like the Employees page: the scroll position,
  // the row being edited and the open dropdown all stay put, so employees
  // can be edited in ANY order — not just top-to-bottom. (Unmounting the
  // table on every save made rows vanish + replay the flicker cascade,
  // which ate clicks on rows further down the list.)
  const loadedPeriod = useRef<string | null>(null);

  const load = (): void => {
    const key = `${year}:${month}`;
    if (loadedPeriod.current !== key) {
      loadedPeriod.current = key;
      setLoading(true);
    }
    dataApi.getSalarySheet(year, month)
      .then(setReport)
      .catch((err) => {
        setReport(null);
        toast.error(err instanceof Error ? err.message : 'Failed to load payroll');
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [year, month, realtimeVersion]);

  // deduction rule texts — refreshed with the same realtime bump a settings
  // save triggers (payroll_period / payroll_employee)
  useEffect(() => {
    let cancelled = false;
    dataApi.getDeductionSettings()
      .then((s) => { if (!cancelled) setDedSettings(s); })
      .catch(() => { /* keep the previous / default rule texts */ });
    return () => { cancelled = true; };
  }, [realtimeVersion]);

  // trades for the edit-mode dropdown
  useEffect(() => {
    if (!editMode) return;
    let cancelled = false;
    dataApi.listTrades()
      .then((rows) => { if (!cancelled) setTradeOptions(rows); })
      .catch(() => { if (!cancelled) setTradeOptions([]); });
    return () => { cancelled = true; };
  }, [editMode, realtimeVersion]);

  const generate = async (): Promise<void> => {
    setGenerating(true);
    try {
      await dataApi.generatePayroll(year, month);
      toast.success(`Payroll generated for ${MONTH_NAMES[month - 1]} ${year}`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate payroll');
    } finally {
      setGenerating(false);
    }
  };

  const period = report?.period ?? null;
  const finalized = period?.status === 'finalized';
  const employees = useMemo(() => report?.employees ?? [], [report]);

  // ---- BRANCH-WISE scoping (the top-row Branch dropdown) --------------------
  // An employee belongs to a branch when they worked at ANY of its sites this
  // period (their row stays consolidated — that is how Payroll works). Normal
  // admins are additionally limited to the sites of their GRANTED branches
  // plus directly assigned sites, so "All branches" is already their own.
  const branchIdOfSite = useMemo(
    () => new Map((sites ?? []).map((s) => [s.id, s.branch_id ?? null] as const)),
    [sites],
  );
  const grantedBranchSiteIds = useMemo(() => {
    const ids = new Set<string>();
    const granted = new Set((branches ?? []).map((b) => b.id));
    (sites ?? []).forEach((s) => { if (s.branch_id && granted.has(s.branch_id)) ids.add(s.id); });
    return ids;
  }, [branches, sites]);
  // sites a normal admin may see (granted branches + direct assignments);
  // null = unrestricted super admin
  const allowedSiteIds = useMemo<Set<string> | null>(() => {
    if (isSuperAdmin) return null;
    const ids = new Set([...grantedBranchSiteIds, ...(assignedSiteIds ?? [])]);
    return ids;
  }, [isSuperAdmin, grantedBranchSiteIds, assignedSiteIds]);

  const scopedEmployees = useMemo(() => {
    if (!isSuperAdmin) {
      const allow = allowedSiteIds ?? new Set<string>();
      const base = employees.filter((e) => e.sites.some((s) => s.site_id != null && allow.has(s.site_id)));
      if (branchFilter === 'all') return base;
      if (branchFilter === FILTER_NONE) {
        return base.filter((e) => !e.sites.some((s) => s.site_id != null
          && (branchIdOfSite.get(s.site_id) ?? null) !== null));
      }
      return base.filter((e) => e.sites.some((s) => s.site_id != null
        && branchIdOfSite.get(s.site_id) === branchFilter));
    }
    if (branchFilter === 'all') return employees;
    if (branchFilter === FILTER_NONE) {
      return employees.filter((e) => !e.sites.some((s) => s.site_id != null
        && (branchIdOfSite.get(s.site_id) ?? null) !== null));
    }
    return employees.filter((e) => e.sites.some((s) => s.site_id != null
      && branchIdOfSite.get(s.site_id) === branchFilter));
  }, [employees, isSuperAdmin, allowedSiteIds, branchFilter, branchIdOfSite]);

  // true when a specific branch (or the viewer's own allowance) narrows the data
  const branchScopeActive = branchFilter !== 'all' || !isSuperAdmin;
  const selectedBranchName = branchFilter === 'all'
    ? null
    : branchFilter === FILTER_NONE
      ? 'No branch'
      : (branches ?? []).find((b) => b.id === branchFilter)?.name ?? null;

  // notes grouped per employee (for the sticky-note icons)
  const notesByEmployee = useMemo(() => {
    const map = new Map<string, EmployeeNote[]>();
    notes.forEach((n) => {
      const list = map.get(n.employee_id);
      if (list) list.push(n);
      else map.set(n.employee_id, [n]);
    });
    return map;
  }, [notes]);

  // ---- search / filter option lists (built from the BRANCH-SCOPED rows) ----
  const tradeFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    scopedEmployees.forEach((e) => {
      if (e.trade_id) map.set(e.trade_id, e.trade_name ?? 'Unknown trade');
    });
    return [...map.entries()].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [scopedEmployees]);

  const campFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    scopedEmployees.forEach((e) => {
      if (e.camp_id) map.set(e.camp_id, e.camp_name ?? 'Unknown camp');
    });
    return [...map.entries()].map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [scopedEmployees]);

  // countries present in this period, grouped by region (Africans, Asians, …)
  const regionCountries = useMemo(
    () => countriesByRegion(scopedEmployees.map((e) => e.nationality)),
    [scopedEmployees],
  );
  const countryFilterOptions = useMemo(() => {
    const present = new Set(scopedEmployees.map((e) => e.nationality).filter(Boolean) as string[]);
    if (regionFilter === FILTER_ALL) {
      return Object.values(regionCountries).flat().sort((a, b) => a.localeCompare(b));
    }
    if (regionFilter === '__others__') {
      return [...present]
        .filter((c) => !NATIONALITY_REGIONS.some((r) => r.countries.some((rc) => rc.toLowerCase() === c.toLowerCase())))
        .sort((a, b) => a.localeCompare(b));
    }
    const region = NATIONALITY_REGIONS.find((r) => r.key === regionFilter);
    if (!region) return [];
    return region.countries.filter((c) => present.has(c));
  }, [regionFilter, regionCountries, scopedEmployees]);

  const filtersActive = search.trim() !== ''
    || tradeFilter !== FILTER_ALL
    || regionFilter !== FILTER_ALL
    || countryFilter !== FILTER_ALL
    || campFilter !== FILTER_ALL
    || statusFilter !== FILTER_ALL
    || payFilter !== FILTER_ALL;

  // how many of the six DROPDOWN filters are set — badge on the mobile
  // Filters icon (the search box is visible on its own and not counted)
  const activeFilterCount = [tradeFilter, regionFilter, countryFilter, campFilter, statusFilter, payFilter]
    .filter((f) => f !== FILTER_ALL).length;

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    const region = regionFilter === FILTER_ALL
      ? null
      : NATIONALITY_REGIONS.find((r) => r.key === regionFilter) ?? null;
    return scopedEmployees.filter((e) => {
      if (tradeFilter !== FILTER_ALL && (e.trade_id ?? FILTER_NONE) !== tradeFilter) return false;
      // nationality region + country filters (same behaviour as Employees)
      if (region) {
        const nat = (e.nationality ?? '').trim().toLowerCase();
        if (!nat) return false;
        if (region.key === '__others__') {
          const known = NATIONALITY_REGIONS.some((r) =>
            r.countries.some((c) => c.toLowerCase() === nat));
          if (known) return false;
        } else if (!region.countries.some((c) => c.toLowerCase() === nat)) {
          return false;
        }
      }
      if (countryFilter !== FILTER_ALL && (e.nationality ?? FILTER_NONE) !== countryFilter) return false;
      // camp filter ('__none__' = employees without a camp)
      if (campFilter === FILTER_NONE && e.camp_id) return false;
      if (campFilter !== FILTER_ALL && campFilter !== FILTER_NONE && e.camp_id !== campFilter) return false;
      // status: payment status + employee status (mirrors the Employees page)
      const hasSiteThisMonth = e.sites.some((s) => s.site_id != null);
      if (statusFilter === 'paid' && e.payment_status !== 'paid') return false;
      if (statusFilter === 'unpaid' && e.payment_status === 'paid') return false;
      if (statusFilter === 'active' && e.status !== 'active') return false;
      if (statusFilter === 'working' && !hasSiteThisMonth) return false;
      if (statusFilter === 'idle' && hasSiteThisMonth) return false;
      if (statusFilter === 'pending_deletion' && e.status !== 'pending_deletion') return false;
      // payment method: cash / specific card type (by name — unique) / not set
      if (payFilter === 'cash' && e.payment_type !== 'cash') return false;
      if (payFilter === '__unset__' && e.payment_type) return false;
      if (payFilter !== FILTER_ALL && payFilter !== 'cash' && payFilter !== '__unset__'
        && !(e.payment_type === 'card' && e.card_type === payFilter)) return false;
      if (!q) return true;
      return e.full_name.toLowerCase().includes(q)
        || e.employee_code.toLowerCase().includes(q)
        || (e.trade_name ?? '').toLowerCase().includes(q);
    });
  }, [scopedEmployees, search, tradeFilter, regionFilter, countryFilter, campFilter, statusFilter, payFilter]);

  // footer totals follow the FILTERED rows (consistent with the visible table)
  const filteredTotals = useMemo(() => ({
    hours: round2(filteredEmployees.reduce((n, e) => n + e.total_hours, 0)),
    advances: round2(filteredEmployees.reduce((n, e) => n + e.advance, 0)),
    // manual deduction + the automatic absent deduction (what the column shows)
    deductions: round2(filteredEmployees.reduce((n, e) => n + e.deduction + (e.absent_deduction ?? 0), 0)),
    gross: round2(filteredEmployees.reduce((n, e) => n + e.gross_salary, 0)),
    net: round2(filteredEmployees.reduce((n, e) => n + e.net_salary, 0)),
  }), [filteredEmployees]);

  const clearFilters = (): void => {
    setSearch('');
    setTradeFilter(FILTER_ALL);
    setRegionFilter(FILTER_ALL);
    setCountryFilter(FILTER_ALL);
    setCampFilter(FILTER_ALL);
    setStatusFilter(FILTER_ALL);
    setPayFilter(FILTER_ALL);
  };

  // ---- Excel export --------------------------------------------------------
  // Opens the PREVIEW page with the CURRENTLY FILTERED rows; the columns are
  // picked (all on by default) and the file downloaded from there. The chips
  // describe the active filters — they show on the preview and shape the
  // download filename (Pulse_Payroll_<Month>-<Year>_<chips>_<date>.xlsx).
  const exportChips = (): string[] => {
    const chips: string[] = [];
    if (branchFilter !== 'all') {
      chips.push(`Branch: ${branchFilter === FILTER_NONE ? 'No branch' : selectedBranchName ?? 'Branch'}`);
    }
    const q = search.trim();
    if (q) chips.push(`Search: ${q}`);
    if (regionFilter !== FILTER_ALL) {
      const label = regionFilter === '__others__'
        ? 'Others'
        : NATIONALITY_REGIONS.find((r) => r.key === regionFilter)?.label ?? 'Region';
      chips.push(`Region: ${label}`);
    }
    if (countryFilter !== FILTER_ALL) chips.push(`Country: ${countryFilter}`);
    if (campFilter !== FILTER_ALL) {
      chips.push(campFilter === FILTER_NONE
        ? 'Camp: none assigned'
        : `Camp: ${campFilterOptions.find((c) => c.id === campFilter)?.name ?? 'Camp'}`);
    }
    if (tradeFilter !== FILTER_ALL) {
      chips.push(tradeFilter === FILTER_NONE
        ? 'Trade: none'
        : `Trade: ${tradeFilterOptions.find((t) => t.id === tradeFilter)?.name ?? 'Trade'}`);
    }
    if (payFilter !== FILTER_ALL) {
      chips.push(payFilter === 'cash'
        ? 'Payment: Cash'
        : payFilter === '__unset__' ? 'Payment: not set' : `Payment: ${payFilter}`);
    }
    if (statusFilter !== FILTER_ALL) chips.push(`Status: ${STATUS_LABELS[statusFilter] ?? statusFilter}`);
    return chips;
  };

  const exportToExcel = (): void => {
    if (filteredEmployees.length === 0) {
      toast.error('Nothing to export', { description: 'The current filters match no employees.' });
      return;
    }
    setExporting(true);
    const filters = exportChips();
    const fileName = payrollExportFileName(year, month, filters);
    // give the button its spinner frame, then switch to the preview page
    setTimeout(() => {
      navigateToPayrollExport(filteredEmployees, year, month, fileName, filters, scopedEmployees.length);
      setExporting(false);
    }, 120);
  };

  // payment cards — read from the stored settlement rows (never recalculated).
  // When a BRANCH is selected (or a normal admin's allowance applies) the
  // cards describe that scope — the selected branch's payroll is what loads.
  const paidNet = useMemo(
    () => round2(scopedEmployees.filter((e) => e.payment_status === 'paid').reduce((n, e) => n + e.net_salary, 0)),
    [scopedEmployees],
  );
  const balanceToPay = useMemo(
    () => round2(scopedEmployees.filter((e) => e.payment_status !== 'paid').reduce((n, e) => n + e.net_salary, 0)),
    [scopedEmployees],
  );
  const scopedPaidCount = scopedEmployees.filter((e) => e.payment_status === 'paid').length;
  const scopedUnpaidCount = scopedEmployees.length - scopedPaidCount;
  const scopedGross = round2(scopedEmployees.reduce((n, e) => n + e.gross_salary, 0));
  const scopedAdvances = round2(scopedEmployees.reduce((n, e) => n + e.advance, 0));
  const scopedDeductions = round2(scopedEmployees.reduce((n, e) => n + e.deduction + (e.absent_deduction ?? 0), 0));

  // ---- inline settlement save (advance / deduction / absent deduction) -----
  // absentDeduction is sent ONLY when the absent input was touched — the
  // stored value then has priority over the rule (flagged on the settlement)
  const onAdjust = async (
    e: PayrollEmployeeVM, advance: number, deduction: number, absentDeduction?: number,
  ): Promise<void> => {
    setBusyKey(`settle:${e.id}`);
    try {
      await dataApi.updatePayrollAdjustment(e.id, {
        advance, deduction, notes: e.notes,
        ...(absentDeduction != null ? { absent_deduction: absentDeduction } : {}),
      });
      toast.success('Settlement saved', {
        description: `${e.full_name} — advance AED ${fmtMoney(advance)} · deduction AED ${fmtMoney(deduction)}`
          + (absentDeduction != null ? ` · absent deduction AED ${fmtMoney(absentDeduction)}` : ''),
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusyKey(null);
    }
  };

  // ---- absent deduction → back to the configured rule (recomputed from
  //      this month's attendance; clears the edited flag) ---------------------
  const onAbsentAuto = async (e: PayrollEmployeeVM): Promise<void> => {
    setBusyKey(`settle:${e.id}`);
    try {
      await dataApi.updatePayrollAdjustment(e.id, {
        advance: e.advance, deduction: e.deduction, notes: e.notes, absent_auto: true,
      });
      toast.success('Absent deduction reset to the rule', {
        description: `${e.full_name} — recomputed from the ${MONTH_NAMES[month - 1]} ${year} attendance.`,
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setBusyKey(null);
    }
  };

  // ---- change an employee's trade straight from Payroll (edit mode) -------
  // Immediate save: the pick overwrites the stored trade + assignment history
  // (effective from the 1st of the payroll month) and re-prices the month.
  // Every linked page reads the same rows → all of them update together.
  const onTradeChange = async (e: PayrollEmployeeVM, tradeId: string | null): Promise<void> => {
    if ((tradeId ?? null) === (e.trade_id ?? null)) return;
    if (e.payment_status === 'paid') {
      toast.error('This employee is already marked paid — reopen the payroll first');
      return;
    }
    setBusyKey(`trade:${e.id}`);
    try {
      await dataApi.updateSalarySheetRow({ payroll_employee_id: e.id, trade_id: tradeId });
      const tName = tradeId
        ? tradeOptions.find((t) => t.id === tradeId)?.name ?? 'the new trade'
        : 'no trade';
      toast.success('Trade updated', {
        description: `${e.full_name} → ${tName} — month re-priced; Salary Sheet, Employee Details, Attendance and every linked page now use the new trade.`,
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change trade');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleEditMode = (): void => setEditMode((o) => !o);

  // ---- the six filter dropdowns, rendered in TWO places: inline in the
  //      desktop sticky bar (≥ lg) and full-width inside the mobile bottom
  //      sheet (< lg). Identical options and behaviour in both. -------------
  const renderFilterSelects = (): ReactNode => (<>
    {/* region → country (cascading, like the Employees page) */}
    <Select
      value={regionFilter}
      onValueChange={(v) => { setRegionFilter(v); setCountryFilter(FILTER_ALL); }}
    >
      <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-40" aria-label="Filter by nationality region">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>All regions</SelectItem>
        {NATIONALITY_REGIONS.map((r) => (
          <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>
        ))}
        <SelectItem value="__others__">Others</SelectItem>
      </SelectContent>
    </Select>
    <Select value={countryFilter} onValueChange={setCountryFilter}>
      <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-40" aria-label="Filter by nationality country">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>All countries</SelectItem>
        {countryFilterOptions.map((c) => (
          <SelectItem key={c} value={c}>{c}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    <Select value={campFilter} onValueChange={setCampFilter}>
      <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-44" aria-label="Filter by camp">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>All camps</SelectItem>
        {campFilterOptions.map((c) => (
          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
        ))}
        <SelectItem value={FILTER_NONE}>No camp assigned</SelectItem>
      </SelectContent>
    </Select>
    <Select value={tradeFilter} onValueChange={setTradeFilter}>
      <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-40" aria-label="Filter by trade">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>All trades</SelectItem>
        {tradeFilterOptions.map((t) => (
          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
        ))}
        <SelectItem value={FILTER_NONE}>No trade</SelectItem>
      </SelectContent>
    </Select>
    {/* payment method — All / Cash / every card type in the DB / Not set */}
    <Select value={payFilter} onValueChange={setPayFilter}>
      <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-44" aria-label="Filter by payment method">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>All payment methods</SelectItem>
        <SelectItem value="cash">Cash</SelectItem>
        {cardTypes.map((c) => (
          <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
        ))}
        <SelectItem value="__unset__">Not set</SelectItem>
      </SelectContent>
    </Select>
    <Select value={statusFilter} onValueChange={setStatusFilter}>
      <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-44" aria-label="Filter by status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FILTER_ALL}>All statuses</SelectItem>
        <SelectItem value="paid">Paid</SelectItem>
        <SelectItem value="unpaid">Unpaid</SelectItem>
        <SelectItem value="active">Active</SelectItem>
        <SelectItem value="working">Working (site this month)</SelectItem>
        <SelectItem value="idle">Idle (no site)</SelectItem>
        <SelectItem value="pending_deletion">Pending deletion</SelectItem>
      </SelectContent>
    </Select>
  </>);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      {/* sticky action bar — Edit / Finalize / Reopen stay visible while scrolling */}
      <div className="sticky top-16 z-30 rounded-xl border border-border/60 bg-background/90 px-3 py-2.5 shadow-lg shadow-black/[0.04] backdrop-blur-xl">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="shrink-0 rounded-lg bg-brand/10 p-1.5 text-brand"><Banknote size={16} /></div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Payroll — {MONTH_NAMES[month - 1]} {year}</h1>
              <p className="truncate text-xs text-muted-foreground">
                {branchFilter === 'all'
                  ? (isSuperAdmin
                      ? 'One row per employee — consolidated across all sites'
                      : 'One row per employee — your granted branches')
                  : `One row per employee — ${selectedBranchName ?? 'the selected branch'}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {period && (
              <span className={cn(
                'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold',
                finalized
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
              )}>
                {finalized ? <Lock size={12} /> : <Clock size={12} />}
                {finalized ? 'Finalized' : 'Draft'}
              </span>
            )}
            {/* BRANCH dropdown — branch-wise separation: picking a branch
                loads only that branch's payroll (rows, cards and the export) */}
            <Select value={branchFilter} onValueChange={setBranchFilter}>
              <SelectTrigger
                className="h-10 w-[170px] shrink-0 bg-card sm:w-48"
                aria-label="Filter payroll by branch"
                title="Show only the selected branch's payroll"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <GitBranch size={14} className="shrink-0 text-brand" />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {(branches ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}{!b.is_active ? ' (inactive)' : ''}
                  </SelectItem>
                ))}
                {isSuperAdmin && <SelectItem value={FILTER_NONE}>No branch</SelectItem>}
              </SelectContent>
            </Select>
            <Select value={MONTH_NAMES[month - 1]} onValueChange={(m) => setSalaryPeriod(year, MONTH_NAMES.indexOf(m) + 1)}>
              <SelectTrigger className="h-10 w-36 bg-card" aria-label="Payroll month"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={(y) => setSalaryPeriod(Number(y), month)}>
              <SelectTrigger className="h-10 w-24 bg-card" aria-label="Payroll year"><SelectValue /></SelectTrigger>
              <SelectContent>
                {selectableYears().map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
            {report?.exists && (
              <Button
                variant="outline"
                size="sm"
                onClick={exportToExcel}
                disabled={exporting || filteredEmployees.length === 0}
                title={filteredEmployees.length === 0
                  ? 'The current filters match no employees'
                  : `Preview the filtered payroll (${filteredEmployees.length} employee${filteredEmployees.length === 1 ? '' : 's'}) as an Excel sheet`}
                className="h-9 font-medium"
              >
                {exporting
                  ? <Loader2 size={14} className="mr-1 animate-spin" />
                  : <FileSpreadsheet size={14} className="mr-1 text-emerald-600 dark:text-emerald-400" />}
                Excel
              </Button>
            )}
            {report?.exists && (
              <Button
                variant={editMode ? 'default' : 'outline'}
                size="sm"
                onClick={toggleEditMode}
                className={cn(editMode && 'brand-gradient font-semibold text-white')}
              >
                {editMode
                  ? <><Eye size={14} /> Done</>
                  : <><PencilLine size={14} /> Edit</>}
              </Button>
            )}
            {isSuperAdmin && report?.exists && !finalized && (
              <Button size="sm" onClick={() => setFinalizeOpen(true)} className="brand-gradient font-semibold text-white">
                <Lock size={14} /> Finalize
              </Button>
            )}
            {isSuperAdmin && finalized && (
              <Button size="sm" variant="outline" onClick={() => setReopenOpen(true)}>
                <LockOpen size={14} /> Reopen
              </Button>
            )}
          </div>
        </div>

        {/* search + filters — always visible while scrolling (same set as the
            Employees page: region, country, camp, trade, payment method,
            status). Below lg the six dropdowns collapse behind a FILTERS
            icon (bottom sheet) so the bar stays one compact row on phones */}
        <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5">
          <div className="relative min-w-0 flex-1 lg:min-w-[170px]">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, ID or trade…"
              aria-label="Search employees by name, ID or trade"
              className="h-9 bg-card pl-8 pr-8 text-sm"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {/* MOBILE (< lg): a single FILTERS icon carries ALL the filter
              fields — it opens the bottom sheet below, so this sticky bar
              stays one compact row and the table is never covered */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFiltersOpen(true)}
            aria-label={`Open filters${activeFilterCount > 0 ? ` (${activeFilterCount} active)` : ''}`}
            className="h-9 shrink-0 gap-1.5 px-3 text-xs lg:hidden"
          >
            <ListFilter size={14} />
            Filters
            {activeFilterCount > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {filtersActive && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground lg:hidden" title="Employees shown / branch scope">
              {filteredEmployees.length}/{scopedEmployees.length}
            </span>
          )}

          {/* DESKTOP (≥ lg): the six dropdowns stay inline in the bar */}
          <div className="hidden flex-wrap items-center gap-2 lg:flex">
            {renderFilterSelects()}
            {filtersActive && (
              <>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title="Employees shown / branch scope">
                  {filteredEmployees.length}/{scopedEmployees.length}
                </span>
                <Button variant="ghost" size="sm" className="h-9 shrink-0 px-2.5 text-xs" onClick={clearFilters}>
                  <X size={13} /> Clear
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* MOBILE (< lg): ALL filter fields live in this bottom sheet behind
          the Filters icon — region, country, camp, trade, payment method,
          status, with a live result count and Clear all */}
      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-2xl p-0">
          <SheetHeader className="border-b border-border/60 px-4 py-3">
            <SheetTitle className="text-sm">Filters</SheetTitle>
            <SheetDescription className="text-xs">
              {filteredEmployees.length} of {scopedEmployees.length} employees shown — changes apply live
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-2.5 px-4 py-4 [&_[data-slot=select-trigger]]:w-full">
            {renderFilterSelects()}
          </div>
          <div className="sticky bottom-0 flex gap-2 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur">
            {filtersActive && (
              <Button variant="outline" className="h-10 flex-1 text-xs" onClick={clearFilters}>
                <X size={14} /> Clear all
              </Button>
            )}
            <Button className="brand-gradient h-10 flex-1 font-semibold text-white" onClick={() => setFiltersOpen(false)}>
              Show {filteredEmployees.length} employee{filteredEmployees.length === 1 ? '' : 's'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : !report || !report.exists ? (
        <EmptyState
          icon={<Banknote size={22} />}
          title={`No payroll for ${MONTH_NAMES[month - 1]} ${year}`}
          description="Generate the month's payroll first — it is calculated once and shared by the Salary Sheet and Payroll."
          action={
            <Button onClick={generate} disabled={generating} className="brand-gradient font-semibold text-white">
              {generating ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Wallet size={15} className="mr-1" />}
              Generate Payroll
            </Button>
          }
        />
      ) : (
        <>
          {/* edit-mode banner */}
          {editMode && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                <b>Edit mode</b> — pick the <b>trade</b> from the dropdown (overwrites the stored trade
                and re-prices the month — updates the Salary Sheet, Employee Details, Attendance and
                every linked page) and edit <b>advance / deduction / absent deduction</b> inline (saves on blur or Enter).
                Paid employees are protected. Salary calculation edits stay in the <b>Salary Sheet</b>.
              </span>
            </p>
          )}

          {/* totals — branch-scoped when a branch is picked (the selected
              branch's payroll is what loads); period totals otherwise */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: <Users size={12} />, label: 'Total employees', value: String(branchScopeActive ? scopedEmployees.length : report.totals.employees), hint: branchScopeActive ? `${scopedPaidCount} paid · ${scopedUnpaidCount} unpaid` : `${report.totals.paid_count} paid · ${report.totals.unpaid_count} unpaid`, tone: 'default' as const },
              { icon: <Banknote size={12} />, label: 'Total gross salary', value: `AED ${fmtMoney(branchScopeActive ? scopedGross : report.totals.gross_salary)}`, hint: `Adv. ${fmtMoney(branchScopeActive ? scopedAdvances : report.totals.advances)} · Ded. ${fmtMoney(branchScopeActive ? scopedDeductions : report.totals.deductions)}`, tone: 'brand' as const },
              { icon: <BadgeCheck size={12} />, label: 'Paid salary', value: `AED ${fmtMoney(paidNet)}`, hint: `${branchScopeActive ? scopedPaidCount : report.totals.paid_count} employee${(branchScopeActive ? scopedPaidCount : report.totals.paid_count) === 1 ? '' : 's'} paid (net)`, tone: 'emerald' as const },
              { icon: <Scale size={12} />, label: 'Balance to pay', value: `AED ${fmtMoney(balanceToPay)}`, hint: `${branchScopeActive ? scopedUnpaidCount : report.totals.unpaid_count} employee${(branchScopeActive ? scopedUnpaidCount : report.totals.unpaid_count) === 1 ? '' : 's'} unpaid (net)`, tone: 'amber' as const },
            ].map((c, i) => (
              <motion.div
                key={c.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.05, ease: EASE }}
                className={cn(
                  'card-glow rounded-xl border bg-card p-4',
                  c.tone === 'brand' && 'border-brand/25 bg-brand/[0.05]',
                  c.tone === 'emerald' && 'border-emerald-500/25 bg-emerald-500/[0.05]',
                  c.tone === 'amber' && 'border-amber-500/25 bg-amber-500/[0.05]',
                )}
              >
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {c.icon} {c.label}
                </p>
                <p className={cn(
                  'mt-1.5 text-2xl font-bold tracking-tight tabular-nums',
                  c.tone === 'brand' && 'text-brand',
                  c.tone === 'emerald' && 'text-emerald-500',
                  c.tone === 'amber' && 'text-amber-500',
                )}>
                  {c.value}
                </p>
                {c.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{c.hint}</p>}
              </motion.div>
            ))}
          </div>

          {/* consolidated table — ONE row per employee, settlement always
              visible. Wide layout (matches the Attendance page) so the ten
              columns breathe; cells get extra horizontal padding. */}
          <section className="card-glow overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              <Table className="[&_td]:px-4 [&_th]:px-4 [&_td]:py-3">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Sl No</TableHead>
                    <TableHead className="min-w-56">Employee</TableHead>
                    <TableHead className="min-w-28">Code</TableHead>
                    <TableHead className="text-right">Total Hours</TableHead>
                    <TableHead className="min-w-40">Trade</TableHead>
                    <TableHead className="min-w-32">Payment Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Advance</TableHead>
                    <TableHead className="text-right" title={`Manual deduction + absent deduction (AED ${dedSettings.absent_deduction_amount} per absence beyond the first ${dedSettings.absent_free_days}) — the absent part is editable in Edit mode and the edited value has priority — click a value to open the attendance calendar`}>Deduction</TableHead>
                    <TableHead className="text-right">Net Payable</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* filter results animate in with the same smooth flicker
                      cascade the Employees page uses (staggered fade + rise) */}
                  <AnimatePresence initial={false}>
                  {filteredEmployees.map((e, i) => {
                    const paid = e.payment_status === 'paid';
                    const tradeBusy = busyKey === `trade:${e.id}`;
                    const settleBusy = busyKey === `settle:${e.id}`;
                    // paid employees (and removed ones) keep read-only cells
                    const editable = editMode && !paid && e.status !== 'deleted';
                    const hasSalary = e.gross_salary > 0;
                    return (
                      <motion.tr
                        key={e.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ delay: Math.min(i * 0.03, 0.45), duration: 0.2, ease: EASE }}
                        className={cn(
                          'border-b transition-colors hover:bg-muted/50',
                          paid && 'bg-emerald-500/[0.07]',
                          e.manually_edited && !paid && 'bg-amber-500/[0.04]',
                        )}
                      >
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand/15 text-[11px] font-bold text-brand">
                              {e.photo ? <img src={e.photo} alt="" className="size-full object-cover" /> : initials(e.full_name)}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="truncate text-sm font-medium">
                                  {e.full_name}
                                  {e.manually_edited && (
                                    <span className="ml-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-amber-500">
                                      manual
                                    </span>
                                  )}
                                </p>
                                {/* sticky-note quick notes — stored on the employee */}
                                <EmployeeNotesCell
                                  employee={e}
                                  notes={notesByEmployee.get(e.employee_id) ?? []}
                                  onChanged={loadNotes}
                                />
                              </div>
                              {paid && (
                                <p className="text-[10px] font-medium text-emerald-500">
                                  Paid {e.paid_at ? fmtDateTime(e.paid_at) : ''}{e.paid_by_name ? ` · ${e.paid_by_name}` : ''}
                                </p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.employee_code}</TableCell>
                        <TableCell className="text-right">
                          <HoursCell e={e} year={year} month={month} />
                        </TableCell>
                        <TableCell className="text-xs">
                          {editable ? (
                            <span className="inline-flex items-center gap-1.5">
                              {tradeBusy && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
                              <Select
                                value={e.trade_id ?? NO_TRADE}
                                disabled={tradeBusy}
                                onValueChange={(v) => { void onTradeChange(e, v === NO_TRADE ? null : v); }}
                              >
                                <SelectTrigger className="h-8 w-40 bg-card text-xs" aria-label={`Trade of ${e.full_name}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NO_TRADE}>No trade</SelectItem>
                                  {tradeOptions.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                      {t.name}{t.is_active ? '' : ' (inactive)'}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </span>
                          ) : (
                            e.trade_name ?? <span className="text-amber-500">no trade</span>
                          )}
                        </TableCell>
                        {/* payment method — cash, or the card type only */}
                        <TableCell className="text-xs">
                          <PaymentMethodCell e={e} />
                        </TableCell>
                        {/* amount (gross) — BEFORE advance / deduction, same
                            order as the header and the Excel export */}
                        <TableCell className="text-right font-mono text-sm font-semibold">
                          AED {fmtMoney(e.gross_salary)}
                        </TableCell>
                        <TableCell className="text-right">
                          {editable ? (
                            <div className="flex justify-end">
                              <AdjustInput
                                value={e.advance} busy={settleBusy} label="Advance"
                                onCommit={(next) => { void onAdjust(e, next, e.deduction); }}
                              />
                            </div>
                          ) : (
                            <span className={cn('font-mono text-xs', e.advance > 0 ? '' : 'text-muted-foreground')}>
                              {e.advance > 0 ? fmtMoney(e.advance) : '—'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {editable ? (
                            <div className="flex flex-col items-end gap-1">
                              <div className="flex justify-end">
                                <AdjustInput
                                  value={e.deduction} busy={settleBusy} label="Deduction"
                                  onCommit={(next) => { void onAdjust(e, e.advance, next); }}
                                />
                              </div>
                              {/* ABSENT deduction — EDITABLE like a normal deduction
                                  value. The amount typed here is stored as the
                                  ACTUAL deduction (flagged) and has priority over
                                  the rule until the ↺ reset. */}
                              {((e.absent_deduction ?? 0) > 0 || e.absent_deduction_edited) && (
                                <div className="flex items-center gap-1.5">
                                  {e.absent_deduction_edited && (
                                    <span
                                      className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                                      title="Manually set — this amount has priority over the configured rule until reset"
                                    >
                                      <Pencil size={9} /> edited
                                    </span>
                                  )}
                                  <span
                                    className="inline-flex items-center gap-1"
                                    title={`Absent deduction — editable, same as the manual deduction${e.absent_deduction_edited
                                      ? ' (currently manually set — priority)'
                                      : ` (rule: AED ${dedSettings.absent_deduction_amount} per absence beyond the first ${dedSettings.absent_free_days})`}`}
                                  >
                                    <span className="rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-bold text-red-500">A</span>
                                    <AdjustInput
                                      value={e.absent_deduction ?? 0} busy={settleBusy} label="Absent deduction"
                                      onCommit={(next) => { void onAdjust(e, e.advance, e.deduction, next); }}
                                    />
                                  </span>
                                  {e.absent_deduction_edited && (
                                    <button
                                      type="button"
                                      disabled={settleBusy}
                                      title="Back to the configured rule — recomputed from this month's attendance"
                                      aria-label={`Reset the absent deduction of ${e.full_name} to the rule`}
                                      onClick={() => { void onAbsentAuto(e); }}
                                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-brand disabled:opacity-50"
                                    >
                                      {settleBusy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => navigateToAttendanceCalendar(e, year, month)}
                              title={`Open ${e.full_name}'s attendance calendar for ${MONTH_NAMES[month - 1]} ${year}${
                                (e.deduction + (e.absent_deduction ?? 0)) > 0
                                  ? ` — manual ${fmtMoney(e.deduction)}${(e.absent_deduction ?? 0) > 0 ? ` + absent ${fmtMoney(e.absent_deduction)}` : ''}`
                                  : ' (no deduction this month)'}`}
                              className={cn(
                                'group inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-muted/70',
                                (e.deduction + (e.absent_deduction ?? 0)) > 0 ? '' : 'text-muted-foreground',
                              )}
                            >
                              {(e.deduction + (e.absent_deduction ?? 0)) > 0
                                ? fmtMoney(e.deduction + (e.absent_deduction ?? 0))
                                : '—'}
                              {(e.absent_deduction ?? 0) > 0 && (
                                <span
                                  className="rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-bold text-red-500"
                                  title={`Absent deduction — AED ${fmtMoney(e.absent_deduction)}${e.absent_deduction_edited
                                    ? ' · manually set in Edit mode (this value has priority over the rule)'
                                    : ` (AED ${dedSettings.absent_deduction_amount} × chargeable absences, beyond the first ${dedSettings.absent_free_days}) — editable in Edit mode`}`}
                                >
                                  A
                                </span>
                              )}
                              {e.absent_deduction_edited && (
                                <span
                                  className="inline-flex items-center rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                                  title="The absent deduction was edited on the Payroll page — the stored amount is the actual deduction"
                                >
                                  <Pencil size={9} />
                                </span>
                              )}
                              <CalendarDays size={11} className="text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                          AED {fmtMoney(e.net_salary)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {paid ? (
                              <>
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-500">
                                  <BadgeCheck size={11} /> Paid
                                </span>
                                {isSuperAdmin ? (
                                  <Button
                                    variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground"
                                    onClick={() => setUnpayTarget(e)}
                                    title="Revert to unpaid (audited)"
                                  >
                                    <LockOpen size={12} /> Undo
                                  </Button>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground" title="Only a super admin can revert a paid salary">
                                    locked
                                  </span>
                                )}
                              </>
                            ) : (
                              <Button
                                size="sm"
                                disabled={!hasSalary}
                                title={hasSalary
                                  ? `Mark the monthly salary paid (net AED ${fmtMoney(e.net_salary)})`
                                  : 'No salary calculated for this employee this month'}
                                onClick={() => setPayTarget(e)}
                                className="h-8 brand-gradient px-3 text-xs font-semibold text-white"
                              >
                                <BadgeCheck size={13} className="mr-1" /> Mark paid
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </motion.tr>
                    );
                  })}
                  </AnimatePresence>
                  {filteredEmployees.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={11} className="py-10 text-center text-sm text-muted-foreground">
                        {scopedEmployees.length === 0 && branchScopeActive
                          ? `No employees worked in ${selectedBranchName ?? 'your branches'} this month.`
                          : employees.length === 0
                            ? 'No employees in this payroll period.'
                            : 'No employees match the search / filters.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
                {filteredEmployees.length > 0 && (
                  <TableFooter>
                    <TableRow className="font-semibold hover:bg-transparent">
                      <TableCell colSpan={3} className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                        Total — {filteredEmployees.length} employee{filteredEmployees.length === 1 ? '' : 's'}
                        {filtersActive && ` (of ${scopedEmployees.length})`}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtHrs(filteredTotals.hours)} h</TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right font-mono text-sm">AED {fmtMoney(filteredTotals.gross)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmtMoney(filteredTotals.advances)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmtMoney(filteredTotals.deductions)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-emerald-600 dark:text-emerald-400">
                        AED {fmtMoney(filteredTotals.net)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </div>
            <p className="flex items-center gap-1.5 border-t px-4 py-2.5 text-[11px] text-muted-foreground">
              <UserX size={12} className="shrink-0" />
              Hover (or tap) a Total Hours value for the complete calculation. Click a Deduction value to open the employee&apos;s attendance calendar (absent deduction: AED {dedSettings.absent_deduction_amount} per absence beyond the first {dedSettings.absent_free_days} — configurable in Trade/Ded Management, and editable per employee in Edit mode; an edited amount has priority and flows into the Salary Sheet and the attendance record). Employees without a site are listed under Idle Employees in the Salary Sheet.
            </p>
          </section>

          {/* audit trail — collapsed behind an expandable icon button */}
          {report.audit.length > 0 && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setAuditOpen((o) => !o)}
                aria-expanded={auditOpen}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors',
                  auditOpen
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-border/60 bg-card text-muted-foreground hover:text-foreground',
                )}
                title={auditOpen ? 'Hide the audit trail' : `Show all ${report.audit.length} audit entries`}
              >
                <History size={14} />
                Audit trail
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                  {report.audit.length}
                </span>
                {auditOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            </div>
          )}
          <AnimatePresence initial={false}>
            {auditOpen && report.audit.length > 0 && (
              <motion.section
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="overflow-hidden"
              >
                <div className="card-glow rounded-xl border bg-card p-5">
                  <SectionTitle icon={<History size={16} />} title="Audit trail" sub={`All ${report.audit.length} entries — payments, reverts, edits, finalizations and reopens`} />
                  <div className="mt-3 space-y-1.5">
                    {report.audit.map((a) => (
                      <p key={a.id} className="text-xs text-muted-foreground">
                        <span className="font-mono">{fmtDateTime(a.created_at)}</span>
                        {' · '}<span className="font-semibold text-foreground">{a.actor_name ?? 'System'}</span>
                        {' · '}{a.details}
                      </p>
                    ))}
                  </div>
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </>
      )}

      {/* dialogs */}
      <PaymentDialog
        employee={payTarget}
        open={payTarget !== null}
        onOpenChange={(v) => { if (!v) setPayTarget(null); }}
        onSaved={load}
      />
      <UnpayDialog
        employee={unpayTarget}
        open={unpayTarget !== null}
        onOpenChange={(v) => { if (!v) setUnpayTarget(null); }}
        onSaved={load}
      />
      <FinalizeDialog report={report} open={finalizeOpen} onOpenChange={setFinalizeOpen} onDone={load} />
      <ReopenDialog report={report} open={reopenOpen} onOpenChange={setReopenOpen} onDone={load} />
    </div>
  );
}
