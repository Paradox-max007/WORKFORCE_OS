'use client';

// ============================================================================
// PULSE Workforce OS — Monthly site breakdown (Working Hours module)
// ----------------------------------------------------------------------------
// The expandable part of one month card: one row per site the employee worked
// at that month, with the site's hours and its share of the month as a bar.
// The site of EVERY day is resolved date-effectively (mid-month transfers
// split the month), so these rows always sum back to the month total.
// ============================================================================

import { Building2, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkingHoursSiteTotal } from '@/lib/types';

// deterministic palette per row index (no chart library needed for one bar)
const SITE_BAR_COLORS = [
  'bg-brand', 'bg-emerald-500', 'bg-cyan-500', 'bg-amber-500',
  'bg-rose-500', 'bg-purple-500', 'bg-sky-500', 'bg-lime-500',
];

export function MonthlySiteBreakdown({
  sites,
  monthTotal,
}: {
  sites: WorkingHoursSiteTotal[];
  monthTotal: number;
}) {
  return (
    <div className="space-y-2">
      {sites.map((s, i) => {
        const share = monthTotal > 0 ? Math.round((s.totalHours / monthTotal) * 100) : 0;
        return (
          <div key={`${s.siteId ?? 'none'}`} className="rounded-lg border bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={cn('size-2.5 shrink-0 rounded-full', SITE_BAR_COLORS[i % SITE_BAR_COLORS.length])} />
              <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[13px] font-medium">
                {s.siteId ? <Building2 size={12} className="shrink-0 text-muted-foreground" /> : <MapPin size={12} className="shrink-0 text-muted-foreground" />}
                <span className="truncate">{s.siteName}</span>
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums">
                {s.totalHours.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} hrs
              </span>
              <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{share}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-all duration-500', SITE_BAR_COLORS[i % SITE_BAR_COLORS.length])}
                style={{ width: `${share}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
