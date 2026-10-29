# P-3 — Admin Management Page (admin-page.tsx)

## Task
Built `/home/z/my-project/src/components/admins/admin-page.tsx` — the PULSE premium Admin
Management page for the SPA (`AppView = 'admins'`, already wired in `src/app/page.tsx`).
Only this file was created/modified.

## Prior work consulted (in /agent-ctx)
- `P-2-attendance-agent.md` — followed the same PULSE page conventions (PageHeader,
  SkeletonRows loading, motion stagger, sonner toasts, realtime refetch).

## What was built (full legacy feature parity + PULSE design language)
1. **Super-admin-only guard** — non-super admins get a centered `EmptyState` panel
   (Shield icon, "Super admin access only"). All hooks still run unconditionally.
2. **Two grouped card sections** — "Super Admins" (amber/gold, Crown) and "Admins"
   (brand, Shield), each with its own search box (name/email, clearable), count badge,
   staggered row entrance (0.3s, ease [0.22,1,0.36,1], delay i*0.04 capped), desktop
   `Table` + mobile cards, `card-glow` hover lift (motion wrapper OUTSIDE the
   card-glow element so the CSS hover transform still works).
3. **Row content** — avatar initials (brand gradient for admins, amber gradient for
   super admins), name (+ "You" badge for the signed-in account), email, role badge
   (Crown/Shield), created date, and an "Access" summary for regular admins
   (Dashboard + Uniform Registry base chips + granted-menu chips, kept in sync live).
4. **Create dialog** — name/email/password (min 6 chars, Eye/EyeOff show-toggle),
   role `Select` with helpful descriptions + dynamic info panels ("Super admin — full
   access to everything" / "Admin — Dashboard + Uniform Registry by default; grant more
   via Permissions"). Amber gradient submit for super admin, brand gradient otherwise.
   Calls `dataApi.createProfile`; server errors surfaced via toast.
5. **Edit dialog** — same fields, password optional ("leave blank to keep"),
   client-side **last-super-admin demotion guard** (option disabled in the select +
   pre-submit toast) and the server-thrown "Cannot demote the last super admin" is
   surfaced via toast. Calls `dataApi.updateProfile`.
6. **Permissions dialog** (admin rows, KeyRound action) — loads via
   `dataApi.getMenuPermissions(profileId)`; renders the 6 keys from `MENU_KEYS`
   (employees, sites, attendance, leave_requests, cancellation_requests,
   notifications) as instantly-saving Switch toggles (optimistic + revert on failure,
   per-key spinner) with toasts `Access granted/revoked for <menu>`; "Dashboard" and
   "Uniform Registry" shown as locked/checked disabled switches under
   "Always available"; staggered rows, shimmer skeletons while loading.
7. **Delete confirm** — AlertDialog warning removal is permanent, client-side
   last-super-admin guard (button disabled + toast), `dataApi.deleteProfile`,
   success/error toasts.
8. **Realtime** — `useRealtimeVersion(['profiles', 'menu_permission'])` drives a full
   refetch (profiles + per-admin permission summaries for the Access column).

## Notes / deviations
- Switch checked-state uses explicit `data-[state=checked]:bg-brand` (+
  `bg-white!` thumb) because this project's globals.css never defines `--primary`,
  so the stock shadcn `bg-primary` track/thumb resolves to nothing — same root cause
  other pages avoid by using `brand-gradient` buttons.
- Legacy `window.confirm` prompts for promote/create-super-admin were replaced by the
  in-dialog amber/brand info panels + role descriptions (spec's premium-dialog style);
  the demote/delete guards remain enforced (client + server).
- `dropdown-menu` from the allowed palette was not needed — inline icon buttons match
  the established leave-request page action pattern.

## Verification
- `bunx tsc --noEmit 2>&1 | grep "admin-page"` → **no output (clean)**.
- dev.log: my module now resolves; remaining `Module not found: '@/components/sites/sites-page'`
  belongs to a different task's file, not this one.
