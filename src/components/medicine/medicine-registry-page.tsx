'use client';

// ============================================================================
// PULSE Workforce OS — Medicine Registry (controlled-access menu)
// ----------------------------------------------------------------------------
// Basic medicines handed to employees. Two tabs:
//   • STOCK   — the medicine list (rate per tablet + quantity available);
//               add / edit / restock / deactivate / delete
//   • RECORDS — every dispense (date + time, employee, item lines, total,
//               Paid / Unpaid → coming-salary / Recovered status); click a row
//               to open the full medicine record
//
// DISPENSE flow (the primary action):
//   search the employee → pick one → add as many medicine LINES as needed
//   (each shows the available quantity + the rate; the amount is computed
//   live as rate × quantity) → total → PAID switch:
//     • paid   → nothing touches payroll
//     • unpaid → the total is folded into the employee's COMING salary
//                Deduction column (this month's settlement while unpaid, else
//                next month's) — it appears on the Payroll page with a MED
//                tag, and clicking that tag re-opens this record.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Banknote, CircleCheck, Eye, History, Loader2, PackagePlus, Pencil, Pill,
  Plus, RefreshCw, Search, Trash2, X, Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { useBranchScope } from '@/components/shared/branch-scope';
import { EmptyState, PageHeader, SectionTitle, SkeletonRows, StatCard } from '@/components/shared/primitives';
import {
  fmtMedMoney, MedicineRecordDialog, MedicineStatusChip, medicineItemsText,
} from './medicine-record-dialog';
import { dataApi } from '@/lib/data';
import { fmtDateTime, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useRealtimeVersion } from '@/store/realtime';
import type {
  EmployeeVM, Medicine, MedicineRecordVM,
} from '@/lib/types';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const LOW_STOCK = 20;

export function MedicineRegistryPage() {
  const version = useRealtimeVersion(['medicine', 'medicine_record', 'employee', 'site', 'payroll_period', 'payroll_employee']);
  const scope = useBranchScope();

  const [medicines, setMedicines] = useState<Medicine[] | null>(null);
  const [records, setRecords] = useState<MedicineRecordVM[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [tab, setTab] = useState<'stock' | 'records'>('stock');

  // ---- stock tab -------------------------------------------------------------
  const [stockSearch, setStockSearch] = useState('');
  const [medOpen, setMedOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<Medicine | null>(null);
  const [medName, setMedName] = useState('');
  const [medRate, setMedRate] = useState('');
  const [medQty, setMedQty] = useState('');
  const [medSaving, setMedSaving] = useState(false);
  const [deleteMedTarget, setDeleteMedTarget] = useState<Medicine | null>(null);
  const [deletingMed, setDeletingMed] = useState(false);

  // ---- records tab -------------------------------------------------------------
  const [recSearch, setRecSearch] = useState('');
  const [recStatusFilter, setRecStatusFilter] = useState<'all' | 'unpaid' | 'paid'>('all');
  const [detailsRecord, setDetailsRecord] = useState<MedicineRecordVM | null>(null);
  const [recordBusyId, setRecordBusyId] = useState<string | null>(null);

  // ---- dispense dialog -------------------------------------------------------------
  const [dispOpen, setDispOpen] = useState(false);
  const [dispEmpId, setDispEmpId] = useState<string | null>(null);
  const [dispLines, setDispLines] = useState<{ medicine_id: string; quantity: string }[]>([{ medicine_id: '', quantity: '' }]);
  const [dispPaid, setDispPaid] = useState(false);
  const [dispSaving, setDispSaving] = useState(false);

  // ---- data loading -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [meds, recs, emps] = await Promise.all([
        dataApi.listMedicines(),
        dataApi.listMedicineRecords(),
        dataApi.listEmployees(),
      ]);
      if (!cancelled) {
        setMedicines(meds);
        setRecords(recs);
        setEmployees(emps);
      }
    })().catch(() => {
      if (!cancelled) {
        setMedicines([]);
        setRecords([]);
        setEmployees([]);
      }
    });
    return () => { cancelled = true; };
  }, [version]);

  const activeMeds = useMemo(() => (medicines ?? []).filter((m) => m.is_active), [medicines]);
  const medById = useMemo(() => new Map((medicines ?? []).map((m) => [m.id, m])), [medicines]);

  // employees pickable for dispensing — active, inside the viewer's branch
  // scope (idle employees belong to no branch: super admins / all-branches
  // grants only, same rule as every branch-scoped page)
  const pickableEmployees = useMemo(
    () => (employees ?? []).filter(
      (e) => e.status === 'active' && scope.employeeInScope(e),
    ),
    [employees, scope],
  );

  // ---- stats -------------------------------------------------------------
  const now = new Date();
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const stats = useMemo(() => {
    const recs = records ?? [];
    const pending = recs.filter((r) => !r.paid && !r.cleared);
    return {
      medicines: activeMeds.length,
      stockUnits: activeMeds.reduce((n, m) => n + m.quantity_available, 0),
      thisMonth: recs.filter((r) => r.dispensed_at >= monthStartIso).length,
      pendingAmount: pending.reduce((n, r) => n + r.total_amount, 0),
      pendingCount: pending.length,
    };
  }, [records, activeMeds, monthStartIso]);

  // ---- stock tab: filtered rows -------------------------------------------------------------
  const filteredMeds = useMemo(() => {
    if (!medicines) return null;
    const q = stockSearch.trim().toLowerCase();
    return medicines.filter((m) => !q || m.name.toLowerCase().includes(q));
  }, [medicines, stockSearch]);

  // ---- records tab: filtered rows -------------------------------------------------------------
  const filteredRecords = useMemo(() => {
    if (!records) return null;
    const q = recSearch.trim().toLowerCase();
    return records.filter((r) => {
      if (recStatusFilter === 'unpaid' && (r.paid || r.cleared)) return false;
      if (recStatusFilter === 'paid' && !r.paid) return false;
      if (!q) return true;
      return `${r.employee_name} ${r.employee_code} ${medicineItemsText(r.items)}`.toLowerCase().includes(q);
    });
  }, [records, recSearch, recStatusFilter]);

  // ---- add / edit medicine -------------------------------------------------------------
  const openMedDialog = (med: Medicine | null) => {
    setEditingMed(med);
    setMedName(med?.name ?? '');
    setMedRate(med ? String(med.rate_per_tablet) : '');
    setMedQty(med ? String(med.quantity_available) : '');
    setMedOpen(true);
  };

  const saveMed = async () => {
    if (medSaving) return;
    setMedSaving(true);
    try {
      await dataApi.saveMedicine({
        id: editingMed?.id,
        name: medName,
        rate_per_tablet: Number(medRate),
        quantity_available: Number(medQty),
        ...(editingMed ? { is_active: editingMed.is_active } : {}),
      });
      toast.success(editingMed ? 'Medicine updated' : 'Medicine added', {
        description: `${medName.trim()} — ${fmtMedMoney(Number(medRate) || 0)} per tablet · ${Math.round(Number(medQty) || 0)} available.`,
      });
      setMedOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the medicine');
    } finally {
      setMedSaving(false);
    }
  };

  const toggleMedActive = async (med: Medicine) => {
    setRecordBusyId(med.id);
    try {
      await dataApi.saveMedicine({
        id: med.id, name: med.name, rate_per_tablet: med.rate_per_tablet,
        quantity_available: med.quantity_available, is_active: !med.is_active,
      });
      toast.success(med.is_active ? `${med.name} deactivated` : `${med.name} reactivated`, {
        description: med.is_active
          ? 'Kept in history — it can no longer be dispensed.'
          : 'Available for dispensing again.',
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the medicine');
    } finally {
      setRecordBusyId(null);
    }
  };

  const deleteMed = async () => {
    if (!deleteMedTarget || deletingMed) return;
    setDeletingMed(true);
    try {
      await dataApi.deleteMedicine(deleteMedTarget.id);
      toast.success(`${deleteMedTarget.name} deleted`, {
        description: 'Past records keep their own snapshot of it.',
      });
      setDeleteMedTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the medicine');
    } finally {
      setDeletingMed(false);
    }
  };

  // ---- dispense -------------------------------------------------------------
  const dispEmployee = useMemo(
    () => pickableEmployees.find((e) => e.id === dispEmpId) ?? null,
    [pickableEmployees, dispEmpId],
  );

  const lineAmount = (line: { medicine_id: string; quantity: string }): number => {
    const med = medById.get(line.medicine_id);
    if (!med) return 0;
    const qty = Math.floor(Number(line.quantity));
    if (!Number.isFinite(qty) || qty < 1) return 0;
    return Math.round(med.rate_per_tablet * qty * 100) / 100;
  };
  const dispTotal = useMemo(
    () => Math.round(dispLines.reduce((n, l) => n + lineAmount(l), 0) * 100) / 100,
    [dispLines, medById],
  );

  const openDispense = () => {
    setDispEmpId(null);
    setDispLines([{ medicine_id: '', quantity: '' }]);
    setDispPaid(false);
    setDispOpen(true);
  };

  const confirmDispense = async () => {
    if (dispSaving) return;
    if (!dispEmpId) {
      toast.error('Search and select the employee first');
      return;
    }
    const picked = dispLines.filter((l) => l.medicine_id);
    if (picked.length === 0) {
      toast.error('Select at least one medicine');
      return;
    }
    setDispSaving(true);
    try {
      const rec = await dataApi.dispenseMedicine({
        employee_id: dispEmpId,
        items: picked.map((l) => ({ medicine_id: l.medicine_id, quantity: Math.floor(Number(l.quantity)) })),
        paid: dispPaid,
      });
      const empName = rec.employee_name;
      if (rec.paid) {
        toast.success(`Recorded — ${fmtMedMoney(rec.total_amount)} paid`, {
          description: `${empName} took ${medicineItemsText(rec.items)} on ${fmtDateTime(rec.dispensed_at)}. No deduction — the amount was paid at the counter.`,
        });
      } else {
        toast.success(`Recorded — ${fmtMedMoney(rec.total_amount)} → ${empName}'s coming salary`, {
          description: `Added to the ${rec.cut_month ? MONTH_NAMES[rec.cut_month - 1] : ''} ${rec.cut_year} payroll Deduction with a MED tag. Clicking that tag on the Payroll page opens this record.`,
        });
      }
      setDispOpen(false);
      setTab('records');
      setDetailsRecord(rec);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to record the medicines');
    } finally {
      setDispSaving(false);
    }
  };

  // ---- record actions -------------------------------------------------------------
  const markRecordPaid = async (id: string) => {
    setRecordBusyId(id);
    try {
      await dataApi.markMedicineRecordPaid(id);
      toast.success('Marked paid', {
        description: 'The pending salary deduction was removed — nothing will be deducted.',
      });
      setDetailsRecord(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark the record paid');
    } finally {
      setRecordBusyId(null);
    }
  };

  const deleteRecord = async (id: string) => {
    setRecordBusyId(id);
    try {
      await dataApi.deleteMedicineRecord(id);
      toast.success('Record deleted', {
        description: 'The stock was restored and the pending deduction removed.',
      });
      setDetailsRecord(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the record');
    } finally {
      setRecordBusyId(null);
    }
  };

  const loading = medicines === null || records === null;

  // ===========================================================================
  return (
    <div className="space-y-6">
      <PageHeader
        title="Medicine Registry"
        description="Basic medicines for employees — stock, dispensing and salary deductions. Unpaid amounts fold into the coming salary's Deduction (MED tag on the Payroll page)."
        actions={
          <>
            <Button variant="outline" className="gap-2" onClick={openMedDialog.bind(null, null)}>
              <Plus size={15} /> Add Medicine
            </Button>
            <Button className="gap-2" onClick={openDispense}>
              <Pill size={15} /> Dispense Medicine
            </Button>
          </>
        }
      />

      {/* ---- stats ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Medicines in stock" value={stats.medicines} icon={<Pill size={18} />} tone="brand" hint={`${stats.stockUnits} units available`} />
        <StatCard label="Dispensed this month" value={stats.thisMonth} icon={<History size={18} />} tone="cyan" hint={MONTH_NAMES[now.getMonth()]} />
        <StatCard label="Unpaid (→ salary)" value={stats.pendingCount} icon={<Banknote size={18} />} tone="amber" hint={`${fmtMedMoney(stats.pendingAmount)} pending deduction`} />
        <StatCard label="Stock value" value={Math.round((medicines ?? []).filter((m) => m.is_active).reduce((n, m) => n + m.rate_per_tablet * m.quantity_available, 0) * 100) / 100} decimals={2} icon={<PackagePlus size={18} />} tone="emerald" hint="rate × quantity, all medicines" />
      </div>

      {/* ---- tabs ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'stock' | 'records')}>
          <TabsList>
            <TabsTrigger value="stock" className="gap-1.5">
              <Pill size={13} /> Stock
            </TabsTrigger>
            <TabsTrigger value="records" className="gap-1.5">
              <History size={13} /> Records
              {stats.pendingCount > 0 && (
                <span className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                  {stats.pendingCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === 'stock' ? (
          <div className="relative w-full sm:max-w-xs">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} placeholder="Search medicines…" className="h-10 pl-9 pr-9" />
            {stockSearch && (
              <button type="button" onClick={() => setStockSearch('')} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Select value={recStatusFilter} onValueChange={(v) => setRecStatusFilter(v as 'all' | 'unpaid' | 'paid')}>
              <SelectTrigger className="h-10 w-full sm:w-44" aria-label="Filter by payment status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All records</SelectItem>
                <SelectItem value="unpaid">Unpaid → salary</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-full sm:max-w-xs">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={recSearch} onChange={(e) => setRecSearch(e.target.value)} placeholder="Search employee or medicine…" className="h-10 pl-9 pr-9" />
              {recSearch && (
                <button type="button" onClick={() => setRecSearch('')} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---- STOCK tab ---- */}
      {tab === 'stock' && (
        loading ? <SkeletonRows rows={5} /> : (filteredMeds?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Pill size={22} />}
            title={stockSearch ? 'No matching medicines' : 'No medicines yet'}
            description={stockSearch ? 'Try a different search term.' : 'Add the basic medicines you hand to employees — name, rate per tablet and the available quantity.'}
            action={<Button className="gap-2" onClick={openMedDialog.bind(null, null)}><Plus size={15} /> Add the first medicine</Button>}
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card-glow overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Medicine</TableHead>
                    <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Rate / tablet</TableHead>
                    <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Available</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Status</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Updated</TableHead>
                    <TableHead className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMeds!.map((m) => (
                    <TableRow key={m.id} className={cn(!m.is_active && 'opacity-55')}>
                      <TableCell className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', m.is_active ? 'bg-sky-500/10 text-sky-500' : 'bg-muted text-muted-foreground')}>
                            <Pill size={15} />
                          </span>
                          <div>
                            <p className="text-sm font-medium">{m.name}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {fmtMedMoney(m.rate_per_tablet)} × {m.quantity_available} = {fmtMedMoney(Math.round(m.rate_per_tablet * m.quantity_available * 100) / 100)}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="px-3 py-3 text-right font-mono text-sm tabular-nums">{fmtMedMoney(m.rate_per_tablet)}</TableCell>
                      <TableCell className="px-3 py-3 text-right">
                        <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-sm font-semibold tabular-nums',
                          !m.is_active ? 'text-muted-foreground'
                            : m.quantity_available === 0 ? 'bg-rose-500/10 text-rose-500'
                              : m.quantity_available <= LOW_STOCK ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-emerald-500/10 text-emerald-500')}>
                          {m.quantity_available}
                          {m.is_active && m.quantity_available <= LOW_STOCK && m.quantity_available > 0 && (
                            <span className="font-sans text-[10px] font-bold">LOW</span>
                          )}
                          {m.is_active && m.quantity_available === 0 && (
                            <span className="font-sans text-[10px] font-bold">OUT</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-3 text-xs">
                        {m.is_active ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                            <CircleCheck size={11} /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-zinc-500/25 bg-zinc-500/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">Deactivated</span>
                        )}
                      </TableCell>
                      <TableCell className="px-3 py-3 text-xs text-muted-foreground">{fmtDateTime(m.updated_at).split('·')[0]}</TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`Edit ${m.name}`} onClick={() => openMedDialog(m)} title={m.is_active ? 'Edit name / rate / quantity (restock by raising the quantity)' : 'Reactivate or edit'}>
                            {recordBusyId === m.id ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[11px]" disabled={recordBusyId === m.id} onClick={() => void toggleMedActive(m)}>
                            {m.is_active ? 'Deactivate' : 'Activate'}
                          </Button>
                          <Button variant="ghost" size="icon" className="size-8 text-rose-500 hover:text-rose-600" aria-label={`Delete ${m.name}`} onClick={() => setDeleteMedTarget(m)} title="Delete from the stock list (past records keep their snapshot)">
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </motion.div>
        )
      )}

      {/* ---- RECORDS tab ---- */}
      {tab === 'records' && (
        loading ? <SkeletonRows rows={5} /> : (filteredRecords?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<History size={22} />}
            title={recSearch || recStatusFilter !== 'all' ? 'No matching records' : 'No medicines dispensed yet'}
            description={recSearch || recStatusFilter !== 'all'
              ? 'Try a different search or status filter.'
              : 'Use "Dispense Medicine" to record what an employee takes — paid at the counter, or deducted from the coming salary.'}
            action={<Button className="gap-2" onClick={openDispense}><Pill size={15} /> Dispense Medicine</Button>}
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card-glow overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Taken on</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Employee</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Medicines</TableHead>
                    <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Total</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Payment</TableHead>
                    <TableHead className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Record</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRecords!.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetailsRecord(r)} title="Click to open the full medicine record">
                      <TableCell className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-muted-foreground">
                        {fmtDateTime(r.dispensed_at)}
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                            {r.photo ? <img src={r.photo} alt={r.employee_name} className="size-full object-cover" /> : initials(r.employee_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{r.employee_name}</p>
                            <p className="font-mono text-[10px] text-muted-foreground">{r.employee_code}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-64 px-3 py-3 text-xs text-muted-foreground">
                        <p className="truncate">{medicineItemsText(r.items)}</p>
                      </TableCell>
                      <TableCell className="px-3 py-3 text-right font-mono text-sm font-semibold tabular-nums">{fmtMedMoney(r.total_amount)}</TableCell>
                      <TableCell className="px-3 py-3"><MedicineStatusChip record={r} /></TableCell>
                      <TableCell className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={(e) => { e.stopPropagation(); setDetailsRecord(r); }}>
                          <Eye size={13} /> View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">
              Every record keeps the date and time the employee took the medicines. Unpaid amounts deduct from the coming salary only — paid ones never touch payroll. Click a row to view, mark paid or delete.
            </p>
          </motion.div>
        )
      )}

      {/* =========================================================================
          DIALOGS
         ========================================================================= */}

      {/* ---- add / edit medicine ---- */}
      <Dialog open={medOpen} onOpenChange={(o) => { if (!o && !medSaving) setMedOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingMed ? `Edit ${editingMed.name}` : 'Add a medicine'}</DialogTitle>
            <DialogDescription>
              The rate is per tablet / capsule / sachet — it is charged when the medicine is dispensed, and the amount shows on the employee&apos;s record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="med-name">Medicine name</Label>
              <Input id="med-name" value={medName} onChange={(e) => setMedName(e.target.value)} placeholder="e.g. Paracetamol 500mg" className="h-10" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="med-rate">Rate per tablet</Label>
                <Input id="med-rate" value={medRate} onChange={(e) => setMedRate(e.target.value)} inputMode="decimal" placeholder="0.50" className="h-10" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="med-qty">Quantity available</Label>
                <Input id="med-qty" value={medQty} onChange={(e) => setMedQty(e.target.value)} inputMode="numeric" placeholder="100" className="h-10" />
              </div>
            </div>
            {editingMed && (
              <p className="rounded-lg border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2 text-[11px] text-muted-foreground">
                Restocking: set the NEW total quantity available (current: {editingMed.quantity_available}).
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={medSaving} onClick={() => setMedOpen(false)}>Cancel</Button>
            <Button disabled={medSaving || !medName.trim()} onClick={() => void saveMed()}>
              {medSaving ? <Loader2 size={14} className="animate-spin" /> : editingMed ? <Pencil size={14} /> : <Plus size={14} />}
              {editingMed ? 'Save changes' : 'Add medicine'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- delete medicine confirm ---- */}
      <AlertDialog open={!!deleteMedTarget} onOpenChange={(o) => { if (!o && !deletingMed) setDeleteMedTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteMedTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from the stock list and can no longer be dispensed. Past dispense records keep their own snapshot of it, so history stays readable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingMed}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-600/90"
              disabled={deletingMed}
              onClick={(e) => { e.preventDefault(); void deleteMed(); }}
            >
              {deletingMed ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- dispense medicine ---- */}
      <Dialog open={dispOpen} onOpenChange={(o) => { if (!o && !dispSaving) setDispOpen(false); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500"><Pill size={16} /></span>
              Dispense medicines
            </DialogTitle>
            <DialogDescription>
              Search the employee, add one or several medicines with the quantity they take — the amount is computed from each rate per tablet.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* employee search */}
            <div className="space-y-1.5">
              <Label>Employee</Label>
              <EmployeeCombobox
                employees={pickableEmployees}
                value={dispEmpId}
                onChange={setDispEmpId}
                disabled={dispSaving}
                placeholder="Search the employee taking the medicines…"
                emptyText="No matching active employees."
              />
            </div>

            {/* medicine lines */}
            <div className="space-y-2">
              <Label>Medicines</Label>
              {dispLines.map((line, idx) => {
                const med = medById.get(line.medicine_id);
                const qty = Math.floor(Number(line.quantity));
                const qtyValid = Number.isFinite(qty) && qty >= 1;
                const overStock = !!med && qtyValid && qty > med.quantity_available;
                return (
                  <div key={idx} className="rounded-lg border bg-card p-2.5">
                    <div className="flex items-center gap-2">
                      <Select
                        value={line.medicine_id}
                        onValueChange={(v) => setDispLines((prev) => prev.map((l, i) => (i === idx ? { ...l, medicine_id: v } : l)))}
                      >
                        <SelectTrigger className="h-9 min-w-0 flex-1 bg-card text-xs" aria-label={`Medicine ${idx + 1}`}>
                          <SelectValue placeholder="Select a medicine…" />
                        </SelectTrigger>
                        <SelectContent>
                          {activeMeds.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No active medicines — add some first.</p>}
                          {activeMeds.map((m) => (
                            <SelectItem key={m.id} value={m.id} disabled={m.quantity_available === 0}>
                              {m.name} — {m.quantity_available} left · {fmtMedMoney(m.rate_per_tablet)}/tablet{m.quantity_available === 0 ? ' (out of stock)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={line.quantity}
                        onChange={(e) => setDispLines((prev) => prev.map((l, i) => (i === idx ? { ...l, quantity: e.target.value } : l)))}
                        inputMode="numeric"
                        placeholder="Qty"
                        aria-label={`Quantity of medicine ${idx + 1}`}
                        className="h-9 w-20 shrink-0 text-center"
                      />
                      <span className="w-20 shrink-0 text-right font-mono text-xs font-semibold tabular-nums">
                        {lineAmount(line) > 0 ? fmtMedMoney(lineAmount(line)) : '—'}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground hover:text-rose-500"
                        aria-label={`Remove medicine line ${idx + 1}`}
                        disabled={dispSaving || dispLines.length === 1}
                        onClick={() => setDispLines((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <X size={14} />
                      </Button>
                    </div>
                    {/* available quantity + validation */}
                    {med && (
                      <p className={cn('mt-1.5 flex items-center gap-1.5 px-0.5 text-[11px]', overStock ? 'font-medium text-rose-500' : 'text-muted-foreground')}>
                        <PackagePlus size={11} className={overStock ? 'text-rose-500' : 'text-emerald-500'} />
                        Available: <span className="font-semibold tabular-nums">{med.quantity_available}</span>
                        {' · '}{fmtMedMoney(med.rate_per_tablet)} per tablet
                        {qtyValid && !overStock && <> · amount {fmtMedMoney(lineAmount(line))}</>}
                        {overStock && <> — only {med.quantity_available} left</>}
                      </p>
                    )}
                  </div>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={dispSaving || activeMeds.length === 0}
                onClick={() => setDispLines((prev) => [...prev, { medicine_id: '', quantity: '' }])}
              >
                <Plus size={13} /> Add another medicine
              </Button>
            </div>

            {/* total + paid switch */}
            <div className="space-y-2.5 rounded-xl border bg-muted/40 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Total amount</span>
                <span className="font-mono text-lg font-bold tabular-nums">{fmtMedMoney(dispTotal)}</span>
              </div>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5" htmlFor="disp-paid">
                <Checkbox
                  id="disp-paid"
                  checked={dispPaid}
                  onCheckedChange={(c) => setDispPaid(c === true)}
                  disabled={dispSaving}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Banknote size={13} className="text-emerald-500" /> The employee paid now
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {dispPaid
                      ? 'No deduction — the record is stored as paid (with the date and time) and payroll is never touched.'
                      : `Unpaid — ${fmtMedMoney(dispTotal)} is added to ${dispEmployee?.full_name ?? 'the employee'}'s DEDUCTION for the coming salary and shows with a MED tag on the Payroll page (clicking it opens this record).`}
                  </span>
                </span>
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={dispSaving} onClick={() => setDispOpen(false)}>Cancel</Button>
            <Button disabled={dispSaving || !dispEmpId || dispLines.every((l) => !l.medicine_id) || dispTotal <= 0} onClick={() => void confirmDispense()}>
              {dispSaving ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {dispPaid ? 'Record — paid' : 'Record — deduct from salary'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- record details (view / mark paid / delete) ---- */}
      <AnimatePresence>
        {detailsRecord && (
          <MedicineRecordDialog
            records={[detailsRecord]}
            onClose={() => setDetailsRecord(null)}
            onMarkPaid={markRecordPaid}
            onDelete={deleteRecord}
            busyId={recordBusyId}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
