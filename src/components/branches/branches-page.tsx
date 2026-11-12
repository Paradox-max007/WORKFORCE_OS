'use client';

// ============================================================================
// PULSE Workforce OS — Branch Management
// ----------------------------------------------------------------------------
// A BRANCH owns multiple work sites (site.branch_id). This page manages the
// branch tree:
//
//   Super admins
//     • create / edit / deactivate / delete branches
//     • assign sites to a branch (and unassign them)
//     • see every branch, its sites and live employee counts
//
//   Normal admins (Branches menu granted by a super admin)
//     • see ONLY the branches assigned to them (Admin Management → Branches)
//     • read-only — branch management is a super-admin action
//
// Sites without a branch ("no branch") are only visible to super admins and
// admins with a direct site assignment — a site becomes visible to an admin
// by assigning it to a branch they can access, or via Site Access.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Building2, ChevronDown, GitBranch, Loader2, MapPin, Pencil, Plus,
  Power, PowerOff, Search, Trash2, TreePine, Users, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, PageHeader, SkeletonRows } from '@/components/shared/primitives';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BranchWithCount, SiteWithCount } from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function BranchesPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const version = useRealtimeVersion(['branch', 'admin_branch', 'site', 'employee']);

  const [branches, setBranches] = useState<BranchWithCount[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BranchWithCount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BranchWithCount | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  // ---- data loading ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // listBranches is scoped server-side: super admins get every branch,
        // normal admins only their assigned ones
        const [b, s] = await Promise.all([
          dataApi.listBranches(),
          dataApi.listSites().catch(() => [] as SiteWithCount[]),
        ]);
        if (!cancelled) {
          setBranches(b);
          setSites(s);
        }
      } catch {
        if (!cancelled) setBranches([]);
      }
    })();
    return () => { cancelled = true; };
  }, [version]);

  // ---- search debounce --------------------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ---- derived ----------------------------------------------------------------
  const branchNameOf = useMemo(() => {
    const map = new Map<string, string>();
    (branches ?? []).forEach((b) => map.set(b.id, b.name));
    return map;
  }, [branches]);

  /** sites of a branch (or the "no branch" bucket when branchId is null) */
  const sitesOf = (branchId: string | null): SiteWithCount[] =>
    (sites ?? []).filter((s) => (s.branch_id ?? null) === branchId);

  const matchesSearch = (b: BranchWithCount): boolean => {
    if (!debouncedSearch) return true;
    const hay = `${b.name} ${b.location ?? ''} ${b.notes ?? ''}`.toLowerCase();
    if (hay.includes(debouncedSearch)) return true;
    // also match when any of the branch's sites matches
    return sitesOf(b.id).some((s) =>
      `${s.name} ${s.client_name ?? ''} ${s.project_name ?? ''}`.toLowerCase().includes(debouncedSearch));
  };

  const visibleBranches = (branches ?? []).filter(matchesSearch);
  const unassignedSites = sitesOf(null).filter((s) => {
    if (!debouncedSearch) return true;
    return `${s.name} ${s.client_name ?? ''} ${s.project_name ?? ''}`.toLowerCase().includes(debouncedSearch);
  });
  const loading = branches === null || sites === null;

  // auto-expand branches while searching so hits are visible
  useEffect(() => {
    if (debouncedSearch) {
      setExpanded(new Set((branches ?? []).filter(matchesSearch).map((b) => b.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---- actions -----------------------------------------------------------------
  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };
  const openEdit = (b: BranchWithCount) => {
    setEditTarget(b);
    setFormOpen(true);
  };

  const handleToggleActive = async (b: BranchWithCount) => {
    try {
      await dataApi.updateBranch(b.id, {
        name: b.name, location: b.location, notes: b.notes, is_active: !b.is_active,
      });
      toast.success(b.is_active ? 'Branch deactivated' : 'Branch activated', {
        description: `"${b.name}" ${b.is_active ? 'is now inactive' : 'is active again'}.`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the branch');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDialogBusy(true);
    try {
      await dataApi.deleteBranch(deleteTarget.id);
      toast.success('Branch deleted', {
        description: `"${deleteTarget.name}" was removed. Its sites moved to "no branch" — no employees were affected.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the branch');
    } finally {
      setDialogBusy(false);
    }
  };

  /** Move one site to another branch (super admin, from the branch rows). */
  const handleMoveSite = async (site: SiteWithCount, branchId: string | null) => {
    try {
      await dataApi.setSiteBranch(site.id, branchId);
      toast.success(branchId
        ? `${site.name} → ${branchNameOf.get(branchId) ?? 'branch'}`
        : `${site.name} moved out of the branch`, {
        description: branchId ? 'The site now belongs to this branch.' : 'The site is back in the "no branch" list.',
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to move the site');
    }
  };

  // ---- render --------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Branches"
        description={
          isSuperAdmin
            ? 'Group your work sites under regional branches — admins only see the branches you allow.'
            : 'Branches you have access to and the work sites they own.'
        }
        actions={isSuperAdmin ? (
          <Button
            onClick={openCreate}
            className="h-10 brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            <Plus size={16} /> New Branch
          </Button>
        ) : undefined}
      />

      <div className="card-glow overflow-hidden rounded-xl border bg-card">
        {/* search bar */}
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-brand/10 p-1.5 text-brand">
              <GitBranch size={16} aria-hidden />
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                Branch Tree
                <Badge
                  variant="outline"
                  className="rounded-full border-brand/25 bg-brand/10 px-2 text-[10px] font-semibold text-brand"
                >
                  {loading ? '…' : branches?.length ?? 0}
                </Badge>
              </h3>
              <p className="text-xs text-muted-foreground">
                {isSuperAdmin
                  ? 'Expand a branch to see and manage its sites'
                  : 'Sites owned by the branches you can access'}
              </p>
            </div>
          </div>
          <div className="relative w-full sm:max-w-xs">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search branches or sites…"
              aria-label="Search branches"
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

        <div className="space-y-3 p-4">
          {loading ? (
            <SkeletonRows rows={3} />
          ) : (branches ?? []).length === 0 ? (
            <EmptyState
              icon={<GitBranch size={22} />}
              title="No branches yet"
              description={
                isSuperAdmin
                  ? 'Create your first branch and assign work sites to it — normal admins will only see the branches you give them.'
                  : 'No branches have been assigned to you yet. Ask a super admin to grant you branch access.'
              }
              action={isSuperAdmin ? (
                <Button onClick={openCreate} className="brand-gradient font-semibold text-white">
                  <Plus size={16} /> New Branch
                </Button>
              ) : undefined}
            />
          ) : (
            <>
              {visibleBranches.map((b, i) => (
                <BranchRow
                  key={b.id}
                  branch={b}
                  sites={sitesOf(b.id)}
                  index={i}
                  expanded={expanded.has(b.id)}
                  canManage={isSuperAdmin}
                  onToggle={() => toggleExpand(b.id)}
                  onEdit={() => openEdit(b)}
                  onToggleActive={() => { void handleToggleActive(b); }}
                  onDelete={() => setDeleteTarget(b)}
                  onRemoveSite={(s) => { void handleMoveSite(s, null); }}
                />
              ))}
              {visibleBranches.length === 0 && debouncedSearch && (
                <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                  No branches match “{search}”.
                </p>
              )}

              {/* Unassigned sites bucket (super admin sees it to fix coverage;
                  normal admins see these sites too — they are not gated) */}
              <UnassignedSitesRow
                sites={unassignedSites}
                branches={branches ?? []}
                canManage={isSuperAdmin}
                onAssign={(s, branchId) => { void handleMoveSite(s, branchId); }}
              />
            </>
          )}
        </div>
      </div>

      {/* ---- Create / Edit branch dialog ---- */}
      <BranchFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editTarget} />

      {/* ---- Delete confirmation ---- */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-rose-500" /> Delete Branch
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete{' '}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Its{' '}
              {deleteTarget?.site_count ?? 0} site(s) will move to “no branch” — they stay
              visible to super admins (and admins with a direct site assignment) —
              no employees are affected. Admins assigned to this branch lose their assignment.
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
              Delete Branch
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One branch = one collapsible row; expanding lists the branch's sites
// ---------------------------------------------------------------------------
function BranchRow({
  branch, sites, index, expanded, canManage, onToggle, onEdit, onToggleActive, onDelete, onRemoveSite,
}: {
  branch: BranchWithCount;
  sites: SiteWithCount[];
  index: number;
  expanded: boolean;
  canManage: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onRemoveSite: (site: SiteWithCount) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.4), duration: 0.3, ease: EASE }}
      className={cn(
        'overflow-hidden rounded-xl border bg-background/40',
        expanded ? 'border-brand/30' : 'border-border/60',
      )}
    >
      {/* collapsible header */}
      <div className="flex items-center gap-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} branch ${branch.name}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              branch.is_active
                ? 'bg-brand/10 text-brand'
                : 'bg-zinc-500/10 text-zinc-400',
            )}
          >
            <GitBranch size={19} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold">{branch.name}</span>
              {!branch.is_active && (
                <Badge variant="secondary" className="border-zinc-500/25 bg-zinc-500/10 text-zinc-400">
                  Inactive
                </Badge>
              )}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              {branch.location && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <MapPin size={11} className="shrink-0" aria-hidden /> {branch.location}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Building2 size={11} aria-hidden /> {branch.site_count} {branch.site_count === 1 ? 'site' : 'sites'}
              </span>
              <span className="inline-flex items-center gap-1">
                <Users size={11} aria-hidden /> {branch.employee_count} {branch.employee_count === 1 ? 'employee' : 'employees'}
              </span>
              <span className="hidden sm:inline">Created {fmtDate(branch.created_at)}</span>
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {canManage && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={onEdit}
                title="Edit branch"
                aria-label={`Edit branch ${branch.name}`}
                className="size-8 text-muted-foreground hover:bg-brand/10 hover:text-brand"
              >
                <Pencil size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleActive}
                title={branch.is_active ? 'Deactivate branch' : 'Activate branch'}
                aria-label={`${branch.is_active ? 'Deactivate' : 'Activate'} branch ${branch.name}`}
                className={cn(
                  'size-8',
                  branch.is_active
                    ? 'text-amber-500 hover:bg-amber-500/10 hover:text-amber-500'
                    : 'text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500',
                )}
              >
                {branch.is_active ? <PowerOff size={15} /> : <Power size={15} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDelete}
                title="Delete branch"
                aria-label={`Delete branch ${branch.name}`}
                className="size-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
              >
                <Trash2 size={15} />
              </Button>
            </>
          )}
          <button
            type="button"
            onClick={onToggle}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} branch ${branch.name}`}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={{ duration: 0.2 }}>
              <ChevronDown size={16} />
            </motion.span>
          </button>
        </div>
      </div>

      {/* expanded: the branch's sites */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t bg-muted/20 p-3">
              {sites.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No sites in this branch yet — assign sites from the Branches page or the site form.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {sites.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2"
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-md',
                          s.is_active
                            ? 'bg-emerald-500/10 text-emerald-500'
                            : 'bg-zinc-500/10 text-zinc-400',
                        )}
                      >
                        <Building2 size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {[s.client_name, s.project_name].filter(Boolean).join(' · ') || 'No client / project'}
                        </p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 gap-1 border-brand/25 bg-brand/10 text-brand">
                        <Users size={11} /> {s.employee_count}
                      </Badge>
                      {!s.is_active && (
                        <Badge variant="secondary" className="shrink-0 border-zinc-500/25 bg-zinc-500/10 text-zinc-400">
                          Inactive
                        </Badge>
                      )}
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onRemoveSite(s)}
                          title="Remove from branch"
                          aria-label={`Remove ${s.name} from ${branch.name}`}
                          className="size-7 shrink-0 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
                        >
                          <X size={13} />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// "No branch" bucket — sites waiting for a branch assignment
// ---------------------------------------------------------------------------
function UnassignedSitesRow({
  sites, branches, canManage, onAssign,
}: {
  sites: SiteWithCount[];
  branches: BranchWithCount[];
  canManage: boolean;
  onAssign: (site: SiteWithCount, branchId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (sites.length === 0 && !canManage) return null;

  return (
    <div className={cn('overflow-hidden rounded-xl border border-dashed', expanded && 'border-brand/30')}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 p-3.5 text-left"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <TreePine size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            No branch
            <Badge variant="outline" className="rounded-full bg-muted px-2 text-[10px] font-semibold text-muted-foreground">
              {sites.length}
            </Badge>
          </span>
          <span className="text-[11px] text-muted-foreground/70">
            {canManage
              ? 'Sites without a branch — visible to super admins (and admins with a direct site assignment) until you assign them.'
              : 'Sites without a branch are super-admin only unless directly assigned.'}
          </span>
        </span>
        <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.2 }} className="text-muted-foreground">
          <ChevronDown size={15} className="-rotate-90" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t bg-muted/20 p-3">
              {sites.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                  Every site belongs to a branch — nice.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {sites.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2">
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-md',
                          s.is_active ? 'bg-emerald-500/10 text-emerald-500' : 'bg-zinc-500/10 text-zinc-400',
                        )}
                      >
                        <Building2 size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {[s.client_name, s.project_name].filter(Boolean).join(' · ') || 'No client / project'}
                        </p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 gap-1 border-brand/25 bg-brand/10 text-brand">
                        <Users size={11} /> {s.employee_count}
                      </Badge>
                      {canManage && branches.filter((b) => b.is_active).length > 0 && (
                        <Select onValueChange={(v) => onAssign(s, v)}>
                          <SelectTrigger
                            size="sm"
                            className="h-8 w-[130px] shrink-0 text-xs"
                            aria-label={`Assign ${s.name} to a branch`}
                          >
                            <SelectValue placeholder="Assign to…" />
                          </SelectTrigger>
                          <SelectContent>
                            {branches.filter((b) => b.is_active).map((b) => (
                              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit branch dialog
// ---------------------------------------------------------------------------
function BranchFormDialog({
  open, onOpenChange, editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: BranchWithCount | null;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setLocation(editing?.location ?? '');
      setNotes(editing?.notes ?? '');
      setIsActive(editing?.is_active ?? true);
      setBusy(false);
    }
  }, [open, editing]);

  const trimmedName = name.trim();
  const unchanged =
    !!editing &&
    trimmedName === editing.name &&
    location.trim() === (editing.location ?? '') &&
    notes.trim() === (editing.notes ?? '') &&
    isActive === editing.is_active;

  const submit = async () => {
    if (!trimmedName || busy || unchanged) return;
    setBusy(true);
    try {
      if (editing) {
        await dataApi.updateBranch(editing.id, {
          name: trimmedName,
          location: location.trim() || null,
          notes: notes.trim() || null,
          is_active: isActive,
        });
        toast.success('Branch updated', { description: `"${trimmedName}" was saved.` });
      } else {
        await dataApi.createBranch(trimmedName, location.trim() || null, notes.trim() || null);
        toast.success('Branch created', {
          description: `"${trimmedName}" is ready — assign sites to it from the branch row or the site form.`,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the branch');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded-lg bg-brand/10 p-1.5 text-brand">
              <GitBranch size={15} aria-hidden />
            </span>
            {editing ? 'Edit Branch' : 'New Branch'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Update the branch details. Sites keep their assignment.'
              : 'A branch groups work sites — normal admins only see branches assigned to them.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="branch-name">Branch name *</Label>
            <Input
              id="branch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Northern Emirates Branch"
              className="h-10"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-location">Location</Label>
            <Input
              id="branch-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Umm Al Quwain · Ras Al Khaimah"
              className="h-10"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-notes">Notes</Label>
            <Textarea
              id="branch-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes about this branch…"
              rows={3}
            />
          </div>
          {editing && (
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-[11px] text-muted-foreground">Inactive branches are greyed out but keep their sites.</p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                aria-label="Toggle branch active"
                className="data-[state=checked]:bg-brand [&_[data-slot=switch-thumb]]:bg-white!"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!trimmedName || busy || unchanged}
            className="brand-gradient font-semibold text-white"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {editing ? 'Save Changes' : 'Create Branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
