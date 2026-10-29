'use client';

// ============================================================================
// PULSE Workforce OS — Employee Details (dedicated page)
// ----------------------------------------------------------------------------
// Replaces the old employee details modal with a full page: profile header,
// Personal / Professional / Documents / Record sections, a monthly Track Record
// timesheet calendar, and a WhatsApp share flow that exports the track record
// (lifetime or chosen months) as a multi-page A4 PDF via html2canvas-pro.
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, Briefcase, CalendarCheck, Clock3, Crown, FileDown, FileText,
  Loader2, MessageCircle, Pencil, Tent, UserRound, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AnimatedCounter, EmptyState, EmployeeStatusBadge, RatingStars, SectionTitle,
  SiteBadge, SkeletonRows,
} from '@/components/shared/primitives';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dataApi } from '@/lib/data';
import { fmtDate, fmtDateTime, initials } from '@/lib/format';
import { downloadEmployeeCv } from '@/lib/pdf';
import { exportTrackRecordPdf, trackRecordFilename } from '@/lib/pdf-trackrecord';
import { cn } from '@/lib/utils';
import type { Attendance, DocumentStatus, EmployeeStatus, EmployeeVM } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useRealtimeVersion } from '@/store/realtime';

// ---------------------------------------------------------------------------
// Month / range helpers (same patterns as the attendance module)
// ---------------------------------------------------------------------------
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
const todayYMD = (): string => {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth() + 1, t.getDate());
};
const isSunday = (date: string): boolean => new Date(`${date}T00:00:00`).getDay() === 0;
const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate();

interface MonthPoint { y: number; m: number }
const monthKeyOf = (p: MonthPoint): string => `${p.y}-${pad(p.m)}`;
const monthIndexOf = (p: MonthPoint): number => p.y * 12 + (p.m - 1);
const monthFromIndex = (i: number): MonthPoint => ({ y: Math.floor(i / 12), m: (i % 12) + 1 });
const monthOf = (iso: string): MonthPoint => {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
};
const currentMonthPoint = (): MonthPoint => {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth() + 1 };
};
const monthLabel = (p: MonthPoint): string => `${MONTH_NAMES[p.m - 1]} ${p.y}`;
const selectableYears = (): number[] => {
  const y = currentMonthPoint().y;
  return [y - 2, y - 1, y];
};
const fmtHours = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: 'Active',
  pending_deletion: 'Pending Deletion',
  deleted: 'Deleted',
};

/** "1, 2, 3, 5" → [1, 2, 3, 5] (validated, deduped, sorted) */
const parseMonthsInput = (raw: string): number[] => {
  const tokens = raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const nums = tokens.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  return [...new Set(nums)].sort((a, b) => a - b);
};

const invalidMonthTokens = (raw: string): string[] => {
  const tokens = raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  return tokens.filter((t) => {
    const n = Number(t);
    return !Number.isInteger(n) || n < 1 || n > 12;
  });
};

const totalsFor = (records: Attendance[]): { hours: number; absents: number } => {
  let hours = 0;
  let absents = 0;
  records.forEach((r) => {
    if (r.status === 'present' && r.hours != null) hours += r.hours;
    else if (r.status === 'absent') absents += 1;
  });
  return { hours: Math.round(hours * 100) / 100, absents };
};

const describeMonths = (points: MonthPoint[]): string => {
  if (points.length === 0) return '';
  if (points.length === 1) return monthLabel(points[0]);
  const sorted = [...points].sort((a, b) => monthIndexOf(a) - monthIndexOf(b));
  if (sorted.every((p) => p.y === sorted[0].y)) {
    return `${sorted.map((p) => MONTH_SHORT[p.m - 1]).join(', ')} ${sorted[0].y}`;
  }
  return `${monthLabel(sorted[0])} – ${monthLabel(sorted[sorted.length - 1])}`;
};

/** Lifetime range: first working month = join month, or the earliest month that
 *  has marked attendance (whichever is earlier — probed with a bounded look-back
 *  that never precedes the employee record). Last working month = the current
 *  month, or the updated_at month for deleted / pending-deletion employees. */
async function computeLifetimeRange(emp: EmployeeVM): Promise<{ first: MonthPoint; last: MonthPoint }> {
  const current = currentMonthPoint();
  let last = current;
  if ((emp.status === 'deleted' || emp.status === 'pending_deletion') && emp.updated_at) {
    const lu = monthOf(emp.updated_at);
    if (monthIndexOf(lu) < monthIndexOf(current)) last = lu;
  }
  const created = monthOf(emp.created_at);
  let first = emp.join_date ? monthOf(emp.join_date) : created;
  const floor = Math.max(monthIndexOf(created), monthIndexOf(first) - 6);
  for (let i = monthIndexOf(first) - 1; i >= floor; i--) {
    try {
      const rows = await dataApi.getMonthAttendance(monthKeyOf(monthFromIndex(i)));
      const hasMarks = rows.some((r) => r.employee_id === emp.id && r.status !== 'not_marked');
      if (!hasMarks) break;
      first = monthFromIndex(i);
    } catch {
      break;
    }
  }
  if (monthIndexOf(first) > monthIndexOf(last)) first = last;
  return { first, last };
}

const enumerateMonths = (first: MonthPoint, last: MonthPoint): MonthPoint[] => {
  const out: MonthPoint[] = [];
  for (let i = monthIndexOf(first); i <= monthIndexOf(last); i++) out.push(monthFromIndex(i));
  return out;
};

// ---------------------------------------------------------------------------
// Shared display pieces
// ---------------------------------------------------------------------------
function InfoRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  const text = typeof value === 'string' ? value : undefined;
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 truncate text-sm font-medium', mono && 'font-mono text-xs')} title={text}>
        {value ?? '—'}
      </p>
    </div>
  );
}

function DocStatusPill({ status }: { status: DocumentStatus | null }) {
  if (!status) return <span className="text-sm font-medium text-muted-foreground">—</span>;
  const map: Record<DocumentStatus, string> = {
    Valid: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-500',
    Expired: 'border-rose-500/25 bg-rose-500/10 text-rose-500',
    'N/A': 'border-zinc-500/25 bg-zinc-500/10 text-zinc-400',
  };
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', map[status])}>
      {status}
    </span>
  );
}

function InfoCard({ index, icon, title, sub, children }: {
  index: number; icon: ReactNode; title: string; sub?: string; children: ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.08 + index * 0.06, ease: EASE }}
      className="card-glow rounded-xl border bg-card p-5"
    >
      <SectionTitle icon={icon} title={title} sub={sub} />
      <div className="mt-4 grid gap-x-4 gap-y-4 sm:grid-cols-2">{children}</div>
    </motion.section>
  );
}

/**
 * Calendar-style month timesheet. Two variants:
 *  - themed (default): app tokens, used on the Track Record page section.
 *  - print: explicit white/black classes so the captured PDF looks the same in
 *    light & dark themes (html2canvas-pro captures the real computed colors).
 */
function MonthGrid({ year, month, records, print = false }: {
  year: number; month: number; records: Attendance[]; print?: boolean;
}) {
  const today = todayYMD();
  const lead = new Date(year, month - 1, 1).getDay();
  const days = daysInMonth(year, month);
  const byDate = useMemo(() => {
    const m = new Map<string, Attendance>();
    records.forEach((r) => m.set(r.date, r));
    return m;
  }, [records]);

  return (
    <div className={cn('grid grid-cols-7', print ? 'gap-1' : 'gap-1.5')}>
      {WEEKDAYS.map((w) => (
        <div
          key={w}
          className={cn(
            'pb-1 text-center text-[11px] font-semibold uppercase tracking-wide',
            print
              ? (w === 'Sun' ? 'text-rose-600' : 'text-zinc-500')
              : (w === 'Sun' ? 'text-rose-500' : 'text-muted-foreground'),
          )}
        >
          {w}
        </div>
      ))}
      {Array.from({ length: lead }).map((_, i) => <div key={`lead-${i}`} />)}
      {Array.from({ length: days }).map((_, idx) => {
        const d = idx + 1;
        const date = ymd(year, month, d);
        const rec = byDate.get(date);
        const future = date > today;
        const sun = isSunday(date);
        const absent = rec?.status === 'absent';
        const hasHours = rec?.status === 'present' && rec.hours != null;
        return (
          <div
            key={d}
            role="img"
            aria-label={`${date}${sun ? ', Sunday' : ''}${future ? ', upcoming' : absent ? ', absent' : hasHours ? `, ${rec?.hours} hours worked` : ', not marked'}`}
            className={cn(
              'relative flex min-h-16 flex-col items-center justify-center rounded-lg border text-sm',
              print ? 'border-zinc-300 bg-white text-zinc-900' : 'border-border/60 bg-background/60',
              sun && (print ? 'border-rose-200 bg-rose-50' : 'border-rose-500/20 bg-rose-500/[0.04]'),
              future && 'opacity-40',
              date === today && (print ? 'ring-2 ring-zinc-500' : 'ring-2 ring-brand/50'),
            )}
          >
            <span className={cn('absolute left-1.5 top-1 text-[10px]', print ? 'text-zinc-500' : 'text-muted-foreground')}>
              {d}
            </span>
            {absent ? (
              <span className={cn('text-lg font-bold', print ? 'text-rose-600' : 'text-rose-500')}>A</span>
            ) : hasHours ? (
              <span className={cn('text-base font-semibold tabular-nums', print ? 'text-emerald-700' : 'text-emerald-500')}>
                {rec?.hours}h
              </span>
            ) : (
              <span className={cn('text-xs', print ? 'text-zinc-400' : 'text-muted-foreground/50')}>—</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print preview blocks (explicit light colors — captured by html2canvas-pro)
// ---------------------------------------------------------------------------
function PrintHeaderBlock({ emp, points }: { emp: EmployeeVM; points: MonthPoint[] }) {
  return (
    <header className="rounded-lg border-2 border-zinc-300 bg-white p-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-1.5 shrink-0 rounded-full bg-violet-600" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
            Pulse Workforce OS — Employee Track Record
          </p>
          <h2 className="truncate text-xl font-bold leading-tight text-zinc-900">{emp.full_name}</h2>
          <p className="truncate text-xs font-medium text-zinc-600">
            <span className="font-mono">{emp.employee_code}</span>
            {' · '}{emp.position ?? 'Team Member'}{' · '}{emp.company_name ?? '—'}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-zinc-200 pt-2 text-[11px] leading-relaxed text-zinc-800 sm:grid-cols-3">
        <p><span className="font-semibold text-zinc-500">Site:</span> {emp.site_name ?? 'No Site Assigned'}</p>
        <p><span className="font-semibold text-zinc-500">Camp:</span> {emp.camp_name ?? '—'}{emp.camp_name ? ` (Block ${emp.camp_block ?? '—'}, Room ${emp.camp_room ?? '—'})` : ''}</p>
        <p><span className="font-semibold text-zinc-500">Nationality:</span> {emp.nationality ?? '—'}</p>
        <p><span className="font-semibold text-zinc-500">Rating:</span> {emp.rating.toFixed(1)} / 5.0</p>
        <p><span className="font-semibold text-zinc-500">Status:</span> {STATUS_LABEL[emp.status]}</p>
        <p><span className="font-semibold text-zinc-500">Generated:</span> {fmtDate(todayYMD())}</p>
      </div>
      {points.length > 0 && (
        <p className="mt-2 border-t border-zinc-200 pt-2 text-[11px] text-zinc-700">
          <span className="font-semibold text-zinc-500">Period:</span> {describeMonths(points)}
          {' — '}{points.length} month{points.length !== 1 ? 's' : ''}
        </p>
      )}
    </header>
  );
}

function PrintMonthCard({ emp, preview }: { emp: EmployeeVM; preview: MonthPreview }) {
  const totals = totalsFor(preview.records);
  return (
    <section className="break-inside-avoid rounded-lg border-2 border-zinc-300 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-zinc-300 pb-2">
        <h3 className="text-sm font-bold tracking-wide text-zinc-900">
          {MONTH_NAMES[preview.point.m - 1].toUpperCase()} {preview.point.y}
          {' — '}{(emp.site_name ?? 'No Site Assigned').toUpperCase()}
        </h3>
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
          {emp.full_name} · {emp.employee_code}
        </span>
      </div>
      <div className="mt-3">
        <MonthGrid year={preview.point.y} month={preview.point.m} records={preview.records} print />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-3">
        <span className="rounded-md border-2 border-emerald-700 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-900">
          TOTAL HOURS: {fmtHours(totals.hours)}
        </span>
        <span className="rounded-md border-2 border-rose-700 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-900">
          TOTAL ABSENT: {totals.absents}
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Share via WhatsApp dialog (options → preview → PDF export)
// ---------------------------------------------------------------------------
interface MonthPreview { point: MonthPoint; records: Attendance[] }

function ShareDialogContent({ emp, onPreviewChange }: {
  emp: EmployeeVM;
  onPreviewChange: (hasPreview: boolean) => void;
}) {
  const [includeTrackRecord, setIncludeTrackRecord] = useState(true);
  const [shareMode, setShareMode] = useState<'lifetime' | 'specific'>('lifetime');
  const [specificYear, setSpecificYear] = useState(currentMonthPoint().y);
  const [monthsInput, setMonthsInput] = useState('');
  const [lifetimeRange, setLifetimeRange] = useState<{ first: MonthPoint; last: MonthPoint } | null>(null);
  const [previewMonths, setPreviewMonths] = useState<MonthPreview[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [simpleBusy, setSimpleBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [waBusy, setWaBusy] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const employeeId = emp.id;

  const parsedMonths = useMemo(() => parseMonthsInput(monthsInput), [monthsInput]);
  const invalidTokens = useMemo(() => invalidMonthTokens(monthsInput), [monthsInput]);
  const lifetimeCount = useMemo(() => (
    lifetimeRange ? monthIndexOf(lifetimeRange.last) - monthIndexOf(lifetimeRange.first) + 1 : 0
  ), [lifetimeRange]);

  // Live "first working month → last working month" helper text.
  useEffect(() => {
    if (!includeTrackRecord || shareMode !== 'lifetime') return;
    let cancelled = false;
    (async () => {
      const range = await computeLifetimeRange(emp);
      if (!cancelled) setLifetimeRange(range);
    })();
    return () => { cancelled = true; };
    // Deps are stable on purpose: the emp object identity changes on every realtime
    // refetch, but only the employee id matters here (join_date/updated_at are fixed
    // within a dialog session).
  }, [employeeId, includeTrackRecord, shareMode]);

  const buildPreview = async () => {
    let points: MonthPoint[];
    if (shareMode === 'specific') {
      if (parsedMonths.length === 0) {
        toast.error('No months selected', { description: 'Enter at least one month number (1–12), e.g. 1, 2, 3.' });
        return;
      }
      points = parsedMonths.map((m) => ({ y: specificYear, m }));
    } else {
      const range = lifetimeRange ?? await computeLifetimeRange(emp);
      points = enumerateMonths(range.first, range.last);
    }
    setPreviewBusy(true);
    try {
      const results = await Promise.all(
        points.map((p) => dataApi.getMonthAttendance(monthKeyOf(p)).catch(() => [] as Attendance[])),
      );
      const previews: MonthPreview[] = points.map((p, i) => ({
        point: p,
        records: results[i].filter((r) => r.employee_id === employeeId),
      }));
      setPreviewMonths(previews);
      onPreviewChange(true);
      toast.success(`Preview ready — ${previews.length} month${previews.length !== 1 ? 's' : ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to build the preview');
    } finally {
      setPreviewBusy(false);
    }
  };

  /** Old simple flow: CV PDF + wa.me, no track record. */
  const simpleShare = () => {
    setSimpleBusy(true);
    try {
      downloadEmployeeCv(emp);
      window.open(`https://wa.me/?text=${encodeURIComponent('Employee details attached')}`, '_blank');
      toast.success('CV downloaded — WhatsApp opened');
    } finally {
      setSimpleBusy(false);
    }
  };

  const exportPreview = async (): Promise<boolean> => {
    const el = previewRef.current;
    if (!el) {
      toast.error('The preview is not ready yet');
      return false;
    }
    try {
      await exportTrackRecordPdf(el, trackRecordFilename(emp));
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'PDF export failed');
      return false;
    }
  };

  const downloadPreview = async () => {
    setPdfBusy(true);
    const ok = await exportPreview();
    if (ok) toast.success('Track record PDF downloaded');
    setPdfBusy(false);
  };

  const sharePreview = async () => {
    setWaBusy(true);
    const summary = previewMonths ? describeMonths(previewMonths.map((p) => p.point)) : '';
    const waUrl = `https://wa.me/?text=${encodeURIComponent(`Track record for ${emp.full_name} (${emp.employee_code}) — ${summary}. PDF attached.`)}`;
    // opened synchronously inside the click so popup blockers allow it
    const win = window.open('', '_blank');
    const ok = await exportPreview();
    if (ok) {
      if (win) win.location.href = waUrl;
      else window.open(waUrl, '_blank');
      toast.success('Track record PDF downloaded — WhatsApp opened');
    } else if (win) {
      win.close();
    }
    setWaBusy(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageCircle size={16} className="text-emerald-500" aria-hidden="true" />
          {previewMonths ? 'Track Record Preview' : 'Share via WhatsApp'}
        </DialogTitle>
        <DialogDescription>
          {previewMonths
            ? `${emp.full_name} — ${previewMonths.length} month${previewMonths.length !== 1 ? 's' : ''} (${describeMonths(previewMonths.map((p) => p.point))}). The PDF contains exactly what you see below.`
            : `Send ${emp.full_name}'s details — with or without a monthly track record PDF.`}
        </DialogDescription>
      </DialogHeader>

      {!previewMonths && (
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3">
          <div>
            <Label htmlFor="include-track-record" className="text-sm">Include track record</Label>
            <p className="text-xs text-muted-foreground">Attach the monthly timesheet PDF to the share.</p>
          </div>
          <Switch
            id="include-track-record"
            checked={includeTrackRecord}
            onCheckedChange={setIncludeTrackRecord}
            aria-label="Include track record in the shared PDF"
          />
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {previewMonths ? (
          <motion.div
            key="preview"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="space-y-4"
          >
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border bg-muted/40 p-3">
              <div ref={previewRef} className="space-y-4 bg-white p-3 text-zinc-900 sm:p-5">
                <PrintHeaderBlock emp={emp} points={previewMonths.map((p) => p.point)} />
                {previewMonths.map((pv) => (
                  <PrintMonthCard key={monthKeyOf(pv.point)} emp={emp} preview={pv} />
                ))}
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                onClick={() => { setPreviewMonths(null); onPreviewChange(false); }}
                disabled={pdfBusy || waBusy}
              >
                <ArrowLeft size={14} /> Back
              </Button>
              <Button variant="outline" onClick={downloadPreview} disabled={pdfBusy || waBusy}>
                {pdfBusy ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} Download PDF
              </Button>
              <Button className="brand-gradient font-semibold text-white" onClick={sharePreview} disabled={pdfBusy || waBusy}>
                {waBusy ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />} Share via WhatsApp
              </Button>
            </div>
          </motion.div>
        ) : !includeTrackRecord ? (
          <motion.div
            key="cv-only"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="space-y-4"
          >
            <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              Simple flow: shares the employee CV PDF only — no track record months are attached.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={() => { downloadEmployeeCv(emp); toast.success('CV PDF downloaded'); }}
                disabled={simpleBusy}
              >
                <FileDown size={14} /> Download CV
              </Button>
              <Button className="brand-gradient font-semibold text-white" onClick={simpleShare} disabled={simpleBusy}>
                {simpleBusy ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />} Share via WhatsApp
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="options"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="space-y-4"
          >
            <Tabs value={shareMode} onValueChange={(v) => setShareMode(v as 'lifetime' | 'specific')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="lifetime">Lifetime</TabsTrigger>
                <TabsTrigger value="specific">Specific months</TabsTrigger>
              </TabsList>
            </Tabs>

            {shareMode === 'lifetime' ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                {lifetimeRange ? (
                  <p className="text-muted-foreground">
                    From <span className="font-semibold text-foreground">{monthLabel(lifetimeRange.first)}</span> to{' '}
                    <span className="font-semibold text-foreground">{monthLabel(lifetimeRange.last)}</span> —{' '}
                    <span className="font-semibold text-brand">{lifetimeCount} month{lifetimeCount !== 1 ? 's' : ''}</span>{' '}
                    will be included (first working month → last working month).
                  </p>
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Computing the first working month…
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-[104px_1fr] gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="share-year">Year</Label>
                    <Select value={String(specificYear)} onValueChange={(v) => setSpecificYear(Number(v))}>
                      <SelectTrigger id="share-year" className="bg-card" aria-label="Year for the selected months">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {selectableYears().map((y) => (
                          <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="share-months">Months</Label>
                    <Input
                      id="share-months"
                      placeholder="e.g. 1, 2, 3, 5"
                      value={monthsInput}
                      onChange={(e) => setMonthsInput(e.target.value)}
                      aria-label="Month numbers to include, comma separated"
                    />
                  </div>
                </div>
                {invalidTokens.length > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Ignoring: {invalidTokens.join(', ')} — only month numbers 1–12 are kept.
                  </p>
                )}
                {parsedMonths.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedMonths.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand"
                      >
                        {MONTH_SHORT[m - 1]} {specificYear}
                        <button
                          type="button"
                          aria-label={`Remove ${MONTH_SHORT[m - 1]} ${specificYear}`}
                          className="rounded-full p-0.5 transition-colors hover:bg-brand/20"
                          onClick={() => setMonthsInput(parsedMonths.filter((x) => x !== m).join(', '))}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Type month numbers separated by commas — each becomes one timesheet page.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={() => { downloadEmployeeCv(emp); toast.success('CV PDF downloaded'); }}
                disabled={previewBusy}
              >
                <FileDown size={14} /> Download CV
              </Button>
              <Button className="brand-gradient font-semibold text-white" onClick={buildPreview} disabled={previewBusy}>
                {previewBusy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Preview PDF
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function EmployeeDetailsPage() {
  const realtimeVersion = useRealtimeVersion(['employee', 'attendance', 'site', 'camp']);
  const selectedEmployeeId = useAppStore((s) => s.selectedEmployeeId);
  const navigateToEmployees = useAppStore((s) => s.navigateToEmployees);
  const navigateToEmployeeForm = useAppStore((s) => s.navigateToEmployeeForm);

  const [emp, setEmp] = useState<EmployeeVM | null>(null);
  const [loading, setLoading] = useState(true);

  const initialPoint = currentMonthPoint();
  const [trYear, setTrYear] = useState(initialPoint.y);
  const [trMonth, setTrMonth] = useState(initialPoint.m);
  const [trLoading, setTrLoading] = useState(true);
  const [trRecords, setTrRecords] = useState<Attendance[] | null>(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [sharePreviewActive, setSharePreviewActive] = useState(false);

  const trMonthKey = `${trYear}-${pad(trMonth)}`;

  // ---- resolve the employee ---------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const emps = await dataApi.listEmployees();
        if (cancelled) return;
        setEmp(emps.find((e) => e.id === selectedEmployeeId) ?? null);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load employee');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedEmployeeId, realtimeVersion]);

  // ---- track record month ------------------------------------------------------
  useEffect(() => {
    const employeeId = selectedEmployeeId;
    if (!employeeId) return;
    let cancelled = false;
    dataApi.getMonthAttendance(trMonthKey)
      .then((rows) => {
        if (cancelled) return;
        setTrRecords(rows.filter((r) => r.employee_id === employeeId));
        setTrLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setTrRecords([]);
        setTrLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedEmployeeId, trMonthKey, realtimeVersion]);

  const trTotals = useMemo(() => totalsFor(trRecords ?? []), [trRecords]);

  // ---- loading ------------------------------------------------------------------
  if (loading) {
    return (
      <div className="mx-auto max-w-6xl">
        <Skeleton className="mb-4 h-9 w-44 rounded-lg" />
        <Skeleton className="mb-4 h-44 rounded-xl" />
        <SkeletonRows rows={4} />
      </div>
    );
  }

  // ---- not found ------------------------------------------------------------------
  if (!emp) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="mx-auto max-w-6xl"
      >
        <EmptyState
          icon={<UserRound size={22} />}
          title="Employee not found"
          description="This employee may have been removed, or the link is out of date."
          action={
            <Button variant="outline" onClick={() => navigateToEmployees()} aria-label="Back to employees list">
              <ArrowLeft size={14} className="mr-1" /> Back to Employees
            </Button>
          }
        />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="mx-auto max-w-6xl space-y-4"
    >
      {/* Back */}
      <Button variant="outline" size="sm" onClick={() => navigateToEmployees()} aria-label="Back to employees list">
        <ArrowLeft size={15} /> Employees
      </Button>

      {/* ============================ Profile header ============================ */}
      <section className="card-glow rounded-xl border bg-card p-5 md:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
            <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-brand/15 text-xl font-bold text-brand ring-1 ring-brand/20 md:size-24">
              {emp.photo ? (
                <img src={emp.photo} alt={`${emp.full_name}'s photo`} className="size-full object-cover" />
              ) : initials(emp.full_name)}
            </div>
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center justify-center gap-2 text-xl font-semibold tracking-tight sm:justify-start md:text-2xl">
                {emp.full_name}
                {emp.is_team_leader && (
                  <span
                    title="Team Leader"
                    className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                  >
                    <Crown size={11} className="fill-amber-400 text-amber-400" /> Team Leader
                  </span>
                )}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <span className="font-mono text-xs text-muted-foreground">{emp.employee_code}</span>
                <EmployeeStatusBadge status={emp.status} />
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {[emp.position ?? 'Team Member', emp.company_name, emp.nationality].filter(Boolean).join(' · ')}
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <SiteBadge name={emp.site_name} />
                {emp.camp_name ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    <Tent size={11} className="inline" aria-hidden="true" /> {emp.camp_name}
                    {emp.camp_block && <> · Block {emp.camp_block}</>}
                    {emp.camp_room && <> · Room {emp.camp_room}</>}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    <Tent size={11} className="inline" aria-hidden="true" /> No camp
                  </span>
                )}
              </div>
              <div className="mt-2 flex justify-center sm:justify-start">
                <RatingStars rating={emp.rating} size={15} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigateToEmployeeForm('edit', emp.id, 'employee_details')}
              aria-label={`Edit ${emp.full_name}`}
            >
              <Pencil size={14} /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { downloadEmployeeCv(emp); toast.success('CV PDF downloaded'); }}
              aria-label={`Download ${emp.full_name}'s CV`}
            >
              <FileDown size={14} /> Download CV
            </Button>
            <Button
              size="sm"
              className="brand-gradient font-semibold text-white"
              onClick={() => { setSharePreviewActive(false); setShareOpen(true); }}
              aria-label={`Share ${emp.full_name}'s details via WhatsApp`}
            >
              <MessageCircle size={14} /> Share via WhatsApp
            </Button>
          </div>
        </div>
      </section>

      {/* ============================ Detail sections ============================ */}
      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard index={0} icon={<UserRound size={16} />} title="Personal Information" sub="Contact & background">
          <InfoRow label="Nationality" value={emp.nationality ?? '—'} />
          <InfoRow label="Date of Birth" value={fmtDate(emp.date_of_birth)} />
          <InfoRow label="Phone" value={emp.phone ?? '—'} />
          <InfoRow label="Email" value={emp.email ?? '—'} />
          <InfoRow label="Emergency Contact" value={emp.emergency_contact ?? '—'} />
          <div className="sm:col-span-2">
            <InfoRow label="Home Country Address" value={emp.address ?? '—'} />
          </div>
        </InfoCard>

        <InfoCard index={1} icon={<Briefcase size={16} />} title="Professional Information" sub="Employment & assignment">
          <InfoRow label="Position" value={emp.position ?? '—'} />
          <InfoRow label="Join Date" value={fmtDate(emp.join_date)} />
          <InfoRow label="Company" value={emp.company_name ?? '—'} />
          <InfoRow label="Site" value={<SiteBadge name={emp.site_name} />} />
          <InfoRow
            label="Accommodation"
            value={emp.camp_name
              ? (
                <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <Tent size={13} className="inline" aria-hidden="true" />
                  {emp.camp_name} — Block {emp.camp_block ?? '—'}, Room {emp.camp_room ?? '—'}
                </span>
              )
              : 'No camp assigned'}
          />
          <InfoRow
            label="Team Leader"
            value={emp.is_team_leader
              ? (
                <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <Crown size={13} className="inline fill-amber-400 text-amber-400" aria-hidden="true" />
                  Yes — of {emp.leader_site_name ?? 'a site'}
                </span>
                )
              : 'No'}
          />
        </InfoCard>

        <InfoCard index={2} icon={<FileText size={16} />} title="Document Details" sub="Passport & ID">
          <InfoRow label="Passport Number" value={emp.passport_number ?? '—'} mono />
          <InfoRow label="Passport Status" value={<DocStatusPill status={emp.passport_status} />} />
          <InfoRow label="ID Number" value={emp.id_number ?? '—'} mono />
          <InfoRow label="ID Status" value={<DocStatusPill status={emp.id_status} />} />
        </InfoCard>

        <InfoCard index={3} icon={<Clock3 size={16} />} title="Record Information" sub="Audit metadata">
          <InfoRow label="Employee Code" value={emp.employee_code} mono />
          <InfoRow label="Performance Rating" value={<RatingStars rating={emp.rating} size={13} />} />
          <InfoRow label="Created" value={fmtDateTime(emp.created_at)} />
          <InfoRow label="Last Updated" value={fmtDateTime(emp.updated_at)} />
        </InfoCard>
      </div>

      {/* ============================ Track record ============================ */}
      <section className="card-glow rounded-xl border bg-card p-5 md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SectionTitle
            icon={<CalendarCheck size={16} />}
            title="Track Record"
            sub="Monthly timesheet — hours worked per day"
          />
          <div className="flex items-center gap-2">
            {trLoading && <Loader2 size={14} className="animate-spin text-brand" aria-label="Loading attendance" />}
            <Select
              value={MONTH_NAMES[trMonth - 1]}
              onValueChange={(m) => { setTrLoading(true); setTrMonth(MONTH_NAMES.indexOf(m) + 1); }}
            >
              <SelectTrigger className="h-9 w-32 bg-card" aria-label="Track record month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(trYear)}
              onValueChange={(y) => { setTrLoading(true); setTrYear(Number(y)); }}
            >
              <SelectTrigger className="h-9 w-20 bg-card" aria-label="Track record year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectableYears().map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4">
          {trLoading ? (
            <div className="grid grid-cols-7 gap-1.5" aria-label="Loading timesheet">
              {Array.from({ length: 35 }).map((_, i) => (
                <Skeleton key={i} className="min-h-16 rounded-lg" />
              ))}
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={trMonthKey}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: EASE }}
              >
                <MonthGrid year={trYear} month={trMonth} records={trRecords ?? []} />
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-1.5 text-sm font-semibold text-emerald-500">
                    Total Hours: <AnimatedCounter value={trTotals.hours} decimals={Number.isInteger(trTotals.hours) ? 0 : 1} />
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm font-semibold',
                      trTotals.absents > 0
                        ? 'border-rose-500/25 bg-rose-500/10 text-rose-500'
                        : 'border-border bg-muted text-muted-foreground',
                    )}
                  >
                    Total Absent: <AnimatedCounter value={trTotals.absents} />
                  </span>
                  <span className="ml-auto hidden text-[11px] text-muted-foreground sm:block">
                    A = Absent · — = Not marked
                  </span>
                </div>
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </section>

      {/* ============================ Share dialog ============================ */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className={cn('sm:max-w-lg', sharePreviewActive && 'sm:max-w-3xl')}>
          <ShareDialogContent emp={emp} onPreviewChange={setSharePreviewActive} />
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
