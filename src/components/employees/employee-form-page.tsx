'use client';

// ============================================================================
// PULSE Workforce OS — Dedicated Add / Edit Employee page
// ----------------------------------------------------------------------------
// Replaces the old cramped modal:
//  • full-width sectioned layout (no clustered/overlaid camp fields)
//  • manual Employee ID — leave blank to auto-generate, type one to use it
//  • Team Leader toggle that can be switched ON and OFF again
//  • Back button returns to where you came from (list or details page)
//  • creating an employee navigates to the Employee Management page
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowLeft, Building2, Clock, Crown, HeartPulse, IdCard,
  ImagePlus, Loader2, Plus, Save, Tent, UserRound, Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { NationalitySelect } from '@/components/shared/nationality-select';
import { PhoneInput } from '@/components/shared/phone-input';
import { RatingStars } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  EXPERIENCE_TIERS, SALARY_ROLES, type CampWithCount, type Company,
  type DocumentStatus, type EmployeeInput, type EmployeeVM, type ExperienceTier,
  type SalaryRole, type SiteWithCount, type Trade, type TradeRateInput,
} from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';

const EMPTY_FORM: EmployeeInput = {
  full_name: '', employee_code: null, nationality: null, date_of_birth: null,
  phone: null, email: null, address: null, emergency_contact: null,
  position: null, join_date: null, company_name: null,
  passport_number: null, passport_status: null, id_number: null, id_status: null,
  current_site_id: null, camp_id: null, camp_block: null, camp_room: null,
  photo: null, is_team_leader: false, team_leader_site_id: null,
  trade_id: null, salary_role: 'standard',
};

const DOC_STATUSES: { value: DocumentStatus; label: string; cls: string }[] = [
  { value: 'Valid', label: 'Valid', cls: 'text-emerald-500' },
  { value: 'Expired', label: 'Expired', cls: 'text-rose-500' },
  { value: 'N/A', label: 'N/A', cls: 'text-zinc-400' },
];

const nullify = (v: string | null | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null);

// ---------------------------------------------------------------------------
// Inline trade creation dialog (spec §7): create a trade WITH its six rate
// cells without leaving the employee form — the new trade is selected
// automatically on save.
// ---------------------------------------------------------------------------
function NewTradeDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (trade: Trade) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rates, setRates] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const cellKey = (role: SalaryRole, tier: ExperienceTier): string => `${role}:${tier}`;
  const filled = Object.values(rates).filter((v) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0).length;
  const allSix = filled >= 6;

  const submit = async (): Promise<void> => {
    if (!name.trim()) { toast.error('Trade name is required'); return; }
    if (!allSix) {
      toast.error('Configure all six rate cells', {
        description: '3 salary roles × 2 experience tiers — a trade without rates cannot price salary.',
      });
      return;
    }
    setSaving(true);
    try {
      const payload: TradeRateInput[] = SALARY_ROLES.flatMap((role) =>
        EXPERIENCE_TIERS.map((tier) => ({
          salary_role: role.value,
          experience_tier: tier.value,
          hourly_rate: Number(rates[cellKey(role.value, tier.value)]),
        })));
      const trade = await dataApi.createTrade({
        name: name.trim(), description: description.trim() || null, is_active: true, rates: payload,
      });
      toast.success('Trade created & selected', { description: trade.name });
      setName(''); setDescription(''); setRates({});
      onOpenChange(false);
      onCreated(trade);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create trade');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wrench size={16} className="text-brand" /> Add New Trade</DialogTitle>
          <DialogDescription>
            All six rate cells (3 salary roles × 2 experience tiers) must be configured — the new
            trade is selected automatically once saved.
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
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className="h-11" />
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Role / Tier</th>
                  {EXPERIENCE_TIERS.map((t) => (
                    <th key={t.value} className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SALARY_ROLES.map((role) => (
                  <tr key={role.value} className="border-b last:border-0">
                    <td className="px-3 py-2 text-xs font-medium">{role.label}</td>
                    {EXPERIENCE_TIERS.map((tier) => (
                      <td key={tier.value} className="px-3 py-2">
                        <Input
                          type="number" min={0} step="0.25" inputMode="decimal"
                          className="h-9 bg-card text-right font-mono" placeholder="AED/h"
                          value={rates[cellKey(role.value, tier.value)] ?? ''}
                          onChange={(e) => setRates({ ...rates, [cellKey(role.value, tier.value)]: e.target.value })}
                          aria-label={`${role.label} ${tier.label} rate`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={cn('text-xs', allSix ? 'text-emerald-500' : 'text-muted-foreground')}>
            {allSix ? 'All rate cells configured.' : `${filled}/6 rate cells configured.`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Plus size={15} className="mr-1" />}
            Save & Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// client-side photo compression (max 300px, JPEG 0.8) — same as before
function compressPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const scale = Math.min(1, 300 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas unavailable'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => reject(new Error('Invalid image'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** One titled card section of the form. */
function FormSection({ icon, title, hint, children, className }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={cn('card-glow rounded-2xl border bg-card p-5 md:p-6', className)}
    >
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
        </div>
      </div>
      {children}
    </motion.section>
  );
}

export function EmployeeFormPage() {
  const mode = useAppStore((s) => s.employeeFormMode);
  const employeeId = useAppStore((s) => s.employeeFormId);
  const returnTo = useAppStore((s) => s.employeeFormReturnTo);
  const navigateToEmployees = useAppStore((s) => s.navigateToEmployees);
  const navigateToEmployeeDetails = useAppStore((s) => s.navigateToEmployeeDetails);
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';

  const isEdit = mode === 'edit' && !!employeeId;

  const [form, setForm] = useState<EmployeeInput>(EMPTY_FORM);
  const [existingCode, setExistingCode] = useState<string | null>(null);
  // historical opening balance as raw text ('' = blank) — parsed at submit so
  // half-typed decimals never break the form state
  const [openingHours, setOpeningHours] = useState('');
  // trades for the dropdown + inline creation dialog
  const [trades, setTrades] = useState<(Trade & { current_rates: unknown[] })[]>([]);
  const [tradeDialogOpen, setTradeDialogOpen] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [allEmployees, setAllEmployees] = useState<EmployeeVM[]>([]);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [camps, setCamps] = useState<CampWithCount[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [newSiteName, setNewSiteName] = useState<string | null>(null);
  const [addingSite, setAddingSite] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState<string | null>(null);
  const [addingCompany, setAddingCompany] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- load reference data (+ the employee being edited) ----------------------
  // Runs ONCE per mount: re-fetching on realtime changes would wipe the user's
  // in-progress form. The page remounts on every visit (view key changes), so
  // data is always fresh when the form opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [emps, sts, cps, trs, cmps] = await Promise.all([
          dataApi.listEmployees(),
          dataApi.listSites(),
          dataApi.listCamps(),
          dataApi.listTrades().catch(() => []),
          dataApi.listCompanies().catch(() => [] as Company[]),
        ]);
        if (cancelled) return;
        setAllEmployees(emps);
        setSites(sts);
        setCamps(cps);
        setTrades(trs);
        setCompanies(cmps);
        if (isEdit && employeeId) {
          const emp = emps.find((e) => e.id === employeeId);
          if (!emp) {
            toast.error('Employee not found');
            navigateToEmployees();
            return;
          }
          setExistingCode(emp.employee_code);
          setOpeningHours(emp.opening_hours ? String(emp.opening_hours) : '');
          setForm({
            full_name: emp.full_name,
            employee_code: null,
            nationality: emp.nationality,
            date_of_birth: emp.date_of_birth,
            phone: emp.phone,
            email: emp.email,
            address: emp.address,
            emergency_contact: emp.emergency_contact,
            position: emp.position,
            join_date: emp.join_date,
            company_name: emp.company_name,
            passport_number: emp.passport_number,
            passport_status: emp.passport_status,
            id_number: emp.id_number,
            id_status: emp.id_status,
            current_site_id: emp.current_site_id,
            camp_id: emp.camp_id,
            camp_block: emp.camp_block,
            camp_room: emp.camp_room,
            photo: emp.photo,
            is_team_leader: emp.is_team_leader,
            team_leader_site_id: emp.team_leader_site_id,
            trade_id: emp.trade_id ?? null,
            salary_role: emp.salary_role ?? 'standard',
          });
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const activeSites = useMemo(() => (sites ?? []).filter((s) => s.is_active), [sites]);
  const activeCamps = useMemo(() => (camps ?? []).filter((c) => c.is_active), [camps]);
  const activeTrades = useMemo(() => trades.filter((t) => t.is_active), [trades]);

  // ---- navigation ---------------------------------------------------------------
  const goBack = () => {
    if (returnTo === 'employee_details' && employeeId) navigateToEmployeeDetails(employeeId);
    else navigateToEmployees();
  };

  // ---- inline new site ------------------------------------------------------------
  const pickSite = (v: string) => {
    if (v === '__add_new') {
      setNewSiteName('');
      return;
    }
    setNewSiteName(null);
    setForm((f) => ({ ...f, current_site_id: v === 'none' ? null : v }));
  };

  // ---- inline new company (companies live in their own table) ----------------
  const pickCompany = (v: string) => {
    if (v === '__add_new') {
      setNewCompanyName('');
      return;
    }
    setNewCompanyName(null);
    setForm((f) => ({ ...f, company_name: v === 'none' ? null : v }));
  };

  const addCompanyInline = async () => {
    if (!newCompanyName?.trim()) return;
    setAddingCompany(true);
    try {
      const company = await dataApi.createCompany(newCompanyName.trim());
      toast.success('Company created', { description: company.name });
      setCompanies((prev) => [...prev, company]);
      setForm((f) => ({ ...f, company_name: company.name }));
      setNewCompanyName(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create company');
    } finally {
      setAddingCompany(false);
    }
  };

  const addSiteInline = async () => {
    if (!newSiteName?.trim()) return;
    setAddingSite(true);
    try {
      const site = await dataApi.createSite(newSiteName.trim(), null, null, null);
      toast.success('Site created', { description: site.name });
      setForm((f) => ({ ...f, current_site_id: site.id }));
      setNewSiteName(null);
      // refresh counts for the site select
      setSites(await dataApi.listSites());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create site');
    } finally {
      setAddingSite(false);
    }
  };

  // ---- photo ----------------------------------------------------------------------
  const handlePhoto = async (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error('Only JPEG, PNG or WebP images are allowed');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image is too large (max 10MB)');
      return;
    }
    try {
      const photo = await compressPhoto(file);
      setForm((f) => ({ ...f, photo }));
    } catch {
      toast.error('Failed to process image');
    }
  };

  // ---- submit ------------------------------------------------------------------------
  const submit = async () => {
    if (!form.full_name.trim()) {
      toast.error('Full name is required');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const manualCode = (form.employee_code ?? '').trim();
    if (manualCode) {
      const dup = allEmployees.find((e) => e.employee_code.toLowerCase() === manualCode.toLowerCase());
      if (dup) {
        toast.error(`Employee ID "${manualCode}" is already taken by ${dup.full_name}`, {
          description: 'Use another ID or leave it blank to auto-generate.',
        });
        return;
      }
    }
    if (form.is_team_leader && form.team_leader_site_id) {
      const conflict = allEmployees.find(
        (e) => e.is_team_leader && e.team_leader_site_id === form.team_leader_site_id
          && e.status !== 'deleted' && e.id !== employeeId,
      );
      if (conflict) {
        toast.error(`Another employee (${conflict.full_name}) is already the team leader of this site`);
        return;
      }
    }

    // historical opening balance — optional, decimal, never negative
    const openingText = openingHours.trim();
    let parsedOpening: number | null = null;
    if (openingText !== '') {
      parsedOpening = Number(openingText);
      if (!Number.isFinite(parsedOpening) || parsedOpening < 0) {
        toast.error('Previous working hours must be a number of 0 or more (decimals allowed, e.g. 2000 or 1860.5)');
        return;
      }
      if (parsedOpening > 9999999999.99) {
        toast.error('Previous working hours are unrealistically large');
        return;
      }
    } else if (isEdit && editingEmployee) {
      // blank on edit → keep the stored balance (type 0 to reset it to zero)
      parsedOpening = editingEmployee.opening_hours ?? 0;
    }

    setSaving(true);
    const payload: EmployeeInput = {
      ...form,
      opening_hours: parsedOpening,
      full_name: form.full_name.trim(),
      employee_code: isEdit ? undefined : (manualCode || null),
      nationality: nullify(form.nationality),
      phone: nullify(form.phone),
      email: nullify(form.email),
      address: nullify(form.address),
      emergency_contact: nullify(form.emergency_contact),
      position: nullify(form.position),
      company_name: nullify(form.company_name),
      passport_number: nullify(form.passport_number),
      id_number: nullify(form.id_number),
      camp_block: form.camp_id ? nullify(form.camp_block) : null,
      camp_room: form.camp_id ? nullify(form.camp_room) : null,
    };
    try {
      if (isEdit && employeeId) {
        const updated = await dataApi.updateEmployee(employeeId, payload);
        toast.success('Employee updated', { description: `${updated.full_name} saved.` });
        // back to where we came from (details page keeps context)
        if (returnTo === 'employee_details') navigateToEmployeeDetails(employeeId);
        else navigateToEmployees();
      } else {
        const created = await dataApi.createEmployee(payload);
        toast.success('Employee created', { description: `${created.full_name} — ID ${created.employee_code}` });
        // fresh employee → straight to the Employee Management page
        navigateToEmployees();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const editingEmployee = isEdit ? allEmployees.find((e) => e.id === employeeId) : null;

  // ------------------------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-6xl">
      {/* header + back */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={goBack} aria-label="Back">
            <ArrowLeft size={17} />
          </Button>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
              {isEdit ? 'Edit Employee' : 'Add New Employee'}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {isEdit
                ? `${existingCode ?? ''} — update any detail; the Employee ID stays fixed.`
                : 'Leave the Employee ID blank to auto-generate one, or type your own.'}
            </p>
          </motion.div>
        </div>
        <Button onClick={submit} disabled={saving || loading} className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]">
          {saving ? <Loader2 size={16} className="mr-1.5 animate-spin" /> : <Save size={16} className="mr-1.5" />}
          {isEdit ? 'Save Changes' : 'Create Employee'}
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          {/* ---------------- Identity ---------------- */}
          <FormSection icon={<UserRound size={16} />} title="Identity" hint="Name, Employee ID, nationality & photo">
            <div className="flex items-center gap-4">
              <span className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border bg-muted text-xs font-bold text-brand">
                {form.photo ? <img src={form.photo} alt="Preview" className="size-full object-cover" /> : initials(form.full_name || 'New') || <ImagePlus size={20} />}
              </span>
              <div className="space-y-2">
                <p className="text-sm font-medium">Photo</p>
                <p className="text-xs text-muted-foreground">JPEG/PNG/WebP up to 10MB. Auto-compressed to 300px.</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>Choose File</Button>
                  {form.photo && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, photo: null }))}>Remove</Button>
                  )}
                </div>
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => handlePhoto(e.target.files?.[0] ?? undefined)} />
              </div>
            </div>

            <div className="mt-4 grid gap-4">
              <div className="space-y-2">
                <Label>Full Name *</Label>
                <Input
                  value={form.full_name}
                  onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                  placeholder="e.g. Rajesh Kumar"
                  className="h-11"
                  autoFocus={!isEdit}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{isEdit ? 'Employee ID (fixed)' : 'Employee ID (optional)'}</Label>
                  {isEdit ? (
                    <Input value={existingCode ?? '—'} readOnly disabled className="h-11 font-mono" />
                  ) : (
                    <Input
                      value={form.employee_code ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))}
                      placeholder="Auto-generated if left blank"
                      className="h-11 font-mono"
                    />
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {isEdit
                      ? 'IDs are permanent once assigned.'
                      : 'Type a custom ID to use it (must be unique), or leave blank for auto-generation (PUL-YYYY-NNN).'}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Nationality</Label>
                  <NationalitySelect value={form.nationality} onChange={(v) => setForm((f) => ({ ...f, nationality: v }))} />
                </div>
              </div>
            </div>
          </FormSection>

          {/* ---------------- Personal ---------------- */}
          <FormSection icon={<HeartPulse size={16} />} title="Personal & Contact" hint="Birth date, phones and home-country address">
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Date of Birth</Label>
                  <Input type="date" value={form.date_of_birth ?? ''} onChange={(e) => setForm((f) => ({ ...f, date_of_birth: e.target.value || null }))} className="h-11" />
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <PhoneInput
                    value={form.phone}
                    onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
                    placeholder="5xx xxx xxxx"
                  />
                  <p className="text-[11px] text-muted-foreground">Pick the country code, then type the local number (saved as +code number).</p>
                </div>
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input type="email" value={form.email ?? ''} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="h-11" />
                </div>
                <div className="space-y-2">
                  <Label>Emergency Contact</Label>
                  <Input value={form.emergency_contact ?? ''} onChange={(e) => setForm((f) => ({ ...f, emergency_contact: e.target.value }))} placeholder="+966 5xx xxx xxxx" className="h-11" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Home Country Address</Label>
                <Textarea
                  value={form.address ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  placeholder="Home country address as per passport / official documents (house, street, city, country)"
                  rows={2}
                />
                <p className="text-[11px] text-muted-foreground">As printed in the passport / official documents — not the accommodation address.</p>
              </div>
            </div>
          </FormSection>

          {/* ---------------- Work & Accommodation ---------------- */}
          <FormSection icon={<Building2 size={16} />} title="Work & Accommodation" hint="Trade, site, camp with block & room">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Trade</Label>
                <Select
                  value={form.trade_id ?? 'none'}
                  onValueChange={(v) => {
                    if (v === '__add_new') { setTradeDialogOpen(true); return; }
                    setForm((f) => ({ ...f, trade_id: v === 'none' ? null : v }));
                  }}
                >
                  <SelectTrigger className="h-11 bg-card" aria-label="Trade"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No trade assigned</SelectItem>
                    {activeTrades.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                    <SelectItem value="__add_new" className="text-brand">+ Add New Trade…</SelectItem>
                  </SelectContent>
                </Select>
                {mode === 'edit' && (
                  <p className="text-[11px] text-muted-foreground">
                    Changing the trade or salary role takes effect today — earlier work keeps its
                    original classification for accurate historical payroll.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Salary Role</Label>
                <Select
                  value={form.salary_role ?? 'standard'}
                  onValueChange={(v) => setForm((f) => ({ ...f, salary_role: v as SalaryRole }))}
                >
                  <SelectTrigger className="h-11 bg-card" aria-label="Salary role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SALARY_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Rate category inside the trade (Standard / Team Leader / Supervisor).
                </p>
              </div>
              <div className="space-y-2">
                <Label>Position as per Visa</Label>
                <Input value={form.position ?? ''} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="e.g. Electrician, Plumber" className="h-11" />
                <p className="text-[11px] text-muted-foreground">The job title printed on the employee&apos;s visa.</p>
              </div>
              <div className="space-y-2">
                <Label>Join Date</Label>
                <Input type="date" value={form.join_date ?? ''} onChange={(e) => setForm((f) => ({ ...f, join_date: e.target.value || null }))} className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>Company Name</Label>
                <Select value={form.company_name ?? 'none'} onValueChange={pickCompany}>
                  <SelectTrigger className="h-11 bg-card" aria-label="Company name"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No company</SelectItem>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                    ))}
                    {/* legacy company name not yet in the company table */}
                    {form.company_name && !companies.some((c) => c.name === form.company_name) && (
                      <SelectItem value={form.company_name}>{form.company_name}</SelectItem>
                    )}
                    <SelectItem value="__add_new" className="text-brand">+ Add New Company…</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Companies are managed in their own list — use “Add New” to create one on the fly.</p>
              </div>
              <div className="space-y-2">
                <Label>Current Working Site</Label>
                <Select value={form.current_site_id ?? 'none'} onValueChange={pickSite}>
                  <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No site assigned (Idle)</SelectItem>
                    {activeSites.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                    <SelectItem value="__add_new" className="text-brand">+ Add New Site…</SelectItem>
                  </SelectContent>
                </Select>
                {mode === 'edit' && (
                  <p className="text-[11px] text-muted-foreground">
                    Changing the site records a transfer effective today — the attendance sheet keeps the employee at the
                    bottom of the old site's crew (faded) with the new site shown across the moved days.
                  </p>
                )}
              </div>
              {newSiteName !== null && (
                <div className="flex items-end gap-2 sm:col-span-2">
                  <div className="flex-1 space-y-2">
                    <Label>New Site Name</Label>
                    <Input value={newSiteName} onChange={(e) => setNewSiteName(e.target.value)} placeholder="e.g. NPC – Umm Al Quwain" className="h-11" />
                  </div>
                  <Button type="button" onClick={addSiteInline} disabled={addingSite} className="brand-gradient text-white">
                    {addingSite ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Plus size={14} className="mr-1" />} Add
                  </Button>
                </div>
              )}
              {newCompanyName !== null && (
                <div className="flex items-end gap-2 sm:col-span-2">
                  <div className="flex-1 space-y-2">
                    <Label>New Company Name</Label>
                    <Input
                      value={newCompanyName}
                      onChange={(e) => setNewCompanyName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addCompanyInline(); } }}
                      placeholder="e.g. Arabian Shield Manpower"
                      className="h-11"
                    />
                  </div>
                  <Button type="button" onClick={() => { void addCompanyInline(); }} disabled={addingCompany} className="brand-gradient text-white">
                    {addingCompany ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Plus size={14} className="mr-1" />} Add
                  </Button>
                </div>
              )}
            </div>

            {/* camp on its own full-width row; block + room share the row
                below — nothing can crowd or overlap at any breakpoint */}
            <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
              <Label className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <Tent size={13} /> Accommodation Camp
              </Label>
              <div className="mt-2 space-y-3">
                <Select
                  value={form.camp_id ?? 'none'}
                  onValueChange={(v) => {
                    setForm((f) => ({
                      ...f,
                      camp_id: v === 'none' ? null : v,
                      // switching camp clears stale room details
                      ...(v === 'none' && { camp_block: null, camp_room: null }),
                    }));
                  }}
                >
                  <SelectTrigger className="h-11 w-full bg-card" aria-label="Accommodation camp"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No camp assigned</SelectItem>
                    {activeCamps.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{c.employee_count != null ? ` (${c.employee_count})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    value={form.camp_block ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, camp_block: e.target.value }))}
                    disabled={!form.camp_id}
                    placeholder={form.camp_id ? 'Block no. (e.g. B)' : 'Block — pick a camp first'}
                    className="h-11 disabled:opacity-50"
                    aria-label="Camp block number"
                  />
                  <Input
                    value={form.camp_room ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, camp_room: e.target.value }))}
                    disabled={!form.camp_id}
                    placeholder={form.camp_id ? 'Room no. (e.g. 204)' : 'Room — pick a camp first'}
                    className="h-11 disabled:opacity-50"
                    aria-label="Camp room number"
                  />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Where the employee stays — camp, block and room number. One employee belongs to exactly one camp; change it anytime here or from the Camps page.
              </p>
            </div>

            {/* team leader — toggle ON and OFF freely */}
            <div className="mt-4 rounded-xl border border-border/60 bg-muted/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Crown size={14} className="fill-amber-400 text-amber-400" /> Team Leader
                  </p>
                  <p className="text-xs text-muted-foreground">Only one leader per site — toggle on or off anytime.</p>
                </div>
                <Switch
                  checked={!!form.is_team_leader}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, is_team_leader: v, ...(v ? {} : { team_leader_site_id: null }) }))}
                  aria-label="Team leader"
                />
              </div>
              {form.is_team_leader && (
                <div className="mt-3 space-y-2">
                  <Label>Lead Site</Label>
                  <Select
                    value={form.team_leader_site_id ?? 'none'}
                    onValueChange={(v) => setForm((f) => ({ ...f, team_leader_site_id: v === 'none' ? null : v }))}
                  >
                    <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No specific site</SelectItem>
                      {activeSites.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </FormSection>

          {/* ---------------- Historical Working Hours ---------------- */}
          <FormSection
            icon={<Clock size={16} />}
            title="Historical Working Hours"
            hint="For employees who worked before PULSE started tracking attendance"
          >
            <div className="space-y-2">
              <Label htmlFor="opening-hours">
                Previous Total Working Hours <span className="text-muted-foreground/60">(opening balance)</span>
              </Label>
              <div className="relative">
                <Input
                  id="opening-hours"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={openingHours}
                  onChange={(e) => setOpeningHours(e.target.value)}
                  disabled={isEdit && !isSuperAdmin}
                  placeholder="Enter previous hours, e.g. 2000"
                  className="h-11 pr-12"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  hrs
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Optional — leave blank for new employees. Added to attendance-recorded hours for the
                lifetime total on the Working Hours page; it is never spread across months or sites.
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-brand/15 bg-brand/5 px-3 py-2 text-[11px] text-muted-foreground">
                <Clock size={12} className="shrink-0 text-brand" />
                <span>
                  Lifetime hours = opening balance + attendance-recorded hours.
                  {isEdit && !isSuperAdmin && ' Only super admins can adjust this balance.'}
                  {isEdit && isSuperAdmin && ' Blank keeps the current balance; type 0 to reset it.'}
                </span>
              </div>
            </div>
          </FormSection>

          {/* ---------------- Documents ---------------- */}
          <FormSection icon={<IdCard size={16} />} title="Documents" hint="Passport & ID numbers with validity">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Passport Number</Label>
                <Input value={form.passport_number ?? ''} onChange={(e) => setForm((f) => ({ ...f, passport_number: e.target.value }))} placeholder="P1234567" className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>Passport Status</Label>
                <Select value={form.passport_status ?? 'none'} onValueChange={(v) => setForm((f) => ({ ...f, passport_status: v === 'none' ? null : v as DocumentStatus }))}>
                  <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {DOC_STATUSES.map((d) => (
                      <SelectItem key={d.value} value={d.value} className={d.cls}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>ID Number</Label>
                <Input value={form.id_number ?? ''} onChange={(e) => setForm((f) => ({ ...f, id_number: e.target.value }))} placeholder="UAE-IQ-20260001" className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>ID Status</Label>
                <Select value={form.id_status ?? 'none'} onValueChange={(v) => setForm((f) => ({ ...f, id_status: v === 'none' ? null : v as DocumentStatus }))}>
                  <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {DOC_STATUSES.map((d) => (
                      <SelectItem key={d.value} value={d.value} className={d.cls}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isEdit && editingEmployee && (
                <div className="space-y-2 sm:col-span-2">
                  <Label>Performance Rating</Label>
                  <div className="flex h-11 items-center gap-2 rounded-xl border bg-muted/40 px-3">
                    <RatingStars rating={editingEmployee.rating} />
                    <span className="text-xs text-muted-foreground">Auto-calculated from attendance</span>
                  </div>
                </div>
              )}
            </div>
          </FormSection>
        </div>
      )}

      {/* sticky bottom save bar (mobile friendly) */}
      <div className="sticky bottom-0 z-10 mt-6 -mx-1 flex items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
        <p className="hidden text-xs text-muted-foreground sm:block">
          {isEdit ? 'Update any detail — the Employee ID stays fixed.' : 'Only the full name is required; everything else is optional.'}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={goBack} disabled={saving}>Back</Button>
          <Button onClick={submit} disabled={saving || loading} className="brand-gradient font-semibold text-white">
            {saving ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : <Save size={15} className="mr-1.5" />}
            {isEdit ? 'Save Changes' : 'Create Employee'}
          </Button>
        </div>
      </div>

      {/* inline new-trade creation (spec §7) */}
      <NewTradeDialog
        open={tradeDialogOpen}
        onOpenChange={setTradeDialogOpen}
        onCreated={(trade) => {
          setTrades((prev) => [...prev, trade as Trade & { current_rates: unknown[] }]);
          setForm((f) => ({ ...f, trade_id: trade.id }));
        }}
      />
    </div>
  );
}
