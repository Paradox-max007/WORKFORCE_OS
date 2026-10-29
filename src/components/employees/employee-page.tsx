'use client';

// ============================================================================
// PULSE Workforce OS — Employee management module
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Crown, FileSpreadsheet, Loader2, MapPin, Pencil, Plus, Search, Tent, Trash2,
  UserRound, UserX, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, EmployeeStatusBadge, RatingStars, SiteBadge, SkeletonRows } from '@/components/shared/primitives';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { NATIONALITY_REGIONS, countriesByRegion } from '@/lib/nationality-groups';
import { exportEmployeesToXlsx, employeeExportFileName } from '@/lib/export-xlsx';
import { cn } from '@/lib/utils';
import type { CampWithCount, EmployeeVM, SiteWithCount } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

export function EmployeePage() {
  const user = useAuthStore((s) => s.user);
  const navigateToEmployeeDetails = useAppStore((s) => s.navigateToEmployeeDetails);
  const navigateToEmployeeForm = useAppStore((s) => s.navigateToEmployeeForm);
  const consumeEmployeeFilter = useAppStore((s) => s.consumeEmployeeFilter);
  const realtimeVersion = useRealtimeVersion(['employee', 'site', 'camp']);

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [camps, setCamps] = useState<CampWithCount[] | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [regionFilter, setRegionFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [campFilter, setCampFilter] = useState('all');
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  // delete / request-deletion dialogs (add & edit moved to the dedicated form page)
  const [deleteTarget, setDeleteTarget] = useState<EmployeeVM | null>(null);
  const [requestDeleteTarget, setRequestDeleteTarget] = useState<EmployeeVM | null>(null);
  const [requestReason, setRequestReason] = useState('');

  // cross-page filter (e.g. dashboard "Idle" card)
  useEffect(() => {
    const f = consumeEmployeeFilter();
    if (f === 'idle' || f === 'working') setStatusFilter(f);

  }, []);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // data loading
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [emps, sts, cps] = await Promise.all([dataApi.listEmployees(), dataApi.listSites(), dataApi.listCamps()]);
        if (!cancelled) { setEmployees(emps); setSites(sts); setCamps(cps); }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
    return () => { cancelled = true; };

  }, [realtimeVersion]);

  const activeSites = useMemo(() => (sites ?? []).filter((s) => s.is_active), [sites]);
  const activeCamps = useMemo(() => (camps ?? []).filter((c) => c.is_active), [camps]);

  // countries present in the directory, grouped by region (Africans, Asians, …)
  const regionCountries = useMemo(
    () => countriesByRegion((employees ?? []).map((e) => e.nationality)),
    [employees],
  );
  const countryOptions = useMemo(() => {
    const present = new Set((employees ?? []).map((e) => e.nationality).filter(Boolean) as string[]);
    if (regionFilter === 'all') {
      return Object.values(regionCountries).flat().sort((a, b) => a.localeCompare(b));
    }
    if (regionFilter === '__others__') {
      const others = [...present].filter((c) =>
        !NATIONALITY_REGIONS.some((r) => r.countries.some((rc) => rc.toLowerCase() === c.toLowerCase())),
      );
      return others.sort((a, b) => a.localeCompare(b));
    }
    const region = NATIONALITY_REGIONS.find((r) => r.key === regionFilter);
    if (!region) return [];
    const inRegion = region.countries.filter((c) => present.has(c));
    return inRegion.length > 0 ? inRegion : region.countries;
  }, [regionFilter, regionCountries, employees]);

  // filtering
  const filtered = useMemo(() => {
    const list = employees ?? [];
    const q = debouncedSearch.toLowerCase().trim();
    const region = regionFilter === 'all' ? null : NATIONALITY_REGIONS.find((r) => r.key === regionFilter) ?? null;
    return list.filter((e) => {
      if (statusFilter === 'active' && e.status !== 'active') return false;
      if (statusFilter === 'working' && (e.status !== 'active' || !e.current_site_id)) return false;
      if (statusFilter === 'idle' && (e.status !== 'active' || e.current_site_id)) return false;
      if (statusFilter === 'pending_deletion' && e.status !== 'pending_deletion') return false;
      // nationality region + country filters
      if (region) {
        const nat = (e.nationality ?? '').trim().toLowerCase();
        if (!nat) return false;
        if (region.key === '__others__') {
          const known = NATIONALITY_REGIONS.some((r) =>
            r.countries.some((c) => c.toLowerCase() === nat));
          if (known) return false;
        } else if (!region.countries.some((c) => c.toLowerCase() === nat)) {
          return false;
        }
      }
      if (countryFilter !== 'all' && (e.nationality ?? '') !== countryFilter) return false;
      // camp filter ('__none__' = employees without a camp)
      if (campFilter === '__none__' && e.camp_id) return false;
      if (campFilter !== 'all' && campFilter !== '__none__' && e.camp_id !== campFilter) return false;
      if (q) {
        const hay = `${e.full_name} ${e.employee_code} ${e.nationality ?? ''} ${e.phone ?? ''} ${e.position ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [employees, debouncedSearch, statusFilter, regionFilter, countryFilter, campFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  // ---- actions ---------------------------------------------------------------
  // add / edit live on the dedicated form page
  const openAdd = () => navigateToEmployeeForm('create');
  const openEdit = (emp: EmployeeVM) => navigateToEmployeeForm('edit', emp.id, 'employees');

  const campOptions = useMemo(() => (camps ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [camps]);

  /** filename chips mirror the active filters so exports are self-describing */
  const exportChips = (): string[] => {
    const chips: string[] = [];
    if (debouncedSearch.trim()) chips.push(`Search-${debouncedSearch.trim()}`);
    if (statusFilter !== 'all') chips.push(`Status-${statusFilter.replace(/_/g, ' ')}`);
    if (regionFilter === '__others__') chips.push('Nationality-Others');
    else if (regionFilter !== 'all') {
      const region = NATIONALITY_REGIONS.find((r) => r.key === regionFilter);
      chips.push(`Nationality-${region?.label ?? regionFilter}`);
    }
    if (countryFilter !== 'all') chips.push(`Country-${countryFilter}`);
    if (campFilter === '__none__') chips.push('Camp-None');
    else if (campFilter !== 'all') {
      chips.push(`Camp-${campOptions.find((c) => c.id === campFilter)?.name ?? 'Camp'}`);
    }
    return chips;
  };

  const exportToExcel = async () => {
    if (filtered.length === 0) {
      toast.error('Nothing to export', { description: 'The current filters match no employees.' });
      return;
    }
    setExporting(true);
    try {
      const fileName = employeeExportFileName(exportChips());
      await exportEmployeesToXlsx(filtered, fileName);
      toast.success('Excel exported', { description: `${filtered.length} employee(s) → ${fileName}` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await dataApi.deleteEmployeeCascade(deleteTarget.id);
      toast.success('Employee deleted', { description: `${deleteTarget.full_name} and related records were removed from view.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleteTarget(null);
    }
  };

  const confirmRequestDeletion = async () => {
    if (!requestDeleteTarget) return;
    try {
      await dataApi.requestEmployeeDeletion(requestDeleteTarget.id, requestReason.trim() || null);
      toast.success('Deletion requested', { description: 'A super admin will review this request.' });
      setRequestDeleteTarget(null);
      setRequestReason('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    }
  };

  const isSuperAdmin = user?.role === 'super_admin';
  const loading = !employees || !sites;

  return (
    <div className="mx-auto max-w-7xl">
      {/* header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Employee Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered.length} employee{filtered.length !== 1 ? 's' : ''} · full HR profiles, documents and ratings
          </p>
        </motion.div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={exportToExcel}
            disabled={exporting || filtered.length === 0}
            className="h-10 font-medium"
            title="Download the current filtered list as an Excel sheet"
          >
            {exporting ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : <FileSpreadsheet size={15} className="mr-1.5 text-emerald-600 dark:text-emerald-400" />}
            Export Excel
          </Button>
          <Button onClick={openAdd} className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]">
            <Plus size={16} className="mr-1.5" /> Add Employee
          </Button>
        </div>
      </div>

      {/* filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, ID, nationality, phone, position…"
            className="h-10 pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="h-10 w-44 bg-card"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="working">Currently Working</SelectItem>
            <SelectItem value="idle">Idle (No Site)</SelectItem>
            <SelectItem value="pending_deletion">Pending Deletion</SelectItem>
          </SelectContent>
        </Select>
        {/* Nationality region + country filters (e.g. Africans → Burundi) */}
        <Select
          value={regionFilter}
          onValueChange={(v) => { setRegionFilter(v); setCountryFilter('all'); setPage(1); }}
        >
          <SelectTrigger className="h-10 w-44 bg-card" aria-label="Filter by nationality region">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Regions</SelectItem>
            {NATIONALITY_REGIONS.map((r) => (
              <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>
            ))}
            <SelectItem value="__others__">Others</SelectItem>
          </SelectContent>
        </Select>
        <Select value={countryFilter} onValueChange={(v) => { setCountryFilter(v); setPage(1); }}>
          <SelectTrigger className="h-10 w-44 bg-card" aria-label="Filter by nationality country">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Countries</SelectItem>
            {countryOptions.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={campFilter} onValueChange={(v) => { setCampFilter(v); setPage(1); }}>
          <SelectTrigger className="h-10 w-48 bg-card" aria-label="Filter by camp">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Camps</SelectItem>
            {campOptions.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}{c.employee_count != null ? ` (${c.employee_count})` : ''}
              </SelectItem>
            ))}
            <SelectItem value="__none__">No camp assigned</SelectItem>
          </SelectContent>
        </Select>
        {(search || statusFilter !== 'all' || regionFilter !== 'all' || countryFilter !== 'all' || campFilter !== 'all') && (
          <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter('all'); setRegionFilter('all'); setCountryFilter('all'); setCampFilter('all'); setPage(1); }}>
            <X size={14} className="mr-1" /> Reset
          </Button>
        )}
      </div>

      {/* table */}
      {loading ? (
        <SkeletonRows rows={6} />
      ) : pageRows.length === 0 ? (
        <EmptyState
          icon={<UserRound size={22} />}
          title="No employees found"
          description={search || statusFilter !== 'all' ? 'Try adjusting your filters.' : 'Add your first employee to get started.'}
          action={
            !search && statusFilter === 'all' ? (
              <Button onClick={openAdd} variant="outline"><Plus size={15} className="mr-1.5" /> Add Employee</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* desktop */}
          <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Employee</th>
                  <th className="px-4 py-3 font-medium">ID</th>
                  <th className="px-4 py-3 font-medium">Nationality</th>
                  <th className="px-4 py-3 font-medium">Position</th>
                  <th className="px-4 py-3 font-medium">Site</th>
                  <th className="px-4 py-3 font-medium">Rating</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {pageRows.map((emp, i) => (
                    <motion.tr
                      key={emp.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ delay: i * 0.03 }}
                      className="border-b border-border/40 transition-colors last:border-0 hover:bg-brand/[0.03]"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xs font-bold text-brand">
                            {emp.photo ? (
                               
                              <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" />
                            ) : initials(emp.full_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 font-medium">
                              <span className="truncate">{emp.full_name}</span>
                              {emp.is_team_leader && (
                                <span title="Team Leader" className="inline-flex">
                                  <Crown size={12} className="shrink-0 fill-amber-400 text-amber-400" />
                                </span>
                              )}
                            </p>
                            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                              {emp.site_name ? (
                                <SiteBadge name={emp.site_name} />
                              ) : (
                                <span className="inline-flex items-center gap-0.5 text-amber-500"><UserX size={10} /> Idle</span>
                              )}
                              {emp.camp_name && (
                                <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                  <Tent size={9} className="inline" />{emp.camp_name}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{emp.employee_code}</td>
                      <td className="px-4 py-3">
                        {emp.nationality ? (
                          <span className="text-xs font-medium">{emp.nationality}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{emp.position ?? '—'}</td>
                      <td className="px-4 py-3">
                        {emp.site_name ? (
                          <span className="inline-flex items-center gap-1"><MapPin size={12} className="text-emerald-500" />{emp.site_name}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unassigned</span>
                        )}
                      </td>
                      <td className="px-4 py-3"><RatingStars rating={emp.rating} /></td>
                      <td className="px-4 py-3"><EmployeeStatusBadge status={emp.status} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-brand" title="View details" onClick={() => navigateToEmployeeDetails(emp.id)}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                          </Button>
                          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-brand" title="Edit" onClick={() => openEdit(emp)}>
                            <Pencil size={14} />
                          </Button>
                          {emp.status !== 'pending_deletion' && (
                            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500" title="Delete" onClick={() => (isSuperAdmin ? setDeleteTarget(emp) : setRequestDeleteTarget(emp))}>
                              <Trash2 size={14} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="grid gap-3 md:hidden">
            <AnimatePresence>
              {pageRows.map((emp, i) => (
                <motion.div
                  key={emp.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="card-glow rounded-xl border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="flex size-10 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xs font-bold text-brand">
                        {emp.photo ? (
                           
                          <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" />
                        ) : initials(emp.full_name)}
                      </span>
                      <div>
                        <p className="flex items-center gap-1 font-medium">
                          {emp.full_name}
                          {emp.is_team_leader && <Crown size={12} className="fill-amber-400 text-amber-400" />}
                        </p>
                        <p className="font-mono text-[11px] text-muted-foreground">{emp.employee_code} · {emp.position ?? '—'}</p>
                      </div>
                    </div>
                    <EmployeeStatusBadge status={emp.status} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {emp.site_name ? <SiteBadge name={emp.site_name} /> : <SiteBadge name={null} />}
                      {emp.nationality && (
                        <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
                          {emp.nationality}
                        </span>
                      )}
                      {emp.camp_name && (
                        <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          <Tent size={9} className="inline" />{emp.camp_name}
                        </span>
                      )}
                      <RatingStars rating={emp.rating} size={12} />
                    </div>
                    <div className="flex gap-1">
                      <Button variant="outline" size="icon" className="size-8" title="View details" onClick={() => navigateToEmployeeDetails(emp.id)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></Button>
                      <Button variant="outline" size="icon" className="size-8" onClick={() => openEdit(emp)}><Pencil size={13} /></Button>
                      {emp.status !== 'pending_deletion' && (
                        <Button variant="outline" size="icon" className="size-8 hover:border-rose-500/40 hover:text-rose-500" onClick={() => (isSuperAdmin ? setDeleteTarget(emp) : setRequestDeleteTarget(emp))}><Trash2 size={13} /></Button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-1">
              {(['first', 'prev'] as const).map((k) => (
                <Button key={k} variant="outline" size="sm" disabled={k === 'first' ? safePage === 1 : safePage === 1} onClick={() => setPage(k === 'first' ? 1 : safePage - 1)}>
                  {k === 'first' ? '«' : '‹'}
                </Button>
              ))}
              {Array.from({ length: totalPages }).slice(Math.max(0, Math.min(safePage - 3, totalPages - 5)), Math.max(5, Math.min(totalPages, safePage + 2))).map((_, idx) => {
                const n = Math.max(0, Math.min(safePage - 3, totalPages - 5)) + idx + 1;
                return (
                  <Button key={n} variant={n === safePage ? 'default' : 'outline'} size="sm" className={cn(n === safePage && 'brand-gradient text-white')} onClick={() => setPage(n)}>
                    {n}
                  </Button>
                );
              })}
              {(['next', 'last'] as const).map((k) => (
                <Button key={k} variant="outline" size="sm" disabled={safePage === totalPages} onClick={() => setPage(k === 'last' ? totalPages : safePage + 1)}>
                  {k === 'next' ? '›' : '»'}
                </Button>
              ))}
            </div>
          )}
        </>
      )}


      {/* ============ Delete (super admin) ============ */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Employee?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.full_name}</strong> will be permanently removed. Their attendance, warnings, fines,
              requests and uniform records will be hidden from the system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-600/90" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ============ Request deletion (admin) ============ */}
      <Dialog open={!!requestDeleteTarget} onOpenChange={(o) => { if (!o) setRequestDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request Employee Deletion</DialogTitle>
            <DialogDescription>
              <strong>{requestDeleteTarget?.full_name}</strong> will be marked as “Pending Deletion” until a super admin
              approves or rejects the request.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason</Label>
            <Textarea value={requestReason} onChange={(e) => setRequestReason(e.target.value)} placeholder="Why should this employee be removed?" rows={3} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setRequestDeleteTarget(null)}>Cancel</Button>
            <Button className="bg-rose-600 font-semibold text-white hover:bg-rose-600/90" onClick={confirmRequestDeletion}>Submit Request</Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
