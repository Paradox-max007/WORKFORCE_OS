// Verify the Balance column arithmetic display for all three time-card cases
// using the REAL exported helpers from export-payroll-xlsx.ts.
//
// Balance = net payable − |time card extra| — the difference ALWAYS applies
// with its effect on the balance: a NEGATIVE extra (time card below the
// approved attendance) SUBTRACTS just like a positive one (the sign is never
// flipped into an addition; the amount is recovered next month via the
// advance).
import {
  payrollBalanceOf, payrollNetPayableOf, payrollTimeCardExtraOf,
} from '@/lib/export-payroll-xlsx';
import type { PayrollEmployeeVM } from '@/lib/types';

const base = {
  full_name: 'Test', employee_code: 'T1', gross_salary: 1560, total_hours: 120,
  net_salary: 1160, advance: 0, deduction: 0, time_card_hours: null,
  time_card_amount: null,
} as unknown as PayrollEmployeeVM;

const cases = [
  { name: 'no time card entered', e: { ...base } },
  { name: 'difference is 0 (120h card = 120h attendance)', e: { ...base, time_card_hours: 120, time_card_amount: 0 } },
  { name: 'POSITIVE extra +60', e: { ...base, time_card_hours: 124.615, time_card_amount: 60 } },
  { name: 'NEGATIVE extra -104 (sign respected — balance REDUCES)', e: { ...base, time_card_hours: 112, time_card_amount: -104 } },
  { name: 'NEGATIVE extra beyond the net (-2,000)', e: { ...base, time_card_hours: 0, time_card_amount: -2000 } },
];

const fmtMoney = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

for (const { name, e } of cases) {
  const bal = payrollBalanceOf(e);
  const extra = payrollTimeCardExtraOf(e);
  const net = payrollNetPayableOf(e);
  if (bal == null) {
    console.log(`${name}\n  cell: — (no balance)\n`);
    continue;
  }
  if (extra === 0) {
    console.log(`${name}\n  cell: ${fmtMoney(0)} (muted — no calculation shown)\n`);
    continue;
  }
  const operand = Math.abs(extra);
  console.log(`${name}`);
  console.log(`  calc line: ${fmtMoney(net)} − ${fmtMoney(operand)} =`);
  console.log(`  value:     ${fmtMoney(bal)}`);
  // arithmetic self-check — ALWAYS a subtraction (sign respected)
  const check = Math.round((net - operand) * 100) / 100;
  if (check !== bal) throw new Error(`arithmetic mismatch: ${check} vs ${bal}`);
  if (extra < 0 && bal >= net) {
    throw new Error(`negative extra must REDUCE the balance: ${fmtMoney(bal)} >= ${fmtMoney(net)}`);
  }
  console.log(`  arithmetic self-check OK (${fmtMoney(net)} - ${fmtMoney(operand)} -> ${fmtMoney(bal)})\n`);
}
console.log('ALL CASES OK');
