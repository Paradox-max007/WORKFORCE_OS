'use client';

// ============================================================================
// PULSE Workforce OS — Admin Management (accounts, roles & menu permissions)
// ----------------------------------------------------------------------------
// Super-admin-only module. Two grouped sections (Super Admins / Admins) with
// independent search, create/edit dialogs, per-menu permission switches and
// a guarded delete flow. Everything re-fetches in realtime whenever the
// `profiles` or `menu_permission` tables change anywhere.
// ============================================================================

import { motion } from 'framer-motion';
import {
  Ban, Bell, Building2, Calendar, CalendarCheck, Crown, Eye, EyeOff, FileText,
  KeyRound, LayoutDashboard, Loader2, Lock, Mail, Pencil, Plus, Search, Shield,
  Shirt, Tent, Trash2, User, Users, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { dataApi } from '@/lib/data';
import { fmtDate, initials } from '@/lib/format';
import { MENU_KEYS, type MenuKey, type MenuPermissionMap, type Profile, type Role, type SiteWithCount } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Signature PULSE easing — soft expo-out. */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY_PERMS: MenuPermissionMap = {
  employees: false,
  sites: false,
  camps: false,
  attendance: false,
  leave_requests: false,
  cancellation_requests: false,
  notifications: false,
};

/** Friendly metadata for the permission keys defined in MENU_KEYS. */
const MENU_META: Record<MenuKey, { label: string; hint: string; icon: LucideIcon }> = {
  employees: { label: 'Employees', hint: 'Directory, records & ratings', icon: Users },
  sites: { label: 'Sites', hint: 'Work sites & client projects', icon: Building2 },
  camps: { label: 'Camps', hint: 'Accommodation & room assignments', icon: Tent },
  attendance: { label: 'Attendance', hint: 'Sitewise hours marking — assigned sites only', icon: CalendarCheck },
  leave_requests: { label: 'Leave Requests', hint: 'Leave applications & review', icon: FileText },
  cancellation_requests: { label: 'Cancellations', hint: 'Employee deletion requests', icon: Ban },
  notifications: { label: 'Notifications', hint: 'Alerts & announcements', icon: Bell },
};

/** Menus every admin can always reach (mirrors the sidebar visibility rules). */
const ALWAYS_ON_MENUS: { label: string; hint: string; icon: LucideIcon }[] = [
  { label: 'Dashboard', hint: 'Operations overview & stats', icon: LayoutDashboard },
  { label: 'Uniform Registry', hint: 'Uniform tokens & renewals', icon: Shirt },
];

/** Create or edit target for the account dialog. */
type AccountTarget =
  | { mode: 'create'; role: 'admin' | 'super_admin' }
  | { mode: 'edit'; profile: Profile };

const matchesSearch = (profile: Profile, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return profile.name.toLowerCase().includes(q) || profile.email.toLowerCase().includes(q);
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function AdminPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const version = useRealtimeVersion(['profiles', 'menu_permission', 'admin_site', 'site']);

  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [permCache, setPermCache] = useState<Record<string, MenuPermissionMap>>({});
  const [sitesCache, setSitesCache] = useState<Record<string, string[]>>({});
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [superSearch, setSuperSearch] = useState('');
  const [adminSearch, setAdminSearch] = useState('');

  // Dialog state
  const [accountTarget, setAccountTarget] = useState<AccountTarget | null>(null);
  const [permTarget, setPermTarget] = useState<Profile | null>(null);
  const [sitesTarget, setSitesTarget] = useState<Profile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ---- data loading (re-fetches whenever profiles / permissions change) ----
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const [list, siteList] = await Promise.all([dataApi.listProfiles(), dataApi.listSites()]);
        if (cancelled) return;
        setProfiles(list);
        setSites(siteList);
        // Permission summaries + site assignments for the admin rows
        const [maps, siteSets] = await Promise.all([
          Promise.all(
            list
              .filter((p) => p.role === 'admin')
              .map(async (p): Promise<[string, MenuPermissionMap]> => {
                try {
                  return [p.id, await dataApi.getMenuPermissions(p.id)];
                } catch {
                  return [p.id, { ...EMPTY_PERMS }];
                }
              }),
          ),
          Promise.all(
            list
              .filter((p) => p.role === 'admin')
              .map(async (p): Promise<[string, string[]]> => {
                try {
                  return [p.id, await dataApi.getSiteAssignments(p.id)];
                } catch {
                  return [p.id, [] as string[]];
                }
              }),
          ),
        ]);
        if (!cancelled) {
          setPermCache(Object.fromEntries(maps));
          setSitesCache(Object.fromEntries(siteSets));
        }
      } catch {
        if (!cancelled) setProfiles([]);
      }
    })();
    return () => { cancelled = true; };
  }, [version, isSuperAdmin]);

  // ---- derived values --------------------------------------------------------
  const allSuper = useMemo(() => (profiles ?? []).filter((p) => p.role === 'super_admin'), [profiles]);
  const allAdmins = useMemo(() => (profiles ?? []).filter((p) => p.role === 'admin'), [profiles]);
  const superAdmins = useMemo(() => allSuper.filter((p) => matchesSearch(p, superSearch)), [allSuper, superSearch]);
  const regularAdmins = useMemo(() => allAdmins.filter((p) => matchesSearch(p, adminSearch)), [allAdmins, adminSearch]);
  const superCount = allSuper.length;
  const loading = profiles === null;

  // ---- delete flow (client-side guard: never remove the last super admin) ----
  const requestDelete = (p: Profile) => {
    if (p.role === 'super_admin' && superCount <= 1) {
      toast.error('Cannot delete the last super admin', {
        description: 'There must be at least one super admin. Promote another account first.',
      });
      return;
    }
    setDeleteTarget(p);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await dataApi.deleteProfile(deleteTarget.id);
      toast.success('Account deleted', {
        description: `${deleteTarget.name} (${deleteTarget.email}) no longer has access to the system.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete the account');
    } finally {
      setDeleting(false);
    }
  };

  // Keep the "Access" column in sync when toggles fire in the permissions dialog
  const handlePermChanged = (profileId: string, key: MenuKey, allowed: boolean) => {
    setPermCache((prev) => ({
      ...prev,
      [profileId]: { ...(prev[profileId] ?? EMPTY_PERMS), [key]: allowed },
    }));
  };

  // Keep the "Sites" column in sync when toggles fire in the site-access dialog
  const handleSitesChanged = (profileId: string, siteIds: string[]) => {
    setSitesCache((prev) => ({ ...prev, [profileId]: siteIds }));
  };

  // ---- super-admin-only guard -------------------------------------------------
  if (!isSuperAdmin) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-7xl flex-col items-center justify-center">
        <div className="w-full max-w-lg">
          <EmptyState
            icon={<Shield size={22} />}
            title="Super admin access only"
            description="Only super admins can create and manage admin accounts and menu permissions. Contact a super admin if you believe you should have access."
          />
        </div>
      </div>
    );
  }

  const TH = 'px-3 py-3 text-xs uppercase tracking-wide text-muted-foreground';

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Admin Management"
        description="Create and manage admin accounts, control roles, and grant menu access."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setAccountTarget({ mode: 'create', role: 'super_admin' })}
              className="h-10 gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-400"
            >
              <Crown size={16} aria-hidden /> Create Super Admin
            </Button>
            <Button
              onClick={() => setAccountTarget({ mode: 'create', role: 'admin' })}
              className="h-10 brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]"
            >
              <Plus size={16} aria-hidden /> Create Admin
            </Button>
          </>
        }
      />

      {/* ================= Super Admins ================= */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.05, ease: EASE }}
      >
        <section className="card-glow overflow-hidden rounded-xl border bg-card" aria-labelledby="super-admins-title">
          <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="rounded-lg bg-amber-500/10 p-1.5 text-amber-500">
                <Crown size={16} aria-hidden />
              </div>
              <div>
                <h3 id="super-admins-title" className="flex items-center gap-2 text-sm font-semibold">
                  Super Admins
                  <Badge
                    variant="outline"
                    className="rounded-full border-amber-500/25 bg-amber-500/10 px-2 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                  >
                    {superAdmins.length}
                  </Badge>
                </h3>
                <p className="text-xs text-muted-foreground">Full access to every module</p>
              </div>
            </div>
            <SearchBox
              value={superSearch}
              onChange={setSuperSearch}
              placeholder="Search super admins…"
              label="Search super admins by name or email"
            />
          </div>

          {loading ? (
            <div className="p-4">
              <SkeletonRows rows={3} />
            </div>
          ) : superAdmins.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Crown size={22} />}
                title={superSearch ? 'No super admins match your search' : 'No super admins found'}
                description={superSearch
                  ? 'Try a different name or email address.'
                  : 'Create a super admin to share full system access.'}
              />
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto p-2 md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={TH}>Member</TableHead>
                      <TableHead className={TH}>Role</TableHead>
                      <TableHead className={TH}>Created</TableHead>
                      <TableHead className={cn(TH, 'text-right')}>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {superAdmins.map((p, i) => (
                      <motion.tr
                        key={p.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i, 10) * 0.04, duration: 0.3, ease: EASE }}
                        className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/30"
                      >
                        <TableCell className="px-3 py-3">
                          <div className="flex items-center gap-3">
                            <ProfileAvatar profile={p} />
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 text-sm font-medium">
                                <span className="truncate">{p.name}</span>
                                {p.id === user?.id && <YouBadge />}
                              </p>
                              <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                                <Mail size={11} className="shrink-0" aria-hidden /> {p.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <RoleBadge role={p.role} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap px-3 py-3">
                          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Calendar size={13} className="text-muted-foreground/60" aria-hidden />
                            {fmtDate(p.created_at)}
                          </span>
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <div className="flex justify-end">
                            <RowActions
                              profile={p}
                              canDelete={superCount > 1}
                              onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                              onDelete={() => requestDelete(p)}
                            />
                          </div>
                        </TableCell>
                      </motion.tr>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 p-4 md:hidden">
                {superAdmins.map((p, i) => (
                  <motion.div
                    key={p.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    whileHover={{ y: -3 }}
                    transition={{ delay: Math.min(i, 10) * 0.04, duration: 0.3, ease: EASE }}
                    className="rounded-xl border bg-background/40 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <ProfileAvatar profile={p} />
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-sm font-medium">
                            <span className="truncate">{p.name}</span>
                            {p.id === user?.id && <YouBadge />}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{p.email}</p>
                        </div>
                      </div>
                      <RoleBadge role={p.role} />
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Calendar size={12} aria-hidden /> Joined {fmtDate(p.created_at)}
                      </p>
                      <RowActions
                        profile={p}
                        canDelete={superCount > 1}
                        onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                        onDelete={() => requestDelete(p)}
                      />
                    </div>
                  </motion.div>
                ))}
              </div>
            </>
          )}
        </section>
      </motion.div>

      {/* ================= Admins ================= */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1, ease: EASE }}
      >
        <section className="card-glow overflow-hidden rounded-xl border bg-card" aria-labelledby="admins-title">
          <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="rounded-lg bg-brand/10 p-1.5 text-brand">
                <Shield size={16} aria-hidden />
              </div>
              <div>
                <h3 id="admins-title" className="flex items-center gap-2 text-sm font-semibold">
                  Admins
                  <Badge
                    variant="outline"
                    className="rounded-full border-brand/25 bg-brand/10 px-2 text-[10px] font-semibold text-brand"
                  >
                    {regularAdmins.length}
                  </Badge>
                </h3>
                <p className="text-xs text-muted-foreground">Scoped access — grant menus via Permissions</p>
              </div>
            </div>
            <SearchBox
              value={adminSearch}
              onChange={setAdminSearch}
              placeholder="Search admins…"
              label="Search admins by name or email"
            />
          </div>

          {loading ? (
            <div className="p-4">
              <SkeletonRows rows={4} />
            </div>
          ) : regularAdmins.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Shield size={22} />}
                title={adminSearch ? 'No admins match your search' : 'No admins yet'}
                description={adminSearch
                  ? 'Try a different name or email address.'
                  : 'Create an admin to delegate day-to-day operations — they start with Dashboard and Uniform Registry, and you can grant more modules via Permissions.'}
                action={!adminSearch ? (
                  <Button
                    onClick={() => setAccountTarget({ mode: 'create', role: 'admin' })}
                    className="brand-gradient font-semibold text-white"
                  >
                    <Plus size={16} aria-hidden /> Create Admin
                  </Button>
                ) : undefined}
              />
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto p-2 md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={TH}>Member</TableHead>
                      <TableHead className={TH}>Role</TableHead>
                      <TableHead className={TH}>Access</TableHead>
                      <TableHead className={TH}>Assigned Sites</TableHead>
                      <TableHead className={TH}>Created</TableHead>
                      <TableHead className={cn(TH, 'text-right')}>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {regularAdmins.map((p, i) => (
                      <motion.tr
                        key={p.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i, 10) * 0.04, duration: 0.3, ease: EASE }}
                        className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/30"
                      >
                        <TableCell className="px-3 py-3">
                          <div className="flex items-center gap-3">
                            <ProfileAvatar profile={p} />
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 text-sm font-medium">
                                <span className="truncate">{p.name}</span>
                                {p.id === user?.id && <YouBadge />}
                              </p>
                              <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                                <Mail size={11} className="shrink-0" aria-hidden /> {p.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <RoleBadge role={p.role} />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <AccessChips map={permCache[p.id]} />
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <SiteChips siteIds={sitesCache[p.id] ?? []} sites={sites} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap px-3 py-3">
                          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Calendar size={13} className="text-muted-foreground/60" aria-hidden />
                            {fmtDate(p.created_at)}
                          </span>
                        </TableCell>
                        <TableCell className="px-3 py-3">
                          <div className="flex justify-end">
                            <RowActions
                              profile={p}
                              canDelete
                              onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                              onPermissions={() => setPermTarget(p)}
                              onSites={() => setSitesTarget(p)}
                              onDelete={() => requestDelete(p)}
                            />
                          </div>
                        </TableCell>
                      </motion.tr>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 p-4 md:hidden">
                {regularAdmins.map((p, i) => {
                  const grantedLabels = MENU_KEYS
                    .filter((k) => permCache[p.id]?.[k] === true)
                    .map((k) => MENU_META[k].label);
                  return (
                    <motion.div
                      key={p.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      whileHover={{ y: -3 }}
                      transition={{ delay: Math.min(i, 10) * 0.04, duration: 0.3, ease: EASE }}
                      className="rounded-xl border bg-background/40 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <ProfileAvatar profile={p} />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm font-medium">
                              <span className="truncate">{p.name}</span>
                              {p.id === user?.id && <YouBadge />}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{p.email}</p>
                          </div>
                        </div>
                        <RoleBadge role={p.role} />
                      </div>
                      <p className="mt-2.5 text-xs text-muted-foreground">
                        Access — Dashboard &amp; Uniform Registry
                        {grantedLabels.length > 0 ? ` plus ${grantedLabels.join(', ')}` : ' only'}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Building2 size={12} className="shrink-0 text-brand" aria-hidden /> Sites:
                        <SiteChips siteIds={sitesCache[p.id] ?? []} sites={sites} inline />
                      </p>
                      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Calendar size={12} aria-hidden /> Joined {fmtDate(p.created_at)}
                        </p>
                        <RowActions
                          profile={p}
                          canDelete
                          onEdit={() => setAccountTarget({ mode: 'edit', profile: p })}
                          onPermissions={() => setPermTarget(p)}
                          onSites={() => setSitesTarget(p)}
                          onDelete={() => requestDelete(p)}
                        />
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </motion.div>

      {/* ---- Create / Edit dialog ---- */}
      <AccountDialog
        target={accountTarget}
        superCount={superCount}
        onClose={() => setAccountTarget(null)}
      />

      {/* ---- Permissions dialog ---- */}
      <PermissionsDialog
        profile={permTarget}
        onClose={() => setPermTarget(null)}
        onChanged={handlePermChanged}
      />

      {/* ---- Site access dialog ---- */}
      <SiteAccessDialog
        profile={sitesTarget}
        sites={sites}
        onClose={() => setSitesTarget(null)}
        onChanged={handleSitesChanged}
      />

      {/* ---- Delete confirmation ---- */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <span className="rounded-lg bg-rose-500/10 p-1.5 text-rose-500">
                <Trash2 size={15} aria-hidden />
              </span>
              Delete {deleteTarget?.role === 'super_admin' ? 'super admin' : 'admin'} account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes{' '}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>{' '}
              ({deleteTarget?.email}). Their sign-in access and menu permissions are erased —
              this action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-rose-600 font-semibold text-white shadow-lg shadow-rose-500/20 hover:bg-rose-600/90"
            >
              {deleting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={15} aria-hidden />}
              {deleting ? 'Deleting…' : 'Delete Account'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Crown badge for super admins, brand shield badge for admins. */
function RoleBadge({ role }: { role: Role }) {
  if (role === 'super_admin') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        <Crown size={11} aria-hidden /> Super Admin
      </span>
    );
  }
  if (role === 'admin') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand">
        <Shield size={11} aria-hidden /> Admin
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      Awaiting approval
    </span>
  );
}

/** Avatar initials on the brand gradient (gold gradient for super admins). */
function ProfileAvatar({ profile }: { profile: Profile }) {
  const isSuper = profile.role === 'super_admin';
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold',
        isSuper
          ? 'bg-gradient-to-br from-amber-500 to-orange-600 text-white'
          : 'brand-gradient text-brand-foreground',
      )}
    >
      {initials(profile.name)}
    </span>
  );
}

/** Tiny chip marking the signed-in account. */
function YouBadge() {
  return (
    <Badge
      variant="outline"
      className="rounded-full border-brand/25 bg-brand/10 px-1.5 text-[9px] font-bold uppercase tracking-wider text-brand"
    >
      You
    </Badge>
  );
}

/** Section search box (name / email). */
function SearchBox({
  value, onChange, placeholder, label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 bg-card pl-9 pr-9"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Summary of what an admin can reach (base menus + granted keys). */
function AccessChips({ map }: { map: MenuPermissionMap | undefined }) {
  const granted = MENU_KEYS.filter((k) => map?.[k] === true);
  return (
    <div
      className="flex max-w-[260px] flex-wrap items-center gap-1"
      title="Dashboard and Uniform Registry are always available"
    >
      <span className="rounded-full border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
        Dashboard
      </span>
      <span className="rounded-full border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
        Uniform Registry
      </span>
      {granted.map((k) => (
        <span
          key={k}
          className="rounded-full border border-brand/25 bg-brand/10 px-1.5 py-px text-[10px] font-medium text-brand"
        >
          {MENU_META[k].label}
        </span>
      ))}
    </div>
  );
}

/** Summary of the sites an admin is assigned to (attendance scoping). */
function SiteChips({
  siteIds, sites, inline = false,
}: {
  siteIds: string[];
  sites: SiteWithCount[] | null;
  inline?: boolean;
}) {
  const names = (sites ?? []).filter((s) => siteIds.includes(s.id)).map((s) => s.name);
  return (
    <span
      className={cn('flex items-center gap-1', inline ? 'flex-wrap' : 'max-w-[220px] flex-wrap')}
      title="Admins can only mark attendance for their assigned sites"
    >
      {names.length === 0 ? (
        <span className={cn('rounded-full border px-1.5 py-px text-[10px] font-medium', inline ? 'text-amber-600 dark:text-amber-400 border-amber-500/25 bg-amber-500/10' : 'text-muted-foreground bg-muted')}>
          None
        </span>
      ) : names.map((n) => (
        <span
          key={n}
          className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
        >
          {n}
        </span>
      ))}
    </span>
  );
}

/** Row action icon buttons (permissions + site access for admins, edit, guarded delete). */
function RowActions({
  profile, canDelete, onEdit, onPermissions, onSites, onDelete,
}: {
  profile: Profile;
  canDelete: boolean;
  onEdit: () => void;
  onPermissions?: () => void;
  onSites?: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {onPermissions && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onPermissions}
          title="Manage permissions"
          aria-label={`Manage permissions — ${profile.name}`}
          className="size-9 text-muted-foreground hover:bg-brand/10 hover:text-brand"
        >
          <KeyRound size={15} aria-hidden />
        </Button>
      )}
      {onSites && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onSites}
          title="Assign sites (attendance scoping)"
          aria-label={`Assign sites — ${profile.name}`}
          className="size-9 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-500"
        >
          <Building2 size={15} aria-hidden />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        title="Edit account"
        aria-label={`Edit account — ${profile.name}`}
        className="size-9 text-muted-foreground hover:bg-brand/10 hover:text-brand"
      >
        <Pencil size={15} aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? 'Delete account' : 'The last super admin cannot be deleted'}
        aria-label={`Delete account — ${profile.name}`}
        className="size-9 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
      >
        <Trash2 size={15} aria-hidden />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit account dialog
// ---------------------------------------------------------------------------
function AccountDialog({
  target, superCount, onClose,
}: {
  target: AccountTarget | null;
  superCount: number;
  onClose: () => void;
}) {
  const open = target !== null;
  const editing = target?.mode === 'edit' ? target.profile : null;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'super_admin'>('admin');
  const [showPw, setShowPw] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  // The last super admin cannot be demoted (client-side guard; the server also enforces it)
  const isLastSuper = editing !== null && editing.role === 'super_admin' && superCount <= 1;

  // Reset the form every time the dialog opens for a target
  useEffect(() => {
    if (!target) return;
    const editProfile = target.mode === 'edit' ? target.profile : null;
    setName(editProfile?.name ?? '');
    setEmail(editProfile?.email ?? '');
    setPassword('');
    setRole(
      target.mode === 'edit'
        ? (target.profile.role === 'super_admin' ? 'super_admin' : 'admin')
        : target.role,
    );
    setShowPw(false);
    setErrors({});
    setSubmitting(false);
  }, [target]);

  const handleSubmit = async () => {
    if (!target) return;
    const errs: typeof errors = {};
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName) errs.name = 'Name is required';
    if (!trimmedEmail) errs.email = 'Email is required';
    else if (!EMAIL_RE.test(trimmedEmail)) errs.email = 'Enter a valid email address';
    if (target.mode === 'create' && !password) errs.password = 'Password is required';
    else if (password && password.length < 6) errs.password = 'Password must be at least 6 characters';
    setErrors(errs);
    if (errs.name || errs.email || errs.password) return;

    // Client-side guard: cannot demote the last super admin
    if (editing && editing.role === 'super_admin' && role !== 'super_admin' && superCount <= 1) {
      toast.error('Cannot demote the last super admin', {
        description: 'There must be at least one super admin. Promote another account first.',
      });
      return;
    }

    setSubmitting(true);
    try {
      if (target.mode === 'create') {
        const created = await dataApi.createProfile(trimmedEmail, trimmedName, password, role);
        toast.success(role === 'super_admin' ? 'Super admin created' : 'Admin created', {
          description:
            role === 'super_admin'
              ? `${created.name} (${created.email}) now has full access to everything.`
              : `${created.name} (${created.email}) starts with Dashboard + Uniform Registry — grant more via Permissions.`,
        });
      } else if (editing) {
        const updated = await dataApi.updateProfile(editing.id, {
          name: trimmedName,
          email: trimmedEmail,
          role,
          ...(password ? { password } : {}),
        });
        toast.success('Account updated', {
          description: `${updated.name} (${updated.email}) was saved successfully.`,
        });
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-lg p-1.5',
                editing
                  ? 'bg-brand/10 text-brand'
                  : role === 'super_admin'
                    ? 'bg-amber-500/10 text-amber-500'
                    : 'bg-brand/10 text-brand',
              )}
            >
              {editing ? <Pencil size={14} aria-hidden /> : role === 'super_admin' ? <Crown size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
            </span>
            {editing ? 'Edit Account' : role === 'super_admin' ? 'Create Super Admin' : 'Create Admin'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Update the account details — leave the password blank to keep the current one.'
              : role === 'super_admin'
                ? 'Super admin — full access to everything, including Admin Management.'
                : 'Admin — Dashboard + Uniform Registry by default; grant more via Permissions.'}
          </DialogDescription>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 26 }}
          className="space-y-4"
        >
          {/* Role */}
          <div className="space-y-2">
            <Label htmlFor="acct-role">
              Role <span className="text-rose-500">*</span>
            </Label>
            <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'super_admin')}>
              <SelectTrigger id="acct-role" className="h-11 w-full" aria-label="Role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin" disabled={isLastSuper}>
                  <Shield className="size-3.5 text-brand" aria-hidden /> Admin
                  <span className="text-xs text-muted-foreground">· Dashboard + Uniform Registry</span>
                </SelectItem>
                <SelectItem value="super_admin">
                  <Crown className="size-3.5 text-amber-500" aria-hidden /> Super Admin
                  <span className="text-xs text-muted-foreground">· Full access</span>
                </SelectItem>
              </SelectContent>
            </Select>
            {isLastSuper && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                This is the last super admin — the role cannot be lowered.
              </p>
            )}
            {role === 'super_admin' ? (
              <motion.div
                key="super-info"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-3"
              >
                <Crown size={15} className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                    Super admin — full access to everything
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    They can manage every module, create and delete admins, and promote other super admins.
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="admin-info"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="flex items-start gap-2 rounded-lg border border-brand/25 bg-brand/10 px-3.5 py-3"
              >
                <Shield size={15} className="mt-0.5 shrink-0 text-brand" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-brand">
                    Admin — Dashboard + Uniform Registry by default
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Grant more modules via Permissions after creating the account.
                  </p>
                </div>
              </motion.div>
            )}
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="acct-name">
              Name <span className="text-rose-500">*</span>
            </Label>
            <div className="relative">
              <User
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="acct-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((er) => ({ ...er, name: undefined }));
                }}
                placeholder="Full name"
                autoComplete="name"
                aria-invalid={!!errors.name}
                className="h-11 pl-9"
              />
            </div>
            {errors.name && <p className="text-xs text-rose-500">{errors.name}</p>}
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="acct-email">
              Email <span className="text-rose-500">*</span>
            </Label>
            <div className="relative">
              <Mail
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="acct-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors((er) => ({ ...er, email: undefined }));
                }}
                placeholder="admin@example.com"
                autoComplete="email"
                aria-invalid={!!errors.email}
                className="h-11 pl-9"
              />
            </div>
            {errors.email && <p className="text-xs text-rose-500">{errors.email}</p>}
          </div>

          {/* Password (optional on edit — blank keeps the current one) */}
          <div className="space-y-2">
            <Label htmlFor="acct-password">
              Password
              {!editing && <span className="text-rose-500">*</span>}
              {editing && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
            </Label>
            <div className="relative">
              <Lock
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="acct-password"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errors.password) setErrors((er) => ({ ...er, password: undefined }));
                }}
                placeholder={editing ? 'Leave blank to keep the current password' : 'Minimum 6 characters'}
                autoComplete="new-password"
                aria-invalid={!!errors.password}
                className="h-11 pl-9 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                {showPw ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
              </button>
            </div>
            {errors.password
              ? <p className="text-xs text-rose-500">{errors.password}</p>
              : <p className="text-xs text-muted-foreground">Minimum 6 characters.</p>}
          </div>
        </motion.div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className={cn(
              'font-semibold text-white shadow-lg transition-transform active:scale-[0.98]',
              role === 'super_admin' && !editing
                ? 'bg-gradient-to-r from-amber-500 to-orange-500 shadow-amber-500/25 hover:opacity-90'
                : 'brand-gradient shadow-[var(--glow)] hover:opacity-90',
            )}
          >
            {submitting
              ? <Loader2 size={16} className="animate-spin" aria-hidden />
              : editing
                ? <Pencil size={15} aria-hidden />
                : role === 'super_admin'
                  ? <Crown size={15} aria-hidden />
                  : <Plus size={15} aria-hidden />}
            {editing ? 'Save Changes' : role === 'super_admin' ? 'Create Super Admin' : 'Create Admin'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Permissions dialog (admin role only — Dashboard & Uniform Registry are always on)
// ---------------------------------------------------------------------------
function PermissionsDialog({
  profile, onClose, onChanged,
}: {
  profile: Profile | null;
  onClose: () => void;
  onChanged: (profileId: string, key: MenuKey, allowed: boolean) => void;
}) {
  const open = profile !== null;
  const [perms, setPerms] = useState<MenuPermissionMap | null>(null);
  const [savingKey, setSavingKey] = useState<MenuKey | null>(null);

  // Load the initial permission state each time the dialog opens
  useEffect(() => {
    if (!profile) {
      setPerms(null);
      return;
    }
    let cancelled = false;
    setPerms(null);
    setSavingKey(null);
    (async () => {
      const map = await dataApi.getMenuPermissions(profile.id);
      if (!cancelled) setPerms(map);
    })().catch(() => {
      if (!cancelled) {
        setPerms({ ...EMPTY_PERMS });
        toast.error('Failed to load permissions', { description: 'Please close the dialog and try again.' });
      }
    });
    return () => { cancelled = true; };
  }, [profile]);

  // Toggle a single menu — optimistic, instantly saved, reverted on failure
  const toggle = async (key: MenuKey, allowed: boolean) => {
    if (!profile || !perms) return;
    const meta = MENU_META[key];
    const previous = perms[key];
    setSavingKey(key);
    setPerms({ ...perms, [key]: allowed });
    try {
      await dataApi.setMenuPermission(profile.id, key, allowed);
      toast.success(
        allowed ? `Access granted for ${meta.label}` : `Access revoked for ${meta.label}`,
        { description: `${profile.name} · ${meta.label}` },
      );
      onChanged(profile.id, key, allowed);
    } catch (err) {
      setPerms((p) => (p ? { ...p, [key]: previous } : p));
      toast.error(err instanceof Error ? err.message : `Failed to update access for ${meta.label}`);
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded-lg bg-brand/10 p-1.5 text-brand">
              <KeyRound size={14} aria-hidden />
            </span>
            Manage Permissions
          </DialogTitle>
          <DialogDescription>
            Choose the sidebar menus{' '}
            <span className="font-medium text-foreground">{profile?.name}</span> can reach.
            Every change saves instantly.
          </DialogDescription>
        </DialogHeader>

        {perms === null ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="shimmer h-11 rounded-lg border" />
            ))}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="space-y-1.5 py-1"
          >
            {/* Always available */}
            <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Always available
            </p>
            {ALWAYS_ON_MENUS.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 rounded-md bg-muted p-1.5 text-muted-foreground">
                    <item.icon size={15} aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{item.hint}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Always on
                  </span>
                  <Switch
                    checked
                    disabled
                    aria-label={`${item.label} is always available`}
                    className="data-[state=checked]:bg-brand [&_[data-slot=switch-thumb]]:bg-white!"
                  />
                </div>
              </div>
            ))}

            <Separator className="my-3" />

            {/* Configurable access */}
            <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Configurable access
            </p>
            {MENU_KEYS.map((key, i) => {
              const item = MENU_META[key];
              const allowed = perms[key] === true;
              return (
                <motion.div
                  key={key}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.04, duration: 0.25, ease: EASE }}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    allowed ? 'border-brand/25 bg-brand/5' : 'bg-muted/30',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        'shrink-0 rounded-md p-1.5 transition-colors',
                        allowed ? 'bg-brand/10 text-brand' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <item.icon size={15} aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.label}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {allowed ? 'Access granted' : item.hint}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {savingKey === key && (
                      <Loader2 size={13} className="animate-spin text-muted-foreground" aria-hidden />
                    )}
                    <Switch
                      checked={allowed}
                      disabled={savingKey === key}
                      onCheckedChange={(v) => { void toggle(key, v === true); }}
                      aria-label={`${allowed ? 'Revoke' : 'Grant'} ${item.label} access`}
                      className="data-[state=checked]:bg-brand [&_[data-slot=switch-thumb]]:bg-white!"
                    />
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Site access dialog — assign the sites a normal admin can mark attendance for
// ---------------------------------------------------------------------------
function SiteAccessDialog({
  profile, sites, onClose, onChanged,
}: {
  profile: Profile | null;
  sites: SiteWithCount[] | null;
  onClose: () => void;
  onChanged: (profileId: string, siteIds: string[]) => void;
}) {
  const open = profile !== null;
  const [assigned, setAssigned] = useState<Set<string> | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Load the initial assignments each time the dialog opens
  useEffect(() => {
    if (!profile) {
      setAssigned(null);
      return;
    }
    let cancelled = false;
    setAssigned(null);
    setSavingId(null);
    (async () => {
      const ids = await dataApi.getSiteAssignments(profile.id);
      if (!cancelled) setAssigned(new Set(ids));
    })().catch(() => {
      if (!cancelled) {
        setAssigned(new Set());
        toast.error('Failed to load site assignments', { description: 'Please close the dialog and try again.' });
      }
    });
    return () => { cancelled = true; };
  }, [profile]);

  // Toggle one site — optimistic, instantly saved, reverted on failure
  const toggle = async (siteId: string, siteName: string, allowed: boolean) => {
    if (!profile || !assigned) return;
    const previous = new Set(assigned);
    setSavingId(siteId);
    const next = new Set(assigned);
    if (allowed) next.add(siteId);
    else next.delete(siteId);
    setAssigned(next);
    try {
      await dataApi.setSiteAssignment(profile.id, siteId, allowed);
      toast.success(
        allowed ? `${siteName} assigned to ${profile.name}` : `${siteName} removed from ${profile.name}`,
        { description: allowed ? 'They can now mark attendance for this site.' : 'They can no longer mark this site.' },
      );
      onChanged(profile.id, [...next]);
    } catch (err) {
      setAssigned(previous);
      toast.error(err instanceof Error ? err.message : 'Failed to update the site assignment');
    } finally {
      setSavingId(null);
    }
  };

  const activeSites = (sites ?? []).filter((s) => s.is_active);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded-lg bg-emerald-500/10 p-1.5 text-emerald-500">
              <Building2 size={14} aria-hidden />
            </span>
            Assign Sites
          </DialogTitle>
          <DialogDescription>
            Choose the work sites{' '}
            <span className="font-medium text-foreground">{profile?.name}</span> can mark
            attendance for. Every change saves instantly.
          </DialogDescription>
        </DialogHeader>

        {assigned === null || sites === null ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="shimmer h-11 rounded-lg border" />
            ))}
          </div>
        ) : activeSites.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
            No active sites exist yet — create a site first (Sites page) to assign it here.
          </p>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="space-y-1.5 py-1"
          >
            <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sites this admin can mark
            </p>
            {activeSites.map((s, i) => {
              const allowed = assigned.has(s.id);
              return (
                <motion.div
                  key={s.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.04, duration: 0.25, ease: EASE }}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    allowed ? 'border-emerald-500/25 bg-emerald-500/5' : 'bg-muted/30',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-md text-xs font-bold tabular-nums',
                        allowed ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {s.employee_count}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {allowed ? 'Can mark attendance' : `${s.employee_count} employee${s.employee_count === 1 ? '' : 's'} · not assigned`}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {savingId === s.id && (
                      <Loader2 size={13} className="animate-spin text-muted-foreground" aria-hidden />
                    )}
                    <Switch
                      checked={allowed}
                      disabled={savingId === s.id}
                      onCheckedChange={(v) => { void toggle(s.id, s.name, v === true); }}
                      aria-label={`${allowed ? 'Remove' : 'Assign'} ${s.name}`}
                      className="data-[state=checked]:bg-emerald-500 [&_[data-slot=switch-thumb]]:bg-white!"
                    />
                  </div>
                </motion.div>
              );
            })}
            <p className="px-1 pt-1 text-[11px] text-muted-foreground">
              Idle employees (no site) can only be marked by super admins.
            </p>
          </motion.div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
