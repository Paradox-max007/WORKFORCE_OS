'use client';

// ============================================================================
// PULSE Workforce OS — Public shared attendance sheet (/share/[token])
// ----------------------------------------------------------------------------
// The digital copy of a site's attendance sheet behind a one-time link:
//   • no login — the token in the URL is the capability (anon-key RPC in
//     Supabase mode, same-browser demo store in demo mode)
//   • EDITABLE while the link is active: hours (8, 10.5), "A" for absent or
//     ANY short free-text marker — only "A" counts as absent, everything
//     else is a present day (free text tracked no hours)
//   • one-time use: Submit Sheet saves every changed cell into the real
//     attendance records, freezes a snapshot + the save date/time, and locks
//     the link — re-opening shows the SAVED sheet read-only
//   • an admin can re-grant edit access (attendance page → Links sidebar),
//     which makes this same link editable again
//   • days the employee spent at ANOTHER site (mid-month moves) and future
//     dates render locked — exactly like the admin marking sheet
// ============================================================================

import { motion } from 'framer-motion';
import {
  Building2, CalendarCheck, Check, CheckCheck, Loader2, Lock, PencilLine, Send,
} from 'lucide-react';
import Image from 'next/image';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { dataApi } from '@/lib/data';
import { cn } from '@/lib/utils';
import type { SharedSheetEmployee, SharedSheetPayload, SharedSheetSubmitEntry } from '@/lib/types';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const EMP_COL_W = 170;
const TRADE_COL_W = 78;
const TOTAL_COL_W = 56;
const ABSENT_COL_W = 50;
const DAY_MIN_W = 26;

const pad = (n: number): string => String(n).padStart(2, '0');
const isSunday = (date: string): boolean => new Date(`${date}T00:00:00`).getDay() === 0;

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

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------
function SharedSheet() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = (Array.isArray(params.token) ? params.token[0] : params.token) ?? '';
  const siteParam = search.get('site');

  const [payload, setPayload] = useState<SharedSheetPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // empId → date → raw cell text (local edits, submitted in one shot)
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    dataApi.getSharedAttendanceSheet(token)
      .then((p) => {
        setPayload(p);
        if (p.exists && p.status === 'active') {
          const v: Record<string, Record<string, string>> = {};
          p.employees.forEach((e) => { v[e.id] = { ...e.cells }; });
          setValues(v);
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to open the sheet'));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const editable = payload?.exists === true && payload.status === 'active';
  const snapshot = payload?.status === 'submitted' ? payload.snapshot : null;

  const [year, month, days] = useMemo(() => {
    if (snapshot) return [snapshot.year, snapshot.month, snapshot.days];
    if (payload?.year && payload?.month && payload.days) {
      return [payload.year, payload.month, payload.days];
    }
    const [y, m] = (payload?.month_key ?? `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}`).split('-').map(Number);
    return [y, m, new Date(y, m, 0).getDate()];
  }, [payload, snapshot]);

  const today = payload?.today ?? '';
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days]);

  const rows: SharedSheetEmployee[] = snapshot?.employees ?? payload?.employees ?? [];

  // live row totals from the local edits (editable view)
  const rowTotals = (emp: SharedSheetEmployee): { hours: number; absents: number } => {
    let hours = 0;
    let absents = 0;
    for (const date of emp.markable) {
      const raw = values[emp.id]?.[date] ?? emp.cells[date] ?? '';
      const parsed = parseCell(raw);
      if (parsed.kind === 'hours') hours += parsed.hours ?? 0;
      if (parsed.kind === 'absent') absents += 1;
    }
    return { hours: Math.round(hours * 100) / 100, absents };
  };

  const changedEntries = (): SharedSheetSubmitEntry[] => {
    if (!editable) return [];
    const entries: SharedSheetSubmitEntry[] = [];
    for (const emp of payload?.employees ?? []) {
      for (const date of emp.markable) {
        if (date > today) continue;
        const orig = emp.cells[date] ?? '';
        const cur = (values[emp.id]?.[date] ?? '').trim();
        if (cur !== orig.trim()) entries.push({ employee_id: emp.id, date, value: cur });
      }
    }
    return entries;
  };

  const invalidCount = useMemo(() => {
    if (!editable) return 0;
    let n = 0;
    for (const emp of payload?.employees ?? []) {
      for (const date of emp.markable) {
        if (parseCell(values[emp.id]?.[date] ?? '').kind === 'invalid') n += 1;
      }
    }
    return n;
  }, [editable, payload, values]);

  const crewStats = useMemo(() => {
    if (!editable) {
      return {
        total: snapshot?.totals.hours ?? 0,
        absents: snapshot?.totals.absents ?? 0,
        changes: 0,
      };
    }
    let hours = 0;
    let absents = 0;
    for (const emp of payload?.employees ?? []) {
      const t = rowTotals(emp);
      hours += t.hours;
      absents += t.absents;
    }
    return {
      total: Math.round(hours * 100) / 100,
      absents,
      changes: changedEntries().length,
    };
  }, [editable, payload, snapshot, values]);

  const submitSheet = async () => {
    if (!editable) return;
    if (invalidCount > 0) {
      toast.error(`Fix ${invalidCount} invalid value${invalidCount !== 1 ? 's' : ''} first`, {
        description: 'Hours must be 0–24 (e.g. 8 or 10.5), A for absent, or a short free-text marker (max 40 characters).',
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await dataApi.submitSharedAttendanceSheet(token, changedEntries());
      setConfirmOpen(false);
      toast.success('Sheet submitted and saved', {
        description: `${res.applied} cell${res.applied !== 1 ? 's' : ''} saved · locked at ${fmtDateTime(res.saved_at)} — ask an admin for edit access if anything needs changing.`,
      });
      load(); // → read-only saved view
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
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
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
  void year; void month;

  return (
    <Shell>
      <div className="mx-auto max-w-[1500px]">
        {/* header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ease: EASE }}
          className="card-glow rounded-2xl border bg-card p-5"
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
                    <span className="inline-flex items-center gap-1"><PencilLine size={11} /> Editable — not submitted yet</span>
                  ) : (
                    <span className="inline-flex items-center gap-1"><Lock size={11} /> Submitted — read-only</span>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Attendance Sheet · {monthLabel(payload.month_key)} · digital copy shared by PULSE
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-semibold tabular-nums text-emerald-500">
                Total Hours: {crewStats.total}
              </span>
              <span className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold tabular-nums',
                crewStats.absents > 0
                  ? 'border-rose-500/25 bg-rose-500/10 text-rose-500'
                  : 'border-border bg-muted text-muted-foreground',
              )}>
                Total Absent: {crewStats.absents}
              </span>
            </div>
          </div>

          {/* status banner */}
          {editable ? (
            <div className="mt-4 rounded-xl border border-brand/25 bg-brand/[0.06] px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              Mark every day: <span className="font-semibold text-foreground">hours</span> (e.g. 8, 10.5) ·
              <span className="font-semibold text-rose-500"> A</span> for absent ·
              <span className="font-semibold text-foreground"> any short free text</span> (e.g. OT, H, travel — never counted as absent).
              Then press <span className="font-semibold text-foreground">Submit Sheet</span> — the sheet saves and this link locks
              (one-time use). Cells for days at another site and future dates are locked.
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3 text-xs leading-relaxed">
              <span className="font-semibold text-emerald-500">Saved on {fmtDateTime(payload.submitted_at)}</span>
              {payload.submitted_by ? ` by ${payload.submitted_by}` : ''} — this sheet was submitted and can no longer be
              edited through this link. Contact your PULSE admin if something needs changing; they can re-grant edit access.
              {snapshot && (
                <span className="text-muted-foreground"> Crew total at save time: {snapshot.totals.hours}h · {snapshot.totals.absents} absent.</span>
              )}
            </div>
          )}
        </motion.div>

        {/* sheet table */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.06, ease: EASE }}
          className="card-glow mt-4 overflow-hidden rounded-2xl border bg-card"
        >
          <div className="overflow-x-auto">
            <table
              className="w-full table-fixed border-collapse text-sm"
              style={{ minWidth: EMP_COL_W + TRADE_COL_W + TOTAL_COL_W + ABSENT_COL_W + dayList.length * DAY_MIN_W }}
            >
              <thead>
                <tr className="border-b bg-muted/60 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th style={{ width: EMP_COL_W }} className="sticky left-0 z-20 border-x border-foreground/15 bg-muted/60 px-2 py-2 font-medium">
                    Employee
                  </th>
                  <th style={{ width: TRADE_COL_W }} className="border-x border-b border-foreground/15 bg-muted/60 px-2 py-2 font-medium">
                    Trade
                  </th>
                  {dayList.map((d) => {
                    const date = `${payload.month_key}-${pad(d)}`;
                    const sun = isSunday(date);
                    const future = date > today;
                    return (
                      <th
                        key={d}
                        className={cn(
                          'border-x border-b border-foreground/15 px-0 py-2 text-center font-medium',
                          sun && 'bg-rose-500/[0.07] text-rose-500',
                          future && 'text-muted-foreground/50',
                        )}
                        title={`${date}${sun ? ' (Sunday)' : ''}${future ? ' — future (locked)' : ''}`}
                      >
                        <div className="text-[10px] leading-tight">{d}</div>
                        <div className={cn('text-[8px] font-normal normal-case leading-tight opacity-70', sun && 'text-rose-500')}>
                          {WEEKDAYS[new Date(`${date}T00:00:00`).getDay()]}
                        </div>
                      </th>
                    );
                  })}
                  <th style={{ width: TOTAL_COL_W }} className="border-x border-b border-foreground/15 bg-muted/60 px-1 py-2 text-center font-medium text-emerald-500">
                    Total H
                  </th>
                  <th style={{ width: ABSENT_COL_W }} className="border-l border-b border-foreground/15 bg-muted/60 px-1 py-2 text-center font-medium text-rose-500">
                    Absent
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={dayList.length + 4} className="border-b px-4 py-10 text-center text-xs text-muted-foreground">
                      No employees were assigned to this site during {monthLabel(payload.month_key)}.
                    </td>
                  </tr>
                )}
                {rows.map((emp, i) => {
                  const mark = new Set(emp.markable);
                  const totals = editable ? rowTotals(emp) : { hours: emp.total_hours ?? 0, absents: emp.absents ?? 0 };
                  return (
                    <motion.tr
                      key={emp.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i * 0.02, 0.2), ease: EASE }}
                    >
                      <td className="sticky left-0 z-10 border-x border-b border-foreground/15 bg-card px-2 py-1.5">
                        <p className="truncate text-[12px] font-medium leading-tight">{emp.name}</p>
                        <p className="truncate font-mono text-[9.5px] leading-tight text-muted-foreground">{emp.code}</p>
                      </td>
                      <td className="border-x border-b border-foreground/15 px-1.5 py-1.5 text-center">
                        <span className="block truncate text-[10px] text-muted-foreground" title={emp.trade ?? ''}>{emp.trade ?? '—'}</span>
                      </td>
                      {dayList.map((d) => {
                        const date = `${payload.month_key}-${pad(d)}`;
                        const sun = isSunday(date);
                        const future = date > today;
                        const atSite = mark.has(date);
                        const locked = !editable || future || !atSite;
                        const value = editable
                          ? values[emp.id]?.[date] ?? ''
                          : emp.cells[date] ?? '';
                        const parsed = parseCell(value);
                        const showValue = !editable && value !== '';
                        return (
                          <td
                            key={d}
                            className={cn(
                              'border-x border-b border-foreground/15 p-0 text-center',
                              sun && 'bg-rose-500/[0.05]',
                              future && 'bg-muted/40',
                              editable && !future && !atSite && !sun && 'bg-muted/25',
                            )}
                          >
                            {locked ? (
                              <div
                                className={cn(
                                  'flex h-9 w-full items-center justify-center text-[10px] text-muted-foreground/70',
                                  showValue && parsed.kind === 'absent' && 'bg-rose-500/10 text-[11px] font-bold text-rose-500',
                                  showValue && parsed.kind === 'hours' && 'text-[11px] font-medium tabular-nums text-foreground',
                                  showValue && parsed.kind === 'text' && 'bg-brand/[0.08] text-[11px] font-semibold text-brand',
                                )}
                                title={future ? 'Future date — not editable' : !atSite ? 'At another site this day' : showValue ? value : 'Locked'}
                              >
                                {showValue ? value : (!atSite && !future ? '·' : '')}
                              </div>
                            ) : (
                              <input
                                value={value}
                                data-day-col={pad(d)}
                                onChange={(e) => setValues((v) => ({
                                  ...v,
                                  [emp.id]: { ...(v[emp.id] ?? {}), [date]: e.target.value },
                                }))}
                                onKeyDown={(e) => {
                                  // spreadsheet-style walking: Enter/↑/↓ hop
                                  // between employees in the same day column
                                  if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    const cell = e.target as HTMLInputElement;
                                    const col = cell.dataset.dayCol;
                                    const inputs = Array.from(
                                      document.querySelectorAll<HTMLInputElement>(`input[data-day-col="${col}"]`),
                                    );
                                    const idx = inputs.indexOf(cell);
                                    const next = e.key === 'ArrowUp' ? inputs[idx - 1] : inputs[Math.min(idx + 1, inputs.length - 1)];
                                    next?.focus();
                                    next?.select();
                                  }
                                }}
                                aria-label={`${emp.name} — ${date}`}
                                className={cn(
                                  'h-9 w-full bg-transparent text-center text-[11px] font-medium tabular-nums outline-none transition-colors',
                                  'hover:bg-brand/10 focus:bg-brand/15 focus:ring-1 focus:ring-brand/60 focus:ring-inset',
                                  parsed.kind === 'absent' && 'bg-rose-500/10 font-bold text-rose-500',
                                  parsed.kind === 'text' && 'bg-brand/[0.08] font-semibold text-brand',
                                  parsed.kind === 'invalid' && 'bg-rose-500/15 font-bold text-rose-500',
                                )}
                              />
                            )}
                          </td>
                        );
                      })}
                      <td className="border-x border-b border-foreground/15 bg-card px-1 py-1.5 text-center">
                        <span className="inline-flex min-w-9 justify-center rounded-md bg-emerald-500/10 px-1 py-0.5 text-[11px] font-bold tabular-nums text-emerald-500">
                          {totals.hours}
                        </span>
                      </td>
                      <td className="border-l border-b border-foreground/15 bg-card px-1 py-1.5 text-center">
                        <span className={cn(
                          'inline-flex min-w-7 justify-center rounded-md px-1 py-0.5 text-[11px] font-bold tabular-nums',
                          totals.absents > 0 ? 'bg-rose-500/10 text-rose-500' : 'bg-muted text-muted-foreground',
                        )}>
                          {totals.absents}
                        </span>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="border-t bg-muted/30 px-4 py-2.5 text-[11px] text-muted-foreground">
            {rows.length} employee{rows.length !== 1 ? 's' : ''} · alphabetical ·
            hours (e.g. 8, 10.5) or <span className="font-semibold text-rose-500">A</span> for absent or any free-text marker —
            only <span className="font-semibold text-rose-500">A</span> counts as absent
            {editable && (
              <> · <span className="font-medium text-foreground">Enter / ↑ / ↓ move between employees</span></>
            )}
          </p>
        </motion.div>

        {/* submit bar (editable only) */}
        {editable && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, ease: EASE }}
            className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-2xl border bg-card/95 p-3 shadow-lg backdrop-blur"
          >
            <span className="rounded-full border bg-muted px-2.5 py-1 text-[11px] font-semibold tabular-nums text-muted-foreground">
              {rows.length} employees
            </span>
            <span className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums',
              crewStats.changes > 0
                ? 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-border bg-muted text-muted-foreground',
            )}>
              {crewStats.changes} change{crewStats.changes !== 1 ? 's' : ''}
            </span>
            {invalidCount > 0 && (
              <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-rose-500">
                {invalidCount} invalid
              </span>
            )}
            <p className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:block">
              Submitting saves every changed cell into PULSE and locks this link (one-time use).
            </p>
            <Button
              className="ml-auto gap-1.5"
              disabled={submitting || invalidCount > 0}
              onClick={() => setConfirmOpen(true)}
            >
              <Send size={15} />
              Submit Sheet
            </Button>
          </motion.div>
        )}
      </div>

      {/* confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <CheckCheck size={15} />
              </span>
              Submit this sheet?
            </DialogTitle>
            <DialogDescription>
              {crewStats.changes > 0
                ? `${crewStats.changes} cell${crewStats.changes !== 1 ? 's' : ''} will be saved into the PULSE attendance records.`
                : 'No changes were made — the current marks will be saved as the submitted sheet.'}
              {' '}After submitting, this link locks and only shows the saved sheet. An admin can re-grant edit access if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            <CalendarCheck size={13} className="shrink-0 text-brand" />
            The save date and time are recorded with the sheet.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={submitting}>
              Keep editing
            </Button>
            <Button onClick={submitSheet} disabled={submitting || invalidCount > 0}>
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
        <div className="mx-auto flex max-w-[1500px] items-center gap-2.5 px-4 py-3">
          <Image src="/logo.svg" alt="PULSE" width={28} height={28} className="rounded-lg" />
          <div className="min-w-0">
            <p className="text-[13px] font-bold leading-none tracking-tight">PULSE</p>
            <p className="text-[10px] leading-tight text-muted-foreground">Workforce Operations OS</p>
          </div>
          <span className="ml-auto hidden rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-[10.5px] font-semibold text-brand sm:inline-flex">
            Digital Attendance Sheet
          </span>
        </div>
      </header>
      <main className="relative px-3 py-5 sm:px-5">{children}</main>
      <footer className="relative px-4 pb-6 pt-2 text-center text-[10.5px] text-muted-foreground">
        Shared through PULSE — hours, A (absent) or free-text markers. Only A counts as absent.
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
          <div className="mx-auto max-w-[1500px] space-y-3">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        </Shell>
      }
    >
      <SharedSheet />
    </Suspense>
  );
}
