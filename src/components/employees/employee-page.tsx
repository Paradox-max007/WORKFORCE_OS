'use client';

// ============================================================================
// PULSE Workforce OS — Employee management module
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Building2, Crown, Eye, FileSpreadsheet, GitBranch, Loader2, MapPin, Plus, RotateCcw, Search, Tent,
  UserRound, UserX, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, BranchBadge, EmployeeStatusBadge, RatingStars, SiteBadge, SkeletonRows } from '@/components/shared/primitives';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { NATIONALITY_REGIONS, countriesByRegion } from '@/lib/nationality-groups';
import { employeeExportFileName } from '@/lib/export-xlsx';
import { cn } from '@/lib/utils';
import type { BranchWithCount, CampWithCount, CardType, EmployeeVM, SiteWithCount } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

export function EmployeePage() {
  const user = useAuthStore((s) => s.user);
  const navigateToEmployeeDetails = useAppStore((s) => s.navigateToEmployeeDetails);
  const navigateToEmployeeForm = useAppStore((s) => s.navigateToEmployeeForm);
  const navigateToExportPreview = useAppStore((s) => s.navigateToExportPreview);
  const consumeEmployeeFilter = useAppStore((s) => s.consumeEmployeeFilter);
  const realtimeVersion = useRealtimeVersion(['employee', 'site', 'camp', 'card_type']);

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  // archived employees (approved Cancellation Requests) — listed by the
  // "Cancelled" status filter; every past record stays available
  const [cancelledEmployees, setCancelledEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [branches, setBranches] = useState<BranchWithCount[] | null>(null);
  const [camps, setCamps] = useState<CampWithCount[] | null>(null);
  const [cardTypes, setCardTypes] = useState<CardType[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [regionFilter, setRegionFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [campFilter, setCampFilter] = useState('all');
  const [payFilter, setPayFilter] = useState('all');
  // branch-wise separation — super admins pick a branch from the top row;
  // normal admins are scoped to their granted branches (or everything with
  // the employees_all_branches permission)
  const [branchFilter, setBranchFilter] = useState('all');
  const [siteFilter, setSiteFilter] = useState('all');
  const [assignedSiteIds, setAssignedSiteIds] = useState<Set<string> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  // bringing an archived employee (cancelled or soft-deleted) back to the
  // active roster (super admin) — edit & delete live on the details page only
  const [restoreTarget, setRestoreTarget] = useState<EmployeeVM | null>(null);

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
        const [emps, cancelledList, sts, cps, cards, brs] = await Promise.all([
          dataApi.listEmployees(), dataApi.listCancelledEmployees().catch(() => [] as EmployeeVM[]),
          dataApi.listSites(), dataApi.listCamps(),
          dataApi.listCardTypes().catch(() => [] as CardType[]),
          // branches: every branch for super admins, only the GRANTED branches
          // for normal admins (used for the scoping below)
          dataApi.listBranches().catch(() => [] as BranchWithCount[]),
        ]);
        if (!cancelled) {
          setEmployees(emps); setCancelledEmployees(cancelledList); setSites(sts); setCamps(cps); setCardTypes(cards); setBranches(brs);
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
    return () => { cancelled = true; };

  }, [realtimeVersion]);

  // normal admins: their directly assigned sites (Site Access) — joins the
  // granted-branch sites to form the effective scope below
  useEffect(() => {
    if (user?.role === 'super_admin') { setAssignedSiteIds(null); return; }
    if (!user) return;
    let cancelled = false;
    dataApi.getSiteAssignments(user.id)
      .then((ids) => { if (!cancelled) setAssignedSiteIds(new Set(ids)); })
      .catch(() => { if (!cancelled) setAssignedSiteIds(new Set()); });
    return () => { cancelled = true; };
  }, [user, realtimeVersion]);

  const activeSites = useMemo(() => (sites ?? []).filter((s) => s.is_active), [sites]);
  const activeCamps = useMemo(() => (camps ?? []).filter((c) => c.is_active), [camps]);

  const isSuperAdmin = user?.role === 'super_admin';
  // super admins always see everything; normal admins only with the explicit
  // employees_all_branches grant (Admin Management → Employees → All-branches view)
  const menuPermissions = useAuthStore((s) => s.menuPermissions);
  const viewAllBranches = isSuperAdmin || menuPermissions?.employees_all_branches === true;

  // site id → owning branch id (an employee's branch = their site's branch)
  const branchIdOfSite = useMemo(
    () => new Map((sites ?? []).map((s) => [s.id, s.branch_id ?? null] as const)),
    [sites],
  );

  // EFFECTIVE employee scope for normal admins without the all-branches grant:
  // the sites of their granted branches (listBranches is already scoped to
  // them) PLUS any directly assigned sites (Admin Management → Site Access).
  // null = unrestricted (super admin / all-branches grant).
  const effectiveSiteIds = useMemo<Set<string> | null>(() => {
    if (viewAllBranches) return null;
    const set = new Set(assignedSiteIds ?? []);
    const grantedBranchIds = new Set((branches ?? []).map((b) => b.id));
    (sites ?? []).forEach((s) => {
      if (s.branch_id && grantedBranchIds.has(s.branch_id)) set.add(s.id);
    });
    return set;
  }, [viewAllBranches, assignedSiteIds, branches, sites]);

  // countries present in the directory, grouped by region (Africans, Asians, …)
  // — includes CANCELLED employees so their nationalities stay filterable
  const regionCountries = useMemo(
    () => countriesByRegion([...(employees ?? []), ...(cancelledEmployees ?? [])].map((e) => e.nationality)),
    [employees, cancelledEmployees],
  );
  const countryOptions = useMemo(() => {
    const present = new Set([...(employees ?? []), ...(cancelledEmployees ?? [])].map((e) => e.nationality).filter(Boolean) as string[]);
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
    // the "Cancelled" filter lists ARCHIVED employees (approved cancellation
    // requests — never deleted, all records kept). Every other filter works on
    // the working roster.
    const viewingCancelled = statusFilter === 'cancelled';
    const list = viewingCancelled ? (cancelledEmployees ?? []) : (employees ?? []);
    const q = debouncedSearch.toLowerCase().trim();
    const region = regionFilter === 'all' ? null : NATIONALITY_REGIONS.find((r) => r.key === regionFilter) ?? null;
    return list.filter((e) => {
      // branch scope — normal admins (without the all-branches grant) only see
      // employees working at one of their effective sites. Cancelled employees
      // are site-free (archived) → the scope check is skipped for them.
      if (!viewingCancelled && effectiveSiteIds && (!e.current_site_id || !effectiveSiteIds.has(e.current_site_id))) return false;
      // super-admin Branch dropdown + Site filter (working roster only —
      // cancelled employees have no current site by definition)
      if (!viewingCancelled && branchFilter !== 'all') {
        const b = e.current_site_id ? branchIdOfSite.get(e.current_site_id) : null;
        if (b !== branchFilter) return false;
      }
      if (!viewingCancelled && siteFilter !== 'all' && e.current_site_id !== siteFilter) return false;
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
      // payment method filter (cash / specific card type / not set)
      if (payFilter === 'cash' && e.payment_type !== 'cash') return false;
      if (payFilter === '__unset__' && e.payment_type) return false;
      if (payFilter !== 'all' && payFilter !== 'cash' && payFilter !== '__unset__'
        && !(e.payment_type === 'card' && e.card_type_id === payFilter)) return false;
      if (q) {
        const hay = `${e.full_name} ${e.employee_code} ${e.nationality ?? ''} ${e.phone ?? ''} ${e.position ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [employees, cancelledEmployees, debouncedSearch, statusFilter, regionFilter, countryFilter, campFilter, payFilter, effectiveSiteIds, branchFilter, siteFilter, branchIdOfSite]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  // ---- actions ---------------------------------------------------------------
  // add lives on the dedicated form page; edit & delete live on the employee
  // DETAILS page — the list only routes you there
  const openAdd = () => navigateToEmployeeForm('create');

  const campOptions = useMemo(() => (camps ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [camps]);

  // sites offered in the Site filter — normal admins (no all-branches grant)
  // only get their effective sites; super admins get the selected branch's
  // sites (or every site when "All branches" is selected)
  const siteFilterOptions = useMemo(() => {
    let list = activeSites;
    if (effectiveSiteIds) list = list.filter((s) => effectiveSiteIds.has(s.id));
    else if (branchFilter !== 'all') list = list.filter((s) => (s.branch_id ?? null) === branchFilter);
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [activeSites, effectiveSiteIds, branchFilter]);

  // switching the branch makes a foreign site selection meaningless — drop it
  const changeBranchFilter = (v: string) => {
    setBranchFilter(v);
    if (siteFilter !== 'all' && !siteFilterOptions.some((s) => s.id === siteFilter)) setSiteFilter('all');
    setPage(1);
  };

  /** filename chips mirror the active filters so exports are self-describing */
  const exportChips = (): string[] => {
    const chips: string[] = [];
    if (debouncedSearch.trim()) chips.push(`Search-${debouncedSearch.trim()}`);
    if (branchFilter !== 'all') {
      chips.push(`Branch-${(branches ?? []).find((b) => b.id === branchFilter)?.name ?? 'Branch'}`);
    }
    if (siteFilter !== 'all') {
      chips.push(`Site-${(sites ?? []).find((s) => s.id === siteFilter)?.name ?? 'Site'}`);
    }
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
    if (payFilter === 'cash') chips.push('Payment-Cash');
    else if (payFilter === '__unset__') chips.push('Payment-Not-Set');
    else if (payFilter !== 'all') {
      chips.push(`Payment-${cardTypes.find((c) => c.id === payFilter)?.name ?? 'Card'}`);
    }
    return chips;
  };

  /** Export Excel opens the PREVIEW page first — the download button there
   *  writes the .xlsx (same columns, same order, same values). */
  const exportToExcel = () => {
    if (filtered.length === 0) {
      toast.error('Nothing to export', { description: 'The current filters match no employees.' });
      return;
    }
    setExporting(true);
    const fileName = employeeExportFileName(exportChips());
    // give the button its spinner frame, then switch to the preview page
    setTimeout(() => {
      navigateToExportPreview(filtered, fileName);
      setExporting(false);
    }, 120);
  };

  const confirmRestore = async () => {
    if (!restoreTarget) return;
    try {
      await dataApi.restoreEmployee(restoreTarget.id);
      toast.success('Employee restored', { description: `${restoreTarget.full_name} is back on the active roster — assign a site/camp from Edit.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoreTarget(null);
    }
  };

  const loading = !employees || !sites || (!isSuperAdmin && assignedSiteIds === null && !viewAllBranches);

  return (
    <div className="mx-auto max-w-[1600px]">
      {/* header */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Employee Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {statusFilter === 'cancelled'
              ? <>Employee archive — cancelled or deleted staff; every record kept in the database and restorable</>
              : <>{filtered.length} employee{filtered.length !== 1 ? 's' : ''} · full HR profiles, documents and ratings</>}
          </p>
        </motion.div>
        <div className="flex flex-wrap items-center gap-2">
          {/* BRANCH dropdown — SUPER ADMIN ONLY, lives next to Export Excel:
              All branches + every available branch; the list (and the Site
              options in the filter bar) follow the selection */}
          {isSuperAdmin && (
            <Select value={branchFilter} onValueChange={changeBranchFilter}>
              <SelectTrigger
                className="h-10 w-44 bg-card"
                aria-label="Filter employees by branch"
                title="Show only the selected branch's employees"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <GitBranch size={14} className="shrink-0 text-brand" />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Branches</SelectItem>
                {(branches ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}{!b.is_active ? ' (inactive)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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

      {/* search + filters — STICKY so they stay reachable while scrolling the
          table (same behaviour as the Payroll page) */}
      <div className="sticky top-16 z-30 mb-4 rounded-xl border border-border/60 bg-background/90 px-3 py-2.5 shadow-lg shadow-black/[0.04] backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, ID, nationality, phone, position…"
            className="h-10 bg-card pl-9"
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
            <SelectItem value="cancelled">Cancelled / Deleted</SelectItem>
          </SelectContent>
        </Select>
        {/* payment method filter (cash / card types from the card_type table) */}
        <Select value={payFilter} onValueChange={(v) => { setPayFilter(v); setPage(1); }}>
          <SelectTrigger className="h-10 w-44 bg-card" aria-label="Filter by payment method"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Payment Methods</SelectItem>
            <SelectItem value="cash">Cash</SelectItem>
            {cardTypes.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
            <SelectItem value="__unset__">Not set</SelectItem>
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
        {/* SITE filter — selecting a site lists that site's employees on top
            of every other active filter (no icon — matches the other filters) */}
        <Select value={siteFilter} onValueChange={(v) => { setSiteFilter(v); setPage(1); }}>
          <SelectTrigger className="h-10 w-44 bg-card" aria-label="Filter employees by site">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sites</SelectItem>
            {siteFilterOptions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} ({s.employee_count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(search || branchFilter !== 'all' || siteFilter !== 'all' || statusFilter !== 'all' || regionFilter !== 'all' || countryFilter !== 'all' || campFilter !== 'all' || payFilter !== 'all') && (
          <Button variant="outline" size="sm" onClick={() => { setSearch(''); setBranchFilter('all'); setSiteFilter('all'); setStatusFilter('all'); setRegionFilter('all'); setCountryFilter('all'); setCampFilter('all'); setPayFilter('all'); setPage(1); }}>
            <X size={14} className="mr-1" /> Reset
          </Button>
        )}
        </div>
      </div>

      {/* table */}
      {loading ? (
        <SkeletonRows rows={6} />
      ) : pageRows.length === 0 ? (
        <EmptyState
          icon={<UserRound size={22} />}
          title={statusFilter === 'cancelled' ? 'No archived employees' : 'No employees found'}
          description={
            statusFilter === 'cancelled'
              ? 'Employees land here after a cancellation request is approved or a delete removes them from view. Nothing is erased — all records stay in the database and a super admin can restore them.'
              : !viewAllBranches && effectiveSiteIds !== null && effectiveSiteIds.size === 0
              ? 'You have no branch or site access yet — ask a super admin to grant your branches (Admin Management → Manage Permissions → Branch access).'
              : search || statusFilter !== 'all' || branchFilter !== 'all' || siteFilter !== 'all'
                ? 'Try adjusting your filters.'
                : 'Add your first employee to get started.'
          }
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
                  <th className="px-4 py-3 font-medium">Branch</th>
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
                        {emp.branch_name ? (
                          <span className="inline-flex items-center gap-1" title="Owner branch of the current site">
                            <Building2 size={12} className="text-brand" />{emp.branch_name}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
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
                        {/* edit & delete live on the DETAILS page — the list
                            only routes you there; archived rows (cancelled or
                            soft-deleted) offer a super-admin Restore */}
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            className="brand-gradient font-semibold text-white shadow-md shadow-[var(--glow)] transition-transform active:scale-[0.98]"
                            onClick={() => navigateToEmployeeDetails(emp.id)}
                            aria-label={`View ${emp.full_name}'s details`}
                          >
                            <Eye size={14} /> View
                          </Button>
                          {(emp.status === 'cancelled' || emp.status === 'deleted') && isSuperAdmin && (
                            <Button
                              variant="outline" size="sm"
                              className="h-8 gap-1.5 border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400"
                              title="Restore to active"
                              onClick={() => setRestoreTarget(emp)}
                            >
                              <RotateCcw size={13} /> Restore
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
                      <BranchBadge name={emp.branch_name} />
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
                    <div className="flex items-center gap-1.5">
                      {/* view routes to the details page — edit & delete live there */}
                      <Button
                        size="sm"
                        className="brand-gradient font-semibold text-white"
                        onClick={() => navigateToEmployeeDetails(emp.id)}
                        aria-label={`View ${emp.full_name}'s details`}
                      >
                        <Eye size={13} /> View
                      </Button>
                      {(emp.status === 'cancelled' || emp.status === 'deleted') && isSuperAdmin && (
                        <Button variant="outline" size="sm" className="h-8 gap-1.5 border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400" onClick={() => setRestoreTarget(emp)}>
                          <RotateCcw size={12} /> Restore
                        </Button>
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


      {/* ============ Restore archived employee (super admin) ============
          Works for CANCELLED employees and SOFT-DELETED ones alike — a soft
          delete only hides rows, so everything comes back on restore. */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(o) => { if (!o) setRestoreTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore Employee?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{restoreTarget?.full_name}</strong> will return to the active roster with all their past records
              (attendance, salary, advances, uniforms…). Assign a site and camp again from Edit afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-emerald-600 text-white hover:bg-emerald-600/90" onClick={confirmRestore}>
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
