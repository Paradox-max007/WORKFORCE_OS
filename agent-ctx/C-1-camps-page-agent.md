# C-1 — Camps Page (Camp Management module)

**Task ID:** C-1 · **Agent:** camps-page agent · **Status:** ✅ Complete

## What was built

Fully implemented `/home/z/my-project/src/components/camps/camps-page.tsx`
(`CampsPage`, no props) — the Camps module of PULSE Workforce OS. This is the
ONLY file modified; the page was already wired in `src/app/page.tsx` (view
`'camps'`), sidebar (Tent icon) and `MENU_KEYS` gating.

### Components in the file
| Component | Purpose |
|---|---|
| `CampsPage` | Main view switcher: list ⇆ residents sub-view (`AnimatePresence mode="wait"` slide, like sites-page) |
| `StatChip` | Small summary chip with `AnimatedCounter` (Total Camps / Active Camps / Employees Housed) |
| `CampCard` | card-glow grid tile: Tent tile (brand when active / zinc when inactive), name, created date, location, capacity ("N beds" / "No limit"), notes (line-clamp-2), residents badge, View Residents (Eye), toggle active (Power/PowerOff + per-card busy spinner), Edit (Pencil), Delete (Trash2). Stagger `initial={{opacity:0,y:8}}`, `delay i*0.05` capped, `whileHover y:-4`, exit animation wrapped in `AnimatePresence` |
| `CampFormDialog` | Create/Edit: name (required), location, capacity (number, NaN/negative guarded), notes (Textarea). Save disabled while busy/unchanged/invalid |
| `MoveResidentDialog` | Shared per-row + bulk "move to another active camp" dialog (Select destinations + `__none__` = "No camp" for per-row). Fully controlled (`target` prop) to satisfy `react-hooks/set-state-in-effect` |
| `CampResidentsView` | Per-camp sub-view: Back button, Tent header, occupants badge, capacity usage bar (animated width; amber >85%, rose when full), EmployeeCombobox to add/transfer residents (disabled when camp inactive — inactive camps stop accepting new residents), alphabetical residents list (desktop Table + mobile cards), per-row Move (ArrowLeftRight) + Remove (UserMinus with confirm), checkbox multi-select + bulk "Move Selected" / "Remove Selected" |

## dataApi calls used (all as specified)
- `listCamps()` + `listEmployees()` — fetched together, refetch keyed on
  `useRealtimeVersion(['camp','employee'])`
- `createCamp(name, location, capacity, notes)`
- `updateCamp(id, { name, location, capacity, notes, is_active })` — used for
  edits AND the activate/deactivate toggle (deactivate keeps residents)
- `deleteCamp(id)` — destructive AlertDialog warns "N employee(s) will be left
  without a camp — they are NOT deleted"
- `assignEmployeeCamp(employeeId, campId | null)` — add / move / bulk move /
  remove (data layer unassigns the previous camp automatically)

## Domain rules mirrored in UI
- One employee ↔ at most one camp; transfers are instant.
- Deactivated camps: assignments kept, add-picker disabled, excluded from move
  destinations (data layer would reject them anyway).
- Delete unassigns employees, never deletes them.

## Verification results
1. `bunx tsc --noEmit 2>&1 | grep "camps-page"` → **no output** (exit 1 = 0 matches) ✅
2. `bunx eslint src/components/camps/camps-page.tsx --no-warn-ignored` → **0 errors, 0 warnings** (exit 0) ✅
3. `dev.log` tail → repeated `✓ Compiled` + `GET / 200` after saving; **no module
   errors**, no `camps-page` mentions, no `Module not found` / `Syntax error` in log ✅

## Deviations / notes for future agents
- **MoveResidentDialog is fully controlled** (destination lives in parent state,
  reset in open handlers) — the sites-page-style `useEffect(() => { if (open)
  setTarget('') })` reset trips the new `react-hooks/set-state-in-effect` rule
  in this project's eslint config. (The multi-setState form-reset effect in
  `CampFormDialog` — copied verbatim from sites-page `SiteFormDialog` — passes.)
- Capacity `0` is treated as "No limit" for the usage bar (avoids division by
  zero); capacity is stored/edited as-is otherwise.
- Grid loading uses `SkeletonRows rows={6}` per spec (sites-page uses card
  skeletons); sub-view loading uses 4 skeleton cards per spec.
- Per-row move of a selected resident also drops it from the bulk selection to
  avoid a stale bulk "Remove Selected" acting on the employee's new camp.
- No role gating (sidebar 'camps' permission is the only gate, per spec) — so
  unlike sites-page there is no `useAuthStore` import.
- Verify a `camp` can be seen by a user with the `camps` menu permission in
  the sidebar; API-level access is identical to Sites.
