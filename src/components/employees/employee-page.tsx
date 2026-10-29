'use client';

// ============================================================================
// PULSE Workforce OS — Employee management module
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Crown, ImagePlus, Loader2, MapPin, Pencil, Plus, Search, Tent, Trash2,
  UserRound, UserX, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmployeeCombobox } from '@/components/shared/employee-combobox';
import { NationalitySelect } from '@/components/shared/nationality-select';
import { EmptyState, EmployeeStatusBadge, RatingStars, SiteBadge, SkeletonRows } from '@/components/shared/primitives';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { dataApi } from '@/lib/data';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CampWithCount, DocumentStatus, EmployeeInput, EmployeeVM, SiteWithCount } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

const EMPTY_FORM: EmployeeInput = {
  full_name: '', nationality: null, date_of_birth: null, phone: null, email: null,
  address: null, emergency_contact: null, position: null, join_date: null,
  company_name: null, passport_number: null, passport_status: null, id_number: null,
  id_status: null, current_site_id: null, camp_id: null, photo: null,
  is_team_leader: false, team_leader_site_id: null,
};

const DOC_STATUSES: { value: DocumentStatus; label: string; cls: string }[] = [
  { value: 'Valid', label: '✓ Valid', cls: 'text-emerald-500' },
  { value: 'Expired', label: '✗ Expired', cls: 'text-rose-500' },
  { value: 'N/A', label: 'N/A', cls: 'text-zinc-400' },
];

const nullify = (v: string): string | null => (v.trim() === '' ? null : v.trim());

// client-side photo compression (max 300px, JPEG 0.8)
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

export function EmployeePage() {
  const user = useAuthStore((s) => s.user);
  const navigateToEmployeeDetails = useAppStore((s) => s.navigateToEmployeeDetails);
  const consumeEmployeeFilter = useAppStore((s) => s.consumeEmployeeFilter);
  const consumePendingEditEmployeeId = useAppStore((s) => s.consumePendingEditEmployeeId);
  const realtimeVersion = useRealtimeVersion(['employee', 'site', 'camp']);

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [camps, setCamps] = useState<CampWithCount[] | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  // form / dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EmployeeInput>(EMPTY_FORM);
  const [formTab, setFormTab] = useState('personal');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EmployeeVM | null>(null);
  const [requestDeleteTarget, setRequestDeleteTarget] = useState<EmployeeVM | null>(null);
  const [requestReason, setRequestReason] = useState('');
  const [newSiteName, setNewSiteName] = useState<string | null>(null);
  const [addingSite, setAddingSite] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // cross-page filter (e.g. dashboard "Idle" card)
  // (pending edit is consumed in the employees-watching effect below, once data is loaded)
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

  // filtering
  const filtered = useMemo(() => {
    const list = employees ?? [];
    const q = debouncedSearch.toLowerCase().trim();
    return list.filter((e) => {
      if (statusFilter === 'active' && e.status !== 'active') return false;
      if (statusFilter === 'working' && (e.status !== 'active' || !e.current_site_id)) return false;
      if (statusFilter === 'idle' && (e.status !== 'active' || e.current_site_id)) return false;
      if (statusFilter === 'pending_deletion' && e.status !== 'pending_deletion') return false;
      if (q) {
        const hay = `${e.full_name} ${e.employee_code} ${e.nationality ?? ''} ${e.phone ?? ''} ${e.position ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [employees, debouncedSearch, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  // ---- actions ---------------------------------------------------------------
  const openAdd = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormTab('personal');
    setFormOpen(true);
  };

  const openEdit = (emp: EmployeeVM) => {
    setForm({
      full_name: emp.full_name,
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
      photo: emp.photo,
      is_team_leader: emp.is_team_leader,
      team_leader_site_id: emp.team_leader_site_id,
    });
    setEditingId(emp.id);
    setFormTab('personal');
    setFormOpen(true);
  };

  useEffect(() => {
    const editId = consumePendingEditEmployeeId();
    if (editId) {
      const emp = employees?.find((e) => e.id === editId);
      if (emp) openEdit(emp);
    }

  }, [employees]);

  const submitForm = async () => {
    if (!form.full_name.trim()) {
      setFormTab('personal');
      toast.error('Full name is required');
      return;
    }
    setSaving(true);
    const payload: EmployeeInput = {
      ...form,
      full_name: form.full_name.trim(),
      nationality: form.nationality ? nullify(form.nationality) : null,
      phone: form.phone ? nullify(form.phone) : null,
      email: form.email ? nullify(form.email) : null,
      address: form.address ? nullify(form.address) : null,
      emergency_contact: form.emergency_contact ? nullify(form.emergency_contact) : null,
      position: form.position ? nullify(form.position) : null,
      company_name: form.company_name ? nullify(form.company_name) : null,
      passport_number: form.passport_number ? nullify(form.passport_number) : null,
      id_number: form.id_number ? nullify(form.id_number) : null,
    };
    try {
      if (editingId) {
        const updated = await dataApi.updateEmployee(editingId, payload);
        toast.success('Employee updated', { description: `${updated.full_name} saved.` });
      } else {
        const created = await dataApi.createEmployee(payload);
        toast.success('Employee created', { description: `${created.full_name} — ID ${created.employee_code}` });
      }
      setFormOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

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

  const addSiteInline = async () => {
    if (!newSiteName?.trim()) return;
    setAddingSite(true);
    try {
      const site = await dataApi.createSite(newSiteName.trim(), null, null);
      toast.success('Site created', { description: site.name });
      setForm((f) => ({ ...f, current_site_id: site.id }));
      setNewSiteName(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create site');
    } finally {
      setAddingSite(false);
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
        <Button onClick={openAdd} className="brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]">
          <Plus size={16} className="mr-1.5" /> Add Employee
        </Button>
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
        {(search || statusFilter !== 'all') && (
          <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter('all'); setPage(1); }}>
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
                              {emp.nationality && <span className="ml-1">{emp.nationality}</span>}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{emp.employee_code}</td>
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

      {/* ============ Add/Edit dialog ============ */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Employee' : 'Add New Employee'}</DialogTitle>
            <DialogDescription>
              {editingId
                ? 'Update personal, professional and document details.'
                : 'The employee ID is auto-generated in the ASM-YYYY-NNN format on save.'}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={formTab} onValueChange={setFormTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="personal">Personal</TabsTrigger>
              <TabsTrigger value="professional">Professional</TabsTrigger>
            </TabsList>

            {/* -------- Personal tab -------- */}
            <TabsContent value="personal" className="space-y-4 pt-4">
              {/* photo */}
              <div className="flex items-center gap-4">
                <span className="flex size-20 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border bg-muted text-xs font-bold text-brand">
                  {form.photo ? (
                     
                    <img src={form.photo} alt="Preview" className="size-full object-cover" />
                  ) : (
                    <ImagePlus size={20} />
                  )}
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

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Full Name *</Label>
                  <Input value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} placeholder="e.g. Rajesh Kumar" className="h-11" />
                </div>
                <div className="space-y-2">
                  <Label>Employee ID</Label>
                  <Input
                    value={editingId ? (employees?.find((e) => e.id === editingId)?.employee_code ?? '—') : ''}
                    readOnly
                    disabled
                    placeholder="Auto-generated on save"
                    className="h-11 font-mono"
                  />
                  {!editingId && <p className="text-[11px] text-muted-foreground">Format: ASM-YYYY-NNN — assigned automatically</p>}
                </div>
                <div className="space-y-2">
                  <Label>Nationality</Label>
                  <NationalitySelect value={form.nationality} onChange={(v) => setForm((f) => ({ ...f, nationality: v }))} />
                </div>
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
                <div className="space-y-2 sm:col-span-2">
                  <Label>Address</Label>
                  <Textarea value={form.address ?? ''} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder="Labour camp / accommodation address" rows={2} />
                </div>
              </div>
            </TabsContent>

            {/* -------- Professional tab -------- */}
            <TabsContent value="professional" className="space-y-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Position</Label>
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
                  <Select
                    value={form.current_site_id ?? 'none'}
                    onValueChange={(v) => setForm((f) => ({ ...f, current_site_id: v === 'none' ? null : v }))}
                  >
                    <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">🟡 No site assigned (Idle)</SelectItem>
                      {activeSites.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                      <SelectItem value="__add_new" className="text-brand">+ Add New Site…</SelectItem>
                    </SelectContent>
                  </Select>
                  {form.current_site_id === '__add_new' && null}
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

                {/* Camp assignment */}
                <div className="space-y-2 sm:col-span-2">
                  <Label className="flex items-center gap-1.5"><Tent size={13} className="text-amber-500" /> Accommodation Camp</Label>
                  <Select
                    value={form.camp_id ?? 'none'}
                    onValueChange={(v) => setForm((f) => ({ ...f, camp_id: v === 'none' ? null : v }))}
                  >
                    <SelectTrigger className="h-11 bg-card"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">🟡 No camp assigned</SelectItem>
                      {activeCamps.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{c.employee_count != null ? ` (${c.employee_count})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Where the employee stays. Each employee belongs to exactly one camp — change it anytime here or from the Camps page.
                  </p>
                </div>

                {/* Team leader */}
                <div className="rounded-xl border border-border/60 bg-muted/40 p-4 sm:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <Crown size={14} className="fill-amber-400 text-amber-400" /> Team Leader
                      </p>
                      <p className="text-xs text-muted-foreground">Only one leader per site.</p>
                    </div>
                    <Switch checked={form.is_team_leader} onCheckedChange={(v) => setForm((f) => ({ ...f, is_team_leader: v }))} />
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

                {/* Documents */}
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
                {editingId && (
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Performance Rating</Label>
                    <div className="flex h-11 items-center gap-2 rounded-xl border bg-muted/40 px-3">
                      <RatingStars rating={employees?.find((e) => e.id === editingId)?.rating ?? 5} />
                      <span className="text-xs text-muted-foreground">Auto-calculated from attendance</span>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-between gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setFormTab(formTab === 'personal' ? 'professional' : 'personal')}
            >
              {formTab === 'personal' ? 'Next: Professional' : 'Back: Personal'}
            </Button>
            <Button type="button" onClick={submitForm} disabled={saving} className="brand-gradient font-semibold text-white">
              {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {editingId ? 'Save Changes' : 'Create Employee'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
