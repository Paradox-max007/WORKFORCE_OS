# Task 2-c — Leave Requests + Cancellation Requests modules (frontend agent)

**Task ID:** 2-c
**Agent:** frontend-agent (leave & cancellation modules)
**Scope:** EXACTLY 2 new files, no other files touched.

## Files created

1. `src/components/leave-requests/leave-request-page.tsx` → exports `LeaveRequestPage`
2. `src/components/cancellation-requests/cancellation-request-page.tsx` → exports `CancellationRequestPage`

Both are wired into `src/app/page.tsx` (imports already existed — no changes were needed there).

## What was implemented

### LeaveRequestPage
- `PageHeader` ("Leave Requests" / "Review and manage employee leave applications") + brand-gradient
  "New Leave Request" button with `CalendarPlus` icon.
- 4 `StatCard`s (grid-cols-2 md:grid-cols-4): Total (FileText/brand), Pending (Clock/amber),
  Approved (CheckCircle2/emerald), Rejected (XCircle/rose) — each wrapped in a `motion.div`
  with `initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} delay i*0.04`.
- Filters: debounced search (300 ms; matches employee_name, employee_code, leave_type + its
  label, other_type_text, reason), status `Select` (all/pending/approved/rejected), a Reset
  button that only renders while a filter is active, and an "x of y request(s)" counter.
- Desktop: shadcn `Table` with animated `motion.tr` rows. Columns: Employee (brand initials
  avatar + name + mono code), Leave Type (colored chip — brand/rose/emerald/amber/fuchsia/zinc
  per `LEAVE_TYPE_CHIP`), Duration (`{n} day(s)` + small `fmtDate` range), Reason (truncate),
  Status (`RequestStatusBadge`), Created (`fmtDate` + "by {created_by_name ?? 'System'}"),
  Documents (3 icon buttons → `downloadLeavePdf` / `openLeavePrintWindow` /
  `shareLeaveViaWhatsApp` with .catch toast), Review (super_admin + pending only → emerald
  Check / rose X icon buttons).
- Mobile (<md): card list with the same info + actions.
- New Leave Request `Dialog`: shared `EmployeeCombobox` (active employees only),
  `LEAVE_TYPES` Select with conditional required "Specify Leave Type" Input when value is
  `other`, Start/End date inputs (end has `min={startDate}`), read-only auto Total Days
  (`diff + 1`, min 1, recomputed via useMemo when dates change), required Reason textarea.
  Submit → `dataApi.createLeaveRequest(...)` with `other_type_text: other ? text : null`,
  toasts, dialog closes on success.
- Review flow: controlled `AlertDialog` (custom Buttons, not AlertDialogAction, so the dialog
  stays open during the async review) → `dataApi.reviewLeaveRequest(id, approve)` with
  success/error toasts.
- Live updates: `useRealtimeVersion(['leave_request'])` in the loading-effect deps.
- Loading: stat `Skeleton`s + `SkeletonRows`; empty list → `EmptyState` (with CTA when no
  filters are active).

### CancellationRequestPage
- `PageHeader` ("Cancellation Requests" / "Employee removal workflow — approvals required
  before deletion") + amber-styled "New Cancellation Request" button with `Ban` icon.
- 4 `StatCard`s: Total (FileX2/brand), Pending (Clock/amber), Approved (CheckCircle2/emerald),
  Rejected (XCircle/rose), same stagger animation.
- Filters: debounced search (employee name/code/reason/requested_by_name), status Select,
  conditional Reset, counter.
- Desktop table columns: Employee (initials + name + mono code + position small),
  Employee Status (`EmployeeStatusBadge`), Reason (or italic muted "No reason provided"),
  Request Status (`RequestStatusBadge`), Requested By (name), Created (`fmtDate`),
  Review Actions (super_admin + pending only): "Approve & Delete" rose outline button +
  "Reject & Restore" emerald outline button.
- Review `AlertDialog` explains the consequences: approve → "the employee will be permanently
  deleted and their records hidden. This action cannot be undone." / reject → "the employee
  will be restored to active status…". Confirm buttons: rose solid / emerald solid.
  → `dataApi.reviewCancellationRequest(id, approve)` with toasts.
- Mobile (<md): card list including full-width review buttons on pending rows.
- New Cancellation Request `Dialog`: amber warning box with the mandated wording
  ("Upon submission, the employee will be marked as 'Pending Deletion' … permanently deleted."),
  employee picker, optional Reason textarea, rose "Submit Cancellation" button →
  `dataApi.createCancellationRequest(employeeId, reason.trim() || null)`.
- Live updates: `useRealtimeVersion(['cancellation_request'])`.

### Local employee picker for the deletion dialog
`DeletionEmployeePicker` (private sub-component inside cancellation-request-page.tsx). The
shared `EmployeeCombobox` does not support disabled items or per-item hints, and the spec
requires pending-deletion employees to be visible but disabled with a "pending" hint (the API
throws "This employee already has a pending deletion request"). The local picker mirrors the
shared combobox styling (Popover + Command, `shouldFilter={false}`, own query filtering,
active-sorted-first list) and renders pending items with `disabled` + an amber "pending" chip.
No shared files were modified.

## Data-layer gaps found (NOT fixed — outside my file scope)

1. `src/lib/data/demo-api.ts` (line 32): imports `nowISO` from `./demo-store`, but
   `demo-store.ts` declares `nowISO` locally without exporting it → `tsc --noEmit` error
   TS2459 on demo-api.
2. `src/lib/data/prod-api.ts` (line 532): `'supabase' is possibly 'null'` — TS18047 inside
   `subscribe()` (missing non-null handling after the configured check).
3. `prodApi` has the full method surface used by both pages (`listLeaveRequests`,
   `createLeaveRequest`, `reviewLeaveRequest`, `listCancellationRequests`,
   `createCancellationRequest`, `reviewCancellationRequest`, `listEmployees`, `subscribe`)
   — no API gaps for these modules.
4. Note for other agents: `dataApi.createCancellationRequest(employeeId, reason)` marks the
   employee `pending_deletion` immediately (it delegates to `requestEmployeeDeletion`), and
   `reviewCancellationRequest` emits `['cancellation_request','employee','uniform_registry','notification']`
   — pages that depend on employee/uniform data should include those tables in their realtime
   subscriptions.

## Verification

- `bunx eslint src/components/leave-requests src/components/cancellation-requests
  --no-warn-ignored` → **PASS (0 errors, 0 warnings)**.
- `bunx tsc --noEmit` filtered to my 2 files → **0 errors**. (Remaining src/ errors are only
  the still-missing sibling modules of other agents — admins, attendance, employees,
  notifications, sites, uniform-registry — plus the 2 data-layer gaps above.)
- Dev server log: my two modules resolve and compile ("✓ Compiled"); only other agents' pending
  pages still produce module-not-found.
