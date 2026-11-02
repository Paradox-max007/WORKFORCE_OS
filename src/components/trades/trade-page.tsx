'use client';

// ============================================================================
// PULSE Workforce OS — Trade Management
// ----------------------------------------------------------------------------
// Trades (Electrician, Plumber, …) with EFFECTIVE-DATED hourly rates per
// salary role (standard / team leader / supervisor) × experience tier
// (below-threshold / qualified).
//
//   • Editing a rate closes the previous period and starts a new one from the
//     effective date (default today, future allowed) — historical payroll is
//     never silently re-priced. Backdating is super-admin only.
//   • Inactive trades stay available for historical payroll but disappear from
//     new employee selection.
//   • A new trade can be activated only once all SIX rate cells are configured;
//     incomplete trades are saved as inactive drafts and never price salary.
// ============================================================================

import { motion } from 'framer-motion';
import {
  BadgeCheck, BadgeX, History, Loader2, Pencil, Plus, Power, PowerOff, Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, SectionTitle } from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { dataApi } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  EXPERIENCE_TIERS, SALARY_ROLES, type ExperienceTier, type SalaryRole,
  type Trade, type TradeRate, type TradeRateInput,
} from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const ROLE_LABEL: Record<SalaryRole, string> = {
  standard: 'Standard',
  team_leader: 'Team Leader',
  supervisor: 'Supervisor',
};
const TIER_LABEL: Record<ExperienceTier, string> = {
  below_threshold: 'Below threshold',
  qualified: 'Qualified',
  manual: 'Manual',
};

const rateKey = (role: SalaryRole, tier: ExperienceTier): string => `${role}:${tier}`;

const rateOf = (rates: TradeRate[], role: SalaryRole, tier: ExperienceTier): string => {
  const r = rates.find((x) => x.salary_role === role && x.experience_tier === tier);
  return r ? String(r.hourly_rate) : '';
};

const localTodayYMD = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type TradeWithRates = Trade & { current_rates: TradeRate[] };

// ---------------------------------------------------------------------------
// Rate cell editor (used by the create + edit dialogs)
// ---------------------------------------------------------------------------
function RateGrid({ values, onChange, disabled = false }: {
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Salary role</th>
            {EXPERIENCE_TIERS.map((t) => (
              <th key={t.value} className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t.label} (AED/h)
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SALARY_ROLES.map((role) => (
            <tr key={role.value} className="border-b last:border-0">
              <td className="px-3 py-2 font-medium">{role.label}</td>
              {EXPERIENCE_TIERS.map((tier) => (
                <td key={tier.value} className="px-3 py-2">
                  <Input
                    type="number"
                    min={0}
                    step="0.25"
                    inputMode="decimal"
                    disabled={disabled}
                    className="h-9 bg-card text-right font-mono"
                    placeholder="—"
                    value={values[rateKey(role.value, tier.value)] ?? ''}
                    onChange={(e) => onChange({ ...values, [rateKey(role.value, tier.value)]: e.target.value })}
                    aria-label={`${role.label} ${tier.label} rate`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create trade dialog
// ---------------------------------------------------------------------------
function CreateTradeDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rates, setRates] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const filledCells = useMemo(
    () => Object.values(rates).filter((v) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0).length,
    [rates],
  );
  const allSix = filledCells >= 6;

  const reset = (): void => {
    setName(''); setDescription(''); setRates({});
  };

  const submit = async (): Promise<void> => {
    if (!name.trim()) { toast.error('Trade name is required'); return; }
    if (!allSix) {
      toast.error('Configure all six rate cells before activating', {
        description: 'Or use "Save as inactive draft" to keep it out of salary calculation until the rates are ready.',
      });
      return;
    }
    setSaving(true);
    try {
      const payload: TradeRateInput[] = SALARY_ROLES.flatMap((role) =>
        EXPERIENCE_TIERS.map((tier) => ({
          salary_role: role.value,
          experience_tier: tier.value,
          hourly_rate: Number(rates[rateKey(role.value, tier.value)]),
        })));
      const trade = await dataApi.createTrade({
        name: name.trim(),
        description: description.trim() || null,
        is_active: true,
        rates: payload,
      });
      toast.success('Trade created', { description: `${trade.name} is ready for employee selection.` });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create trade');
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async (): Promise<void> => {
    if (!name.trim()) { toast.error('Trade name is required'); return; }
    setSaving(true);
    try {
      const payload: TradeRateInput[] = SALARY_ROLES.flatMap((role) =>
        EXPERIENCE_TIERS.flatMap((tier) => {
          const raw = (rates[rateKey(role.value, tier.value)] ?? '').trim();
          if (raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) return [];
          return [{ salary_role: role.value, experience_tier: tier.value, hourly_rate: Number(raw) }];
        }));
      await dataApi.createTrade({
        name: name.trim(),
        description: description.trim() || null,
        is_active: false,
        rates: payload,
      });
      toast.success('Inactive draft saved', { description: 'Complete the six rate cells and activate it when ready.' });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save draft');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add New Trade</DialogTitle>
          <DialogDescription>
            All six rate cells (3 salary roles × 2 experience tiers) must be configured before the
            trade becomes available for salary calculation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Trade Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Scaffolder" className="h-11" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes" className="h-11" />
            </div>
          </div>
          <RateGrid values={rates} onChange={setRates} />
          <p className={cn('text-xs', allSix ? 'text-emerald-500' : 'text-muted-foreground')}>
            {allSix
              ? 'All rate cells configured — the trade will be active.'
              : `${filledCells}/6 rate cells configured. Without all six the trade stays inactive and will not price salary.`}
          </p>
        </div>
        <DialogFooter className="flex-row gap-2">
          <Button variant="outline" onClick={saveDraft} disabled={saving || !name.trim()}>
            Save as inactive draft
          </Button>
          <Button onClick={submit} disabled={saving} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Plus size={15} className="mr-1" />}
            Create & Activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit rates dialog (effective-dated change)
// ---------------------------------------------------------------------------
function EditRatesDialog({ trade, open, onOpenChange, isSuperAdmin }: {
  trade: TradeWithRates | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isSuperAdmin: boolean;
}) {
  const [rates, setRates] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState(localTodayYMD());
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<TradeRate[] | null>(null);

  useEffect(() => {
    if (open && trade) {
      const initial: Record<string, string> = {};
      SALARY_ROLES.forEach((role) => EXPERIENCE_TIERS.forEach((tier) => {
        initial[rateKey(role.value, tier.value)] = rateOf(trade.current_rates, role.value, tier.value);
      }));
      setRates(initial);
      setEffectiveFrom(localTodayYMD());
      setHistory(null);
      dataApi.getTradeRateHistory(trade.id).then(setHistory).catch(() => setHistory([]));
    }
  }, [open, trade]);

  if (!trade) return null;

  const changed = SALARY_ROLES.flatMap((role) => EXPERIENCE_TIERS.flatMap((tier) => {
    const key = rateKey(role.value, tier.value);
    const current = rateOf(trade.current_rates, role.value, tier.value);
    const next = (rates[key] ?? '').trim();
    if (next === '' || !Number.isFinite(Number(next)) || Number(next) < 0) return [];
    if (current !== '' && Number(current) === Number(next)) return [];
    return [{ salary_role: role.value, experience_tier: tier.value, hourly_rate: Number(next) }];
  }));

  const submit = async (): Promise<void> => {
    if (changed.length === 0) {
      toast.info('No rate changes to save');
      onOpenChange(false);
      return;
    }
    if (!effectiveFrom) { toast.error('Pick an effective date'); return; }
    setSaving(true);
    try {
      await dataApi.saveTradeRates(trade.id, changed, effectiveFrom);
      toast.success('Rates updated', {
        description: `${changed.length} rate cell${changed.length > 1 ? 's' : ''} effective ${fmtDate(effectiveFrom)}. Finalized payroll stays as snapshotted.`,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save rates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{trade.name} — hourly rates</DialogTitle>
          <DialogDescription>
            A rate change closes the previous period and starts a new one from the effective date.
            Worked hours before that date keep their original rate.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[200px_1fr] sm:items-center">
            <div className="space-y-2">
              <Label>Effective from</Label>
              <Input
                type="date"
                value={effectiveFrom}
                min={isSuperAdmin ? undefined : localTodayYMD()}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="h-11 bg-card"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {isSuperAdmin
                ? 'Backdating is an audited super-admin action — earlier work is re-priced only in DRAFT payroll.'
                : 'Default is today. Future dates are allowed; backdating requires a super admin.'}
            </p>
          </div>
          <RateGrid values={rates} onChange={setRates} />
          {changed.length > 0 && (
            <p className="text-xs text-brand">
              {changed.length} cell{changed.length > 1 ? 's' : ''} will change effective {fmtDate(effectiveFrom)}.
            </p>
          )}
          {history && history.length > 6 && (
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-2.5">
              <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <History size={11} /> Rate history (older periods)
              </p>
              {history.slice(6).slice().reverse().map((h) => (
                <p key={h.id} className="font-mono text-[11px] text-muted-foreground">
                  {ROLE_LABEL[h.salary_role]} · {TIER_LABEL[h.experience_tier]} — AED {h.hourly_rate}/h
                  · {fmtDate(h.effective_from)} → {h.effective_to ? fmtDate(h.effective_to) : 'now'}
                </p>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || changed.length === 0} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : null}
            Save Rate Change{changed.length > 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit details dialog (name / description / active)
// ---------------------------------------------------------------------------
function EditTradeDialog({ trade, open, onOpenChange }: {
  trade: TradeWithRates | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && trade) {
      setName(trade.name);
      setDescription(trade.description ?? '');
      setActive(trade.is_active);
    }
  }, [open, trade]);

  if (!trade) return null;

  const submit = async (): Promise<void> => {
    if (!name.trim()) { toast.error('Trade name is required'); return; }
    setSaving(true);
    try {
      await dataApi.updateTrade(trade.id, {
        name: name.trim(),
        description: description.trim() || null,
        is_active: active,
      });
      toast.success('Trade updated');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update trade');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Trade</DialogTitle>
          <DialogDescription>
            Inactive trades stay on historical payroll records but disappear from new employee selection.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Trade Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-11" />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="h-11" />
          </div>
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              {active ? <Power size={14} className="text-emerald-500" /> : <PowerOff size={14} className="text-muted-foreground" />}
              {active ? 'Active — selectable for employees' : 'Inactive — hidden from new selection'}
            </div>
            <Switch checked={active} onCheckedChange={setActive} aria-label="Toggle trade active" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Trade card
// ---------------------------------------------------------------------------
function TradeCard({ trade, index, onEditRates, onEditDetails }: {
  trade: TradeWithRates;
  index: number;
  onEditRates: () => void;
  onEditDetails: () => void;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.4), ease: EASE }}
      className="card-glow rounded-xl border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 truncate text-base font-semibold">
            <Wrench size={15} className="shrink-0 text-brand" /> {trade.name}
          </h3>
          {trade.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{trade.description}</p>
          )}
        </div>
        {trade.is_active ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
            <BadgeCheck size={11} /> Active
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            <BadgeX size={11} /> Inactive
          </span>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Role / Tier</th>
              <th className="px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Below threshold</th>
              <th className="px-3 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Qualified</th>
            </tr>
          </thead>
          <tbody>
            {SALARY_ROLES.map((role) => (
              <tr key={role.value} className="border-b last:border-0">
                <td className="px-3 py-1.5 text-xs font-medium">{role.label}</td>
                {EXPERIENCE_TIERS.map((tier) => {
                  const r = trade.current_rates.find(
                    (x) => x.salary_role === role.value && x.experience_tier === tier.value,
                  );
                  return (
                    <td key={tier.value} className="px-3 py-1.5 text-right font-mono text-xs">
                      {r ? `AED ${r.hourly_rate}` : <span className="text-amber-500">no rate</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onEditRates}>
          <Pencil size={13} /> Edit Rates
        </Button>
        <Button variant="ghost" size="sm" onClick={onEditDetails}>Details</Button>
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function TradePage() {
  const realtimeVersion = useRealtimeVersion(['trades', 'trade_rate_history', 'payroll_period', 'payroll_employee']);
  const isSuperAdmin = useAuthStore((s) => s.user?.role) === 'super_admin';

  const [trades, setTrades] = useState<TradeWithRates[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [ratesTarget, setRatesTarget] = useState<TradeWithRates | null>(null);
  const [editTarget, setEditTarget] = useState<TradeWithRates | null>(null);

  useEffect(() => {
    let cancelled = false;
    dataApi.listTrades()
      .then((rows) => { if (!cancelled) setTrades(rows); })
      .catch((err) => {
        if (!cancelled) {
          setTrades([]);
          toast.error(err instanceof Error ? err.message : 'Failed to load trades');
        }
      });
    return () => { cancelled = true; };
  }, [realtimeVersion]);

  const visible = useMemo(
    () => (trades ?? []).filter((t) => t.is_active || showInactive),
    [trades, showInactive],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SectionTitle
        icon={<Wrench size={16} />}
        title="Trade Management"
        sub="Trades & effective-dated hourly rates — 3 salary roles × 2 experience tiers each"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} aria-label="Show inactive trades" />
          Show inactive trades
        </label>
        <Button onClick={() => setCreateOpen(true)} className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]">
          <Plus size={16} className="mr-1.5" /> Add Trade
        </Button>
      </div>

      {trades === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Wrench size={22} />}
          title={showInactive ? 'No trades yet' : 'No active trades'}
          description="Create a trade with its six rate cells to start pricing salary."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {visible.map((t, i) => (
            <TradeCard
              key={t.id}
              trade={t}
              index={i}
              onEditRates={() => setRatesTarget(t)}
              onEditDetails={() => setEditTarget(t)}
            />
          ))}
        </div>
      )}

      <CreateTradeDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditRatesDialog
        trade={ratesTarget}
        open={ratesTarget !== null}
        onOpenChange={(v) => { if (!v) setRatesTarget(null); }}
        isSuperAdmin={isSuperAdmin}
      />
      <EditTradeDialog
        trade={editTarget}
        open={editTarget !== null}
        onOpenChange={(v) => { if (!v) setEditTarget(null); }}
      />
    </div>
  );
}
