// Builds the E2E fixture: an xlsx that looks like a REAL Excel upload —
// explicit white fills, explicit black fonts, thin black borders, a yellow
// highlight with black text and a red-text cell (chosen colours).
// Writes /tmp/upload-dark-test.xlsx and prints it as base64 for injection.
import { Workbook } from 'exceljs';

const wb = new Workbook();
const ws = wb.addWorksheet('Nov 2026');

const black = { argb: 'FF000000' };
const thin = { style: 'thin', color: black };

const a1 = ws.getCell('A1');
a1.value = 'MARINA TOWER — NOVEMBER 2026';
a1.font = { bold: true, size: 13, color: black };
a1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }; // explicit white

['Day', 'Worker', 'Hours'].forEach((h, i) => {
  const c = ws.getCell(2, i + 1);
  c.value = h;
  c.font = { bold: true, color: black };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; // "White, Bg 1, Darker 5%"
  c.border = { top: thin, left: thin, bottom: thin, right: thin };
});

const rows = [
  ['Mon', 'Ravi Kumar', 10],
  ['Tue', 'Anita Shah', 9.5],
  ['Wed', 'John Doe', 8],
  ['Thu', 'Sam Raj', 11],
];
rows.forEach((r, i) => {
  r.forEach((v, j) => {
    const c = ws.getCell(3 + i, j + 1);
    c.value = v;
    c.font = { color: black }; // Excel writes explicit black fonts
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }; // explicit white fill
    c.border = { bottom: thin, left: thin, right: thin };
  });
});

// chosen colours must survive dark mode untouched
const y = ws.getCell('C3');
y.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // yellow
y.font = { bold: true, color: black };

const rd = ws.getCell('B8');
rd.value = 'OVERTIME';
rd.font = { bold: true, color: { argb: 'FFC00000' } }; // red text, no fill

ws.getColumn(1).width = 10;
ws.getColumn(2).width = 22;
ws.getColumn(3).width = 10;

const buf = await wb.xlsx.writeBuffer();
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/upload-dark-test.xlsx', Buffer.from(buf));
console.log(Buffer.from(buf).toString('base64'));
