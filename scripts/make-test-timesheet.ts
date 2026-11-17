// generates a realistic sample timesheet xlsx for browser testing
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('November 2026', {
  views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }],
});

// title row (merged)
ws.mergeCells('A1:H1');
const t = ws.getCell('A1');
t.value = 'RED COAST COMPOUND — TIMESHEET NOVEMBER 2026';
t.style = {
  font: { bold: true, size: 14, name: 'Arial', color: { argb: 'FF1F3864' } },
  alignment: { horizontal: 'center', vertical: 'middle' },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
};

// header row
const headers = ['#', 'Employee', 'Trade', 1, 2, 3, 'Total Hrs', 'Rate'];
ws.getRow(3).values = headers;
ws.getRow(3).eachCell((cell) => {
  cell.style = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } },
    },
  };
});

const employees = [
  ['Ahmed Hassan', 'Mason', 9, 9, 8],
  ['Ravi Kumar', 'Electrician', 8, 9, 9],
  ['John Mwangi', 'Plumber', 10, 8, 9],
  ['Samir Ali', 'Carpenter', 9, 10, 8],
];

employees.forEach((emp, i) => {
  const r = 4 + i;
  ws.getRow(r).values = [i + 1, emp[0], emp[1], emp[2], emp[3], emp[4]];
  const totalCell = ws.getCell(`G${r}`);
  totalCell.value = { formula: `SUM(D${r}:F${r})`, result: (emp[2] as number) + (emp[3] as number) + (emp[4] as number) };
  const rateCell = ws.getCell(`H${r}`);
  rateCell.value = 25;
  rateCell.numFmt = '"$"#,##0.00';
  ws.getRow(r).eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF808080' } },
      left: { style: 'thin', color: { argb: 'FF808080' } },
      bottom: { style: 'thin', color: { argb: 'FF808080' } },
      right: { style: 'thin', color: { argb: 'FF808080' } },
    };
  });
});

// grand total row
ws.getRow(8).values = ['', 'TOTAL', '', '', '', ''];
ws.getCell('G8').value = { formula: 'SUM(G4:G7)', result: 106 };
ws.getCell('A8').font = { bold: true };
ws.getCell('G8').font = { bold: true };
ws.getCell('G8').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };

// sizes
ws.getColumn(1).width = 5;
ws.getColumn(2).width = 22;
ws.getColumn(3).width = 14;
ws.columns.forEach((col, i) => { if (i > 2) col.width = 9; });
ws.getRow(1).height = 28;
ws.getRow(3).height = 20;

const buf = await wb.xlsx.writeBuffer();
writeFileSync('/tmp/test-timesheet.xlsx', new Uint8Array(buf as ArrayBuffer));
console.log('written', buf.byteLength, 'bytes');
