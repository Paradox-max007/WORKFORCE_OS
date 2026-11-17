// ============================================================================
// PULSE Workforce OS — FortuneSheet ⇄ XLSX converter round-trip tests
// ----------------------------------------------------------------------------
// Run: bun scripts/test-fortune-roundtrip.ts
//
// Covers the PRD acceptance list: values, formulas (with cached results),
// fonts/colours/borders/merges, column widths & row heights, hidden rows and
// columns, frozen panes, number formats, multiple sheets, plus defensive
// cases (empty / garbage input — the "Cannot read properties of undefined"
// class of bugs must never come back).
// ============================================================================

import assert from 'node:assert';
import ExcelJS from 'exceljs';
import {
  parseToFortuneDoc,
  fortuneToXlsxBytes,
  fortuneFirstSheetCsv,
} from '../src/lib/files/fortune-xlsx';
import type { Sheet as FSheet } from '@fortune-sheet/core';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.error(`  FAIL  ${label}`); }
}

// ---------------------------------------------------------------------------
// 1) build a workbook exercising every converter feature
// ---------------------------------------------------------------------------
async function buildSampleWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Timesheet', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
    properties: { defaultRowHeight: 15 },
  });

  // header (merged A1:B1, styled)
  ws.mergeCells('A1:B1');
  const a1 = ws.getCell('A1');
  a1.value = 'SITE TIMESHEET';
  a1.style = {
    font: { bold: true, italic: true, underline: 'single', strike: true, size: 14, name: 'Arial', color: { argb: 'FFFF0000' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: {
      top: { style: 'double', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF123456' } },
      bottom: { style: 'medium', color: { argb: 'FF654321' } },
      right: { style: 'dashed', color: { argb: 'FF00FF00' } },
    },
  };

  // days + hours + formulas
  ws.getCell('A3').value = 'Day 1';
  ws.getCell('B3').value = 8;
  ws.getCell('A4').value = 'Day 2';
  ws.getCell('B4').value = 7.5;
  ws.getCell('A5').value = 'Day 3';
  ws.getCell('B5').value = 9;
  ws.getCell('A6').value = 'Total';
  ws.getCell('B6').value = { formula: 'SUM(B3:B5)', result: 24.5 };
  ws.getCell('A7').value = 'Average';
  ws.getCell('B7').value = { formula: 'AVERAGE(B3:B5)', result: 8.166666666666666 };
  ws.getCell('C3').value = { formula: 'IF(B3>7.75,"OT","OK")', result: 'OK' };
  ws.getCell('C6').value = { formula: 'IF(SUM(B3:B5)>24,"Over","Under")', result: 'Over' };

  // number formats
  ws.getCell('D2').value = 1234.5;
  ws.getCell('D2').numFmt = '#,##0.00';
  ws.getCell('D3').value = 0.42;
  ws.getCell('D3').numFmt = '0.00%';
  const d4 = ws.getCell('D4');
  d4.value = new Date(2026, 10, 5);
  d4.numFmt = 'yyyy-mm-dd';

  // hidden row + column
  ws.getRow(9).values = ['hidden row'];
  ws.getRow(9).hidden = true;
  ws.getColumn('E').width = 5;
  ws.getColumn('E').hidden = true;

  // explicit sizes
  ws.getColumn('A').width = 22.5;
  ws.getColumn('B').width = 11;
  ws.getRow(1).height = 30;
  ws.getRow(3).height = 18;

  // second sheet — cross-sheet reference + absolute refs
  const ws2 = wb.addWorksheet('Summary');
  ws2.getCell('A1').value = { formula: 'Timesheet!B6*2', result: 49 };
  ws2.getCell('A2').value = { formula: 'SUM($B$1:$B$3)', result: 0 };
  ws2.getCell('B1').value = 'plain text';

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// 2) parse → verify the FortuneSheet model
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n== parse: xlsx → FortuneSheet ==');
  const bytes = await buildSampleWorkbook();
  const parsed = await parseToFortuneDoc(bytes.buffer as ArrayBuffer);
  assert(parsed, 'parse must succeed');
  const base = parsed!.base;
  const sheets = parsed!.sheets;
  ok(sheets.length === 2, `two sheets parsed (${sheets.length})`);
  const ts = sheets[0];

  const cellAt = (s: FSheet, r: number, c: number) =>
    (s.celldata ?? []).find((cd) => cd.r === r && cd.c === c)?.v;

  ok(ts.name === 'Timesheet', 'sheet name');
  ok(ts.config?.merge?.['0_0'] != null, 'merge A1:B1 in config');
  const a1 = cellAt(ts, 0, 0) as Record<string, unknown>;
  ok(a1?.mc != null && (a1.mc as { rs?: number }).rs === 1, 'anchor mc present');
  const b1 = cellAt(ts, 0, 1) as Record<string, unknown>;
  ok(b1?.mc != null && (b1.mc as { rs?: number }).rs == null, 'covered cell mc without rs');
  ok(a1?.bl === 1 && a1?.it === 1 && a1?.un === 1 && a1?.cl === 1, 'bold/italic/underline/strike imported');
  ok(a1?.fc === '#FF0000', 'font colour imported');
  ok(a1?.bg === '#FFF2CC', 'fill colour imported');
  ok(a1?.ht === 0 && a1?.vt === 0 && a1?.tb === 'wrap', 'alignment + wrap imported');
  ok(a1?.ff === 'Arial' && a1?.fs === 14, 'font family + size imported');

  const borders = (ts.config as { borderInfo?: { value?: Record<string, { style: unknown; color: string }> }[] }).borderInfo ?? [];
  const a1Border = borders.find((b) => b.value?.t && (b as { value?: { row_index?: number } }).value?.row_index === 0);
  ok(!!a1Border, 'A1 border info present');
  const bv = a1Border?.value ?? {};
  ok(bv.t?.style === 7, `double border → code 7 (got ${bv.t?.style})`);
  ok(bv.l?.style === 1, `thin border → code 1 (got ${bv.l?.style})`);
  ok(bv.b?.style === 8, `medium border → code 8 (got ${bv.b?.style})`);
  ok(bv.r?.style === 4, `dashed border → code 4 (got ${bv.r?.style})`);
  ok(bv.l?.color === '#123456', 'border colour imported');

  const b6 = cellAt(ts, 5, 1) as Record<string, unknown>;
  ok(b6?.f === '=SUM(B3:B5)', `formula with '=' (got ${b6?.f})`);
  ok(b6?.v === 24.5, 'cached formula result imported');
  const c3 = cellAt(ts, 2, 2) as Record<string, unknown>;
  ok(c3?.f === '=IF(B3>7.75,"OT","OK")', 'IF formula imported');

  const d2 = cellAt(ts, 1, 3) as Record<string, { fa?: string }>;
  ok(d2?.ct?.fa === '#,##0.00', 'number format imported');
  const d3 = cellAt(ts, 2, 3) as Record<string, { fa?: string }>;
  ok(d3?.ct?.fa === '0.00%', 'percent format imported');
  const d4 = cellAt(ts, 3, 3) as Record<string, unknown>;
  ok((d4?.ct as { t?: string } | undefined)?.t === 'd', 'date cell typed as date');

  ok(ts.config?.columnlen?.['0'] === Math.round(22.5 * 7 + 5), 'column width chars→px');
  ok(ts.config?.rowlen?.['0'] === 40, 'row height pt→px (30pt → 40px)');
  ok(ts.config?.colhidden?.['4'] === 0, 'hidden column imported');
  ok(ts.config?.rowhidden?.['8'] === 0, 'hidden row imported');
  ok(ts.frozen?.type === 'both' && ts.frozen?.range?.row_focus === 1 && ts.frozen?.range?.column_focus === 0, `frozen panes imported (${JSON.stringify(ts.frozen)})`);

  const summary = sheets[1];
  const sA1 = cellAt(summary, 0, 0) as Record<string, unknown>;
  ok(sA1?.f === '=Timesheet!B6*2', 'cross-sheet formula imported');

  // ---------------------------------------------------------------------------
  // 3) simulate user edits (celldata form), then export and re-load
  // ---------------------------------------------------------------------------
  console.log('\n== export: FortuneSheet → xlsx (with simulated edits) ==');
  const total = cellAt(ts, 5, 1);
  if (total) total.v = 26; // cached result changed by recalc
  (ts.celldata ?? []).push({ r: 9, c: 0, v: { v: 'added by editor', bg: '#00FF00', bl: 1 } });
  (ts.celldata ?? []).push({ r: 10, c: 1, v: { f: '=B3+B4+B5', v: 24.5 } });
  // a toolbar-style "all borders" range entry
  (ts.config as { borderInfo?: unknown[] }).borderInfo = [
    ...((ts.config as { borderInfo?: unknown[] }).borderInfo ?? []),
    { rangeType: 'range', borderType: 'border-all', color: '#3366FF', style: '1', range: [{ row: [12, 13], column: [0, 1] }] },
  ];
  // a zoom level set from the bottom-right control
  ts.zoomRatio = 1.3;

  const outBytes = await fortuneToXlsxBytes(sheets, base);
  ok(outBytes.length > 4000, `output xlsx written (${outBytes.length} bytes)`);

  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(outBytes.buffer as ArrayBuffer);
  const ws2 = wb2.worksheets.find((w) => w.name === 'Timesheet');
  assert(ws2, 'Timesheet sheet survived');
  const nA1 = ws2.getCell('A1');
  ok(nA1.value === 'SITE TIMESHEET', 'value round-trip');
  ok(nA1.font?.bold === true && nA1.font?.italic === true, 'font bold/italic round-trip');
  ok(!!nA1.font?.underline && nA1.font?.strike === true, 'underline/strike round-trip');
  ok((nA1.font?.color as { argb?: string })?.argb === 'FFFF0000', 'font colour round-trip');
  ok((nA1.fill as unknown as { fgColor?: { argb?: string } })?.fgColor?.argb === 'FFFFF2CC', 'fill round-trip');
  ok(nA1.alignment?.horizontal === 'center' && nA1.alignment?.vertical === 'middle' && nA1.alignment?.wrapText === true, 'alignment + wrap round-trip');
  ok(nA1.border?.top?.style === 'double', 'double border round-trip');
  ok(nA1.border?.left?.style === 'thin', 'thin border round-trip');
  ok(nA1.border?.bottom?.style === 'medium', 'medium border round-trip');
  ok(nA1.border?.right?.style === 'dashed', 'dashed border round-trip');
  ok((nA1.border?.left?.color as { argb?: string })?.argb === 'FF123456', 'border colour round-trip');
  ok(ws2.model.merges?.includes('A1:B1'), `merge round-trip (${ws2.model.merges})`);

  const nB6 = ws2.getCell('B6').value as { formula?: string; result?: unknown };
  ok(nB6?.formula === 'SUM(B3:B5)', 'formula exported');
  ok(nB6?.result === 26, 'fresh cached result exported');

  const nA10 = ws2.getCell('A10').value as string;
  ok(nA10 === 'added by editor', 'added cell exported');
  const nA10s = ws2.getCell('A10');
  ok((nA10s.fill as unknown as { fgColor?: { argb?: string } })?.fgColor?.argb === 'FF00FF00', 'added cell fill exported');
  ok(nA10s.font?.bold === true, 'added cell bold exported');

  const nB11 = ws2.getCell('B11').value as { formula?: string };
  ok(nB11?.formula === 'B3+B4+B5', 'editor formula exported');

  const nB7 = ws2.getCell('B7').value as { formula?: string };
  ok(nB7?.formula === 'AVERAGE(B3:B5)', 'second formula exported');

  ok(ws2.getCell('D2').numFmt === '#,##0.00', 'number format round-trip');
  ok(ws2.getCell('D3').numFmt === '0.00%', 'percent format round-trip');
  const nD4 = ws2.getCell('D4');
  ok(nD4.value instanceof Date && nD4.numFmt === 'yyyy-mm-dd', `date cell round-trip (${typeof nD4.value} / ${nD4.numFmt})`);

  const rBorder = ws2.getCell('A13').border as Record<string, { style?: string; color?: { argb?: string } }>;
  ok(rBorder?.top?.style === 'thin' && rBorder?.top?.color?.argb === 'FF3366FF', 'toolbar range border (border-all) exported');
  const rBorder2 = ws2.getCell('B14').border as Record<string, { style?: string }>;
  ok(rBorder2?.bottom?.style === 'thin' && rBorder2?.right?.style === 'thin', 'range border covers all cells');

  ok(Math.abs((ws2.getColumn('A').width ?? 0) - 22.5) < 0.15, `column width round-trip (${ws2.getColumn('A').width})`);
  ok(Math.abs((ws2.getRow(1).height ?? 0) - 30) < 0.6, `row height round-trip (${ws2.getRow(1).height})`);
  ok(ws2.getColumn('E').hidden === true, 'hidden column round-trip');
  ok(ws2.getRow(9).hidden === true, 'hidden row round-trip');
  const view = ws2.views[0] as { state?: string; xSplit?: number; ySplit?: number; zoomScale?: number };
  ok(view?.state === 'frozen' && view?.xSplit === 1 && view?.ySplit === 2, `frozen panes round-trip (${JSON.stringify(ws2.views)})`);
  ok(view?.zoomScale === 130, `zoom round-trip (${view?.zoomScale}%)`);

  // re-parse the exported file: zoom must come back as zoomRatio
  {
    const again = await parseToFortuneDoc(outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer);
    const tsAgain = again?.sheets.find((s) => s.name === 'Timesheet');
    ok(tsAgain?.zoomRatio === 1.3, `zoom re-imported as zoomRatio (${tsAgain?.zoomRatio})`);
    ok(!!tsAgain?.frozen && tsAgain.frozen.type === 'both', 'frozen panes re-imported');
  }

  const wsS = wb2.worksheets.find((w) => w.name === 'Summary');
  const sA1v = wsS?.getCell('A1').value as { formula?: string };
  ok(sA1v?.formula === 'Timesheet!B6*2', 'cross-sheet formula round-trip');
  // fullCalcOnLoad is written into workbook.xml (ExcelJS does not re-expose it on load)
  {
    const { execSync } = await import('node:child_process');
    const fsmod = await import('node:fs');
    const osmod = await import('node:os');
    const tmp = `${osmod.tmpdir()}/pulse-calcpr-${Date.now()}.xlsx`;
    fsmod.writeFileSync(tmp, outBytes);
    let xml = '';
    try {
      xml = execSync(`unzip -p "${tmp}" xl/workbook.xml`).toString();
    } catch { /* unzip missing — skip gracefully */ }
    fsmod.rmSync(tmp, { force: true });
    ok(xml.includes('fullCalcOnLoad="1"'), 'fullCalcOnLoad set for Excel recalc');
  }

  // ---------------------------------------------------------------------------
  // 4) csv export of the first sheet
  // ---------------------------------------------------------------------------
  console.log('\n== csv export ==');
  const csv = await fortuneFirstSheetCsv(sheets);
  ok(csv.includes('Day 1') && csv.includes('SITE TIMESHEET'), 'csv contains values');
  ok(csv.split('\n').length >= 10, 'csv has rows');

  // ---------------------------------------------------------------------------
  // 5) defensive cases — garbage must never throw (the "reading '2'" class)
  // ---------------------------------------------------------------------------
  console.log('\n== defensive: garbage & edge inputs ==');
  const garbage = await parseToFortuneDoc(new TextEncoder().encode('this is not a spreadsheet at all').buffer as ArrayBuffer);
  ok(garbage === null, 'garbage text → null (no throw)');
  const empty = await parseToFortuneDoc(new ArrayBuffer(0));
  ok(empty === null, 'empty bytes → null (no throw)');

  const wbTiny = new ExcelJS.Workbook();
  const wsTiny = wbTiny.addWorksheet('Sheet1');
  wsTiny.getCell('A1').value = 1;
  const tinyBytes = new Uint8Array(await wbTiny.xlsx.writeBuffer() as ArrayBuffer);
  const tinyParsed = await parseToFortuneDoc(tinyBytes.buffer as ArrayBuffer);
  ok(tinyParsed !== null && tinyParsed!.sheets.length === 1, 'single-cell workbook parses');
  const tinyOut = await fortuneToXlsxBytes(tinyParsed!.sheets, tinyParsed!.base);
  const wbTiny2 = new ExcelJS.Workbook();
  await wbTiny2.xlsx.load(tinyOut.buffer as ArrayBuffer);
  ok(wbTiny2.worksheets[0].getCell('A1').value === 1, 'single-cell round-trip');

  // empty worksheet (no cells at all)
  const wbEmpty = new ExcelJS.Workbook();
  wbEmpty.addWorksheet('Empty');
  const emptyBytes = new Uint8Array(await wbEmpty.xlsx.writeBuffer() as ArrayBuffer);
  const emptyParsed = await parseToFortuneDoc(emptyBytes.buffer as ArrayBuffer);
  ok(emptyParsed !== null && emptyParsed!.sheets[0].celldata?.length === 0, 'empty worksheet parses with no celldata');
  const emptyOut = await fortuneToXlsxBytes(emptyParsed!.sheets, emptyParsed!.base);
  ok(emptyOut.length > 3000, 'empty worksheet exports a valid xlsx');

  // legacy CSV parse path
  const csvBytes = new TextEncoder().encode('a,b,c\n1,2,3\n4,5,6');
  const csvParsed = await parseToFortuneDoc(csvBytes.buffer as ArrayBuffer);
  ok(csvParsed !== null && csvParsed!.sheets[0].celldata !== undefined, 'csv parses via legacy path');
  const csvCell = csvParsed!.sheets[0].celldata?.find((cd) => cd.r === 1 && cd.c === 0)?.v as Record<string, unknown>;
  ok(csvCell?.v === '1' || csvCell?.v === 1, `csv value parsed (${csvCell?.v})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error('TEST RUNNER ERROR:', e);
  process.exit(1);
});
