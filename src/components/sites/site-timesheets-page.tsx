'use client';

// ============================================================================
// PULSE Workforce OS — Site Timesheets / Time Cards page
// ----------------------------------------------------------------------------
// Opened from the "Timesheet / Time Cards" button on each site card of the
// Sites page. Layout (as requested):
//
//   Row 1 — site identity: Site Name · Client · Project · No. of Employees
//   Row 2 — every month from the START of the site (newest first) as chips;
//           a dot shows which months already have documents
//   Below  — the selected month's two OPTIONAL document slots:
//             • Time Card   (PDF)          — preview / download / replace / remove
//             • Timesheet   (XLSX / PDF)   — Excel files open in the in-app
//                                            editor (formulas supported);
//                                            PDFs preview in the app
//
// Storage: Supabase Storage bucket 'site-timesheets' in production (run
// supabase/migrations/20261116_site_timesheets_bucket.sql once), a local
// IndexedDB mini-bucket in demo mode — see src/lib/files/site-docs.ts.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Briefcase, Building2, CalendarDays, Download, Eye, FileClock,
  FileSpreadsheet, Loader2, Pencil, Trash2, TriangleAlert, Upload, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState, PageHeader } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import {
  deleteSiteDoc, downloadSiteDoc, isEditableTimesheet, listSiteDocs, monthLabel,
  monthsSince, siteDocUrl, TIME_CARD_ACCEPT, TIMESHEET_ACCEPT,
  uploadSiteDoc, type SiteDoc, type SiteDocKind,
} from '@/lib/files/site-docs';
import type { SiteWithCount } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';

/** the full spreadsheet stack (jspreadsheet + SheetJS + ExcelJS) is a big
 *  chunk — load it only when an Excel file is actually opened for editing. */
const TimesheetEditorDialog = dynamic(
  () => import('@/components/sites/timesheet-editor').then((m) => m.TimesheetEditorDialog),
  { ssr: false, loading: () => null },
);

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function fmtWhen(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** one of the two document slots of a month */
function DocSlot({
  kind, doc, busy, onUpload, onPreview, onEdit, onDownload, onRemove,
}: {
  kind: SiteDocKind;
  doc: SiteDoc | null;
  busy: boolean;
  onUpload: (file: File) => void;
  onPreview: () => void;
  onEdit: () => void;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const isTimeCard = kind === 'time-card';
  const Icon = isTimeCard ? FileClock : FileSpreadsheet;
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4',
        doc ? 'border-border bg-card' : 'border-dashed border-border/80 bg-card/50',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={isTimeCard ? TIME_CARD_ACCEPT : TIMESHEET_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ''; // allow re-picking the same file
          if (f) onUpload(f);
        }}
      />

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            isTimeCard ? 'bg-amber-500/10 text-amber-500' : 'bg-emerald-500/10 text-emerald-500',
          )}>
            <Icon size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{isTimeCard ? 'Time Card' : 'Timesheet'}</p>
            <p className="text-[11px] text-muted-foreground">
              {isTimeCard ? 'PDF document — optional' : 'Excel (editable in-app) or PDF — optional'}
            </p>
          </div>
        </div>
        {busy && <Loader2 size={16} className="mt-1 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {doc ? (
        <>
          <div className="min-w-0 rounded-lg border border-border/70 bg-background/60 px-3 py-2">
            <p className="truncate text-xs font-medium" title={doc.name}>{doc.name}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {fmtSize(doc.size)}{doc.updatedAt ? ` · ${fmtWhen(doc.updatedAt)}` : ''}
            </p>
          </div>
          <div className="mt-auto flex flex-wrap gap-2">
            {isEditableTimesheet(doc) ? (
              <Button size="sm" className="h-8 gap-1.5" onClick={onEdit} disabled={busy}>
                <Pencil size={14} /> Open &amp; Edit
              </Button>
            ) : (
              <Button size="sm" className="h-8 gap-1.5" onClick={onPreview} disabled={busy}>
                <Eye size={14} /> Preview
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onDownload} disabled={busy}>
              <Download size={14} /> Download
            </Button>
            <Button
              size="sm" variant="outline" className="h-8 gap-1.5 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
              onClick={() => inputRef.current?.click()} disabled={busy}
            >
              <Upload size={14} /> Replace
            </Button>
            <Button
              size="sm" variant="outline"
              className="h-8 gap-1.5 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-500"
              onClick={onRemove} disabled={busy}
            >
              <Trash2 size={14} /> Remove
            </Button>
          </div>
        </>
      ) : (
        <Button
          variant="outline" className="mt-auto w-full gap-2 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
          onClick={() => inputRef.current?.click()} disabled={busy}
        >
          <Upload size={15} /> Upload {isTimeCard ? 'PDF' : 'Excel / PDF'}
        </Button>
      )}
    </div>
  );
}

export function SiteTimesheetsPage() {
  const siteId = useAppStore((s) => s.selectedSiteId);
  const navigateTo = useAppStore((s) => s.navigateTo);

  const [site, setSite] = useState<SiteWithCount | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [docs, setDocs] = useState<SiteDoc[] | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  const [busySlot, setBusySlot] = useState<SiteDocKind | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<SiteDoc | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SiteDoc | null>(null);
  const [editor, setEditor] = useState<{ doc: SiteDoc; bytes: ArrayBuffer } | null>(null);

  const months = useMemo(() => (site ? monthsSince(site.created_at) : []), [site]);
  const docsVersion = useRef(0);

  const refreshDocs = useCallback(async (id: string, monthList: string[]) => {
    const version = ++docsVersion.current;
    const fresh = await listSiteDocs(id, monthList).catch(() => [] as SiteDoc[]);
    if (version === docsVersion.current) setDocs(fresh);
  }, []);

  // load the site + its documents
  useEffect(() => {
    if (!siteId) { setNotFound(true); return; }
    let alive = true;
    (async () => {
      try {
        const all = await dataApi.listSites();
        if (!alive) return;
        const found = all.find((s) => s.id === siteId) ?? null;
        if (!found) { setNotFound(true); return; }
        setSite(found);
        const monthList = monthsSince(found.created_at);
        setSelectedMonth((prev) => (prev && monthList.includes(prev) ? prev : (monthList[0] ?? '')));
        await refreshDocs(found.id, monthList);
      } catch {
        if (alive) setNotFound(true);
      }
    })();
    return () => { alive = false; };
  }, [siteId, refreshDocs]);

  const docFor = (month: string, kind: SiteDocKind): SiteDoc | null =>
    docs?.find((d) => d.month === month && d.kind === kind) ?? null;

  const upload = async (month: string, kind: SiteDocKind, file: File) => {
    if (!siteId) return;
    setBusySlot(kind);
    setSlotError(null);
    try {
      await uploadSiteDoc(siteId, month, kind, file);
      await refreshDocs(siteId, months);
      toast.success(`${kind === 'time-card' ? 'Time card' : 'Timesheet'} uploaded for ${monthLabel(month)}`);
    } catch (e) {
      setSlotError(e instanceof Error ? e.message : 'The upload failed.');
    } finally {
      setBusySlot(null);
    }
  };

  const openPreview = async (doc: SiteDoc) => {
    try {
      const url = await siteDocUrl(doc);
      setPreviewDoc(doc);
      setPreviewUrl(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the preview.');
    }
  };

  const openEditor = async (doc: SiteDoc) => {
    try {
      const blob = await downloadSiteDoc(doc);
      const buffer = await blob.arrayBuffer();
      setEditor({ doc, bytes: buffer });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the timesheet.');
    }
  };

  const download = async (doc: SiteDoc) => {
    try {
      const ext = doc.ext;
      const label = doc.kind === 'time-card' ? 'TimeCard' : 'Timesheet';
      const siteSlug = (site?.name ?? 'site').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
      const url = await siteDocUrl(doc, `${siteSlug}_${label}_${doc.month}.${ext}`);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${siteSlug}_${label}_${doc.month}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The download failed.');
    }
  };

  const remove = async () => {
    if (!removeTarget || !siteId) return;
    const doc = removeTarget;
    setRemoveTarget(null);
    setBusySlot(doc.kind);
    setSlotError(null);
    try {
      await deleteSiteDoc(doc);
      await refreshDocs(siteId, months);
      toast.success('Document removed.');
    } catch (e) {
      setSlotError(e instanceof Error ? e.message : 'Could not remove the document.');
    } finally {
      setBusySlot(null);
    }
  };

  if (notFound) {
    return (
      <EmptyState
        icon={<Building2 className="size-10 text-muted-foreground" />}
        title="Site not found"
        description="This site no longer exists — go back to the Sites page and pick another one."
        action={<Button variant="outline" className="gap-2" onClick={() => navigateTo('sites')}><ArrowLeft className="size-4" /> Back to Sites</Button>}
      />
    );
  }

  if (!site || !docs) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const monthDocs = selectedMonth
    ? (docFor(selectedMonth, 'time-card') ? 1 : 0) + (docFor(selectedMonth, 'timesheet') ? 1 : 0)
    : 0;

  return (
    <>
      <PageHeader
        title="Timesheets / Time Cards"
        description={`Monthly document archive of ${site.name}`}
        actions={
          <Button variant="outline" className="gap-2" onClick={() => navigateTo('sites')}>
            <ArrowLeft className="size-4" /> Back to Sites
          </Button>
        }
      />

      {/* ---- Row 1: site identity ---- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: <Building2 className="size-5" />, label: 'Site Name', value: site.name, tone: 'bg-brand/10 text-brand' },
          { icon: <Briefcase className="size-5" />, label: 'Client', value: site.client_name, tone: 'bg-emerald-500/10 text-emerald-500' },
          { icon: <FileSpreadsheet className="size-5" />, label: 'Project', value: site.project_name, tone: 'bg-amber-500/10 text-amber-500' },
          { icon: <Users className="size-5" />, label: 'No. of Employees', value: String(site.employee_count), tone: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400' },
        ].map((c, i) => (
          <motion.div
            key={c.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-3 rounded-xl border bg-card p-4"
          >
            <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg', c.tone)}>{c.icon}</div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</p>
              <p className="truncate text-sm font-semibold" title={c.value ?? undefined}>{c.value || '—'}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* ---- Row 2: every month since the site started ---- */}
      <div className="mt-5 rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 px-1">
          <CalendarDays className="size-4 text-muted-foreground" />
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Months since the site started ({months.length})
          </p>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {months.map((m) => {
            const count = (docFor(m, 'time-card') ? 1 : 0) + (docFor(m, 'timesheet') ? 1 : 0);
            return (
              <button
                key={m}
                type="button"
                onClick={() => { setSelectedMonth(m); setSlotError(null); }}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  m === selectedMonth
                    ? 'border-transparent brand-gradient text-brand-foreground shadow-sm'
                    : 'border-border bg-background/60 text-muted-foreground hover:border-brand/40 hover:text-foreground',
                )}
                aria-pressed={m === selectedMonth}
              >
                {monthLabel(m)}
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    count === 2 ? 'bg-emerald-500' : count === 1 ? 'bg-amber-500' : m === selectedMonth ? 'bg-brand-foreground/40' : 'bg-border',
                  )}
                  title={count === 0 ? 'No documents yet' : `${count} of 2 documents uploaded`}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- the selected month's two optional slots ---- */}
      {selectedMonth && (
        <div className="mt-4">
          <p className="mb-3 px-1 text-sm font-semibold">
            {monthLabel(selectedMonth)}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {monthDocs === 0 ? 'no documents yet — both are optional' : `${monthDocs} of 2 documents uploaded`}
            </span>
          </p>
          {slotError && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <p className="break-words">{slotError}</p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <DocSlot
              kind="time-card"
              doc={docFor(selectedMonth, 'time-card')}
              busy={busySlot === 'time-card'}
              onUpload={(f) => void upload(selectedMonth, 'time-card', f)}
              onPreview={() => { const d = docFor(selectedMonth, 'time-card'); if (d) void openPreview(d); }}
              onEdit={() => {}}
              onDownload={() => { const d = docFor(selectedMonth, 'time-card'); if (d) void download(d); }}
              onRemove={() => setRemoveTarget(docFor(selectedMonth, 'time-card'))}
            />
            <DocSlot
              kind="timesheet"
              doc={docFor(selectedMonth, 'timesheet')}
              busy={busySlot === 'timesheet'}
              onUpload={(f) => void upload(selectedMonth, 'timesheet', f)}
              onPreview={() => { const d = docFor(selectedMonth, 'timesheet'); if (d) void openPreview(d); }}
              onEdit={() => { const d = docFor(selectedMonth, 'timesheet'); if (d) void openEditor(d); }}
              onDownload={() => { const d = docFor(selectedMonth, 'timesheet'); if (d) void download(d); }}
              onRemove={() => setRemoveTarget(docFor(selectedMonth, 'timesheet'))}
            />
          </div>
        </div>
      )}

      {/* ---- PDF preview ---- */}
      {previewDoc && previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-label="Document preview">
          <div className="flex h-full max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <FileClock className="size-5 shrink-0 text-brand" />
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">{previewDoc.name}</p>
              <Button size="sm" className="h-8 gap-1.5" onClick={() => void download(previewDoc)}>
                <Download className="size-4" /> Download
              </Button>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Close preview" onClick={() => { setPreviewDoc(null); setPreviewUrl(null); }}>
                <ArrowLeft className="size-4 rotate-180" />
              </Button>
            </div>
            <iframe src={previewUrl} title={previewDoc.name} className="min-h-0 flex-1 bg-white" />
          </div>
        </div>
      )}

      {/* ---- Excel editor ---- */}
      {editor && (
        <TimesheetEditorDialog
          doc={editor.doc}
          bytes={editor.bytes}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            if (siteId) await refreshDocs(siteId, months);
            toast.success('Timesheet saved back to the document store.');
          }}
        />
      )}

      {/* ---- remove confirmation ---- */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.name} of {removeTarget ? monthLabel(removeTarget.month) : ''} will be permanently deleted from the document store. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button variant="destructive" className="gap-2" onClick={() => void remove()}>
              <Trash2 className="size-4" /> Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
