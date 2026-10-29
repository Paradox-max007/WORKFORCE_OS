# Task P-1 — Sites Page (sites agent)

**Task ID:** P-1
**Agent:** sites-agent
**Scope:** EXACTLY 1 new file — `src/components/sites/sites-page.tsx` (export `SitesPage`, no props). No other files touched. Wired already via `src/app/page.tsx` (`sites: <SitesPage />`).

## What was implemented

### 1. Sites list view
- `PageHeader` ("Sites" / "Manage work sites and the crews assigned to each location") + brand-gradient
  "New Site" button (Plus icon, `shadow-[var(--glow)]`).
- `Tabs` Active / Inactive with live counts (emerald / zinc chips), shared debounced search
  (300 ms; matches `name`, `client_name`, `project_name`, clear "X" button). Both tabs render a
  responsive card grid (`sm:grid-cols-2 xl:grid-cols-3`) inside the standard
  `card-glow rounded-xl border bg-card` container.
- Loading → 6-card skeleton grid (`ui/Skeleton`); empty → `EmptyState` (different copy per
  tab / search, CTA "New Site" on the active tab).
- **Site cards** (motion stagger `delay i*0.05`, `whileHover y:-4`, `card-glow`): Building2 icon
  tile (emerald when active / zinc when inactive), name, `Created {fmtDate}`, client + project
  lines, employee-count badge (+ "Inactive" badge), actions: toggle active (PowerOff amber /
  Power emerald, per-card spinner via `togglingId`), edit (Pencil, brand hover),
  **delete (Trash2, super_admin only — mirrors employee-page's hard-delete guard)**, and
  **View Employees** (Eye) + **Attendance Sheet** (FileSpreadsheet) buttons.

### 2. Site dialogs
- **Create / Edit** `SiteFormDialog` (one dialog, `editing` prop): name required (trimmed),
  client, project; Enter submits; Save disabled while busy or unchanged (edit); toasts;
  `dataApi.createSite(name, client, project)` / `dataApi.updateSite(id, {...})`.
- **Deactivate AlertDialog**: amber warning box listing the actual `employee_count`
  ("N employee(s) will be set to idle/unassigned", leader status cleared, moved to Inactive tab);
  confirm → `updateSite(..., is_active: false)` → toast **including `unassignedCount`**.
- **Activate**: direct call + success toast (no dialog). **Delete AlertDialog**: destructive
  rose, wording "Employees assigned to this site will be unassigned (not deleted)."
  → `deleteSite(id)`.

### 3. Per-site employees sub-view (`SiteEmployeesView`)
- `AnimatePresence mode="wait"` slide transitions between list ⇆ sub-view (and back button).
- Site header (brand tile + name + count badge + client/project/created meta) with
  **Team Leader callout** (Crown, amber chip, leader = `is_team_leader && team_leader_site_id === site.id`,
  or a muted "No team leader assigned").
- **Add Employee** via shared `EmployeeCombobox` (active employees not on this site; shows their
  current site / idle). Selecting → `dataApi.updateEmployee(id, full EmployeeInput)` with
  `current_site_id: site.id` → toast "Employee transferred — … from X to Y" / "Employee added".
  `toEmployeeInput(emp, overrides)` builds the FULL `EmployeeInput` from the `EmployeeVM`
  (all fields passed through; only site/leader fields overridden) — mirrors employee-page.
- Crew card: `SectionTitle` + employee search; desktop `Table` / mobile cards (motion rows);
  columns: checkbox (select-all with `indeterminate`), Employee (avatar/photo + name + crown TL
  badge + nationality), ID (mono), Position, `RatingStars`, `EmployeeStatusBadge`; rows sorted
  team-leader-first; selected rows highlighted `bg-brand/5`.
- **Remove Selected** (UserMinus, shows count) → AlertDialog → for each selected employee
  `updateEmployee(id, input)` with `current_site_id: null` + cleared `is_team_leader` /
  `team_leader_site_id` **when they lead this site** → toast.

### 4. Attendance sheet (`AttendanceSheetView`) — full-screen fixed overlay (z-50, motion, Esc closes)
- Toolbar: Back, site/page summary, **Download PDF** (`exportElementToPdf`) and **Print**
  (`printElement`) with busy state + toasts.
- **Preview**: exact A4 pages (794×1123) auto-scaled to the viewport (ResizeObserver), white
  bg / black text / `print-color-adjust: exact`, Times New Roman info section, everything
  uppercase. Rebranded header band: "PULSE WORKFORCE OS LLC." + DAILY ATTENDANCE band
  (#bbbcbd) + inline-SVG logo (html2canvas-safe, survives `outerHTML` copying).
- **Editable header fields**: • CLIENT NAME / PROJECT NAME / DATE (DD/MM/YYYY, default today) /
  STRENGTH (default = employee count). Subsequent pages render a compact header +
  CLIENT/PROJECT/DATE line.
- **Main table** SL. NO / NAME / EMP. CODE / TRADE / SIGNATURE with inline editable cells
  (uppercase; TRADE shows `position / TL` / `position / SUPERVISOR`, suffix stripped on edit;
  editing position re-detects supervisors and re-sorts). Sorting: team leaders (of this site)
  first, then supervisors, then alphabetical. Row colors: TL `#fffbeb`, supervisor `#eff6ff`
  (blue tint is the mandated sheet convention), zebra `#f3f4f6`.
- **"EXTRA EMPLOYEES (IF ANY)"** table with **5 blank numbered rows** (serial continues after
  the crew) on the last page — cells are editable too.
- **Pagination**: 18 rows on the first page, 24 on subsequent pages; footer "PAGE X OF Y".
- **Export architecture**: the sheet is rendered three times from one `renderPage()` closure —
  (1) visible interactive pages (inputs), (2) a hidden **print copy** (text cells, true-A4
  794×1122 pages, `page-break-after: always`) whose root contains an embedded
  `<style>{ATT_CSS}</style>` (scoped `.att-sheet …`) so `printElement`'s `outerHTML` iframe
  stays fully styled, and (3) a hidden **PDF copy** where each page sits in an 800×1148 wrapper
  so that at html2canvas scale 2 every wrapper maps to exactly 287 mm — the slice height used
  by `exportElementToPdf` — making each jsPDF page align perfectly with one sheet page.
  Positioning is on wrapper/ancestors only, never inline on the captured/copied roots.
- Employees = non-deleted `current_site_id === site.id` from `dataApi.listEmployees()`.

### 5. Realtime
- `useRealtimeVersion(['site', 'employee'])` drives the list+employees fetch effect — own and
  remote mutations re-render everything (deactivate while viewing its crew empties it; site
  delete closes the sub-view/sheet gracefully).

## Deviations / notes
- **Role gating**: legacy sites page had no per-action role checks, so only **delete** is gated
  to super_admin (consistent with the employees module's hard-delete guard); toggle/edit/create
  remain available to anyone with the sites menu (menu gating is global).
- Sheet EMP. CODE cells are **pre-filled** with `employee_code` (legacy left them blank);
  still fully editable. Extra rows + signature cells persist edits in-session (legacy had
  no-op handlers). Team-leader styling/sorting in the sheet is scoped to leaders *of this site*
  (legacy used the raw flag; the sub-view sorted scoped — kept the scoped semantics).
- Company header rebranded ARABIAN SHIELD MANPOWER → **PULSE WORKFORCE OS LLC.** and the ASM
  logo → the PULSE gradient logo (inline SVG, safe for html2canvas + print iframe).
- Did not use `StatCard`s (legacy page had none; feature list didn't request them). Loading
  uses a skeleton card grid; `SkeletonRows` not needed (no row-list loading state on this page).
- `togglingId` guards double-clicks on activate; all mutations have busy spinners + error toasts.

## Verification
- `bunx tsc --noEmit 2>&1 | grep "sites-page"` → **NOTHING (0 errors)**. Remaining project-wide
  tsc errors are pre-existing and outside this task's scope (`examples/websocket/*`,
  `skills/*`, `src/store/realtime.ts:58` 'supabase possibly null').
- `bunx eslint src/components/sites/sites-page.tsx --no-warn-ignored` → **0 errors, 0 warnings**.
- Dev server: module resolves, `GET / 200`, no compile errors in `dev.log`.
