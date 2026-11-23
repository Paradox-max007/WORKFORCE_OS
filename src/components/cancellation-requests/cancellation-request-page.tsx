'use client';

// ============================================================================
// PULSE Workforce OS — Cancellation Requests module (employee cancellation workflow)
// ============================================================================

import { motion } from 'framer-motion';
import {
  Ban, Check, CheckCircle2, ChevronsUpDown, Clock, Eye, FileDown, FileX2, Loader2,
  Paperclip, RotateCcw, Search, Trash2, TriangleAlert, Upload, X, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { EmployeeDocViewer } from '@/components/employees/employee-doc-viewer';
import { dataApi } from '@/lib/data';
import {
  CANCELLATION_PAPER_ACCEPT, cancellationPaperUrl, getCancellationPaper,
  uploadCancellationPaper, type CancellationPaper,
} from '@/lib/files/cancellation-paper';
import { fmtDate, initials } from '@/lib/format';
import type { CancellationRequestVM, EmployeeVM } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useBranchScope } from '@/components/shared/branch-scope';
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

  // branch scope — normal admins only see requests of their branches'
  // employees (granted branches + directly assigned sites)
  const scope = useBranchScope();

  const [requests, setRequests] = useState<CancellationRequestVM[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<{ req: CancellationRequestVM; approve: boolean } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  // cancellation papers of APPROVED requests (encrypted vault): request id →
  // paper (undefined = still checking, null = nothing attached)
  const [papers, setPapers] = useState<Record<string, CancellationPaper | null>>({});
  const [attachTarget, setAttachTarget] = useState<CancellationRequestVM | null>(null);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [paperPreview, setPaperPreview] = useState<{ name: string; ext: string; url: string } | null>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

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

  // ---- cancellation papers of the approved requests (encrypted vault) --------
  useEffect(() => {
    const approved = (requests ?? []).filter((r) => r.status === 'approved');
    if (approved.length === 0) { setPapers({}); return; }
    let cancelled = false;
    Promise.all(
      approved.map(async (r) => [r.id, await getCancellationPaper(r.id).catch(() => null)] as const),
    ).then((entries) => {
      if (!cancelled) setPapers(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [requests]);

  // ---- derived values ---------------------------------------------------------
  // employee id → record (scope lookup for the request rows); requests of
  // employees no longer on the roster (archived) stay visible as history
  const employeeById = useMemo(
    () => new Map((employees ?? []).map((e) => [e.id, e] as const)),
    [employees],
  );
  /** requests of employees inside the viewer's branch scope */
  const scopedRequests = useMemo(() => {
    const list = requests ?? [];
    if (scope.effectiveSiteIds === null) return list;
    return list.filter((r) => {
      const emp = employeeById.get(r.employee_id);
      return emp ? scope.employeeInScope(emp) : true;
    });
  }, [requests, employeeById, scope]);

  const stats = useMemo(() => {
    return {
      total: scopedRequests.length,
      pending: scopedRequests.filter((r) => r.status === 'pending').length,
      approved: scopedRequests.filter((r) => r.status === 'approved').length,
      rejected: scopedRequests.filter((r) => r.status === 'rejected').length,
    };
  }, [scopedRequests]);

  const filtered = useMemo(() => {
    return scopedRequests.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!debouncedSearch) return true;
      const hay = `${r.employee_name} ${r.employee_code} ${r.reason ?? ''} ${r.requested_by_name ?? ''}`.toLowerCase();
      return hay.includes(debouncedSearch);
    });
  }, [scopedRequests, debouncedSearch, statusFilter]);

  const filtersActive = search.trim().length > 0 || statusFilter !== 'all';
  const loading = requests === null;
  // the create dialog only offers the viewer's own branch employees
  const selectableEmployees = (employees ?? [])
    .filter((e) => (e.status === 'active' || e.status === 'pending_deletion') && scope.employeeInScope(e))
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
        toast.success('Cancellation approved — employee cancelled', {
          description: `${req.employee_name} (${req.employee_code}) moved to the Cancelled list — every past record is kept.`,
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
        <Trash2 size={14} /> Approve &amp; Cancel
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

  // ---- cancellation paper (approved requests) ---------------------------------
  const openPaper = async (r: CancellationRequestVM) => {
    const paper = papers[r.id];
    if (!paper) return;
    try {
      const { url } = await cancellationPaperUrl(paper);
      setPaperPreview({
        name: `Cancellation Paper — ${r.employee_name} (${r.employee_code})`,
        ext: paper.ext,
        url,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The paper could not be decrypted.');
    }
  };

  const downloadPaper = async (r: CancellationRequestVM) => {
    const paper = papers[r.id];
    if (!paper) return;
    try {
      const { url, revoke } = await cancellationPaperUrl(paper);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Cancellation Paper — ${r.employee_name} (${r.employee_code}).${paper.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(revoke, 30_000);
      toast.success('Cancellation paper downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed.');
    }
  };

  const handleAttach = async () => {
    if (!attachTarget || !attachFile) return;
    setAttachBusy(true);
    try {
      const wasReplacing = !!papers[attachTarget.id];
      await uploadCancellationPaper(attachTarget.id, attachFile);
      const saved = await getCancellationPaper(attachTarget.id).catch(() => null);
      setPapers((p) => ({ ...p, [attachTarget.id]: saved }));
      toast.success(wasReplacing ? 'Cancellation paper updated' : 'Cancellation paper attached', {
        description: `${attachTarget.employee_name} (${attachTarget.employee_code}) — encrypted and stored with the approved request.`,
      });
      setAttachTarget(null);
      setAttachFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setAttachBusy(false);
    }
  };

  /** paper state + actions of one APPROVED request (view/download for every
   *  admin, attach/replace for super admins) */
  const paperActions = (r: CancellationRequestVM, full = false) => {
    const paper = papers[r.id];
    return (
      <div className={cn('flex items-center gap-1.5', full && 'w-full flex-wrap')}>
        {paper === undefined ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" aria-label="Checking for a cancellation paper" /> Paper…
          </span>
        ) : paper ? (
          <>
            <span
              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500"
              title={`${paper.name} · encrypted${paper.updatedAt ? ` · uploaded ${paper.updatedAt.slice(0, 10)}` : ''}`}
            >
              <Paperclip size={10} aria-hidden="true" /> Paper
            </span>
            <Button
              variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void openPaper(r)}
              aria-label={`View the cancellation paper of ${r.employee_name}`}
            >
              <Eye size={12} /> View
            </Button>
            <Button
              variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void downloadPaper(r)}
              aria-label={`Download the cancellation paper of ${r.employee_name}`}
            >
              <FileDown size={12} /> Download
            </Button>
            {isSuperAdmin && (
              <Button
                variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => { setAttachFile(null); setAttachTarget(r); }}
                aria-label={`Replace the cancellation paper of ${r.employee_name}`}
              >
                <Upload size={12} /> Replace
              </Button>
            )}
          </>
        ) : isSuperAdmin ? (
          <Button
            variant="outline" size="sm"
            className={cn('h-7 gap-1 px-2 text-[11px]', full && 'flex-1')}
            onClick={() => { setAttachFile(null); setAttachTarget(r); }}
            aria-label={`Attach the cancellation paper of ${r.employee_name}`}
          >
            <Paperclip size={12} /> Attach Paper
          </Button>
        ) : (
          <span className="text-xs italic text-muted-foreground/60">No paper attached</span>
        )}
      </div>
    );
  };

  const statCards = [
    { label: 'Total Requests', value: stats.total, icon: <FileX2 size={20} />, tone: 'brand' as const, hint: 'All cancellation requests' },
    { label: 'Pending', value: stats.pending, icon: <Clock size={20} />, tone: 'amber' as const, hint: 'Awaiting approval' },
    { label: 'Approved', value: stats.approved, icon: <CheckCircle2 size={20} />, tone: 'emerald' as const, hint: 'Employees cancelled' },
    { label: 'Rejected', value: stats.rejected, icon: <XCircle size={20} />, tone: 'rose' as const, hint: 'Employees restored' },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Cancellation Requests"
        description="Employee cancellation workflow — approvals archive, never delete"
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
                    <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Actions</TableHead>
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
                      <TableCell className="px-3 py-3">
                        {r.status === 'pending' ? (
                          isSuperAdmin ? (
                            <div className="flex items-center justify-end">{reviewButtons(r)}</div>
                          ) : (
                            <p className="text-right text-xs text-muted-foreground/50">—</p>
                          )
                        ) : r.status === 'approved' ? (
                          <div className="flex items-center justify-end">{paperActions(r)}</div>
                        ) : (
                          <p className="text-right text-xs text-muted-foreground/50">—</p>
                        )}
                      </TableCell>
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

                  {r.status === 'approved' && (
                    <div className="mt-3 border-t pt-3">
                      {paperActions(r, true)}
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
              {reviewTarget?.approve ? 'Approve & Cancel Employee?' : 'Reject & Restore Employee?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reviewTarget && (
                <>
                  <span className="font-medium text-foreground">
                    {reviewTarget.req.employee_name} ({reviewTarget.req.employee_code})
                  </span>{' '}
                  {reviewTarget.approve
                    ? '— the employee will be moved to the Cancelled list. They leave every working list but NONE of their records are deleted: attendance, salary sheet, advances, uniforms, warnings and fines all stay available for future reference. They can be restored anytime.'
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
              {reviewTarget?.approve ? 'Approve & Cancel' : 'Reject & Restore'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Attach / replace cancellation paper (approved requests) ---- */}
      <Dialog
        open={!!attachTarget}
        onOpenChange={(o) => { if (!o) { setAttachTarget(null); setAttachFile(null); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {papers[attachTarget?.id ?? ''] ? 'Replace Cancellation Paper' : 'Attach Cancellation Paper'}
            </DialogTitle>
            <DialogDescription>
              {attachTarget && (
                <>
                  The signed cancellation document of{' '}
                  <span className="font-medium text-foreground">
                    {attachTarget.employee_name} ({attachTarget.employee_code})
                  </span>{' '}
                  — a PDF or image scan. It is encrypted (AES-256-GCM) before storage and becomes
                  viewable and downloadable on the employee&apos;s details page.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <input
            ref={attachInputRef}
            type="file"
            accept={CANCELLATION_PAPER_ACCEPT}
            className="hidden"
            data-testid="cancellation-paper-input"
            aria-label="Cancellation paper file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ''; // allow re-picking the same file
              setAttachFile(f ?? null);
            }}
          />
          <button
            type="button"
            onClick={() => attachInputRef.current?.click()}
            className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/80 bg-card/50 px-4 py-6 text-center transition-colors hover:border-brand/50 hover:bg-brand/5"
          >
            <Paperclip size={20} className="text-brand" aria-hidden="true" />
            <span className="text-sm font-medium">
              {attachFile ? 'Choose a different file' : 'Click to choose a PDF or image scan'}
            </span>
            <span className="text-xs text-muted-foreground">PDF, JPG, PNG or WebP · up to 15 MB</span>
          </button>

          {attachFile && (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2.5">
              <p className="truncate text-sm font-medium" title={attachFile.name}>{attachFile.name}</p>
              <p className="text-xs text-muted-foreground">
                {(attachFile.size / 1024 / 1024).toFixed(2)} MB · will be encrypted before upload
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={attachBusy}
              onClick={() => { setAttachTarget(null); setAttachFile(null); }}
            >
              Cancel
            </Button>
            <Button
              disabled={!attachFile || attachBusy}
              onClick={() => void handleAttach()}
              className="brand-gradient font-semibold text-white shadow-md shadow-[var(--glow)] transition-transform active:scale-[0.98]"
            >
              {attachBusy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {papers[attachTarget?.id ?? ''] ? 'Replace Paper' : 'Attach Paper'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Decrypted paper preview (PDF zoom viewer / image lightbox) ---- */}
      {paperPreview && (
        <EmployeeDocViewer
          name={paperPreview.name}
          ext={paperPreview.ext}
          url={paperPreview.url}
          onClose={() => {
            URL.revokeObjectURL(paperPreview.url);
            setPaperPreview(null);
          }}
        />
      )}
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
        description: `${selectedEmployee?.full_name ?? 'The employee'} is now marked as 'Pending Deletion' until a super admin reviews it.`,
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
            Request the cancellation of an employee. A super admin must approve it first.
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
              approves or rejects. If approved, the employee is moved to the Cancelled list — all their
              past records are kept and they can be restored later.
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
