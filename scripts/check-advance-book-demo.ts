// Demo-engine verification of the Advance Book (mirrors the SQL test
// test_advance_book_migration.py — demo and production must behave the same).
// Runs against the in-memory demo store (no window → fresh seed).
import { db } from '@/lib/data/demo-store';
import { buildAdvanceBook, syncAdvanceBookPeriod } from '@/lib/data/demo-salary';
import { demoApi } from '@/lib/data/demo-api';
import type { Employee } from '@/lib/types';

let passed = 0;
let failed = 0;
function step(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`  OK   ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n${detail}` : ''}`); }
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- minimal fixtures ------------------------------------------------------
const emp = {
  id: 'emp-1', full_name: 'Book Keeper', employee_code: 'BK-01', status: 'active',
  join_date: '2026-01-01', opening_hours: 1500, photo: null,
} as unknown as Employee;

db.employees = [emp];
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
db.advanceRecords = [];

// T1 — add a record cut OCT: folds into the existing row
await demoApi.saveAdvanceRecord({
  employee_id: emp.id, amount: 100, given_date: '2026-10-20',
  cut_year: 2026, cut_month: 10, note: 'cash advance — site A',
});
let pe = db.payrollEmployees[0];
step('T1 add cut Oct → advance 100 / applied 100 / net 160',
  pe.advance === 100 && pe.advance_book_applied === 100 && pe.net_salary === 160,
  `advance=${pe.advance} applied=${pe.advance_book_applied} net=${pe.net_salary}`);
let book = await demoApi.getAdvanceBook();
step('T1 book: 1 due, overdue (Oct is past), applied, audit row',
  book.totals.due_count === 1 && book.totals.due_amount === 100
    && book.records[0].overdue === true && book.records[0].applied === true
    && db.payrollAudit.some((a) => a.action === 'advance_add'),
  JSON.stringify(book.totals));

// T2 — reschedule to NOV (no Nov period yet): Oct advance back to 0
const recId = db.advanceRecords[0].id;
await demoApi.saveAdvanceRecord({
  id: recId, employee_id: emp.id, amount: 100, given_date: '2026-10-20',
  cut_year: 2026, cut_month: 11, note: 'rescheduled',
});
pe = db.payrollEmployees[0];
step('T2 reschedule to Nov → Oct advance 0 / applied 0 / net 260',
  pe.advance === 0 && pe.advance_book_applied === 0 && pe.net_salary === 260,
  `advance=${pe.advance} applied=${pe.advance_book_applied} net=${pe.net_salary}`);

// T3 — the Nov period appears (generate hook = syncAdvanceBookPeriod)
db.payrollPeriods.push({
  id: 'per-nov', year: 2026, month: 11, status: 'draft', created_by: null,
  finalized_by: null, finalized_at: null, created_at: '2026-11-01T00:00:00Z',
});
db.payrollEmployees.push({
  id: 'pe-nov', payroll_period_id: 'per-nov', employee_id: emp.id,
  opening_lifetime_hours: 0, closing_lifetime_hours: 0, total_hours: 20,
  unrated_hours: 0, unassigned_hours: 0, gross_salary: 260, advance: 0,
  advance_book_applied: 0, deduction: 0, absent_deduction: 0,
  absent_deduction_edited: false, net_salary: 260, payment_status: 'unpaid',
  paid_at: null, paid_by: null, notes: null, trade_id_snapshot: null,
  salary_role_snapshot: 'standard', manually_edited: false,
});
syncAdvanceBookPeriod(db, 2026, 11);
let nov = db.payrollEmployees[1];
step('T3 generate sync folds the record into Nov (100 / 100 / 160)',
  nov.advance === 100 && nov.advance_book_applied === 100 && nov.net_salary === 160,
  `advance=${nov.advance} applied=${nov.advance_book_applied} net=${nov.net_salary}`);

// T4 — manual advance edit coexists, then a second record
await demoApi.updatePayrollAdjustment('pe-nov', { advance: 150, deduction: 0, notes: null });
nov = db.payrollEmployees[1];
step('T4a manual edit → advance 150, applied stays 100',
  nov.advance === 150 && nov.advance_book_applied === 100,
  `advance=${nov.advance} applied=${nov.advance_book_applied}`);
await demoApi.saveAdvanceRecord({
  employee_id: emp.id, amount: 50, given_date: '2026-11-10',
  cut_year: 2026, cut_month: 11, note: 'second',
});
nov = db.payrollEmployees[1];
step('T4b +50 record → advance 200 / applied 150 / net 60',
  nov.advance === 200 && nov.advance_book_applied === 150 && nov.net_salary === 60,
  `advance=${nov.advance} applied=${nov.advance_book_applied} net=${nov.net_salary}`);
book = await demoApi.getAdvanceBook();
step('T5 totals: 2 due, 150', book.totals.due_count === 2 && book.totals.due_amount === 150,
  JSON.stringify(book.totals));

// T6 — mark paid → cleared (derived), unmark → due again
await demoApi.markPayrollPaid('pe-nov', { advance: 200, deduction: 0, notes: null });
book = await demoApi.getAdvanceBook();
step('T6 paid → both cleared, sheet empties advance_book_due',
  book.totals.cleared_count === 2 && book.totals.due_count === 0,
  JSON.stringify(book.totals));

// T7 — cleared records locked
let lockedEdit = false;
try {
  await demoApi.saveAdvanceRecord({
    id: recId, employee_id: emp.id, amount: 10, given_date: '2026-10-20',
    cut_year: 2026, cut_month: 12,
  });
} catch (err) {
  lockedEdit = err instanceof Error && err.message.includes('already cleared');
}
let lockedDelete = false;
try {
  await demoApi.deleteAdvanceRecord(recId);
} catch (err) {
  lockedDelete = err instanceof Error && err.message.includes('already cleared');
}
step('T7 cleared records cannot be edited or deleted', lockedEdit && lockedDelete);

// T8 — unmark → due again
await demoApi.unmarkPayrollPaid('pe-nov', 'test revert');
book = await demoApi.getAdvanceBook();
step('T8 unmark → both due again',
  book.totals.due_count === 2 && book.totals.cleared_count === 0,
  JSON.stringify(book.totals));

// T9 — delete the 50 record: exactly its part removed
const rec50 = db.advanceRecords.find((r) => r.amount === 50)!;
await demoApi.deleteAdvanceRecord(rec50.id);
nov = db.payrollEmployees[1];
step('T9 delete → advance 150 / applied 100 / net 110',
  nov.advance === 150 && nov.advance_book_applied === 100 && nov.net_salary === 110,
  `advance=${nov.advance} applied=${nov.advance_book_applied} net=${nov.net_salary}`);

// T10 — PAID rows skipped: re-pay, then add a record cut to the paid month
await demoApi.markPayrollPaid('pe-nov', { advance: 150, deduction: 0, notes: null });
await demoApi.saveAdvanceRecord({
  employee_id: emp.id, amount: 60, given_date: '2026-11-12',
  cut_year: 2026, cut_month: 11, note: 'late entry into a paid month',
});
nov = db.payrollEmployees[1];
book = await demoApi.getAdvanceBook();
step('T10 paid row skipped (advance stays 150/100), new record stays due',
  nov.advance === 150 && nov.advance_book_applied === 100 && book.totals.due_count === 1,
  `advance=${nov.advance} applied=${nov.advance_book_applied} totals=${JSON.stringify(book.totals)}`);

// buildAdvanceBook consistency spot-check (same totals path)
const built = buildAdvanceBook(db);
step('T11 buildAdvanceBook matches getAdvanceBook',
  built.totals.due_count === book.totals.due_count
    && built.totals.cleared_amount === book.totals.cleared_amount);

console.log(`\n== demo advance book: ${passed}/${passed + failed} steps passed ==`);
if (failed > 0) process.exit(1);
