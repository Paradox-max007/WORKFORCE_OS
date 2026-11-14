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
// ADDING supports SINGLE and BULK creation in one dialog: the BRANCH is picked
// FIRST (All branches shows everyone), then one or many employees are checked
// from the searchable list — each row shows the name, code, position/trade,
// site and branch — and every checked employee gets their own amount (a
// quick "apply to all" field fills them in one go). The given date, cut month
// and note are shared.
//
// MONTHWISE RECORD — no separate summary table: the Month + Year dropdowns by
// the search filter the SAME ledger (advances GIVEN in the period plus the
// ones cut from that period's salary) and the toolbar chip totals the given
// vs recovered amounts for the picked period.
//
// DEEP LINK — the Payroll page's red "− amount → next month" line under Net
// Payable opens this ledger focused on that employee's time-card carryover
// record (search preset + amber highlight).
//
// From HERE and from the Payroll page's Advance popover you can pick the cut
// month per record (edit = reschedule: the old month's advance is corrected,
// the new month's takes the amount in).
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownLeft, ArrowUpRight, BadgeCheck, BookOpenText, CalendarClock,
  CheckCheck, CircleDollarSign, GitBranch, ListFilter, Loader2, MapPin,
  Pencil, Plus, Search, Trash2, TriangleAlert, Users, X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SectionTitle } from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import type {
  AdvanceBookReport, AdvanceRecordVM, BranchWithCount, EmployeeVM, Site,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { useRealtimeVersion } from '@/store/realtime';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const fmtMoney = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n: number): number => Math.round(n * 100) / 100;
const monthLabel = (y: number, m: number): string => `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;

/**
 * Which parts of a record touch the picked month/year period: GIVEN (handed
 * out then) and CUT (scheduled to be recovered from that month's salary).
 */
const periodMatch = (
  r: AdvanceRecordVM,
  m: number | null,
  y: number | null,
): { given: boolean; cut: boolean } => {
  const given = (y === null || Number(r.given_date.slice(0, 4)) === y)
    && (m === null || Number(r.given_date.slice(5, 7)) === m);
  const cut = (y === null || r.cut_year === y) && (m === null || r.cut_month === m);
  return { given, cut };
};

type StatusFilter = 'all' | 'due' | 'overdue' | 'cleared';

/** Edit (reschedule) dialog state — a SINGLE record; adding uses BulkAddState. */
interface FormState {
  id: string | null;
  employeeId: string | null;
  amount: string;
  givenDate: string;
  cutMonth: string;
  cutYear: string;
  note: string;
}

/** Add dialog state — supports ONE or MANY employees in a single save. */
interface BulkAddState {
  /** 'all' | branch id | '__none__' (sites without an owner branch) */
  branchId: string;
  query: string;
  /** employeeId → amount string (presence = selected) */
  amounts: Record<string, string>;
  applyAll: string;
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
  const [branches, setBranches] = useState<BranchWithCount[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  /** 'all' | '1'..'12' — the monthwise filter over the SAME ledger table */
  const [monthFilter, setMonthFilter] = useState('all');
  /** 'all' | year string */
  const [yearFilter, setYearFilter] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdvanceRecordVM | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** record ids highlighted by a deep link (Payroll → carryover record) */
  const [focusIds, setFocusIds] = useState<Set<string>>(() => new Set());

  const [form, setForm] = useState<FormState>({
    id: null, employeeId: null, amount: '', givenDate: todayYMD(),
    cutMonth: '', cutYear: '', note: '',
  });
  const [bulk, setBulk] = useState<BulkAddState>({
    branchId: 'all', query: '', amounts: {}, applyAll: '',
    givenDate: todayYMD(), cutMonth: '', cutYear: '', note: '',
  });

  const load = (): void => {
    // a deep link (Payroll red carryover line) may be waiting — consume it
    // once the data is here so the target record exists to highlight
    const focus = useAppStore.getState().advanceBookFocus;
    Promise.all([
      dataApi.getAdvanceBook(), dataApi.listEmployees(),
      dataApi.listBranches().catch(() => [] as BranchWithCount[]),
      dataApi.listSites().catch(() => [] as Site[]),
    ])
      .then(([book, emps, brs, sts]) => {
        setReport(book);
        setEmployees(emps);
        setBranches(brs);
        setSites(sts);
        if (focus) {
          useAppStore.setState({ advanceBookFocus: null });
          setSearch(focus.employeeName);
          setStatusFilter('all');
          setMonthFilter('all');
          setYearFilter('all');
          const targets = book.records.filter((r) => r.employee_id === focus.employeeId
            && (!focus.timeCard || (r.from_time_card && !r.cleared)));
          const rows = targets.length > 0
            ? targets
            : book.records.filter((r) => r.employee_id === focus.employeeId);
          if (rows.length > 0) {
            setFocusIds(new Set(rows.map((r) => r.id)));
            // let the filtered table paint, then bring the record into view
            setTimeout(() => {
              document.getElementById(`adv-rec-${rows[0].id}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 150);
            // the amber highlight fades after a while
            setTimeout(() => { setFocusIds(new Set()); }, 8000);
          }
        }
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Failed to load the advance book');
      });
  };

  useEffect(load, [realtimeVersion]);

  // site id → owning branch id (an employee's branch = their site's branch)
  const branchIdOfSite = useMemo(
    () => new Map((sites ?? []).map((s) => [s.id, s.branch_id ?? null] as const)),
    [sites],
  );
  const branchNameOf = useMemo(
    () => new Map((branches ?? []).map((b) => [b.id, b.name] as const)),
    [branches],
  );

  // ---- filtering -----------------------------------------------------------
  const filterMonth = monthFilter === 'all' ? null : Number(monthFilter);
  const filterYear = yearFilter === 'all' ? null : Number(yearFilter);
  const periodActive = filterMonth !== null || filterYear !== null;

  const filtered = useMemo(() => {
    if (!report) return [];
    const q = search.toLowerCase().trim();
    return report.records.filter((r) => {
      if (q && !r.full_name.toLowerCase().includes(q)
        && !r.employee_code.toLowerCase().includes(q)) return false;
      if (statusFilter === 'due') return !r.cleared && !r.overdue;
      if (statusFilter === 'overdue') return r.overdue;
      if (statusFilter === 'cleared') return r.cleared;
      // monthwise filter — the record was GIVEN in the period or is cut from
      // that period's salary
      if (periodActive) {
        const pm = periodMatch(r, filterMonth, filterYear);
        if (!pm.given && !pm.cut) return false;
      }
      return true;
    });
  }, [report, search, statusFilter, periodActive, filterMonth, filterYear]);

  const visibleTotal = useMemo(
    () => filtered.reduce((n, r) => n + r.amount, 0), [filtered]);

  // ---- month / year filter — the monthwise given-vs-recovered record -------
  // No separate summary table: the SAME ledger is filtered by the picked
  // month/year and the toolbar chip totals given vs recovered for the period.
  const filterYears = useMemo(() => {
    const ys = new Set<number>([new Date().getFullYear()]);
    report?.records.forEach((r) => {
      ys.add(Number(r.given_date.slice(0, 4)));
      ys.add(r.cut_year);
    });
    return [...ys].filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
  }, [report]);

  const periodStats = useMemo(() => {
    if (!report || !periodActive) return null;
    let gCount = 0;
    let gAmount = 0;
    let rCount = 0;
    let rAmount = 0;
    report.records.forEach((r) => {
      const { given, cut } = periodMatch(r, filterMonth, filterYear);
      if (given) { gCount += 1; gAmount += r.amount; }
      if (cut && r.cleared) { rCount += 1; rAmount += r.amount; }
    });
    return {
      given: { count: gCount, amount: round2(gAmount) },
      recovered: { count: rCount, amount: round2(rAmount) },
      net: round2(gAmount - rAmount),
    };
  }, [report, periodActive, filterMonth, filterYear]);

  const periodLabel = filterMonth !== null && filterYear !== null
    ? `${MONTH_NAMES[filterMonth - 1]} ${filterYear}`
    : filterMonth !== null
      ? `${MONTH_NAMES[filterMonth - 1]} — all years`
      : `Year ${filterYear ?? ''}`;

  // ---- add (single + bulk) dialog ------------------------------------------
  const openAdd = (): void => {
    const now = new Date();
    setBulk({
      branchId: 'all', query: '', amounts: {}, applyAll: '',
      givenDate: todayYMD(),
      cutMonth: String(now.getMonth() + 1), cutYear: String(now.getFullYear()),
      note: '',
    });
    setFormOpen(true);
  };

  /** the dialog's employee list — branch first, then the search text */
  const pickerEmployees = useMemo(() => {
    if (!employees) return [];
    const q = bulk.query.toLowerCase().trim();
    return employees.filter((e) => {
      if (e.status !== 'active') return false;
      const branch = e.current_site_id ? branchIdOfSite.get(e.current_site_id) ?? null : null;
      if (bulk.branchId === '__none__') {
        if (branch != null) return false;
      } else if (bulk.branchId !== 'all' && branch !== bulk.branchId) return false;
      if (q && !e.full_name.toLowerCase().includes(q)
        && !e.employee_code.toLowerCase().includes(q)
        && !(e.position ?? '').toLowerCase().includes(q)
        && !(e.trade_name ?? '').toLowerCase().includes(q)
        && !(e.site_name ?? '').toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [employees, branchIdOfSite, bulk.branchId, bulk.query]);

  const selectedIds = useMemo(
    () => Object.keys(bulk.amounts), [bulk.amounts]);
  const selectedCount = selectedIds.length;

  const toggleEmployee = (id: string): void => {
    setBulk((b) => {
      const next = { ...b.amounts };
      if (id in next) delete next[id];
      else next[id] = b.applyAll || '';
      return { ...b, amounts: next };
    });
  };

  const setAmount = (id: string, value: string): void => {
    setBulk((b) => ({ ...b, amounts: { ...b.amounts, [id]: value } }));
  };

  const applyToAll = (): void => {
    const v = bulk.applyAll;
    setBulk((b) => {
      const next: Record<string, string> = {};
      Object.keys(b.amounts).forEach((id) => { next[id] = v; });
      return { ...b, amounts: next };
    });
  };

  const selectAllVisible = (): void => {
    setBulk((b) => {
      const next = { ...b.amounts };
      pickerEmployees.forEach((e) => {
        if (!(e.id in next)) next[e.id] = b.applyAll || '';
      });
      return { ...b, amounts: next };
    });
  };

  const clearSelection = (): void => {
    setBulk((b) => ({ ...b, amounts: {} }));
  };

  /** save every checked employee — one advance record each (sequential so the
   *  per-record sync + audit trail stay ordered; failures are collected) */
  const saveBulk = async (): Promise<void> => {
    if (saving) return;
    if (selectedCount === 0) { toast.error('Select at least one employee'); return; }
    if (!bulk.cutMonth || !bulk.cutYear) { toast.error('Pick the cut month'); return; }
    const entries: { employee: EmployeeVM; amount: number }[] = [];
    for (const id of selectedIds) {
      const employee = employees?.find((e) => e.id === id);
      if (!employee) continue;
      const n = Number(bulk.amounts[id]);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error(`${employee.full_name}: the advance amount must be greater than 0`);
        return;
      }
      entries.push({ employee, amount: round2(n) });
    }
    if (entries.length === 0) { toast.error('Select at least one employee'); return; }
    setSaving(true);
    const failed: string[] = [];
    let saved = 0;
    for (const { employee, amount } of entries) {
      try {
        await dataApi.saveAdvanceRecord({
          employee_id: employee.id,
          amount,
          given_date: bulk.givenDate || todayYMD(),
          cut_year: Number(bulk.cutYear),
          cut_month: Number(bulk.cutMonth),
          note: bulk.note.trim() || null,
        });
        saved += 1;
      } catch {
        failed.push(`${employee.full_name} (${employee.employee_code})`);
      }
    }
    setSaving(false);
    if (saved > 0) {
      toast.success(saved === 1
        ? 'Advance recorded'
        : `${saved} advance${saved === 1 ? '' : 's'} recorded`, {
        description: `${fmtMoney(round2(entries.filter((x) => !failed.includes(`${x.employee.full_name} (${x.employee.employee_code})`)).reduce((n, x) => n + x.amount, 0)))} cut from ${MONTH_NAMES[Number(bulk.cutMonth) - 1]} ${bulk.cutYear} — that month's Advance column follows automatically.`,
      });
    }
    if (failed.length > 0) {
      toast.error(`${failed.length} record${failed.length === 1 ? '' : 's'} failed`, {
        description: failed.join(', '),
      });
    }
    if (failed.length === 0) {
      setFormOpen(false);
      load();
    } else {
      // keep the dialog open with only the failed employees still checked
      const keep: Record<string, string> = {};
      failed.forEach((f) => {
        const emp = employees?.find((e) => `${e.full_name} (${e.employee_code})` === f);
        if (emp) keep[emp.id] = bulk.amounts[emp.id] ?? '';
      });
      setBulk((b) => ({ ...b, amounts: keep }));
      load();
    }
  };

  // ---- edit (reschedule) dialog --------------------------------------------
  const openEdit = (r: AdvanceRecordVM): void => {
    setForm({
      id: r.id, employeeId: r.employee_id, amount: String(r.amount),
      givenDate: r.given_date, cutMonth: String(r.cut_month),
      cutYear: String(r.cut_year), note: r.note ?? '',
    });
    setFormOpen(true);
  };

  const saveEdit = async (): Promise<void> => {
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
        amount: round2(amount),
        given_date: form.givenDate || todayYMD(),
        cut_year: Number(form.cutYear),
        cut_month: Number(form.cutMonth),
        note: form.note.trim() || null,
      });
      toast.success('Advance record updated', {
        description: `${fmtMoney(round2(amount))} cut from ${MONTH_NAMES[Number(form.cutMonth) - 1]} ${form.cutYear} — the payroll Advance column of that month follows automatically.`,
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
  if (!report || !employees || !branches || !sites) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
        <Skeleton className="h-40" />
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

  const editEmployee = form.employeeId
    ? employees.find((e) => e.id === form.employeeId) ?? null
    : null;

  /** one employee row of the add dialog's picker */
  const pickerRow = (e: EmployeeVM): ReactNode => {
    const checked = e.id in bulk.amounts;
    const branch = e.current_site_id ? branchIdOfSite.get(e.current_site_id) ?? null : null;
    const branchName = branch ? branchNameOf.get(branch) ?? null : null;
    return (
      <li
        key={e.id}
        className={cn(
          'flex items-center gap-2.5 border-b border-border/50 px-2.5 py-2 transition-colors last:border-0',
          checked ? 'bg-brand/[0.06]' : 'hover:bg-muted/50',
        )}
      >
        <Checkbox
          checked={checked}
          onCheckedChange={() => toggleEmployee(e.id)}
          aria-label={`Select ${e.full_name}`}
          className="mt-0.5"
        />
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand/15 text-[11px] font-bold text-brand">
          {e.photo ? <img src={e.photo} alt="" className="size-full object-cover" /> : initials(e.full_name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{e.full_name}</p>
          <p className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
            {e.employee_code} · {e.trade_name ?? e.position ?? 'No trade'}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-none text-muted-foreground">
            {e.site_name ? (
              <span className="inline-flex items-center gap-0.5">
                <MapPin size={9} /> {e.site_name}
              </span>
            ) : (
              <span className="text-amber-500">Idle — no site</span>
            )}
            <span className="inline-flex items-center gap-0.5">
              <GitBranch size={9} /> {branchName ?? 'No branch'}
            </span>
          </p>
        </div>
        {checked && (
          <Input
            type="number" min={0} step="0.01" inputMode="decimal"
            value={bulk.amounts[e.id] ?? ''}
            onChange={(ev) => setAmount(e.id, ev.target.value)}
            disabled={saving}
            className="h-8 w-24 shrink-0 border-border/70 bg-card text-right font-mono text-xs"
            placeholder="0.00"
            aria-label={`Advance amount of ${e.full_name}`}
          />
        )}
      </li>
    );
  };

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

      {/* toolbar — search, status, month + year (the monthwise record) */}
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
        <div
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title="Monthwise record — advances given in the picked month plus the ones cut from that month's salary"
        >
          <CalendarClock size={14} className="shrink-0" />
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="h-9 w-[7.5rem] bg-card text-xs" aria-label="Filter by month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {MONTH_NAMES.map((m, idx) => (
                <SelectItem key={m} value={String(idx + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="h-9 w-28 bg-card text-xs" aria-label="Filter by year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All years</SelectItem>
              {filterYears.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {periodStats && (
          <span
            className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-[11px]"
            title="Given = advances handed out in the period · Recovered = cleared from that period's paid salaries · both are listed below and the Status column tells them apart"
          >
            <span className="inline-flex items-center gap-1 font-semibold">
              <CalendarClock size={11} /> {periodLabel}
            </span>
            <span className="inline-flex items-center gap-1 font-mono text-amber-600 dark:text-amber-400">
              <ArrowUpRight size={11} className="shrink-0" />
              {fmtMoney(periodStats.given.amount)}
              <span className="font-sans text-muted-foreground">({periodStats.given.count} given)</span>
            </span>
            <span className="inline-flex items-center gap-1 font-mono text-emerald-600 dark:text-emerald-400">
              <ArrowDownLeft size={11} className="shrink-0" />
              {fmtMoney(periodStats.recovered.amount)}
              <span className="font-sans text-muted-foreground">({periodStats.recovered.count} recovered)</span>
            </span>
            <span className="font-mono font-semibold text-muted-foreground">
              Net {fmtMoney(periodStats.net)}
            </span>
            <button
              type="button"
              aria-label="Clear the month / year filter"
              onClick={() => { setMonthFilter('all'); setYearFilter('all'); }}
              className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={11} />
            </button>
          </span>
        )}
        {focusIds.size > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
            <Users size={11} /> Linked from Payroll — {focusIds.size} record{focusIds.size === 1 ? '' : 's'} highlighted
            <button
              type="button"
              aria-label="Clear the highlight"
              onClick={() => { setFocusIds(new Set()); setSearch(''); }}
              className="ml-0.5 transition-colors hover:text-foreground"
            >
              <X size={11} />
            </button>
          </span>
        )}
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
                    id={`adv-rec-${r.id}`}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className={cn(
                      'border-b transition-colors hover:bg-muted/50',
                      focusIds.has(r.id)
                        && 'bg-amber-500/[0.08] ring-2 ring-inset ring-amber-500/60',
                    )}
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
                      : periodActive
                        ? 'No records for this month / year — switch back to All months / All years.'
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

      {/* add (single + bulk) / edit (reschedule) dialog */}
      <Dialog open={formOpen} onOpenChange={(v) => { if (!saving) setFormOpen(v); }}>
        <DialogContent className={form.id ? 'sm:max-w-md' : 'sm:max-w-2xl'}>
          <DialogHeader>
            <DialogTitle>
              {form.id ? 'Edit / reschedule advance' : 'Add advance — single or multiple'}
            </DialogTitle>
            <DialogDescription>
              {form.id
                ? 'Only due records can be edited — cleared ones are history. Changing the cut month corrects both months automatically.'
                : 'Pick the branch first, then check one or many employees (name, code, trade, site and branch on every row). Each checked employee gets their own amount; the given date, cut month and note are shared.'}
            </DialogDescription>
          </DialogHeader>

          {form.id ? (
            /* ---- EDIT (reschedule) — a single locked employee ---- */
            <div className="space-y-3.5">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Employee</p>
                {editEmployee && (
                  <div className="flex items-center gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand/15 text-[11px] font-bold text-brand">
                      {editEmployee.photo
                        ? <img src={editEmployee.photo} alt="" className="size-full object-cover" />
                        : initials(editEmployee.full_name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{editEmployee.full_name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {editEmployee.employee_code} · {editEmployee.trade_name ?? editEmployee.position ?? 'No trade'}
                        {editEmployee.site_name ? ` · ${editEmployee.site_name}` : ''}
                      </p>
                    </div>
                  </div>
                )}
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
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Cut from the salary of</p>
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
          ) : (
            /* ---- ADD — branch first, then one or many employees ---- */
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Branch <span className="text-muted-foreground/70">(picked first)</span>
                  </p>
                  <Select
                    value={bulk.branchId}
                    onValueChange={(v) => setBulk((b) => ({ ...b, branchId: v }))}
                    disabled={saving}
                  >
                    <SelectTrigger className="h-11 bg-card" aria-label="Filter employees by branch">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All branches — all employees</SelectItem>
                      {branches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                      <SelectItem value="__none__">No branch (idle / unassigned)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Given on</p>
                  <Input
                    type="date"
                    value={bulk.givenDate}
                    onChange={(e) => setBulk((b) => ({ ...b, givenDate: e.target.value }))}
                    disabled={saving}
                    className="h-11"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Employees{' '}
                    <span className="font-normal text-muted-foreground/70">
                      ({pickerEmployees.length} in {bulk.branchId === 'all' ? 'all branches' : bulk.branchId === '__none__' ? 'no branch' : branchNameOf.get(bulk.branchId) ?? 'branch'})
                    </span>
                  </p>
                  <span className="flex items-center gap-1.5">
                    <Button
                      variant="ghost" size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={saving || pickerEmployees.length === 0}
                      onClick={selectAllVisible}
                    >
                      <CheckCheck size={11} className="mr-0.5" /> Select all
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="h-7 px-2 text-[11px] text-muted-foreground"
                      disabled={saving || selectedCount === 0}
                      onClick={clearSelection}
                    >
                      <X size={11} className="mr-0.5" /> Clear
                    </Button>
                  </span>
                </div>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={bulk.query}
                    onChange={(e) => setBulk((b) => ({ ...b, query: e.target.value }))}
                    disabled={saving}
                    placeholder="Search name, code, trade or site…"
                    className="h-9 bg-card pl-8 text-sm"
                  />
                </div>
                <ul className="mt-2 max-h-64 overflow-y-auto rounded-lg border">
                  {pickerEmployees.length === 0 && (
                    <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No employees match this branch / search.
                    </li>
                  )}
                  {pickerEmployees.map(pickerRow)}
                </ul>
              </div>

              {selectedCount > 0 && (
                <div className="flex flex-wrap items-end gap-2.5 rounded-lg border border-brand/25 bg-brand/[0.05] px-3 py-2.5">
                  <div>
                    <p className="text-[11px] font-semibold text-brand">
                      {selectedCount} employee{selectedCount === 1 ? '' : 's'} selected
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Total: {fmtMoney(round2(selectedIds.reduce((n, id) => n + (Number(bulk.amounts[id]) || 0), 0)))}
                    </p>
                  </div>
                  <div className="ml-auto flex items-end gap-1.5">
                    <div>
                      <p className="mb-1 text-[10px] font-medium text-muted-foreground">Same amount for all</p>
                      <Input
                        type="number" min={0} step="0.01" inputMode="decimal"
                        value={bulk.applyAll}
                        onChange={(e) => setBulk((b) => ({ ...b, applyAll: e.target.value }))}
                        disabled={saving}
                        className="h-8 w-28 border-border/70 bg-card text-right font-mono text-xs"
                        placeholder="0.00"
                      />
                    </div>
                    <Button
                      variant="outline" size="sm"
                      className="h-8"
                      disabled={saving || !(Number(bulk.applyAll) > 0)}
                      onClick={applyToAll}
                      title="Fill every selected employee's amount with this value"
                    >
                      Apply
                    </Button>
                  </div>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Cut from the salary of</p>
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    value={bulk.cutMonth}
                    onValueChange={(v) => setBulk((b) => ({ ...b, cutMonth: v }))}
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
                    value={bulk.cutYear}
                    onValueChange={(v) => setBulk((b) => ({ ...b, cutYear: v }))}
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
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Note (optional — shared)</p>
                <Textarea
                  value={bulk.note}
                  onChange={(e) => setBulk((b) => ({ ...b, note: e.target.value }))}
                  disabled={saving}
                  rows={2}
                  placeholder="e.g. cash advance — site A, agreed with the supervisor"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
            {form.id ? (
              <Button className="brand-gradient text-white" onClick={() => { void saveEdit(); }} disabled={saving}>
                {saving && <Loader2 size={14} className="mr-1 animate-spin" />}
                Save changes
              </Button>
            ) : (
              <Button
                className="brand-gradient text-white"
                onClick={() => { void saveBulk(); }}
                disabled={saving || selectedCount === 0}
              >
                {saving && <Loader2 size={14} className="mr-1 animate-spin" />}
                {selectedCount === 1
                  ? 'Record advance'
                  : selectedCount > 1
                    ? `Record ${selectedCount} advances`
                    : 'Record advance'}
              </Button>
            )}
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
