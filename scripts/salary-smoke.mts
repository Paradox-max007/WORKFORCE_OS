// Smoke test: demo salary engine (site attribution, rates, manual edits)
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
import { db } from '@/lib/data/demo-store';
import {
  buildSalarySheet, refreshPayrollPeriod, applySalarySheetRow,
  resetPayrollEmployeeAuto, calcEmployeePayroll,
} from '@/lib/data/demo-salary';

const now = new Date();
const y = now.getFullYear();
const m = now.getMonth() + 1;

const uid = (): string => `t-${Math.random().toString(36).slice(2, 10)}`;

// 1. generate payroll for the current month
refreshPayrollPeriod(db, y, m, null, uid);
const sheet = buildSalarySheet(db, y, m, (yy, mm) => refreshPayrollPeriod(db, yy, mm, null, uid));

console.log('== period:', sheet.period?.status, `${y}-${m}`);
console.log('== sites:', sheet.sites.map((s) => `${s.site_name}(${s.employees} emp, ${s.total_hours}h, gross ${s.gross_salary})`).join(' | '));

// 2. Kamal Hussain (moved NPC → Marina 41 days ago) must appear at BOTH sites
const kamal = db.employees.find((e) => e.full_name === 'Kamal Hussain')!;
const kamalEmp = sheet.employees.find((e) => e.employee_id === kamal.id)!;
console.log('== Kamal sites:', kamalEmp.sites.map((s) => `${s.site_name}: ${s.total_hours}h`).join(' | '));
console.log('== Kamal unrated:', kamalEmp.unrated_hours, 'unassigned:', kamalEmp.unassigned_hours, 'gross:', kamalEmp.gross_salary);

// 3. no employee should have missing rates (seeded rates cover 2026-01-01 →)
const withMissing = sheet.employees.filter((e) => e.sites.some((s) => s.has_missing_rate));
console.log('== employees with missing rate:', withMissing.map((e) => e.full_name));

// 4. per-site unpriced attribution: employees without a trade still land at their site
const cleaner = db.employees.find((e) => e.full_name === 'Ibrahim Toure')!; // no site, no trade match? 'Cleaner' trade exists... 
const cleanerEmp = sheet.employees.find((e) => e.employee_id === cleaner.id)!;
console.log('== Ibrahim (Cleaner, idle) sites:', cleanerEmp.sites.map((s) => `${s.site_name}: ${s.total_hours}h`));

// 5. manual site override survives a draft regeneration
const target = sheet.employees.find((e) => e.full_name === 'Rajesh Kumar')!;
const targetSite = target.sites[0];
const peId = target.id;
console.log('== before manual:', target.total_hours, 'h gross', target.gross_salary);
applySalarySheetRow(db, {
  payroll_employee_id: peId,
  sites: [{ site_id: targetSite.site_id, total_hours: 100, hourly_rate: 12.5, gross_salary: 1250 }],
}, null, 'tester', uid);
const sheet2 = buildSalarySheet(db, y, m, (yy, mm) => refreshPayrollPeriod(db, yy, mm, null, uid));
const after = sheet2.employees.find((e) => e.id === peId)!;
console.log('== after manual + regen:', after.total_hours, 'h gross', after.gross_salary, 'manual:', after.manually_edited);

// 6. trade change via the sheet (non-manual employee) → reprice
const emp2 = sheet2.employees.find((e) => e.full_name === 'Arun Nair')!;
const newTrade = db.trades.find((t) => t.name === 'Welder')!;
console.log('== Arun before trade change:', emp2.trade_name, emp2.gross_salary);
applySalarySheetRow(db, {
  payroll_employee_id: emp2.id,
  trade_id: newTrade.id,
  advance: 50, deduction: 0,
}, null, 'tester', uid);
const sheet3 = buildSalarySheet(db, y, m, (yy, mm) => refreshPayrollPeriod(db, yy, mm, null, uid));
const emp2b = sheet3.employees.find((e) => e.id === emp2.id)!;
console.log('== Arun after trade change:', emp2b.trade_name, emp2b.gross_salary, 'advance:', emp2b.advance);
console.log('== stored trade overwritten:', db.employees.find((e) => e.full_name === 'Arun Nair')!.trade_id === newTrade.id);

// 7. reset to auto
resetPayrollEmployeeAuto(db, peId, null, 'tester', uid);
const sheet4 = buildSalarySheet(db, y, m, (yy, mm) => refreshPayrollPeriod(db, yy, mm, null, uid));
const afterReset = sheet4.employees.find((e) => e.id === peId)!;
console.log('== after reset-to-auto:', afterReset.total_hours, 'h gross', afterReset.gross_salary, 'manual:', afterReset.manually_edited);

// 8. pure calc check: unassigned per-site attribution
const calc = calcEmployeePayroll(db, kamal.id, y, m);
console.log('== calc unassigned_sites:', Object.fromEntries(calc.unassigned_sites), 'unrated_sites:', Object.fromEntries(calc.unrated_sites));
console.log('DONE');
