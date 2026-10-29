'use client';

// ============================================================================
// PULSE Workforce OS — Uniform Registry (list + shared create/renew dialog)
// ----------------------------------------------------------------------------
// Groups every non-deleted uniform entry per employee (newest entry + record
// count), with search / site filters, pagination, mobile cards, and a per-
// employee drill-down (UniformEntryDetails). All mutations go through dataApi
// and refetch live via useRealtimeVersion.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight, Crown, Eye, History,
  Info, Loader2, Plus, RefreshCw, RotateCcw, Search, Shield, Shirt, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { EmptyState, PageHeader, SkeletonRows } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import { daysUntil, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useRealtimeVersion } from '@/store/realtime';
import {
  UNIFORM_ITEMS,
  type EmployeeInput, type EmployeeVM, type SiteWithCount, type UniformEntry,
} from '@/lib/types';
import {
  DocTypeBadge, RenewalBadge, RenewalTag, UniformEntryDetails, UniformItemBadges,
  buildItemsRecord, errMessage, formatExpiryPreview, todayYMD,
} from './uniform-entry-details';

const PAGE_SIZE = 10;
const NO_SITE = '__none__';

// ---------------------------------------------------------------------------
// Local types & helpers
// ---------------------------------------------------------------------------
type DialogTarget =
  | { mode: 'create'; presetEmployeeId: string | null }
  | { mode: 'renew'; entry: UniformEntry };

interface RegistryRow {
  entry: UniformEntry; // newest entry of this employee
  count: number; // total records of this employee
  employee: EmployeeVM | null;
}

/** Build a full EmployeeInput payload from an EmployeeVM (for leader promotion). */
const toEmployeeInput = (e: EmployeeVM): EmployeeInput => ({
  full_name: e.full_name,
  nationality: e.nationality,
  date_of_birth: e.date_of_birth,
  phone: e.phone,
  email: e.email,
  address: e.address,
  emergency_contact: e.emergency_contact,
  position: e.position,
  join_date: e.join_date,
  company_name: e.company_name,
  passport_number: e.passport_number,
  passport_status: e.passport_status,
  id_number: e.id_number,
  id_status: e.id_status,
  current_site_id: e.current_site_id,
  camp_id: e.camp_id,
  camp_block: e.camp_block,
  camp_room: e.camp_room,
  photo: e.photo,
  is_team_leader: e.is_team_leader,
  team_leader_site_id: e.team_leader_site_id,
});

// ---------------------------------------------------------------------------
// Registry page
// ---------------------------------------------------------------------------
export function UniformRegistryPage() {
  const version = useRealtimeVersion(['uniform_registry', 'employee', 'site']);

  const [entries, setEntries] = useState<UniformEntry[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);

  // filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [siteFilter, setSiteFilter] = useState('all');
  const [page, setPage] = useState(1);

  // details drill-down
  const [detailsEmployeeId, setDetailsEmployeeId] = useState<string | null>(null);

  // shared create/renew dialog
  const [dialogTarget, setDialogTarget] = useState<DialogTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = (t: DialogTarget) => {
    setDialogTarget(t);
    setDialogOpen(true);
  };

  // ---- data loading ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [es, emps, sts] = await Promise.all([
        dataApi.listUniformEntries(),
        dataApi.listEmployees(),
        dataApi.listSites(),
      ]);
      if (!cancelled) {
        setEntries(es);
        setEmployees(emps);
        setSites(sts);
      }
    })().catch(() => {
      if (!cancelled) {
        setEntries([]);
        setEmployees([]);
        setSites([]);
      }
    });
    return () => { cancelled = true; };
  }, [version]);

  // 300ms search debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const employeeMap = useMemo(
    () => new Map((employees ?? []).map((e) => [e.id, e])),
    [employees],
  );

  // ---- rows: one per employee (newest entry + record count) -------------------
  const rows = useMemo<RegistryRow[] | null>(() => {
    if (!entries) return null;
    const byEmp = new Map<string, RegistryRow>();
    // listUniformEntries is newest-first → first occurrence IS the newest entry
    for (const entry of entries) {
      const cur = byEmp.get(entry.employee_id);
      if (cur) cur.count += 1;
      else {
        byEmp.set(entry.employee_id, {
          entry,
          count: 1,
          employee: employeeMap.get(entry.employee_id) ?? null,
        });
      }
    }
    return Array.from(byEmp.values());
  }, [entries, employeeMap]);

  // site filter options = distinct site names present across entries
  const siteOptions = useMemo(() => {
    const names = new Set<string>();
    (entries ?? []).forEach((e) => {
      if (e.site_name) names.add(e.site_name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  // ---- filtering + pagination -------------------------------------------------
  const filteredRows = useMemo(() => {
    if (!rows) return null;
    const q = debouncedSearch.trim().toLowerCase();
    return rows.filter((r) => {
      if (siteFilter !== 'all' && r.entry.site_name !== siteFilter) return false;
      if (!q) return true;
      return (
        r.entry.employee_name.toLowerCase().includes(q) ||
        String(r.entry.token_number).includes(q) ||
        String(r.entry.uniform_id).includes(q)
      );
    });
  }, [rows, debouncedSearch, siteFilter]);

  const totalPages = filteredRows ? Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredRows
    ? filteredRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
    : null;

  const loading = entries === null || employees === null || sites === null;
  const filtersActive = debouncedSearch.trim() !== '' || siteFilter !== 'all';

  const resetFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setSiteFilter('all');
    setPage(1);
  };

  const handleDeleteEntry = async (entry: UniformEntry) => {
    try {
      await dataApi.deleteUniformEntry(entry.id);
      toast.success('Uniform entry deleted');
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const openDetails = (employeeId: string) => setDetailsEmployeeId(employeeId);

  const detailsEmployee = detailsEmployeeId && employees
    ? employees.find((e) => e.id === detailsEmployeeId) ?? null
    : null;

  // ---- row action handlers ----------------------------------------------------
  const rowActions = (row: RegistryRow) => ({
    onAdd: () => openDialog({ mode: 'create', presetEmployeeId: row.entry.employee_id }),
    onView: () => {
      if (row.employee) openDetails(row.employee.id);
    },
    onRenew: () => openDialog({ mode: 'renew', entry: row.entry }),
    onDelete: handleDeleteEntry,
  });

  return (
    <div className="mx-auto max-w-7xl">
      <AnimatePresence mode="wait" initial={false}>
        {detailsEmployee ? (
          <motion.div
            key={`details-${detailsEmployee.id}`}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <UniformEntryDetails
              key={detailsEmployee.id}
              employee={detailsEmployee}
              onBack={() => setDetailsEmployeeId(null)}
              autoOpenAdd={false}
              renewEntryId={dialogTarget?.mode === 'renew' ? dialogTarget.entry.id : null}
              onRenewEntry={(entry) => openDialog({ mode: 'renew', entry })}
            />
          </motion.div>
        ) : (
          <motion.div
            key="registry-list"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <PageHeader
              title="Uniform Registry"
              description="Track issued uniforms, safety gear and 6-month renewals"
              actions={
                <Button
                  className="brand-gradient rounded-lg text-brand-foreground shadow-lg shadow-brand/20 hover:opacity-90"
                  onClick={() => openDialog({ mode: 'create', presetEmployeeId: null })}
                >
                  <Plus size={16} />
                  New Entry
                </Button>
              }
            />

            {loading ? (
              <div className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Skeleton className="h-10 w-full max-w-sm" />
                  <Skeleton className="h-10 w-48" />
                </div>
                <SkeletonRows rows={6} />
              </div>
            ) : (
              <>
                {/* Filters */}
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative w-full sm:max-w-sm">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-10 bg-card pl-9"
                      placeholder="Search employee, token # or uniform ID…"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setPage(1);
                      }}
                      aria-label="Search uniform registry"
                    />
                  </div>
                  <Select
                    value={siteFilter}
                    onValueChange={(v) => {
                      setSiteFilter(v);
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="h-10 w-full bg-card sm:w-52" aria-label="Filter by site">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sites</SelectItem>
                      {siteOptions.map((name) => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {filtersActive && (
                    <Button variant="ghost" size="sm" className="h-10" onClick={resetFilters}>
                      <RotateCcw size={14} />
                      Reset
                    </Button>
                  )}
                </div>

                {/* Content */}
                {filteredRows && filteredRows.length === 0 ? (
                  (entries?.length ?? 0) === 0 ? (
                    <EmptyState
                      icon={<Shirt size={22} />}
                      title="No uniform entries yet"
                      description="Start tracking issued uniforms, safety gear and their 6-month renewals by creating the first entry."
                      action={
                        <Button
                          className="brand-gradient rounded-lg text-brand-foreground hover:opacity-90"
                          onClick={() => openDialog({ mode: 'create', presetEmployeeId: null })}
                        >
                          <Plus size={15} />
                          New Entry
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={<Search size={22} />}
                      title="No entries match your filters"
                      description="Try a different employee name, token number or site."
                      action={
                        <Button variant="outline" onClick={resetFilters}>
                          <RotateCcw size={14} />
                          Reset filters
                        </Button>
                      }
                    />
                  )
                ) : (
                  <>
                    {/* Desktop table */}
                    <div className="card-glow hidden overflow-hidden rounded-xl border bg-card md:block">
                      <Table>
                        <TableHeader>
                          <tr className="hover:bg-transparent">
                            <TableHead className="pl-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Token #</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Uniform ID</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employee</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Document</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Site</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team Leader</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Records</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Created</TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Renewal</TableHead>
                            <TableHead className="pr-4 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</TableHead>
                          </tr>
                        </TableHeader>
                        <TableBody>
                          {(pageRows ?? []).map((row, i) => (
                            <motion.tr
                              key={row.entry.id}
                              initial={{ opacity: 0, y: 12 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: Math.min(i * 0.04, 0.35), duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                              className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40"
                            >
                              <TableCell className="pl-4">
                                <span className="font-mono text-sm font-semibold">#{row.entry.token_number}</span>
                                {row.entry.is_renewal && <span className="ml-1.5"><RenewalTag /></span>}
                              </TableCell>
                              <TableCell>
                                <span className="font-mono text-xs text-muted-foreground">{row.entry.uniform_id}</span>
                              </TableCell>
                              <TableCell>
                                <p className="font-medium">{row.entry.employee_name}</p>
                                {row.employee && (
                                  <p className="font-mono text-[11px] text-muted-foreground">{row.employee.employee_code}</p>
                                )}
                              </TableCell>
                              <TableCell>
                                <span className="flex items-center gap-1.5">
                                  <DocTypeBadge docType={row.entry.document_type} />
                                  <span className="font-mono text-xs">{row.entry.document_number}</span>
                                </span>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <UniformItemBadges items={row.entry.items} />
                              </TableCell>
                              <TableCell>
                                <span className="text-xs">
                                  {row.entry.site_name ?? <span className="text-muted-foreground">—</span>}
                                </span>
                              </TableCell>
                              <TableCell>
                                {row.entry.team_leader_name ? (
                                  <span className="inline-flex items-center gap-1 text-xs">
                                    <Shield size={12} className="text-brand" />
                                    {row.entry.team_leader_name}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <RecordsBadge
                                  row={row}
                                  onOpen={() => row.employee && openDetails(row.employee.id)}
                                />
                              </TableCell>
                              <TableCell>
                                <span className="whitespace-nowrap text-xs text-muted-foreground">
                                  {fmtDate(row.entry.created_at)}
                                </span>
                              </TableCell>
                              <TableCell>
                                <RenewalBadge renewalDate={row.entry.renewal_date} />
                              </TableCell>
                              <TableCell className="pr-3">
                                <RowActions row={row} {...rowActions(row)} />
                              </TableCell>
                            </motion.tr>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Mobile cards */}
                    <div className="space-y-3 md:hidden">
                      {(pageRows ?? []).map((row, i) => (
                        <motion.div
                          key={row.entry.id}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: Math.min(i * 0.04, 0.3), duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                          className="card-glow space-y-3 rounded-xl border bg-card p-4"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 font-mono text-sm font-semibold">
                                #{row.entry.token_number}
                                {row.entry.is_renewal && <RenewalTag />}
                              </p>
                              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                                Uniform ID {row.entry.uniform_id}
                              </p>
                            </div>
                            <RenewalBadge renewalDate={row.entry.renewal_date} />
                          </div>
                          <div>
                            <p className="truncate font-medium">{row.entry.employee_name}</p>
                            {row.employee && (
                              <p className="font-mono text-[11px] text-muted-foreground">{row.employee.employee_code}</p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <DocTypeBadge docType={row.entry.document_type} />
                            <span className="font-mono text-xs">{row.entry.document_number}</span>
                          </div>
                          <UniformItemBadges items={row.entry.items} />
                          <div className="space-y-1 text-[11px] text-muted-foreground">
                            <p>
                              Site:{' '}
                              <span className="text-foreground/80">{row.entry.site_name ?? '—'}</span>
                            </p>
                            <p className="flex items-center gap-1">
                              Leader:{' '}
                              {row.entry.team_leader_name ? (
                                <>
                                  <Shield size={11} className="text-brand" />
                                  <span className="text-foreground/80">{row.entry.team_leader_name}</span>
                                </>
                              ) : (
                                '—'
                              )}
                            </p>
                            <p>Created: <span className="text-foreground/80">{fmtDate(row.entry.created_at)}</span></p>
                          </div>
                          <div className="flex items-center justify-between gap-2 border-t pt-3">
                            <RecordsBadge
                              row={row}
                              onOpen={() => row.employee && openDetails(row.employee.id)}
                            />
                            <RowActions row={row} {...rowActions(row)} />
                          </div>
                        </motion.div>
                      ))}
                    </div>

                    {/* Pagination */}
                    {filteredRows && filteredRows.length > 0 && (
                      <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
                        <p className="text-xs text-muted-foreground">
                          Showing {pageRows?.length ?? 0} of {filteredRows.length} employee
                          {filteredRows.length === 1 ? '' : 's'} · page {safePage} of {totalPages}
                        </p>
                        <ListPagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Shared Create / Renew dialog (available over both views) */}
      <CreateRenewDialog
        open={dialogOpen}
        target={dialogTarget}
        employees={employees ?? []}
        sites={sites ?? []}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Records badge ("N record(s)" — highlighted border when N > 1, opens details)
// ---------------------------------------------------------------------------
function RecordsBadge({ row, onOpen }: { row: RegistryRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!row.employee}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        row.count > 1
          ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/20'
          : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted',
        !row.employee && 'cursor-not-allowed opacity-60',
      )}
    >
      <History size={11} />
      {row.count} record{row.count === 1 ? '' : 's'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Row actions: Add (Plus) · View (Eye) · Renew (RefreshCw, expired only) · Delete
// ---------------------------------------------------------------------------
function RowActions({
  row,
  onAdd,
  onView,
  onRenew,
  onDelete,
}: {
  row: RegistryRow;
  onAdd: () => void;
  onView: () => void;
  onRenew: () => void;
  onDelete: (entry: UniformEntry) => Promise<void>;
}) {
  const expired = daysUntil(row.entry.renewal_date) < 0;
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="size-8 text-brand hover:text-brand"
        onClick={onAdd}
        title="Add entry for this employee"
        aria-label="Add entry for this employee"
      >
        <Plus size={15} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="size-8"
        onClick={onView}
        disabled={!row.employee}
        title="View details"
        aria-label="View details"
      >
        <Eye size={15} />
      </Button>
      {expired && (
        <Button
          variant="ghost"
          size="sm"
          className="size-8 text-purple-500 hover:text-purple-500"
          onClick={onRenew}
          title="Renew entry"
          aria-label="Renew entry"
        >
          <RefreshCw size={15} />
        </Button>
      )}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 text-rose-500 hover:text-rose-500"
            title="Delete entry"
            aria-label="Delete entry"
          >
            <Trash2 size={15} />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete uniform entry?</AlertDialogTitle>
            <AlertDialogDescription>
              Token #{row.entry.token_number} for {row.entry.employee_name} will be permanently
              removed from the registry. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void onDelete(row.entry)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination: First / Prev / numbered / Next / Last
// ---------------------------------------------------------------------------
function ListPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;

  const pages: (number | 'ellipsis')[] = [];
  if (totalPages <= 7) {
    for (let p = 1; p <= totalPages; p++) pages.push(p);
  } else {
    pages.push(1);
    if (page > 3) pages.push('ellipsis');
    for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) pages.push(p);
    if (page < totalPages - 2) pages.push('ellipsis');
    pages.push(totalPages);
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page === 1}
        onClick={() => onPageChange(1)}
        aria-label="First page"
      >
        <ChevronsLeft size={15} />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page === 1}
        onClick={() => onPageChange(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft size={15} />
      </Button>
      {pages.map((p, idx) =>
        p === 'ellipsis' ? (
          <span key={`ellipsis-${idx}`} className="px-1 text-xs text-muted-foreground">
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === page ? 'default' : 'outline'}
            size="icon"
            className={cn(
              'size-8 text-xs tabular-nums',
              p === page && 'brand-gradient border-transparent text-brand-foreground',
            )}
            onClick={() => onPageChange(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page === totalPages}
        onClick={() => onPageChange(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight size={15} />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        disabled={page === totalPages}
        onClick={() => onPageChange(totalPages)}
        aria-label="Last page"
      >
        <ChevronsRight size={15} />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Create / Renew dialog
// ---------------------------------------------------------------------------
function CreateRenewDialog({
  open,
  target,
  employees,
  sites,
  onClose,
}: {
  open: boolean;
  target: DialogTarget | null;
  employees: EmployeeVM[];
  sites: SiteWithCount[];
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {target && (
          <EntryForm
            key={target.mode === 'renew' ? `renew-${target.entry.id}` : `create-${target.presetEmployeeId ?? 'blank'}`}
            mode={target.mode}
            presetEmployeeId={target.mode === 'renew' ? null : target.presetEmployeeId}
            renewEntry={target.mode === 'renew' ? target.entry : null}
            employees={employees}
            sites={sites}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface EntryFormState {
  employeeId: string | null;
  docType: 'id' | 'passport';
  docNumber: string;
  items: Record<string, boolean>;
  siteName: string | null;
  leaderId: string | null;
  leaderFreeText: string;
  createdDate: string;
}

function EntryForm({
  mode,
  presetEmployeeId,
  renewEntry,
  employees,
  sites,
  onClose,
}: {
  mode: 'create' | 'renew';
  presetEmployeeId: string | null;
  renewEntry: UniformEntry | null;
  employees: EmployeeVM[];
  sites: SiteWithCount[];
  onClose: () => void;
}) {
  const isRenew = mode === 'renew' && renewEntry !== null;
  const [submitting, setSubmitting] = useState(false);

  const makeInitialState = (): EntryFormState => {
    if (mode === 'renew' && renewEntry) {
      const site = sites.find((s) => s.name === renewEntry.site_name) ?? null;
      const leader = site
        ? employees.find(
            (e) => e.status === 'active' && e.site_name === site.name && e.full_name === renewEntry.team_leader_name,
          ) ?? null
        : null;
      return {
        employeeId: renewEntry.employee_id,
        docType: renewEntry.document_type,
        docNumber: renewEntry.document_number,
        items: { ...renewEntry.items },
        siteName: site ? site.name : null,
        leaderId: leader ? leader.id : null,
        leaderFreeText: site ? '' : renewEntry.team_leader_name ?? '',
        createdDate: todayYMD(), // renewal happens today; backdating allowed
      };
    }
    // create mode — prefill documents when an employee is preset
    const preset = presetEmployeeId ? employees.find((e) => e.id === presetEmployeeId) ?? null : null;
    const doc = preset
      ? preset.passport_number
        ? { type: 'passport' as const, number: preset.passport_number }
        : preset.id_number
          ? { type: 'id' as const, number: preset.id_number }
          : null
      : null;
    return {
      employeeId: presetEmployeeId,
      docType: doc ? doc.type : 'passport',
      docNumber: doc ? doc.number : '',
      items: {},
      siteName: null,
      leaderId: null,
      leaderFreeText: '',
      createdDate: todayYMD(),
    };
  };

  const [state, setState] = useState<EntryFormState>(makeInitialState);
  const patch = (p: Partial<EntryFormState>) => setState((prev) => ({ ...prev, ...p }));
  const patchItem = (key: string, value: boolean) =>
    setState((prev) => ({ ...prev, items: { ...prev.items, [key]: value } }));

  const activeEmployees = useMemo(() => employees.filter((e) => e.status === 'active'), [employees]);
  const siteObj = useMemo(
    () => (state.siteName ? sites.find((s) => s.name === state.siteName) ?? null : null),
    [sites, state.siteName],
  );
  const leaderPool = useMemo(() => {
    if (!state.siteName) return [];
    const pool = activeEmployees.filter((e) => e.site_name === state.siteName);
    return [...pool].sort((a, b) => Number(b.is_team_leader) - Number(a.is_team_leader));
  }, [activeEmployees, state.siteName]);
  const currentLeader = useMemo(
    () => (siteObj ? employees.find((e) => e.is_team_leader && e.team_leader_site_id === siteObj.id) ?? null : null),
    [employees, siteObj],
  );
  const expiryPreview = formatExpiryPreview(state.createdDate);

  const handleEmployeeChange = (id: string | null) => {
    const emp = id ? activeEmployees.find((e) => e.id === id) ?? null : null;
    if (emp) {
      // auto-fill document: passport wins when both exist, else id, else blank
      if (emp.passport_number) {
        patch({ employeeId: id, docType: 'passport', docNumber: emp.passport_number });
      } else if (emp.id_number) {
        patch({ employeeId: id, docType: 'id', docNumber: emp.id_number });
      } else {
        patch({ employeeId: id, docNumber: '' });
      }
    } else {
      patch({ employeeId: null, docNumber: '' });
    }
  };

  const handleSiteChange = (value: string) => {
    const next = value === NO_SITE ? null : value;
    patch({ siteName: next, leaderId: null });
  };

  const handleSubmit = async () => {
    if (!state.employeeId) {
      toast.error('Please select an employee');
      return;
    }
    if (!state.docNumber.trim()) {
      toast.error('Document number is required');
      return;
    }
    if (!UNIFORM_ITEMS.some((i) => state.items[i.key] === true)) {
      toast.error('Select at least one item given');
      return;
    }
    if (!state.createdDate) {
      toast.error('Created date is required');
      return;
    }
    setSubmitting(true);
    try {
      const leaderEmp = state.leaderId ? activeEmployees.find((e) => e.id === state.leaderId) ?? null : null;
      const teamLeaderName = siteObj
        ? leaderEmp?.full_name ?? null
        : state.leaderFreeText.trim() || null;

      await dataApi.createUniformEntry({
        employee_id: state.employeeId,
        document_type: state.docType,
        document_number: state.docNumber.trim(),
        items: buildItemsRecord(state.items),
        site_name: siteObj ? siteObj.name : null,
        team_leader_name: teamLeaderName,
        created_at: new Date(state.createdDate).toISOString(),
        token_number: null, // auto-assigned
        is_renewal: isRenew,
        previous_token_id: isRenew && renewEntry ? renewEntry.token_number : null,
      });

      // Team-leader promotion: demote the old leader first, then promote the pick
      if (siteObj && leaderEmp) {
        const needsPromote = !leaderEmp.is_team_leader || leaderEmp.team_leader_site_id !== siteObj.id;
        if (needsPromote) {
          if (currentLeader && currentLeader.id !== leaderEmp.id) {
            await dataApi.updateEmployee(currentLeader.id, {
              ...toEmployeeInput(currentLeader),
              is_team_leader: false,
              team_leader_site_id: null,
            });
          }
          await dataApi.updateEmployee(leaderEmp.id, {
            ...toEmployeeInput(leaderEmp),
            is_team_leader: true,
            team_leader_site_id: siteObj.id,
          });
        }
      }

      toast.success(isRenew ? 'Uniform entry renewed — a new token number was assigned' : 'Uniform entry created');
      onClose();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{isRenew ? 'Renew Uniform Entry' : 'New Uniform Entry'}</DialogTitle>
        <DialogDescription>
          {isRenew && renewEntry
            ? `Renewing the uniform record with token #${renewEntry.token_number} for ${renewEntry.employee_name}.`
            : 'Record an issued uniform, safety gear and its 6-month renewal. Token and uniform IDs are assigned automatically.'}
        </DialogDescription>
      </DialogHeader>

      {isRenew && (
        <div className="flex items-start gap-2 rounded-lg border border-purple-500/25 bg-purple-500/10 p-3 text-xs text-purple-400">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>A new token number will be assigned automatically.</span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Employee *</Label>
          <EmployeeCombobox
            employees={activeEmployees}
            value={state.employeeId}
            onChange={handleEmployeeChange}
            disabled={isRenew}
            placeholder="Search employees…"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Document Type *</Label>
          <Select value={state.docType} onValueChange={(v) => patch({ docType: v as 'id' | 'passport' })}>
            <SelectTrigger className="h-11 w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="id">ID Card</SelectItem>
              <SelectItem value="passport">Passport</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Document Number *</Label>
          <Input
            className="h-11"
            placeholder="e.g. P1543211"
            value={state.docNumber}
            onChange={(e) => patch({ docNumber: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Created Date *</Label>
          <Input
            type="date"
            className="h-11"
            value={state.createdDate}
            onChange={(e) => patch({ createdDate: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">
            Expiry:{' '}
            <span className="font-medium text-foreground/80">{expiryPreview ?? '—'}</span> (6 months)
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Site</Label>
          <Select value={state.siteName ?? NO_SITE} onValueChange={handleSiteChange}>
            <SelectTrigger className="h-11 w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SITE}>No site</SelectItem>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Team Leader</Label>
          {siteObj ? (
            <div className="space-y-1.5">
              <EmployeeCombobox
                employees={leaderPool}
                value={state.leaderId}
                onChange={(id) => patch({ leaderId: id })}
                placeholder="Pick a team leader…"
                emptyText="No active employees at this site."
              />
              {currentLeader ? (
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Crown size={11} className="shrink-0 fill-amber-400 text-amber-400" />
                  {currentLeader.full_name} currently leads this site
                  {state.leaderId && state.leaderId !== currentLeader.id
                    ? ' — picking a different employee will transfer leadership'
                    : ''}
                </p>
              ) : (
                <p className="text-[11px] text-amber-500">No team leader set for this site</p>
              )}
              {state.leaderId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => patch({ leaderId: null })}
                >
                  Clear selection
                </Button>
              )}
            </div>
          ) : (
            <Input
              className="h-11"
              placeholder="Team leader name (optional)"
              value={state.leaderFreeText}
              onChange={(e) => patch({ leaderFreeText: e.target.value })}
            />
          )}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Items Given *</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {UNIFORM_ITEMS.map((item) => (
              <label
                key={item.key}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent/50',
                  state.items[item.key] === true && 'border-brand/40 bg-brand/5',
                )}
              >
                <Checkbox
                  checked={state.items[item.key] === true}
                  onCheckedChange={(c) => patchItem(item.key, c === true)}
                />
                <span aria-hidden>{item.emoji}</span>
                {item.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          className="brand-gradient rounded-lg text-brand-foreground hover:opacity-90"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting && <Loader2 size={15} className="animate-spin" />}
          {isRenew ? 'Renew Entry' : 'Create Entry'}
        </Button>
      </DialogFooter>
    </div>
  );
}
