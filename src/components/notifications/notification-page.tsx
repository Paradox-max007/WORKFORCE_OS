'use client';

// ============================================================================
// PULSE Workforce OS — Notifications Hub (live feed: requests, warnings, fines)
// ----------------------------------------------------------------------------
// One live surface for everything that needs attention:
//  · Recent activity strip (raw Notification records, live unread badge)
//  · Requests tab → Leave Requests + Cancellations (filters, create, review)
//  · Warnings tab → issue / browse warnings
//  · Fines tab → issue / browse fines
// ============================================================================

import { motion } from 'framer-motion';
import {
  Banknote, Bell, BellOff, CalendarCheck2, Check, CheckCheck, ChevronsUpDown,
  Download, FileDown, FileText, Inbox, Loader2, MessageCircle, Plus, Printer,
  Send, TriangleAlert, UserX, X, Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import {
  EmptyState, EmployeeStatusBadge, PageHeader, RequestStatusBadge, SectionTitle, SkeletonRows,
} from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { fmtDate, fmtSar, fmtTimeAgo, initials } from '@/lib/format';
import {
  downloadLeavePdf, openLeavePrintWindow, shareLeaveViaWhatsApp,
  downloadNoticePdf, openNoticeWhatsAppMessage, shareNoticePdfViaWhatsApp,
} from '@/lib/pdf';
import {
  NOTICE_KINDS, buildNoticeWhatsAppText, noticeLabel, noticeRef, noticeTitle,
  sanitizeWhatsAppNumber,
  type NoticeKind, type NoticeLetterData, type TerminationNoticeBasis,
} from '@/lib/notices';
import {
  LEAVE_TYPES,
  type CancellationRequestVM, type EmployeeVM, type FineVM, type LeaveRequestInput,
  type LeaveRequestVM, type LeaveType, type Notification, type TerminationLetterVM,
  type WarningVM,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';
import { useSettingsStore } from '@/store/settings-store';

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';
type MonthFilter = 'all' | number;

const MONTH_OPTIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR - 2, CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1, CURRENT_YEAR + 2];

/** Colored dot per notification type (request = brand, warning = amber, fine = rose, termination = red) */
const TYPE_DOT: Record<Notification['type'], string> = {
  request: 'bg-brand',
  warning: 'bg-amber-500',
  fine: 'bg-rose-500',
  termination: 'bg-red-500',
};

const DOC_BTN = 'size-8 text-muted-foreground transition-colors hover:bg-brand/10 hover:text-brand';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : 'Something went wrong');

const leaveTypeLabel = (req: LeaveRequestVM): string =>
  req.leave_type === 'other' && req.other_type_text
    ? req.other_type_text
    : LEAVE_TYPES.find((t) => t.value === req.leave_type)?.label ?? req.leave_type;

/** ISO created_at is inside the selected year (+ month when "all" is not set) */
const inYearMonth = (iso: string, year: number, month: MonthFilter): boolean =>
  iso.slice(0, 4) === String(year)
  && (month === 'all' || iso.slice(5, 7) === String(month + 1).padStart(2, '0'));

/** Mono employee-code chip used on every card */
function MonoCode({ code }: { code: string }) {
  return (
    <span className="shrink-0 rounded-md border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {code}
    </span>
  );
}

/** Tiny count chip for tab triggers */
function CountChip({ count, tone }: { count: number; tone: 'brand' | 'amber' | 'rose' }) {
  if (count <= 0) return null;
  const tones: Record<'brand' | 'amber' | 'rose', string> = {
    brand: 'bg-brand/15 text-brand',
    amber: 'bg-amber-500/15 text-amber-500',
    rose: 'bg-rose-500/15 text-rose-500',
  };
  return (
    <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums', tones[tone])}>
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Employee combobox for cancellations (pending-deletion entries disabled)
// ---------------------------------------------------------------------------
function CancellableEmployeeCombobox({
  employees, value, onChange,
}: {
  employees: EmployeeVM[];
  value: string | null;
  onChange: (employeeId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = useMemo(() => employees.find((e) => e.id === value) ?? null, [employees, value]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return employees;
    return employees.filter((e) =>
      e.full_name.toLowerCase().includes(q)
      || e.employee_code.toLowerCase().includes(q)
      || (e.position ?? '').toLowerCase().includes(q));
  }, [employees, query]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="h-11 w-full justify-between font-normal">
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                {initials(selected.full_name)}
              </span>
              <span className="truncate">{selected.full_name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{selected.employee_code}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Search employees…</span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Type to search…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No employees found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((e) => (
                <CommandItem
                  key={e.id}
                  value={`${e.full_name} ${e.employee_code}`}
                  disabled={e.status === 'pending_deletion'}
                  onSelect={() => {
                    onChange(e.id === value ? null : e.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                    {initials(e.full_name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{e.full_name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{e.employee_code}</span>
                  {e.status === 'pending_deletion' ? (
                    <span className="ml-2 shrink-0 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                      Pending deletion
                    </span>
                  ) : (
                    <span className="ml-2 shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                      Active
                    </span>
                  )}
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
// New Leave Request dialog
// ---------------------------------------------------------------------------
function LeaveRequestDialog({
  open, onOpenChange, employees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
}) {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [leaveType, setLeaveType] = useState<LeaveType | null>(null);
  const [otherText, setOtherText] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the form every time the dialog opens
  useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setLeaveType(null);
      setOtherText('');
      setStartDate('');
      setEndDate('');
      setReason('');
      setBusy(false);
    }
  }, [open]);

  // Total days = inclusive day difference (min 1), recomputed on every change
  const totalDays = useMemo(() => {
    if (!startDate) return 0;
    if (!endDate) return 1;
    const diff = Math.floor((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
    return Math.max(1, diff);
  }, [startDate, endDate]);

  const submit = async () => {
    if (!employeeId) { toast.error('Please select an employee'); return; }
    if (!leaveType) { toast.error('Please select a leave type'); return; }
    if (leaveType === 'other' && !otherText.trim()) { toast.error('Please specify the leave type'); return; }
    if (!startDate || !endDate) { toast.error('Please pick both start and end dates'); return; }
    if (Date.parse(endDate) < Date.parse(startDate)) { toast.error('End date cannot be before the start date'); return; }
    if (!reason.trim()) { toast.error('Please provide a reason'); return; }

    const input: LeaveRequestInput = {
      employee_id: employeeId,
      leave_type: leaveType,
      other_type_text: leaveType === 'other' ? otherText.trim() : null,
      start_date: startDate,
      end_date: endDate,
      total_days: totalDays,
      reason: reason.trim(),
    };

    setBusy(true);
    try {
      await dataApi.createLeaveRequest(input);
      toast.success('Leave request submitted');
      onOpenChange(false);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Leave Request</DialogTitle>
          <DialogDescription>
            Submit a leave application for an active employee. Super admins are notified instantly.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label>Employee <span className="text-rose-500">*</span></Label>
          <EmployeeCombobox
            employees={employees}
            value={employeeId}
            onChange={setEmployeeId}
            emptyText="No active employees found."
          />
        </div>

        <div className="grid gap-1.5">
          <Label>Leave Type <span className="text-rose-500">*</span></Label>
          <Select value={leaveType ?? undefined} onValueChange={(v) => setLeaveType(v as LeaveType)}>
            <SelectTrigger className="h-11 w-full bg-card">
              <SelectValue placeholder="Select leave type" />
            </SelectTrigger>
            <SelectContent>
              {LEAVE_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {leaveType === 'other' && (
          <div className="grid gap-1.5">
            <Label htmlFor="leave-other">Specify Leave Type <span className="text-rose-500">*</span></Label>
            <Input
              id="leave-other"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="e.g. Study Leave"
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="leave-start">Start Date <span className="text-rose-500">*</span></Label>
            <Input
              id="leave-start"
              type="date"
              className="h-11 dark:[color-scheme:dark]"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="leave-end">End Date <span className="text-rose-500">*</span></Label>
            <Input
              id="leave-end"
              type="date"
              className="h-11 dark:[color-scheme:dark]"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="leave-days">Total Days</Label>
          <Input id="leave-days" type="number" readOnly value={totalDays} className="h-11 bg-muted/60 font-medium" />
          <p className="text-[11px] text-muted-foreground">
            Auto-calculated from the selected period (both dates included).
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="leave-reason">Reason <span className="text-rose-500">*</span></Label>
          <Textarea
            id="leave-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for the leave…"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit(); }} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {busy ? 'Submitting…' : 'Submit Leave Request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// New Cancellation Request dialog
// ---------------------------------------------------------------------------
function CancellationDialog({
  open, onOpenChange, employees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
}) {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setReason('');
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!employeeId) { toast.error('Please select an employee'); return; }
    setBusy(true);
    try {
      await dataApi.createCancellationRequest(employeeId, reason.trim() || null);
      toast.success('Cancellation request submitted');
      onOpenChange(false);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Cancellation Request</DialogTitle>
          <DialogDescription>
            Request the permanent removal of an employee record from the workforce.
          </DialogDescription>
        </DialogHeader>

        <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            Upon submission, the employee will be marked as &apos;Pending Deletion&apos; until a super admin
            approves or rejects. If approved, the employee will be permanently deleted.
          </span>
        </p>

        <div className="grid gap-1.5">
          <Label>Employee <span className="text-rose-500">*</span></Label>
          <CancellableEmployeeCombobox employees={employees} value={employeeId} onChange={setEmployeeId} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cancel-reason">Reason <span className="text-xs font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea
            id="cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why should this employee be removed?…"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit(); }} disabled={busy} className="bg-rose-500 text-white shadow-xs hover:bg-rose-600">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />}
            {busy ? 'Submitting…' : 'Submit Cancellation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add New Warning dialog
// ---------------------------------------------------------------------------
function WarningDialog({
  open, onOpenChange, employees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
}) {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setReason('');
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!employeeId) { toast.error('Please select an employee'); return; }
    if (!reason.trim()) { toast.error('Please provide a reason'); return; }
    setBusy(true);
    try {
      await dataApi.issueWarning(employeeId, reason.trim());
      toast.success('Warning issued');
      onOpenChange(false);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Warning</DialogTitle>
          <DialogDescription>Issue a formal warning to an active employee.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label>Employee <span className="text-rose-500">*</span></Label>
          <EmployeeCombobox
            employees={employees}
            value={employeeId}
            onChange={setEmployeeId}
            emptyText="No active employees found."
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="warning-reason">Reason <span className="text-rose-500">*</span></Label>
          <Textarea
            id="warning-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What did the employee do?…"
          />
        </div>

        <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          This will deduct 0.5 stars from their performance rating.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit(); }} disabled={busy} className="bg-amber-500 text-white shadow-xs hover:bg-amber-600">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <TriangleAlert size={14} />}
            {busy ? 'Issuing…' : 'Issue Warning'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add New Fine dialog
// ---------------------------------------------------------------------------
function FineDialog({
  open, onOpenChange, employees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
}) {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setAmount('');
      setReason('');
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!employeeId) { toast.error('Please select an employee'); return; }
    const parsed = parseFloat(amount);
    if (amount.trim() === '' || Number.isNaN(parsed) || parsed < 0) { toast.error('Please enter a valid fine amount'); return; }
    if (!reason.trim()) { toast.error('Please provide a reason'); return; }
    setBusy(true);
    try {
      await dataApi.issueFine(employeeId, reason.trim(), parsed);
      toast.success('Fine issued');
      onOpenChange(false);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Fine</DialogTitle>
          <DialogDescription>Issue a monetary fine to an active employee.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label>Employee <span className="text-rose-500">*</span></Label>
          <EmployeeCombobox
            employees={employees}
            value={employeeId}
            onChange={setEmployeeId}
            emptyText="No active employees found."
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="fine-amount">Amount (SAR) <span className="text-rose-500">*</span></Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-muted-foreground">SAR</span>
            <Input
              id="fine-amount"
              type="number"
              min={0}
              step={0.01}
              className="h-11 pl-11"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="fine-reason">Reason <span className="text-rose-500">*</span></Label>
          <Textarea
            id="fine-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this fine being issued?…"
          />
        </div>

        <p className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-xs text-rose-600 dark:text-rose-400">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          This will deduct 1 star from their performance rating.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit(); }} disabled={busy} className="bg-rose-500 text-white shadow-xs hover:bg-rose-600">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} />}
            {busy ? 'Issuing…' : 'Issue Fine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function LeaveCard({
  req, index, isSuperAdmin, onReview,
}: {
  req: LeaveRequestVM;
  index: number;
  isSuperAdmin: boolean;
  onReview: (req: LeaveRequestVM, approve: boolean) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="card-glow rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-semibold">{req.employee_name}</p>
          <MonoCode code={req.employee_code} />
        </div>
        <RequestStatusBadge status={req.status} />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-semibold text-brand">{leaveTypeLabel(req)}</span>
        {' · period '}
        <span className="font-medium text-foreground/80">{fmtDate(req.start_date)} → {fmtDate(req.end_date)}</span>
        {' · '}
        <span className="font-medium text-foreground/80">{req.total_days} day(s)</span>
      </p>

      <p className="mt-1.5 line-clamp-2 text-sm italic text-muted-foreground">{req.reason}</p>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Requested by {req.created_by_name ?? 'System'} · {fmtTimeAgo(req.created_at)}
        {req.reviewed_by_name && <> · Reviewed by {req.reviewed_by_name}</>}
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon" className={DOC_BTN}
            title="Download PDF" aria-label="Download leave application PDF"
            onClick={() => downloadLeavePdf(req)}
          >
            <Download size={14} />
          </Button>
          <Button
            variant="ghost" size="icon" className={DOC_BTN}
            title="Print" aria-label="Print leave application"
            onClick={() => openLeavePrintWindow(req)}
          >
            <Printer size={14} />
          </Button>
          <Button
            variant="ghost" size="icon" className={DOC_BTN}
            title="Share via WhatsApp" aria-label="Share leave application via WhatsApp"
            onClick={() => { void shareLeaveViaWhatsApp(req); }}
          >
            <MessageCircle size={14} />
          </Button>
        </div>
        {isSuperAdmin && req.status === 'pending' && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline" size="sm"
              className="border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500"
              onClick={() => onReview(req, true)}
            >
              <Check size={14} /> Approve
            </Button>
            <Button
              variant="outline" size="sm"
              className="border-rose-500/40 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
              onClick={() => onReview(req, false)}
            >
              <X size={14} /> Reject
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function CancellationCard({
  req, index, isSuperAdmin, onReview,
}: {
  req: CancellationRequestVM;
  index: number;
  isSuperAdmin: boolean;
  onReview: (req: CancellationRequestVM, approve: boolean) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="card-glow rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-semibold">{req.employee_name}</p>
          <MonoCode code={req.employee_code} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <EmployeeStatusBadge status={req.employee_status} />
          <RequestStatusBadge status={req.status} />
        </div>
      </div>

      <p className={cn('mt-2 line-clamp-2 text-sm italic', req.reason ? 'text-muted-foreground' : 'text-muted-foreground/60')}>
        {req.reason ?? 'No reason provided'}
      </p>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Requested by {req.requested_by_name ?? 'System'} · {fmtTimeAgo(req.created_at)}
        {req.reviewed_by_name && <> · Reviewed by {req.reviewed_by_name}</>}
      </p>

      {req.status === 'pending' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          {isSuperAdmin ? (
            <>
              <span className="mr-auto text-[11px] text-muted-foreground">This request needs your decision</span>
              <Button
                size="sm" className="bg-rose-500 text-white shadow-xs hover:bg-rose-600"
                onClick={() => onReview(req, true)}
              >
                <UserX size={14} /> Approve &amp; Delete
              </Button>
              <Button
                size="sm" className="bg-emerald-500 text-white shadow-xs hover:bg-emerald-600"
                onClick={() => onReview(req, false)}
              >
                <Check size={14} /> Reject &amp; Restore
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">Awaiting review by a super admin.</span>
          )}
        </div>
      )}
    </motion.div>
  );
}

/** Shared action row: download the formal letter PDF / send via WhatsApp */
function NoticeActions({ onDownload, onWhatsApp }: { onDownload: () => void; onWhatsApp: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
      <Button
        size="sm" variant="outline"
        className="h-8 gap-1.5 px-2.5 text-[11px]"
        onClick={onDownload}
      >
        <FileDown size={13} /> Letter PDF
      </Button>
      <Button
        size="sm" variant="outline"
        className="h-8 gap-1.5 px-2.5 text-[11px] text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400"
        onClick={onWhatsApp}
      >
        <MessageCircle size={13} /> WhatsApp
      </Button>
    </div>
  );
}

function WarningCard({
  warn, index, employee, onWhatsApp,
}: {
  warn: WarningVM;
  index: number;
  employee: EmployeeVM | undefined;
  onWhatsApp: (data: NoticeLetterData) => void;
}) {
  const letterData = (): NoticeLetterData | null => !employee ? null : {
    kind: 'warning',
    employee,
    recordId: warn.id,
    reason: warn.reason,
    createdAt: warn.created_at,
    creatorName: warn.issued_by_name,
    isAuto: warn.is_auto_generated,
    absentDates: warn.absent_dates,
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="card-glow rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-semibold">{warn.employee_name}</p>
          <MonoCode code={warn.employee_code} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {warn.is_auto_generated && (
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-500/25 bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
              <Zap size={10} /> Auto
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
            <TriangleAlert size={10} /> Warning
          </span>
        </div>
      </div>

      <p className="mt-2 line-clamp-2 text-sm italic text-muted-foreground">{warn.reason}</p>

      {warn.absent_dates && warn.absent_dates.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Absent dates:</span>
          {warn.absent_dates.map((d) => (
            <span key={d} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {d}
            </span>
          ))}
        </div>
      )}

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Created by: {warn.is_auto_generated ? 'System (Auto-generated)' : warn.issued_by_name} · {fmtTimeAgo(warn.created_at)}
      </p>

      {employee ? (
        <NoticeActions
          onDownload={() => { const d = letterData(); if (d) downloadNoticePdf(d); }}
          onWhatsApp={() => { const d = letterData(); if (d) onWhatsApp(d); }}
        />
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground/70">Employee record unavailable — letter cannot be generated.</p>
      )}
    </motion.div>
  );
}

function FineCard({
  fine, index, employee, onWhatsApp,
}: {
  fine: FineVM;
  index: number;
  employee: EmployeeVM | undefined;
  onWhatsApp: (data: NoticeLetterData) => void;
}) {
  const letterData = (): NoticeLetterData | null => !employee ? null : {
    kind: 'fine',
    employee,
    recordId: fine.id,
    reason: fine.reason,
    createdAt: fine.created_at,
    creatorName: fine.issued_by_name,
    amount: fine.amount,
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="card-glow rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-semibold">{fine.employee_name}</p>
          <MonoCode code={fine.employee_code} />
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-500">
          <Banknote size={10} /> {fmtSar(fine.amount)}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-sm italic text-muted-foreground">{fine.reason}</p>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Created by: {fine.issued_by_name} · {fmtTimeAgo(fine.created_at)}
      </p>

      {employee ? (
        <NoticeActions
          onDownload={() => { const d = letterData(); if (d) downloadNoticePdf(d); }}
          onWhatsApp={() => { const d = letterData(); if (d) onWhatsApp(d); }}
        />
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground/70">Employee record unavailable — notice cannot be generated.</p>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Letters tab — unified document card (warning letters / fine notices / termination letters)
// ---------------------------------------------------------------------------
const KIND_BADGE: Record<NoticeKind, { cls: string; icon: React.ReactNode }> = {
  warning: {
    cls: 'border-amber-500/25 bg-amber-500/10 text-amber-500',
    icon: <TriangleAlert size={10} />,
  },
  fine: {
    cls: 'border-rose-500/25 bg-rose-500/10 text-rose-500',
    icon: <Banknote size={10} />,
  },
  termination: {
    cls: 'border-red-500/30 bg-red-500/10 text-red-500',
    icon: <UserX size={10} />,
  },
};

interface NoticeDoc {
  kind: NoticeKind;
  recordId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  reason: string;
  createdAt: string;
  creatorName: string;
  isAuto: boolean;
  amount?: number;
  effectiveDate?: string | null;
  noticeBasis?: TerminationNoticeBasis;
  customBody?: string | null;
}

function NoticeDocumentCard({
  doc, index, employee, onWhatsApp,
}: {
  doc: NoticeDoc;
  index: number;
  employee: EmployeeVM | undefined;
  onWhatsApp: (data: NoticeLetterData) => void;
}) {
  const letterData = (): NoticeLetterData | null => !employee ? null : {
    kind: doc.kind,
    employee,
    recordId: doc.recordId,
    reason: doc.reason,
    createdAt: doc.createdAt,
    creatorName: doc.creatorName,
    isAuto: doc.isAuto,
    amount: doc.amount,
    effectiveDate: doc.effectiveDate,
    noticeBasis: doc.noticeBasis,
    customBody: doc.customBody,
  };
  const badge = KIND_BADGE[doc.kind];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className="card-glow rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', badge.cls)}>
            {badge.icon} {noticeLabel(doc.kind)}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{noticeRef(doc.kind, doc.recordId)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {doc.isAuto && (
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-500/25 bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
              <Zap size={10} /> Auto
            </span>
          )}
          {doc.kind === 'fine' && typeof doc.amount === 'number' && (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-500">
              <Banknote size={10} /> {fmtSar(doc.amount)}
            </span>
          )}
          {doc.kind === 'termination' && doc.effectiveDate && (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-500">
              <CalendarCheck2 size={10} /> Effective {fmtDate(doc.effectiveDate)}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <p className="truncate text-sm font-semibold">{doc.employeeName}</p>
        <MonoCode code={doc.employeeCode} />
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm italic text-muted-foreground">{doc.reason}</p>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Created by: {doc.isAuto ? 'System (Auto-generated)' : doc.creatorName} · {fmtDate(doc.createdAt)}
      </p>

      {employee ? (
        <NoticeActions
          onDownload={() => { const d = letterData(); if (d) downloadNoticePdf(d); }}
          onWhatsApp={() => { const d = letterData(); if (d) onWhatsApp(d); }}
        />
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground/70">Employee record unavailable — letter cannot be generated.</p>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// New Letter / Notice dialog (Warning Letter · Termination Letter · Fine Notice)
// ---------------------------------------------------------------------------
function NoticeCreateDialog({
  open, onOpenChange, employees, creatorName, onWhatsApp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
  creatorName: string;
  onWhatsApp: (data: NoticeLetterData) => void;
}) {
  const [kind, setKind] = useState<NoticeKind>('warning');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [noticeBasis, setNoticeBasis] = useState<TerminationNoticeBasis>('with_notice');
  const [customBody, setCustomBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState(true);

  useEffect(() => {
    if (open) {
      setKind('warning');
      setEmployeeId(null);
      setReason('');
      setAmount('');
      setEffectiveDate('');
      setNoticeBasis('with_notice');
      setCustomBody('');
      setBusy(false);
      setDownload(true);
    }
  }, [open]);

  const employee = useMemo(() => employees.find((e) => e.id === employeeId) ?? null, [employees, employeeId]);

  const submit = async () => {
    if (!employeeId || !employee) { toast.error('Please select an employee'); return; }
    if (!reason.trim()) { toast.error('Please provide a reason'); return; }
    let parsedAmount = 0;
    if (kind === 'fine') {
      parsedAmount = parseFloat(amount);
      if (amount.trim() === '' || Number.isNaN(parsedAmount) || parsedAmount < 0) {
        toast.error('Please enter a valid fine amount');
        return;
      }
    }
    if (kind === 'termination' && !effectiveDate) { toast.error('Please select the effective date'); return; }
    setBusy(true);
    try {
      let recordId = '';
      if (kind === 'warning') {
        const rec = await dataApi.issueWarning(employeeId, reason.trim());
        recordId = rec?.id ?? '';
      } else if (kind === 'fine') {
        const rec = await dataApi.issueFine(employeeId, reason.trim(), parsedAmount);
        recordId = rec?.id ?? '';
      } else {
        const rec = await dataApi.createTerminationLetter(
          employeeId, reason.trim(), effectiveDate, noticeBasis, customBody.trim() || null,
        );
        recordId = rec?.id ?? '';
      }
      if (recordId) {
        const letter: NoticeLetterData = {
          kind,
          employee,
          recordId,
          reason: reason.trim(),
          createdAt: new Date().toISOString(),
          creatorName,
          amount: kind === 'fine' ? parsedAmount : undefined,
          effectiveDate: kind === 'termination' ? effectiveDate : undefined,
          noticeBasis: kind === 'termination' ? noticeBasis : undefined,
          customBody: kind === 'termination' ? customBody.trim() || null : undefined,
        };
        toast.success(`${noticeTitle(kind)} created${kind !== 'termination' ? (kind === 'fine' ? ' — fine issued' : ' — warning issued') : ''}`);
        if (download) downloadNoticePdf(letter);
        else onWhatsApp(letter);
      } else {
        toast.success(`${noticeTitle(kind)} created`);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Letter / Notice</DialogTitle>
          <DialogDescription>
            Create a formal Warning Letter, Termination Letter or Fine Notice — download the PDF or send it through WhatsApp.
          </DialogDescription>
        </DialogHeader>

        {/* document type */}
        <div className="grid grid-cols-3 gap-2">
          {NOTICE_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => setKind(k.kind)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border p-2.5 text-center text-[11px] font-medium transition-colors',
                kind === k.kind
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border text-muted-foreground hover:bg-muted/60',
              )}
            >
              {k.kind === 'warning' && <TriangleAlert size={16} />}
              {k.kind === 'termination' && <UserX size={16} />}
              {k.kind === 'fine' && <Banknote size={16} />}
              {k.label}
            </button>
          ))}
        </div>

        {/* employee */}
        <div className="grid gap-1.5">
          <Label>Employee <span className="text-rose-500">*</span></Label>
          <EmployeeCombobox
            employees={employees}
            value={employeeId}
            onChange={setEmployeeId}
            emptyText="No active employees found."
          />
          {employee && (
            <p className="rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {employee.trade_name ?? 'No trade'} · {employee.nationality ?? '—'} · {employee.site_name ?? 'No site'} · {employee.phone ?? 'No phone'}
            </p>
          )}
        </div>

        {/* fine amount */}
        {kind === 'fine' && (
          <div className="grid gap-1.5">
            <Label htmlFor="notice-amount">Amount (SAR) <span className="text-rose-500">*</span></Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-muted-foreground">SAR</span>
              <Input
                id="notice-amount"
                type="number"
                min={0}
                step={0.01}
                className="h-11 pl-11"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* termination specifics */}
        {kind === 'termination' && (
          <>
            <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="notice-effective">Effective Date <span className="text-rose-500">*</span></Label>
                <Input
                  id="notice-effective"
                  type="date"
                  className="h-11"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Notice Basis</Label>
                <Select value={noticeBasis} onValueChange={(v) => setNoticeBasis(v as TerminationNoticeBasis)}>
                  <SelectTrigger className="h-11 bg-card" aria-label="Notice basis"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="with_notice">With notice period</SelectItem>
                    <SelectItem value="immediate">Immediate termination</SelectItem>
                    <SelectItem value="payment_in_lieu">Payment in lieu of notice</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="notice-custom">Custom Letter Text <span className="text-muted-foreground">(optional — leave blank for the standard format)</span></Label>
              <Textarea
                id="notice-custom"
                rows={4}
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                placeholder="Type the full letter text if the standard format does not fit…"
              />
            </div>
          </>
        )}

        {/* reason */}
        <div className="grid gap-1.5">
          <Label htmlFor="notice-reason">
            Reason <span className="text-rose-500">*</span>
            {kind === 'warning' && <span className="ml-1 text-muted-foreground">(deducts 0.5 stars)</span>}
            {kind === 'fine' && <span className="ml-1 text-muted-foreground">(deducts 1 star)</span>}
          </Label>
          <Textarea
            id="notice-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === 'termination' ? 'Grounds for termination…' : 'What happened?…'}
          />
        </div>

        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          The letter will be identified as <span className="font-semibold text-foreground">Created by: {creatorName}</span> and carries the
          employee's name, code and full details.
        </p>

        <div className="flex items-center gap-2">
          <Button
            type="button" size="sm" variant={download ? 'default' : 'outline'}
            className="h-8 gap-1.5 text-[11px]"
            onClick={() => setDownload(true)}
          >
            <FileDown size={13} /> Download PDF after creating
          </Button>
          <Button
            type="button" size="sm" variant={!download ? 'default' : 'outline'}
            className="h-8 gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400"
            onClick={() => setDownload(false)}
          >
            <MessageCircle size={13} /> Open WhatsApp instead
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void submit(); }} disabled={busy} className="bg-brand text-white shadow-xs hover:bg-brand/90">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {busy ? 'Creating…' : `Create ${noticeLabel(kind)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp send dialog — "send directly" (PDF file) and "send as message"
// ---------------------------------------------------------------------------
function WhatsAppSendDialog({
  open, onOpenChange, payload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: { data: NoticeLetterData; nonce: number } | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {payload && (
          <WhatsAppSendForm key={payload.nonce} data={payload.data} onOpenChange={onOpenChange} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WhatsAppSendForm({
  data, onOpenChange,
}: {
  data: NoticeLetterData;
  onOpenChange: (open: boolean) => void;
}) {
  const [phone, setPhone] = useState(() => sanitizeWhatsAppNumber(data.employee.phone) ?? '');
  const [text, setText] = useState(() => buildNoticeWhatsAppText(data));
  const [busy, setBusy] = useState(false);
  const digits = phone.replace(/[^0-9]/g, '');

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageCircle size={16} className="text-emerald-500" />
          Send {noticeTitle(data.kind).toLowerCase()} via WhatsApp
        </DialogTitle>
        <DialogDescription>
          Send the PDF file directly, or send the notice as a text message to the employee's number.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="wa-phone">WhatsApp Number <span className="text-muted-foreground">(international format, e.g. 9665xxxxxxxx)</span></Label>
        <Input
          id="wa-phone"
          inputMode="tel"
          className="h-11"
          placeholder="9665xxxxxxxx"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="wa-text">Message</Label>
        <Textarea
          id="wa-text"
          rows={7}
          className="text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <DialogFooter className="flex-col gap-2 sm:flex-col">
        <Button
          className="w-full gap-2 bg-emerald-500 text-white shadow-xs hover:bg-emerald-600"
          disabled={busy || digits.length < 7}
          onClick={() => { openNoticeWhatsAppMessage(phone, text); onOpenChange(false); }}
        >
          <Send size={14} /> Send as Message (open chat)
        </Button>
        <Button
          variant="outline"
          className="w-full gap-2"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void shareNoticePdfViaWhatsApp(data)
              .catch(() => toast.error('Could not share the PDF — it was downloaded instead.'))
              .finally(() => { setBusy(false); onOpenChange(false); });
          }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
          Send PDF Directly (share file)
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function NotificationPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const version = useRealtimeVersion(['notification', 'leave_request', 'cancellation_request', 'warning', 'fine', 'termination_letter']);
  // controlled tab — other pages deep-link straight to Warnings / Fines
  // (e.g. the Notices & Fines card on the Employee Details page)
  const activeTab = useAppStore((s) => s.notificationsTab);
  const navigateToNotifications = useAppStore((s) => s.navigateToNotifications);

  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequestVM[] | null>(null);
  const [cancellations, setCancellations] = useState<CancellationRequestVM[] | null>(null);
  const [warnings, setWarnings] = useState<WarningVM[] | null>(null);
  const [fines, setFines] = useState<FineVM[] | null>(null);
  const [terminationLetters, setTerminationLetters] = useState<TerminationLetterVM[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);

  // Shared filters for the Requests tab (apply to both sub-lists)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [yearFilter, setYearFilter] = useState<number>(CURRENT_YEAR);
  const [monthFilter, setMonthFilter] = useState<MonthFilter>('all');

  // Creation dialogs
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [fineOpen, setFineOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);

  // Letters tab: document filter + WhatsApp send dialog payload
  const [letterFilter, setLetterFilter] = useState<NoticeKind | 'all'>('all');
  const [whatsapp, setWhatsapp] = useState<{ data: NoticeLetterData; nonce: number } | null>(null);
  /** open the WhatsApp send dialog — every open gets a fresh nonce so the
   *  keyed inner form remounts with prefilled state (no effect resets). The
   *  letterhead company (Site Settings → company name) is stamped on the
   *  payload so the message text matches the PDF heading. */
  const openWhatsApp = useCallback((data: NoticeLetterData) => {
    const companyName = data.companyName?.trim()
      || useSettingsStore.getState().settings.company_name?.trim()
      || null;
    setWhatsapp((prev) => ({ data: { ...data, companyName }, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Review confirmations (AlertDialog state)
  const [leaveReview, setLeaveReview] = useState<{ req: LeaveRequestVM; approve: boolean } | null>(null);
  const [cancelReview, setCancelReview] = useState<{ req: CancellationRequestVM; approve: boolean } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  // Recently dismissed activity-strip ids
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);

  // ---- data loading (re-fetches whenever any hub table changes anywhere) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [notifs, unread, leaves, cancels, warns, fineRows, terms, emps] = await Promise.all([
        dataApi.listNotifications(),
        dataApi.getUnreadNotificationCount(),
        dataApi.listLeaveRequests(),
        dataApi.listCancellationRequests(),
        dataApi.listWarnings(),
        dataApi.listFines(),
        dataApi.listTerminationLetters(),
        dataApi.listEmployees(),
      ]);
      if (cancelled) return;
      setNotifications(notifs);
      setUnreadCount(unread);
      setLeaveRequests(leaves);
      setCancellations(cancels);
      setWarnings(warns);
      setFines(fineRows);
      setTerminationLetters(terms);
      setEmployees(emps);
    })().catch(() => {
      if (!cancelled) {
        setNotifications([]);
        setUnreadCount(0);
        setLeaveRequests([]);
        setCancellations([]);
        setWarnings([]);
        setFines([]);
        setTerminationLetters([]);
        setEmployees([]);
      }
    });
    return () => { cancelled = true; };
  }, [version]);

  // ---- derived values ---------------------------------------------------------
  const activeEmployees = useMemo(() => (employees ?? []).filter((e) => e.status === 'active'), [employees]);
  const cancelCandidates = useMemo(() => employees ?? [], [employees]);

  const pendingLeaveCount = useMemo(
    () => (leaveRequests ?? []).filter((r) => r.status === 'pending').length, [leaveRequests]);
  const pendingCancelCount = useMemo(
    () => (cancellations ?? []).filter((r) => r.status === 'pending').length, [cancellations]);

  const filteredLeaves = useMemo(
    () => (leaveRequests ?? []).filter((r) =>
      (statusFilter === 'all' || r.status === statusFilter) && inYearMonth(r.created_at, yearFilter, monthFilter)),
    [leaveRequests, statusFilter, yearFilter, monthFilter]);
  const filteredCancellations = useMemo(
    () => (cancellations ?? []).filter((r) =>
      (statusFilter === 'all' || r.status === statusFilter) && inYearMonth(r.created_at, yearFilter, monthFilter)),
    [cancellations, statusFilter, yearFilter, monthFilter]);

  const stripItems = useMemo(() => {
    const dismissed = new Set(dismissedIds);
    return (notifications ?? []).filter((n) => !dismissed.has(n.id)).slice(0, 8);
  }, [notifications, dismissedIds]);

  const employeeById = useMemo(() => new Map((employees ?? []).map((e) => [e.id, e])), [employees]);

  // unified Letters tab feed — every formal document, newest first
  const noticeDocs = useMemo<NoticeDoc[]>(() => {
    const docs: NoticeDoc[] = [];
    for (const w of warnings ?? []) {
      docs.push({
        kind: 'warning', recordId: w.id, employeeId: w.employee_id,
        employeeName: w.employee_name, employeeCode: w.employee_code,
        reason: w.reason, createdAt: w.created_at, creatorName: w.issued_by_name,
        isAuto: w.is_auto_generated,
      });
    }
    for (const f of fines ?? []) {
      docs.push({
        kind: 'fine', recordId: f.id, employeeId: f.employee_id,
        employeeName: f.employee_name, employeeCode: f.employee_code,
        reason: f.reason, createdAt: f.created_at, creatorName: f.issued_by_name,
        isAuto: false, amount: f.amount,
      });
    }
    for (const t of terminationLetters ?? []) {
      docs.push({
        kind: 'termination', recordId: t.id, employeeId: t.employee_id,
        employeeName: t.employee_name, employeeCode: t.employee_code,
        reason: t.reason, createdAt: t.created_at, creatorName: t.created_by_name,
        isAuto: false, effectiveDate: t.effective_date, noticeBasis: t.notice_basis,
        customBody: t.custom_body,
      });
    }
    return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [warnings, fines, terminationLetters]);

  const filteredDocs = useMemo(
    () => letterFilter === 'all' ? noticeDocs : noticeDocs.filter((d) => d.kind === letterFilter),
    [noticeDocs, letterFilter],
  );

  // ---- handlers ----------------------------------------------------------------
  const handleMarkAllRead = async () => {
    try {
      await dataApi.markAllNotificationsRead();
      toast.success('All notifications marked as read');
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const handleStripClick = async (n: Notification) => {
    setDismissedIds((prev) => [...prev, n.id]);
    try {
      await dataApi.markNotificationRead(n.id);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const confirmLeaveReview = async () => {
    if (!leaveReview) return;
    setReviewBusy(true);
    try {
      await dataApi.reviewLeaveRequest(leaveReview.req.id, leaveReview.approve);
      toast.success(leaveReview.approve ? 'Leave request approved' : 'Leave request rejected');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setReviewBusy(false);
      setLeaveReview(null);
    }
  };

  const confirmCancelReview = async () => {
    if (!cancelReview) return;
    setReviewBusy(true);
    try {
      await dataApi.reviewCancellationRequest(cancelReview.req.id, cancelReview.approve);
      toast.success(cancelReview.approve
        ? 'Cancellation approved — employee permanently removed'
        : 'Cancellation rejected — employee restored to active');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setReviewBusy(false);
      setCancelReview(null);
    }
  };

  // ---- render -------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Notifications Hub"
        description="Review requests, warnings and fines in one live feed"
        actions={
          <>
            <span
              aria-live="polite"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-rose-500/25 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-500 shadow-xs',
                unreadCount === 0 && 'opacity-70',
              )}
            >
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-rose-400 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-rose-500" />
              </span>
              {unreadCount} unread
            </span>
            <Button variant="outline" onClick={() => { void handleMarkAllRead(); }} disabled={unreadCount === 0}>
              <CheckCheck size={15} /> Mark All Read
            </Button>
          </>
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* Recent activity strip (raw Notification records)                   */}
      {/* ------------------------------------------------------------------ */}
      <motion.section
        aria-label="Recent activity"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="card-glow rounded-xl border bg-card p-4 md:p-5"
      >
        <SectionTitle
          icon={<Bell size={15} />}
          title="Recent Activity"
          sub="The 8 newest events — click one to mark it as read and clear it"
        />
        <div className="mt-3">
          {notifications === null ? (
            <SkeletonRows rows={2} />
          ) : stripItems.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
              <BellOff size={16} className="text-brand" />
              No recent activity — you are all caught up.
            </div>
          ) : (
            <div className="flex max-h-40 gap-3 overflow-auto pb-1 pr-1">
              {stripItems.map((n, i) => (
                <motion.button
                  key={n.id}
                  type="button"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  onClick={() => { void handleStripClick(n); }}
                  title="Mark as read and remove from the strip"
                  className={cn(
                    'card-glow w-72 shrink-0 rounded-xl border p-3 text-left',
                    n.read ? 'border-border/70 bg-card' : 'border-l-2 border-l-brand border-brand/25 bg-brand/[0.04]',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn('size-2 shrink-0 rounded-full', TYPE_DOT[n.type])} />
                    <span className={cn('truncate text-xs', n.read ? 'font-medium' : 'font-semibold')}>{n.title}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{fmtTimeAgo(n.created_at)}</span>
                  </div>
                  <p className={cn('mt-1.5 line-clamp-2 text-[11px]', n.read ? 'text-muted-foreground' : 'text-foreground/80')}>
                    {n.message}
                  </p>
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </motion.section>

      {/* ------------------------------------------------------------------ */}
      {/* Main tabs: Requests / Warnings / Fines                               */}
      {/* ------------------------------------------------------------------ */}
      <Tabs value={activeTab} onValueChange={(v) => navigateToNotifications(v as 'requests' | 'warnings' | 'fines' | 'letters')} className="w-full">
        <TabsList className="w-full max-w-xl">
          <TabsTrigger value="requests">
            <Inbox size={14} /> Requests
            <CountChip count={pendingLeaveCount + pendingCancelCount} tone="brand" />
          </TabsTrigger>
          <TabsTrigger value="letters">
            <FileText size={14} /> Letters
            <CountChip count={noticeDocs.length} tone="brand" />
          </TabsTrigger>
          <TabsTrigger value="warnings">
            <TriangleAlert size={14} /> Warnings
            <CountChip count={warnings?.length ?? 0} tone="amber" />
          </TabsTrigger>
          <TabsTrigger value="fines">
            <Banknote size={14} /> Fines
            <CountChip count={fines?.length ?? 0} tone="rose" />
          </TabsTrigger>
        </TabsList>

        {/* ---- Requests (nested tabs) ---- */}
        <TabsContent value="requests" className="mt-4">
          <div className="card-glow rounded-xl border bg-card p-4 md:p-5">
            <Tabs defaultValue="leave" className="w-full">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <TabsList>
                  <TabsTrigger value="leave">
                    <CalendarCheck2 size={14} /> Leave Requests
                    <CountChip count={pendingLeaveCount} tone="brand" />
                  </TabsTrigger>
                  <TabsTrigger value="cancellations">
                    <UserX size={14} /> Cancellations
                    <CountChip count={pendingCancelCount} tone="amber" />
                  </TabsTrigger>
                </TabsList>

                {/* Filters row (applies to both request lists) */}
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                    <SelectTrigger className="h-9 w-[132px] bg-card" aria-label="Filter by status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="approved">Approved</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={String(yearFilter)} onValueChange={(v) => setYearFilter(parseInt(v, 10))}>
                    <SelectTrigger className="h-9 w-[92px] bg-card" aria-label="Filter by year">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {YEAR_OPTIONS.map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={monthFilter === 'all' ? 'all' : String(monthFilter)}
                    onValueChange={(v) => setMonthFilter(v === 'all' ? 'all' : parseInt(v, 10))}
                  >
                    <SelectTrigger className="h-9 w-[126px] bg-card" aria-label="Filter by month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Months</SelectItem>
                      {MONTH_OPTIONS.map((m, i) => (
                        <SelectItem key={m} value={String(i)}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* ---- Leave requests ---- */}
              <TabsContent value="leave" className="mt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {filteredLeaves.length} leave request(s){' '}
                    {(statusFilter !== 'all' || monthFilter !== 'all') && <span>matching the current filters</span>}
                  </p>
                  <Button size="sm" onClick={() => setLeaveOpen(true)}>
                    <Plus size={14} /> New Leave Request
                  </Button>
                </div>
                <div className="mt-3 max-h-[600px] space-y-3 overflow-y-auto pr-1">
                  {leaveRequests === null ? (
                    <SkeletonRows rows={4} />
                  ) : filteredLeaves.length === 0 ? (
                    <EmptyState
                      icon={<CalendarCheck2 size={22} />}
                      title="No leave requests"
                      description="No leave requests match the filters above. Adjust them, or submit a new request to get started."
                    />
                  ) : (
                    filteredLeaves.map((req, i) => (
                      <LeaveCard
                        key={req.id}
                        req={req}
                        index={i}
                        isSuperAdmin={isSuperAdmin}
                        onReview={(r, approve) => setLeaveReview({ req: r, approve })}
                      />
                    ))
                  )}
                </div>
              </TabsContent>

              {/* ---- Cancellation requests ---- */}
              <TabsContent value="cancellations" className="mt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {filteredCancellations.length} cancellation request(s){' '}
                    {(statusFilter !== 'all' || monthFilter !== 'all') && <span>matching the current filters</span>}
                  </p>
                  <Button size="sm" onClick={() => setCancelOpen(true)}>
                    <Plus size={14} /> New Cancellation Request
                  </Button>
                </div>
                <div className="mt-3 max-h-[600px] space-y-3 overflow-y-auto pr-1">
                  {cancellations === null ? (
                    <SkeletonRows rows={4} />
                  ) : filteredCancellations.length === 0 ? (
                    <EmptyState
                      icon={<UserX size={22} />}
                      title="No cancellation requests"
                      description="No cancellation requests match the filters above. Adjust them, or submit a new request to get started."
                    />
                  ) : (
                    filteredCancellations.map((req, i) => (
                      <CancellationCard
                        key={req.id}
                        req={req}
                        index={i}
                        isSuperAdmin={isSuperAdmin}
                        onReview={(r, approve) => setCancelReview({ req: r, approve })}
                      />
                    ))
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>

        {/* ---- Letters & Notices ---- */}
        <TabsContent value="letters" className="mt-4">
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="card-glow rounded-xl border bg-card p-4 md:p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle
                icon={<FileText size={15} />}
                title="Letters & Notices"
                sub="Warning letters, termination letters and fine notices — download the PDF or send through WhatsApp"
              />
              <Button size="sm" className="bg-brand text-white shadow-xs hover:bg-brand/90" onClick={() => setNoticeOpen(true)}>
                <Plus size={14} /> New Letter / Notice
              </Button>
            </div>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {(['all', 'warning', 'termination', 'fine'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setLetterFilter(f)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[11px] font-medium transition-colors',
                    letterFilter === f
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  {f === 'all' ? 'All Documents' : `${noticeLabel(f)}s`}
                </button>
              ))}
            </div>

            <div className="mt-4 max-h-[600px] space-y-3 overflow-y-auto pr-1">
              {filteredDocs === null || warnings === null || fines === null ? (
                <SkeletonRows rows={3} />
              ) : filteredDocs.length === 0 ? (
                <EmptyState
                  icon={<FileText size={22} />}
                  title="No letters or notices yet"
                  description="Create a Warning Letter, Termination Letter or Fine Notice — issued warnings and fines also appear here automatically."
                />
              ) : (
                filteredDocs.map((doc, i) => (
                  <NoticeDocumentCard
                    key={`${doc.kind}-${doc.recordId}`}
                    doc={doc}
                    index={i}
                    employee={employeeById.get(doc.employeeId)}
                    onWhatsApp={openWhatsApp}
                  />
                ))
              )}
            </div>
          </motion.section>
        </TabsContent>

        {/* ---- Warnings ---- */}
        <TabsContent value="warnings" className="mt-4">
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="card-glow rounded-xl border bg-card p-4 md:p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle
                icon={<TriangleAlert size={15} />}
                title="Warnings"
                sub="Each warning deducts 0.5 stars from the employee performance rating"
              />
              <Button size="sm" className="bg-amber-500 text-white shadow-xs hover:bg-amber-600" onClick={() => setWarningOpen(true)}>
                <TriangleAlert size={14} /> Add New Warning
              </Button>
            </div>
            <div className="mt-4 max-h-[600px] space-y-3 overflow-y-auto pr-1">
              {warnings === null ? (
                <SkeletonRows />
              ) : warnings.length === 0 ? (
                <EmptyState
                  icon={<TriangleAlert size={22} />}
                  title="No warnings issued"
                  description="No warnings have been issued yet. Auto-warnings appear here after 3+ consecutive absences."
                />
              ) : (
                warnings.map((w, i) => (
                  <WarningCard
                    key={w.id}
                    warn={w}
                    index={i}
                    employee={employeeById.get(w.employee_id)}
                    onWhatsApp={openWhatsApp}
                  />
                ))
              )}
            </div>
          </motion.section>
        </TabsContent>

        {/* ---- Fines ---- */}
        <TabsContent value="fines" className="mt-4">
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="card-glow rounded-xl border bg-card p-4 md:p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle
                icon={<Banknote size={15} />}
                title="Fines"
                sub="Each fine deducts 1 star from the employee performance rating"
              />
              <Button size="sm" className="bg-rose-500 text-white shadow-xs hover:bg-rose-600" onClick={() => setFineOpen(true)}>
                <Banknote size={14} /> Add New Fine
              </Button>
            </div>
            <div className="mt-4 max-h-[600px] space-y-3 overflow-y-auto pr-1">
              {fines === null ? (
                <SkeletonRows />
              ) : fines.length === 0 ? (
                <EmptyState
                  icon={<Banknote size={22} />}
                  title="No fines issued"
                  description="No fines have been issued yet. Issue a fine to see it appear in this live feed."
                />
              ) : (
                fines.map((f, i) => (
                  <FineCard
                    key={f.id}
                    fine={f}
                    index={i}
                    employee={employeeById.get(f.employee_id)}
                    onWhatsApp={openWhatsApp}
                  />
                ))
              )}
            </div>
          </motion.section>
        </TabsContent>
      </Tabs>

      {/* ------------------------------------------------------------------ */}
      {/* Review confirmations                                                 */}
      {/* ------------------------------------------------------------------ */}
      <AlertDialog open={leaveReview !== null} onOpenChange={(o) => { if (!o) setLeaveReview(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {leaveReview?.approve ? 'Approve this leave request?' : 'Reject this leave request?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {leaveReview && (
                <>
                  <span className="font-medium text-foreground">{leaveReview.req.employee_name}</span>
                  {' '}({leaveReview.req.employee_code}) — {leaveTypeLabel(leaveReview.req)} for{' '}
                  {leaveReview.req.total_days} day(s), {fmtDate(leaveReview.req.start_date)} →{' '}
                  {fmtDate(leaveReview.req.end_date)}.
                  {leaveReview.approve
                    ? ' This will mark the request as approved.'
                    : ' This will mark the request as rejected.'}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reviewBusy}
              className={cn(
                'text-white',
                leaveReview?.approve
                  ? 'bg-emerald-500 hover:bg-emerald-600'
                  : 'bg-rose-500 hover:bg-rose-600',
              )}
              onClick={(e) => { e.preventDefault(); void confirmLeaveReview(); }}
            >
              {reviewBusy && <Loader2 size={14} className="animate-spin" />}
              {leaveReview?.approve ? 'Yes, Approve' : 'Yes, Reject'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelReview !== null} onOpenChange={(o) => { if (!o) setCancelReview(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cancelReview?.approve ? 'Approve & Delete Employee?' : 'Reject & Restore Employee?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cancelReview && (
                <>
                  {cancelReview.approve ? (
                    <>
                      This will <span className="font-medium text-rose-500">permanently remove</span>{' '}
                      <span className="font-medium text-foreground">{cancelReview.req.employee_name}</span>
                      {' '}({cancelReview.req.employee_code}) from the workforce. This action cannot be undone.
                    </>
                  ) : (
                    <>
                      This will reject the deletion request for{' '}
                      <span className="font-medium text-foreground">{cancelReview.req.employee_name}</span>
                      {' '}and restore them to active status.
                    </>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reviewBusy}
              className={cn(
                'text-white',
                cancelReview?.approve
                  ? 'bg-rose-500 hover:bg-rose-600'
                  : 'bg-emerald-500 hover:bg-emerald-600',
              )}
              onClick={(e) => { e.preventDefault(); void confirmCancelReview(); }}
            >
              {reviewBusy && <Loader2 size={14} className="animate-spin" />}
              {cancelReview?.approve ? 'Approve & Delete' : 'Reject & Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ------------------------------------------------------------------ */}
      {/* Creation dialogs                                                     */}
      {/* ------------------------------------------------------------------ */}
      <LeaveRequestDialog open={leaveOpen} onOpenChange={setLeaveOpen} employees={activeEmployees} />
      <CancellationDialog open={cancelOpen} onOpenChange={setCancelOpen} employees={cancelCandidates} />
      <WarningDialog open={warningOpen} onOpenChange={setWarningOpen} employees={activeEmployees} />
      <FineDialog open={fineOpen} onOpenChange={setFineOpen} employees={activeEmployees} />
      <NoticeCreateDialog
        open={noticeOpen}
        onOpenChange={setNoticeOpen}
        employees={activeEmployees}
        creatorName={user?.name ?? 'System'}
        onWhatsApp={openWhatsApp}
      />
      <WhatsAppSendDialog
        open={whatsapp !== null}
        onOpenChange={(o) => { if (!o) setWhatsapp(null); }}
        payload={whatsapp}
      />
    </div>
  );
}
