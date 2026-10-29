# Task P-2 — Attendance page (attendance agent)

**Task ID:** P-2
**Agent:** attendance-agent
**Scope:** EXACTLY 1 new file — no other files touched.

## File created

- `src/components/attendance/attendance-page.tsx` → exports `AttendancePage` (no props).

The import in `src/app/page.tsx` already existed — no changes needed there.

## What was implemented (legacy feature parity, PULSE design language)

### List view (matrix)
- Employees × days matrix inside a `card-glow` card with horizontal scroll (`overflow-x-auto` +
  `min-w-max`), `role="grid/row/gridcell/columnheader"` semantics.
- **Current month**: days 1→today **reversed (today leftmost)**; header shows day number + relative
  label (Today / Yesterday / "N days ago" for ≤6 days ago, emerald) or weekday abbreviation otherwise.
  **Past months**: 1..last day. Future months (reachable via year select) render dimmed, non-clickable.
- **Friday columns tinted** (computed locally via `new Date(y, m-1, d).getDay() === 5` →
  `bg-rose-500/[0.04]`, rose header text). **Last-7-days subtle tint** (`bg-emerald-500/[0.05]`).
- **Sticky employee column** (left) + **sticky OT total column** (right) so they stay visible while
  scrolling days. Employee cell: brand initials avatar / photo, name, mono code, `SiteBadge`
  ("Idle · No Site" for idle employees).
- **OT total per employee** = sum of `overtime_hours` for the month (purple `Nh`, tooltip).
- Debounced employee search (name / code / position / nationality / site, 300 ms) +
  **searchable site filter** (Popover + Command, filters employees by `current_site_id`, per-site
  employee count shown, "All Sites" entry, active sites or sites with employees only).
- Pagination 20/page with the numbered pattern (« ‹ 1..5 › »), clamped `safePage`,
  "Showing X of Y employee(s)" counter, status legend (4 statuses + Friday + Last 7 days swatches),
  Reset button while filters are active.

### Calendar view
- Shared `EmployeeCombobox` (searchable, site info per item) + **SiteBadge / per-status count chips**
  (dot + count + label, colors from `ATTENDANCE_STATUSES`; non-future days only).
- 7-column grid **Sunday first**, `gap-px bg-border/50` grid lines, **Friday red-tinted**
  (cell + weekday header), today highlighted (`ring-brand/50`, brand day number).
- **Future days dimmed (`opacity-45`) and non-editable** (dashed placeholder, no popover).
- **Overtime hours shown under the cell** when set (`Nh`, purple).

### Status popover (click any past cell, list or calendar)
- Fixed-position popover (position from button `getBoundingClientRect()`, opens above/below,
  clamped to viewport) with backdrop click-away + Escape; framer-motion scale/opacity pop in/out.
- The 4 statuses from `ATTENDANCE_STATUSES` (colored dot + label + check for selection);
  when `overtime` selected → **overtime hours input (default "2", min 0, max 24, step 0.5)** with
  animated height reveal.
- Save → `dataApi.markAttendance(employeeId, date, status, hours|null)` + **optimistic local upsert**
  (revert on failure) + spinner while busy + sonner success/error toast.
- Cells are small colored squares/short labels (P/A/O/NS) with `title`/`aria-label` tooltip of the
  full status (+ OT hours); **clicking future dates does nothing** (guard + non-interactive render).

### Defaults & data
- Missing records default to `present` if the employee has a `current_site_id`, else `no_site`
  (matches server auto-creation). Records with `not_marked` fall back to the same default.
- Fetch via `dataApi.getMonthAttendance(monthKey)` + `listEmployees()` + `listSites()`, keyed on
  `[monthKey, version]`; loading → `SkeletonRows` (list) / skeleton grid (calendar).
- **Realtime**: `const version = useRealtimeVersion(['attendance', 'employee'])` — re-fetch on change
  (own marks re-sync through it; no flicker since state only updates after resolve).

### Month navigation
- Prev/next buttons (**next disabled at current month**) + month label chip + month select +
  **year select (current−2 … current+1)** — all state kept as a single `'YYYY-MM'` key.

### Design rules honored
- `'use client'`; shadcn/ui (tabs, button, input, label, select, popover, command, skeleton) +
  shared primitives (PageHeader, EmptyState, SkeletonRows, SiteBadge) + EmployeeCombobox.
- framer-motion: staggered row entrance (capped delay), animated status cell changes (keyed
  `StatusLabel` spring scale-pop + color transitions), `AnimatePresence mode="wait"` view switching.
- Tokens only: `bg-card`, `bg-muted`, `text-muted-foreground`, `brand-gradient`, `card-glow`,
  `bg-brand/15`, `text-brand`; status colors emerald/rose/purple/amber from ATTENDANCE_STATUSES —
  **no raw blue/indigo**. Toasts via sonner. Fully responsive (wrapping toolbar, horizontal-scroll
  matrix, cards/skeletons on mobile).

## Deviations from legacy (intentional)
1. Legacy's separate Employee/ID/Site matrix columns merged into one sticky employee cell
   (avatar + name + code + SiteBadge) — cleaner on mobile.
2. Legacy's custom search inputs (SearchableEmployeeSelect / SiteFilter) replaced by the shared
   `EmployeeCombobox` and a Popover+Command site filter — consistent PULSE pattern.
3. Employee name search hidden in calendar view (legacy disabled it with an overlay hint); the
   combobox provides its own search.
4. Extra niceties beyond parity: sticky employee/OT columns, weekday labels in matrix headers,
   today highlight in calendar, per-site employee counts, Reset filters button, "Last 7 days"
   legend entry.
5. Legacy fetched paginated employees from an API endpoint; here `listEmployees()` returns all
   and pagination/search/site filtering happen client-side (matches the demo/prod DataApi surface).

## Verification
- `cd /home/z/my-project && bunx tsc --noEmit 2>&1 | grep "attendance-page"` → **NOTHING (clean)**.
  (Remaining project errors are only other agents' missing modules — admins/sites/uniform-registry
  pages — plus `src/store/realtime.ts` TS18047 and examples/skills files; all outside my scope.)
- `bunx eslint src/components/attendance/attendance-page.tsx --no-warn-ignored` → **PASS
  (0 errors, 0 warnings)**.
- Dev log: the previous "Can't resolve '@/components/attendance/attendance-page'" entry is resolved
  by this file; the dev server page bundle still waits on the other agents' missing pages.

## Notes for other agents
- `dataApi.markAttendance` auto-adjusts employee rating (±0.2/hour OT delta) and auto-creates a
  warning after 3 consecutive absences (skipping Fridays) — it emits `attendance` (and possibly
  `warning`/`notification`), so pages depending on those tables should subscribe to them.
