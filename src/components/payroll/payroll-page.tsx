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
//   • hovering / tapping Total Hours opens the complete calculation breakdown
//     (site distribution, qualification, every rate line) — read from the
//     sheet records, never recalculated here
//   • advance / deduction / net settlement and the Paid/Unpaid toggle live
//     here; marking paid turns the employee's rows green in every Salary
//     Sheet section
//   • reverting a payment is super-admin only and audited with a reason
//   • shares the selected month with the Salary Sheet (app store)
// ============================================================================

import { motion } from 'framer-motion';
import {
  BadgeCheck, Banknote, Check, Clock, Loader2, Lock, LockOpen, PencilLine,
  TriangleAlert, UserX, Users, Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { FinalizeDialog, ReopenDialog } from '@/components/salary-sheet/period-dialogs';
import { dataApi } from '@/lib/data';
import { fmtDate, fmtDateTime, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type PayrollEmployeeVM, type SalarySheetReport,
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
  below_threshold: 'Below threshold', qualified: 'Qualified', manual: 'Manual',
};

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

  const lineSum = Math.round(groups.reduce((n, g) => n + g.gross, 0) * 100) / 100;
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
          {qual.qualified ? 'Qualified' : 'Below threshold'}
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
          This month: <span className="font-mono text-foreground">{fmtHrs(e.below_threshold_hours)} h</span> below threshold ·
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
                  <TableHead className="text-right">Below thr.</TableHead>
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
          <TriangleAlert size={13} /> {fmtHrs(e.unrated_hours)} h have a trade but no effective rate — configure the rate in Trade Management.
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
        <HoverCardContent side="top" align="start" className="w-[min(580px,88vw)] max-h-[70vh] overflow-y-auto">
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
// Adjustment dialog (advance / deduction / notes) — settlement administration
// ---------------------------------------------------------------------------
function AdjustmentDialog({ employee, open, onOpenChange, onSaved }: {
  employee: PayrollEmployeeVM | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [advance, setAdvance] = useState('0');
  const [deduction, setDeduction] = useState('0');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && employee) {
      setAdvance(String(employee.advance));
      setDeduction(String(employee.deduction));
      setNotes(employee.notes ?? '');
    }
  }, [open, employee]);

  if (!employee) return null;

  const adv = Number(advance) || 0;
  const ded = Number(deduction) || 0;
  const net = Math.round((employee.gross_salary - adv - ded) * 100) / 100;

  const submit = async (): Promise<void> => {
    if (adv < 0 || ded < 0) { toast.error('Advance and deduction must be 0 or more'); return; }
    setSaving(true);
    try {
      await dataApi.updatePayrollAdjustment(employee.id, {
        advance: adv, deduction: ded, notes: notes.trim() || null,
      });
      toast.success('Adjustment saved', { description: `${employee.full_name} — net AED ${fmtMoney(net)}` });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust settlement — {employee.full_name}</DialogTitle>
          <DialogDescription>Advances and deductions belong to the employee&apos;s monthly settlement, not to any site.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Advance (AED)</Label>
              <Input type="number" min={0} step="0.01" value={advance}
                onChange={(e) => setAdvance(e.target.value)} className="h-11 bg-card font-mono" />
            </div>
            <div className="space-y-2">
              <Label>Deduction (AED)</Label>
              <Input type="number" min={0} step="0.01" value={deduction}
                onChange={(e) => setDeduction(e.target.value)} className="h-11 bg-card font-mono" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Remarks</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional remarks" className="h-11" />
          </div>
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Gross salary</span><span className="font-mono">AED {fmtMoney(employee.gross_salary)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">− Advance − Deduction</span><span className="font-mono">AED {fmtMoney(adv + ded)}</span></div>
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
              <span>Net salary</span><span className="font-mono text-brand">AED {fmtMoney(net)}</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Payment dialog (mark paid — records who and when)
// ---------------------------------------------------------------------------
function PaymentDialog({ employee, open, onOpenChange, onSaved }: {
  employee: PayrollEmployeeVM | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [advance, setAdvance] = useState('0');
  const [deduction, setDeduction] = useState('0');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && employee) {
      setAdvance(String(employee.advance));
      setDeduction(String(employee.deduction));
      setNotes(employee.notes ?? '');
    }
  }, [open, employee]);

  if (!employee) return null;

  const adv = Number(advance) || 0;
  const ded = Number(deduction) || 0;
  const net = Math.round((employee.gross_salary - adv - ded) * 100) / 100;

  const submit = async (): Promise<void> => {
    if (adv < 0 || ded < 0) { toast.error('Advance and deduction must be 0 or more'); return; }
    setSaving(true);
    try {
      await dataApi.markPayrollPaid(employee.id, {
        advance: adv, deduction: ded, notes: notes.trim() || null, paid: true,
      });
      toast.success('Marked as paid', {
        description: `${employee.full_name} — AED ${fmtMoney(net)}. Green in every Salary Sheet section.`,
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Advance (AED)</Label>
              <Input type="number" min={0} step="0.01" value={advance}
                onChange={(e) => setAdvance(e.target.value)} className="h-11 bg-card font-mono" />
            </div>
            <div className="space-y-2">
              <Label>Deduction (AED)</Label>
              <Input type="number" min={0} step="0.01" value={deduction}
                onChange={(e) => setDeduction(e.target.value)} className="h-11 bg-card font-mono" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Remarks</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remarks" className="h-11" />
          </div>
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Gross salary</span><span className="font-mono">AED {fmtMoney(employee.gross_salary)}</span></div>
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
              <span>Net salary payable</span><span className="font-mono text-emerald-500">AED {fmtMoney(net)}</span>
            </div>
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
  const isSuperAdmin = useAuthStore((s) => s.user?.role) === 'super_admin';

  // SHARED payroll period — the Salary Sheet uses the same selection
  const year = useAppStore((s) => s.salaryPeriodYear);
  const month = useAppStore((s) => s.salaryPeriodMonth);
  const setSalaryPeriod = useAppStore((s) => s.setSalaryPeriod);

  const [report, setReport] = useState<SalarySheetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [adjustTarget, setAdjustTarget] = useState<PayrollEmployeeVM | null>(null);
  const [payTarget, setPayTarget] = useState<PayrollEmployeeVM | null>(null);
  const [unpayTarget, setUnpayTarget] = useState<PayrollEmployeeVM | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  const load = (): void => {
    setLoading(true);
    dataApi.getSalarySheet(year, month)
      .then(setReport)
      .catch((err) => {
        setReport(null);
        toast.error(err instanceof Error ? err.message : 'Failed to load payroll');
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [year, month, realtimeVersion]);

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

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* sticky action bar — Finalize / Reopen stay visible while scrolling */}
      <div className="sticky top-16 z-30 rounded-xl border border-border/60 bg-background/90 px-3 py-2.5 shadow-lg shadow-black/[0.04] backdrop-blur-xl">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="shrink-0 rounded-lg bg-brand/10 p-1.5 text-brand"><Banknote size={16} /></div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Payroll — {MONTH_NAMES[month - 1]} {year}</h1>
              <p className="truncate text-xs text-muted-foreground">One row per employee — consolidated across all sites</p>
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
      </div>

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
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
          {/* totals */}
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { icon: <Users size={12} />, label: 'Total employees', value: String(report.totals.employees), hint: `${report.totals.paid_count} paid · ${report.totals.unpaid_count} unpaid`, tone: 'default' as const },
              { icon: <Banknote size={12} />, label: 'Total gross salary', value: `AED ${fmtMoney(report.totals.gross_salary)}`, hint: 'Reconciles with the Salary Sheet', tone: 'brand' as const },
              { icon: <Wallet size={12} />, label: 'Net payable', value: `AED ${fmtMoney(report.totals.net_payable)}`, hint: `Adv. ${fmtMoney(report.totals.advances)} · Ded. ${fmtMoney(report.totals.deductions)}`, tone: 'emerald' as const },
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
                )}
              >
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {c.icon} {c.label}
                </p>
                <p className={cn(
                  'mt-1.5 text-2xl font-bold tracking-tight tabular-nums',
                  c.tone === 'brand' && 'text-brand',
                  c.tone === 'emerald' && 'text-emerald-500',
                )}>
                  {c.value}
                </p>
                {c.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{c.hint}</p>}
              </motion.div>
            ))}
          </div>

          {/* consolidated table — ONE row per employee */}
          <section className="card-glow overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">Sl No</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Total Hours</TableHead>
                    <TableHead>Trade</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employees.map((e, i) => {
                    const paid = e.payment_status === 'paid';
                    return (
                      <TableRow
                        key={e.id}
                        className={cn(
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
                              <p className="truncate text-sm font-medium">
                                {e.full_name}
                                {e.manually_edited && (
                                  <span className="ml-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-amber-500">
                                    manual
                                  </span>
                                )}
                              </p>
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
                          {e.trade_name ?? <span className="text-amber-500">no trade</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">
                          AED {fmtMoney(e.gross_salary)}
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
                              <>
                                <Button
                                  variant="ghost" size="icon" className="size-8"
                                  disabled={paid}
                                  title="Adjust advance / deduction"
                                  onClick={() => setAdjustTarget(e)}
                                >
                                  <PencilLine size={14} />
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={!finalized}
                                  title={finalized ? 'Mark the monthly salary paid' : 'Finalize the payroll first'}
                                  onClick={() => setPayTarget(e)}
                                  className="h-8 brand-gradient px-3 text-xs font-semibold text-white"
                                >
                                  <BadgeCheck size={13} className="mr-1" /> Mark paid
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {employees.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                        No employees in this payroll period.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="flex items-center gap-1.5 border-t px-4 py-2.5 text-[11px] text-muted-foreground">
              <UserX size={12} className="shrink-0" />
              Hover (or tap) a Total Hours value for the complete calculation. Employees without a site are listed under Idle Employees in the Salary Sheet.
            </p>
          </section>

          {/* audit trail */}
          {report.audit.length > 0 && (
            <section className="card-glow rounded-xl border bg-card p-5">
              <SectionTitle icon={<Clock size={16} />} title="Audit trail" sub="Payments, reverts, finalizations and reopens" />
              <div className="mt-3 space-y-1.5">
                {report.audit.map((a) => (
                  <p key={a.id} className="text-xs text-muted-foreground">
                    <span className="font-mono">{fmtDateTime(a.created_at)}</span>
                    {' · '}<span className="font-semibold text-foreground">{a.actor_name ?? 'System'}</span>
                    {' · '}{a.details}
                  </p>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* dialogs */}
      <AdjustmentDialog
        employee={adjustTarget}
        open={adjustTarget !== null}
        onOpenChange={(v) => { if (!v) setAdjustTarget(null); }}
        onSaved={load}
      />
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
