'use client';

// ============================================================================
// PULSE Workforce OS — Uniform Registry → per-employee details view
// ----------------------------------------------------------------------------
// Full-page drill-down for one employee: month-grouped entries with inline
// add / edit / renew / delete. Also exports the tiny shared building blocks
// (badges + helpers) that the registry list view reuses.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, Check, Loader2, Pencil, Plus, RefreshCw, Shield, Shirt, Trash2, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, SectionTitle, SkeletonRows } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import { daysUntil, fmtDate, initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useRealtimeVersion } from '@/store/realtime';
import { UNIFORM_ITEMS, type EmployeeVM, type UniformEntry } from '@/lib/types';

// ---------------------------------------------------------------------------
// Shared helpers (also used by uniform-registry-page.tsx)
// ---------------------------------------------------------------------------
export const todayYMD = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong';

/** Build a full UNIFORM_ITEMS-shaped record from a sparse checkbox state. */
export const buildItemsRecord = (items: Record<string, boolean>): Record<string, boolean> =>
  Object.fromEntries(UNIFORM_ITEMS.map((i) => [i.key, items[i.key] === true]));

/** "Expiry" live-preview helper: created date + 6 months, formatted 'd MMM yyyy'. */
export const formatExpiryPreview = (createdYMD: string): string | null => {
  if (!createdYMD) return null;
  const d = new Date(createdYMD);
  if (Number.isNaN(d.getTime())) return null;
  const expiry = new Date(d);
  expiry.setMonth(expiry.getMonth() + 6);
  if (Number.isNaN(expiry.getTime())) return null;
  return format(expiry, 'd MMM yyyy');
};

const isoToYMD = (iso: string): string => iso.slice(0, 10);

// ---------------------------------------------------------------------------
// Shared badges
// ---------------------------------------------------------------------------
export function UniformItemBadges({ items }: { items: Record<string, boolean> }) {
  const given = UNIFORM_ITEMS.filter((i) => items[i.key] === true);
  if (given.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  // Clean single-row display — items sit side by side instead of stacking up
  return (
    <span className="flex max-w-[320px] items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {given.map((i) => (
        <span
          key={i.key}
          title={i.label}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[11px] text-brand"
        >
          <span aria-hidden>{i.emoji}</span>
          {i.label}
        </span>
      ))}
    </span>
  );
}

export function DocTypeBadge({ docType }: { docType: 'id' | 'passport' }) {
  return docType === 'passport' ? (
    <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
      Passport
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-slate-500/25 bg-slate-500/10 px-2 py-0.5 text-[11px] font-medium text-slate-400">
      ID Card
    </span>
  );
}

export function RenewalTag() {
  return (
    <span className="inline-flex items-center rounded-full border border-purple-500/25 bg-purple-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-purple-400">
      Renewal
    </span>
  );
}

/** Renewal status vs renewal_date: expired → emerald, ≤30 days → amber, else slate. */
export function RenewalBadge({ renewalDate }: { renewalDate: string }) {
  const days = daysUntil(renewalDate);
  if (days < 0) {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
        Renewal Available
      </span>
    );
  }
  if (days <= 30) {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
        {days} days remaining
      </span>
    );
  }
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-slate-500/25 bg-slate-500/10 px-2 py-0.5 text-[11px] font-medium text-slate-400">
      Active
    </span>
  );
}

// ---------------------------------------------------------------------------
// Details view types
// ---------------------------------------------------------------------------
const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface MonthGroup {
  key: string;
  label: string;
  entries: UniformEntry[];
  soon: boolean;
  expired: boolean;
}

interface AddFormState {
  document_type: 'id' | 'passport';
  document_number: string;
  created_at: string;
  site_name: string;
  team_leader_name: string;
  items: Record<string, boolean>;
}

interface EditDraft {
  token_number: string;
  document_type: 'id' | 'passport';
  document_number: string;
  site_name: string;
  team_leader_name: string;
  created_at: string;
  items: Record<string, boolean>;
}

export interface UniformEntryDetailsProps {
  employee: EmployeeVM;
  onBack: () => void;
  /** Auto-expand the inline Add form on mount. */
  autoOpenAdd?: boolean;
  /** Id of the entry whose renew dialog the parent currently has open. */
  renewEntryId?: string | null;
  /**
   * Fired when the user hits Renew on an expired row. The shared create/renew
   * dialog lives in the parent registry page, so the entry is passed back up
   * and this view then navigates back via onBack.
   */
  onRenewEntry?: (entry: UniformEntry) => void;
}

const tabTone = (g: MonthGroup): string => {
  if (g.soon) {
    return 'border-rose-500/30 text-rose-500 data-[state=active]:border-rose-500/40 data-[state=active]:bg-rose-500/15 data-[state=active]:text-rose-500';
  }
  if (g.expired) {
    return 'border-emerald-500/30 text-emerald-500 data-[state=active]:border-emerald-500/40 data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-500';
  }
  return 'border-transparent text-muted-foreground data-[state=active]:bg-slate-500/15 data-[state=active]:text-slate-400';
};

// ---------------------------------------------------------------------------
// UniformEntryDetails
// ---------------------------------------------------------------------------
export function UniformEntryDetails({
  employee,
  onBack,
  autoOpenAdd = false,
  renewEntryId = null,
  onRenewEntry,
}: UniformEntryDetailsProps) {
  const version = useRealtimeVersion(['uniform_registry', 'employee', 'site']);

  const [entries, setEntries] = useState<UniformEntry[] | null>(null);
  const [formOpen, setFormOpen] = useState<boolean>(autoOpenAdd);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [tab, setTab] = useState('');

  const initAddForm = (): AddFormState => ({
    document_type: employee.passport_number ? 'passport' : employee.id_number ? 'id' : 'passport',
    document_number: employee.passport_number ?? employee.id_number ?? '',
    created_at: todayYMD(),
    site_name: '',
    team_leader_name: '',
    items: {},
  });

  const [addForm, setAddForm] = useState<AddFormState>(initAddForm);

  const toggleForm = (next: boolean) => {
    setFormOpen(next);
    if (next) setAddForm(initAddForm());
  };

  // ---- data loading ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    dataApi.listEmployeeUniforms(employee.id)
      .then((rows) => { if (!cancelled) setEntries(rows); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [employee.id, version]);

  // ---- month groups -----------------------------------------------------------
  const groups = useMemo<MonthGroup[]>(() => {
    if (!entries) return [];
    const map = new Map<string, UniformEntry[]>();
    for (const e of entries) {
      const d = new Date(e.created_at);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, list]) => {
        const dayList = list.map((e) => daysUntil(e.renewal_date));
        return {
          key,
          label: `${MONTHS_SHORT[parseInt(key.slice(5), 10) - 1]} ${key.slice(0, 4)}`,
          entries: list,
          soon: dayList.some((dd) => dd >= 0 && dd <= 30),
          expired: dayList.some((dd) => dd < 0),
        };
      });
  }, [entries]);

  const activeKey = tab && groups.some((g) => g.key === tab) ? tab : groups[0]?.key ?? '';
  const activeGroup = groups.find((g) => g.key === activeKey) ?? null;
  const addExpiryPreview = formatExpiryPreview(addForm.created_at);
  const editExpiryPreview = draft ? formatExpiryPreview(draft.created_at) : null;

  // ---- mutations ---------------------------------------------------------------
  const patchAdd = (patch: Partial<AddFormState>) => setAddForm((prev) => ({ ...prev, ...patch }));
  const patchAddItem = (key: string, value: boolean) =>
    setAddForm((prev) => ({ ...prev, items: { ...prev.items, [key]: value } }));
  const patchDraft = (patch: Partial<EditDraft>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const patchDraftItem = (key: string, value: boolean) =>
    setDraft((prev) => (prev ? { ...prev, items: { ...prev.items, [key]: value } } : prev));

  const submitAdd = async () => {
    if (!addForm.document_number.trim()) {
      toast.error('Document number is required');
      return;
    }
    if (!UNIFORM_ITEMS.some((i) => addForm.items[i.key] === true)) {
      toast.error('Select at least one item given');
      return;
    }
    if (!addForm.created_at) {
      toast.error('Created date is required');
      return;
    }
    setSubmitting(true);
    try {
      await dataApi.createUniformEntry({
        employee_id: employee.id,
        document_type: addForm.document_type,
        document_number: addForm.document_number.trim(),
        items: buildItemsRecord(addForm.items),
        site_name: addForm.site_name.trim() || null,
        team_leader_name: addForm.team_leader_name.trim() || null,
        created_at: new Date(addForm.created_at).toISOString(),
        token_number: null, // assigned automatically
        is_renewal: false,
        previous_token_id: null,
      });
      toast.success('Uniform entry created');
      toggleForm(false);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (e: UniformEntry) => {
    setEditingId(e.id);
    setDraft({
      token_number: String(e.token_number),
      document_type: e.document_type,
      document_number: e.document_number,
      site_name: e.site_name ?? '',
      team_leader_name: e.team_leader_name ?? '',
      created_at: isoToYMD(e.created_at),
      items: { ...e.items },
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = async (entry: UniformEntry) => {
    if (!draft) return;
    const token = parseInt(draft.token_number, 10);
    if (!Number.isInteger(token) || token <= 0) {
      toast.error('Token number must be a positive whole number');
      return;
    }
    if (!draft.document_number.trim()) {
      toast.error('Document number is required');
      return;
    }
    if (!UNIFORM_ITEMS.some((i) => draft.items[i.key] === true)) {
      toast.error('Select at least one item given');
      return;
    }
    if (!draft.created_at) {
      toast.error('Created date is required');
      return;
    }
    setSubmitting(true);
    try {
      await dataApi.updateUniformEntry(entry.id, {
        token_number: token,
        document_type: draft.document_type,
        document_number: draft.document_number.trim(),
        items: buildItemsRecord(draft.items),
        site_name: draft.site_name.trim() || null,
        team_leader_name: draft.team_leader_name.trim() || null,
        created_at: new Date(draft.created_at).toISOString(),
      });
      toast.success('Entry updated');
      cancelEdit();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (entry: UniformEntry) => {
    try {
      await dataApi.deleteUniformEntry(entry.id);
      toast.success('Uniform entry deleted');
      if (editingId === entry.id) cancelEdit();
    } catch (err) {
      toast.error(errMessage(err));
    }
  };

  const triggerRenew = (entry: UniformEntry) => {
    onRenewEntry?.(entry);
    onBack();
  };

  // ---- render ------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={onBack}
            aria-label="Back to uniform registry"
            title="Back to uniform registry"
            className="mt-0.5 rounded-lg"
          >
            <ArrowLeft size={16} />
          </Button>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-start gap-3"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-sm font-bold text-brand">
              {initials(employee.full_name)}
            </span>
            <div>
              <h1 className="text-xl font-bold uppercase leading-tight tracking-tight md:text-2xl">
                {employee.full_name}
              </h1>
              <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Employee ID: {employee.employee_code} · {entries?.length ?? 0} entries total
              </p>
            </div>
          </motion.div>
        </div>
        <Button
          className="brand-gradient rounded-lg text-brand-foreground shadow-lg shadow-brand/20 hover:opacity-90"
          onClick={() => toggleForm(!formOpen)}
        >
          <Plus size={16} />
          Add Entry
        </Button>
      </div>

      {/* Inline Add form (expandable card) */}
      <AnimatePresence initial={false}>
        {formOpen && (
          <motion.div
            key="uniform-add-form"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="card-glow mb-6 rounded-xl border bg-card p-4 md:p-5">
              <SectionTitle
                icon={<Plus size={15} />}
                title="Add New Entry"
                sub={`Issue a new uniform record for ${employee.full_name} — token number is assigned automatically`}
              />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Employee</Label>
                  <div className="flex h-11 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-sm">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                      {initials(employee.full_name)}
                    </span>
                    <span className="truncate font-medium">{employee.full_name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                      {employee.employee_code}
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Document Type *</Label>
                  <Select
                    value={addForm.document_type}
                    onValueChange={(v) => patchAdd({ document_type: v as 'id' | 'passport' })}
                  >
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
                    value={addForm.document_number}
                    onChange={(e) => patchAdd({ document_number: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Created Date *</Label>
                  <Input
                    type="date"
                    className="h-11"
                    value={addForm.created_at}
                    onChange={(e) => patchAdd({ created_at: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Expiry:{' '}
                    <span className="font-medium text-foreground/80">{addExpiryPreview ?? '—'}</span>{' '}
                    (6 months)
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Site Name</Label>
                  <Input
                    className="h-11"
                    placeholder="Optional"
                    value={addForm.site_name}
                    onChange={(e) => patchAdd({ site_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Team Leader</Label>
                  <Input
                    className="h-11"
                    placeholder="Optional"
                    value={addForm.team_leader_name}
                    onChange={(e) => patchAdd({ team_leader_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Items Given *</Label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {UNIFORM_ITEMS.map((item) => (
                      <label
                        key={item.key}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent/50',
                          addForm.items[item.key] === true && 'border-brand/40 bg-brand/5',
                        )}
                      >
                        <Checkbox
                          checked={addForm.items[item.key] === true}
                          onCheckedChange={(c) => patchAddItem(item.key, c === true)}
                        />
                        <span aria-hidden>{item.emoji}</span>
                        {item.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" onClick={() => toggleForm(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  className="brand-gradient rounded-lg text-brand-foreground hover:opacity-90"
                  onClick={() => void submitAdd()}
                  disabled={submitting}
                >
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                  Add Entry
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content */}
      {entries === null ? (
        <SkeletonRows rows={6} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Shirt size={22} />}
          title="No uniform entries yet"
          description={`${employee.full_name} has no uniform records. Add the first issued uniform entry to start tracking its 6-month renewal.`}
          action={
            <Button
              className="brand-gradient rounded-lg text-brand-foreground hover:opacity-90"
              onClick={() => toggleForm(true)}
            >
              <Plus size={15} />
              Add Entry
            </Button>
          }
        />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="card-glow rounded-xl border bg-card p-4 md:p-5"
        >
          <Tabs value={activeKey} onValueChange={setTab}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <TabsList className="h-auto w-full flex-wrap justify-start gap-1 p-1">
                {groups.map((g) => (
                  <TabsTrigger
                    key={g.key}
                    value={g.key}
                    className={cn('h-7 rounded-md px-2.5 text-[11px] font-semibold tracking-wide', tabTone(g))}
                  >
                    {g.label}
                    <span className="ml-1 opacity-60">· {g.entries.length}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {/* Legend */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground lg:shrink-0 lg:pt-2">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-rose-500" /> Expiring within 30 days
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-emerald-500" /> Renewal available (past due)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-slate-400" /> Active
                </span>
              </div>
            </div>

            <TabsContent value={activeKey} className="mt-4">
              <Table>
                <TableHeader>
                  <tr className="border-b hover:bg-transparent">
                    <TableHead className="pl-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Token #</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Doc Type</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Doc Number</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Site Name</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Team Leader</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Items</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Created</TableHead>
                    <TableHead className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Expiry</TableHead>
                    <TableHead className="pr-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {(activeGroup?.entries ?? []).map((e, i) =>
                    editingId === e.id && draft ? (
                      <tr key={e.id} className="border-b border-border/40 bg-brand/[0.04]">
                        <TableCell className="pl-2">
                          <Input
                            type="number"
                            className="h-8 w-20 font-mono text-sm"
                            value={draft.token_number}
                            onChange={(ev) => patchDraft({ token_number: ev.target.value })}
                            aria-label="Token number"
                          />
                        </TableCell>
                        <TableCell>
                          <Select
                            value={draft.document_type}
                            onValueChange={(v) => patchDraft({ document_type: v as 'id' | 'passport' })}
                          >
                            <SelectTrigger className="h-8 w-28 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="id">ID Card</SelectItem>
                              <SelectItem value="passport">Passport</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 w-32 font-mono text-xs"
                            value={draft.document_number}
                            onChange={(ev) => patchDraft({ document_number: ev.target.value })}
                            aria-label="Document number"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 w-28 text-xs"
                            placeholder="—"
                            value={draft.site_name}
                            onChange={(ev) => patchDraft({ site_name: ev.target.value })}
                            aria-label="Site name"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 w-28 text-xs"
                            placeholder="—"
                            value={draft.team_leader_name}
                            onChange={(ev) => patchDraft({ team_leader_name: ev.target.value })}
                            aria-label="Team leader name"
                          />
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="grid max-w-[260px] grid-cols-2 gap-x-3 gap-y-1">
                            {UNIFORM_ITEMS.map((item) => (
                              <label key={item.key} className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                                <Checkbox
                                  checked={draft.items[item.key] === true}
                                  onCheckedChange={(c) => patchDraftItem(item.key, c === true)}
                                />
                                <span aria-hidden>{item.emoji}</span>
                                {item.label}
                              </label>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="date"
                            className="h-8 w-32 text-xs"
                            value={draft.created_at}
                            onChange={(ev) => patchDraft({ created_at: ev.target.value })}
                            aria-label="Created date"
                          />
                          <p className="mt-1 whitespace-nowrap text-[10px] text-muted-foreground">
                            Expiry: {editExpiryPreview ?? '—'}
                          </p>
                        </TableCell>
                        <TableCell>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {editExpiryPreview ?? '—'}
                          </span>
                        </TableCell>
                        <TableCell className="pr-2">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-8 text-emerald-500 hover:text-emerald-500"
                              onClick={() => void saveEdit(e)}
                              disabled={submitting}
                              title="Save changes"
                              aria-label="Save changes"
                            >
                              {submitting ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Check size={15} />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-8"
                              onClick={cancelEdit}
                              disabled={submitting}
                              title="Cancel editing"
                              aria-label="Cancel editing"
                            >
                              <X size={15} />
                            </Button>
                          </div>
                        </TableCell>
                      </tr>
                    ) : (
                      <motion.tr
                        key={e.id}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.045, 0.35), duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                        className={cn(
                          'border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40',
                          renewEntryId === e.id && 'bg-brand/5 ring-1 ring-brand/30',
                        )}
                      >
                        <TableCell className="pl-2">
                          <span className="font-mono text-sm font-semibold">#{e.token_number}</span>
                          {e.is_renewal && <span className="ml-1.5"><RenewalTag /></span>}
                        </TableCell>
                        <TableCell>
                          <DocTypeBadge docType={e.document_type} />
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs">{e.document_number}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs">{e.site_name ?? <span className="text-muted-foreground">—</span>}</span>
                        </TableCell>
                        <TableCell>
                          {e.team_leader_name ? (
                            <span className="inline-flex items-center gap-1 text-xs">
                              <Shield size={12} className="text-brand" />
                              {e.team_leader_name}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <UniformItemBadges items={e.items} />
                        </TableCell>
                        <TableCell>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {fmtDate(e.created_at)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const days = daysUntil(e.renewal_date);
                            return (
                              <span
                                className={cn(
                                  'whitespace-nowrap text-xs font-medium',
                                  days < 0 ? 'text-emerald-500' : days <= 30 ? 'text-rose-500' : 'text-muted-foreground',
                                )}
                              >
                                {fmtDate(e.renewal_date)}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="pr-2">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="size-8"
                              onClick={() => startEdit(e)}
                              title="Edit entry"
                              aria-label="Edit entry"
                            >
                              <Pencil size={14} />
                            </Button>
                            {daysUntil(e.renewal_date) < 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="size-8 text-purple-500 hover:text-purple-500"
                                onClick={() => triggerRenew(e)}
                                title="Renew entry"
                                aria-label="Renew entry"
                              >
                                <RefreshCw size={14} />
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
                                  <Trash2 size={14} />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete uniform entry?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Token #{e.token_number} ({fmtDate(e.created_at)}) will be permanently
                                    removed from the registry. This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-white hover:bg-destructive/90"
                                    onClick={() => void handleDelete(e)}
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </motion.tr>
                    ),
                  )}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        </motion.div>
      )}
    </div>
  );
}
