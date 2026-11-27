'use client';

// ============================================================================
// PULSE Workforce OS — Medicine record dialog (shared)
// ----------------------------------------------------------------------------
// The full "medicine bought record" for one employee: the DATE + TIME the
// medicines were taken, every item line (name, rate per tablet, quantity,
// amount), the total, and the payment status:
//   • Paid           — the employee paid at the counter (or later) → NO
//                      deduction ever happened
//   • Unpaid         — the amount deducts from the coming salary (the cut
//                      month's Deduction column — MED tag on the Payroll page)
//   • Recovered      — cleared: the cut month's salary was PAID with this
//                      record folded in
// Used by the Medicine Registry (with Mark Paid / Delete actions) AND the
// Payroll / Salary Sheet pages (the clickable MED tag — view only).

import {
  BadgeCheck, Banknote, CircleCheck, Clock, Loader2, MapPin, Pill, Trash2, User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';
import type { MedicineRecordVM } from '@/lib/types';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export const fmtMedMoney = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Items as one readable line: "Paracetamol 500mg ×10, ORS Sachet ×2" */
export const medicineItemsText = (items: MedicineRecordVM['items']): string =>
  items.map((i) => `${i.medicine_name} ×${i.quantity}`).join(', ');

/** One record's payment-status chip (shared by the registry list + dialog) */
export function MedicineStatusChip({ record }: { record: MedicineRecordVM }) {
  if (record.paid) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400"
        title={record.paid_at
          ? `Paid by the employee on ${fmtDateTime(record.paid_at)} — no salary deduction`
          : 'Paid by the employee — no salary deduction'}
      >
        <CircleCheck size={11} /> Paid
      </span>
    );
  }
  if (record.cleared) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand"
        title={`Recovered — the ${record.cut_month ? MONTH_NAMES[record.cut_month - 1] : ''} ${record.cut_year} salary was paid with this amount deducted`}
      >
        <BadgeCheck size={11} /> Recovered
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
      title={`Unpaid — ${fmtMedMoney(record.total_amount)} deducts from the ${record.cut_month ? MONTH_NAMES[record.cut_month - 1] : ''} ${record.cut_year} salary (MED tag on the Payroll page)`}
    >
      <Banknote size={11} /> Unpaid → {record.cut_month ? MONTH_NAMES[record.cut_month - 1] : ''} {record.cut_year} salary
    </span>
  );
}

export function MedicineRecordDialog({
  records,
  onClose,
  onMarkPaid,
  busyId,
  onDelete,
}: {
  /** the records to show (usually ONE — the Payroll MED tag may open several) */
  records: MedicineRecordVM[] | null;
  onClose: () => void;
  /** optional Mark-Paid action (Medicine Registry only) */
  onMarkPaid?: (id: string) => void;
  /** which record id is currently saving */
  busyId?: string | null;
  /** optional Delete action (Medicine Registry only) */
  onDelete?: (id: string) => void;
}) {
  const open = !!records && records.length > 0;
  const first = records?.[0] ?? null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
              <Pill size={16} />
            </span>
            Medicine Record
          </DialogTitle>
          <DialogDescription>
            {records && records.length > 1
              ? `${records.length} medicine records — every dispense of this employee for the selected salary month.`
              : 'What the employee took, when, and whether it was paid.'}
          </DialogDescription>
        </DialogHeader>

        {records?.map((r) => (
          <div key={r.id} className={cn('space-y-3 rounded-xl border bg-card p-4', records.length > 1 && 'mb-1')}>
            {/* employee + status */}
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xs font-bold text-brand">
                  {r.photo
                    ? <img src={r.photo} alt={r.employee_name} className="size-full object-cover" />
                    : r.employee_name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{r.employee_name}</p>
                  <p className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                    <span>{r.employee_code}</span>
                    {r.site_name && (
                      <span className="flex min-w-0 items-center gap-0.5 font-sans" title={`Employee's site — ${r.site_name}`}>
                        <MapPin size={10} className="shrink-0 text-brand" />
                        <span className="truncate font-medium text-foreground/80">{r.site_name}</span>
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <MedicineStatusChip record={r} />
            </div>

            {/* date + time taken */}
            <div className="flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] px-3 py-2 text-xs">
              <Clock size={13} className="shrink-0 text-sky-500" />
              <span className="font-medium">Taken on</span>
              <span className="tabular-nums text-foreground">{fmtDateTime(r.dispensed_at)}</span>
              {r.created_by_name && (
                <span className="ml-auto truncate text-muted-foreground">by {r.created_by_name}</span>
              )}
            </div>

            {/* item lines */}
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/60 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2.5 py-1.5 font-medium">Medicine</th>
                    <th className="px-1 py-1.5 text-right font-medium">Rate</th>
                    <th className="px-1 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-2.5 py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((it, idx) => (
                    <tr key={`${r.id}-${idx}`} className="border-b last:border-0">
                      <td className="px-2.5 py-1.5 font-medium">{it.medicine_name}</td>
                      <td className="px-1 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                        {fmtMedMoney(it.rate_per_tablet)}
                      </td>
                      <td className="px-1 py-1.5 text-right font-mono tabular-nums">{it.quantity}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums">
                        {fmtMedMoney(it.amount)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t bg-muted/40">
                    <td colSpan={3} className="px-2.5 py-1.5 text-right font-medium">Total</td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-sm font-bold tabular-nums text-foreground">
                      {fmtMedMoney(r.total_amount)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* payment note */}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {r.paid ? (
                <>Paid by the employee{r.paid_at ? ` on ${fmtDateTime(r.paid_at)}` : ''} — no deduction was made from any salary.</>
              ) : r.cleared ? (
                <>Recovered — this amount was deducted from the paid {r.cut_month ? MONTH_NAMES[r.cut_month - 1] : ''} {r.cut_year} salary{r.cleared_at ? ` (paid ${fmtDateTime(r.cleared_at)})` : ''}.</>
              ) : (
                <>Unpaid — {fmtMedMoney(r.total_amount)} is folded into the <span className="font-semibold text-foreground">{r.cut_month ? MONTH_NAMES[r.cut_month - 1] : ''} {r.cut_year}</span> salary&apos;s Deduction column (the MED tag on the Payroll page opens this record). If the employee pays later, mark it paid and the deduction is removed.</>
              )}
            </p>

            {(onMarkPaid || onDelete) && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
                {onDelete && !r.cleared && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs text-rose-500 hover:text-rose-600"
                    disabled={busyId === r.id}
                    onClick={() => onDelete(r.id)}
                    title="Annul this record — the stock is restored and the pending deduction removed (kept when the salary that carried it was already paid)"
                  >
                    {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    Delete
                  </Button>
                )}
                {onMarkPaid && !r.paid && !r.cleared && (
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 px-3 text-xs"
                    disabled={busyId === r.id}
                    onClick={() => onMarkPaid(r.id)}
                    title="The employee paid later — removes the pending salary deduction"
                  >
                    {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Banknote size={13} />}
                    Mark Paid
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}

        <DialogFooter className="sm:justify-start">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <User size={11} />
            {first ? `Recorded ${fmtDateTime(first.created_at)}` : null}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
