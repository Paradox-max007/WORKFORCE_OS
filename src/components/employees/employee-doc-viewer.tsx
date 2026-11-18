'use client';

// ============================================================================
// PULSE Workforce OS — Employee document viewer (preview + print + download)
// ----------------------------------------------------------------------------
// Full-screen portal that shows one DECRYPTED employee document:
//   • PDFs  → the shared PdfZoomViewer (zoom, fit, page nav, print, download)
//   • images → lightbox with zoom in/out and a print window
// The parent supplies a browser-usable object URL of the decrypted bytes and
// revokes it when this viewer closes.
// ============================================================================

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Minus, Plus, Printer, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PdfZoomViewer } from '@/components/sites/pdf-zoom-viewer';
import { cn } from '@/lib/utils';

function downloadUrl(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function EmployeeDocViewer({
  name,
  ext,
  url,
  onClose,
}: {
  /** display name, e.g. "Passport (PDF)" */
  name: string;
  /** original extension (pdf / jpg / png / webp) */
  ext: string;
  /** object URL of the DECRYPTED document bytes */
  url: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const isPdf = ext.toLowerCase() === 'pdf';

  const printImage = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) {
      toast.error('The print window was blocked — allow popups for this site to print.');
      return;
    }
    const safe = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    w.document.write(
      `<!doctype html><html><head><title>${safe}</title>` +
      '<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}' +
      'img{max-width:100%;max-height:100vh;object-fit:contain}</style></head>' +
      `<body><img src="${url}" alt="${safe}" onload="setTimeout(function(){window.focus();window.print();},200)"></body></html>`,
    );
    w.document.close();
  };

  if (isPdf) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex flex-col bg-background"
        role="dialog"
        aria-label={`${name} preview`}
      >
        <PdfZoomViewer
          url={url}
          fileName={name}
          onDownload={() => downloadUrl(url, `${name}.pdf`)}
          onClose={onClose}
        />
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-label={`${name} preview`}
    >
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/70 px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</p>
        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-background/60 px-1 py-0.5">
          <Button
            variant="ghost" size="icon" className="size-7"
            onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}
            aria-label="Zoom out" title="Zoom out"
          >
            <Minus size={13} />
          </Button>
          <span className="w-10 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost" size="icon" className="size-7"
            onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
            aria-label="Zoom in" title="Zoom in"
          >
            <Plus size={13} />
          </Button>
        </div>
        <Button
          variant="outline" size="sm" className="gap-1.5"
          onClick={() => downloadUrl(url, `${name}.${ext}`)}
        >
          <Download size={14} /> Download
        </Button>
        <Button
          variant="outline" size="sm" className="gap-1.5 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
          onClick={printImage}
        >
          <Printer size={14} /> Print
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Close preview">
          <X size={16} />
        </Button>
      </div>

      {/* image canvas */}
      <div className="flex-1 overflow-auto p-4">
        <div className="flex min-h-full items-center justify-center">
          <img
            src={url}
            alt={name}
            style={{ transform: `scale(${zoom})` }}
            className={cn(
              'max-h-[calc(100dvh-6rem)] max-w-full origin-center rounded-lg border border-border/60 shadow-lg',
              'transition-transform duration-150',
            )}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
