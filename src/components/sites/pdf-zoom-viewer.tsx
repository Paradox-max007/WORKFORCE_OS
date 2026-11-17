'use client';

// ============================================================================
// PULSE Workforce OS — zoomable PDF viewer (PDF.js, Apache-2.0)
// ----------------------------------------------------------------------------
// Renders site documents (time cards / PDF timesheets) with real zoom:
//   • zoom in / out (25%–400%) with live percentage
//   • fit width · fit page · actual size (100%)
//   • full-screen view
//   • page navigation (prev / next / jump, "page X of Y")
//   • print & download
// The zoom level is fully independent from the Excel editor zoom (PRD §6).
// The worker is served from /public (pdf.worker.min.mjs) so Turbopack never
// has to bundle it.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Download, FileClock, Loader2, Maximize2,
  Minus, Plus, Printer, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

type FitMode = 'none' | 'width' | 'page';

export function PdfZoomViewer({
  url,
  fileName,
  onDownload,
  onClose,
}: {
  url: string;
  fileName: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesHostRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const docRef = useRef<unknown>(null);
  const taskRef = useRef<{ destroy?: () => Promise<void> } | null>(null);
  const renderingRef = useRef(false);
  const pendingRenderRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const fitRef = useRef<FitMode>('width');

  // ---- load the document ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    setPage(1);
    docRef.current = null;

    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const task = pdfjs.getDocument({ url });
        taskRef.current = task as unknown as { destroy?: () => Promise<void> };
        const pdf = await task.promise;
        if (cancelled) { void task.destroy(); return; }
        docRef.current = pdf;
        setNumPages(pdf.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'The PDF could not be opened.');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      docRef.current = null;
      const task = taskRef.current;
      taskRef.current = null;
      if (task?.destroy) void task.destroy();
    };
  }, [url]);

  // ---- (re)render every page at the current zoom ----
  const renderPages = useCallback(async () => {
    const pdf = docRef.current as {
      numPages: number;
      getPage: (n: number) => Promise<{
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: { canvas: HTMLCanvasElement; viewport: unknown }) => { promise: Promise<void>; cancel?: () => void };
      }>;
    } | null;
    if (!pdf || renderingRef.current) {
      pendingRenderRef.current = true;
      return;
    }
    renderingRef.current = true;
    try {
      // canvas output is rendered at 2x for crisp text, displayed at zoom size
      const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1)) * (zoom > 1.5 ? 1 : 1.5);
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = canvasRefs.current[i - 1];
        if (!canvas) continue;
        const p = await pdf.getPage(i);
        const viewport = p.getViewport({ scale: zoom });
        const w = Math.floor(viewport.width);
        const h = Math.floor(viewport.height);
        canvas.width = Math.floor(w * outputScale);
        canvas.height = Math.floor(h * outputScale);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        await p.render({ canvas, viewport }).promise;
      }
    } catch { /* a cancelled render (zoom changed) is not an error */ }
    renderingRef.current = false;
    if (pendingRenderRef.current) {
      pendingRenderRef.current = false;
      void renderPages();
    }
  }, [zoom]);

  useEffect(() => {
    if (!loading && numPages > 0) void renderPages();
  }, [loading, numPages, renderPages]);

  // ---- fit modes need the container width ----
  const applyFit = useCallback((mode: FitMode) => {
    fitRef.current = mode;
    const pdf = docRef.current as { getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number } }> } | null;
    const scroll = scrollRef.current;
    if (!pdf || !scroll) return;
    void (async () => {
      try {
        const p1 = await pdf.getPage(1);
        const base = p1.getViewport({ scale: 1 });
        if (mode === 'width') {
          const avail = scroll.clientWidth - 32;
          if (avail > 0 && base.width > 0) setZoom(clampZoom(avail / base.width));
        } else if (mode === 'page') {
          const availW = scroll.clientWidth - 32;
          const availH = scroll.clientHeight - 32;
          if (availW > 0 && availH > 0) {
            setZoom(clampZoom(Math.min(availW / base.width, availH / base.height)));
          }
        } else {
          setZoom(1);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // initial fit-to-width once loaded
  useEffect(() => {
    if (!loading && numPages > 0) applyFit('width');
  }, [loading, numPages, applyFit]);

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10) / 10));

  const zoomBy = (delta: number) => {
    fitRef.current = 'none';
    setZoom((z) => clampZoom(z + delta));
  };

  const goPage = (n: number) => {
    const target = Math.min(Math.max(1, n), Math.max(1, numPages));
    setPage(target);
    const canvas = canvasRefs.current[target - 1];
    canvas?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const fullscreen = () => {
    const el = scrollRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  const print = () => {
    const images = canvasRefs.current
      .slice(0, numPages)
      .map((c) => (c ? `<img src="${c.toDataURL('image/jpeg', 0.92)}" />` : ''))
      .join('');
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    w.document.write(
      `<html><head><title>${fileName}</title><style>
        @page { margin: 8mm; } body { margin: 0; } img { width: 100%; page-break-after: always; }
        img:last-child { page-break-after: auto; }
      </style></head><body>${images}</body></html>`,
    );
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 350);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-card">
      {/* ---- header ---- */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <FileClock className="size-5 shrink-0 text-brand" />
        <p className="min-w-0 max-w-[38%] flex-1 truncate text-sm font-semibold" title={fileName}>{fileName}</p>
        <Button size="sm" className="h-8 gap-1.5" onClick={onDownload}>
          <Download className="size-4" /> Download
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={print}>
          <Printer className="size-4" /> Print
        </Button>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Close preview" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      {/* ---- zoom toolbar ---- */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5">
        <Button variant="ghost" size="icon" className="size-7" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM + 0.001}>
          <Minus className="size-3.5" />
        </Button>
        <span className="w-12 text-center text-xs font-semibold tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon" className="size-7" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM - 0.001}>
          <Plus className="size-3.5" />
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" className={cn('h-7 px-2 text-[11px]', fitRef.current === 'width' && 'bg-brand/10 text-brand')} onClick={() => applyFit('width')}>Fit width</Button>
        <Button variant="ghost" size="sm" className={cn('h-7 px-2 text-[11px]', fitRef.current === 'page' && 'bg-brand/10 text-brand')} onClick={() => applyFit('page')}>Fit page</Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => { fitRef.current = 'none'; setZoom(1); }}>100%</Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon" className="size-7" title="Full screen" aria-label="Full screen" onClick={fullscreen}>
          <Maximize2 className="size-3.5" />
        </Button>

        {/* page navigation */}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" title="Previous page" aria-label="Previous page" onClick={() => goPage(page - 1)} disabled={page <= 1}>
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            page <span className="font-semibold text-foreground">{page}</span> of {numPages || '…'}
          </span>
          <Button variant="ghost" size="icon" className="size-7" title="Next page" aria-label="Next page" onClick={() => goPage(page + 1)} disabled={page >= numPages}>
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* ---- pages ---- */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-neutral-100 p-4 dark:bg-neutral-900">
        {loading && (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-3">
              <Loader2 className="size-4 animate-spin text-brand" />
              <p className="text-sm">Opening the document…</p>
            </div>
          </div>
        )}
        {error && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-sm rounded-xl border border-destructive/30 bg-card px-5 py-4 text-center">
              <p className="text-sm font-semibold">The PDF could not be opened</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
            </div>
          </div>
        )}
        <div ref={pagesHostRef} className="mx-auto flex w-fit flex-col items-center gap-4">
          {!loading && !error && Array.from({ length: numPages }, (_, i) => (
            <canvas
              key={i}
              ref={(el) => { canvasRefs.current[i] = el; }}
              className="max-w-full rounded-md bg-white shadow-md"
              aria-label={`Page ${i + 1}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
