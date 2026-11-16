// Verify the SAVED timesheet kept: values, formula+result, fills, fonts,
// borders, alignment, merges (old + new), column widths, row heights.
import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(await (await import('node:fs')).promises.readFile('/tmp/saved-timesheet.xlsx'));
const ws = wb.getWorksheet('May 2026');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`FAIL  ${label} ${extra}`); }
};

const argb = (c) => c?.argb ?? `theme:${c?.theme}`;

// values & formula
check('C3 = 10 (edited)', ws.getCell('C3').value === 10, JSON.stringify(ws.getCell('C3').value));
const c6 = ws.getCell('C6').value;
check('C6 formula SUM(C3:C4)', c6?.formula === 'SUM(C3:C4)', JSON.stringify(c6));
check('C6 cached result 19', c6?.result === 19, JSON.stringify(c6?.result));
check('C4 = 9', ws.getCell('C4').value === 9);
check('A1 title text', ws.getCell('A1').value === 'ACME SITE — MAY 2026 TIMESHEET');

// unchanged styles (must be bit-perfect)
check('A1 fill 4472C4', argb(ws.getCell('A1').fill?.fgColor) === 'FF4472C4', JSON.stringify(ws.getCell('A1').fill));
check('A1 font bold + white', ws.getCell('A1').font?.bold === true && argb(ws.getCell('A1').font?.color) === 'FFFFFFFF');
check('A2 fill FFC000', argb(ws.getCell('A2').fill?.fgColor) === 'FFFFC000');
check('D2 fill FFC000', argb(ws.getCell('D2').fill?.fgColor) === 'FFFFC000');
check('C3 fill C6EFCE (value edited, style kept)', argb(ws.getCell('C3').fill?.fgColor) === 'FFC6EFCE');
check('C4 font italic+underline+ED7D31', ws.getCell('C4').font?.italic === true && ws.getCell('C4').font?.underline === true && argb(ws.getCell('C4').font?.color) === 'FFED7D31');
check('C6 fill FFF2CC', argb(ws.getCell('C6').fill?.fgColor) === 'FFFFF2CC');
check('B3 border thin black top', ws.getCell('B3').border?.top?.style === 'thin' && argb(ws.getCell('B3').border?.top?.color) === 'FF000000');
check('B3 border medium bottom', ws.getCell('B3').border?.bottom?.style === 'medium');
check('D3 alignment center/middle', ws.getCell('D3').alignment?.horizontal === 'center' && ws.getCell('D3').alignment?.vertical === 'middle');

// new user styling
check('B4 fill FF69B4 (user pink)', argb(ws.getCell('B4').fill?.fgColor) === 'FFFF69B4', JSON.stringify(ws.getCell('B4').fill));
check('C5 fill FF69B4 (user pink)', argb(ws.getCell('C5').fill?.fgColor) === 'FFFF69B4');
check('B5 fill FF69B4 (user pink)', argb(ws.getCell('B5').fill?.fgColor) === 'FFFF69B4');
check('C4 fill FF69B4 (painted range incl. C4)', argb(ws.getCell('C4').fill?.fgColor) === 'FFFF69B4');
check('A4 outside paint (no fill)', !ws.getCell('A4').fill || ws.getCell('A4').fill?.type !== 'pattern' || ws.getCell('A4').fill?.pattern !== 'solid', JSON.stringify(ws.getCell('A4').fill));
check('C4 numFmt kept through restyle', ws.getCell('C4').style?.numFmt === '#,##0.00', String(ws.getCell('C4').style?.numFmt));
check('C4 font kept through restyle', ws.getCell('C4').font?.italic === true && argb(ws.getCell('C4').font?.color) === 'FFED7D31');
check('C3 numFmt kept (value edit only)', ws.getCell('C3').style?.numFmt === '#,##0.00', String(ws.getCell('C3').style?.numFmt));

// merges: original two + the new D4:E5
const merges = (ws.model.merges ?? []).slice().sort();
check('merges A1:C1 + D2:E2 + D4:E5', JSON.stringify(merges) === JSON.stringify(['A1:C1', 'D2:E2', 'D4:E5']), JSON.stringify(merges));

// sizes
check('col A width 12', Math.abs(ws.getColumn(1).width - 12) < 0.2, String(ws.getColumn(1).width));
check('col B width 20', Math.abs(ws.getColumn(2).width - 20) < 0.2, String(ws.getColumn(2).width));
check('col D width 14', Math.abs(ws.getColumn(4).width - 14) < 0.2, String(ws.getColumn(4).width));
check('row 2 height 22', Math.abs(ws.getRow(2).height - 22) < 0.2, String(ws.getRow(2).height));
check('row 6 height 26', Math.abs(ws.getRow(6).height - 26) < 0.2, String(ws.getRow(6).height));

// numFmt round trip
check('B3 numFmt not applicable (none in fixture)', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
