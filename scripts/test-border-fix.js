// Verify the FIXED border pipeline with the real CSSOM serialization forms
// captured from a live browser (see scripts/jss-border-test.html).

const ExcelJS = require('exceljs');

// ---- helpers copied from the EDITED timesheet-editor.tsx ----
const NAMED_COLORS = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', lime: '00FF00', blue: '0000FF',
  yellow: 'FFFF00', cyan: '00FFFF', silver: 'C0C0C0', gray: '808080', grey: '808080',
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
    return [1, 2, 3].map((i) => Math.min(255, Number(m[i])).toString(16).padStart(2, '0')).join('').toUpperCase();
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
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
function splitTopLevel(v) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of v.trim()) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
function expandCssBox(v) {
  const p = splitTopLevel(v);
  if (p.length <= 1) return [p[0] ?? '', p[0] ?? '', p[0] ?? '', p[0] ?? ''];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];
  return [p[0], p[1], p[2], p[3]];
}
function normalizeBorderWidth(w) {
  const t = (w ?? '').trim().toLowerCase();
  if (t === 'thin') return '1px';
  if (t === 'medium') return '2px';
  if (t === 'thick') return '3px';
  if (/^0(?:[a-z]+)?$/.test(t)) return '0px';
  const m = /^([\d.]+)px$/.exec(t);
  return m ? `${m[1]}px` : t;
}
function splitBorderShorthand(v) {
  let width = '', style = '', color = '';
  for (const t of v.trim().split(/\s+/)) {
    if (!width && /^([\d.]+px|thin|medium|thick)$/i.test(t)) width = t;
    else if (!style && /^(solid|dotted|dashed|double|none|hidden|groove|ridge|inset|outset)$/i.test(t)) style = t.toLowerCase();
    else color = color ? `${color} ${t}` : t;
  }
  return { width, style, color };
}
function resolveBorderSides(d) {
  const boxW = d['border-width'] ? expandCssBox(d['border-width']) : null;
  const boxS = d['border-style'] ? expandCssBox(d['border-style']) : null;
  const boxC = d['border-color'] ? expandCssBox(d['border-color']) : null;
  const full = d['border'] ? splitBorderShorthand(d['border']) : null;
  const out = {};
  BORDER_SIDES.forEach((side, i) => {
    const sh = d[`border-${side}`] ? splitBorderShorthand(d[`border-${side}`]) : null;
    const width = normalizeBorderWidth(d[`border-${side}-width`] ?? sh?.width ?? boxW?.[i] ?? full?.width);
    const style = (d[`border-${side}-style`] ?? sh?.style ?? boxS?.[i] ?? full?.style ?? '').toLowerCase();
    const color = d[`border-${side}-color`] ?? sh?.color ?? boxC?.[i] ?? full?.color ?? '';
    if (!style || style === 'none' || style === 'hidden') return;
    if (!width || width === '0px') return;
    const hex = cssColorToHex(color) ?? '000000';
    out[side] = `${width} ${style} #${hex}`;
  });
  return out;
}
function canonicalCss(css) {
  const d = parseCss(css);
  const out = {};
  const borders = resolveBorderSides(d);
  for (const side of BORDER_SIDES) {
    const b = borders[side];
    if (b) out[`border-${side}`] = b;
  }
  for (const [k, v] of Object.entries(d)) {
    if (k === 'display') continue;
    if (k.startsWith('border')) continue;
    if (k === 'background-color' || k === 'color') {
      const hex = cssColorToHex(v);
      if (!hex) continue;
      out[k] = `#${hex}`;
    } else if (k === 'font-weight') {
      out[k] = v === 'normal' || v === '400' ? 'normal' : 'bold';
    } else if (k === 'text-align' && v === 'left') {
      continue;
    } else {
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
  const w = normalizeBorderWidth(/^([^\s]+)/.exec(v)?.[1]);
  let style = null;
  if (/^3px double/.test(v)) style = 'double';
  else if (dottedCheck(v)) style = 'dotted';
  else if (dashedCheck(v)) style = 'dashed';
  else if (w === '2px') style = 'medium';
  else if (/^([3-9]|\d{2})px$/.test(w)) style = 'thick';
  else if (w === '1px') style = 'thin';
  else if (w === '0px') return null;
  if (!style) return null;
  return { style, color: { argb: `FF${color}` } };
}
function cssToExcelStyle(css) {
  const d = parseCss(css);
  const style = {};
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

// ---- REAL CSSOM forms captured from Chrome ----
const CASES = {
  // "All borders" preset → collapsed box shorthands
  allBorders: 'text-align: left; border-width: 1px; border-style: solid; border-color: rgb(0, 0, 0);',
  // "No borders" after previously having borders
  noBorders: 'text-align: left; border-width: medium; border-style: none; border-color: currentcolor;',
  // "Outer borders" corner cell (top + left only) → separate longhands
  outerCorner: 'text-align: left; border-top: 1px solid rgb(0, 0, 0); border-left: 1px solid rgb(0, 0, 0);',
  // mixed widths after re-styling one side
  mixedWidth: 'text-align: left; border-width: 2px 1px 1px; border-style: solid; border-color: rgb(0, 0, 0);',
  // dotted, red
  dotted: 'text-align: left; border-width: 1px; border-style: dotted; border-color: rgb(255, 0, 0);',
  // header styling: fill + bold + borders
  headerStyle: 'text-align: left; background-color: rgb(255, 255, 0); font-weight: bold; border-width: 1px; border-style: solid; border-color: rgb(0, 0, 0);',
  // one side cleared of a 4-side border
  clearedTop: 'text-align: left; border-width: medium 1px 1px; border-style: none solid solid; border-color: currentcolor rgb(0, 0, 0) rgb(0, 0, 0);',
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  →  ' + detail}`);
  if (!cond) failures++;
};

console.log('=== canonicalCss on real CSSOM forms ===');
const canon = {};
for (const [name, css] of Object.entries(CASES)) {
  canon[name] = canonicalCss(css);
  console.log(` ${name}:\n   in:  ${css}\n   out: ${canon[name]}`);
}

// what the FILE loader produces (cssOfExcel builds per-side shorthands)
const fromFile = canonicalCss('background-color:#FFFF00;border-top:1px solid #000000;border-right:1px solid #000000;border-bottom:1px solid #000000;border-left:1px solid #000000;font-weight:bold');
console.log(` fromFile (per-side form):\n   out: ${fromFile}`);

check('allBorders keeps 4 sides', (canon.allBorders.match(/border-/g) || []).length === 4, canon.allBorders);
check('allBorders border part === fromFile border part (diff baseline stable!)',
  canon.allBorders === fromFile
    .split(';')
    .filter((kv) => kv.startsWith('border-'))
    .sort()
    .join(';'),
  `${canon.allBorders} vs ${fromFile}`);
check('allBorders round-trips as Excel borders', (() => {
  const s = cssToExcelStyle(canon.allBorders);
  return s.border && ['top', 'right', 'bottom', 'left'].every((k) => s.border[k]?.style === 'thin');
})(), JSON.stringify(cssToExcelStyle(canon.allBorders)));
check('noBorders produces no border', !canonicalCss(CASES.noBorders), canon.noBorders);
check('outerCorner keeps top+left only', (() => {
  const d = parseCss(canon.outerCorner);
  return !!d['border-top'] && !!d['border-left'] && !d['border-right'] && !d['border-bottom'];
})(), canon.outerCorner);
check('mixedWidth: top 2px (medium), right/bottom/left 1px (thin)', (() => {
  const d = parseCss(canon.mixedWidth);
  return d['border-top'] === '2px solid #000000' && d['border-right'] === '1px solid #000000' && d['border-bottom'] === '1px solid #000000' && d['border-left'] === '1px solid #000000';
})(), canon.mixedWidth);
check('dotted keeps style + red color', parseCss(canon.dotted)['border-top'] === '1px dotted #FF0000', canon.dotted);
check('headerStyle keeps fill + bold + borders', (() => {
  const d = parseCss(canon.headerStyle);
  return d['background-color'] === '#FFFF00' && d['font-weight'] === 'bold' && !!d['border-top'];
})(), canon.headerStyle);
check('clearedTop drops top, keeps other 3', (() => {
  const d = parseCss(canon.clearedTop);
  return !d['border-top'] && !!d['border-right'] && !!d['border-bottom'] && !!d['border-left'];
})(), canon.clearedTop);

console.log('\n=== ExcelJS end-to-end: "All borders" then save + reload ===');
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S1');
  ws.getCell('B2').value = 42;
  const buf1 = await wb.xlsx.writeBuffer();

  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf1);
  const ws2 = wb2.worksheets[0];
  // simulate: user selected B2, clicked "All borders", saved
  ws2.getCell('B2').style = cssToExcelStyle(canonicalCss(CASES.allBorders));
  const buf2 = await wb2.xlsx.writeBuffer();

  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.load(buf2);
  const b = wb3.worksheets[0].getCell('B2').style.border;
  const ok = b && b.top.style === 'thin' && b.right.style === 'thin' && b.bottom.style === 'thin' && b.left.style === 'thin';
  check('saved file really carries all four thin borders', ok, JSON.stringify(b));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
