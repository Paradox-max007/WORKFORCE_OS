'use client';

// ============================================================================
// PULSE Workforce OS — Time Card dialog (per-site approved timesheet hours)
// ----------------------------------------------------------------------------
// Opened from every SITE SECTION header of the Salary Sheet (the button sits
// next to the section title, so it is always visible WHICH sites already have
// time card hours). Saving stores the approved time card hours of that site's
// employees (payroll_time_card / demo mirror) and the backend then:
//   • adds a POSITIVE difference ((time card − attendance hours) × rate) to
//     the employee's net payable in the Payroll (shown as "base + extra"),
//   • carries a NEGATIVE difference to the NEXT month's salary by adding the
//     amount to that employee's advance, with a note carrying the time card
//     and attendance hours details.
// The dialog is shared as-is; `defaultSiteId` preselects the site whose
// button was clicked (the dropdown still allows switching between the sites
// the viewer is allowed to manage).
// ============================================================================

import { ClipboardCheck, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { dataApi } from '@/lib/data';
import type { SalarySheetSiteGroup, SiteTimeCardEntry } from '@/lib/types';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmtHrs = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function TimeCardDialog({ open, onOpenChange, periodId, siteGroups, defaultSiteId, year, month, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  periodId: string | null;
  /** non-idle site groups of this period, ALREADY permission-scoped by the page */
  siteGroups: SalarySheetSiteGroup[];
  /** site whose header button opened the dialog (preselected) */
  defaultSiteId?: string | null;
  year: number;
  month: number;
  onSaved: () => void;
}) {
  const [siteId, setSiteId] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const group = useMemo(
    () => siteGroups.find((g) => g.site_id === siteId) ?? null,
    [siteGroups, siteId],
  );
  const rows = useMemo(() => group?.rows ?? [], [group]);

  // (re)select the site when the dialog opens — the caller's site first
  useEffect(() => {
    if (!open) return;
    setSiteId((prev) => {
      if (siteGroups.some((g) => g.site_id === prev)) return prev;
      if (defaultSiteId && siteGroups.some((g) => g.site_id === defaultSiteId)) {
        return defaultSiteId;
      }
      return siteGroups[0]?.site_id ?? '';
    });
  }, [open, siteGroups, defaultSiteId]);

  // prefill from the stored time card hours whenever the picked site changes
  useEffect(() => {
    const next: Record<string, string> = {};
    rows.forEach((r) => {
      next[r.employee_id] = r.time_card_hours != null ? String(r.time_card_hours) : '';
    });
    setValues(next);
  }, [siteId, rows]);

  const filledCount = rows.filter((r) => (values[r.employee_id] ?? '').trim() !== '').length;

  const save = async (): Promise<void> => {
    if (!periodId || !siteId || saving) return;
    const entries: SiteTimeCardEntry[] = [];
    for (const r of rows) {
      const raw = (values[r.employee_id] ?? '').trim();
      if (raw === '') {
        entries.push({ employee_id: r.employee_id, hours: null });
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        toast.error(`Time card hours of ${r.full_name} must be 0 or more`);
        return;
      }
      entries.push({ employee_id: r.employee_id, hours: round2(n) });
    }
    setSaving(true);
    try {
      await dataApi.saveSiteTimeCardHours(periodId, siteId, entries);
      toast.success('Time card hours saved', {
        description: `${group?.site_name ?? 'Site'} — ${filledCount} employee${filledCount === 1 ? '' : 's'} with hours. Differences now flow into the Payroll net payable.`,
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the time card hours');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck size={16} className="text-brand" />
            Time card hours — {MONTH_NAMES[month - 1]} {year}
          </DialogTitle>
          <DialogDescription>
            Enter the approved timesheet (time card) hours of a site&apos;s employees. A
            positive difference (time card &gt; attendance) is added to the net payable in
            Payroll; a negative difference is recovered from the next month&apos;s salary
            (added to the advance, with a note).
          </DialogDescription>
        </DialogHeader>

        {siteGroups.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            No sites with employees this month in your scope.
          </p>
        ) : (
          <div className="space-y-3">
            <Select value={siteId} onValueChange={setSiteId} disabled={saving}>
              <SelectTrigger className="h-10 bg-card" aria-label="Site of the time card">
                <SelectValue placeholder="Select a site…" />
              </SelectTrigger>
              <SelectContent>
                {siteGroups.map((g) => (
                  <SelectItem key={g.site_id} value={g.site_id!}>
                    {g.site_name} ({g.employees} employee{g.employees === 1 ? '' : 's'})
                    {(g.time_card_total ?? 0) > 0 ? ' · time card ✓' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {rows.length > 0 && (
              <div className="max-h-[46vh] overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Site Hours</TableHead>
                      <TableHead className="w-36 text-right">Time Card Hours</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.employee_id}>
                        <TableCell className="py-2">
                          <p className="truncate text-sm font-medium">{r.full_name}</p>
                          <p className="font-mono text-[10px] text-muted-foreground">{r.employee_code}</p>
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs">
                          {fmtHrs(r.total_hours)} h
                        </TableCell>
                        <TableCell className="py-2">
                          <Input
                            type="number" min={0} step="0.5" inputMode="decimal" disabled={saving}
                            placeholder="—"
                            className="h-8 border-border/70 bg-card text-right font-mono text-xs"
                            value={values[r.employee_id] ?? ''}
                            onChange={(ev) => setValues((prev) => ({
                              ...prev, [r.employee_id]: ev.target.value,
                            }))}
                            aria-label={`Time card hours of ${r.full_name}`}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Empty field = no entry for that employee (an existing one is removed).
              {filledCount > 0 && ` ${filledCount} of ${rows.length} employees filled.`}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => { void save(); }}
            disabled={saving || siteGroups.length === 0 || !siteId || rows.length === 0}
            className="brand-gradient font-semibold text-white"
          >
            {saving ? <Loader2 size={15} className="mr-1 animate-spin" /> : <ClipboardCheck size={15} className="mr-1" />}
            Save time card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
