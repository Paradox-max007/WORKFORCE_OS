'use client';

// ============================================================================
// PULSE Workforce OS — Camp Management (labour accommodation)
// ----------------------------------------------------------------------------
// A camp = accommodation where employees STAY. One employee belongs to at
// most ONE camp (employee.camp_id) — moving a resident is a single reassign
// via dataApi.assignEmployeeCamp. Deactivating a camp KEEPS its residents (it
// just stops accepting new ones); deleting a camp unassigns them (employees
// are never deleted).
// ============================================================================
//
// Layout of this file:
//   1. helpers
//   2. CampsPage            — main view switcher (list ⇆ camp residents)
//   3. StatChip             — small summary chip
//   4. CampCard             — one camp card in the grid
//   5. CampFormDialog       — create / edit camp dialog
//   6. MoveResidentDialog   — small "move to another camp" dialog (row + bulk)
//   7. CampResidentsView    — per-camp residents management sub-view
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, ArrowLeftRight, BedDouble, Eye, Loader2, MapPin, Pencil, Plus,
  Power, PowerOff, Search, Tent, Trash2, TriangleAlert, UserMinus, Users, X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import {
  AnimatedCounter, EmptyState, PageHeader, RatingStars, SectionTitle, SiteBadge,
  SkeletonRows,
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { fmtDate, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CampWithCount, EmployeeVM } from '@/lib/types';
import { useRealtimeVersion } from '@/store/realtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SubView = 'list' | 'residents';
type CampTab = 'active' | 'inactive';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** "" → null, otherwise the trimmed value (what the data layer expects). */
const nullify = (v: string): string | null => (v.trim() === '' ? null : v.trim());

/** Capacity string → whole non-negative number, or null when blank. */
const parseCapacity = (raw: string): number | null => {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (Number.isNaN(n) || n < 0) return null; // invalid text is guarded by the caller
  return Math.max(0, Math.floor(n));
};

const isCapacityInvalid = (raw: string): boolean => {
  const t = raw.trim();
  if (t === '') return false;
  const n = Number(t);
  return Number.isNaN(n) || n < 0;
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function CampsPage() {
  const version = useRealtimeVersion(['camp', 'employee']);

  const [camps, setCamps] = useState<CampWithCount[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);

  const [subView, setSubView] = useState<SubView>('list');
  const [viewCampId, setViewCampId] = useState<string | null>(null);
  const [tab, setTab] = useState<CampTab>('active');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CampWithCount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CampWithCount | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  // ---- data loading (re-fetches whenever camps or employees change) --------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, e] = await Promise.all([dataApi.listCamps(), dataApi.listEmployees()]);
        if (!cancelled) {
          setCamps(c);
          setEmployees(e);
        }
      } catch {
        if (!cancelled) {
          setCamps([]);
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
  const activeCamps = useMemo(() => (camps ?? []).filter((c) => c.is_active), [camps]);
  const inactiveCamps = useMemo(() => (camps ?? []).filter((c) => !c.is_active), [camps]);
  const housedCount = useMemo(
    () => (employees ?? []).filter((e) => e.camp_id !== null && e.status === 'active').length,
    [employees],
  );
  const loading = camps === null;

  const viewCamp = useMemo(
    () => (camps ?? []).find((c) => c.id === viewCampId) ?? null,
    [camps, viewCampId],
  );
  const showResidentsView = subView === 'residents' && !!viewCamp;

  const matchesSearch = (c: CampWithCount): boolean => {
    if (!debouncedSearch) return true;
    const hay = `${c.name} ${c.location ?? ''} ${c.notes ?? ''}`.toLowerCase();
    return hay.includes(debouncedSearch);
  };

  // ---- actions ---------------------------------------------------------------

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };
  const openEdit = (camp: CampWithCount) => {
    setEditTarget(camp);
    setFormOpen(true);
  };

  const openResidents = (camp: CampWithCount) => {
    setViewCampId(camp.id);
    setSubView('residents');
  };
  const backToList = () => {
    setSubView('list');
    setViewCampId(null);
  };

  /** Toggle active/inactive. Deactivating KEEPS residents — it only stops new
   *  assignments — so no confirmation is needed and it is instantly reversible. */
  const handleToggleActive = async (camp: CampWithCount) => {
    setTogglingId(camp.id);
    try {
      await dataApi.updateCamp(camp.id, {
        name: camp.name,
        location: camp.location,
        capacity: camp.capacity,
        notes: camp.notes,
        is_active: !camp.is_active,
      });
      if (camp.is_active) {
        toast.success('Camp deactivated', {
          description: `"${camp.name}" no longer accepts new residents — current residents keep their rooms.`,
        });
      } else {
        toast.success('Camp activated', {
          description: `"${camp.name}" can accept new residents again.`,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the camp');
    } finally {
      setTogglingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDialogBusy(true);
    try {
      await dataApi.deleteCamp(deleteTarget.id);
      toast.success('Camp deleted', {
        description: `"${deleteTarget.name}" was removed.${
          deleteTarget.employee_count > 0
            ? ` ${deleteTarget.employee_count} employee(s) were left without a camp — not deleted.`
            : ''
        }`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the camp');
    } finally {
      setDialogBusy(false);
    }
  };

  // ---- grid renderer (shared by both tabs) ----------------------------------
  const renderGrid = (list: CampWithCount[], tabValue: CampTab) => {
    if (loading) {
      return <SkeletonRows rows={6} />;
    }
    const filtered = list.filter(matchesSearch);
    if (filtered.length === 0) {
      const searching = debouncedSearch.length > 0;
      const noCampsAtAll = (camps ?? []).length === 0;
      return (
        <EmptyState
          icon={<Tent size={22} />}
          title={
            searching
              ? 'No matching camps'
              : tabValue === 'active'
                ? noCampsAtAll
                  ? 'No camps yet'
                  : 'No active camps'
                : 'No inactive camps'
          }
          description={
            searching
              ? 'Try a different search term — search covers camp name, location and notes.'
              : tabValue === 'active'
                ? noCampsAtAll
                  ? 'Create your first camp — the accommodation where your crews stay.'
                  : 'All camps are inactive. Reactivate one from the Inactive tab to accept residents again.'
                : 'Camps you deactivate will be moved here. Residents keep their rooms — a deactivated camp just stops accepting new ones.'
          }
          action={
            !searching && tabValue === 'active' ? (
              <Button onClick={openCreate} className="brand-gradient font-semibold text-white">
                <Plus size={16} /> New Camp
              </Button>
            ) : undefined
          }
        />
      );
    }
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence>
          {filtered.map((camp, i) => (
            <CampCard
              key={camp.id}
              camp={camp}
              index={i}
              busy={togglingId === camp.id}
              onToggle={handleToggleActive}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
              onViewResidents={openResidents}
            />
          ))}
        </AnimatePresence>
      </div>
    );
  };

  // ---- render ----------------------------------------------------------------
  return (
    <div className="mx-auto max-w-7xl">
      <AnimatePresence mode="wait">
        {showResidentsView && viewCamp ? (
          <motion.div
            key="camp-residents"
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 32 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <CampResidentsView
              camp={viewCamp}
              camps={camps ?? []}
              employees={employees}
              onBack={backToList}
            />
          </motion.div>
        ) : (
          <motion.div
            key="camp-list"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <div className="space-y-6">
              <PageHeader
                title="Camp Management"
                description="Accommodation where your crews stay"
                actions={
                  <Button
                    onClick={openCreate}
                    className="h-10 brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
                  >
                    <Plus size={16} /> New Camp
                  </Button>
                }
              />

              {/* ---- summary chips ---- */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
                <StatChip
                  icon={<Tent size={17} />}
                  label="Total Camps"
                  value={(camps ?? []).length}
                  tone="brand"
                  index={0}
                  loading={loading}
                />
                <StatChip
                  icon={<BedDouble size={17} />}
                  label="Active Camps"
                  value={activeCamps.length}
                  tone="emerald"
                  index={1}
                  loading={loading}
                />
                <StatChip
                  icon={<Users size={17} />}
                  label="Employees Housed"
                  value={housedCount}
                  tone="amber"
                  index={2}
                  loading={loading}
                />
              </div>

              {/* ---- tabs + search ---- */}
              <Tabs value={tab} onValueChange={(v) => setTab(v as CampTab)}>
                <div className="card-glow rounded-xl border bg-card">
                  <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
                    <TabsList className="h-11 w-full gap-1 sm:w-auto">
                      <TabsTrigger value="active" className="h-9 gap-2 px-4">
                        <Power size={15} className="text-emerald-500" />
                        Active
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-500">
                          {activeCamps.length}
                        </span>
                      </TabsTrigger>
                      <TabsTrigger value="inactive" className="h-9 gap-2 px-4">
                        <PowerOff size={15} className="text-zinc-400" />
                        Inactive
                        <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-400">
                          {inactiveCamps.length}
                        </span>
                      </TabsTrigger>
                    </TabsList>
                    <div className="relative w-full lg:max-w-xs">
                      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search camps by name, location or notes…"
                        aria-label="Search camps"
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
                    {renderGrid(activeCamps, 'active')}
                  </TabsContent>
                  <TabsContent value="inactive" className="mt-0 p-4">
                    {renderGrid(inactiveCamps, 'inactive')}
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- Create / Edit camp dialog ---- */}
      <CampFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editTarget} />

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
              <Trash2 className="size-5 text-rose-500" /> Delete Camp
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete{' '}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3">
            <p className="text-sm font-medium text-rose-600 dark:text-rose-400">
              {deleteTarget && deleteTarget.employee_count > 0
                ? `${deleteTarget.employee_count} employee${deleteTarget.employee_count === 1 ? '' : 's'} will be left without a camp — they are NOT deleted.`
                : 'No employees are housed here.'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Their camp assignment will simply be cleared. This action cannot be undone.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dialogBusy}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleConfirmDelete}
              disabled={dialogBusy}
              className="bg-rose-600 font-semibold text-white hover:bg-rose-600/90"
            >
              {dialogBusy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              Delete Camp
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary stat chip
// ---------------------------------------------------------------------------
function StatChip({
  icon, label, value, tone, index, loading,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: 'brand' | 'emerald' | 'amber';
  index: number;
  loading: boolean;
}) {
  const tones: Record<string, string> = {
    brand: 'bg-brand/10 text-brand',
    emerald: 'bg-emerald-500/10 text-emerald-500',
    amber: 'bg-amber-500/10 text-amber-500',
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3), duration: 0.35, ease: EASE }}
      className="card-glow flex items-center justify-between gap-3 rounded-xl border bg-card p-4"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-1.5 h-7 w-14" />
        ) : (
          <p className="mt-1 text-xl font-semibold tracking-tight">
            <AnimatedCounter value={value} />
          </p>
        )}
      </div>
      <div className={cn('shrink-0 rounded-lg p-2.5', tones[tone])}>{icon}</div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Camp card (grid tile)
// ---------------------------------------------------------------------------
function CampCard({
  camp, index, busy, onToggle, onEdit, onDelete, onViewResidents,
}: {
  camp: CampWithCount;
  index: number;
  busy: boolean;
  onToggle: (camp: CampWithCount) => void;
  onEdit: (camp: CampWithCount) => void;
  onDelete: (camp: CampWithCount) => void;
  onViewResidents: (camp: CampWithCount) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 8, transition: { duration: 0.18, ease: 'easeIn' } }}
      transition={{ delay: Math.min(index * 0.05, 0.5), duration: 0.35, ease: EASE }}
      whileHover={{ y: -4 }}
      className={cn(
        'card-glow group relative flex flex-col gap-4 rounded-xl border bg-card p-5',
        !camp.is_active && 'opacity-80',
      )}
    >
      {/* header: icon, name, per-card actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              camp.is_active ? 'bg-brand/10 text-brand' : 'bg-zinc-500/10 text-zinc-400',
            )}
          >
            <Tent size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold" title={camp.name}>
              {camp.name}
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Created {fmtDate(camp.created_at)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={() => onToggle(camp)}
            title={camp.is_active ? 'Deactivate camp' : 'Activate camp'}
            aria-label={camp.is_active ? `Deactivate camp ${camp.name}` : `Activate camp ${camp.name}`}
            className={cn(
              'size-8',
              camp.is_active
                ? 'text-amber-500 hover:bg-amber-500/10 hover:text-amber-500'
                : 'text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500',
            )}
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : camp.is_active ? (
              <PowerOff size={15} />
            ) : (
              <Power size={15} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(camp)}
            title="Edit camp"
            aria-label={`Edit camp ${camp.name}`}
            className="size-8 text-muted-foreground hover:bg-brand/10 hover:text-brand"
          >
            <Pencil size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(camp)}
            title="Delete camp"
            aria-label={`Delete camp ${camp.name}`}
            className="size-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </div>

      {/* location / capacity meta */}
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <MapPin size={12} className="shrink-0 text-muted-foreground/60" />
          {camp.location ?? <span className="text-muted-foreground/50">No location</span>}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <BedDouble size={12} className="shrink-0 text-muted-foreground/60" />
          {camp.capacity !== null
            ? `${camp.capacity} ${camp.capacity === 1 ? 'bed' : 'beds'}`
            : 'No limit'}
        </p>
      </div>

      {/* notes (truncated to 2 lines) */}
      {camp.notes && (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={camp.notes}>
          {camp.notes}
        </p>
      )}

      {/* counts + main action */}
      <div className="mt-auto space-y-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1 border-brand/25 bg-brand/10 text-brand">
            <Users size={11} />
            {camp.employee_count} {camp.employee_count === 1 ? 'resident' : 'residents'}
          </Badge>
          {!camp.is_active && (
            <Badge variant="secondary" className="border-zinc-500/25 bg-zinc-500/10 text-zinc-400">
              Inactive
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          className="h-9 w-full gap-2 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
          onClick={() => onViewResidents(camp)}
        >
          <Eye size={15} /> View Residents
        </Button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit camp dialog
// ---------------------------------------------------------------------------
function CampFormDialog({
  open, onOpenChange, editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: CampWithCount | null;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [capacity, setCapacity] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset the form every time the dialog opens
  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setLocation(editing?.location ?? '');
      setCapacity(editing?.capacity !== null && editing?.capacity !== undefined ? String(editing.capacity) : '');
      setNotes(editing?.notes ?? '');
      setBusy(false);
    }
  }, [open, editing]);

  const trimmedName = name.trim();
  const capInvalid = isCapacityInvalid(capacity);
  const cap = parseCapacity(capacity);

  const unchanged =
    !!editing &&
    trimmedName === editing.name &&
    location.trim() === (editing.location ?? '') &&
    capacity.trim() === (editing.capacity === null ? '' : String(editing.capacity)) &&
    notes.trim() === (editing.notes ?? '');

  const submit = async () => {
    if (!trimmedName || busy || unchanged || capInvalid) return;
    setBusy(true);
    try {
      if (editing) {
        await dataApi.updateCamp(editing.id, {
          name: trimmedName,
          location: nullify(location),
          capacity: cap,
          notes: nullify(notes),
          is_active: editing.is_active,
        });
        toast.success('Camp updated', {
          description: `Details for "${trimmedName}" were saved. Current residents are unaffected.`,
        });
      } else {
        const created = await dataApi.createCamp(
          trimmedName,
          nullify(location),
          cap,
          nullify(notes),
        );
        toast.success('Camp created', {
          description: `"${created.name}" has been added. You can now house employees in it.`,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the camp');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Camp' : 'Add New Camp'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update the details of "${editing.name}". Current residents are unaffected.`
              : 'Enter the details for the new accommodation camp.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="camp-name">
              Camp Name <span className="text-rose-500">*</span>
            </Label>
            <Input
              id="camp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Al Quoz Labour Camp"
              className="h-11"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="camp-location">Location</Label>
              <Input
                id="camp-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Dubai — Al Quoz 3"
                className="h-11"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="camp-capacity">Capacity (beds)</Label>
              <Input
                id="camp-capacity"
                type="number"
                min={0}
                step={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                placeholder="Optional"
                className="h-11"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
              />
              {capInvalid ? (
                <p className="text-xs text-rose-500">
                  Capacity must be a non-negative whole number.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Optional — leave empty for no limit.</p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="camp-notes">Notes</Label>
            <Textarea
              id="camp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth knowing about this camp…"
              className="min-h-[80px] resize-none"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!trimmedName || busy || unchanged || capInvalid}
            className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
            {editing ? 'Save Changes' : 'Add Camp'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move resident dialog (per-row + bulk). The selected destination is fully
// controlled by the parent so it resets cleanly between openings. Moving to
// another camp requires the new BLOCK and ROOM number where the employee stays.
// ---------------------------------------------------------------------------
function MoveResidentDialog({
  open, onOpenChange, title, description, destinations, allowNoCamp, busy,
  target, onTargetChange, onConfirm, showRoom, initialBlock = '', initialRoom = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  destinations: CampWithCount[];
  allowNoCamp: boolean;
  busy: boolean;
  target: string;
  onTargetChange: (value: string) => void;
  onConfirm: (campId: string | null, block: string, room: string) => void;
  /** bulk moves skip the block/room prompt (they're edited per-resident after) */
  showRoom: boolean;
  initialBlock?: string;
  initialRoom?: string;
}) {
  const selectId = useId();
  const [block, setBlock] = useState(initialBlock);
  const [room, setRoom] = useState(initialRoom);

  const blockInvalid = showRoom && target !== '__none__' && block.trim() === '';
  const roomInvalid = showRoom && target !== '__none__' && room.trim() === '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-brand" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor={selectId}>Destination camp</Label>
          <Select value={target} onValueChange={onTargetChange}>
            <SelectTrigger id={selectId} className="h-11 w-full">
              <SelectValue placeholder="Choose a destination…" />
            </SelectTrigger>
            <SelectContent>
              {allowNoCamp && (
                <SelectItem value="__none__" className="gap-2">
                  <UserMinus size={14} className="text-amber-500" />
                  No camp (unassigned)
                </SelectItem>
              )}
              {destinations.map((c) => (
                <SelectItem key={c.id} value={c.id} className="gap-2">
                  <Tent size={14} />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-1 shrink-0 text-xs text-muted-foreground">
                    · {c.employee_count} {c.employee_count === 1 ? 'resident' : 'residents'}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {destinations.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No other active camps available{allowNoCamp ? '' : ' — create or reactivate one first'}.
            </p>
          )}

          {showRoom && target && target !== '__none__' && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1.5">
                <Label htmlFor={`${selectId}-block`}>Block no. *</Label>
                <Input
                  id={`${selectId}-block`}
                  value={block}
                  onChange={(e) => setBlock(e.target.value)}
                  placeholder="e.g. B"
                  className="h-11"
                />
                {blockInvalid && <p className="text-xs text-rose-500">Block is required.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${selectId}-room`}>Room no. *</Label>
                <Input
                  id={`${selectId}-room`}
                  value={room}
                  onChange={(e) => setRoom(e.target.value)}
                  placeholder="e.g. 204"
                  className="h-11"
                />
                {roomInvalid && <p className="text-xs text-rose-500">Room is required.</p>}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(target === '__none__' ? null : target, block.trim(), room.trim())}
            disabled={!target || busy || blockInvalid || roomInvalid}
            className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowLeftRight size={16} />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Per-camp residents sub-view
// ---------------------------------------------------------------------------
function CampResidentsView({
  camp, camps, employees, onBack,
}: {
  camp: CampWithCount;
  camps: CampWithCount[];
  employees: EmployeeVM[] | null;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerValue, setPickerValue] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  // "assign into this camp" dialog (block + room are required)
  const [assignTarget, setAssignTarget] = useState<EmployeeVM | null>(null);
  const [assignBlock, setAssignBlock] = useState('');
  const [assignRoom, setAssignRoom] = useState('');
  const [assigning, setAssigning] = useState(false);

  // "edit block/room" dialog for an existing resident
  const [editRoomEmp, setEditRoomEmp] = useState<EmployeeVM | null>(null);
  const [editRoomBlock, setEditRoomBlock] = useState('');
  const [editRoomValue, setEditRoomValue] = useState('');
  const [savingRoom, setSavingRoom] = useState(false);

  const [moveEmp, setMoveEmp] = useState<EmployeeVM | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [moving, setMoving] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkTarget, setBulkTarget] = useState('');
  const [bulkMoving, setBulkMoving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ ids: string[]; label: string } | null>(null);
  const [removing, setRemoving] = useState(false);

  const loading = employees === null;

  const residents = useMemo(() => {
    const list = (employees ?? []).filter((e) => e.camp_id === camp.id && e.status !== 'deleted');
    return [...list].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [employees, camp.id]);

  // every non-deleted employee who is not already a resident here (pick one to
  // house here — instantly transferred out of any previous camp)
  const addable = useMemo(
    () => (employees ?? []).filter((e) => e.status !== 'deleted' && e.camp_id !== camp.id),
    [employees, camp.id],
  );

  // move destinations: other ACTIVE camps only (inactive camps don't accept new
  // residents — assignments to them are rejected by the data layer)
  const destinations = useMemo(
    () => camps.filter((c) => c.is_active && c.id !== camp.id),
    [camps, camp.id],
  );

  // occupancy
  const limit = camp.capacity !== null && camp.capacity > 0 ? camp.capacity : null;
  const usagePct = limit !== null ? Math.min(100, (residents.length / limit) * 100) : 0;
  const full = limit !== null && residents.length >= limit;
  const nearlyFull = limit !== null && !full && usagePct > 85;

  const allSelected = residents.length > 0 && residents.every((e) => selected.has(e.id));
  const someSelected = !allSelected && residents.some((e) => selected.has(e.id));

  const openMove = (emp: EmployeeVM) => {
    setMoveTarget('');
    setMoveEmp(emp);
  };
  const openBulkMove = () => {
    setBulkTarget('');
    setBulkMoveOpen(true);
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(residents.map((e) => e.id)));
  };

  const deselect = (id: string) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // ---- add / transfer a resident into this camp (block & room required) --------
  const handlePickEmployee = (id: string | null) => {
    setPickerValue(null);
    if (!id || !camp.is_active) return;
    const emp = (employees ?? []).find((e) => e.id === id);
    if (!emp) return;
    setAddingId(id);
    setAssignBlock('');
    setAssignRoom('');
    setAssignTarget(emp);
    setAddingId(null);
  };

  const handleConfirmAssign = async () => {
    if (!assignTarget || assigning) return;
    setAssigning(true);
    try {
      await dataApi.assignEmployeeCamp(assignTarget.id, camp.id, assignBlock, assignRoom);
      toast.success(`Moved to ${camp.name}`, {
        description: `${assignTarget.full_name} now stays at "${camp.name}" — Block ${assignBlock}, Room ${assignRoom}.`,
      });
      setAssignTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add the resident');
    } finally {
      setAssigning(false);
    }
  };

  // ---- update an existing resident's block / room ------------------------------
  const openEditRoom = (emp: EmployeeVM) => {
    setEditRoomBlock(emp.camp_block ?? '');
    setEditRoomValue(emp.camp_room ?? '');
    setEditRoomEmp(emp);
  };

  const handleSaveRoom = async () => {
    if (!editRoomEmp || savingRoom) return;
    setSavingRoom(true);
    try {
      await dataApi.assignEmployeeCamp(editRoomEmp.id, camp.id, editRoomBlock, editRoomValue);
      toast.success('Room updated', {
        description: `${editRoomEmp.full_name} — Block ${editRoomBlock || '—'}, Room ${editRoomValue || '—'} at "${camp.name}".`,
      });
      setEditRoomEmp(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the room');
    } finally {
      setSavingRoom(false);
    }
  };

  // ---- move one resident to another active camp (or no camp) ------------------
  const handleMove = async (emp: EmployeeVM, campId: string | null, block: string, room: string) => {
    if (moving) return;
    setMoving(true);
    try {
      await dataApi.assignEmployeeCamp(emp.id, campId, block, room);
      if (campId) {
        const dest = destinations.find((c) => c.id === campId);
        toast.success('Resident moved', {
          description: `${emp.full_name} was moved from "${camp.name}" to "${dest?.name ?? 'another camp'}" — Block ${block || '—'}, Room ${room || '—'}.`,
        });
      } else {
        toast.success('Resident moved out', {
          description: `${emp.full_name} was removed from "${camp.name}" and now has no camp.`,
        });
      }
      deselect(emp.id);
      setMoveEmp(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to move the resident');
    } finally {
      setMoving(false);
    }
  };

  // ---- bulk move selected residents to an active camp -------------------------
  const handleBulkMove = async (campId: string, block: string, room: string) => {
    if (!campId || selected.size === 0 || bulkMoving) return;
    const dest = destinations.find((c) => c.id === campId);
    setBulkMoving(true);
    try {
      await Promise.all([...selected].map((id) => dataApi.assignEmployeeCamp(id, campId, block, room)));
      toast.success(`${selected.size} resident${selected.size === 1 ? '' : 's'} moved`, {
        description: `They were moved from "${camp.name}" to "${dest?.name ?? 'another camp'}"${block ? ` — Block ${block}` : ''}${room ? `, Room ${room}` : ''}.`,
      });
      setSelected(new Set());
      setBulkMoveOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to move the resident(s)');
    } finally {
      setBulkMoving(false);
    }
  };

  // ---- remove resident(s) — set to "no camp", never delete --------------------
  const handleRemove = async () => {
    if (!removeTarget || removing) return;
    setRemoving(true);
    try {
      await Promise.all(removeTarget.ids.map((id) => dataApi.assignEmployeeCamp(id, null)));
      toast.success(`${removeTarget.ids.length} resident${removeTarget.ids.length === 1 ? '' : 's'} removed`, {
        description: `They were left without a camp — not deleted.`,
      });
      setSelected(new Set());
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove the resident(s)');
    } finally {
      setRemoving(false);
    }
  };

  const avatar = (emp: EmployeeVM, sizeClass: string, textClass: string) => (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 font-bold text-brand',
        sizeClass,
        textClass,
      )}
    >
      {emp.photo ? (
        <img src={emp.photo} alt={emp.full_name} className="size-full object-cover" />
      ) : (
        initials(emp.full_name)
      )}
    </span>
  );

  return (
    <div className="space-y-6">
      {/* ---- header: back, camp identity, occupancy ---- */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={onBack}
            aria-label="Back to camps"
            className="size-10 shrink-0"
          >
            <ArrowLeft size={17} />
          </Button>
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl p-2.5',
              camp.is_active ? 'bg-brand/10 text-brand' : 'bg-zinc-500/10 text-zinc-400',
            )}
          >
            <Tent size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{camp.name}</h1>
              <Badge variant="secondary" className="tabular-nums">
                {residents.length} {residents.length === 1 ? 'resident' : 'residents'}
              </Badge>
              {!camp.is_active && (
                <Badge variant="secondary" className="border-zinc-500/25 bg-zinc-500/10 text-zinc-400">
                  Inactive
                </Badge>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {camp.location ? `${camp.location} · ` : ''}Created {fmtDate(camp.created_at)}
            </p>
            {limit !== null ? (
              <div className="mt-2.5 w-full max-w-sm">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Occupancy</span>
                  <span
                    className={cn(
                      'font-medium tabular-nums',
                      full ? 'text-rose-500' : nearlyFull ? 'text-amber-500' : 'text-foreground',
                    )}
                  >
                    {residents.length} / {limit} beds{full ? ' · Full' : nearlyFull ? ' · Nearly full' : ''}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    className={cn('h-full rounded-full', full ? 'bg-rose-500' : nearlyFull ? 'bg-amber-500' : 'bg-brand')}
                    initial={{ width: 0 }}
                    animate={{ width: `${usagePct}%` }}
                    transition={{ duration: 0.7, ease: EASE }}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <BedDouble size={13} className="text-muted-foreground/60" /> No capacity limit
              </p>
            )}
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto lg:shrink-0">
          <div className="w-full sm:w-72">
            <EmployeeCombobox
              employees={addable}
              value={pickerValue}
              onChange={handlePickEmployee}
              disabled={loading || !!addingId || !camp.is_active}
              placeholder={camp.is_active ? 'Add resident to this camp…' : 'Camp is inactive'}
              emptyText="No employees available."
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Employees not yet in a camp, or transfer from another camp — you'll pick their block & room next.
            </p>
          </div>
          {selected.size > 0 && (
            <>
              <Button
                variant="outline"
                onClick={openBulkMove}
                className="gap-2 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
              >
                <ArrowLeftRight size={16} /> Move Selected ({selected.size})
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  setRemoveTarget({
                    ids: [...selected],
                    label: `${selected.size} selected resident${selected.size === 1 ? '' : 's'}`,
                  })
                }
                className="gap-2"
              >
                <UserMinus size={16} /> Remove Selected ({selected.size})
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ---- residents card ---- */}
      <div className="card-glow rounded-xl border bg-card">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <SectionTitle
            icon={<Users size={16} />}
            title="Residents"
            sub="Sorted alphabetically — one employee stays in at most one camp"
          />
        </div>

        {loading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : residents.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Users size={22} />}
              title="No one lives here yet"
              description={
                camp.is_active
                  ? 'Use the picker above to house employees in this camp — they can be transferred from another camp too.'
                  : 'This camp is inactive. Reactivate it to start accepting residents.'
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
                        aria-label="Select all residents"
                      />
                    </TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Resident</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">ID</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Position</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Block / Room</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Work Site</TableHead>
                    <TableHead className="px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground">Rating</TableHead>
                    <TableHead className="px-3 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {residents.map((emp, i) => (
                    <motion.tr
                      key={emp.id}
                      initial={{ opacity: 0, y: 8 }}
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
                          {avatar(emp, 'size-8', 'text-[11px]')}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{emp.full_name}</p>
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
                        {emp.camp_block || emp.camp_room ? (
                          <span className="inline-flex items-center gap-1.5 text-[13px]">
                            <BedDouble size={13} className="shrink-0 text-amber-500" aria-hidden />
                            <span className="font-medium">Block {emp.camp_block ?? '—'}</span>
                            <span className="text-muted-foreground">· Room {emp.camp_room ?? '—'}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">Not set</span>
                        )}
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <SiteBadge name={emp.site_name} />
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <RatingStars rating={emp.rating} />
                      </TableCell>
                      <TableCell className="px-3 py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditRoom(emp)}
                            title="Edit block / room"
                            aria-label={`Edit ${emp.full_name}'s block and room`}
                            className="size-8 text-muted-foreground hover:bg-amber-500/10 hover:text-amber-500"
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openMove(emp)}
                            title="Move resident"
                            aria-label={`Move ${emp.full_name} to another camp`}
                            className="size-8 text-muted-foreground hover:bg-brand/10 hover:text-brand"
                          >
                            <ArrowLeftRight size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setRemoveTarget({ ids: [emp.id], label: emp.full_name })}
                            title="Remove from camp"
                            aria-label={`Remove ${emp.full_name} from ${camp.name}`}
                            className="size-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
                          >
                            <UserMinus size={15} />
                          </Button>
                        </div>
                      </TableCell>
                    </motion.tr>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* ---- Mobile cards ---- */}
            <div className="space-y-3 p-4 md:hidden">
              {residents.map((emp, i) => (
                <motion.div
                  key={emp.id}
                  initial={{ opacity: 0, y: 8 }}
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
                    {avatar(emp, 'size-9', 'text-xs')}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{emp.full_name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {emp.employee_code}
                        {emp.nationality ? ` · ${emp.nationality}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-3">
                    <span className="text-xs text-muted-foreground">
                      {emp.position ?? 'No position'}
                    </span>
                    <SiteBadge name={emp.site_name} />
                    {(emp.camp_block || emp.camp_room) && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <BedDouble size={12} className="text-amber-500" aria-hidden />
                        Block {emp.camp_block ?? '—'} · Room {emp.camp_room ?? '—'}
                      </span>
                    )}
                    <RatingStars rating={emp.rating} />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1 gap-1.5 hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-500"
                      onClick={() => openEditRoom(emp)}
                    >
                      <Pencil size={13} /> Room
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1 gap-1.5 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                      onClick={() => openMove(emp)}
                    >
                      <ArrowLeftRight size={13} /> Move
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1 gap-1.5 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-500"
                      onClick={() => setRemoveTarget({ ids: [emp.id], label: emp.full_name })}
                    >
                      <UserMinus size={13} /> Remove
                    </Button>
                  </div>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ---- Assign into this camp (block + room required) ---- */}
      <Dialog open={!!assignTarget} onOpenChange={(o) => { if (!o) setAssignTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BedDouble className="size-5 text-amber-500" />
              Assign to {camp.name}
            </DialogTitle>
            <DialogDescription>
              {assignTarget
                ? `${assignTarget.full_name}${assignTarget.camp_name ? ` is transferred from "${assignTarget.camp_name}"` : ' joins this camp'} — mention the block and room number where they stay.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="assign-block">Block no. *</Label>
              <Input
                id="assign-block"
                value={assignBlock}
                onChange={(e) => setAssignBlock(e.target.value)}
                placeholder="e.g. B"
                className="h-11"
                onKeyDown={(e) => { if (e.key === 'Enter' && assignBlock.trim() && assignRoom.trim()) void handleConfirmAssign(); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="assign-room">Room no. *</Label>
              <Input
                id="assign-room"
                value={assignRoom}
                onChange={(e) => setAssignRoom(e.target.value)}
                placeholder="e.g. 204"
                className="h-11"
                onKeyDown={(e) => { if (e.key === 'Enter' && assignBlock.trim() && assignRoom.trim()) void handleConfirmAssign(); }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignTarget(null)} disabled={assigning}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleConfirmAssign()}
              disabled={!assignBlock.trim() || !assignRoom.trim() || assigning}
              className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
            >
              {assigning ? <Loader2 size={16} className="animate-spin" /> : <BedDouble size={16} />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Edit block / room of an existing resident ---- */}
      <Dialog open={!!editRoomEmp} onOpenChange={(o) => { if (!o) setEditRoomEmp(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="size-5 text-amber-500" />
              Edit Block / Room
            </DialogTitle>
            <DialogDescription>
              {editRoomEmp ? `Where does ${editRoomEmp.full_name} stay inside "${camp.name}"?` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-room-block">Block no. *</Label>
              <Input
                id="edit-room-block"
                value={editRoomBlock}
                onChange={(e) => setEditRoomBlock(e.target.value)}
                placeholder="e.g. B"
                className="h-11"
                onKeyDown={(e) => { if (e.key === 'Enter' && editRoomBlock.trim() && editRoomValue.trim()) void handleSaveRoom(); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-room-value">Room no. *</Label>
              <Input
                id="edit-room-value"
                value={editRoomValue}
                onChange={(e) => setEditRoomValue(e.target.value)}
                placeholder="e.g. 204"
                className="h-11"
                onKeyDown={(e) => { if (e.key === 'Enter' && editRoomBlock.trim() && editRoomValue.trim()) void handleSaveRoom(); }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRoomEmp(null)} disabled={savingRoom}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleSaveRoom()}
              disabled={!editRoomBlock.trim() || !editRoomValue.trim() || savingRoom}
              className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
            >
              {savingRoom ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Move single resident dialog (remounts per employee to reset the room inputs) ---- */}
      <MoveResidentDialog
        key={moveEmp ? `move-${moveEmp.id}` : 'move-closed'}
        open={!!moveEmp}
        onOpenChange={(o) => {
          if (!o) setMoveEmp(null);
        }}
        title="Move Resident"
        description={
          moveEmp
            ? `Move ${moveEmp.full_name} out of "${camp.name}". Transfers are instant — an employee stays in at most one camp.`
            : ''
        }
        destinations={destinations}
        allowNoCamp
        showRoom
        busy={moving}
        target={moveTarget}
        onTargetChange={setMoveTarget}
        onConfirm={(campId, block, room) => {
          if (moveEmp) void handleMove(moveEmp, campId, block, room);
        }}
      />

      {/* ---- Bulk move dialog (remounts on open so the room inputs reset) ---- */}
      <MoveResidentDialog
        key={bulkMoveOpen ? `bulk-${selected.size}` : 'bulk-closed'}
        open={bulkMoveOpen}
        onOpenChange={setBulkMoveOpen}
        title={`Move ${selected.size} ${selected.size === 1 ? 'Resident' : 'Residents'}`}
        description={`Move ${selected.size} selected resident${selected.size === 1 ? '' : 's'} from "${camp.name}" to another active camp — you can set each resident's block & room afterwards.`}
        destinations={destinations}
        allowNoCamp={false}
        showRoom={false}
        busy={bulkMoving}
        target={bulkTarget}
        onTargetChange={setBulkTarget}
        onConfirm={(campId, block, room) => {
          if (campId) void handleBulkMove(campId, block, room);
        }}
      />

      {/* ---- Remove resident(s) confirmation ---- */}
      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-amber-500" />
              Remove{' '}
              {removeTarget
                ? removeTarget.ids.length === 1
                  ? 'Resident'
                  : `${removeTarget.ids.length} Residents`
                : 'Residents'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Remove {removeTarget?.label} from{' '}
              <span className="font-medium text-foreground">{camp.name}</span>? They will be left
              without a camp and will <span className="font-medium">not</span> be deleted from the
              database.
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
