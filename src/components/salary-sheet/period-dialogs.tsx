'use client';

// ============================================================================
// PULSE Workforce OS — Payroll period lifecycle dialogs (shared)
// ----------------------------------------------------------------------------
// Finalize (lock the calculation snapshot) and Reopen (audited return to
// draft) are used by BOTH the Salary Sheet and the Payroll page — they
// operate on the same payroll_period row.
// ============================================================================

import { Loader2, Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dataApi } from '@/lib/data';
import type { SalarySheetReport } from '@/lib/types';

const fmtMoney = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtHrs = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export const PERIOD_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function FinalizeDialog({ report, open, onOpenChange, onDone }: {
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
          <DialogTitle>Finalize {PERIOD_MONTH_NAMES[report.period.month - 1]} {report.period.year} payroll?</DialogTitle>
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

export function ReopenDialog({ report, open, onOpenChange, onDone }: {
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
          <DialogTitle>Reopen {PERIOD_MONTH_NAMES[report.period.month - 1]} {report.period.year} payroll?</DialogTitle>
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
