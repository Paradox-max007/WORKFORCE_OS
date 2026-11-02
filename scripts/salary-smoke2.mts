process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
import { db } from '@/lib/data/demo-store';
import { buildSalarySheet, refreshPayrollPeriod } from '@/lib/data/demo-salary';

const uid = (): string => `t-${Math.random().toString(36).slice(2, 10)}`;
const now = new Date();
// October = the month containing the move (12 days ago)
const y = now.getMonth() >= 1 ? now.getFullYear() : now.getFullYear() - 1;
const m = now.getMonth() === 0 ? 12 : now.getMonth(); // previous month number

refreshPayrollPeriod(db, y, m, null, uid);
const sheet = buildSalarySheet(db, y, m, (yy, mm) => refreshPayrollPeriod(db, yy, mm, null, uid));
console.log('== period:', `${y}-${m}`);
console.log('== sites:', sheet.sites.map((s) => `${s.site_name}(${s.employees} emp, ${s.total_hours}h)`).join(' | '));

const kamal = db.employees.find((e) => e.full_name === 'Kamal Hussain')!;
const kamalEmp = sheet.employees.find((e) => e.employee_id === kamal.id)!;
console.log('== Kamal in October (moved mid-month):',
  kamalEmp.sites.map((s) => `${s.site_name}: ${s.total_hours}h, gross ${s.gross_salary}`).join(' | '));
const npcRow = kamalEmp.sites.find((s) => s.site_name.includes('NPC'));
const marinaRow = kamalEmp.sites.find((s) => s.site_name.includes('Marina'));
console.log(npcRow && marinaRow ? 'PASS: moved-out employee appears at BOTH sites' : 'FAIL: expected both sites');

// sitewise breakdown: each site group contains the employee rows
sheet.sites.forEach((g) => {
  const names = g.rows.map((r) => r.full_name).join(', ');
  console.log(`   [${g.site_name}] ${g.employees} employees: ${names}`);
});
console.log('DONE');
