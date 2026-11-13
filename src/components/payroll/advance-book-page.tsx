'use client';

// ============================================================================
// PULSE Workforce OS — Advance Book (the advance ledger)
// ----------------------------------------------------------------------------
// Every advance handed to an employee is a RECORD here: amount, given date,
// the CUT month (the salary month that recovers it) and a note. The status is
// DERIVED from the payroll data — it can never drift:
//
//   DUE      not yet recovered (the cut month's salary was not paid yet, or
//            the record is scheduled for a future month)
//   OVERDUE  due AND the cut month already passed — chip prompts rescheduling
//   CLEARED  the advance was folded into the cut month's Advance column and
//            that salary was PAID (unmarking the payment flips it back)
//
// The sync (advance_book_sync_period / save_advance_record RPC) folds DUE
// records into the cut month's payroll Advance column automatically — manual
// advance edits and the time-card carryover are never double-counted.
//
// From HERE and from the Payroll page's Advance popover you can pick the cut
// month per record (edit = reschedule: the old month's advance is corrected,
// the new month's takes the amount in).
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  BadgeCheck, BookOpenText, CalendarClock, CircleDollarSign, ListFilter,
  Loader2, Pencil, Plus, Search, Trash2, TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { SectionTitle } from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { fmtDate, initials } from '@/lib/format';
import type { AdvanceBookReport, AdvanceRecordVM, EmployeeVM } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useRealtimeVersion } from '@/store/realtime';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const fmtMoney = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthLabel = (y: number, m: number): string => `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;

type StatusFilter = 'all' | 'due' | 'overdue' | 'cleared';

/** Add / edit (reschedule) dialog state */
interface FormState {
  id: string | null;
  employeeId: string | null;
  amount: string;
  givenDate: string;
  cutMonth: string;
  cutYear: string;
  note: string;
}

const todayYMD = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function AdvanceBookPage() {
  const realtimeVersion = useRealtimeVersion(['advance_record', 'payroll_employee']);
  const [report, setReport] = useState<AdvanceBookReport | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdvanceRecordVM | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState<FormState>({
    id: null, employeeId: null, amount: '', givenDate: todayYMD(),
    cutMonth: '', cutYear: '', note: '',
  });

  const load = (): void => {
    Promise.all([dataApi.getAdvanceBook(), dataApi.listEmployees()])
      .then(([book, emps]) => {
        setReport(book);
        setEmployees(emps);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Failed to load the advance book');
      });
  };

  useEffect(load, [realtimeVersion]);

  // ---- filtering -----------------------------------------------------------
  const filtered = useMemo(() => {
    if (!report) return [];
    const q = search.toLowerCase().trim();
    return report.records.filter((r) => {
      if (q && !r.full_name.toLowerCase().includes(q)
        && !r.employee_code.toLowerCase().includes(q)) return false;
      if (statusFilter === 'due') return !r.cleared && !r.overdue;
      if (statusFilter === 'overdue') return r.overdue;
      if (statusFilter === 'cleared') return r.cleared;
      return true;
    });
  }, [report, search, statusFilter]);

  const visibleTotal = useMemo(
    () => filtered.reduce((n, r) => n + r.amount, 0), [filtered]);

  // ---- add / edit dialog ---------------------------------------------------
  const openAdd = (): void => {
    const now = new Date();
    setForm({
      id: null, employeeId: null, amount: '', givenDate: todayYMD(),
      cutMonth: String(now.getMonth() + 1), cutYear: String(now.getFullYear()), note: '',
    });
    setFormOpen(true);
  };

  const openEdit = (r: AdvanceRecordVM): void => {
    setForm({
      id: r.id, employeeId: r.employee_id, amount: String(r.amount),
      givenDate: r.given_date, cutMonth: String(r.cut_month),
      cutYear: String(r.cut_year), note: r.note ?? '',
    });
    setFormOpen(true);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const amount = Number(form.amount);
    if (!form.employeeId) { toast.error('Pick an employee'); return; }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Advance amount must be greater than 0');
      return;
    }
    if (!form.cutMonth || !form.cutYear) { toast.error('Pick the cut month'); return; }
    setSaving(true);
    try {
      await dataApi.saveAdvanceRecord({
        id: form.id ?? undefined,
        employee_id: form.employeeId,
        amount: Math.round(amount * 100) / 100,
        given_date: form.givenDate || todayYMD(),
        cut_year: Number(form.cutYear),
        cut_month: Number(form.cutMonth),
        note: form.note.trim() || null,
      });
      toast.success(form.id ? 'Advance record updated' : 'Advance recorded', {
        description: `${fmtMoney(Math.round(amount * 100) / 100)} cut from ${MONTH_NAMES[Number(form.cutMonth) - 1]} ${form.cutYear} — the payroll Advance column of that month follows automatically.`,
      });
      setFormOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the advance record');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await dataApi.deleteAdvanceRecord(deleteTarget.id);
      toast.success('Advance record deleted', {
        description: `${deleteTarget.full_name} — the cut month's Advance column was corrected.`,
      });
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the advance record');
    } finally {
      setDeleting(false);
    }
  };

  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return [y - 2, y - 1, y, y + 1, y + 2];
  }, []);

  // ---- render --------------------------------------------------------------
  if (!report || !employees) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  const t = report.totals;
  const cards = [
    {
      icon: <CircleDollarSign size={12} />, label: 'Due', tone: 'amber' as const,
      value: fmtMoney(t.due_amount),
      hint: `${t.due_count} record${t.due_count === 1 ? '' : 's'} not yet recovered`,
    },
    {
      icon: <TriangleAlert size={12} />, label: 'Overdue', tone: 'rose' as const,
      value: fmtMoney(t.overdue_amount),
      hint: `${t.overdue_count} past the cut month — reschedule or pay`,
    },
    {
      icon: <BadgeCheck size={12} />, label: 'Cleared', tone: 'emerald' as const,
      value: fmtMoney(t.cleared_amount),
      hint: `${t.cleared_count} record${t.cleared_count === 1 ? '' : 's'} recovered from paid salaries`,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle
          icon={<BookOpenText size={18} />}
          title="Advance Book"
          sub="The advance ledger — every advance, its cut month, and whether it is due or cleared"
        />
        <Button className="brand-gradient text-white" onClick={openAdd}>
          <Plus size={15} className="mr-1" /> Add Advance
        </Button>
      </div>

      {/* summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {cards.map((c, i) => (
          <motion.div
            key={c.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
            className={cn(
              'card-glow rounded-xl border bg-card p-4',
              c.tone === 'amber' && 'border-amber-500/25 bg-amber-500/[0.05]',
              c.tone === 'rose' && 'border-rose-500/25 bg-rose-500/[0.05]',
              c.tone === 'emerald' && 'border-emerald-500/25 bg-emerald-500/[0.05]',
            )}
          >
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {c.icon} {c.label}
            </p>
            <p className={cn(
              'mt-1.5 text-2xl font-bold tracking-tight tabular-nums',
              c.tone === 'amber' && 'text-amber-500',
              c.tone === 'rose' && 'text-rose-500',
              c.tone === 'emerald' && 'text-emerald-500',
            )}>
              {c.value}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{c.hint}</p>
          </motion.div>
        ))}
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee or code…"
            className="h-9 bg-card pl-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ListFilter size={14} />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="h-9 w-36 bg-card text-xs" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All records</SelectItem>
              <SelectItem value="due">Due</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
              <SelectItem value="cleared">Cleared</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ledger table */}
      <section className="card-glow overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <Table className="[&_td]:px-3 [&_th]:px-3">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Sl No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Given</TableHead>
                <TableHead title="The salary month that recovers this advance">Cut From</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="min-w-40">Note</TableHead>
                <TableHead>Added By</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {filtered.map((r, i) => (
                  <motion.tr
                    key={r.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="border-b transition-colors hover:bg-muted/50"
                  >
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand/15 text-[11px] font-bold text-brand">
                          {r.photo
                            ? <img src={r.photo} alt="" className="size-full object-cover" />
                            : initials(r.full_name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{r.full_name}</p>
                          <p className="font-mono text-[10px] text-muted-foreground">{r.employee_code}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="flex flex-col items-end gap-1">
                        <span className="font-mono text-sm font-semibold">{fmtMoney(r.amount)}</span>
                        {r.from_time_card && (
                          <span
                            className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-600 dark:text-sky-400"
                            title="Born from a TIME-CARD carryover — the attendance salary exceeded the approved time card hours, so the difference is recovered from the cut month"
                          >
                            Time card
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDate(r.given_date)}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-xs font-medium">
                        <CalendarClock size={11} className="text-muted-foreground" />
                        {monthLabel(r.cut_year, r.cut_month)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.cleared ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-500"
                          title={`Recovered by the paid ${monthLabel(r.cut_year, r.cut_month)} salary${r.cleared_at ? ` — ${fmtDate(r.cleared_at.slice(0, 10))}` : ''}`}
                        >
                          <BadgeCheck size={11} /> Cleared
                        </span>
                      ) : r.overdue ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-500"
                          title="The cut month has already passed without the salary being paid — reschedule it to a later month"
                        >
                          <TriangleAlert size={11} /> Overdue
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
                          title={r.applied
                            ? `Scheduled — inside the ${monthLabel(r.cut_year, r.cut_month)} Advance column, salary not paid yet`
                            : `Scheduled for ${monthLabel(r.cut_year, r.cut_month)} — folds into that month's Advance column`}
                        >
                          <CircleDollarSign size={11} /> Due
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-muted-foreground" title={r.note ?? undefined}>
                      {r.note ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.created_by_name ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.cleared ? (
                        <span className="text-[11px] text-muted-foreground" title="Cleared records are kept as history">
                          history
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button
                            variant="ghost" size="sm" className="h-7 px-2 text-[11px]"
                            onClick={() => openEdit(r)}
                            title="Edit the amount or reschedule the cut month"
                          >
                            <Pencil size={12} /> Reschedule
                          </Button>
                          <Button
                            variant="ghost" size="sm"
                            className="h-7 px-2 text-[11px] text-rose-500 hover:text-rose-600"
                            onClick={() => setDeleteTarget(r)}
                            title="Delete this advance record"
                          >
                            <Trash2 size={12} />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                    {report.records.length === 0
                      ? 'No advances recorded yet — use Add Advance to hand one out and pick its cut month.'
                      : 'No records match the search / filter.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {filtered.length > 0 && (
              <TableFooter>
                <TableRow className="font-semibold hover:bg-transparent">
                  <TableCell colSpan={2} className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                    Total — {filtered.length} record{filtered.length === 1 ? '' : 's'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmtMoney(visibleTotal)}</TableCell>
                  <TableCell colSpan={6} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
        <p className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">
          An advance is CLEARED when the salary of its cut month is marked paid with the amount folded into that
          month&apos;s Advance column (the Payroll page). Unmarking the payment flips the record back to Due. Records
          added after a month was already paid stay Due — reschedule them to a later month.
        </p>
      </section>

      {/* add / edit dialog */}
      <Dialog open={formOpen} onOpenChange={(v) => { if (!saving) setFormOpen(v); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit / reschedule advance' : 'Add advance'}</DialogTitle>
            <DialogDescription>
              {form.id
                ? 'Only due records can be edited — cleared ones are history. Changing the cut month corrects both months automatically.'
                : 'The amount is folded into the Advance column of the cut month (its net salary), and cleared when that salary is paid.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Employee</p>
              <EmployeeCombobox
                employees={employees}
                value={form.employeeId}
                onChange={(id) => setForm((f) => ({ ...f, employeeId: id }))}
                disabled={saving || !!form.id}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Amount</p>
                <Input
                  type="number" min={0} step="0.01" inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  disabled={saving}
                  className="h-11 font-mono"
                  placeholder="0.00"
                />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Given on</p>
                <Input
                  type="date"
                  value={form.givenDate}
                  onChange={(e) => setForm((f) => ({ ...f, givenDate: e.target.value }))}
                  disabled={saving}
                  className="h-11"
                />
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Cut from the salary of
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  value={form.cutMonth}
                  onValueChange={(v) => setForm((f) => ({ ...f, cutMonth: v }))}
                  disabled={saving}
                >
                  <SelectTrigger className="h-11 bg-card" aria-label="Cut month">
                    <SelectValue placeholder="Month" />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, idx) => (
                      <SelectItem key={m} value={String(idx + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={form.cutYear}
                  onValueChange={(v) => setForm((f) => ({ ...f, cutYear: v }))}
                  disabled={saving}
                >
                  <SelectTrigger className="h-11 bg-card" aria-label="Cut year">
                    <SelectValue placeholder="Year" />
                  </SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((y) => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Note (optional)</p>
              <Textarea
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                disabled={saving}
                rows={2}
                placeholder="e.g. cash advance — site A, agreed with the supervisor"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
            <Button className="brand-gradient text-white" onClick={() => { void save(); }} disabled={saving}>
              {saving && <Loader2 size={14} className="mr-1 animate-spin" />}
              {form.id ? 'Save changes' : 'Record advance'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this advance record?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  <span className="font-semibold">{deleteTarget.full_name}</span> —{' '}
                  {fmtMoney(deleteTarget.amount)} cut from {monthLabel(deleteTarget.cut_year, deleteTarget.cut_month)}.
                  The amount is removed from that month&apos;s Advance column. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={(e) => { e.preventDefault(); void remove(); }}
              disabled={deleting}
            >
              {deleting && <Loader2 size={14} className="mr-1 animate-spin" />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
