// ============================================================================
// PULSE Workforce OS — Pebby access scope (src/lib/ai/scope.ts)
// ----------------------------------------------------------------------------
// ONE place that answers "what may THIS viewer see through Pebby?" — the AI
// equivalent of the shared useBranchScope hook the pages use:
//
//   • super admins → everything (unrestricted);
//   • normal admins with the employees_all_branches grant → everything;
//   • every other normal admin → the sites of their GRANTED branches
//     (listBranches is already server-scoped) PLUS directly assigned sites
//     (Admin Management → Site Access). An employee belongs to the owner
//     branch of their CURRENT site — idle employees belong to no branch.
//
// Every Pebby surface consumes the SAME resolved scope:
//   • buildAiKnowledgeBase(scope)  — the per-question snapshot
//   • buildAiSystemPrompt(kb, s, scope) — identity + VIEWER ACCESS section
//   • runAiQuery(spec, scope)      — the [[QUERY]] engine
//   • the widget's [[LOOKUP]] rounds (employees / attendance / salary /
//     site-docs / doc-content)
// So a branch-scoped admin can never get a global search result from the DB:
// employees, sites, attendance, payroll, salary sheets, advances, uniforms,
// warnings, fines, letters and documents of OTHER branches simply do not
// exist in anything Pebby reads.
//
// The connection itself stays shared: the super admin saves the AI
// credentials once on the Site Settings page and every admin chats through
// them (the proxy reads the stored key server-side — raw keys never reach
// the browser); what changes per user is the DATA, scoped here.
// ============================================================================

import { dataApi } from '@/lib/data';
import type {
  BranchWithCount, EmployeeVM, MenuPermissionMap, PayrollEmployeeVM, Profile, Role,
  SalarySheetReport, SiteWithCount,
} from '@/lib/types';

/** Everything Pebby is allowed to show one viewer — one serializable object. */
export interface AiScope {
  /** viewer identity (also embedded in the system prompt) */
  viewerName: string;
  viewerRole: Role;
  /** super admin / employees_all_branches grant → sees everything */
  unrestricted: boolean;
  /** branches the viewer may access (granted branches; all for super admins) */
  branches: BranchWithCount[];
  /** sites inside the effective scope (granted-branch sites + direct
   *  assignments); every site when unrestricted */
  sites: SiteWithCount[];
  /** in-scope roster + cancelled employees (ALL of them when unrestricted) */
  employees: EmployeeVM[];
  cancelledEmployees: EmployeeVM[];
  /** null = unrestricted (predicates always true); otherwise the exact ids /
   *  codes Pebby may reveal */
  siteIds: Set<string> | null;
  siteNames: Set<string> | null;
  employeeIds: Set<string> | null;
  employeeCodes: Set<string> | null;
  /** granted branch names (for the prompt + welcome text) */
  grantedBranchNames: string[];
  /** directly assigned site names (Admin Management → Site Access) */
  directSiteNames: string[];
  /** predicates — always true when unrestricted */
  employeeByIdInScope: (id: string | null | undefined) => boolean;
  employeeByCodeInScope: (code: string | null | undefined) => boolean;
  siteNameInScope: (name: string | null | undefined) => boolean;
  /** a salary-sheet report narrowed to the scope (employees + recomputed
   *  totals + in-scope site groups) — untouched when unrestricted */
  scopeSalaryReport: (report: SalarySheetReport | null) => SalarySheetReport | null;
}

/** Raw inputs for buildAiScope (pure — testable without a browser session). */
export interface AiScopeInput {
  viewerName: string;
  viewerRole: Role;
  unrestricted: boolean;
  /** granted branches — dataApi.listBranches() is already server-scoped */
  branches: BranchWithCount[];
  /** every site the viewer can read (site → owner-branch mapping) */
  allSites: SiteWithCount[];
  /** directly assigned site ids (Admin Management → Site Access) */
  assignedSiteIds: Set<string>;
  /** the full roster (unfiltered) */
  employees: EmployeeVM[];
  /** the full cancelled roster (unfiltered) */
  cancelledEmployees: EmployeeVM[];
}

/** Pure scope builder — resolves the effective site / employee sets and the
 *  scoping predicates. No I/O, so bun scripts can test it with synthetic
 *  inputs while the browser path (resolveAiScope) fetches the real data. */
export function buildAiScope(input: AiScopeInput): AiScope {
  const {
    viewerName, viewerRole, unrestricted, branches, allSites,
    assignedSiteIds, employees, cancelledEmployees,
  } = input;

  // EFFECTIVE site scope: sites of GRANTED branches + direct assignments.
  // (null = unrestricted — super admin or the all-branches grant.)
  const grantedBranchIds = new Set(branches.map((b) => b.id));
  const siteIds = unrestricted
    ? null
    : new Set([
        ...assignedSiteIds,
        ...allSites
          .filter((s) => s.branch_id !== null && grantedBranchIds.has(s.branch_id))
          .map((s) => s.id),
      ]);

  const sites = siteIds === null ? allSites : allSites.filter((s) => siteIds.has(s.id));
  const siteNames = siteIds === null ? null : new Set(sites.map((s) => s.name));

  // an employee is in scope when their CURRENT site is (idle employees belong
  // to no branch — super admin / all-branches only), mirroring the pages
  const employeeIn = (e: EmployeeVM): boolean =>
    siteIds === null || (e.current_site_id !== null && siteIds.has(e.current_site_id));
  const scopedEmployees = employees.filter(employeeIn);
  const scopedCancelled = cancelledEmployees.filter(employeeIn);

  const employeeIds = unrestricted
    ? null
    : new Set([...scopedEmployees, ...scopedCancelled].map((e) => e.id));
  const employeeCodes = unrestricted
    ? null
    : new Set([...scopedEmployees, ...scopedCancelled].map((e) => e.employee_code.toUpperCase()));

  const employeeByIdInScope = (id: string | null | undefined): boolean => {
    if (employeeIds === null) return true;
    return typeof id === 'string' && employeeIds.has(id);
  };
  const employeeByCodeInScope = (code: string | null | undefined): boolean => {
    if (employeeCodes === null) return true;
    return typeof code === 'string' && employeeCodes.has(code.trim().toUpperCase());
  };
  const siteNameInScope = (name: string | null | undefined): boolean => {
    if (siteNames === null) return true;
    return typeof name === 'string' && siteNames.has(name);
  };

  /** Narrow a salary-sheet report to the scope: in-scope settlement rows,
   *  site groups of in-scope sites only, totals recomputed from the scoped
   *  rows (another branch's amounts never leak through the totals line). */
  const scopeSalaryReport = (report: SalarySheetReport | null): SalarySheetReport | null => {
    if (unrestricted || !report || !report.exists) return report;
    const rows = report.employees.filter((p) =>
      (p.sites ?? []).some((s) => s.site_id !== null && siteIds?.has(s.site_id)),
    );
    const totals = {
      employees: rows.length,
      total_hours: 0,
      gross_salary: 0,
      advances: 0,
      deductions: 0,
      net_payable: 0,
      paid_count: 0,
      unpaid_count: 0,
    };
    for (const p of rows) {
      totals.total_hours += p.total_hours ?? 0;
      totals.gross_salary += p.gross_salary ?? 0;
      totals.advances += p.advance ?? 0;
      totals.deductions += p.deduction ?? 0;
      totals.net_payable += p.net_salary ?? 0;
      if (p.payment_status === 'paid') totals.paid_count += 1;
      else totals.unpaid_count += 1;
    }
    // site groups: only the viewer's sites survive (a group aggregates that
    // one site's employees, so its own numbers stay correct as-is)
    const siteGroups = (report.sites ?? []).filter(
      (g) => g.site_id !== null && g.site_id !== undefined && siteIds?.has(g.site_id),
    );
    return { ...report, employees: rows, totals, sites: siteGroups };
  };

  return {
    viewerName,
    viewerRole,
    unrestricted,
    branches,
    sites,
    employees: scopedEmployees,
    cancelledEmployees: scopedCancelled,
    siteIds,
    siteNames,
    employeeIds,
    employeeCodes,
    grantedBranchNames: branches.map((b) => b.name),
    directSiteNames: allSites.filter((s) => assignedSiteIds.has(s.id)).map((s) => s.name),
    employeeByIdInScope,
    employeeByCodeInScope,
    siteNameInScope,
    scopeSalaryReport,
  };
}

/** Resolve the scope of the signed-in viewer (browser path). Fetches the
 *  reference lists ONCE per question and delegates to buildAiScope; the
 *  knowledge base then reuses scope.employees / sites / branches instead of
 *  refetching, so the scoped snapshot costs exactly what the global one did.
 *
 *  A missing user resolves UNRESTRICTED — the widget never renders without a
 *  signed-in user, so this is unreachable in practice (and the proxy still
 *  verifies the caller server-side in Supabase mode). */
export async function resolveAiScope(
  user: Profile | null,
  menuPermissions: MenuPermissionMap | null,
): Promise<AiScope> {
  const isSuperAdmin = user?.role === 'super_admin';
  const unrestricted = isSuperAdmin || menuPermissions?.employees_all_branches === true;

  const [branches, allSites, employees, cancelledEmployees, assigned] = await Promise.all([
    // listBranches is server-scoped: super admin → every branch, normal
    // admin → only the branches granted to them
    dataApi.listBranches().catch(() => [] as BranchWithCount[]),
    dataApi.listSites().catch(() => [] as SiteWithCount[]),
    dataApi.listEmployees().catch(() => [] as EmployeeVM[]),
    dataApi.listCancelledEmployees().catch(() => [] as EmployeeVM[]),
    // directly assigned sites join the scope (super admins fetch nothing)
    (unrestricted || !user
      ? Promise.resolve([] as string[])
      : dataApi.getSiteAssignments(user.id).catch(() => [] as string[])
    ),
  ]);

  return buildAiScope({
    viewerName: user?.name ?? 'Admin',
    viewerRole: user?.role ?? 'admin',
    unrestricted,
    branches,
    allSites,
    assignedSiteIds: new Set(assigned),
    employees,
    cancelledEmployees,
  });
}

/** Human-readable one-liner of the viewer's access for the system prompt and
 *  the chat welcome text, e.g. "everything (super admin)" or
 *  "branches: Northern, Marina (sites: 4) + direct sites: Airport Tower". */
export function describeScope(scope: AiScope): string {
  if (scope.unrestricted) {
    return scope.viewerRole === 'super_admin'
      ? 'everything (super admin — every branch, every site)'
      : 'every branch (All Branches grant)';
  }
  const bits: string[] = [];
  if (scope.grantedBranchNames.length > 0) {
    bits.push(`branches: ${scope.grantedBranchNames.join(', ')}`);
  }
  if (scope.directSiteNames.length > 0) {
    bits.push(`direct sites: ${scope.directSiteNames.join(', ')}`);
  }
  return bits.length > 0 ? bits.join(' + ') : 'no branch or site grants';
}
