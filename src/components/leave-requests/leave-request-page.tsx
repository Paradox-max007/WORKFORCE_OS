'use client';

// ============================================================================
// PULSE Workforce OS — Leave Requests module (list, create, review, documents)
// ============================================================================

import { motion } from 'framer-motion';
import {
  CalendarPlus, Check, CheckCircle2, Clock, Download, FileText, Loader2,
  MessageCircle, Printer, Search, X, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import {
  EmptyState, PageHeader, RequestStatusBadge, SkeletonRows, StatCard,
} from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { fmtDate, initials } from '@/lib/format';
import { downloadLeavePdf, openLeavePrintWindow, shareLeaveViaWhatsApp } from '@/lib/pdf';
import { LEAVE_TYPES, type EmployeeVM, type LeaveRequestVM, type LeaveType } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';

/** Colored chip per leave type (brand + semantic accents, no blue/indigo) */
const LEAVE_TYPE_CHIP: Record<LeaveType, string> = {
  casual: 'border-brand/25 bg-brand/10 text-brand',
  sick: 'border-rose-500/25 bg-rose-500/10 text-rose-500',
  annual: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500',
  emergency: 'border-amber-500/25 bg-amber-500/10 text-amber-500',
  marriage: 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-500',
  other: 'border-zinc-500/25 bg-zinc-500/10 text-zinc-400',
};

const leaveTypeLabel = (req: LeaveRequestVM): string =>
  req.leave_type === 'other' && req.other_type_text
    ? req.other_type_text
    : LEAVE_TYPES.find((t) => t.value === req.leave_type)?.label ?? req.leave_type;

const DOC_BTN = 'size-8 text-muted-foreground transition-colors hover:bg-brand/10 hover:text-brand';

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function LeaveRequestPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const version = useRealtimeVersion(['leave_request']);

  const [requests, setRequests] = useState<LeaveRequestVM[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<{ req: LeaveRequestVM; approve: boolean } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  // ---- data loading (re-fetches whenever leave requests change anywhere) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [reqs, emps] = await Promise.all([
        dataApi.listLeaveRequests(),
        dataApi.listEmployees(),
      ]);
      if (!cancelled) {
        setRequests(reqs);
        setEmployees(emps);
      }
    })().catch(() => {
      if (!cancelled) {
        setRequests([]);
        setEmployees([]);
      }
    });
    return () => { cancelled = true; };
  }, [version]);

  // ---- search debounce (300ms) ------------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ---- derived values ---------------------------------------------------------
  const stats = useMemo(() => {
    const list = requests ?? [];
    return {
      total: list.length,
      pending: list.filter((r) => r.status === 'pending').length,
      approved: list.filter((r) => r.status === 'approved').length,
      rejected: list.filter((r) => r.status === 'rejected').length,
    };
  }, [requests]);

  const filtered = useMemo(() => {
    const list = requests ?? [];
    return list.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!debouncedSearch) return true;
      const label = leaveTypeLabel(r).toLowerCase();
      const hay = `${r.employee_name} ${r.employee_code} ${r.leave_type} ${label} ${r.other_type_text ?? ''} ${r.reason}`.toLowerCase();
      return hay.includes(debouncedSearch);
    });
  }, [requests, debouncedSearch, statusFilter]);

  const filtersActive = search.trim().length > 0 || statusFilter !== 'all';
  const loading = requests === null;
  const activeEmployees = (employees ?? []).filter((e) => e.status === 'active');

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('all');
  };

  // ---- review (super admin only, pending only) ---------------------------------
  const handleReview = async () => {
    if (!reviewTarget) return;
    setReviewBusy(true);
    try {
      const { req, approve } = reviewTarget;
      await dataApi.reviewLeaveRequest(req.id, approve);
      toast.success(approve ? 'Leave request approved' : 'Leave request rejected', {
        description: `${req.employee_name} — ${leaveTypeLabel(req)} (${req.total_days} day(s))`,
      });
      setReviewTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to review the request');
    } finally {
      setReviewBusy(false);
    }
  };

  const shareWhatsApp = (req: LeaveRequestVM) => {
    shareLeaveViaWhatsApp(req).catch(() => toast.error('Unable to share this application via WhatsApp'));
  };

  const statCards = [
    { label: 'Total Requests', value: stats.total, icon: <FileText size={20} />, tone: 'brand' as const, hint: 'All leave applications' },
    { label: 'Pending', value: stats.pending, icon: <Clock size={20} />, tone: 'amber' as const, hint: 'Awaiting review' },
    { label: 'Approved', value: stats.approved, icon: <CheckCircle2 size={20} />, tone: 'emerald' as const, hint: 'Confirmed leave' },
    { label: 'Rejected', value: stats.rejected, icon: <XCircle size={20} />, tone: 'rose' as const, hint: 'Declined applications' },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Leave Requests"
        description="Review and manage employee leave applications"
        actions={
          <Button
            onClick={() => setCreateOpen(true)}
            className="h-10 brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            <CalendarPlus size={16} /> New Leave Request
          </Button>
        }
      />

      {/* ---- Stat cards ---- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          : statCards.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <StatCard label={s.label} value={s.value} icon={s.icon} tone={s.tone} hint={s.hint} />
            </motion.div>
          ))}
      </div>

      {/* ---- Requests card (filters + list) ---- */}
      <div className="card-glow rounded-xl border bg-card">
        {/* Filters */}
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by employee, leave type or reason…"
              aria-label="Search leave requests"
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
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="h-10 w-full bg-card sm:w-44" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="text-muted-foreground">
              <X size={14} /> Reset
            </Button>
          )}
          <p className="hidden shrink-0 text-xs text-muted-foreground lg:block">
            {loading ? 'Loading…' : `${filtered.length} of ${requests?.length ?? 0} request(s)`}
          </p>
        </div>

        {/* Content */}
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={5} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<CalendarPlus size={22} />}
              title={filtersActive ? 'No matching leave requests' : 'No leave requests yet'}
              description={filtersActive
                ? 'Try adjusting your search or status filter to find what you are looking for.'
                : 'Create the first leave application — it will be reviewed by a super admin.'}
              action={!filtersActive ? (
                <Button
                  onClick={() => setCreateOpen(true)}
                  className="brand-gradient font-semibold text-white"
                >
                  <CalendarPlus size={16} /> New Leave Request
                </Button>
              ) : undefined}
            />
          </div>
        ) : (
          <>
            {/* ---- Desktop table ---- */}
            <div className="hidden overflow-x-auto p-2 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Employee</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Leave Type</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Duration</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Reason</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Status</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Created</TableHead>
                    <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Documents</TableHead>
                    {isSuperAdmin && (
                      <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Review</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r, i) => (
                    <motion.tr
                      key={r.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/30"
                    >
                      <TableCell className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-bold text-brand">
                            {initials(r.employee_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{r.employee_name}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">{r.employee_code}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium', LEAVE_TYPE_CHIP[r.leave_type])}>
                          {leaveTypeLabel(r)}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <p className="text-sm font-medium">{r.total_days} day{r.total_days === 1 ? '' : 's'}</p>
                        <p className="text-[11px] text-muted-foreground">{fmtDate(r.start_date)} → {fmtDate(r.end_date)}</p>
                      </TableCell>
                      <TableCell className="max-w-[220px] px-3 py-3">
                        <p className="truncate text-sm text-muted-foreground" title={r.reason}>{r.reason}</p>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <RequestStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <p className="text-sm">{fmtDate(r.created_at)}</p>
                        <p className="text-[11px] text-muted-foreground">by {r.created_by_name ?? 'System'}</p>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost" size="icon" className={DOC_BTN}
                            title="Download PDF" aria-label={`Download PDF — ${r.employee_name}`}
                            onClick={() => downloadLeavePdf(r)}
                          >
                            <Download size={15} />
                          </Button>
                          <Button
                            variant="ghost" size="icon" className={DOC_BTN}
                            title="Print" aria-label={`Print — ${r.employee_name}`}
                            onClick={() => openLeavePrintWindow(r)}
                          >
                            <Printer size={15} />
                          </Button>
                          <Button
                            variant="ghost" size="icon" className={DOC_BTN}
                            title="Share via WhatsApp" aria-label={`Share via WhatsApp — ${r.employee_name}`}
                            onClick={() => shareWhatsApp(r)}
                          >
                            <MessageCircle size={15} />
                          </Button>
                        </div>
                      </TableCell>
                      {isSuperAdmin && (
                        <TableCell className="px-3 py-3">
                          {r.status === 'pending' ? (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost" size="icon"
                                className="size-8 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500"
                                title="Approve" aria-label={`Approve — ${r.employee_name}`}
                                onClick={() => setReviewTarget({ req: r, approve: true })}
                              >
                                <Check size={16} />
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                className="size-8 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
                                title="Reject" aria-label={`Reject — ${r.employee_name}`}
                                onClick={() => setReviewTarget({ req: r, approve: false })}
                              >
                                <X size={16} />
                              </Button>
                            </div>
                          ) : (
                            <p className="text-right text-xs text-muted-foreground/50">—</p>
                          )}
                        </TableCell>
                      )}
                    </motion.tr>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* ---- Mobile cards ---- */}
            <div className="space-y-3 p-4 md:hidden">
              {filtered.map((r, i) => (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="rounded-xl border bg-background/40 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-bold text-brand">
                        {initials(r.employee_name)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.employee_name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{r.employee_code}</p>
                      </div>
                    </div>
                    <RequestStatusBadge status={r.status} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium', LEAVE_TYPE_CHIP[r.leave_type])}>
                      {leaveTypeLabel(r)}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand">
                      <CalendarPlus size={11} /> {r.total_days} day{r.total_days === 1 ? '' : 's'}
                    </span>
                  </div>

                  <p className="mt-2 text-xs text-muted-foreground">
                    {fmtDate(r.start_date)} → {fmtDate(r.end_date)} · created {fmtDate(r.created_at)} by {r.created_by_name ?? 'System'}
                  </p>
                  <p className="mt-2 line-clamp-2 text-sm">{r.reason}</p>

                  <div className="mt-3 flex items-center justify-between border-t pt-3">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="icon" className={DOC_BTN}
                        aria-label="Download PDF" onClick={() => downloadLeavePdf(r)}
                      >
                        <Download size={15} />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className={DOC_BTN}
                        aria-label="Print" onClick={() => openLeavePrintWindow(r)}
                      >
                        <Printer size={15} />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className={DOC_BTN}
                        aria-label="Share via WhatsApp" onClick={() => shareWhatsApp(r)}
                      >
                        <MessageCircle size={15} />
                      </Button>
                    </div>
                    {isSuperAdmin && r.status === 'pending' && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost" size="icon"
                          className="size-8 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500"
                          aria-label="Approve" onClick={() => setReviewTarget({ req: r, approve: true })}
                        >
                          <Check size={16} />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          className="size-8 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
                          aria-label="Reject" onClick={() => setReviewTarget({ req: r, approve: false })}
                        >
                          <X size={16} />
                        </Button>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ---- New request dialog ---- */}
      <NewLeaveRequestDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        employees={activeEmployees}
      />

      {/* ---- Review confirmation ---- */}
      <AlertDialog
        open={!!reviewTarget}
        onOpenChange={(o) => { if (!o) setReviewTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reviewTarget?.approve ? 'Approve this leave request?' : 'Reject this leave request?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reviewTarget && (
                <>
                  {reviewTarget.approve
                    ? 'This will approve the request and the employee will be notified. '
                    : 'This will reject the request and the employee will be notified. '}
                  <span className="font-medium text-foreground">
                    {reviewTarget.req.employee_name} ({reviewTarget.req.employee_code})
                  </span>{' '}
                  — {leaveTypeLabel(reviewTarget.req)}, {reviewTarget.req.total_days} day(s) from{' '}
                  {fmtDate(reviewTarget.req.start_date)} to {fmtDate(reviewTarget.req.end_date)}.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewBusy}>Cancel</AlertDialogCancel>
            <Button
              disabled={reviewBusy}
              onClick={handleReview}
              className={
                reviewTarget?.approve
                  ? 'bg-emerald-600 text-white hover:bg-emerald-600/90'
                  : 'bg-rose-600 text-white hover:bg-rose-600/90'
              }
            >
              {reviewBusy
                ? <Loader2 size={16} className="animate-spin" />
                : reviewTarget?.approve ? <Check size={16} /> : <X size={16} />}
              {reviewTarget?.approve ? 'Approve' : 'Reject'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New Leave Request dialog
// ---------------------------------------------------------------------------
function NewLeaveRequestDialog({
  open, onOpenChange, employees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
}) {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [leaveType, setLeaveType] = useState<LeaveType | null>(null);
  const [otherTypeText, setOtherTypeText] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset the form every time the dialog opens
  useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setLeaveType(null);
      setOtherTypeText('');
      setStartDate('');
      setEndDate('');
      setReason('');
      setSubmitting(false);
    }
  }, [open]);

  // Auto-calculated total days = date diff + 1 (minimum 1)
  const totalDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
    const diff = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    return diff > 0 ? diff : 0;
  }, [startDate, endDate]);

  const selectedEmployee = employees.find((e) => e.id === employeeId) ?? null;

  const handleSubmit = async () => {
    if (!employeeId) { toast.error('Please select an employee'); return; }
    if (!leaveType) { toast.error('Please select a leave type'); return; }
    if (leaveType === 'other' && !otherTypeText.trim()) { toast.error('Please specify the leave type'); return; }
    if (!startDate || !endDate) { toast.error('Please select the start and end dates'); return; }
    if (totalDays < 1) { toast.error('The end date must be on or after the start date'); return; }
    if (!reason.trim()) { toast.error('Please provide a reason for the leave'); return; }

    setSubmitting(true);
    try {
      await dataApi.createLeaveRequest({
        employee_id: employeeId,
        leave_type: leaveType,
        other_type_text: leaveType === 'other' ? otherTypeText.trim() : null,
        start_date: startDate,
        end_date: endDate,
        total_days: totalDays,
        reason: reason.trim(),
      });
      toast.success('Leave request submitted', {
        description: `${selectedEmployee?.full_name ?? 'Employee'} — ${totalDays} day(s) of leave, now pending review.`,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit the leave request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Leave Request</DialogTitle>
          <DialogDescription>
            Submit a leave application on behalf of an employee. A super admin will review it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Employee */}
          <div className="space-y-2">
            <Label>Employee <span className="text-rose-500">*</span></Label>
            <EmployeeCombobox
              employees={employees}
              value={employeeId}
              onChange={setEmployeeId}
              placeholder="Search employees…"
              emptyText="No active employees found."
            />
          </div>

          {/* Leave type */}
          <div className="space-y-2">
            <Label>Leave Type <span className="text-rose-500">*</span></Label>
            <Select
              value={leaveType ?? undefined}
              onValueChange={(v) => {
                setLeaveType(v as LeaveType);
                if (v !== 'other') setOtherTypeText('');
              }}
            >
              <SelectTrigger className="h-11 w-full" aria-label="Leave type">
                <SelectValue placeholder="Select leave type" />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Other → specify */}
          {leaveType === 'other' && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-2"
            >
              <Label htmlFor="other-type">Specify Leave Type <span className="text-rose-500">*</span></Label>
              <Input
                id="other-type"
                value={otherTypeText}
                onChange={(e) => setOtherTypeText(e.target.value)}
                placeholder="e.g. Study leave"
                className="h-11"
              />
            </motion.div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="start-date">Start Date <span className="text-rose-500">*</span></Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-date">End Date <span className="text-rose-500">*</span></Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-11"
              />
            </div>
          </div>

          {/* Total days (read-only, auto) */}
          <div className="space-y-2">
            <Label htmlFor="total-days">Total Days</Label>
            <Input
              id="total-days"
              readOnly
              value={totalDays > 0 ? String(totalDays) : ''}
              placeholder="—"
              className="h-11 bg-muted/50 font-medium"
            />
            <p className="text-xs text-muted-foreground">
              Auto-calculated from the selected dates (minimum 1 day).
            </p>
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason <span className="text-rose-500">*</span></Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the reason for this leave request…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <CalendarPlus size={16} />}
            Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
