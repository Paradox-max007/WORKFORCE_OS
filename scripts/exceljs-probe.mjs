// Verify exceljs behavior: style read/write, merges, widths, heights, formulas.
import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('May 2026');

// content
ws.getCell('A1').value = 'SITE TIMESHEET';
ws.getCell('A2').value = 'Day';
ws.getCell('B2').value = 'Hours';
ws.getCell('C2').value = 'Total';
ws.getCell('A3').value = 'Mon';
ws.getCell('B3').value = 8;
ws.getCell('C3').value = { formula: 'SUM(B3:B4)', result: 17 };
ws.getCell('A4').value = 'Tue';
ws.getCell('B4').value = 9;

// styles
ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
ws.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14, name: 'Calibri' };
ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
ws.getCell('C3').font = { italic: true, underline: true, color: { argb: 'FFED7D31' } };
ws.getCell('B3').alignment = { horizontal: 'center', vertical: 'middle' };
ws.getCell('B3').border = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'medium', color: { argb: 'FF333333' } },
};
ws.getCell('B3').numFmt = '#,##0.00';

// merges + sizes
ws.mergeCells('A1:C1');
ws.getColumn(2).width = 24;      // chars
ws.getRow(3).height = 30;        // points
ws.getRow(5).height = 18;

const buf = await wb.xlsx.writeBuffer();
const bytes = new Uint8Array(buf);

// ---- reload and inspect ----
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(bytes);
const ws2 = wb2.getWorksheet('May 2026');

console.log('merges:', JSON.stringify(ws2.model.merges));
console.log('colB width:', ws2.getColumn(2).width, ' colA width:', ws2.getColumn(1).width);
console.log('row3 height:', ws2.getRow(3).height, ' row5 height:', ws2.getRow(5).height);
console.log('rowCount:', ws2.rowCount, 'columnCount:', ws2.columnCount);

const a1 = ws2.getCell('A1');
console.log('A1 fill:', JSON.stringify(a1.fill));
console.log('A1 font:', JSON.stringify(a1.font));
const c3 = ws2.getCell('C3');
console.log('C3 value:', JSON.stringify(c3.value), 'font:', JSON.stringify(c3.font));
const b3 = ws2.getCell('B3');
console.log('B3 numFmt:', b3.style?.numFmt, '| border:', JSON.stringify(b3.border), '| align:', JSON.stringify(b3.alignment));
console.log('B3 style obj keys:', Object.keys(b3.style ?? {}));
console.log('plain cell A4 style keys:', Object.keys(ws2.getCell('A4').style ?? {}), JSON.stringify(ws2.getCell('A4').style));

// ---- test unmerge + value assign keeping style ----
ws2.unMergeCells('A1:C1');
ws2.getCell('B1').value = 'hello'; // B1 was a hidden merged cell
console.log('after unmerge, A1 fill still:', JSON.stringify(ws2.getCell('A1').fill?.fgColor?.argb));

// re-merge new range then write buffer again and count merges
ws2.mergeCells('A2:B2');
const buf2 = await wb2.xlsx.writeBuffer();
const wb3 = new ExcelJS.Workbook();
await wb3.xlsx.load(buf2);
console.log('reloaded merges:', JSON.stringify(wb3.getWorksheet('May 2026').model.merges));
console.log('reloaded A2 fill (merge keeps anchor style):', JSON.stringify(wb3.getWorksheet('May 2026').getCell('A2').fill?.fgColor?.argb));
console.log('OK');
