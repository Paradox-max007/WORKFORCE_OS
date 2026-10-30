'use client';

// ============================================================================
// PULSE Workforce OS — Cancellation Requests module (employee removal workflow)
// ============================================================================

import { motion } from 'framer-motion';
import {
  Ban, Check, CheckCircle2, ChevronsUpDown, Clock, FileX2, Loader2,
  RotateCcw, Search, Trash2, TriangleAlert, X, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  EmptyState, EmployeeStatusBadge, PageHeader, RequestStatusBadge, SkeletonRows, StatCard,
} from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import type { CancellationRequestVM, EmployeeVM } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';

const APPROVE_BTN = 'border-rose-500/30 bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 hover:text-rose-500';
const RESTORE_BTN = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-500';

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function CancellationRequestPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const version = useRealtimeVersion(['cancellation_request']);

  const [requests, setRequests] = useState<CancellationRequestVM[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<{ req: CancellationRequestVM; approve: boolean } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  // ---- data loading (re-fetches whenever cancellation requests change) --------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [reqs, emps] = await Promise.all([
        dataApi.listCancellationRequests(),
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
      const hay = `${r.employee_name} ${r.employee_code} ${r.reason ?? ''} ${r.requested_by_name ?? ''}`.toLowerCase();
      return hay.includes(debouncedSearch);
    });
  }, [requests, debouncedSearch, statusFilter]);

  const filtersActive = search.trim().length > 0 || statusFilter !== 'all';
  const loading = requests === null;
  const selectableEmployees = (employees ?? [])
    .filter((e) => e.status === 'active' || e.status === 'pending_deletion')
    .sort((a, b) => (a.status === b.status ? a.full_name.localeCompare(b.full_name) : a.status === 'active' ? -1 : 1));

  const resetFilters = () => {
    setSearch('');
    setStatusFilter('all');
  };

  // ---- review (super admin only, pending only) --------------------------------
  const handleReview = async () => {
    if (!reviewTarget) return;
    setReviewBusy(true);
    try {
      const { req, approve } = reviewTarget;
      await dataApi.reviewCancellationRequest(req.id, approve);
      if (approve) {
        toast.success('Cancellation approved — employee deleted', {
          description: `${req.employee_name} (${req.employee_code}) has been permanently removed.`,
        });
      } else {
        toast.success('Cancellation rejected — employee restored', {
          description: `${req.employee_name} (${req.employee_code}) is active again.`,
        });
      }
      setReviewTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to review the request');
    } finally {
      setReviewBusy(false);
    }
  };

  const reviewButtons = (r: CancellationRequestVM, full = false) => (
    <div className={cn('flex items-center gap-2', full && 'w-full')}>
      <Button
        variant="outline" size="sm"
        className={cn(APPROVE_BTN, full && 'flex-1')}
        onClick={() => setReviewTarget({ req: r, approve: true })}
      >
        <Trash2 size={14} /> Approve &amp; Delete
      </Button>
      <Button
        variant="outline" size="sm"
        className={cn(RESTORE_BTN, full && 'flex-1')}
        onClick={() => setReviewTarget({ req: r, approve: false })}
      >
        <RotateCcw size={14} /> Reject &amp; Restore
      </Button>
    </div>
  );

  const statCards = [
    { label: 'Total Requests', value: stats.total, icon: <FileX2 size={20} />, tone: 'brand' as const, hint: 'All cancellation requests' },
    { label: 'Pending', value: stats.pending, icon: <Clock size={20} />, tone: 'amber' as const, hint: 'Awaiting approval' },
    { label: 'Approved', value: stats.approved, icon: <CheckCircle2 size={20} />, tone: 'emerald' as const, hint: 'Employees deleted' },
    { label: 'Rejected', value: stats.rejected, icon: <XCircle size={20} />, tone: 'rose' as const, hint: 'Employees restored' },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Cancellation Requests"
        description="Employee removal workflow — approvals required before deletion"
        actions={
          <Button
            onClick={() => setCreateOpen(true)}
            className="h-10 border border-amber-500/30 bg-amber-500/10 font-semibold text-amber-500 shadow-lg shadow-amber-500/10 transition-all hover:bg-amber-500/20 hover:text-amber-500 active:scale-[0.98]"
          >
            <Ban size={16} /> New Cancellation Request
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
              placeholder="Search by employee or reason…"
              aria-label="Search cancellation requests"
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
              icon={<Ban size={22} />}
              title={filtersActive ? 'No matching cancellation requests' : 'No cancellation requests'}
              description={filtersActive
                ? 'Try adjusting your search or status filter to find what you are looking for.'
                : 'Submit a cancellation request to start the employee removal workflow.'}
              action={!filtersActive ? (
                <Button
                  onClick={() => setCreateOpen(true)}
                  className="border border-amber-500/30 bg-amber-500/10 font-semibold text-amber-500 hover:bg-amber-500/20 hover:text-amber-500"
                >
                  <Ban size={16} /> New Cancellation Request
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
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Employee Status</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Reason</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Request Status</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Requested By</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Created</TableHead>
                    {isSuperAdmin && (
                      <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Review Actions</TableHead>
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
                            {r.employee_position && (
                              <p className="truncate text-[11px] text-muted-foreground/70">{r.employee_position}</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <EmployeeStatusBadge status={r.employee_status} />
                      </TableCell>
                      <TableCell className="max-w-[220px] px-3 py-3">
                        {r.reason
                          ? <p className="truncate text-sm text-muted-foreground" title={r.reason}>{r.reason}</p>
                          : <p className="text-sm italic text-muted-foreground/60">No reason provided</p>}
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <RequestStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <p className="text-sm">{r.requested_by_name ?? '—'}</p>
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <p className="text-sm">{fmtDate(r.created_at)}</p>
                      </TableCell>
                      {isSuperAdmin && (
                        <TableCell className="px-3 py-3">
                          {r.status === 'pending' ? (
                            <div className="flex items-center justify-end">
                              {reviewButtons(r)}
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
                        {r.employee_position && (
                          <p className="truncate text-[11px] text-muted-foreground/70">{r.employee_position}</p>
                        )}
                      </div>
                    </div>
                    <RequestStatusBadge status={r.status} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <EmployeeStatusBadge status={r.employee_status} />
                    <span className="text-[11px] text-muted-foreground">
                      by {r.requested_by_name ?? '—'} · {fmtDate(r.created_at)}
                    </span>
                  </div>

                  {r.reason
                    ? <p className="mt-2 line-clamp-2 text-sm">{r.reason}</p>
                    : <p className="mt-2 text-sm italic text-muted-foreground/60">No reason provided</p>}

                  {isSuperAdmin && r.status === 'pending' && (
                    <div className="mt-3 border-t pt-3">
                      {reviewButtons(r, true)}
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ---- New request dialog ---- */}
      <NewCancellationRequestDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        employees={selectableEmployees}
      />

      {/* ---- Review confirmation ---- */}
      <AlertDialog
        open={!!reviewTarget}
        onOpenChange={(o) => { if (!o) setReviewTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reviewTarget?.approve ? 'Approve & Delete Employee?' : 'Reject & Restore Employee?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reviewTarget && (
                <>
                  <span className="font-medium text-foreground">
                    {reviewTarget.req.employee_name} ({reviewTarget.req.employee_code})
                  </span>{' '}
                  {reviewTarget.approve
                    ? '— the employee will be permanently deleted and their records hidden. This action cannot be undone.'
                    : '— the employee will be restored to active status and the cancellation request will be marked as rejected.'}
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
                  ? 'bg-rose-600 text-white hover:bg-rose-600/90'
                  : 'bg-emerald-600 text-white hover:bg-emerald-600/90'
              }
            >
              {reviewBusy
                ? <Loader2 size={16} className="animate-spin" />
                : reviewTarget?.approve ? <Trash2 size={16} /> : <RotateCcw size={16} />}
              {reviewTarget?.approve ? 'Approve & Delete' : 'Reject & Restore'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New Cancellation Request dialog
// ---------------------------------------------------------------------------
function NewCancellationRequestDialog({
  open, onOpenChange, employees,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: EmployeeVM[];
}) {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset the form every time the dialog opens
  useEffect(() => {
    if (open) {
      setEmployeeId(null);
      setReason('');
      setSubmitting(false);
    }
  }, [open]);

  const selectedEmployee = employees.find((e) => e.id === employeeId) ?? null;

  const handleSubmit = async () => {
    if (!employeeId) { toast.error('Please select an employee'); return; }
    setSubmitting(true);
    try {
      await dataApi.createCancellationRequest(employeeId, reason.trim() || null);
      toast.success('Cancellation request submitted', {
        description: `${selectedEmployee?.full_name ?? 'The employee'} is now marked as 'Pending Deletion' until a super admin approves it.`,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit the cancellation request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Cancellation Request</DialogTitle>
          <DialogDescription>
            Request the removal of an employee. A super admin must approve it before deletion.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Consequence warning */}
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400"
            role="note"
          >
            <TriangleAlert size={18} className="mt-0.5 shrink-0" />
            <p>
              Upon submission, the employee will be marked as{' '}
              <span className="font-semibold">&quot;Pending Deletion&quot;</span> until a super admin
              approves or rejects. If approved, the employee will be permanently deleted.
            </p>
          </motion.div>

          {/* Employee picker (pending-deletion employees are disabled) */}
          <div className="space-y-2">
            <Label>Employee <span className="text-rose-500">*</span></Label>
            <DeletionEmployeePicker
              employees={employees}
              value={employeeId}
              onChange={setEmployeeId}
            />
            <p className="text-xs text-muted-foreground">
              Employees already pending deletion cannot be selected again.
            </p>
          </div>

          {/* Reason (optional) */}
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why should this employee be removed? (optional)"
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
            className="bg-rose-600 font-semibold text-white shadow-lg shadow-rose-500/10 transition-all hover:bg-rose-600/90 active:scale-[0.98]"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Ban size={16} />}
            Submit Cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Employee picker for the deletion workflow — shows active + pending-deletion
// employees, with pending ones disabled (a "pending" hint, since the API
// rejects employees that already have an open request).
// ---------------------------------------------------------------------------
function DeletionEmployeePicker({
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
    return employees.filter(
      (e) =>
        e.full_name.toLowerCase().includes(q) ||
        e.employee_code.toLowerCase().includes(q) ||
        (e.position ?? '').toLowerCase().includes(q),
    );
  }, [employees, query]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-11 w-full justify-between font-normal"
        >
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
        <Command shouldFilter={false}>
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{e.full_name}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {e.employee_code} · {e.position ?? 'No position'}
                    </span>
                  </span>
                  {e.status === 'pending_deletion' && (
                    <span className="ml-2 shrink-0 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                      pending
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
