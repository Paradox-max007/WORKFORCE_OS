'use client';

// ============================================================================
// PULSE Workforce OS — Salary Sheet (monthly payroll)
// ----------------------------------------------------------------------------
// Displays the DATABASE-CALCULATED payroll (get_salary_sheet RPC / demo
// engine). The frontend never calculates salary — it renders the verified
// result and handles the settlement workflow:
//
//   • month selector + status (Draft recalculation live / Finalized snapshot)
//   • summary cards: employees, total hours, gross, advances, deductions, net
//   • site groups: per-employee hours & gross AT THAT SITE (historical site
//     attribution), with a click-through rate breakdown
//   • consolidated Employee Settlement table: advance / deduction / net are
//     settled exactly ONCE per employee per month (never repeated per site)
//   • payment + adjustment + finalize + audited reopen dialogs
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck, Banknote, ChevronDown, ChevronRight, Clock, FileSpreadsheet,
  Loader2, Lock, LockOpen, PencilLine, TriangleAlert, Users, Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, SectionTitle } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { dataApi } from '@/lib/data';
import { fmtDate, fmtDateTime, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type PayrollEmployeeVM, type PayrollSalaryLineVM, type SalarySheetReport,
} from '@/lib/types';
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
  below_threshold: 'Below eligibility', qualified: 'Qualified',
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
// Rate breakdown dialog (spec §5.3 — explainable payroll)
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
              <TriangleAlert size={13} /> {fmtHrs(employee.unrated_hours)} h have a trade but no effective rate — configure the rate in Trade Management.
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
// Adjustment dialog (advance / deduction / notes)
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
// Payment dialog (enter values, confirm Mark Paid)
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
      toast.success('Marked as paid', { description: `${employee.full_name} — AED ${fmtMoney(net)}` });
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
            Payment is recorded with your name and today&apos;s date. Paid records are protected from ordinary editing.
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
            Confirm & Mark Paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Finalize / Reopen dialogs
// ---------------------------------------------------------------------------
function FinalizeDialog({ report, open, onOpenChange, onDone }: {
  report: SalarySheetReport | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!report?.period) return null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await dataApi.finalizePayroll(report.period!.id);
      toast.success('Payroll finalized', {
        description: 'The calculation is locked as a snapshot. Payments can now be recorded.',
      });
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to finalize');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Finalize {MONTH_NAMES[report.period.month - 1]} {report.period.year} payroll?</DialogTitle>
          <DialogDescription>
            The calculated hours, rates and gross amounts are stored as a locked snapshot.
            Later attendance corrections or rate edits will NOT change this payroll — corrections
            require an audited reopen.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Employees</span><span className="font-mono">{report.totals.employees}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Total hours</span><span className="font-mono">{fmtHrs(report.totals.total_hours)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Gross salary</span><span className="font-mono">AED {fmtMoney(report.totals.gross_salary)}</span></div>
          <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
            <span>Net payable</span><span className="font-mono text-brand">AED {fmtMoney(report.totals.net_payable)}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="brand-gradient font-semibold text-white">
            {busy ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Lock size={15} className="mr-1" />}
            Finalize Payroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReopenDialog({ report, open, onOpenChange, onDone }: {
  report: SalarySheetReport | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!report?.period) return null;

  const submit = async (): Promise<void> => {
    if (!reason.trim()) { toast.error('A reason is required to reopen'); return; }
    setBusy(true);
    try {
      await dataApi.reopenPayroll(report.period!.id, reason.trim());
      toast.success('Payroll reopened', { description: 'The previous snapshot and your reason were recorded in the audit log.' });
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reopen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen {MONTH_NAMES[report.period.month - 1]} {report.period.year} payroll?</DialogTitle>
          <DialogDescription>
            The payroll returns to draft and recalculates from current data. The reopen is
            audited: your name, the reason and the previous totals are recorded.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Reason *</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Attendance corrections for site B crew" className="h-11" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy} variant="destructive" className="font-semibold">
            {busy ? <Loader2 size={15} className="mr-1 animate-spin" /> : <LockOpen size={15} className="mr-1" />}
            Reopen with Reason
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Site group (collapsible)
// ---------------------------------------------------------------------------
function SiteGroup({ group, index, onShowLines }: {
  group: SalarySheetReport['sites'][number];
  index: number;
  onShowLines: (employeeId: string, siteName: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const employeeById = useMemo(() => new Map(group.rows.map((r) => [r.employee_id, r])), [group]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.05, 0.35), ease: EASE }}
      className="card-glow overflow-hidden rounded-xl border bg-card"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={16} className="shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{group.site_name}</h3>
          <p className="text-xs text-muted-foreground">
            Employees: {group.employees} · Hours: {fmtHrs(group.total_hours)}
          </p>
        </div>
        <span className="shrink-0 font-mono text-sm font-semibold text-brand">AED {fmtMoney(group.gross_salary)}</span>
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
                    <TableHead className="hidden lg:table-cell">Trade</TableHead>
                    <TableHead className="hidden xl:table-cell">Nationality</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Gross (site)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.map((r, i) => {
                    const emp = employeeById.get(r.employee_id);
                    const multiRate = new Set(r.lines.map((l) => `${l.salary_role}|${l.experience_tier}|${l.hourly_rate}`)).size > 1;
                    const firstRate = r.lines[0]?.hourly_rate;
                    return (
                      <TableRow key={`${r.employee_id}-${r.site_id ?? 'none'}`} className="cursor-pointer" onClick={() => onShowLines(r.employee_id, group.site_name)}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand/15 text-[11px] font-bold text-brand">
                              {emp?.photo ? <img src={emp.photo} alt="" className="size-full object-cover" /> : initials(r.full_name)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{r.full_name}</p>
                              <p className="truncate font-mono text-[10px] text-muted-foreground">{r.employee_code}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{r.employee_code}</TableCell>
                        <TableCell className="hidden text-xs md:table-cell">
                          {r.trade_name ?? <span className="text-amber-500">no trade</span>}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">{r.nationality ?? '—'}</TableCell>
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
  const isSuperAdmin = useAuthStore((s) => s.user?.role) === 'super_admin';

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [report, setReport] = useState<SalarySheetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [linesTarget, setLinesTarget] = useState<{ employeeId: string; siteName: string | null } | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<PayrollEmployeeVM | null>(null);
  const [payTarget, setPayTarget] = useState<PayrollEmployeeVM | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  const load = (): void => {
    setLoading(true);
    dataApi.getSalarySheet(year, month)
      .then(setReport)
      .catch((err) => {
        setReport(null);
        toast.error(err instanceof Error ? err.message : 'Failed to load salary sheet');
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

  const employeeById = useMemo(
    () => new Map((report?.employees ?? []).map((e) => [e.employee_id, e])),
    [report],
  );
  const linesEmployee = linesTarget ? employeeById.get(linesTarget.employeeId) ?? null : null;

  const period = report?.period ?? null;
  const finalized = period?.status === 'finalized';
  const exportCsv = (): void => {
    if (!report) return;
    const rows: string[][] = [['Site', 'Sl', 'Employee', 'Employee ID', 'Trade', 'Nationality', 'Hours', 'Gross (AED)']];
    report.sites.forEach((g) => g.rows.forEach((r, i) => rows.push([
      g.site_name, String(i + 1), r.full_name, r.employee_code,
      r.trade_name ?? '', r.nationality ?? '', fmtHrs(r.total_hours), fmtMoney(r.gross_salary),
    ])));
    const settlement: string[][] = [['', ''], ['SETTLEMENT', ''], ['Employee', 'Employee ID', 'Gross', 'Advance', 'Deduction', 'Net', 'Status']];
    report.employees.forEach((e) => settlement.push([
      e.full_name, e.employee_code, fmtMoney(e.gross_salary), fmtMoney(e.advance),
      fmtMoney(e.deduction), fmtMoney(e.net_salary), e.payment_status,
    ]));
    const csv = [...rows, ...settlement]
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `salary-sheet-${year}-${String(month).padStart(2, '0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <SectionTitle
          icon={<Wallet size={16} />}
          title="Salary Sheet"
          sub="Monthly payroll — sitewise hours, rates & settlement (database-calculated)"
        />
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
          <Select value={MONTH_NAMES[month - 1]} onValueChange={(m) => setMonth(MONTH_NAMES.indexOf(m) + 1)}>
            <SelectTrigger className="h-10 w-36 bg-card" aria-label="Payroll month"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(y) => setYear(Number(y))}>
            <SelectTrigger className="h-10 w-24 bg-card" aria-label="Payroll year"><SelectValue /></SelectTrigger>
            <SelectContent>
              {selectableYears().map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
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
          {/* summary cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard index={0} icon={<Users size={12} />} label="Employees"
              value={String(report.totals.employees)}
              hint={`${report.totals.paid_count} paid · ${report.totals.unpaid_count} unpaid`} />
            <StatCard index={1} icon={<Clock size={12} />} label="Total hours"
              value={fmtHrs(report.totals.total_hours)} />
            <StatCard index={2} icon={<Banknote size={12} />} label="Gross salary"
              value={`AED ${fmtMoney(report.totals.gross_salary)}`} tone="brand" />
            <StatCard index={3} icon={<Wallet size={12} />} label="Net payable"
              value={`AED ${fmtMoney(report.totals.net_payable)}`} tone="emerald"
              hint={`Adv. ${fmtMoney(report.totals.advances)} · Ded. ${fmtMoney(report.totals.deductions)}`} />
          </div>

          {/* site groups */}
          {report.sites.length === 0 ? (
            <EmptyState
              icon={<Users size={22} />}
              title="No employee hours this month"
              description="Mark attendance first — the salary sheet prices every hour at the site where it was worked."
            />
          ) : (
            <div className="space-y-4">
              {report.sites.map((g, i) => (
                <SiteGroup key={`${g.site_id ?? 'none'}`} group={g} index={i}
                  onShowLines={(employeeId, siteName) => setLinesTarget({ employeeId, siteName })} />
              ))}
            </div>
          )}

          {/* consolidated settlement */}
          <section className="card-glow rounded-xl border bg-card p-5">
            <SectionTitle
              icon={<Banknote size={16} />}
              title="Employee Settlement"
              sub="One settlement per employee per month — advance & deduction are never repeated per site"
            />
            <div className="mt-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">Sl</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead className="hidden md:table-cell">Trade</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Advance</TableHead>
                    <TableHead className="text-right">Deduction</TableHead>
                    <TableHead className="text-right">Net Salary</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.employees.map((e, i) => (
                    <TableRow key={e.id} className={e.payment_status === 'paid' ? 'opacity-80' : undefined}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{e.full_name}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">{e.employee_code}</p>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-xs md:table-cell">{e.trade_name ?? <span className="text-amber-500">no trade</span>}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{fmtHrs(e.total_hours)}</TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">AED {fmtMoney(e.gross_salary)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">AED {fmtMoney(e.advance)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">AED {fmtMoney(e.deduction)}</TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold text-brand">AED {fmtMoney(e.net_salary)}</TableCell>
                      <TableCell>
                        {e.payment_status === 'paid' ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500"
                            title={`Paid ${e.paid_at ? fmtDateTime(e.paid_at) : ''}${e.paid_by_name ? ` by ${e.paid_by_name}` : ''}`}>
                            <BadgeCheck size={11} /> Paid
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            Unpaid
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost" size="icon" className="size-8"
                            title={e.payment_status === 'paid' ? 'Paid — protected' : 'Adjust advance / deduction'}
                            disabled={e.payment_status === 'paid'}
                            onClick={() => setAdjustTarget(e)}
                          >
                            <PencilLine size={14} />
                          </Button>
                          <Button
                            variant="ghost" size="icon" className="size-8 text-emerald-500 hover:text-emerald-400"
                            title={finalized ? 'Mark salary paid' : 'Finalize the payroll first'}
                            disabled={!finalized || e.payment_status === 'paid'}
                            onClick={() => setPayTarget(e)}
                          >
                            <BadgeCheck size={14} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* all-sites totals */}
            <div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">All sites gross</p>
                <p className="mt-0.5 font-mono text-lg font-bold">AED {fmtMoney(report.totals.gross_salary)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Advances</p>
                <p className="mt-0.5 font-mono text-lg font-bold text-amber-500">AED {fmtMoney(report.totals.advances)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Deductions</p>
                <p className="mt-0.5 font-mono text-lg font-bold text-amber-500">AED {fmtMoney(report.totals.deductions)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Net salary payable</p>
                <p className="mt-0.5 font-mono text-lg font-bold text-emerald-500">AED {fmtMoney(report.totals.net_payable)}</p>
              </div>
            </div>
          </section>

          {/* audit trail */}
          {report.audit.length > 0 && (
            <section className="card-glow rounded-xl border bg-card p-5">
              <SectionTitle icon={<Clock size={16} />} title="Audit trail" sub="Finalizations, reopens and payments" />
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
      <LinesDialog
        employee={linesEmployee}
        siteName={linesTarget?.siteName ?? null}
        open={linesTarget !== null}
        onOpenChange={(v) => { if (!v) setLinesTarget(null); }}
      />
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
      <FinalizeDialog report={report} open={finalizeOpen} onOpenChange={setFinalizeOpen} onDone={load} />
      <ReopenDialog report={report} open={reopenOpen} onOpenChange={setReopenOpen} onDone={load} />
    </div>
  );
}
