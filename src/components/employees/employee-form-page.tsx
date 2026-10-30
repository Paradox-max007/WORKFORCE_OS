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
  ArrowLeft, Building2, Crown, HeartPulse, IdCard,
  ImagePlus, Loader2, Plus, Save, Tent, UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { NationalitySelect } from '@/components/shared/nationality-select';
import { RatingStars } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CampWithCount, DocumentStatus, EmployeeInput, EmployeeVM, SiteWithCount } from '@/lib/types';
import { useAppStore } from '@/store/app-store';

const EMPTY_FORM: EmployeeInput = {
  full_name: '', employee_code: null, nationality: null, date_of_birth: null,
  phone: null, email: null, address: null, emergency_contact: null,
  position: null, join_date: null, company_name: null,
  passport_number: null, passport_status: null, id_number: null, id_status: null,
  current_site_id: null, camp_id: null, camp_block: null, camp_room: null,
  photo: null, is_team_leader: false, team_leader_site_id: null,
};

const DOC_STATUSES: { value: DocumentStatus; label: string; cls: string }[] = [
  { value: 'Valid', label: 'Valid', cls: 'text-emerald-500' },
  { value: 'Expired', label: 'Expired', cls: 'text-rose-500' },
  { value: 'N/A', label: 'N/A', cls: 'text-zinc-400' },
];

const nullify = (v: string | null | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null);

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

  const isEdit = mode === 'edit' && !!employeeId;

  const [form, setForm] = useState<EmployeeInput>(EMPTY_FORM);
  const [existingCode, setExistingCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [allEmployees, setAllEmployees] = useState<EmployeeVM[]>([]);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [camps, setCamps] = useState<CampWithCount[] | null>(null);
  const [newSiteName, setNewSiteName] = useState<string | null>(null);
  const [addingSite, setAddingSite] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- load reference data (+ the employee being edited) ----------------------
  // Runs ONCE per mount: re-fetching on realtime changes would wipe the user's
  // in-progress form. The page remounts on every visit (view key changes), so
  // data is always fresh when the form opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [emps, sts, cps] = await Promise.all([
          dataApi.listEmployees(),
          dataApi.listSites(),
          dataApi.listCamps(),
        ]);
        if (cancelled) return;
        setAllEmployees(emps);
        setSites(sts);
        setCamps(cps);
        if (isEdit && employeeId) {
          const emp = emps.find((e) => e.id === employeeId);
          if (!emp) {
            toast.error('Employee not found');
            navigateToEmployees();
            return;
          }
          setExistingCode(emp.employee_code);
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

  const addSiteInline = async () => {
    if (!newSiteName?.trim()) return;
    setAddingSite(true);
    try {
      const site = await dataApi.createSite(newSiteName.trim(), null, null);
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

    setSaving(true);
    const payload: EmployeeInput = {
      ...form,
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
                  <Input value={form.phone ?? ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+966 5xx xxx xxxx" className="h-11" />
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
          <FormSection icon={<Building2 size={16} />} title="Work & Accommodation" hint="Site, trade, camp with block & room">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Position (Trade)</Label>
                <Input value={form.position ?? ''} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="e.g. Electrician, Plumber" className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>Join Date</Label>
                <Input type="date" value={form.join_date ?? ''} onChange={(e) => setForm((f) => ({ ...f, join_date: e.target.value || null }))} className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>Company Name</Label>
                <Input value={form.company_name ?? ''} onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))} className="h-11" />
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
            </div>

            {/* camp + block + room — one clean row */}
            <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
              <Label className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <Tent size={13} /> Accommodation Camp
              </Label>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
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
                  <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No camp assigned</SelectItem>
                    {activeCamps.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{c.employee_count != null ? ` (${c.employee_count})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={form.camp_block ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, camp_block: e.target.value }))}
                  disabled={!form.camp_id}
                  placeholder={form.camp_id ? 'Block no. (e.g. B)' : 'Block — pick a camp first'}
                  className="h-11 disabled:opacity-50"
                />
                <Input
                  value={form.camp_room ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, camp_room: e.target.value }))}
                  disabled={!form.camp_id}
                  placeholder={form.camp_id ? 'Room no. (e.g. 204)' : 'Room — pick a camp first'}
                  className="h-11 disabled:opacity-50"
                />
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
    </div>
  );
}
