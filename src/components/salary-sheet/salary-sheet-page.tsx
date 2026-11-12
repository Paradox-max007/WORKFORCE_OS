'use client';

// ============================================================================
// PULSE Workforce OS — Salary Sheet (site-wise calculation view)
// ----------------------------------------------------------------------------
// Displays the DATABASE-CALCULATED payroll (get_salary_sheet RPC / demo
// engine). The frontend never calculates salary — it renders the verified
// result. The Salary Sheet is the source of truth for salary CALCULATIONS;
// payment administration lives in the separate Payroll page (same period).
//
//   • month selector + status (Draft recalculation live / Finalized snapshot)
//   • summary cards: employees, total hours, gross, paid count
//   • SITE sections: per-employee hours & gross AT THAT SITE (historical site
//     attribution — moved-out employees stay on every site they worked at)
//   • IDLE EMPLOYEES section, always LAST: employees without a site
//     assignment for the period + unassigned/unrated hours (never attributed
//     to an invented site; historical attendance keeps its real site rows)
//   • paid employees are green-shaded in EVERY section they appear in
//   • EDIT MODE: change the employee's TRADE from a dropdown (immediate save
//     — overwrites the stored trade and re-prices the month) and override
//     hours / rate / gross. THE SHEET RECORD HAS PRIORITY — saved values are
//     protected from the automatic recalculation (↺ returns to auto pricing)
//   • payment/advance/deduction administration: see the Payroll page. The
//     Deduction column shows manual + ABSENT deduction (red “A” chip) — the
//     SAME rule as the Payroll page: the absent amount edited there has
//     PRIORITY over the configured rule and flows into this sheet, its
//     totals and the net payable automatically
//   • BRANCH-WISE SEPARATION — a Branch dropdown in the top row (shared with
//     the Payroll page): picking a branch loads only THAT branch's site
//     sections, summary cards and CSV export. "No branch" = sites without
//     an owner branch (plus the idle employees — they belong to no branch).
//     Normal admins only ever see their granted branches (+ directly
//     assigned sites); the idle section is super-admin only.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck, Banknote, Check, ChevronDown, ChevronRight, ChevronUp, Clock, Eye,
  FileSpreadsheet, GitBranch, History, Loader2, Lock, LockOpen, Pencil, PencilLine, RotateCcw, Search,
  TriangleAlert, UserX, Users, Wallet, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, SectionTitle } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { FinalizeDialog, ReopenDialog } from '@/components/salary-sheet/period-dialogs';
import { dataApi } from '@/lib/data';
import { fmtDateTime, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type PayrollEmployeeVM, type PayrollSalaryLineVM, type SalarySheetReport,
  type SalarySheetSiteGroup, type SiteWithCount, type Trade, type BranchWithCount,
} from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtMoney = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtHrs = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const selectableYears = (): number[] => {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y];
};

const ROLE_LABEL: Record<string, string> = {
  standard: 'Standard', team_leader: 'Team Leader', supervisor: 'Supervisor',
};
const TIER_LABEL: Record<string, string> = {
  below_threshold: 'Below eligibility', qualified: 'Qualified', manual: 'Manual',
};

/** sentinel filter values */
const FILTER_ALL = 'all';
const FILTER_NONE = '__none__';

/** sentinel for "no trade" in the edit-mode dropdown (Radix needs non-empty values) */
const NO_TRADE = '__none__';

type SiteRow = SalarySheetSiteGroup['rows'][number];
type SiteDraft = { hours: string; rate: string; gross: string };
/** live trade-edit state for a site row (edit mode only) */
type TradeState = { value: string | null; editable: boolean; busy: boolean };

/** effective (volume-weighted) rate of a site row — the edit-mode prefill */
const effRateOf = (r: SiteRow): number => {
  if (r.lines.length === 1) return r.lines[0].hourly_rate;
  if (r.total_hours > 0) return Math.round((r.gross_salary / r.total_hours) * 100) / 100;
  return r.lines[0]?.hourly_rate ?? 0;
};

// ---------------------------------------------------------------------------
// Summary stat card
// ---------------------------------------------------------------------------
function StatCard({ icon, label, value, hint, tone = 'default', index }: {
  icon: React.ReactNode; label: string; value: string; hint?: string;
  tone?: 'default' | 'brand' | 'emerald' | 'amber';
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05, ease: EASE }}
      className={cn(
        'card-glow rounded-xl border bg-card p-4',
        tone === 'brand' && 'border-brand/25 bg-brand/[0.05]',
        tone === 'emerald' && 'border-emerald-500/25 bg-emerald-500/[0.05]',
        tone === 'amber' && 'border-amber-500/25 bg-amber-500/[0.05]',
      )}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon} {label}
      </p>
      <p className={cn(
        'mt-1.5 text-2xl font-bold tracking-tight tabular-nums',
        tone === 'brand' && 'text-brand',
        tone === 'emerald' && 'text-emerald-500',
        tone === 'amber' && 'text-amber-500',
      )}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Rate breakdown dialog (explainable payroll — click a read-mode row)
// ---------------------------------------------------------------------------
function LinesDialog({ employee, siteName, open, onOpenChange }: {
  employee: PayrollEmployeeVM | null;
  siteName: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const lines: PayrollSalaryLineVM[] = useMemo(() => {
    if (!employee) return [];
    return siteName
      ? employee.sites.find((s) => s.site_name === siteName)?.lines ?? []
      : employee.sites.flatMap((s) => s.lines);
  }, [employee, siteName]);

  if (!employee) return null;

  // group consecutive same-rate segments for a readable breakdown
  const groups: { key: string; role: string; tier: string; rate: number; hours: number; gross: number; site: string }[] = [];
  lines.forEach((l) => {
    const key = `${l.site_name}|${l.salary_role}|${l.experience_tier}|${l.hourly_rate}`;
    const g = groups.find((x) => x.key === key);
    if (g) { g.hours += l.hours; g.gross += l.gross_amount; }
    else groups.push({
      key, role: l.salary_role, tier: l.experience_tier, rate: l.hourly_rate,
      hours: l.hours, gross: l.gross_amount, site: l.site_name,
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Salary calculation — {employee.full_name}</DialogTitle>
          <DialogDescription>
            {siteName ? `Hours & gross at ${siteName}` : 'All sites this month'} · every line is one rate segment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {groups.length === 0 && (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              No rated hours this month{employee.unassigned_hours > 0 ? ` — ${fmtHrs(employee.unassigned_hours)} h have no trade assigned.` : '.'}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.key} className="rounded-lg border bg-muted/20 p-3">
              <p className="text-sm font-semibold">{ROLE_LABEL[g.role] ?? g.role} — {TIER_LABEL[g.tier] ?? g.tier}</p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">{g.site}</p>
              <p className="mt-1 font-mono text-sm">
                {fmtHrs(g.hours)} h × AED {fmtMoney(g.rate)} = <span className="font-semibold text-brand">AED {fmtMoney(g.gross)}</span>
              </p>
            </div>
          ))}
          {employee.unrated_hours > 0 && (
            <p className="flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert size={13} /> {fmtHrs(employee.unrated_hours)} h have a trade but no effective rate — configure the rate in Trade/Ded Management.
            </p>
          )}
          {groups.length > 0 && (
            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Total</span>
              <span className="font-mono font-semibold">
                {fmtHrs(employee.total_hours)} h · AED {fmtMoney(employee.gross_salary)}
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Site group (collapsible) — normal sites AND the trailing Idle Employees
// group. Read mode + edit mode (hours / rate / gross / trade).
// ---------------------------------------------------------------------------
function SiteGroup({
  group, index, onShowLines, editMode, peIdOf, siteDraftOf, onSiteDraftChange,
  onSaveSite, onResetAuto, busyKey, tradeOptions, tradeStateOf, onTradeChange,
  paidOf, settlementOf,
}: {
  group: SalarySheetSiteGroup;
  index: number;
  onShowLines: (employeeId: string, siteName: string) => void;
  editMode: boolean;
  peIdOf: (employeeId: string) => string | undefined;
  siteDraftOf: (peId: string, row: SiteRow) => SiteDraft;
  onSiteDraftChange: (peId: string, siteId: string | null, next: SiteDraft) => void;
  onSaveSite: (peId: string, row: SiteRow, draft: SiteDraft) => void;
  onResetAuto: (employeeId: string) => void;
  busyKey: string | null;
  tradeOptions: Trade[];
  tradeStateOf: (employeeId: string) => TradeState;
  onTradeChange: (employeeId: string, tradeId: string | null) => void;
  paidOf: (employeeId: string) => boolean;
  /** employee-level settlement (advance / deduction / absent deduction) —
   *  set per employee in Payroll; the absent part follows the Payroll page
   *  rule (an edited amount there has priority) */
  settlementOf: (employeeId: string) => {
    advance: number; deduction: number;
    absent_deduction: number; absent_deduction_edited: boolean;
  } | undefined;
}) {
  const [open, setOpen] = useState(true);
  const idle = group.idle === true;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.35), ease: EASE }}
      className={cn(
        'card-glow overflow-hidden rounded-xl border bg-card',
        idle && 'border-dashed',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={16} className="shrink-0 text-muted-foreground" />}
        <span className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          idle ? 'bg-amber-500/15 text-amber-500' : 'bg-brand/15 text-brand',
        )}>
          {idle ? <UserX size={15} /> : <Users size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">
            {group.site_name}
          </h3>
          <p className="text-xs text-muted-foreground">
            {idle
              ? `No site assignment · unassigned hours only — Employees: ${group.employees}`
              : `Employees: ${group.employees} · Hours: ${fmtHrs(group.total_hours)}`}
          </p>
        </div>
        <span className={cn(
          'shrink-0 font-mono text-sm font-semibold',
          idle ? 'text-amber-500' : 'text-brand',
        )}>
          AED {fmtMoney(group.gross_salary)}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">Sl</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead className="hidden md:table-cell">Employee ID</TableHead>
                    <TableHead className={cn(editMode ? 'table-cell' : 'hidden lg:table-cell')}>Trade</TableHead>
                    <TableHead className="hidden xl:table-cell">Nationality</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Gross{idle ? ' (idle)' : ' (site)'}</TableHead>
                    <TableHead className="text-right">Advance</TableHead>
                    <TableHead className="text-right">Deduction</TableHead>
                    {editMode && <TableHead className="w-20 text-right">Save</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.map((r, i) => {
                    const peId = peIdOf(r.employee_id);
                    const draft = peId ? siteDraftOf(peId, r) : null;
                    const rowKey = `${peId ?? ''}|${r.site_id ?? 'none'}`;
                    const busy = busyKey === `site:${rowKey}`;
                    const multiRate = new Set(r.lines.map((l) => `${l.salary_role}|${l.experience_tier}|${l.hourly_rate}`)).size > 1;
                    const firstRate = r.lines[0]?.hourly_rate;
                    // synthetic idle rows have no site row behind them → only
                    // the trade dropdown is editable, never hours/rate/gross
                    const editable = editMode && peId != null && draft != null && r.synthetic !== true;
                    const paid = paidOf(r.employee_id);
                    const empBusy = peId != null && busyKey === `emp:${peId}`;
                    const settlement = settlementOf(r.employee_id);
                    return (
                      <TableRow
                        key={`${r.employee_id}-${r.site_id ?? 'none'}`}
                        className={cn(
                          !editMode && 'cursor-pointer',
                          r.manually_edited && 'bg-amber-500/[0.04]',
                          paid && 'bg-emerald-500/[0.07]',
                        )}
                        onClick={editMode ? undefined : () => onShowLines(r.employee_id, group.site_name)}
                      >
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand/15 text-[11px] font-bold text-brand">
                              {r.photo ? <img src={r.photo} alt="" className="size-full object-cover" /> : initials(r.full_name)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">
                                {r.full_name}
                                {r.manually_edited && (
                                  <span className="ml-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-amber-500">
                                    manual
                                  </span>
                                )}
                                {paid && (
                                  <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-emerald-500">
                                    <BadgeCheck size={10} /> paid
                                  </span>
                                )}
                              </p>
                              <p className="truncate font-mono text-[10px] text-muted-foreground">{r.employee_code}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{r.employee_code}</TableCell>
                        <TableCell className={cn('text-xs', editMode ? 'table-cell' : 'hidden lg:table-cell')}>
                          {(() => {
                            const ts = tradeStateOf(r.employee_id);
                            if (!ts.editable) {
                              return r.trade_name ?? <span className="text-amber-500">no trade</span>;
                            }
                            return (
                              <Select
                                value={ts.value ?? NO_TRADE}
                                onValueChange={(v) => onTradeChange(r.employee_id, v === NO_TRADE ? null : v)}
                              >
                                <SelectTrigger className="h-8 w-36 bg-card text-xs" aria-label={`Trade of ${r.full_name}`}>
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
                            );
                          })()}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">{r.nationality ?? '—'}</TableCell>
                        {editable && draft ? (
                          <>
                            <TableCell className="text-right">
                              <Input
                                type="number" min={0} step="0.25" inputMode="decimal"
                                className="h-8 w-20 border-border/70 bg-card text-right font-mono text-sm"
                                value={draft.hours}
                                onChange={(e) => {
                                  const hours = e.target.value;
                                  const h = Number(hours);
                                  const rt = Number(draft.rate);
                                  onSiteDraftChange(peId!, r.site_id, {
                                    hours, rate: draft.rate,
                                    gross: Number.isFinite(h) && Number.isFinite(rt) ? (h * rt).toFixed(2) : draft.gross,
                                  });
                                }}
                                aria-label={`Hours at ${group.site_name}`}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number" min={0} step="0.25" inputMode="decimal"
                                className="h-8 w-20 border-border/70 bg-card text-right font-mono text-xs"
                                value={draft.rate}
                                onChange={(e) => {
                                  const rate = e.target.value;
                                  const h = Number(draft.hours);
                                  const rt = Number(rate);
                                  onSiteDraftChange(peId!, r.site_id, {
                                    hours: draft.hours, rate,
                                    gross: Number.isFinite(h) && Number.isFinite(rt) ? (h * rt).toFixed(2) : draft.gross,
                                  });
                                }}
                                aria-label={`Hourly rate at ${group.site_name}`}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number" min={0} step="0.01" inputMode="decimal"
                                className="h-8 w-24 border-border/70 bg-card text-right font-mono text-sm"
                                value={draft.gross}
                                onChange={(e) => onSiteDraftChange(peId!, r.site_id, {
                                  hours: draft.hours, rate: draft.rate, gross: e.target.value,
                                })}
                                aria-label={`Gross at ${group.site_name}`}
                              />
                            </TableCell>
                            {/* advance / deduction stay employee-level (Payroll) —
                                shown read-only even in edit mode */}
                            <TableCell className="text-right font-mono text-xs">
                              <span
                                className={settlement && settlement.advance > 0 ? '' : 'text-muted-foreground'}
                                title="Advance is set per employee on the Payroll page"
                              >
                                {settlement && settlement.advance > 0 ? fmtMoney(settlement.advance) : '—'}
                              </span>
                            </TableCell>
                            {/* advance / deduction — employee-level settlement
                                values (same on every site row of the employee);
                                administered on the Payroll page. The deduction
                                shows manual + absent (same rule as Payroll — an
                                absent amount edited there has priority) */}
                            <TableCell className="text-right font-mono text-xs">
                              <span
                                className={settlement && (settlement.deduction + settlement.absent_deduction) > 0 ? '' : 'text-muted-foreground'}
                                title={`Deduction is set per employee on the Payroll page — manual ${fmtMoney(settlement?.deduction ?? 0)}${(settlement?.absent_deduction ?? 0) > 0 ? ` + absent AED ${fmtMoney(settlement?.absent_deduction ?? 0)}${settlement?.absent_deduction_edited ? ' (manually set — priority)' : ''}` : ''}`}
                              >
                                {settlement && (settlement.deduction + settlement.absent_deduction) > 0
                                  ? fmtMoney(settlement.deduction + settlement.absent_deduction)
                                  : '—'}
                                {(settlement?.absent_deduction ?? 0) > 0 && (
                                  <span
                                    className="ml-1 rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-bold text-red-500"
                                    title="Absent deduction — included (editable on the Payroll page; an edited amount has priority over the rule)"
                                  >
                                    A
                                  </span>
                                )}
                                {settlement?.absent_deduction_edited && (
                                  <span
                                    className="ml-1 inline-flex items-center rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                                    title="The absent deduction was edited on the Payroll page — this value has priority over the rule"
                                  >
                                    <Pencil size={9} />
                                  </span>
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="outline" size="icon"
                                  className="size-8 text-emerald-500 hover:text-emerald-400"
                                  disabled={busy}
                                  title="Save this row (the sheet record wins)"
                                  onClick={() => onSaveSite(peId!, r, draft)}
                                >
                                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                </Button>
                                {r.manually_edited && (
                                  <Button
                                    variant="ghost" size="icon" className="size-8"
                                    disabled={empBusy}
                                    title="Return this employee to automatic calculation (all sites)"
                                    onClick={() => onResetAuto(r.employee_id)}
                                  >
                                    {empBusy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell className="text-right font-mono text-sm">{fmtHrs(r.total_hours)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {r.has_missing_rate ? (
                                <span className="text-amber-500">missing rate</span>
                              ) : r.lines.length === 0 ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <span className="underline decoration-dotted underline-offset-4">
                                  {multiRate ? `${new Set(r.lines.map((l) => l.hourly_rate)).size} rates` : `AED ${fmtMoney(firstRate ?? 0)}`}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm font-semibold">AED {fmtMoney(r.gross_salary)}</TableCell>
                            {/* advance / deduction — employee-level settlement
                                values (same on every site row of the employee);
                                administered on the Payroll page */}
                            <TableCell className="text-right font-mono text-xs">
                              <span
                                className={settlement && settlement.advance > 0 ? '' : 'text-muted-foreground'}
                                title="Advance is set per employee on the Payroll page"
                              >
                                {settlement && settlement.advance > 0 ? fmtMoney(settlement.advance) : '—'}
                              </span>
                            </TableCell>
                            {/* advance / deduction — employee-level settlement
                                values (same on every site row of the employee);
                                administered on the Payroll page. The deduction
                                shows manual + absent (same rule as Payroll — an
                                absent amount edited there has priority) */}
                            <TableCell className="text-right font-mono text-xs">
                              <span
                                className={settlement && (settlement.deduction + settlement.absent_deduction) > 0 ? '' : 'text-muted-foreground'}
                                title={`Deduction is set per employee on the Payroll page — manual ${fmtMoney(settlement?.deduction ?? 0)}${(settlement?.absent_deduction ?? 0) > 0 ? ` + absent AED ${fmtMoney(settlement?.absent_deduction ?? 0)}${settlement?.absent_deduction_edited ? ' (manually set — priority)' : ''}` : ''}`}
                              >
                                {settlement && (settlement.deduction + settlement.absent_deduction) > 0
                                  ? fmtMoney(settlement.deduction + settlement.absent_deduction)
                                  : '—'}
                                {(settlement?.absent_deduction ?? 0) > 0 && (
                                  <span
                                    className="ml-1 rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-bold text-red-500"
                                    title="Absent deduction — included (editable on the Payroll page; an edited amount has priority over the rule)"
                                  >
                                    A
                                  </span>
                                )}
                                {settlement?.absent_deduction_edited && (
                                  <span
                                    className="ml-1 inline-flex items-center rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                                    title="The absent deduction was edited on the Payroll page — this value has priority over the rule"
                                  >
                                    <Pencil size={9} />
                                  </span>
                                )}
                              </span>
                            </TableCell>
                            {editMode && <TableCell />}
                          </>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function SalarySheetPage() {
  const realtimeVersion = useRealtimeVersion(['payroll_period', 'payroll_employee', 'attendance', 'employee', 'trade_rate_history']);
  // branch/site scoping data — powers the BRANCH dropdown in the top row
  const branchVersion = useRealtimeVersion(['site', 'branch', 'admin_branch', 'admin_site', 'profiles']);
  const isSuperAdmin = useAuthStore((s) => s.user?.role) === 'super_admin';

  // SHARED payroll period — the Payroll page uses the same selection
  const year = useAppStore((s) => s.salaryPeriodYear);
  const month = useAppStore((s) => s.salaryPeriodMonth);
  const setSalaryPeriod = useAppStore((s) => s.setSalaryPeriod);
  // SHARED branch scope — the Payroll page uses the same selection
  const branchFilter = useAppStore((s) => s.salaryPeriodBranchId);
  const setBranchFilter = useAppStore((s) => s.setSalaryPeriodBranch);

  const [report, setReport] = useState<SalarySheetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [linesTarget, setLinesTarget] = useState<{ employeeId: string; siteName: string | null } | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  // ---- edit mode (the sheet record has priority) ---------------------------
  const [editMode, setEditMode] = useState(false);
  const [tradeOptions, setTradeOptions] = useState<Trade[]>([]);
  const [siteDrafts, setSiteDrafts] = useState<Record<string, SiteDraft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // ---- search (name / employee ID / trade) — filters rows inside every
  //      site section; empty sections are hidden -------------------------------
  const [search, setSearch] = useState('');
  // ---- audit trail — collapsed behind a pill button (same as Payroll) -------
  const [auditOpen, setAuditOpen] = useState(false);

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

  // SILENT REFRESH — skeleton only on the FIRST load of a period (same
  // pattern as the Payroll page): later reloads (row edited, trade picked,
  // realtime bump) keep the sheet mounted and update in place, so the scroll
  // position and the row being edited stay put.
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
        toast.error(err instanceof Error ? err.message : 'Failed to load salary sheet');
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [year, month, realtimeVersion]);

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

  const employeeById = useMemo(
    () => new Map((report?.employees ?? []).map((e) => [e.employee_id, e])),
    [report],
  );
  const linesEmployee = linesTarget ? employeeById.get(linesTarget.employeeId) ?? null : null;

  /** employee_id → payroll_employee id (the settlement row id) */
  const peIdOf = useCallback(
    (employeeId: string): string | undefined => employeeById.get(employeeId)?.id,
    [employeeById],
  );

  /** paid employees are green in EVERY section they appear in */
  const paidOf = useCallback(
    (employeeId: string): boolean => employeeById.get(employeeId)?.payment_status === 'paid',
    [employeeById],
  );

  /** employee-level settlement (advance / deduction / absent deduction) for
   *  the new columns — same value on every site row of the employee; edited
   *  on the Payroll page (an edited absent deduction has priority) */
  const settlementOf = useCallback(
    (employeeId: string): {
      advance: number; deduction: number;
      absent_deduction: number; absent_deduction_edited: boolean;
    } | undefined => {
      const e = employeeById.get(employeeId);
      return e ? {
        advance: e.advance,
        deduction: e.deduction,
        absent_deduction: e.absent_deduction ?? 0,
        absent_deduction_edited: !!e.absent_deduction_edited,
      } : undefined;
    },
    [employeeById],
  );

  const siteDraftOf = useCallback((peId: string, r: SiteRow): SiteDraft =>
    siteDrafts[`${peId}|${r.site_id ?? 'none'}`] ?? {
      hours: String(r.total_hours),
      rate: String(effRateOf(r)),
      gross: r.gross_salary.toFixed(2),
    }, [siteDrafts]);

  const onSiteDraftChange = useCallback((peId: string, siteId: string | null, next: SiteDraft): void => {
    setSiteDrafts((prev) => ({ ...prev, [`${peId}|${siteId ?? 'none'}`]: next }));
  }, []);

  const onSaveSite = async (peId: string, r: SiteRow, draft: SiteDraft): Promise<void> => {
    const key = `${peId}|${r.site_id ?? 'none'}`;
    const hours = Number(draft.hours);
    const rate = Number(draft.rate);
    const gross = Number(draft.gross);
    if (!Number.isFinite(hours) || hours < 0) { toast.error('Hours must be 0 or more'); return; }
    if (!Number.isFinite(gross) || gross < 0) { toast.error('Gross must be 0 or more'); return; }
    setBusyKey(`site:${key}`);
    try {
      await dataApi.updateSalarySheetRow({
        payroll_employee_id: peId,
        sites: [{
          site_id: r.site_id,
          total_hours: Math.round(hours * 100) / 100,
          hourly_rate: Number.isFinite(rate) && rate >= 0 ? Math.round(rate * 100) / 100 : null,
          gross_salary: Math.round(gross * 100) / 100,
        }],
      });
      toast.success('Row saved', {
        description: `${r.full_name} @ ${r.site_name} — ${fmtHrs(hours)} h · AED ${fmtMoney(gross)} (protected from recalculation)`,
      });
      setSiteDrafts((prev) => { const n = { ...prev }; delete n[key]; return n; });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusyKey(null);
    }
  };

  const onResetAuto = async (employeeId: string): Promise<void> => {
    const e = employeeById.get(employeeId);
    if (!e) return;
    setBusyKey(`emp:${e.id}`);
    try {
      await dataApi.resetPayrollEmployeeAuto(e.id);
      toast.success('Back to automatic calculation', {
        description: `${e.full_name} was re-priced from attendance, trades & rates.`,
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setBusyKey(null);
    }
  };

  // ---- change an employee's trade straight from the sheet (edit mode) -----
  // Immediate save: the pick overwrites the stored trade + assignment history
  // (effective from the 1st of the payroll month) and re-prices the month.
  const onTradeChange = async (employeeId: string, tradeId: string | null): Promise<void> => {
    const e = employeeById.get(employeeId);
    if (!e) return;
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
      toast.success('Trade updated from the sheet', {
        description: `${e.full_name} → ${tName} — stored trade overwritten, month re-priced.`,
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change trade');
    } finally {
      setBusyKey(null);
    }
  };

  /** live trade dropdown state for a site row (edit mode only) */
  const tradeStateOf = useCallback((employeeId: string): TradeState => {
    const e = employeeById.get(employeeId);
    return {
      value: e?.trade_id ?? null,
      editable: editMode && !!e && e.payment_status !== 'paid' && e.status !== 'deleted',
      busy: !!e && busyKey === `trade:${e.id}`,
    };
  }, [employeeById, editMode, busyKey]);

  const toggleEditMode = (): void => {
    setEditMode((o) => !o);
    setSiteDrafts({});
  };

  const period = report?.period ?? null;
  const finalized = period?.status === 'finalized';

  // ---- BRANCH-WISE scoping (the top-row Branch dropdown) --------------------
  // A site section belongs to the owner branch of its site; the idle group
  // (no site) belongs to no branch. Normal admins are limited to their granted
  // branches' sites (+ directly assigned sites) and never see the idle group.
  const branchIdOfSite = useMemo(
    () => new Map((sites ?? []).map((s) => [s.id, s.branch_id ?? null] as const)),
    [sites],
  );
  const allowedSiteIds = useMemo<Set<string> | null>(() => {
    if (isSuperAdmin) return null;
    const granted = new Set((branches ?? []).map((b) => b.id));
    const ids = new Set<string>();
    (sites ?? []).forEach((s) => {
      if ((s.branch_id && granted.has(s.branch_id)) || (assignedSiteIds ?? new Set()).has(s.id)) ids.add(s.id);
    });
    return ids;
  }, [isSuperAdmin, branches, sites, assignedSiteIds]);

  const allIdleGroups = useMemo(() => report?.sites.filter((g) => g.idle) ?? [], [report]);
  const allSiteGroups = useMemo(() => report?.sites.filter((g) => g.idle !== true) ?? [], [report]);

  const scopedSiteGroups = useMemo(() => {
    const base = !isSuperAdmin
      ? allSiteGroups.filter((g) => g.site_id != null && (allowedSiteIds ?? new Set()).has(g.site_id))
      : allSiteGroups;
    if (branchFilter === 'all') return base;
    if (branchFilter === FILTER_NONE) {
      return base.filter((g) => g.site_id == null || (branchIdOfSite.get(g.site_id) ?? null) === null);
    }
    return base.filter((g) => g.site_id != null && branchIdOfSite.get(g.site_id) === branchFilter);
  }, [isSuperAdmin, allSiteGroups, allowedSiteIds, branchFilter, branchIdOfSite]);

  const scopedIdleGroups = useMemo(() => {
    // idle employees belong to no branch → super admins see them under
    // "All branches" and "No branch"; normal admins never do
    if (!isSuperAdmin) return [];
    return branchFilter === 'all' || branchFilter === FILTER_NONE ? allIdleGroups : [];
  }, [isSuperAdmin, branchFilter, allIdleGroups]);

  // employees that appear in the SCOPE (distinct — a moved employee can sit
  // in several site sections) — drives the branch-scoped summary cards + CSV
  const scopedEmployeeIds = useMemo(() => {
    const ids = new Set<string>();
    scopedSiteGroups.forEach((g) => g.rows.forEach((r) => ids.add(r.employee_id)));
    scopedIdleGroups.forEach((g) => g.rows.forEach((r) => ids.add(r.employee_id)));
    return ids;
  }, [scopedSiteGroups, scopedIdleGroups]);
  const scopedEmployees = useMemo(
    () => (report?.employees ?? []).filter((e) => scopedEmployeeIds.has(e.employee_id)),
    [report, scopedEmployeeIds],
  );

  const branchScopeActive = branchFilter !== 'all' || !isSuperAdmin;
  const selectedBranchName = branchFilter === 'all'
    ? null
    : branchFilter === FILTER_NONE
      ? 'No branch'
      : (branches ?? []).find((b) => b.id === branchFilter)?.name ?? null;

  // branch-scoped summary values (used by the cards + CSV when a scope is
  // active; otherwise the period totals from the report stay authoritative)
  const scopedSummary = useMemo(() => {
    const employees = scopedEmployees.length;
    const totalHours = Math.round(scopedSiteGroups.concat(scopedIdleGroups)
      .reduce((n, g) => n + g.rows.reduce((m, r) => m + r.total_hours, 0), 0) * 100) / 100;
    const gross = Math.round(scopedEmployees.reduce((n, e) => n + e.gross_salary, 0) * 100) / 100;
    const advances = Math.round(scopedEmployees.reduce((n, e) => n + e.advance, 0) * 100) / 100;
    const deductions = Math.round(scopedEmployees.reduce(
      (n, e) => n + e.deduction + (e.absent_deduction ?? 0), 0) * 100) / 100;
    const paid = scopedEmployees.filter((e) => e.payment_status === 'paid').length;
    return { employees, totalHours, gross, advances, deductions, paid, unpaid: employees - paid };
  }, [scopedEmployees, scopedSiteGroups, scopedIdleGroups]);

  const exportCsv = (): void => {
    if (!report) return;
    // follows the BRANCH scope — only the selected branch's sections and
    // employees are exported (all sites when "All branches" is picked)
    const rows: string[][] = [['Site', 'Sl', 'Employee', 'Employee ID', 'Trade', 'Nationality', 'Hours', 'Rate (AED/h)', 'Gross (AED)', 'Advance (AED)', 'Deduction (AED)']];
    scopedSiteGroups.concat(scopedIdleGroups).forEach((g) => g.rows.forEach((r, i) => {
      const emp = employeeById.get(r.employee_id);
      rows.push([
        g.site_name, String(i + 1), r.full_name, r.employee_code,
        r.trade_name ?? '', r.nationality ?? '', fmtHrs(r.total_hours),
        r.has_missing_rate ? '' : fmtMoney(effRateOf(r)), fmtMoney(r.gross_salary),
        emp && emp.advance > 0 ? fmtMoney(emp.advance) : '',
        emp && (emp.deduction + (emp.absent_deduction ?? 0)) > 0
          ? fmtMoney(emp.deduction + (emp.absent_deduction ?? 0)) : '',
      ]);
    }));
    const summary: string[][] = [['', ''], ['EMPLOYEES', ''], ['Employee', 'Employee ID', 'Trade', 'Total Hours', 'Gross', 'Advance', 'Deduction', 'Status']];
    scopedEmployees.forEach((e) => summary.push([
      e.full_name, e.employee_code, e.trade_name ?? '',
      fmtHrs(e.total_hours), fmtMoney(e.gross_salary),
      e.advance > 0 ? fmtMoney(e.advance) : '',
      (e.deduction + (e.absent_deduction ?? 0)) > 0
        ? fmtMoney(e.deduction + (e.absent_deduction ?? 0)) : '',
      e.payment_status,
    ]));
    const csv = [...rows, ...summary]
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const branchSlug = branchFilter === 'all'
      ? ''
      : `-${(selectedBranchName ?? 'branch').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    a.download = `salary-sheet${branchSlug}-${year}-${String(month).padStart(2, '0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // search narrows the rows inside every group; the group counters are
  // recomputed from the visible rows and empty groups are hidden entirely
  const searchActive = search.trim() !== '';
  const matchesRow = useCallback((r: SiteRow): boolean => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.full_name.toLowerCase().includes(q)
      || r.employee_code.toLowerCase().includes(q)
      || (r.trade_name ?? '').toLowerCase().includes(q);
  }, [search]);

  const filterGroups = useCallback((groups: SalarySheetSiteGroup[]): SalarySheetSiteGroup[] =>
    groups
      .map((g) => {
        const rows = g.rows.filter(matchesRow);
        return {
          ...g,
          rows,
          employees: rows.length,
          total_hours: Math.round(rows.reduce((n, r) => n + r.total_hours, 0) * 100) / 100,
          gross_salary: Math.round(rows.reduce((n, r) => n + r.gross_salary, 0) * 100) / 100,
        };
      })
      .filter((g) => g.rows.length > 0), [matchesRow]);

  const visibleSiteGroups = useMemo(() => filterGroups(scopedSiteGroups), [filterGroups, scopedSiteGroups]);
  const visibleIdleGroups = useMemo(() => filterGroups(scopedIdleGroups), [filterGroups, scopedIdleGroups]);
  const visibleRowCount = visibleSiteGroups.reduce((n, g) => n + g.rows.length, 0)
    + visibleIdleGroups.reduce((n, g) => n + g.rows.length, 0);
  const totalRowCount = scopedSiteGroups.reduce((n, g) => n + g.rows.length, 0)
    + scopedIdleGroups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      {/* sticky action bar — Edit / CSV / Finalize stay visible while scrolling */}
      <div className="sticky top-16 z-30 rounded-xl border border-border/60 bg-background/90 px-3 py-2.5 shadow-lg shadow-black/[0.04] backdrop-blur-xl">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="shrink-0 rounded-lg bg-brand/10 p-1.5 text-brand"><Wallet size={16} /></div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">
                Salary Sheet{selectedBranchName ? ` — ${selectedBranchName}` : ''}
              </h1>
              <p className="truncate text-xs text-muted-foreground">Site-wise hours, rates &amp; gross — the salary calculation source of truth</p>
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
          {/* BRANCH dropdown — branch-wise separation: picking a branch loads
              only that branch's site sections, cards and CSV export */}
          <Select value={branchFilter} onValueChange={setBranchFilter}>
            <SelectTrigger
              className="h-10 w-[170px] shrink-0 bg-card sm:w-48"
              aria-label="Filter salary sheet by branch"
              title="Show only the selected branch's salary sheet"
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
          {report?.exists && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <FileSpreadsheet size={14} /> CSV
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

        {/* search — always visible while scrolling; filters rows in every section */}
        <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5">
          <div className="relative flex-1">
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
          {searchActive && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title="Rows shown / total">
              {visibleRowCount}/{totalRowCount}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : !report || !report.exists ? (
        <EmptyState
          icon={<Wallet size={22} />}
          title={`No payroll for ${MONTH_NAMES[month - 1]} ${year}`}
          description="Generate the month's payroll — the database calculates every employee's hours, rate tiers and gross per site."
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
                <b>Edit mode</b> — pick the trade from the dropdown, override hours / rate / gross.
                Saved values <b>overwrite the stored data</b> and are protected from automatic recalculation
                (attendance edits will no longer change them). Use the ↺ button to return an employee to
                automatic pricing. Advances, deductions and payments are managed in <b>Payroll</b>.
              </span>
            </p>
          )}

          {/* summary cards — branch-scoped when a branch is picked (the
              selected branch's sheet is what loads); period totals otherwise */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard index={0} icon={<Users size={12} />} label="Employees"
              value={String(branchScopeActive ? scopedSummary.employees : report.totals.employees)} />
            <StatCard index={1} icon={<Clock size={12} />} label="Total hours"
              value={fmtHrs(branchScopeActive ? scopedSummary.totalHours : report.totals.total_hours)} />
            <StatCard index={2} icon={<Banknote size={12} />} label="Gross salary"
              value={`AED ${fmtMoney(branchScopeActive ? scopedSummary.gross : report.totals.gross_salary)}`} tone="brand"
              hint={`Adv. ${fmtMoney(branchScopeActive ? scopedSummary.advances : report.totals.advances)} · Ded. ${fmtMoney(branchScopeActive ? scopedSummary.deductions : report.totals.deductions)}`} />
            <StatCard index={3} icon={<BadgeCheck size={12} />} label="Paid"
              value={`${branchScopeActive ? scopedSummary.paid : report.totals.paid_count} / ${branchScopeActive ? scopedSummary.employees : report.totals.employees}`} tone="emerald"
              hint={`${branchScopeActive ? scopedSummary.unpaid : report.totals.unpaid_count} unpaid`} />
          </div>

          {/* site groups (historical site attribution) — scoped to the
              selected branch */}
          {scopedSiteGroups.length === 0 && scopedIdleGroups.length === 0 ? (
            <EmptyState
              icon={<GitBranch size={22} />}
              title={branchScopeActive
                ? `No employee hours in ${selectedBranchName ?? 'your branches'} this month`
                : 'No employee hours this month'}
              description={branchScopeActive
                ? 'Either no attendance was marked at this branch\u2019s sites yet, or no sites are assigned to it. Pick another branch or check All branches.'
                : 'Mark attendance first — the salary sheet prices every hour at the site where it was worked.'}
            />
          ) : visibleRowCount === 0 ? (
            <EmptyState
              icon={<Search size={22} />}
              title="No matching employees"
              description={`No employee matches “${search.trim()}” — try another name, ID or trade.`}
            />
          ) : (
            <div className="space-y-4">
              {visibleSiteGroups.map((g, i) => (
                <SiteGroup
                  key={g.site_id ?? 'none'}
                  group={g}
                  index={i}
                  editMode={editMode}
                  peIdOf={peIdOf}
                  siteDraftOf={siteDraftOf}
                  onSiteDraftChange={onSiteDraftChange}
                  onSaveSite={(peId, row, draft) => { void onSaveSite(peId, row, draft); }}
                  onResetAuto={(employeeId) => { void onResetAuto(employeeId); }}
                  busyKey={busyKey}
                  tradeOptions={tradeOptions}
                  tradeStateOf={tradeStateOf}
                  onTradeChange={(employeeId, tradeId) => { void onTradeChange(employeeId, tradeId); }}
                  paidOf={paidOf}
                  settlementOf={settlementOf}
                  onShowLines={(employeeId, siteName) => setLinesTarget({ employeeId, siteName })}
                />
              ))}
              {/* Idle Employees — the last section */}
              {visibleIdleGroups.map((g, i) => (
                <SiteGroup
                  key="idle-employees"
                  group={g}
                  index={scopedSiteGroups.length + i}
                  editMode={editMode}
                  peIdOf={peIdOf}
                  siteDraftOf={siteDraftOf}
                  onSiteDraftChange={onSiteDraftChange}
                  onSaveSite={(peId, row, draft) => { void onSaveSite(peId, row, draft); }}
                  onResetAuto={(employeeId) => { void onResetAuto(employeeId); }}
                  busyKey={busyKey}
                  tradeOptions={tradeOptions}
                  tradeStateOf={tradeStateOf}
                  onTradeChange={(employeeId, tradeId) => { void onTradeChange(employeeId, tradeId); }}
                  paidOf={paidOf}
                  settlementOf={settlementOf}
                  onShowLines={(employeeId, siteName) => setLinesTarget({ employeeId, siteName })}
                />
              ))}
            </div>
          )}

          {/* audit trail — collapsed behind an expandable icon button (same
              behaviour as the Payroll page) */}
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
                  <SectionTitle icon={<History size={16} />} title="Audit trail" sub={`All ${report.audit.length} entries — finalizations, reopens, edits and payments`} />
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
      <LinesDialog
        employee={linesEmployee}
        siteName={linesTarget?.siteName ?? null}
        open={linesTarget !== null}
        onOpenChange={(v) => { if (!v) setLinesTarget(null); }}
      />
      <FinalizeDialog report={report} open={finalizeOpen} onOpenChange={setFinalizeOpen} onDone={load} />
      <ReopenDialog report={report} open={reopenOpen} onOpenChange={setReopenOpen} onDone={load} />
    </div>
  );
}
