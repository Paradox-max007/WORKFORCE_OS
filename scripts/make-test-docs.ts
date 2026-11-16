// Generates test documents for the site-timesheets E2E check
import * as XLSX from 'xlsx';
import { writeFileSync } from 'fs';

const wb = XLSX.utils.book_new();
const ws: XLSX.WorkSheet = {};
// A1=10, A2=32, A3==SUM(A1:A2), B1..B3 labels, C1==IF(A3>40,"high","low")
const cells: Record<string, XLSX.CellObject> = {
  A1: { t: 'n', v: 10 },
  A2: { t: 'n', v: 32 },
  A3: { t: 'n', v: 42, f: 'SUM(A1:A2)' },
  B1: { t: 's', v: 'Employee' },
  B2: { t: 's', v: 'Ahmed' },
  B3: { t: 's', v: 'Hassan' },
  C1: { t: 's', v: 'high', f: 'IF(A3>40,"high","low")' },
};
Object.entries(cells).forEach(([addr, cell]) => { ws[addr] = cell; });
ws['!ref'] = 'A1:C6';
ws['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 14 }];
ws['!merges'] = [{ s: { r: 0, c: 1 }, e: { r: 0, c: 2 } }];
XLSX.utils.book_append_sheet(wb, ws, 'November');
const ws2: XLSX.WorkSheet = {};
ws2['A1'] = { t: 's', v: 'Notes sheet' };
ws2['!ref'] = 'A1:A3';
XLSX.utils.book_append_sheet(wb, ws2, 'Notes');
const out = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
writeFileSync('/tmp/test-timesheet.xlsx', out);
console.log('xlsx written:', out.length, 'bytes');
