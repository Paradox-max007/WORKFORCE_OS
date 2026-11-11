/* Verify the downloaded PULSE payroll .xlsx (structure, order, values, formats) */
const XLSX = require('/home/z/my-project/node_modules/xlsx');
const path = '/home/z/Downloads/Pulse_Payroll_October-2026_Trade-Electrician_2026-11-11.xlsx';

const wb = XLSX.readFile(path);
console.log('Sheets:', wb.SheetNames);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
console.log('Total rows (incl. header + TOTAL):', rows.length);
console.log('\n--- Header row ---');
console.log(JSON.stringify(rows[0]));
console.log('\n--- Data row 1 ---');
console.log(JSON.stringify(rows[1]));
console.log('\n--- TOTAL row ---');
console.log(JSON.stringify(rows[rows.length - 1]));

// number formats + raw types of the money cells (F/G/H/I → idx 5..8)
console.log('\n--- Cell types & formats (row 2, cols E..I) ---');
['E2', 'F2', 'G2', 'H2', 'I2', 'C2'].forEach((addr) => {
  const c = ws[addr];
  console.log(addr, c ? { t: c.t, v: c.v, z: c.z } : 'MISSING');
});

// col widths
console.log('\n!cols:', JSON.stringify(ws['!cols']));
// workbook props
console.log('Props:', JSON.stringify(wb.Props));
