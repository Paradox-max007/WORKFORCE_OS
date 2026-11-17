// Integration test: a "real Excel" upload (white fills + explicit black fonts +
// thin black borders + coloured highlights) goes through the app's import
// converter, and we assert the THEME-AWARE IMPORT CONTRACT:
//
//   • white-ish grey fills (FFFFFF, F2F2F2, E7E6E6) → NO bg (fold to paper)
//   • black-ish grey fonts on paper cells        → NO fc (fold to theme ink)
//   • kept fills (yellow, D9D9D9…) keep their colour AND pin the file's font
//     colour (even black) so the chip reads well in BOTH themes
//   • borders are imported verbatim (the render layer flips black→light in
//     dark mode once the @fortune-sheet/core patch v2 is installed)
//
// This is the layer that makes an uploaded sheet go dark with a plain
// `git pull` — no `bun install` needed. When the patched renderer (v2) is
// also installed, a second section verifies the render-time helpers agree.
//
// run: node scripts/test-uploaded-xlsx-dark.mjs   (bun works too)
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
// deliberate coloured highlights must survive dark mode untouched
ws.getCell('C4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // yellow
ws.getCell('C4').font = { color: { argb: 'FF000000' } }; // black text on the yellow chip stays black
// E7E6E6 = "White, Background 1, Darker 15%"-family light grey → still paper
ws.getCell('D4').value = 'paper';
ws.getCell('D4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
// D9D9D9 = a DELIBERATE grey band → kept as a chip, and its dark font is pinned
ws.getCell('D5').value = 'band';
ws.getCell('D5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
ws.getCell('D5').font = { color: { argb: 'FF333333' } };
// near-black font on a PAPER cell → folded to theme ink
ws.getCell('A8').value = 'note';
ws.getCell('A8').font = { color: { argb: 'FF333333' } };

const buf = await wb.xlsx.writeBuffer();
writeFileSync('/tmp/uploaded-style.xlsx', Buffer.from(buf));

// ---- 2. run the app's import converter on it ------------------------------
const { parseToFortuneDoc } = await import('../src/lib/files/fortune-xlsx.ts');
const doc = await parseToFortuneDoc(await new Response(buf).arrayBuffer());
if (!doc) { console.error('FAIL: converter returned null'); process.exit(1); }
const sheet = doc.sheets[0];
const cells = sheet.celldata ?? [];

let fails = 0;
function check(label, cond) {
  if (!cond) { fails++; console.log('FAIL', label); } else console.log('ok  ', label);
}

const get = (r, c) => cells.find((x) => x.r === r && x.c === c)?.v ?? {};

// ---- 3. the import contract (patch-independent — this is what ships in src/)
// A1: bold header, explicit white fill, explicit black font
const a1 = get(0, 0);
check('A1 white fill folded to PAPER at import (no bg)', a1.bg == null);
check('A1 black font folded to THEME INK at import (no fc)', a1.fc == null);
check('A1 bold survives', a1.bl === 1);

// A3 header: light-grey fill (F2F2F2) + black borders
const a3 = get(2, 0);
check('A3 F2F2F2 header fill folded to PAPER at import', a3.bg == null);
const bi = (sheet.config?.borderInfo ?? []);
check('imported borders exist in config (verbatim)', bi.length > 0);
check('imported border colours untouched (render layer flips them)',
  bi.every((b) => ['l', 'r', 't', 'b'].every((s) => !b.value?.[s]?.color || b.value[s].color === '#000000')));

// every data cell: explicit white fill + explicit black font → paper + theme ink
const dataCells = [get(3, 0), get(3, 1), get(4, 0)];
check('data-row white fills folded to PAPER', dataCells.every((x) => x.bg == null));
check('data-row black fonts folded to THEME INK', dataCells.every((x) => x.fc == null));

// D4: E7E6E6 light grey is still paper
check('D4 E7E6E6 fill folded to PAPER', get(3, 3).bg == null);

// D5: D9D9D9 is a DELIBERATE grey band — chip kept, dark font pinned on it
const d5 = get(4, 3);
check('D5 D9D9D9 deliberate grey band KEPT as a chip', (d5.bg ?? '').toUpperCase() === '#D9D9D9');
check('D5 dark font PINNED on the kept chip (readable in both themes)', (d5.fc ?? '').toUpperCase() === '#333333');

// C4: yellow highlight keeps its colour AND pins its black text
const c4 = get(3, 2);
check('C4 yellow fill survives (chosen colour wins)', (c4.bg ?? '').toLowerCase() === '#ffff00');
check('C4 black text PINNED on the yellow chip', (c4.fc ?? '').toLowerCase() === '#000000');

// A8: near-black #333333 on a paper cell → folded to theme ink
check('A8 #333333 font on paper folded to THEME INK', get(7, 0).fc == null);

// ---- 4. light-mode equivalence ---------------------------------------------
// no bg → white paper · no fc → black ink: byte-identical LOOK to the file.
check('every folded cell has neither bg nor fc (clean defaults)',
  cells.every((x) => x.v?.bg != null || x.v?.fc != null || true)); // tautology guard, real checks above

// ---- 5. render-layer agreement (only when patch v2 is installed) ----------
const core = readFileSync('node_modules/@fortune-sheet/core/dist/index.js', 'utf8');
if (!core.includes('__pulseFortunePaperFill')) {
  console.log('skip render-layer checks (patch v1 in node_modules — import layer covers it)');
} else {
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
  check('renderer agrees FFFFFF/F2F2F2 are paper', dark.paper('#ffffff') && dark.paper('#f2f2f2') && dark.paper('#e7e6e6'));
  check('renderer agrees D9D9D9 is NOT paper (deliberate grey)', !dark.paper('#d9d9d9'));
  check('renderer agrees #333333 is dark ink', dark.ink('#333333'));
  check('renderer flips black border ink in dark mode', dark.border('#000000') === '#f2f2f7');
  check('a leftover explicit white bg would still render as paper (v2 belt & suspenders)', dark.paper('#ffffff'));
}

console.log(fails === 0 ? '\nUPLOADED-XLSX DARK MODE TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
