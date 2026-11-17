// Integration test: a "real Excel" upload (white fills + explicit black font +
// thin black borders + a coloured highlight) goes through the app's import
// converter, and we check exactly what the dark-mode renderer would decide
// for every cell — using the SAME helper code that ships in the patched
// @fortune-sheet/core bundle.
//
// run: node scripts/test-uploaded-xlsx-dark.mjs
import { Workbook } from 'exceljs';
import { readFileSync, writeFileSync } from 'node:fs';

// ---- 1. build a workbook the way real Excel files look --------------------
const wb = new Workbook();
const ws = wb.addWorksheet('November 2026');
ws.getCell('A1').value = 'MARINA TOWER — NOVEMBER TIMESHEET';
ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF000000' } };
ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
ws.getCell('A3').value = 'Day';
ws.getCell('B3').value = 'Worker';
ws.getCell('C3').value = 'Hours';
for (const c of ['A3', 'B3', 'C3']) {
  ws.getCell(c).font = { bold: true, color: { argb: 'FF000000' } };
  ws.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; // Excel "White, Background 1, Darker 5%"
  ws.getCell(c).border = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'thin', color: { argb: 'FF000000' } },
    bottom: { style: 'thin', color: { argb: 'FF000000' } },
    right: { style: 'thin', color: { argb: 'FF000000' } },
  };
}
const rows = [['Mon', 'Ravi Kumar', 10], ['Tue', 'Anita Shah', 9.5], ['Wed', 'John Doe', 8]];
rows.forEach((r, i) => {
  const rn = 4 + i;
  r.forEach((v, j) => {
    const cell = ws.getCell(rn, j + 1);
    cell.value = v;
    cell.font = { color: { argb: 'FF000000' } }; // explicit black, like Excel writes
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }; // explicit white fill
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
    };
  });
});
// a deliberate coloured highlight must survive dark mode untouched
ws.getCell('C4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // yellow
ws.getCell('C4').font = { color: { argb: 'FF000000' } }; // black text on the yellow chip stays black

const buf = await wb.xlsx.writeBuffer();
writeFileSync('/tmp/uploaded-style.xlsx', Buffer.from(buf));

// ---- 2. run the app's import converter on it ------------------------------
const { parseToFortuneDoc } = await import('../src/lib/files/fortune-xlsx.ts');
const doc = await parseToFortuneDoc(await new Response(buf).arrayBuffer());
if (!doc) { console.error('FAIL: converter returned null'); process.exit(1); }
const sheet = doc.sheets[0];
const cells = sheet.celldata ?? [];

// ---- 3. the dark-mode decision helpers, verbatim from the patched bundle --
const core = readFileSync('node_modules/@fortune-sheet/core/dist/index.js', 'utf8');
function extractFn(name) {
  const start = core.indexOf(`function ${name}(`);
  let depth = 0;
  const open = core.indexOf('{', start);
  let i = open;
  for (; i < core.length; i++) {
    if (core[i] === '{') depth++;
    else if (core[i] === '}') { depth--; if (depth === 0) break; }
  }
  return core.slice(start, i + 1);
}
globalThis.document = { documentElement: { classList: { contains: (c) => c === 'dark' } } };
const dark = new Function(
  extractFn('__pulseFortuneDark') + extractFn('__pulseFortuneTheme') + extractFn('__pulseFortuneRgb') +
  extractFn('__pulseFortuneIsGrey') + extractFn('__pulseFortunePaperFill') + extractFn('__pulseFortuneDarkInk') +
  extractFn('__pulseFortuneBorderInk') +
  'return { dark: __pulseFortuneDark, paper: __pulseFortunePaperFill, ink: __pulseFortuneDarkInk, border: __pulseFortuneBorderInk };',
)();

// what the canvas does per cell:
//   fillStyle = cell.bg; if (!fillStyle || paper(fillStyle)) -> dark paper, else fillStyle
//   text      = fc ?? default ink; if ink(text) && (no bg || paper(bg)) -> light ink
let fails = 0;
function check(label, cond) {
  if (!cond) { fails++; console.log('FAIL', label); } else console.log('ok  ', label);
}

const get = (r, c) => cells.find((x) => x.r === r && x.c === c)?.v ?? {};

// A1: bold header, white fill, explicit black font (import drops pure black fc)
const a1 = get(0, 0);
check('A1 imported with white bg', /^#f+$/i.test(a1.bg ?? '') && (a1.bg ?? '').length === 7);
check('A1 black font dropped at import (so default ink applies)', a1.fc == null);
check('A1 white bg renders as DARK PAPER', dark.paper(a1.bg));
check('A1 default ink is LIGHT in dark mode', dark.dark());

// A3 header: light-grey fill (F2F2F2) + black borders
const a3 = get(2, 0);
check('A3 grey header fill renders as dark paper', dark.paper(a3.bg));
const bi = (sheet.config?.borderInfo ?? []);
check('imported borders exist in config', bi.length > 0);
const blackBorders = bi.filter((b) => {
  const sides = ['l', 'r', 't', 'b'];
  return sides.some((s) => b.value?.[s]?.color && dark.border(b.value[s].color) === '#f2f2f7');
});
check('black imported borders render WHITE in dark mode', blackBorders.length === bi.length && bi.length > 0);

// C4: yellow highlight with black text keeps its colour & text colour
const c4 = get(3, 2);
check('C4 yellow fill survives dark mode (chosen colour wins)', (c4.bg ?? '').toLowerCase() === '#ffff00' && !dark.paper(c4.bg));

// every data cell: explicit black fc would be black-on-dark — but import drops it
const dataFcs = [get(3, 0).fc, get(3, 1).fc, get(4, 0).fc];
check('data-row black fonts dropped at import', dataFcs.every((f) => f == null));

// a hypothetical explicit near-black fc on paper would flip to light ink
check('explicit #333333 fc on paper flips to light ink', dark.ink('#333333'));

console.log(fails === 0 ? '\nUPLOADED-XLSX DARK MODE TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
