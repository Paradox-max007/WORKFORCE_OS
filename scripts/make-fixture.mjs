// Build a styled fixture timesheet for the E2E test.
// Covers: fills, font colors, bold/italic/underline, borders, alignment,
// merges (A1:C1 title, D2:E2), column widths, row heights, formula.
import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('May 2026');

ws.getCell('A1').value = 'ACME SITE — MAY 2026 TIMESHEET';
ws.mergeCells('A1:C1');
ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
ws.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };

ws.getCell('A2').value = 'Day';
ws.getCell('B2').value = 'Worker';
ws.getCell('C2').value = 'Hours';
ws.mergeCells('D2:E2');
ws.getCell('D2').value = 'Notes';
for (const a of ['A2', 'B2', 'C2', 'D2']) {
  ws.getCell(a).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
  ws.getCell(a).font = { bold: true };
}

ws.getCell('A3').value = 'Mon';
ws.getCell('B3').value = 'Ravi Kumar';
ws.getCell('C3').value = 8;
ws.getCell('D3').value = 'day shift';
ws.getCell('A4').value = 'Tue';
ws.getCell('B4').value = 'Anita Shah';
ws.getCell('C4').value = 9;
ws.getCell('D4').value = 'night shift';

ws.getCell('C3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
ws.getCell('C3').numFmt = '#,##0.00';
ws.getCell('C4').font = { italic: true, underline: true, color: { argb: 'FFED7D31' } };
ws.getCell('C4').numFmt = '#,##0.00';

ws.getCell('A6').value = 'TOTAL';
ws.getCell('A6').font = { bold: true };
ws.getCell('C6').value = { formula: 'SUM(C3:C4)', result: 17 };
ws.getCell('C6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

ws.getCell('B3').border = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'medium', color: { argb: 'FF444444' } },
};
ws.getCell('D3').alignment = { horizontal: 'center', vertical: 'middle' };

ws.getColumn(1).width = 12;
ws.getColumn(2).width = 20;
ws.getColumn(4).width = 14;
ws.getRow(2).height = 22;
ws.getRow(6).height = 26;

const buf = await wb.xlsx.writeBuffer();
const fs = await import('node:fs');
fs.writeFileSync('/tmp/fixture-timesheet.xlsx', new Uint8Array(buf));
console.log('fixture written:', fs.statSync('/tmp/fixture-timesheet.xlsx').size, 'bytes');
