'use client';

// ============================================================================
// PULSE Workforce OS — Shared branch-scope hook
// ----------------------------------------------------------------------------
// ONE place that answers "what may this admin see?" for the branch-scoped
// pages (Working Hours, Leave Requests, Cancellations, Notifications,
// Uniform Registry, Advance Book…). It mirrors the scoping model the
// Employees page established:
//
//   • super admins → everything;
//   • normal admins with the employees_all_branches grant → everything;
//   • every other normal admin → the sites of their GRANTED branches
//     (listBranches is already scoped) PLUS any directly assigned sites
//     (Admin Management → Site Access). An employee belongs to the owner
//     branch of their CURRENT site — idle employees belong to no branch and
//     stay super-admin / all-branches only.
//
// Menu-level access stays separate: the page itself only renders when the
// admin holds the menu permission; this hook scopes the DATA once they are in.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { dataApi } from '@/lib/data';
import type { BranchWithCount, EmployeeVM, Site } from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';

export interface BranchScope {
  /** reference data loaded (branches / sites / assignments) */
  ready: boolean;
  isSuperAdmin: boolean;
  /** super admin or the employees_all_branches grant → unrestricted view */
  viewAllEmployees: boolean;
  /** branches the viewer may access (granted branches; every branch for a
   *  super admin) */
  branches: BranchWithCount[];
  /** every site (for the site → owner-branch mapping) */
  sites: Site[];
  /** site id → owning branch id (null = the site has no branch) */
  branchIdOfSite: Map<string, string | null>;
  /** branch id → name */
  branchNameOf: Map<string, string>;
  /** an employee's branch = the owner branch of their CURRENT site */
  branchIdOfEmployee: (e: { current_site_id: string | null }) => string | null;
  /** sites a normal admin may see (granted-branch sites + direct
   *  assignments); null = unrestricted (super admin / all-branches grant) */
  effectiveSiteIds: Set<string> | null;
  /** true when the employee is inside the viewer's branch scope (idle
   *  employees belong to no branch — super admin / all-branches only) */
  employeeInScope: (e: EmployeeVM) => boolean;
}

export function useBranchScope(): BranchScope {
  const user = useAuthStore((s) => s.user);
  const menuPermissions = useAuthStore((s) => s.menuPermissions);
  const isSuperAdmin = user?.role === 'super_admin';
  const viewAllEmployees = isSuperAdmin || menuPermissions?.employees_all_branches === true;

  // grants / sites / assignments refresh live (branch grants change → every
  // scoped page follows on the next render)
  const version = useRealtimeVersion(['site', 'branch', 'admin_branch', 'admin_site', 'profiles']);

  const [branches, setBranches] = useState<BranchWithCount[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [assignedSiteIds, setAssignedSiteIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [brs, sts] = await Promise.all([
        // listBranches is server-scoped: super admin → every branch, normal
        // admin → only the branches granted to them
        dataApi.listBranches().catch(() => [] as BranchWithCount[]),
        dataApi.listSites().catch(() => [] as Site[]),
      ]);
      if (cancelled) return;
      setBranches(brs);
      setSites(sts);
    })();
    return () => { cancelled = true; };
  }, [version]);

  // normal admins: directly assigned sites (Site Access) join the scope
  // (super admins / signed-out users fetch nothing — their derived scope
  // below is already unrestricted)
  useEffect(() => {
    if (isSuperAdmin || !user) return;
    let cancelled = false;
    dataApi.getSiteAssignments(user.id)
      .then((ids) => { if (!cancelled) setAssignedSiteIds(new Set(ids)); })
      .catch(() => { if (!cancelled) setAssignedSiteIds(new Set()); });
    return () => { cancelled = true; };
  }, [user, isSuperAdmin, version]);

  const branchIdOfSite = useMemo(
    () => new Map((sites ?? []).map((s) => [s.id, s.branch_id ?? null] as const)),
    [sites],
  );
  const branchNameOf = useMemo(
    () => new Map((branches ?? []).map((b) => [b.id, b.name] as const)),
    [branches],
  );

  // EFFECTIVE site scope: granted-branch sites + direct assignments
  // (null = unrestricted — super admin or the all-branches grant)
  const effectiveSiteIds = useMemo<Set<string> | null>(() => {
    if (viewAllEmployees) return null;
    const set = new Set(assignedSiteIds ?? []);
    const granted = new Set((branches ?? []).map((b) => b.id));
    (sites ?? []).forEach((s) => {
      if (s.branch_id && granted.has(s.branch_id)) set.add(s.id);
    });
    return set;
  }, [viewAllEmployees, assignedSiteIds, branches, sites]);

  const branchIdOfEmployee = useMemo(
    () => (e: { current_site_id: string | null }): string | null =>
      (e.current_site_id ? branchIdOfSite.get(e.current_site_id) ?? null : null),
    [branchIdOfSite],
  );

  const employeeInScope = useMemo(
    () => (e: EmployeeVM): boolean => {
      if (effectiveSiteIds === null) return true;
      return e.current_site_id !== null && effectiveSiteIds.has(e.current_site_id);
    },
    [effectiveSiteIds],
  );

  return {
    ready: branches !== null && sites !== null,
    isSuperAdmin,
    viewAllEmployees,
    branches: branches ?? [],
    sites: sites ?? [],
    branchIdOfSite,
    branchNameOf,
    branchIdOfEmployee,
    effectiveSiteIds,
    employeeInScope,
  };
}
