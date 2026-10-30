'use client';

// ============================================================================
// PULSE Workforce OS — Sites module (site list, per-site crews, attendance
// sheets). Ported from the legacy app with the PULSE premium design language.
// ============================================================================
//
// Layout of this file:
//   1. helpers / constants
//   2. SitesPage            — main view switcher (list ⇆ site employees)
//   3. SiteCard             — one site card in the grid
//   4. SiteFormDialog       — create / edit site dialog
//   5. SiteEmployeesView    — per-site crew management sub-view
//   6. AttendanceSheetView  — full-screen A4 attendance sheet (print / PDF)
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, Building2, Crown, Download, Eye, FileSpreadsheet, Loader2, Pencil,
  Plus, Power, PowerOff, Printer, Search, Trash2, TriangleAlert, UserMinus,
  Users, X,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import {
  EmptyState, EmployeeStatusBadge, PageHeader, RatingStars, SectionTitle,
} from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dataApi } from '@/lib/data';
import { fmtDate, initials } from '@/lib/format';
import { exportElementToPdf, printElement } from '@/lib/pdf';
import { cn } from '@/lib/utils';
import type { EmployeeInput, EmployeeVM, SiteWithCount } from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

// ---------------------------------------------------------------------------
// Helpers & constants
// ---------------------------------------------------------------------------

type SubView = 'list' | 'employees';
type SiteTab = 'active' | 'inactive';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * updateEmployee() requires the FULL EmployeeInput — build one from an existing
 * EmployeeVM (every field passed through) and override only the site/leader
 * fields the caller needs (mirrors how employee-page.tsx builds its payloads).
 */
const toEmployeeInput = (
  e: EmployeeVM,
  overrides: Partial<Pick<EmployeeInput, 'current_site_id' | 'is_team_leader' | 'team_leader_site_id'>> = {},
): EmployeeInput => ({
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
  ...overrides,
});

const upper = (v: string): string => v.toUpperCase();

const formatDateDisplay = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

// ---------------------------------------------------------------------------
// Attendance sheet constants (A4 at 96dpi = 794 × 1123 css px)
// ---------------------------------------------------------------------------
const ROWS_PER_PAGE = 24;
const FIRST_PAGE_ROWS = 18; // first page carries the big header block
const EXTRA_ROWS = 5;

interface SheetRow {
  id: string;
  name: string;
  code: string;
  position: string;
  signature: string;
  isTeamLeader: boolean;
  isSupervisor: boolean;
}

interface ExtraRow {
  name: string;
  code: string;
  trade: string;
  signature: string;
}

const stripTradeSuffix = (v: string): string => v.replace(/\s*\/\s*(TL|SUPERVISOR)$/i, '');

const displayTrade = (r: Pick<SheetRow, 'position' | 'isTeamLeader' | 'isSupervisor'>): string => {
  const pos = r.position.trim();
  if (r.isTeamLeader) return pos ? `${pos} / TL` : 'TL';
  if (r.isSupervisor) return pos ? `${pos} / SUPERVISOR` : 'SUPERVISOR';
  return pos;
};

/**
 * Styles for the attendance sheet. This <style> tag lives INSIDE the printable
 * container, so it travels with `el.outerHTML` when `printElement()` copies the
 * sheet into its iframe, and it also styles the live preview + the off-screen
 * PDF copy. Everything is scoped under `.att-sheet` so it never leaks into the
 * rest of the app. Row paddings are tuned so a full page (24 rows + the extra
 * table) always fits within the fixed 1123px page height.
 */
const ATT_CSS = `
.att-sheet,.att-sheet *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.att-sheet{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
.att-sheet .att-page{position:relative;width:794px;height:1123px;padding:38px;background:#fff;color:#000;overflow:hidden}
.att-sheet .att-band{display:flex;align-items:center;justify-content:space-between;border:1px solid #000;background:#E8E8E8;padding:8px 12px;margin-bottom:10px;min-height:52px}
.att-sheet .att-band-compact{display:block;padding:6px 12px;text-align:center}
.att-sheet .att-company{font-size:16px;font-weight:700;text-align:center;text-transform:uppercase;letter-spacing:.08em;color:#000}
.att-sheet .att-company-sm{font-size:14px}
.att-sheet .att-subband{background:#bbbcbd;color:#000;text-align:center;padding:5px;font-size:13px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;margin-top:6px}
.att-sheet .att-band-compact .att-subband{margin-top:4px;padding:4px}
.att-sheet .att-compact-line{display:flex;justify-content:space-between;font-size:12px;margin:8px 4px 10px;text-transform:uppercase;color:#374151}
.att-sheet .att-info{font-family:'Times New Roman',Times,serif;font-size:12px;text-transform:uppercase;margin:10px 4px 12px;line-height:1.9}
.att-sheet .att-info-row{display:flex;align-items:baseline;margin-bottom:3px}
.att-sheet .att-info-label{font-weight:700;width:130px;flex-shrink:0;color:#000}
.att-sheet .att-info-value{flex:1;border-bottom:1px solid #555;padding:0 4px;min-height:16px;font-weight:700;color:#000}
.att-sheet .att-table{width:100%;border-collapse:collapse;font-size:13px;text-transform:uppercase;table-layout:fixed}
.att-sheet .att-table th{background:#bbbcbd;color:#000;border:1px solid #000;padding:6px;font-weight:700;text-align:center;font-size:14px;line-height:1.2}
.att-sheet .att-table td{border:1px solid #000;padding:6px;font-weight:700;vertical-align:middle;color:#000;line-height:1.2}
.att-sheet .att-c-sl{width:40px}
.att-sheet .att-c-code{width:99px}
.att-sheet .att-c-trade{width:159px}
.att-sheet .att-c-sign{width:140px}
.att-sheet .att-ta-center{text-align:center}
.att-sheet .att-ta-left{text-align:left}
.att-sheet .att-row-even{background:#f3f4f6}
.att-sheet .att-row-tl{background:#fffbeb}
.att-sheet .att-row-sup{background:#eff6ff}
.att-sheet .att-extra-no{color:#9ca3af}
.att-sheet .att-extra-title{margin-top:12px;margin-bottom:4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#000}
.att-sheet .att-totals{display:flex;gap:40px;margin-top:16px;padding-top:10px;border-top:2px solid #000}
.att-sheet .att-totals-cell{flex:1;display:flex;align-items:flex-end;gap:6px;font-size:12px;font-weight:700;text-transform:uppercase;color:#000}
.att-sheet .att-totals-blank{flex:1;border-bottom:1.5px solid #000;min-height:18px;font-weight:700;color:#000}
.att-sheet .att-pageinfo{text-align:right;font-size:10px;color:#6b7280;margin-top:4px;text-transform:uppercase}
.att-sheet .att-text{min-height:16px;color:#000;font-weight:700}
.att-sheet .att-input{width:100%;background:transparent;border:none;outline:none;font-family:inherit;font-size:inherit;font-weight:700;text-transform:uppercase;color:#000;padding:0;min-height:16px;cursor:text}
.att-sheet .att-pdfwrap{width:800px;height:1148px;display:flex;align-items:center;justify-content:center;background:#fff}
.att-print-root .att-page{height:1122px;page-break-after:always;page-break-inside:avoid}
.att-print-root .att-page:last-child{page-break-after:auto}
@page{size:A4;margin:0}
`;

/** Inline SVG logo (html2canvas-safe and survives printElement's outerHTML copy). */
function AttLogo() {
  return (
    <svg width="48" height="48" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="PULSE logo">
      <defs>
        <linearGradient id="att-logo-g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#att-logo-g)" />
      <path d="M10 34h9l6-16 10 30 7-14h12" stroke="white" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function SitesPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const version = useRealtimeVersion(['site', 'employee']);

  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);

  const [subView, setSubView] = useState<SubView>('list');
  const [viewSiteId, setViewSiteId] = useState<string | null>(null);
  const [tab, setTab] = useState<SiteTab>('active');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SiteWithCount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteWithCount | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<SiteWithCount | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  // attendance sheet overlay
  const [attendanceSiteId, setAttendanceSiteId] = useState<string | null>(null);

  // ---- data loading (re-fetches whenever sites or employees change) --------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, e] = await Promise.all([dataApi.listSites(), dataApi.listEmployees()]);
        if (!cancelled) {
          setSites(s);
          setEmployees(e);
        }
      } catch {
        if (!cancelled) {
          setSites([]);
          setEmployees([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  // ---- search debounce (300ms) ---------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ---- derived values --------------------------------------------------------
  const activeSites = useMemo(() => (sites ?? []).filter((s) => s.is_active), [sites]);
  const inactiveSites = useMemo(() => (sites ?? []).filter((s) => !s.is_active), [sites]);
  const loading = sites === null;

  const viewSite = useMemo(
    () => (sites ?? []).find((s) => s.id === viewSiteId) ?? null,
    [sites, viewSiteId],
  );
  const attendanceSite = useMemo(
    () => (sites ?? []).find((s) => s.id === attendanceSiteId) ?? null,
    [sites, attendanceSiteId],
  );
  const showEmployeesView = subView === 'employees' && !!viewSite;

  const matchesSearch = (s: SiteWithCount): boolean => {
    if (!debouncedSearch) return true;
    const hay = `${s.name} ${s.client_name ?? ''} ${s.project_name ?? ''}`.toLowerCase();
    return hay.includes(debouncedSearch);
  };

  // ---- actions ---------------------------------------------------------------

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };
  const openEdit = (site: SiteWithCount) => {
    setEditTarget(site);
    setFormOpen(true);
  };

  const openEmployees = (site: SiteWithCount) => {
    setViewSiteId(site.id);
    setSubView('employees');
  };
  const backToList = () => {
    setSubView('list');
    setViewSiteId(null);
  };

  /** Activate directly; deactivating first asks for confirmation. */
  const handleToggleActive = async (site: SiteWithCount) => {
    if (site.is_active) {
      setDeactivateTarget(site);
      return;
    }
    setTogglingId(site.id);
    try {
      await dataApi.updateSite(site.id, {
        name: site.name,
        client_name: site.client_name,
        project_name: site.project_name,
        is_active: true,
      });
      toast.success('Site activated', {
        description: `"${site.name}" is active again — employees can be assigned to it.`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to activate the site');
    } finally {
      setTogglingId(null);
    }
  };

  const handleConfirmDeactivate = async () => {
    if (!deactivateTarget) return;
    setDialogBusy(true);
    try {
      const { unassignedCount } = await dataApi.updateSite(deactivateTarget.id, {
        name: deactivateTarget.name,
        client_name: deactivateTarget.client_name,
        project_name: deactivateTarget.project_name,
        is_active: false,
      });
      toast.success('Site deactivated', {
        description: `"${deactivateTarget.name}" was moved to the Inactive tab.${
          unassignedCount > 0
            ? ` ${unassignedCount} employee(s) were set to idle/unassigned and team leader status was cleared.`
            : ''
        }`,
      });
      setDeactivateTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to deactivate the site');
    } finally {
      setDialogBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDialogBusy(true);
    try {
      await dataApi.deleteSite(deleteTarget.id);
      toast.success('Site deleted', {
        description: `"${deleteTarget.name}" was removed. Assigned employees were unassigned — not deleted.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the site');
    } finally {
      setDialogBusy(false);
    }
  };

  // ---- grid renderer (shared by both tabs) ----------------------------------
  const renderGrid = (list: SiteWithCount[], tabValue: SiteTab) => {
    if (loading) {
      return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      );
    }
    const filtered = list.filter(matchesSearch);
    if (filtered.length === 0) {
      const searching = debouncedSearch.length > 0;
      return (
        <EmptyState
          icon={<Building2 size={22} />}
          title={
            searching
              ? 'No matching sites'
              : tabValue === 'active'
                ? 'No active sites'
                : 'No inactive sites'
          }
          description={
            searching
              ? 'Try a different search term — search covers site, client and project names.'
              : tabValue === 'active'
                ? 'Create your first work site to start assigning crews and tracking attendance.'
                : 'Sites you deactivate will be moved here and can be reactivated at any time.'
          }
          action={
            !searching && tabValue === 'active' ? (
              <Button onClick={openCreate} className="brand-gradient font-semibold text-white">
                <Plus size={16} /> New Site
              </Button>
            ) : undefined
          }
        />
      );
    }
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((site, i) => (
          <SiteCard
            key={site.id}
            site={site}
            index={i}
            canDelete={isSuperAdmin}
            busy={togglingId === site.id}
            onToggle={handleToggleActive}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onViewEmployees={openEmployees}
            onAttendance={(s) => setAttendanceSiteId(s.id)}
          />
        ))}
      </div>
    );
  };

  // ---- render ----------------------------------------------------------------
  return (
    <div className="mx-auto max-w-7xl">
      <AnimatePresence mode="wait">
        {showEmployeesView && viewSite ? (
          <motion.div
            key="site-employees"
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 32 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <SiteEmployeesView site={viewSite} employees={employees ?? []} onBack={backToList} />
          </motion.div>
        ) : (
          <motion.div
            key="site-list"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <div className="space-y-6">
              <PageHeader
                title="Sites"
                description="Manage work sites and the crews assigned to each location."
                actions={
                  <Button
                    onClick={openCreate}
                    className="h-10 brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
                  >
                    <Plus size={16} /> New Site
                  </Button>
                }
              />

              <Tabs value={tab} onValueChange={(v) => setTab(v as SiteTab)}>
                <div className="card-glow rounded-xl border bg-card">
                  {/* Tabs + shared search */}
                  <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
                    <TabsList className="h-11 w-full gap-1 sm:w-auto">
                      <TabsTrigger value="active" className="h-9 gap-2 px-4">
                        <Power size={15} className="text-emerald-500" />
                        Active
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-500">
                          {activeSites.length}
                        </span>
                      </TabsTrigger>
                      <TabsTrigger value="inactive" className="h-9 gap-2 px-4">
                        <PowerOff size={15} className="text-zinc-400" />
                        Inactive
                        <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-400">
                          {inactiveSites.length}
                        </span>
                      </TabsTrigger>
                    </TabsList>
                    <div className="relative w-full lg:max-w-xs">
                      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by site, client or project…"
                        aria-label="Search sites"
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
                  </div>

                  <TabsContent value="active" className="mt-0 p-4">
                    {renderGrid(activeSites, 'active')}
                  </TabsContent>
                  <TabsContent value="inactive" className="mt-0 p-4">
                    {renderGrid(inactiveSites, 'inactive')}
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- Create / Edit site dialog ---- */}
      <SiteFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editTarget} />

      {/* ---- Deactivate confirmation ---- */}
      <AlertDialog
        open={!!deactivateTarget}
        onOpenChange={(o) => {
          if (!o) setDeactivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-amber-500" /> Deactivate Site
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to deactivate{' '}
              <span className="font-medium text-foreground">{deactivateTarget?.name}</span>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">This will affect employees:</p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">
              <li>
                All{' '}
                <span className="font-semibold text-foreground">
                  {deactivateTarget?.employee_count ?? 0}
                </span>{' '}
                employee(s) assigned to this site will be set to{' '}
                <span className="font-medium text-amber-600 dark:text-amber-400">idle/unassigned</span>
              </li>
              <li>Team leader status for this site will be cleared</li>
              <li>The site will be moved to the Inactive tab</li>
            </ul>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dialogBusy}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleConfirmDeactivate}
              disabled={dialogBusy}
              className="bg-amber-600 font-semibold text-white hover:bg-amber-600/90"
            >
              {dialogBusy ? <Loader2 size={16} className="animate-spin" /> : <PowerOff size={16} />}
              Deactivate Site
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Delete confirmation ---- */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-rose-500" /> Delete Site
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete{' '}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Employees
              assigned to this site will be unassigned (not deleted).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dialogBusy}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleConfirmDelete}
              disabled={dialogBusy}
              className="bg-rose-600 font-semibold text-white hover:bg-rose-600/90"
            >
              {dialogBusy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              Delete Site
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Attendance sheet full-screen overlay ---- */}
      <AnimatePresence>
        {attendanceSite && (
          <motion.div
            key="attendance-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Attendance sheet for ${attendanceSite.name}`}
            className="fixed inset-0 z-50 flex flex-col bg-background"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <AttendanceSheetView
              site={attendanceSite}
              employees={(employees ?? []).filter(
                (e) => e.current_site_id === attendanceSite.id && e.status !== 'deleted',
              )}
              onClose={() => setAttendanceSiteId(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site card (grid tile)
// ---------------------------------------------------------------------------
function SiteCard({
  site, index, canDelete, busy, onToggle, onEdit, onDelete, onViewEmployees, onAttendance,
}: {
  site: SiteWithCount;
  index: number;
  canDelete: boolean;
  busy: boolean;
  onToggle: (site: SiteWithCount) => void;
  onEdit: (site: SiteWithCount) => void;
  onDelete: (site: SiteWithCount) => void;
  onViewEmployees: (site: SiteWithCount) => void;
  onAttendance: (site: SiteWithCount) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.5), duration: 0.35, ease: EASE }}
      whileHover={{ y: -4 }}
      className={cn(
        'card-glow group relative flex flex-col gap-4 rounded-xl border bg-card p-5',
        !site.is_active && 'opacity-80',
      )}
    >
      {/* header: icon, name, per-card actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              site.is_active
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-zinc-500/10 text-zinc-400',
            )}
          >
            <Building2 size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold" title={site.name}>
              {site.name}
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Created {fmtDate(site.created_at)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={() => onToggle(site)}
            title={site.is_active ? 'Deactivate site' : 'Activate site'}
            aria-label={site.is_active ? `Deactivate site ${site.name}` : `Activate site ${site.name}`}
            className={cn(
              'size-8',
              site.is_active
                ? 'text-amber-500 hover:bg-amber-500/10 hover:text-amber-500'
                : 'text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500',
            )}
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : site.is_active ? (
              <PowerOff size={15} />
            ) : (
              <Power size={15} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(site)}
            title="Edit site"
            aria-label={`Edit site ${site.name}`}
            className="size-8 text-muted-foreground hover:bg-brand/10 hover:text-brand"
          >
            <Pencil size={14} />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(site)}
              title="Delete site"
              aria-label={`Delete site ${site.name}`}
              className="size-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
            >
              <Trash2 size={15} />
            </Button>
          )}
        </div>
      </div>

      {/* client / project meta */}
      {(site.client_name || site.project_name) && (
        <div className="space-y-1">
          {site.client_name && (
            <p className="truncate text-xs text-muted-foreground">
              <span className="text-muted-foreground/60">Client:</span> {site.client_name}
            </p>
          )}
          {site.project_name && (
            <p className="truncate text-xs text-muted-foreground">
              <span className="text-muted-foreground/60">Project:</span> {site.project_name}
            </p>
          )}
        </div>
      )}

      {/* counts */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1 border-brand/25 bg-brand/10 text-brand">
          <Users size={11} />
          {site.employee_count} {site.employee_count === 1 ? 'employee' : 'employees'}
        </Badge>
        {!site.is_active && (
          <Badge variant="secondary" className="border-zinc-500/25 bg-zinc-500/10 text-zinc-400">
            Inactive
          </Badge>
        )}
      </div>

      {/* main actions */}
      <div className="mt-auto flex gap-2 border-t pt-4">
        <Button
          variant="outline"
          className="h-9 flex-1 gap-2 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
          onClick={() => onViewEmployees(site)}
        >
          <Eye size={15} /> View Employees
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
          onClick={() => onAttendance(site)}
          title="Attendance sheet"
          aria-label={`Open attendance sheet for ${site.name}`}
        >
          <FileSpreadsheet size={15} />
        </Button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit site dialog
// ---------------------------------------------------------------------------
function SiteFormDialog({
  open, onOpenChange, editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: SiteWithCount | null;
}) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [project, setProject] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the form every time the dialog opens
  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setClient(editing?.client_name ?? '');
      setProject(editing?.project_name ?? '');
      setBusy(false);
    }
  }, [open, editing]);

  const trimmedName = name.trim();
  const unchanged =
    !!editing &&
    trimmedName === editing.name &&
    client.trim() === (editing.client_name ?? '') &&
    project.trim() === (editing.project_name ?? '');

  const submit = async () => {
    if (!trimmedName || busy || unchanged) return;
    setBusy(true);
    try {
      if (editing) {
        await dataApi.updateSite(editing.id, {
          name: trimmedName,
          client_name: client.trim() || null,
          project_name: project.trim() || null,
          is_active: editing.is_active,
        });
        toast.success('Site updated', { description: `Details for "${trimmedName}" were saved.` });
      } else {
        const created = await dataApi.createSite(
          trimmedName,
          client.trim() || null,
          project.trim() || null,
        );
        toast.success('Site created', { description: `"${created.name}" has been added.` });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the site');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Site' : 'Add New Site'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update the details of "${editing.name}". Assigned employees are unaffected.`
              : 'Enter the details for the new work site.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="site-name">
              Site Name <span className="text-rose-500">*</span>
            </Label>
            <Input
              id="site-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. NPC — Umm Al Quwain"
              className="h-11"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-client">Client Name</Label>
            <Input
              id="site-client"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="e.g. NPC"
              className="h-11"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-project">Project Name</Label>
            <Input
              id="site-project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="e.g. NPC — Umm Al Quwain"
              className="h-11"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!trimmedName || busy || unchanged}
            className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
            {editing ? 'Save Changes' : 'Add Site'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Per-site employees sub-view
// ---------------------------------------------------------------------------
function SiteEmployeesView({
  site, employees, onBack,
}: {
  site: SiteWithCount;
  employees: EmployeeVM[];
  onBack: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [pickerValue, setPickerValue] = useState<string | null>(null);

  const siteEmployees = useMemo(
    () => employees.filter((e) => e.current_site_id === site.id && e.status !== 'deleted'),
    [employees, site.id],
  );
  const leader = useMemo(
    () => siteEmployees.find((e) => e.is_team_leader && e.team_leader_site_id === site.id) ?? null,
    [siteEmployees, site.id],
  );
  // transferable: active employees that are not already on this site
  const addable = useMemo(
    () => employees.filter((e) => e.status === 'active' && e.current_site_id !== site.id),
    [employees, site.id],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? siteEmployees.filter((e) =>
          `${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.nationality ?? ''}`
            .toLowerCase()
            .includes(q),
        )
      : siteEmployees;
    // team leader of this site first, everything else keeps list order
    return [...list].sort((a, b) => {
      const aLead = a.is_team_leader && a.team_leader_site_id === site.id;
      const bLead = b.is_team_leader && b.team_leader_site_id === site.id;
      if (aLead !== bLead) return aLead ? -1 : 1;
      return 0;
    });
  }, [siteEmployees, search, site.id]);

  const allSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.id));
  const someSelected = !allSelected && filtered.some((e) => selected.has(e.id));

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((e) => e.id)));
  };

  // ---- add / transfer an employee onto this site -----------------------------
  const handleAdd = async (id: string | null) => {
    setPickerValue(null);
    if (!id || addingId) return;
    const emp = employees.find((e) => e.id === id);
    if (!emp) return;
    setAddingId(id);
    try {
      await dataApi.updateEmployee(id, toEmployeeInput(emp, { current_site_id: site.id }));
      if (emp.site_name) {
        toast.success('Employee transferred', {
          description: `${emp.full_name} was transferred from "${emp.site_name}" to "${site.name}".`,
        });
      } else {
        toast.success('Employee added', {
          description: `${emp.full_name} was added to "${site.name}".`,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add the employee');
    } finally {
      setAddingId(null);
    }
  };

  // ---- remove selected employees (set to idle, never delete) -----------------
  const handleRemove = async () => {
    if (selected.size === 0) return;
    setRemoving(true);
    try {
      await Promise.all(
        [...selected].map((id) => {
          const emp = employees.find((e) => e.id === id);
          if (!emp) return Promise.resolve();
          const leadsThisSite = emp.is_team_leader && emp.team_leader_site_id === site.id;
          return dataApi.updateEmployee(
            id,
            toEmployeeInput(emp, {
              current_site_id: null,
              ...(leadsThisSite ? { is_team_leader: false, team_leader_site_id: null } : {}),
            }),
          );
        }),
      );
      toast.success(`${selected.size} employee(s) removed`, {
        description: 'They were set to idle/unassigned — not deleted. Team leader status was cleared where applicable.',
      });
      setSelected(new Set());
      setRemoveOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove the employee(s)');
    } finally {
      setRemoving(false);
    }
  };

  const meta = [site.client_name, site.project_name].filter(Boolean).join(' · ');

  return (
    <div className="space-y-6">
      {/* ---- header: back, site identity, team leader callout ---- */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={onBack}
            aria-label="Back to sites"
            className="size-10 shrink-0"
          >
            <ArrowLeft size={17} />
          </Button>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 p-2.5 text-brand">
            <Building2 size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{site.name}</h1>
              <Badge variant="secondary" className="tabular-nums">
                {siteEmployees.length} {siteEmployees.length === 1 ? 'employee' : 'employees'}
              </Badge>
              {!site.is_active && (
                <Badge variant="secondary" className="border-zinc-500/25 bg-zinc-500/10 text-zinc-400">
                  Inactive
                </Badge>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {meta ? `${meta} · ` : ''}Created {fmtDate(site.created_at)}
            </p>
            {leader ? (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                <Crown size={13} className="fill-amber-400 text-amber-400" />
                Team Leader · {leader.full_name}
              </div>
            ) : (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Crown size={13} className="text-muted-foreground/50" /> No team leader assigned
              </p>
            )}
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto lg:shrink-0">
          <div className="w-full sm:w-72">
            <EmployeeCombobox
              employees={addable}
              value={pickerValue}
              onChange={handleAdd}
              disabled={!!addingId}
              placeholder="Add employee to this site…"
              emptyText="No active employees available."
            />
          </div>
          {selected.size > 0 && (
            <Button variant="destructive" onClick={() => setRemoveOpen(true)} className="gap-2">
              <UserMinus size={16} /> Remove ({selected.size})
            </Button>
          )}
        </div>
      </div>

      {/* ---- crew table card ---- */}
      <div className="card-glow rounded-xl border bg-card">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <SectionTitle
            icon={<Users size={16} />}
            title="Crew Members"
            sub="Sorted with the team leader first"
          />
          <div className="relative w-full sm:max-w-xs">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employees…"
              aria-label="Search site employees"
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
        </div>

        {filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Users size={22} />}
              title={search ? 'No matching employees' : 'No employees assigned'}
              description={
                search
                  ? 'Try a different search term.'
                  : 'Use the picker above to add or transfer employees to this site.'
              }
            />
          </div>
        ) : (
          <>
            {/* ---- Desktop table ---- */}
            <div className="hidden overflow-x-auto p-2 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 px-3 py-3">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                        onCheckedChange={toggleAll}
                        aria-label="Select all employees"
                      />
                    </TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Employee</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">ID</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Position</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Rating</TableHead>
                    <TableHead className="px-3 py-3 text-center text-xs uppercase tracking-wide text-muted-foreground">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((emp, i) => {
                    const leads = emp.is_team_leader && emp.team_leader_site_id === site.id;
                    return (
                      <motion.tr
                        key={emp.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.28, ease: EASE }}
                        className={cn(
                          'border-b border-border/40 transition-colors last:border-0 hover:bg-muted/30',
                          selected.has(emp.id) && 'bg-brand/5',
                        )}
                      >
                        <TableCell className="px-3 py-3">
                          <Checkbox
                            checked={selected.has(emp.id)}
                            onCheckedChange={() => toggleOne(emp.id)}
                            aria-label={`Select ${emp.full_name}`}
                          />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[11px] font-bold text-brand">
                              {emp.photo ? (
                                <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" />
                              ) : (
                                initials(emp.full_name)
                              )}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="truncate text-sm font-medium">{emp.full_name}</p>
                                {leads && (
                                  <Badge className="gap-0.5 border-amber-500/25 bg-amber-500/10 px-1.5 text-[10px] text-amber-500">
                                    <Crown size={10} className="fill-amber-400 text-amber-400" /> Team Leader
                                  </Badge>
                                )}
                              </div>
                              {emp.nationality && (
                                <p className="text-xs text-muted-foreground">{emp.nationality}</p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3 py-3 font-mono text-[13px]">{emp.employee_code}</TableCell>
                        <TableCell className="px-3 py-3">
                          {emp.position ?? <span className="text-muted-foreground/50">—</span>}
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <RatingStars rating={emp.rating} />
                        </TableCell>
                        <TableCell className="px-3 py-3 text-center">
                          <EmployeeStatusBadge status={emp.status} />
                        </TableCell>
                      </motion.tr>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* ---- Mobile cards ---- */}
            <div className="space-y-3 p-4 md:hidden">
              {filtered.map((emp, i) => {
                const leads = emp.is_team_leader && emp.team_leader_site_id === site.id;
                return (
                  <motion.div
                    key={emp.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.04, 0.3), duration: 0.28, ease: EASE }}
                    className={cn(
                      'rounded-xl border bg-background/40 p-4',
                      selected.has(emp.id) && 'border-brand/40 bg-brand/5',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.has(emp.id)}
                        onCheckedChange={() => toggleOne(emp.id)}
                        aria-label={`Select ${emp.full_name}`}
                        className="mt-1.5"
                      />
                      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xs font-bold text-brand">
                        {emp.photo ? (
                          <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" />
                        ) : (
                          initials(emp.full_name)
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="truncate text-sm font-medium">{emp.full_name}</p>
                          {leads && (
                            <Badge className="gap-0.5 border-amber-500/25 bg-amber-500/10 px-1.5 text-[10px] text-amber-500">
                              <Crown size={10} className="fill-amber-400 text-amber-400" /> TL
                            </Badge>
                          )}
                        </div>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {emp.employee_code}
                          {emp.nationality ? ` · ${emp.nationality}` : ''}
                        </p>
                      </div>
                      <EmployeeStatusBadge status={emp.status} />
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t pt-3">
                      <p className="text-xs text-muted-foreground">{emp.position ?? 'No position'}</p>
                      <RatingStars rating={emp.rating} />
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ---- Remove selected confirmation ---- */}
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-amber-500" />
              Remove {selected.size} {selected.size === 1 ? 'Employee' : 'Employees'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Remove {selected.size} {selected.size === 1 ? 'employee' : 'employees'} from{' '}
              <span className="font-medium text-foreground">{site.name}</span>? They will be set to
              idle/unassigned and will not be deleted from the database. Team leader status will be
              cleared for anyone who leads this site.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleRemove}
              disabled={removing}
              className="bg-rose-600 font-semibold text-white hover:bg-rose-600/90"
            >
              {removing ? <Loader2 size={16} className="animate-spin" /> : <UserMinus size={16} />}
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendance sheet — full-screen overlay with an editable A4 preview
// ---------------------------------------------------------------------------
function AttendanceSheetView({
  site, employees, onClose,
}: {
  site: SiteWithCount;
  employees: EmployeeVM[];
  onClose: () => void;
}) {
  const printRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);

  // editable header fields
  const [clientName, setClientName] = useState((site.client_name ?? '').toUpperCase());
  const [projectName, setProjectName] = useState((site.project_name ?? site.name).toUpperCase());
  const [dateInput, setDateInput] = useState(() => formatDateDisplay(new Date()));
  const [strength, setStrength] = useState(String(employees.length));

  // editable rows (team leaders first, then supervisors, then alphabetical)
  const [rows, setRows] = useState<SheetRow[]>(() =>
    employees.map((e) => ({
      id: e.id,
      name: e.full_name,
      code: e.employee_code,
      position: e.position ?? '',
      signature: '',
      isTeamLeader: e.is_team_leader && e.team_leader_site_id === site.id,
      isSupervisor: (e.position ?? '').toLowerCase().includes('supervisor'),
    })),
  );
  const [extras, setExtras] = useState<ExtraRow[]>(() =>
    Array.from({ length: EXTRA_ROWS }, () => ({ name: '', code: '', trade: '', signature: '' })),
  );
  // hand-written totals (blank lines to be filled after signing)
  const [totalPresent, setTotalPresent] = useState('');
  const [totalAbsent, setTotalAbsent] = useState('');

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  );

  // pagination: 18 rows on the first page (big header), 24 afterwards
  const pages = useMemo(() => {
    if (sortedRows.length <= FIRST_PAGE_ROWS) return [sortedRows];
    const rest = sortedRows.slice(FIRST_PAGE_ROWS);
    const out: SheetRow[][] = [sortedRows.slice(0, FIRST_PAGE_ROWS)];
    for (let i = 0; i < rest.length; i += ROWS_PER_PAGE) out.push(rest.slice(i, i + ROWS_PER_PAGE));
    return out;
  }, [sortedRows]);

  // close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // responsive preview scale (fit the 794px page into the viewport)
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const update = () => {
      setScale(Math.min(1, Math.max(0.25, (el.clientWidth - 48) / 794)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const updateRow = (id: string, field: 'name' | 'code' | 'position' | 'signature', value: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              [field]: value,
              ...(field === 'position'
                ? { isSupervisor: value.toLowerCase().includes('supervisor') }
                : {}),
            }
          : r,
      ),
    );
  };
  const updateExtra = (idx: number, field: keyof ExtraRow, value: string) => {
    setExtras((prev) => prev.map((x, i) => (i === idx ? { ...x, [field]: value } : x)));
  };

  /** Inline editable cell — renders an <input> on screen and plain text in the
   *  hidden print/PDF copies (input values don't survive outerHTML cloning). */
  const cell = (value: string, onChange: ((v: string) => void) | null, center = false) =>
    onChange ? (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(upper(e.target.value))}
        aria-label="Editable cell"
        className={cn(
          'att-input rounded-sm bg-transparent transition-colors hover:bg-brand/10 focus:bg-brand/15 focus:ring-1 focus:ring-brand/60',
          center && 'att-ta-center',
        )}
      />
    ) : (
      <div className="att-text">{value || '\u00A0'}</div>
    );

  /** One A4 page. `interactive` = on-screen preview (editable inputs);
   *  otherwise plain text for the print / PDF copies. */
  const renderPage = (pageRows: SheetRow[], pageIdx: number, interactive: boolean) => {
    const isFirst = pageIdx === 0;
    const isLast = pageIdx === pages.length - 1;
    const serialOffset = pages.slice(0, pageIdx).reduce((n, p) => n + p.length, 0);
    const extraStart = sortedRows.length + 1;

    return (
      <div className="att-page">
        {/* header band + info fields (first page) / compact header (rest) */}
        {isFirst ? (
          <>
            <div className="att-band">
              <div style={{ flex: 1 }} />
              <div style={{ flex: '0 0 auto', textAlign: 'center' }}>
                <div className="att-company">PULSE WORKFORCE OS LLC.</div>
                <div className="att-subband">DAILY ATTENDANCE</div>
              </div>
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                <AttLogo />
              </div>
            </div>
            <div className="att-info">
              <div className="att-info-row">
                <span className="att-info-label">• CLIENT NAME :</span>
                <span className="att-info-value">
                  {cell(clientName, interactive ? (v) => setClientName(v) : null)}
                </span>
              </div>
              <div className="att-info-row">
                <span className="att-info-label">• PROJECT NAME :</span>
                <span className="att-info-value">
                  {cell(projectName, interactive ? (v) => setProjectName(v) : null)}
                </span>
              </div>
              <div className="att-info-row">
                <span className="att-info-label">• DATE :</span>
                <span className="att-info-value">
                  {cell(dateInput, interactive ? (v) => setDateInput(v) : null)}
                </span>
              </div>
              <div className="att-info-row">
                <span className="att-info-label">• STRENGTH :</span>
                <span className="att-info-value">
                  {cell(strength, interactive ? (v) => setStrength(v) : null)}
                </span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="att-band att-band-compact">
              <div className="att-company att-company-sm">PULSE WORKFORCE OS LLC.</div>
              <div className="att-subband">DAILY ATTENDANCE</div>
            </div>
            <div className="att-compact-line">
              <span>
                <strong>CLIENT:</strong> {upper(clientName)} &nbsp;&nbsp;{' '}
                <strong>PROJECT:</strong> {upper(projectName)}
              </span>
              <span>
                <strong>DATE:</strong> {upper(dateInput)}
              </span>
            </div>
          </>
        )}

        {/* main attendance table */}
        <table className="att-table">
          <thead>
            <tr>
              <th className="att-c-sl">SL. NO</th>
              <th className="att-ta-left">NAME</th>
              <th className="att-c-code">EMP. CODE</th>
              <th className="att-c-trade att-ta-left">TRADE</th>
              <th className="att-c-sign">SIGNATURE</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, idx) => {
              const rowCls = row.isTeamLeader
                ? 'att-row-tl'
                : row.isSupervisor
                  ? 'att-row-sup'
                  : idx % 2 === 1
                    ? 'att-row-even'
                    : '';
              return (
                <tr key={row.id} className={rowCls}>
                  <td className="att-ta-center">{serialOffset + idx + 1}</td>
                  <td>{cell(upper(row.name), interactive ? (v) => updateRow(row.id, 'name', v) : null)}</td>
                  <td className="att-ta-center">
                    {cell(upper(row.code), interactive ? (v) => updateRow(row.id, 'code', v) : null, true)}
                  </td>
                  <td>
                    {cell(
                      upper(displayTrade(row)),
                      interactive ? (v) => updateRow(row.id, 'position', stripTradeSuffix(v)) : null,
                    )}
                  </td>
                  <td className="att-ta-center">
                    {cell(
                      upper(row.signature),
                      interactive ? (v) => updateRow(row.id, 'signature', v) : null,
                      true,
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* extra employees table (last page only) */}
        {isLast && (
          <>
            <div className="att-extra-title">EXTRA EMPLOYEES (IF ANY)</div>
            <table className="att-table">
              <thead>
                <tr>
                  <th className="att-c-sl">SL. NO</th>
                  <th className="att-ta-left">NAME</th>
                  <th className="att-c-code">EMP. CODE</th>
                  <th className="att-c-trade att-ta-left">TRADE</th>
                  <th className="att-c-sign">SIGNATURE</th>
                </tr>
              </thead>
              <tbody>
                {extras.map((x, idx) => (
                  <tr key={idx}>
                    <td className="att-ta-center att-extra-no">{extraStart + idx}</td>
                    <td>{cell(x.name, interactive ? (v) => updateExtra(idx, 'name', v) : null)}</td>
                    <td className="att-ta-center">
                      {cell(x.code, interactive ? (v) => updateExtra(idx, 'code', v) : null, true)}
                    </td>
                    <td>{cell(x.trade, interactive ? (v) => updateExtra(idx, 'trade', v) : null)}</td>
                    <td className="att-ta-center">
                      {cell(x.signature, interactive ? (v) => updateExtra(idx, 'signature', v) : null, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* hand-written totals — AFTER the signing rows */}
            <div className="att-totals">
              <div className="att-totals-cell">
                <span className="att-totals-label">TOTAL PRESENT :</span>
                <span className="att-totals-blank">
                  {cell(totalPresent, interactive ? (v) => setTotalPresent(v) : null, true)}
                </span>
              </div>
              <div className="att-totals-cell">
                <span className="att-totals-label">TOTAL ABSENT :</span>
                <span className="att-totals-blank">
                  {cell(totalAbsent, interactive ? (v) => setTotalAbsent(v) : null, true)}
                </span>
              </div>
            </div>
          </>
        )}

        <div className="att-pageinfo">
          PAGE {pageIdx + 1} OF {pages.length}
        </div>
      </div>
    );
  };

  // ---- export helpers ---------------------------------------------------------
  const dateSlug = (() => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateInput.trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().slice(0, 10);
  })();
  const filename = `attendance-${site.name.replace(/\s+/g, '-').toLowerCase()}-${dateSlug}.pdf`;

  /**
   * PDF copy: the hidden container stacks 800×1148px wrappers (each holding a
   * 794×1123 page). At html2canvas scale 2 every wrapper maps to exactly 287mm
   * — the slice height used by `exportElementToPdf` — so each jsPDF page lines
   * up perfectly with one sheet page.
   */
  const handleDownload = async () => {
    const el = pdfRef.current;
    if (!el || busy) return;
    setBusy(true);
    try {
      await exportElementToPdf(el, filename);
      toast.success('Attendance sheet downloaded', {
        description: `${pages.length} page(s) · ${site.name}`,
      });
    } catch {
      toast.error('Failed to generate the PDF. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /** Print copy: true-A4 pages (794×1122) with an embedded stylesheet, so the
   *  outerHTML that `printElement` copies into its iframe stays fully styled. */
  const handlePrint = () => {
    const el = printRef.current;
    if (el) printElement(el);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ---- toolbar ---- */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card/90 px-3 py-2.5 backdrop-blur sm:px-4">
        <Button variant="outline" size="sm" onClick={onClose} className="gap-1.5 font-semibold">
          <ArrowLeft size={15} /> Back
        </Button>
        <div className="hidden h-5 w-px bg-border sm:block" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Attendance Sheet — {site.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {sortedRows.length} employee(s) · {pages.length} page(s) · fields are editable before export
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            <span className="hidden sm:inline">Download PDF</span>
          </Button>
          <Button
            size="sm"
            onClick={handlePrint}
            className="brand-gradient gap-1.5 font-semibold text-white shadow-lg shadow-[var(--glow)]"
          >
            <Printer size={15} />
            <span className="hidden sm:inline">Print</span>
          </Button>
        </div>
      </div>

      {/* ---- scrollable A4 preview ---- */}
      <div ref={previewRef} className="flex-1 overflow-auto bg-muted/50 p-4 sm:p-6 dark:bg-zinc-950/40">
        <div className="mx-auto flex w-fit flex-col items-center gap-6">
          {pages.map((pageRows, i) => (
            <div
              key={i}
              style={{ width: Math.round(794 * scale), height: Math.round(1123 * scale) }}
              className="overflow-hidden shadow-2xl ring-1 ring-border"
            >
              <div
                style={{ width: 794, height: 1123, transform: `scale(${scale})`, transformOrigin: 'top left' }}
              >
                <div className="att-sheet">{renderPage(pageRows, i, true)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---- hidden print copy (true A4, text cells, styled via embedded CSS) ---- */}
      <div aria-hidden className="pointer-events-none" style={{ position: 'absolute', left: '-20000px', top: 0 }}>
        <div ref={printRef} className="att-sheet att-print-root" style={{ width: 794 }}>
          <style>{ATT_CSS}</style>
          {pages.map((pageRows, i) => (
            <Fragment key={i}>{renderPage(pageRows, i, false)}</Fragment>
          ))}
        </div>
      </div>

      {/* ---- hidden PDF copy (800×1148 wrappers for exact jsPDF slicing) ---- */}
      <div
        ref={pdfRef}
        aria-hidden
        className="pointer-events-none att-sheet"
        style={{ position: 'absolute', left: '-21000px', top: 0, width: 800 }}
      >
        {pages.map((pageRows, i) => (
          <div key={i} className="att-pdfwrap">
            {renderPage(pageRows, i, false)}
          </div>
        ))}
      </div>
    </div>
  );
}
