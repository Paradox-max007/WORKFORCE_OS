# PULSE Workforce OS

> **Premium workforce operations, live.** — A reimagined, rebranded & rebuilt version of the
> legacy *ASM (Arabian Shield Manpower)* system, now running on **Supabase** (Postgres +
> Auth + Realtime) and deployable to **Vercel** in minutes.

![Stack](https://img.shields.io/badge/Next.js-16-black) ![Supabase](https://img.shields.io/badge/Supabase-Postgres%20·%20Auth%20·%20Realtime-3ECF8E) ![Vercel](https://img.shields.io/badge/Vercel-ready-black) ![Framer Motion](https://img.shields.io/badge/Framer%20Motion-premium%20animations-FF0080)

---

## What is this?

PULSE is a complete **HR / manpower management suite** for companies that field crews across
multiple client sites. Every feature of the original ASM system was preserved, while the
database, business logic and design were rebuilt **from scratch** on Supabase with a premium,
animated product identity.

### Feature matrix (100 % of legacy ASM, migrated & upgraded)

| Module | Capabilities |
|---|---|
| **Dashboard** | Live KPI cards, 6-month attendance analytics, site-wise breakdown, idle-employee radar — all animated & realtime, with **readable chart tooltips** (light text on themed cards in both themes) |
| **Employees** | Full profiles (passport/ID, emergency contact, rating), photo, site + camp assignment (with **block & room no.**), team-leader flag, soft-delete with cascade hide, **nationality column + region → country filter** (Africans → Burundi/Kenya, Asians → India/…), **home-country address** per passport, **dedicated Add/Edit page** (no modal) with **manual or auto Employee ID**, **camp filter + filtered Excel (.xlsx) export** whose filename mirrors the active filters, **CV PDF export**, **dedicated details page** showing camp · block · room, with **Track Record viewer** & **WhatsApp share with lifetime / specific-month timesheets** |
| **Sites** | Client/project tracking, activate/deactivate with crew impact warning, per-site crew view, add/remove crew, printable **A4 attendance sheet** (PDF / print, alphabetical, with hand-fill TOTAL PRESENT / ABSENT lines) |
| **Camps** | **Accommodation management** — create/edit/deactivate/delete camps (location, capacity, notes), **one employee ↔ exactly one camp**, **block & room numbers** per resident (required on add/move, editable inline), instant transfers between camps, bulk move/remove, capacity usage bars |
| **Attendance** | **Excel-style marking sheet grouped SITEWISE** (one alphabetical section per work site — attendance is marked site-by-site), **fits the FULL month on one screen: Name + Trade + all 30/31 day columns (per the selected month/year) + Total H + Absent are always visible on laptop/desktop** (compact fixed side columns, day columns flex to share the remaining width; horizontal scrolling only engages on smaller screens — on phones ONLY the Employee column stays pinned in place while Trade, all day columns, Total H and Absent scroll together so every day cell stays reachable for marking; from `lg` up Employee/Trade pin left and Total/Absent pin right), every past cell is an always-editable input (custom hours e.g. `8`, `10.5` or `A` for absent; **un-entered days stay blank — no auto-filled defaults**), the **full month is always shown up to its last day with future dates locked**, each row shows the employee's **trade in its own column** (camp shown as a tooltip icon on the name), **Sundays marked red**, **TOTAL HOURS column** (row sum) + **ABSENT count** beside it, site filter narrows the crew, per-employee calendar view, rating engine (±0.2 / OT hour above 8h/day), **auto-warning after 3 consecutive absences**, **admin gating: normal admins only see & mark their assigned sites**, **BULK DAY ENTRY — pick any past date on a calendar (month/year dropdowns + Today/Yesterday shortcuts) and fill that whole day for an entire site crew in one save: unmarked employees default to 10 hours, every value is editable in the dialog (or via `10h → unmarked` / `10h → all`) and in the sheet at any time afterwards** (`bulk_mark_attendance` RPC, single round-trip), **SITE TRANSFERS — every site change (employee form, per-site transfer, remove-from-site) is logged with its effective date: in the month of the move the employee appears under BOTH sites — at the BOTTOM of each crew with the entire row faded: under the site they started the month at, the days from the move to month-end render as ONE merged cell showing the new site, and under the new site the earlier days merge into a cell showing the old site so the moved days can be marked there; a day that was already marked BEFORE the move was recorded keeps its original site — the move is then displayed from the next day (marked on the 25th + moved on the 25th → Site B shows from the 26th); earlier months show them under the old site, later months under the new site; Total H / Absent still aggregate the whole month while each section band counts only its own site's days; bulk day entry follows the same per-day site (an employee is bulk-markable at the old site before the move and at the new site after)** |
| **Leave Requests** | 6 leave types, day math, approve/reject workflow, reviewer audit trail |
| **Cancellation Requests** | Attendance cancellation approvals with reviewer audit trail |
| **Warnings & Fines** | Manual + auto-generated warnings, fines with amounts, full history |
| **Uniform Registry** | Sequential tokens & IDs, encrypted ID/passport numbers (AES-256-GCM), item checklist (uniform/shoes/helmet/bottle/safety jacket) rendered **as a clean row of chips** (no stacking), searchable employee picker that **scrolls properly inside dialogs**, **6-month renewal chain**, per-employee history |
| **Notifications** | Per-user inbox, unread badges, mark-all-read, auto-notifications on requests/warnings/fines |
| **Admin Management** | Super-admin & admin roles, **per-menu permission toggles** (incl. Camps), **site assignments — the super admin assigns each work site to normal admins, who can then only mark attendance for those sites**, create/edit/delete admins (last-super-admin protected) |
| **Realtime** | **Supabase Realtime** on every table (incl. camp) — changes stream into all open tabs/devices instantly |

### What's new vs. legacy ASM

- **New product identity** — "PULSE Workforce OS": aurora-gradient dark/light themes, 4 accent
  colors (violet/emerald/amber/rose), glass cards, glow shadows, animated counters, page
  transitions, staggered lists, spring micro-interactions everywhere (Framer Motion).
- **Database redesigned from scratch** — proper UUID PKs, real FK relationships
  (employees → sites), Postgres enums, JSONB checklists, audit columns, RPC functions for all
  business logic, and **Row Level Security** on every table.
- **Supabase Auth** replaces bcrypt/session cookies — with automatic profile provisioning.
- **Supabase Realtime** replaces polling — every table is in the realtime publication.
- **Zero-config demo mode** — no credentials? The app runs fully functional with seeded demo
  data (same UI, same features) so you can evaluate before wiring Supabase.

---

## Run it (zero config)

```bash
bun install
bun run dev
```

Open http://localhost:3000 — the app boots in **Demo Mode** with a full seeded dataset.

**Demo accounts** (all passwords: `demo1234`):

| Email | Role |
|---|---|
| `super@pulse.app` | Super Admin (Amira Sultan) |
| `admin@pulse.app` | Admin (Ravi Kumar) |
| `sara@pulse.app` | Admin (Sara Menon) |

> Demo mode persists to `localStorage` and simulates realtime across browser tabs via
> `BroadcastChannel`. All business logic (rating engine, auto-warnings, renewal dates,
> token sequencing, permissions) runs identically in demo and production mode.

---

## Connect Supabase (production mode)

### 1. Create the database

1. Create a project at [database.new](https://database.new).
2. Open **SQL Editor → New query**, paste the entire contents of
   [`supabase/schema.sql`](supabase/schema.sql) and **Run**.
3. This single file creates everything: 13 tables (incl. the new `camp` accommodation table
   and the `admin_site` site-assignment table),
   indexes, FK relationships, RLS policies, triggers, 30+ RPC functions (the whole
   business-logic engine — including the Excel-style `mark_attendance` hours model and
   `assign_employee_camp` with block/room) and adds
   every table to the **Supabase Realtime publication**.

> **Already ran an older version of schema.sql?** Drop the old schema first
> (`drop schema public cascade; create schema public;`) then re-run — the attendance
> model changed to per-day worked hours (`hours` column) and camps were added.

### 2. Point the app at it

Copy [`.env.example`](.env.example) → `.env.local` and fill in from
**Project Settings → API**:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVICE-ROLE-KEY   # server-only, for admin user management
ENCRYPTION_SECRET=REPLACE-WITH-A-LONG-RANDOM-SECRET
```

Restart the dev server — the app now reads/writes your Supabase Postgres with live
Realtime. **The first account you sign up with automatically becomes the Super Admin.**

---

## Deploy to Vercel

1. Push this repository to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) → **Import** the repo (Next.js is
   auto-detected, `vercel.json` pins `bun install` + `next build`).
3. **Before the first deploy**, add the environment variables (Production + Preview):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_SECRET`.
4. **Deploy** — done. Every push auto-deploys; PRs get preview URLs.

> **Auth tip:** after deploying, add your Vercel domain in
> Supabase → Authentication → URL Configuration → **Site URL** so sign-in links resolve.

---

## Architecture

```
src/
├─ app/                    # Next.js 16 App Router (single-page shell)
│  ├─ page.tsx             # SPA entry: auth gate + animated view router
│  ├─ layout.tsx           # Fonts, theme, Toaster
│  └─ api/admin-users/     # Service-role endpoint (create/update/delete admins)
├─ components/             # 10 feature pages + premium shared primitives
│  ├─ auth/                # Login / Sign-up (aurora animated shells)
│  ├─ layout/              # Collapsible sidebar + header (LIVE indicator)
│  ├─ shared/              # PageHeader, EmptyState, SkeletonRows, SiteBadge,
│  │                       # EmployeeCombobox, NationalitySelect (flag icons)
│  └─ ...                  # dashboard, employees, sites, attendance, uniform,
│                          # leave, cancellations, notifications, admins
├─ lib/
│  ├─ supabase/client.ts   # Typed browser client (null in demo mode)
│  ├─ data/                # ★ Data layer facade
│  │  ├─ index.ts          #   isSupabaseConfigured ? prodApi : demoApi
│  │  ├─ prod-api.ts       #   Supabase RPC/Realtime implementation
│  │  ├─ demo-api.ts       #   Seeded in-memory implementation (same interface)
│  │  └─ demo-store.ts     #   Demo dataset + persistence
│  ├─ types.ts             # Domain types shared by both implementations
│  ├─ format.ts            # Date/number/name formatting helpers
│  └─ pdf.ts               # jsPDF + html2canvas exporters (CV, WhatsApp, sheets)
├─ store/                  # Zustand: auth, app view, realtime version hooks
└─ supabase/schema.sql     # ★ The complete from-scratch database (tables + RLS +
                           #   RPC business logic + triggers + Realtime publication)
```

**Design decision:** every page talks to a single `dataApi` interface. Production uses
Supabase RPC (`postgres_changes` realtime); demo mode swaps in a seeded in-memory engine with
the identical interface. This keeps the app runnable everywhere while guaranteeing one code
path per feature — no feature drift between demo and production.

### Database highlights (`supabase/schema.sql`)

- `profiles` ↔ `auth.users` with auto-provisioning trigger (first user → super admin)
- `employee.current_site_id → site.id` and `employee.camp_id → camp.id` — real relational
  integrity (legacy used free-text columns), plus `camp_block` / `camp_room` for room-level
  tracking inside each camp
- `admin_site` — sites assigned to normal admins (super admin assigns; attendance RPC only
  accepts marks for assigned sites)
- `attendance(employee_id, date)` unique constraint + rating/warning engine inside
  `mark_attendance()`; `get_month_attendance` returns **only real records** — un-entered
  days stay blank in the sheet, future days are locked client-side
- `bulk_mark_attendance(p_entries jsonb)` — bulk day entry in a single round-trip; every
  entry reuses the full `mark_attendance` engine (permissions, rating, auto-warnings)
- `site_transfer` — automatic move log (from/to site + `effective_date`): `update_employee`
  writes one row whenever `current_site_id` changes (the client passes its local date).
  The attendance sheet folds this log into per-month timelines: a moved employee sits at
  the bottom of BOTH crews (faded) — their original site keeps the days up to the move
  (the moved days merge into one cell showing the new site) and the new site shows the
  earlier days as a merged cell showing the old site, so the moved days can be marked
  there. Days already marked before the move was recorded stay with the old site
  (compared via `created_at`), shifting the displayed move to the next unmarked day.
  The printable per-site sheet simply lists them under their new site alphabetically
- `create_employee` accepts an **optional manual employee ID** (validated unique) and
  falls back to `next_employee_code()` when blank
- `uniform_registry` token sequencing + encrypted document numbers + renewal chain
- RLS: staff read-all, writes **only** through super-admin-gated RPC functions
- All 13 tables in the `supabase_realtime` publication

---

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Start dev server (port 3000) |
| `bun run lint` | ESLint |
| `bun run build` | Production build |
| `bun run start` | Serve the production build |

---

*Migrated, rebranded and rebuilt from
[Paradox-max007/ASM_PROJECT](https://github.com/Paradox-max007/ASM_PROJECT) — every legacy
feature preserved, nothing left behind.*
