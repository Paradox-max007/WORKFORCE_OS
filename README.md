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
| **Dashboard** | Live KPI cards, 6-month attendance analytics, site-wise breakdown, idle-employee radar — all animated & realtime |
| **Employees** | Full profiles (passport/ID, emergency contact, rating), photo, site assignment, team-leader flag, soft-delete with cascade hide, **CV PDF export**, **WhatsApp share** |
| **Sites** | Client/project tracking, activate/deactivate with crew impact warning, per-site crew view, add/remove crew, printable **A4 attendance sheet** (PDF / print) |
| **Attendance** | Employee × day matrix + calendar view, 4 statuses, overtime hours, Friday & "last 7 days" highlights, auto-record defaults, rating engine (±0.2 / OT hour), **auto-warning after 3 consecutive absences** |
| **Leave Requests** | 6 leave types, day math, approve/reject workflow, reviewer audit trail |
| **Cancellation Requests** | Attendance cancellation approvals with reviewer audit trail |
| **Warnings & Fines** | Manual + auto-generated warnings, fines with amounts, full history |
| **Uniform Registry** | Sequential tokens & IDs, encrypted ID/passport numbers (AES-256-GCM), item checklist (uniform/shoes/helmet/bottle/safety jacket), **6-month renewal chain**, per-employee history |
| **Notifications** | Per-user inbox, unread badges, mark-all-read, auto-notifications on requests/warnings/fines |
| **Admin Management** | Super-admin & admin roles, **per-menu permission toggles**, create/edit/delete admins (last-super-admin protected) |
| **Realtime** | **Supabase Realtime** on every table — changes stream into all open tabs/devices instantly |

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
3. This single file creates everything: 11 tables, indexes, FK relationships, RLS policies,
   triggers, 25+ RPC functions (the whole business-logic engine) and adds every table to the
   **Supabase Realtime publication**.

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
- `employee.current_site_id → site.id` — real relational integrity (legacy used a free-text
  column)
- `attendance(employee_id, date)` unique constraint + rating/warning engine inside
  `mark_attendance()`
- `uniform_registry` token sequencing + encrypted document numbers + renewal chain
- RLS: staff read-all, writes **only** through super-admin-gated RPC functions
- All 11 tables in the `supabase_realtime` publication

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
