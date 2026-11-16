// Round-trip test of the timesheet editor's save pipeline (ExcelJS part).
// Replicates the exact functions from src/components/sites/timesheet-editor.tsx.

const ExcelJS = require('exceljs');

// ---- copied helpers from timesheet-editor.tsx ----
const NAMED_COLORS = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', lime: '00FF00', blue: '0000FF',
  yellow: 'FFFF00', magenta: 'FFC0DB', cyan: '00FFFF', silver: 'C0C0C0', gray: '808080',
  grey: '808080', maroon: '800000', olive: '808000', green: '008000', purple: '800080',
  teal: '008080', navy: '000080', orange: 'FFA500', pink: 'FFC0CB', gold: 'FFD700',
  brown: 'A52A2A', beige: 'F5F5DC', ivory: 'FFFFF0',
};

function cssColorToHex(v) {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'currentcolor') return null;
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/.test(h) ? h.toUpperCase() : null;
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(s);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) < 1) return null;
    const hex = [1, 2, 3].map((i) => Math.min(255, Number(m[i])).toString(16).padStart(2, '0')).join('');
    return hex.toUpperCase();
  }
  return NAMED_COLORS[s] ?? null;
}

function parseCss(css) {
  const out = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function canonicalBorder(v) {
  if (!v || v.includes('none') || v.trim() === '') return null;
  const width = /^(\d+)px/.exec(v)?.[1] ?? '1';
  let style = 'solid';
  if (v.includes('double')) style = 'double';
  else if (v.includes('dotted')) style = 'dotted';
  else if (v.includes('dashed')) style = 'dashed';
  const hex = cssColorToHex((v.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/) ?? [])[1] ?? '') ?? '000000';
  return `${width}px ${style} #${hex}`;
}

function canonicalCss(css) {
  const d = parseCss(css);
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'display') continue;
    if (k === 'background-color' || k === 'color') {
      const hex = cssColorToHex(v);
      if (!hex) continue;
      out[k] = `#${hex}`;
    } else if (k === 'font-weight') {
      out[k] = v === 'normal' || v === '400' ? 'normal' : 'bold';
    } else if (k === 'font-family') {
      const fam = v.replace(/["']/g, '').trim();
      if (fam && fam !== 'inherit' && fam !== 'initial') out[k] = fam;
    } else if (k === 'text-decoration') {
      const set = ['underline', 'line-through'].filter((t) => v.includes(t));
      if (set.length) out[k] = set.join(' ');
    } else if (k === 'border-top' || k === 'border-right' || k === 'border-bottom' || k === 'border-left') {
      const b = canonicalBorder(v);
      if (b) out[k] = b;
    } else {
      if (k === 'text-align' && v === 'left') continue;
      out[k] = v.toLowerCase();
    }
  }
  return Object.keys(out).sort().map((k) => `${k}:${out[k]}`).join(';');
}

const dottedCheck = (v) => v.includes('dotted');
const dashedCheck = (v) => v.includes('dashed');

function cssBorderToExcel(v) {
  if (!v || v.includes('none') || v.trim() === '') return null;
  const color = cssColorToHex((v.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/) ?? [])[1] ?? '') ?? '000000';
  let style = null;
  if (/^3px double/.test(v)) style = 'double';
  else if (dottedCheck(v)) style = 'dotted';
  else if (dashedCheck(v)) style = 'dashed';
  else if (/^2px/.test(v)) style = 'medium';
  else if (/^([3-9]|\d{2})px/.test(v)) style = 'thick';
  else if (/^1px/.test(v)) style = 'thin';
  if (!style) return null;
  return { style, color: { argb: `FF${color}` } };
}

function cssToExcelStyle(css, numFmt) {
  const d = parseCss(css);
  const style = {};
  if (numFmt) style.numFmt = numFmt;
  const bg = cssColorToHex(d['background-color']);
  if (bg) style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${bg}` } };
  const border = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const b = cssBorderToExcel(d[`border-${side}`]);
    if (b) border[side] = b;
  }
  if (Object.keys(border).length) style.border = border;
  return style;
}

// ---- TEST ----
(async () => {
  // 1) create a workbook like a freshly uploaded timesheet
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getCell('A1').value = 'Name';
  ws.getCell('B1').value = 'Hours';
  ws.getCell('A2').value = 'John';
  ws.getCell('B2').value = 8;
  const origBuf = await wb.xlsx.writeBuffer();
  console.log('STEP1: original workbook written,', origBuf.byteLength, 'bytes');

  // 2) reload (like parseDoc does)
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(origBuf);
  const ws2 = wb2.worksheets[0];

  // 3) simulate what the browser/jSS gives captureSnapshot after the user
  //    applies "All borders" via the toolbar:
  //    td.style.borderTop = '1px solid #000000' → getAttribute('style') →
  //    "border-top: 1px solid rgb(0, 0, 0); ..." → canonicalCss
  const browserStyleAttr = 'border-top: 1px solid rgb(0, 0, 0); border-right: 1px solid rgb(0, 0, 0); border-bottom: 1px solid rgb(0, 0, 0); border-left: 1px solid rgb(0, 0, 0);';
  const captured = canonicalCss(browserStyleAttr);
  console.log('STEP2: captured canonical css =', JSON.stringify(captured));

  // 4) patchSheet step 3: cell.style = cssToExcelStyle(captured)
  const cell = ws2.getCell('B2');
  cell.style = cssToExcelStyle(captured, undefined);
  console.log('STEP3: cell.style assigned =', JSON.stringify(cell.style));

  // 5) write + reload + check
  const outBuf = await wb2.xlsx.writeBuffer();
  console.log('STEP4: saved workbook,', outBuf.byteLength, 'bytes');

  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(outBuf);
  const ws3 = wb3.worksheets[0];
  const check = ws3.getCell('B2').style;
  console.log('STEP5: B2 style after round-trip =', JSON.stringify(check, null, 1));
  console.log('RESULT:', check && check.border ? 'BORDERS SAVED OK' : 'BORDERS LOST!');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
