'use client';

// ============================================================================
// PULSE Workforce OS — Public shared attendance PAPER (/share/[token])
// ----------------------------------------------------------------------------
// The site's DAILY ATTENDANCE form — the same PDF-styled A4 paper used on the
// Sites page — behind a one-time link (sent over WhatsApp):
//   • no login — the token in the URL is the capability (anon-key RPC in
//     Supabase mode, same-browser demo store in demo mode)
//   • the SIGNATURE column is clickable + editable: tap a cell to mark the
//     employee Present (hours, default 10), Absent ("A" — the ONLY absent
//     marker) or a short custom marker (free text never counts as absent)
//   • change the DATE field to mark another day of the link's month — every
//     mark is kept and submitted together
//   • EXTRA EMPLOYEES rows can be filled in (kept with the saved form only —
//     they have no HR record); TOTAL PRESENT / TOTAL ABSENT auto-count
//   • one-time use: Submit Sheet writes every signature mark through the SAME
//     marking engine into the SAME attendance table the in-app Excel marking
//     sheet reads (so the Excel updates instantly), freezes a snapshot of the
//     paper + the save date/time, and locks the link — re-opening shows the
//     SAVED paper read-only
//   • an admin can re-grant edit access (attendance page → Links sidebar),
//     which makes this same link editable again
// ============================================================================

import { motion } from 'framer-motion';
import {
  Building2, CalendarDays, CalendarCheck, Check, CheckCheck, Loader2, Lock,
  PenLine, Plus, Send, UserRound,
} from 'lucide-react';
import Image from 'next/image';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { dataApi } from '@/lib/data';
import { cn } from '@/lib/utils';
import type {
  SharedSheetEmployee, SharedSheetExtra, SharedSheetPayload, SharedSheetSubmitEntry,
} from '@/lib/types';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const EXTRA_ROWS = 5;

const pad = (n: number): string => String(n).padStart(2, '0');

const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const monthLabel = (monthKey: string): string => {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
};

/** same cell grammar as the marking sheet — ONLY "A" is absent */
function parseCell(raw: string): { kind: 'absent' | 'hours' | 'text' | 'clear' | 'invalid'; hours: number | null } {
  const v = raw.trim();
  if (v === '') return { kind: 'clear', hours: null };
  if (v.toLowerCase() === 'a') return { kind: 'absent', hours: null };
  const n = Number(v);
  if (!Number.isNaN(n) && Number.isFinite(n) && n >= 0 && n <= 24) {
    return { kind: 'hours', hours: Math.round(n * 100) / 100 };
  }
  if (v.length <= 40) return { kind: 'text', hours: null };
  return { kind: 'invalid', hours: null };
}

const emptyExtra = (): SharedSheetExtra => ({ name: '', code: '', trade: '', mark: '' });

// ---------------------------------------------------------------------------
// Signature stamp (the mark shown inside a SIGNATURE cell)
// ---------------------------------------------------------------------------
function Stamp({ value, pending }: { value: string; pending?: boolean }) {
  const parsed = parseCell(value);
  if (parsed.kind === 'clear') return null;
  const style = parsed.kind === 'absent'
    ? 'border-rose-700/80 bg-rose-50 text-rose-800'
    : parsed.kind === 'hours'
      ? 'border-emerald-700/80 bg-emerald-50 text-emerald-800'
      : 'border-violet-700/70 bg-violet-50 text-violet-800';
  return (
    <span
      className={cn(
        'relative inline-flex max-w-full items-center gap-1 truncate rounded-sm border-2 px-1.5 py-0.5 text-[10.5px] font-black uppercase leading-tight tracking-wide',
        style,
      )}
    >
      {parsed.kind === 'absent' ? '✗ Absent' : parsed.kind === 'hours' ? `✓ ${value.trim()} h` : value.trim()}
      {pending && (
        <span
          className="absolute -right-1 -top-1 size-2 rounded-full bg-amber-500 ring-2 ring-white"
          title="Unsaved — submitted with the sheet"
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared mark options (Present hours / Absent / Custom / Clear) — used by the
// crew signature dialog and the extra-employees dialog
// ---------------------------------------------------------------------------
function MarkOptions({ draft, setDraft, invalid }: {
  draft: string;
  setDraft: (v: string) => void;
  invalid: boolean;
}) {
  const parsed = parseCell(draft);
  const [mode, setMode] = useState<'present' | 'absent' | 'custom'>(() =>
    parsed.kind === 'hours' ? 'present'
      : parsed.kind === 'absent' ? 'absent'
        : parsed.kind === 'text' ? 'custom'
          : 'present');

  const select = (m: 'present' | 'absent' | 'custom') => {
    setMode(m);
    if (m === 'present' && parsed.kind !== 'hours') setDraft('10');
    if (m === 'absent') setDraft('A');
    if (m === 'custom' && parsed.kind !== 'text') setDraft('');
  };

  const opt = (active: boolean, tone: string) => cn(
    'flex-1 rounded-lg border-2 px-2 py-2 text-[11px] font-bold uppercase tracking-wide transition-colors',
    active ? tone : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted',
  );

  return (
    <div className="space-y-2.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => select('present')}
          className={opt(mode === 'present', 'border-emerald-600/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400')}
        >
          ✓ Present
        </button>
        <button
          type="button"
          onClick={() => select('absent')}
          className={opt(mode === 'absent', 'border-rose-600/60 bg-rose-500/10 text-rose-700 dark:text-rose-400')}
        >
          ✗ Absent
        </button>
        <button
          type="button"
          onClick={() => select('custom')}
          className={opt(mode === 'custom', 'border-violet-600/60 bg-violet-500/10 text-violet-700 dark:text-violet-400')}
        >
          Custom…
        </button>
      </div>

      {mode === 'present' && (
        <label className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">Hours worked</span>
          <Input
            value={draft}
            inputMode="decimal"
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. 8, 10.5"
            className="h-8 w-28 text-center font-bold tabular-nums"
          />
          <span className="text-[11px] leading-tight text-muted-foreground">
            default 10 · max 24 · anything above 8 counts as overtime rating
          </span>
        </label>
      )}
      {mode === 'custom' && (
        <label className="block rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">
            Custom marker (max 40 chars — never counted as absent)
          </span>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. OT, HALF DAY, TRAVEL"
            className="mt-1.5 h-9 font-semibold uppercase"
            maxLength={40}
          />
        </label>
      )}

      {draft.trim() !== '' && (
        <button
          type="button"
          onClick={() => setDraft('')}
          className="text-[11px] font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear this mark
        </button>
      )}
      {invalid && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] font-medium text-rose-600 dark:text-rose-400">
          Hours must be 0–24 (e.g. 8 or 10.5), A for absent, or a short marker (max 40 characters).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The paper form
// ---------------------------------------------------------------------------
function SharedPaper() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = (Array.isArray(params.token) ? params.token[0] : params.token) ?? '';
  const siteParam = search.get('site');

  const [payload, setPayload] = useState<SharedSheetPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** pending signature marks: `${employeeId}::${date}` → cell text */
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [extras, setExtras] = useState<SharedSheetExtra[]>(() =>
    Array.from({ length: EXTRA_ROWS }, emptyExtra));
  const [paperDate, setPaperDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitterName, setSubmitterName] = useState('');
  /** crew signature dialog target */
  const [markEmp, setMarkEmp] = useState<SharedSheetEmployee | null>(null);
  const [draft, setDraft] = useState('');
  /** extra-employees dialog target (row index) */
  const [extraIdx, setExtraIdx] = useState<number | null>(null);
  const [extraDraft, setExtraDraft] = useState<SharedSheetExtra>(emptyExtra());

  const load = useCallback(() => {
    setLoadError(null);
    dataApi.getSharedAttendanceSheet(token)
      .then((p) => {
        setPayload(p);
        if (p.exists && p.status === 'active') {
          setMarks({});
          setExtras(Array.from({ length: EXTRA_ROWS }, emptyExtra));
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to open the sheet'));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const editable = payload?.exists === true && payload.status === 'active';
  const snapshot = payload?.status === 'submitted' ? payload.snapshot : null;

  // month bounds ---------------------------------------------------------------
  const [firstDay, lastDay] = useMemo(() => {
    const mk = payload?.month_key ?? '';
    const [y, m] = mk.split('-').map(Number);
    if (!y || !m) return ['', ''];
    return [`${mk}-01`, `${mk}-${pad(new Date(y, m, 0).getDate())}`];
  }, [payload?.month_key]);

  const today = payload?.today ?? '';

  // the paper's date: default today, clamped into the link's month -----------
  useEffect(() => {
    if (!editable || !firstDay || !lastDay) return;
    setPaperDate((cur) => {
      if (cur) return cur;
      if (today && today >= firstDay && today <= lastDay) return today;
      if (today && today > lastDay) return lastDay;
      return firstDay;
    });
  }, [editable, firstDay, lastDay, today]);

  const paperDateLocked = snapshot?.paper_date
    ?? (payload?.submitted_at ? payload.submitted_at.slice(0, 10) : '')
    ?? '';
  const shownDate = editable ? paperDate : paperDateLocked;
  const futureDate = !!today && shownDate > today;

  const allEmployees = editable ? (payload?.employees ?? []) : (snapshot?.employees ?? []);
  const crew = useMemo(
    () => allEmployees.filter((e) => e.markable.includes(shownDate)),
    [allEmployees, shownDate],
  );

  // effective signature value for a crew row (pending mark → saved mark) -----
  const effValue = (emp: SharedSheetEmployee, date: string): string =>
    (editable ? marks[`${emp.id}::${date}`] ?? emp.cells[date] ?? '' : emp.cells[date] ?? '');

  const isPending = (emp: SharedSheetEmployee, date: string): boolean =>
    editable && (marks[`${emp.id}::${date}`] ?? emp.cells[date] ?? '') !== (emp.cells[date] ?? '');

  // changed cells across ALL marked days (the submit payload) — a pending mark
  // only exists where the supervisor actually touched the cell, so missing keys
  // fall back to the saved value (no change)
  const changedEntries = (): SharedSheetSubmitEntry[] => {
    if (!editable) return [];
    const entries: SharedSheetSubmitEntry[] = [];
    for (const emp of payload?.employees ?? []) {
      for (const date of emp.markable) {
        if (date > today) continue;
        const cur = (marks[`${emp.id}::${date}`] ?? emp.cells[date] ?? '').trim();
        const orig = (emp.cells[date] ?? '').trim();
        if (cur !== orig) entries.push({ employee_id: emp.id, date, value: cur });
      }
    }
    return entries;
  };

  const pendingEntries = useMemo(changedEntries, [editable, payload, marks, today]);
  const markedDays = useMemo(
    () => new Set(pendingEntries.map((e) => e.date)).size,
    [pendingEntries],
  );

  // TOTAL PRESENT / TOTAL ABSENT boxes ----------------------------------------
  const [totalPresent, totalAbsent] = useMemo(() => {
    if (!editable) {
      if (snapshot?.total_present != null && snapshot?.total_absent != null) {
        return [snapshot.total_present, snapshot.total_absent];
      }
      // legacy snapshot: count from the frozen cells of the shown date
      let p = 0, a = 0;
      for (const emp of snapshot?.employees ?? []) {
        const v = emp.cells[shownDate] ?? '';
        const parsed = parseCell(v);
        if (parsed.kind === 'absent') a += 1;
        else if (parsed.kind === 'hours' || parsed.kind === 'text') p += 1;
      }
      return [p, a];
    }
    let p = 0, a = 0;
    for (const emp of crew) {
      const parsed = parseCell(effValue(emp, shownDate));
      if (parsed.kind === 'absent') a += 1;
      else if (parsed.kind === 'hours' || parsed.kind === 'text') p += 1;
    }
    for (const x of extras) {
      const parsed = parseCell(x.mark);
      if (parsed.kind === 'absent') a += 1;
      else if (parsed.kind === 'hours' || parsed.kind === 'text') p += 1;
    }
    return [p, a];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, snapshot, crew, extras, shownDate, marks]);

  const monthHours = editable
    ? (payload?.employees ?? []).reduce((sum, e) => sum + (e.total_hours ?? 0), 0)
    : snapshot?.totals.hours ?? 0;
  const monthAbsents = editable
    ? (payload?.employees ?? []).reduce((sum, e) => sum + (e.absents ?? 0), 0)
    : snapshot?.totals.absents ?? 0;

  // ---- actions ---------------------------------------------------------------
  const openMark = (emp: SharedSheetEmployee) => {
    // unmarked cells open with the default day (10h) preselected
    setDraft(effValue(emp, shownDate) || '10');
    setMarkEmp(emp);
  };

  const saveMark = () => {
    if (!markEmp) return;
    if (parseCell(draft).kind === 'invalid') return;
    const key = `${markEmp.id}::${shownDate}`;
    setMarks((prev) => {
      const next = { ...prev };
      const orig = (markEmp.cells[shownDate] ?? '').trim();
      if (draft.trim() === orig) delete next[key];
      else next[key] = draft.trim();
      return next;
    });
    setMarkEmp(null);
  };

  const openExtra = (idx: number) => {
    setExtraDraft({ ...extras[idx] });
    setExtraIdx(idx);
  };

  const saveExtra = () => {
    if (extraIdx == null) return;
    if (parseCell(extraDraft.mark).kind === 'invalid') return;
    setExtras((prev) => prev.map((x, i) => (i === extraIdx ? { ...extraDraft } : x)));
    setExtraIdx(null);
  };

  const submitSheet = async () => {
    if (!editable) return;
    setSubmitting(true);
    try {
      const res = await dataApi.submitSharedAttendanceSheet(
        token,
        changedEntries(),
        submitterName || null,
        {
          paper_date: shownDate,
          extras: extras.map((x) => ({
            name: x.name.trim().slice(0, 80),
            code: x.code.trim().slice(0, 40),
            trade: x.trade.trim().slice(0, 60),
            mark: x.mark.trim().slice(0, 40),
          })),
        },
      );
      setConfirmOpen(false);
      setSubmitterName('');
      toast.success('Paper submitted and saved', {
        description: `${res.applied} signature mark${res.applied !== 1 ? 's' : ''} saved into the attendance records · locked at ${fmtDateTime(res.saved_at)} — ask an admin for edit access if anything needs changing.`,
      });
      setPaperDate('');
      load(); // → read-only saved paper
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  // ---- states ---------------------------------------------------------------
  if (loadError) {
    return (
      <Shell>
        <EmptyCard
          icon={<Loader2 size={22} className="animate-spin" />}
          title="Could not open this sheet"
          description={loadError}
        />
      </Shell>
    );
  }

  if (!payload) {
    return (
      <Shell>
        <div className="mx-auto max-w-3xl space-y-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-[520px] rounded-2xl" />
        </div>
      </Shell>
    );
  }

  if (!payload.exists) {
    return (
      <Shell>
        <EmptyCard
          icon={<Lock size={22} />}
          title="Link not found"
          description="This attendance sheet link does not exist (or was generated in a different browser session). Ask the admin who shared it to send a fresh link."
        />
      </Shell>
    );
  }

  const siteName = payload.site_name || siteParam || 'Site';
  const clientName = (editable ? payload.client_name : snapshot?.client_name) ?? '';
  const projectName = (editable ? payload.project_name : snapshot?.project_name) || siteName;

  const draftParsed = parseCell(draft);
  const extraMarkParsed = parseCell(extraDraft.mark);

  // signature cell renderer ----------------------------------------------------
  const signatureCell = (
    value: string,
    pending: boolean,
    onClick: (() => void) | null,
  ) => {
    if (value.trim() !== '') {
      return (
        <button
          type="button"
          disabled={!onClick}
          onClick={onClick ?? undefined}
          className={cn(
            'flex w-full items-center justify-center py-0.5',
            onClick && 'transition-colors hover:bg-brand/10',
          )}
          title={onClick ? 'Tap to change this mark' : value}
        >
          <Stamp value={value} pending={pending} />
        </button>
      );
    }
    if (!onClick) return <span className="block py-1 text-[10px] text-black/25">—</span>;
    return (
      <button
        type="button"
        onClick={onClick}
        className="mx-auto flex items-center gap-1 rounded-sm border border-dashed border-black/30 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-black/45 transition-colors hover:border-brand hover:bg-brand/10 hover:text-brand"
        title="Tap to mark Present / Absent"
      >
        <PenLine size={10} /> Sign
      </button>
    );
  };

  const shownExtras = editable ? extras : (snapshot?.extras?.length ? snapshot.extras : []);

  return (
    <Shell>
      <div className="mx-auto max-w-3xl">
        {/* ---- status header ---- */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ease: EASE }}
          className="card-glow rounded-2xl border bg-card p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Building2 size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold tracking-tight">{siteName}</h1>
                <span
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
                    editable
                      ? 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {editable ? (
                    <span className="inline-flex items-center gap-1"><PenLine size={11} /> Daily paper — not submitted yet</span>
                  ) : (
                    <span className="inline-flex items-center gap-1"><Lock size={11} /> Submitted — read-only</span>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Daily Attendance Paper · {monthLabel(payload.month_key)} · shared by PULSE
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-semibold tabular-nums text-emerald-500">
                Month hours: {Math.round(monthHours * 100) / 100}
              </span>
              <span className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold tabular-nums',
                monthAbsents > 0
                  ? 'border-rose-500/25 bg-rose-500/10 text-rose-500'
                  : 'border-border bg-muted text-muted-foreground',
              )}>
                Month absent: {monthAbsents}
              </span>
            </div>
          </div>

          {editable ? (
            <div className="mt-3.5 rounded-xl border border-brand/25 bg-brand/[0.06] px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              Tap a cell in the <span className="font-semibold text-foreground">SIGNATURE</span> column to mark each employee —
              <span className="font-semibold text-emerald-600 dark:text-emerald-400"> Present</span> (hours, default 10) ·
              <span className="font-semibold text-rose-500"> Absent</span> ·
              <span className="font-semibold text-foreground"> a custom marker</span>. Change the
              <span className="font-semibold text-foreground"> DATE</span> field to mark another day of {monthLabel(payload.month_key)}.
              Submitting saves every mark into the <span className="font-semibold text-foreground">same attendance records as the
              in-app Attendance Sheet</span> (the Excel updates instantly) and locks this link — one-time use.
              {futureDate && (
                <span className="mt-1 block font-semibold text-amber-600 dark:text-amber-400">
                  {shownDate} is a future date — signatures unlock once the day arrives.
                </span>
              )}
            </div>
          ) : (
            <div className="mt-3.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3 text-xs leading-relaxed">
              <span className="font-semibold text-emerald-500">Saved on {fmtDateTime(payload.submitted_at)}</span>
              {payload.submitted_by ? ` by ${payload.submitted_by}` : ''} — this paper was submitted and can no longer be
              edited through this link. Contact your PULSE admin if something needs changing; they can re-grant edit access.
            </div>
          )}
        </motion.div>

        {/* ---- the paper ---- */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.06, ease: EASE }}
          className="mt-4"
        >
          <div className="mx-auto w-full max-w-[794px] border-2 border-black bg-white px-4 py-5 text-black shadow-2xl sm:px-8 sm:py-7">
            {/* header band */}
            <div className="flex items-center justify-between gap-2 border border-black bg-[#E8E8E8] px-3 py-2">
              <div className="flex-1" />
              <div className="shrink-0 text-center">
                <div className="text-[13px] font-bold uppercase tracking-[0.08em] sm:text-[15px]">
                  Pulse Workforce OS LLC.
                </div>
                <div className="mt-1 bg-[#bbbcbd] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.15em] sm:text-[12px]">
                  Daily Attendance
                </div>
              </div>
              <div className="flex flex-1 justify-end">
                <svg width="38" height="38" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="PULSE logo">
                  <defs>
                    <linearGradient id="sp-logo-g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                      <stop stopColor="#8b5cf6" />
                      <stop offset="1" stopColor="#d946ef" />
                    </linearGradient>
                  </defs>
                  <rect width="64" height="64" rx="16" fill="url(#sp-logo-g)" />
                  <path d="M10 34h9l6-16 10 30 7-14h12" stroke="white" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </div>
            </div>

            {/* info rows */}
            <div className="mt-3 space-y-1.5 font-serif text-[11px] uppercase sm:text-[12px]">
              <div className="flex items-baseline gap-2">
                <span className="w-[118px] shrink-0 font-bold sm:w-[130px]">• Client Name :</span>
                <span className="min-h-[16px] flex-1 border-b border-[#555] px-1 font-bold">
                  {clientName || '\u00A0'}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="w-[118px] shrink-0 font-bold sm:w-[130px]">• Project Name :</span>
                <span className="min-h-[16px] flex-1 border-b border-[#555] px-1 font-bold">
                  {projectName || '\u00A0'}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="w-[118px] shrink-0 font-bold sm:w-[130px]">• Date :</span>
                {editable ? (
                  <input
                    type="date"
                    value={paperDate}
                    min={firstDay}
                    max={lastDay}
                    onChange={(e) => setPaperDate(e.target.value)}
                    aria-label="Date of this attendance paper"
                    className="min-h-[18px] flex-1 border-b border-[#555] bg-transparent px-1 font-serif font-bold text-black outline-none focus:border-brand"
                  />
                ) : (
                  <span className="min-h-[16px] flex-1 border-b border-[#555] px-1 font-bold">
                    {shownDate || '\u00A0'}
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="w-[118px] shrink-0 font-bold sm:w-[130px]">• Strength :</span>
                <span className="min-h-[16px] flex-1 border-b border-[#555] px-1 font-bold">
                  {crew.length}
                </span>
              </div>
            </div>

            {/* crew table */}
            <table className="mt-3 w-full table-fixed border-collapse text-[11px] uppercase sm:text-[12px]">
              <thead>
                <tr className="bg-[#bbbcbd]">
                  <th className="w-[32px] border border-black px-1 py-1.5 text-center text-[11px] font-bold sm:w-[40px] sm:text-[13px]">Sl. No</th>
                  <th className="border border-black px-1.5 py-1.5 text-left text-[11px] font-bold sm:text-[13px]">Name</th>
                  <th className="w-[76px] border border-black px-1 py-1.5 text-center text-[11px] font-bold sm:w-[95px] sm:text-[13px]">Emp. Code</th>
                  <th className="w-[104px] border border-black px-1.5 py-1.5 text-left text-[11px] font-bold sm:w-[150px] sm:text-[13px]">Trade</th>
                  <th className="w-[118px] border border-black px-1 py-1.5 text-center text-[11px] font-bold sm:w-[140px] sm:text-[13px]">Signature</th>
                </tr>
              </thead>
              <tbody>
                {crew.length === 0 && (
                  <tr>
                    <td colSpan={5} className="border border-black px-3 py-6 text-center text-[11px] normal-case text-black/50">
                      No employees were at this site on {shownDate}.
                    </td>
                  </tr>
                )}
                {crew.map((emp, i) => {
                  const rowCls = emp.is_team_leader
                    ? 'bg-[#fffbeb]'
                    : emp.is_supervisor
                      ? 'bg-[#eff6ff]'
                      : i % 2 === 1
                        ? 'bg-[#f3f4f6]'
                        : '';
                  const trade = (emp.trade ?? '').trim();
                  const tradeLabel = emp.is_team_leader
                    ? trade ? `${trade} / TL` : 'TL'
                    : emp.is_supervisor
                      ? trade ? `${trade} / SUPERVISOR` : 'SUPERVISOR'
                      : trade;
                  const value = effValue(emp, shownDate);
                  const canMark = editable && !futureDate;
                  return (
                    <tr key={emp.id} className={rowCls}>
                      <td className="border border-black px-1 py-1.5 text-center font-bold">{i + 1}</td>
                      <td className="border border-black px-1.5 py-1.5">
                        <span className="block truncate font-bold" title={emp.name}>{emp.name}</span>
                      </td>
                      <td className="border border-black px-1 py-1.5 text-center font-bold">
                        <span className="block truncate" title={emp.code}>{emp.code}</span>
                      </td>
                      <td className="border border-black px-1.5 py-1.5">
                        <span className="block truncate font-bold" title={tradeLabel}>{tradeLabel || '—'}</span>
                      </td>
                      <td className="border border-black px-1 py-1 text-center">
                        {signatureCell(value, isPending(emp, shownDate), canMark ? () => openMark(emp) : null)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* extra employees */}
            <div className="mb-1 mt-4 text-[11px] font-bold uppercase tracking-[0.05em]">
              Extra Employees (if any)
            </div>
            <table className="w-full table-fixed border-collapse text-[11px] uppercase sm:text-[12px]">
              <thead>
                <tr className="bg-[#bbbcbd]">
                  <th className="w-[32px] border border-black px-1 py-1.5 text-center text-[11px] font-bold sm:w-[40px] sm:text-[13px]">Sl. No</th>
                  <th className="border border-black px-1.5 py-1.5 text-left text-[11px] font-bold sm:text-[13px]">Name</th>
                  <th className="w-[76px] border border-black px-1 py-1.5 text-center text-[11px] font-bold sm:w-[95px] sm:text-[13px]">Emp. Code</th>
                  <th className="w-[104px] border border-black px-1.5 py-1.5 text-left text-[11px] font-bold sm:w-[150px] sm:text-[13px]">Trade</th>
                  <th className="w-[118px] border border-black px-1 py-1.5 text-center text-[11px] font-bold sm:w-[140px] sm:text-[13px]">Signature</th>
                </tr>
              </thead>
              <tbody>
                {(editable ? Array.from({ length: EXTRA_ROWS }, (_, i) => extras[i] ?? emptyExtra()) : shownExtras)
                  .slice(0, Math.max(EXTRA_ROWS, shownExtras.length))
                  .map((x, i) => {
                    const filled = x.name.trim() !== '';
                    return (
                      <tr key={i} className={i % 2 === 1 ? 'bg-[#f3f4f6]' : ''}>
                        <td className="border border-black px-1 py-1.5 text-center font-bold text-black/35">
                          {crew.length + i + 1}
                        </td>
                        <td className="border border-black px-1.5 py-1.5">
                          {editable ? (
                            <button
                              type="button"
                              onClick={() => openExtra(i)}
                              className="block w-full truncate text-left font-bold"
                              title="Tap to fill in this extra employee"
                            >
                              {filled ? x.name : <span className="font-normal italic text-black/35">+ add extra</span>}
                            </button>
                          ) : (
                            <span className="block truncate font-bold">{x.name || '\u00A0'}</span>
                          )}
                        </td>
                        <td className="border border-black px-1 py-1.5 text-center font-bold">
                          <span className="block truncate">{x.code || '\u00A0'}</span>
                        </td>
                        <td className="border border-black px-1.5 py-1.5">
                          <span className="block truncate font-bold">{x.trade || '\u00A0'}</span>
                        </td>
                        <td className="border border-black px-1 py-1 text-center">
                          {signatureCell(
                            x.mark,
                            false,
                            editable && !futureDate
                              ? () => {
                                setExtraDraft({ ...x, mark: x.mark || '10' });
                                setExtraIdx(i);
                              }
                              : null,
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>

            {/* totals */}
            <div className="mt-4 flex gap-6 border-t-2 border-black pt-2 text-[10px] font-bold uppercase sm:gap-10 sm:text-[11px]">
              <div className="flex flex-1 items-end gap-2">
                <span className="shrink-0">Total Present :</span>
                <span className="min-w-[52px] border-b-[1.5px] border-black pb-0.5 text-center text-[13px] tabular-nums">
                  {totalPresent}
                </span>
              </div>
              <div className="flex flex-1 items-end gap-2">
                <span className="shrink-0">Total Absent :</span>
                <span className="min-w-[52px] border-b-[1.5px] border-black pb-0.5 text-center text-[13px] tabular-nums">
                  {totalAbsent}
                </span>
              </div>
            </div>

            <div className="mt-2 text-right text-[9px] uppercase text-black/40">
              Pulse — digital daily attendance
            </div>
          </div>

          <p className="mx-auto mt-2 max-w-[794px] px-1 text-[11px] leading-relaxed text-muted-foreground">
            Signature marks are saved into the PULSE attendance records — the same table the in-app Attendance Sheet
            reads, so the Excel updates instantly. Extra employees are kept with this form only (they have no HR record).
            Only <span className="font-semibold text-rose-500">A</span> counts as absent.
          </p>
        </motion.div>

        {/* ---- submit bar (editable only) ---- */}
        {editable && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, ease: EASE }}
            className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-2xl border bg-card/95 p-3 shadow-lg backdrop-blur"
          >
            <span className="rounded-full border bg-muted px-2.5 py-1 text-[11px] font-semibold tabular-nums text-muted-foreground">
              {crew.length} on site · {shownDate}
            </span>
            <span className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums',
              pendingEntries.length > 0
                ? 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-border bg-muted text-muted-foreground',
            )}>
              {pendingEntries.length} unsaved mark{pendingEntries.length !== 1 ? 's' : ''}
              {markedDays > 1 ? ` · ${markedDays} days` : ''}
            </span>
            <p className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:block">
              Submitting saves every signature mark into PULSE and locks this link (one-time use).
            </p>
            <Button
              className="ml-auto gap-1.5"
              disabled={submitting}
              onClick={() => setConfirmOpen(true)}
            >
              <Send size={15} />
              Submit Sheet
            </Button>
          </motion.div>
        )}
      </div>

      {/* ---- crew signature dialog ---- */}
      <Dialog open={!!markEmp} onOpenChange={(o) => { if (!o) setMarkEmp(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <PenLine size={14} />
              </span>
              <span className="min-w-0 truncate">Sign — {markEmp?.name}</span>
            </DialogTitle>
            <DialogDescription>
              {markEmp?.code} · {shownDate} — mark this employee&apos;s attendance for the day.
            </DialogDescription>
          </DialogHeader>
          <MarkOptions draft={draft} setDraft={setDraft} invalid={draftParsed.kind === 'invalid'} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarkEmp(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={saveMark} disabled={draftParsed.kind === 'invalid'}>
              <Check size={15} />
              Save Mark
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- extra employee dialog ---- */}
      <Dialog open={extraIdx != null} onOpenChange={(o) => { if (!o) setExtraIdx(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <UserRound size={14} />
              </span>
              Extra employee
            </DialogTitle>
            <DialogDescription>
              Someone working on site today who is not in the PULSE records — kept with this form only.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 block">
              <span className="text-xs font-semibold text-muted-foreground">Name</span>
              <Input
                value={extraDraft.name}
                onChange={(e) => setExtraDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. Walk-in Helper"
                className="mt-1 uppercase"
                maxLength={80}
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Emp. code</span>
              <Input
                value={extraDraft.code}
                onChange={(e) => setExtraDraft((d) => ({ ...d, code: e.target.value }))}
                placeholder="e.g. EX-01"
                className="mt-1 uppercase"
                maxLength={40}
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Trade</span>
              <Input
                value={extraDraft.trade}
                onChange={(e) => setExtraDraft((d) => ({ ...d, trade: e.target.value }))}
                placeholder="e.g. Helper"
                className="mt-1 uppercase"
                maxLength={60}
              />
            </label>
          </div>
          <div className="rounded-xl border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">
              Signature <Plus size={11} className="inline" /> mark
            </p>
            <MarkOptions draft={extraDraft.mark} setDraft={(v) => setExtraDraft((d) => ({ ...d, mark: v }))} invalid={extraMarkParsed.kind === 'invalid'} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtraIdx(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={saveExtra} disabled={extraMarkParsed.kind === 'invalid'}>
              <Check size={15} />
              Save Row
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- confirm dialog ---- */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <CheckCheck size={15} />
              </span>
              Submit this paper?
            </DialogTitle>
            <DialogDescription>
              {pendingEntries.length > 0
                ? `${pendingEntries.length} signature mark${pendingEntries.length !== 1 ? 's' : ''}${markedDays > 1 ? ` across ${markedDays} day${markedDays !== 1 ? 's' : ''}` : ''} will be saved into the PULSE attendance records — the same table the in-app Attendance Sheet reads.`
                : 'No signature marks were made — the paper will be saved as shown (no attendance changes).'}
              {' '}After submitting, this link locks and only shows the saved paper. An admin can re-grant edit access if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              <CalendarCheck size={13} className="shrink-0 text-brand" />
              Paper date {shownDate} · the save date and time are recorded with the sheet.
            </div>
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Your name (optional — saved as the submitter)</span>
              <div className="mt-1 flex items-center gap-2">
                <CalendarDays size={14} className="shrink-0 text-muted-foreground" />
                <Input
                  value={submitterName}
                  onChange={(e) => setSubmitterName(e.target.value)}
                  placeholder="e.g. Site Supervisor"
                  maxLength={60}
                />
              </div>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={submitting}>
              Keep editing
            </Button>
            <Button onClick={submitSheet} disabled={submitting}>
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              Submit &amp; Lock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Shell pieces
// ---------------------------------------------------------------------------
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-64 overflow-hidden" aria-hidden>
        <div className="aurora-blob left-[10%] top-[-40%] size-[28rem] brand-gradient opacity-[0.14]" />
        <div className="aurora-blob right-[-5%] top-[-30%] size-[22rem] bg-emerald-500 opacity-[0.07]" />
      </div>
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-3">
          <Image src="/logo.svg" alt="PULSE" width={28} height={28} className="rounded-lg" />
          <div className="min-w-0">
            <p className="text-[13px] font-bold leading-none tracking-tight">PULSE</p>
            <p className="text-[10px] leading-tight text-muted-foreground">Workforce Operations OS</p>
          </div>
          <span className="ml-auto hidden rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-[10.5px] font-semibold text-brand sm:inline-flex">
            Daily Attendance Paper
          </span>
        </div>
      </header>
      <main className="relative px-3 py-5 sm:px-5">{children}</main>
      <footer className="relative px-4 pb-6 pt-2 text-center text-[10.5px] text-muted-foreground">
        Shared through PULSE — signature marks save straight into the attendance records. Only A counts as absent.
      </footer>
    </div>
  );
}

function EmptyCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="card-glow mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border bg-card px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">{icon}</span>
      <p className="text-base font-semibold">{title}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

export default function SharedAttendancePage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <div className="mx-auto max-w-3xl space-y-3">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-[520px] rounded-2xl" />
          </div>
        </Shell>
      }
    >
      <SharedPaper />
    </Suspense>
  );
}
