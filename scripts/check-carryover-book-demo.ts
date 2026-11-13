// Demo-engine verification of the time-card carryover → Advance Book record
// (mirrors the SQL test test_carryover_book_migration.py — demo and
// production must behave the same). Runs against the in-memory demo store.
import { db } from '@/lib/data/demo-store';
import { buildAdvanceBook, syncAdvanceBookPeriod } from '@/lib/data/demo-salary';
import { demoApi } from '@/lib/data/demo-api';
import type { Employee, Site } from '@/lib/types';

let passed = 0;
let failed = 0;
function step(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  OK   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n${detail}` : ''}`); }
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- minimal fixtures -------------------------------------------------------
// 20 h attendance at 13/h → 260 gross in Oct; the site row carries the rate
const emp = {
  id: 'emp-1', full_name: 'Card Carrier', employee_code: 'CC-01', status: 'active',
  join_date: '2026-01-01', opening_hours: 1500, photo: null,
} as unknown as Employee;
const site = { id: 'site-1', name: 'Carry Tower', is_active: true } as unknown as Site;

db.employees = [emp];
db.sites = [site];
db.payrollPeriods = [{
  id: 'per-oct', year: 2026, month: 10, status: 'draft', created_by: null,
  finalized_by: null, finalized_at: null, created_at: '2026-10-01T00:00:00Z',
}];
db.payrollEmployees = [{
  id: 'pe-oct', payroll_period_id: 'per-oct', employee_id: emp.id,
  opening_lifetime_hours: 0, closing_lifetime_hours: 0, total_hours: 20,
  unrated_hours: 0, unassigned_hours: 0, gross_salary: 260, advance: 0,
  advance_book_applied: 0, deduction: 0, absent_deduction: 0,
  absent_deduction_edited: false, net_salary: 260, payment_status: 'unpaid',
  paid_at: null, paid_by: null, notes: null, trade_id_snapshot: null,
  salary_role_snapshot: 'standard', manually_edited: false,
}];
db.payrollSites = [{
  id: 'ps-1', payroll_employee_id: 'pe-oct', site_id: site.id,
  site_name_snapshot: 'Carry Tower', total_hours: 20, below_threshold_hours: 0,
  qualified_hours: 20, standard_hours: 20, team_leader_hours: 0,
  supervisor_hours: 0, gross_salary: 260, has_missing_rate: false,
  manually_edited: false,
}];
db.payrollTimeCards = [];
db.advanceRecords = [];

// D1 — negative difference (12 h vs 20 h → 104): a book record is created
//      with the DEFAULT CUT = the very next month (Nov 2026) + the note
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 12 },
]);
let rec = db.advanceRecords.find((r) => r.employee_id === emp.id);
step('D1 negative difference → book record 104 cut Nov 2026 (source Oct)',
  !!rec && rec.amount === 104 && rec.cut_year === 2026 && rec.cut_month === 11
    && rec.source_period_id === 'per-oct' && rec.applied_amount === 0
    && !!rec.note && rec.note.includes('[Time card Oct 2026]')
    && rec.note.includes('cutting from Nov 2026'),
  rec ? `amount=${rec.amount} cut=${rec.cut_year}-${rec.cut_month} note=${rec.note}` : 'no record');
step('D1 the Nov period is created (draft) + tracking on the entry',
  db.payrollPeriods.some((p) => p.year === 2026 && p.month === 11 && p.status === 'draft')
    && db.payrollTimeCards[0].carryover_applied === 104,
  `periods=${db.payrollPeriods.length} applied=${db.payrollTimeCards[0]?.carryover_applied}`);
let book = await demoApi.getAdvanceBook();
step('D1 book lists it as due + from_time_card',
  book.totals.due_count === 1 && book.totals.due_amount === 104
    && book.records[0].from_time_card === true,
  JSON.stringify(book.totals));

// D2 — the Nov row appears (generation): the record folds into the advance.
//      The Nov PERIOD was already auto-created by the D1 save — attach the
//      row to THAT period (never a duplicate).
const perNov = db.payrollPeriods.find((p) => p.year === 2026 && p.month === 11)!;
db.payrollEmployees.push({
  id: 'pe-nov', payroll_period_id: perNov.id, employee_id: emp.id,
  opening_lifetime_hours: 0, closing_lifetime_hours: 0, total_hours: 20,
  unrated_hours: 0, unassigned_hours: 0, gross_salary: 260, advance: 0,
  advance_book_applied: 0, deduction: 0, absent_deduction: 0,
  absent_deduction_edited: false, net_salary: 260, payment_status: 'unpaid',
  paid_at: null, paid_by: null, notes: null, trade_id_snapshot: null,
  salary_role_snapshot: 'standard', manually_edited: false,
});
syncAdvanceBookPeriod(db, 2026, 11);
let nov = db.payrollEmployees[1];
step('D2 Nov generation folds the record in (104 / 104 / 156)',
  nov.advance === 104 && nov.advance_book_applied === 104 && nov.net_salary === 156,
  `advance=${nov.advance} applied=${nov.advance_book_applied} net=${nov.net_salary}`);

// D3 — re-saving the SAME hours is a no-op (no double count)
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 12 },
]);
nov = db.payrollEmployees[1];
step('D3 re-save same hours → no-op (still 104 / 104)',
  nov.advance === 104 && nov.advance_book_applied === 104 && db.advanceRecords.length === 1,
  `advance=${nov.advance} applied=${nov.advance_book_applied} records=${db.advanceRecords.length}`);

// D4 — re-saving a different amount updates the record + the advance
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 10 },
]);
rec = db.advanceRecords.find((r) => r.employee_id === emp.id)!;
nov = db.payrollEmployees[1];
step('D4 re-save 10 h → record 130, advance 130 / 130 / 130',
  rec.amount === 130 && nov.advance === 130 && nov.advance_book_applied === 130
    && nov.net_salary === 130,
  `rec=${rec.amount} advance=${nov.advance} applied=${nov.advance_book_applied} net=${nov.net_salary}`);

// D5 — the time card now matches → the record is deleted, the advance resets
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 20 },
]);
nov = db.payrollEmployees[1];
step('D5 matching time card → record deleted, advance 0 / 0 / 260',
  db.advanceRecords.length === 0 && nov.advance === 0
    && nov.advance_book_applied === 0 && nov.net_salary === 260,
  `records=${db.advanceRecords.length} advance=${nov.advance} net=${nov.net_salary}`);

// D6 — positive difference → no record at all
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 25 },
]);
step('D6 positive difference → no record, advance untouched',
  db.advanceRecords.length === 0 && nov.advance === 0,
  `records=${db.advanceRecords.length} advance=${nov.advance}`);

// D7 — recreate, RESCHEDULE to Dec by hand, then re-save: the amount follows
//      the time card but the user's cut month is preserved
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 12 },
]);
rec = db.advanceRecords.find((r) => r.employee_id === emp.id)!;
await demoApi.saveAdvanceRecord({
  id: rec.id, employee_id: emp.id, amount: rec.amount, given_date: rec.given_date,
  cut_year: 2026, cut_month: 12, note: rec.note,
});
await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
  { employee_id: emp.id, hours: 8 },
]);
rec = db.advanceRecords.find((r) => r.employee_id === emp.id)!;
nov = db.payrollEmployees[1];
step('D7 reschedule preserved: amount 156, cut stays Dec, Nov row untouched',
  rec.amount === 156 && rec.cut_year === 2026 && rec.cut_month === 12
    && (rec.note ?? '').includes('cutting from Dec 2026')
    && nov.advance === 0 && nov.advance_book_applied === 0 && nov.net_salary === 260,
  `rec=${rec.amount} cut=${rec.cut_year}-${rec.cut_month} note=${rec.note} nov=${nov.advance}/${nov.advance_book_applied}`);

// D8 — generate Dec, pay it → the record is CLEARED (badge kept); re-save raises
db.payrollPeriods.push({
  id: 'per-dec', year: 2026, month: 12, status: 'draft', created_by: null,
  finalized_by: null, finalized_at: null, created_at: '2026-12-01T00:00:00Z',
});
db.payrollEmployees.push({
  id: 'pe-dec', payroll_period_id: 'per-dec', employee_id: emp.id,
  opening_lifetime_hours: 0, closing_lifetime_hours: 0, total_hours: 20,
  unrated_hours: 0, unassigned_hours: 0, gross_salary: 260, advance: 0,
  advance_book_applied: 0, deduction: 0, absent_deduction: 0,
  absent_deduction_edited: false, net_salary: 260, payment_status: 'unpaid',
  paid_at: null, paid_by: null, notes: null, trade_id_snapshot: null,
  salary_role_snapshot: 'standard', manually_edited: false,
});
syncAdvanceBookPeriod(db, 2026, 12);
const dec = db.payrollEmployees[2];
step('D8a Dec generation folds it in (156 / 156 / 104)',
  dec.advance === 156 && dec.advance_book_applied === 156 && dec.net_salary === 104,
  `advance=${dec.advance} applied=${dec.advance_book_applied} net=${dec.net_salary}`);
await demoApi.markPayrollPaid('pe-dec', { advance: 156, deduction: 0, notes: null });
book = await demoApi.getAdvanceBook();
const clearedRec = book.records.find((r) => r.amount === 156);
step('D8b paid → record cleared with the time-card badge',
  !!clearedRec && clearedRec.cleared === true && clearedRec.from_time_card === true,
  JSON.stringify(book.totals));
let raised = false;
try {
  await demoApi.saveSiteTimeCardHours('per-oct', site.id, [
    { employee_id: emp.id, hours: 6 },
  ]);
} catch (err) {
  raised = err instanceof Error && err.message.includes('already cleared');
}
step('D8c re-saving after the clear raises', raised);

// D9 — the audit trail holds the carryover actions
const carryAudits = db.payrollAudit.filter((a) => a.action === 'time_card_carryover');
step('D9 audit trail holds the carryover actions (5)',
  carryAudits.length === 5
    && carryAudits.every((a) => a.period_id === 'per-oct'),
  `count=${carryAudits.length}`);

// D10 — buildAdvanceBook consistency spot-check
const built = buildAdvanceBook(db);
step('D10 buildAdvanceBook matches getAdvanceBook',
  built.totals.cleared_count === book.totals.cleared_count
    && round2(built.totals.cleared_amount) === round2(book.totals.cleared_amount));

console.log(`\n== demo carryover → advance book: ${passed}/${passed + failed} steps passed ==`);
if (failed > 0) process.exit(1);
