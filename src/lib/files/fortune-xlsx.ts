// ============================================================================
// PULSE Workforce OS — ExcelJS/SheetJS ↔ FortuneSheet converters
// ----------------------------------------------------------------------------
// The bridge between the .xlsx world (ExcelJS — what is stored in the site
// document bucket) and the in-app spreadsheet engine (FortuneSheet — what the
// user edits). Everything the PRD calls "must persist" crosses this bridge:
//
//   values & formulas (with cached results)      number / date / currency formats
//   fonts, sizes, bold/italic/strike/underline   text & background colours
//   borders (all 13 OOXML styles, per side)      alignments, wrap, rotation
//   merged cells                                 column widths / row heights
//   hidden rows & columns                        frozen panes
//   per-sheet zoom                               multiple sheets & sheet order
//
// Both directions are "what you see is what is saved": every cell the editor
// shows is written back on save, so no diffing heuristics can lose data.
// ============================================================================

import type {
  Cell as XCell,
  Workbook as XWorkbook,
  Worksheet as XWorksheet,
} from 'exceljs';
import type {
  Fill as XFill,
  Font as XFont,
} from 'exceljs';
import type {
  Cell as FCell,
  CellWithRowAndCol,
  Sheet as FSheet,
  SheetConfig,
} from '@fortune-sheet/core';

// ---------------------------------------------------------------------------
// Units & colour helpers (Excel ⇄ screen)
// ---------------------------------------------------------------------------
// Excel column width unit is "characters" of the default font; the grid works
// in CSS pixels. 7px/char + 5px padding is the classic Calibri-11 mapping.
const charsToPx = (ch: number) => Math.max(10, Math.round(ch * 7 + 5));
const pxToChars = (px: number) => Math.max(1, Math.round(((px - 5) / 7) * 100) / 100);
// Excel row height is in points (1pt = 1/72"), CSS pixels are 1/96".
const ptToPx = (pt: number) => Math.max(10, Math.round(pt / 0.75));
const pxToPt = (px: number) => Math.max(1, Math.round(px * 0.75 * 10) / 10);

/** Office default theme palette (display approximation). */
const THEME_PALETTE = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000',
  '5B9BD5', '70AD47', '0563C1', '954F72',
];

/** classic indexed palette (the colours legacy .xls files use most). */
const INDEXED_PALETTE: Record<number, string> = {
  0: '000000', 1: 'FFFFFF', 2: 'FF0000', 3: '00FF00', 4: '0000FF', 5: 'FFFF00',
  6: 'FF00FF', 7: '00FFFF', 8: '000000', 9: 'FFFFFF', 10: 'FF0000', 11: '00FF00',
  12: '0000FF', 13: 'FFFF00', 14: 'FF00FF', 15: '00FFFF', 16: '800000', 17: '008000',
  18: '000080', 19: '808000', 20: '800080', 21: '008080', 22: 'C0C0C0', 23: '808080',
  40: '00CCFF', 41: 'CCFFFF', 42: 'CCFFCC', 43: 'FFFF99', 44: '99CCFF', 45: 'FF99CC',
  46: 'CC99FF', 47: 'FFCC99', 48: '3366FF', 49: '33CCCC', 50: '99CC00', 51: 'FF9900',
  52: 'FF6600', 53: '666699', 54: '969696', 55: '003366', 56: '339966', 57: '003300',
  58: '333300', 59: '993300', 64: '000000', 65: 'FFFFFF',
};

const NAMED_COLORS: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', lime: '00FF00', blue: '0000FF',
  yellow: 'FFFF00', magenta: 'FF00FF', cyan: '00FFFF', silver: 'C0C0C0', gray: '808080',
  grey: '808080', maroon: '800000', olive: '808000', green: '008000', purple: '800080',
  teal: '008080', navy: '000080', orange: 'FFA500', pink: 'FFC0CB', gold: 'FFD700',
  brown: 'A52A2A', beige: 'F5F5DC', ivory: 'FFFFF0',
};

/** ECMA-376 tint applied to HSL luminance (theme colour shading). */
function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const L = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const q = L < 0.5 ? L * (1 + s) : L + s - L * s;
  const p = 2 * L - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `${to(channel(h + 1 / 3))}${to(channel(h))}${to(channel(h - 1 / 3))}`.toUpperCase();
}

/** exceljs colour object ({argb}|{theme,tint}|{indexed}) → 6-digit hex. */
function excelColorToHex(c: unknown): string | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as { argb?: string; rgb?: string; theme?: number; tint?: number; indexed?: number };
  if (typeof o.argb === 'string' && o.argb.length >= 6) return o.argb.slice(-6).toUpperCase();
  if (typeof o.rgb === 'string' && o.rgb.length >= 6) return o.rgb.slice(-6).toUpperCase();
  if (typeof o.indexed === 'number' && INDEXED_PALETTE[o.indexed]) return INDEXED_PALETTE[o.indexed];
  if (typeof o.theme === 'number' && THEME_PALETTE[o.theme]) {
    return applyTint(THEME_PALETTE[o.theme], typeof o.tint === 'number' ? o.tint : 0);
  }
  return null;
}

/** '#aabbcc' | 'aabbcc' | 'rgb(...)' | named → 6-digit hex (null = invalid). */
export function normalizeHexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : null;
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) {
    return [1, 2, 3].map((i) => Math.min(255, Number(m[i])).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return NAMED_COLORS[s.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Border style mapping — OOXML names ⇄ FortuneSheet numeric codes (0-13)
// ---------------------------------------------------------------------------
const EXCEL_BORDER_TO_CODE: Record<string, number> = {
  thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6,
  double: 7, medium: 8, mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11,
  slantDashDot: 12, thick: 13,
};
const CODE_TO_EXCEL_BORDER = Object.fromEntries(
  Object.entries(EXCEL_BORDER_TO_CODE).map(([name, code]) => [code, name]),
) as Record<number, string>;

interface FortuneBorderSide { style: number | string; color: string }
interface FortuneBorderSides {
  t?: FortuneBorderSide;
  b?: FortuneBorderSide;
  l?: FortuneBorderSide;
  r?: FortuneBorderSide;
}
interface FortuneCellBorderInfo {
  rangeType: 'cell' | 'range';
  value?: FortuneBorderSides & { row_index: number; col_index: number };
  borderType?: string;
  color?: string;
  style?: number | string;
  range?: { row: number[]; column: number[] }[];
}

// ---------------------------------------------------------------------------
// Cell name helpers
// ---------------------------------------------------------------------------
function colName(x: number): string {
  let s = '';
  let n = x + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseCellName(name: string): { x: number; y: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(name ?? '').trim());
  if (!m) return null;
  let x = 0;
  for (const ch of m[1].toUpperCase()) x = x * 26 + (ch.charCodeAt(0) - 64);
  const y = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1 || y < 1) return null;
  return { x: x - 1, y: y - 1 };
}

// ---------------------------------------------------------------------------
// Date helpers — FortuneSheet keeps date cells as 'YYYY-MM-DD HH:mm:ss' text
// ---------------------------------------------------------------------------
function formatFortuneDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 ? date : `${date} ${time}`;
}

function parseFortuneDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Does a numFmt describe a date/time? (same heuristic ExcelJS uses) */
function isDateNumFmt(fmt: string | undefined): boolean {
  if (!fmt) return false;
  const f = fmt.toLowerCase();
  if (f.includes('yy') || f.includes('dd') || f.includes('am/pm')) return true;
  if (/^[dmyhs]+$/.test(f.replace(/[^dmyhs]/g, '')) && /m/.test(f)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Grid sizing — how much runway the editor shows around the content
// ---------------------------------------------------------------------------
const PAD_ROWS = 30;
const PAD_COLS = 8;
const MIN_ROWS = 60;
const MIN_COLS = 20;
const MAX_GRID_ROWS = 20000;
const MAX_GRID_COLS = 700;

// ---------------------------------------------------------------------------
// Parsed document — what the editor component consumes
// ---------------------------------------------------------------------------
export interface FortuneDoc {
  /** FortuneSheet sheet models (celldata form) */
  sheets: FSheet[];
  /** the original ExcelJS workbook when the source was .xlsx — reused as the
   *  save base so sheet-level extras (images, names, …) survive round-trips */
  base: XWorkbook | null;
  /** the source could not be read as a spreadsheet */
  unreadable?: boolean;
}

// ---------------------------------------------------------------------------
// XLSX (ExcelJS) → FortuneSheet
// ---------------------------------------------------------------------------

/** rich-text / hyperlink objects → plain text. */
function textOfCellValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: string; hyperlink?: string; error?: string; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
    if (typeof o.text === 'string') return o.text;
    if (typeof o.error === 'string') return o.error;
  }
  return String(v);
}

function xlsxCellToFortune(cell: XCell, r: number, c: number): FCell | null {
  // ---- value ----
  let v: FCell['v'];
  let f: string | undefined;
  let m: string | undefined;
  let ct: FCell['ct'];
  let qp: number | undefined;

  const raw = cell.value as unknown;
  const style = cell.style as Partial<{
    numFmt: string;
    fill: XFill;
    font: XFont;
    alignment: { horizontal?: string; vertical?: string; wrapText?: boolean; textRotation?: number };
    border: Record<string, { style?: string; color?: unknown }>;
  }> | undefined;
  const numFmt = style?.numFmt;
  if (raw instanceof Date) {
    v = formatFortuneDate(raw);
    m = cell.text?.trim() || String(v);
    ct = { fa: numFmt && numFmt !== 'General' ? numFmt : 'yyyy-mm-dd', t: 'd' };
  } else if (raw != null && typeof raw === 'object') {
    const o = raw as {
      formula?: string; sharedFormula?: string; result?: unknown;
      richText?: { text: string }[]; text?: string; hyperlink?: string; error?: string;
    };
    if (o.formula || o.sharedFormula) {
      f = `=${o.formula ?? o.sharedFormula}`;
      const res = o.result;
      if (typeof res === 'number' || typeof res === 'boolean') v = res;
      else if (res instanceof Date) { v = formatFortuneDate(res); }
      else if (typeof res === 'string' && res) v = res;
      else v = '';
      m = cell.text?.trim() || (v === '' ? '' : String(v));
      ct = numFmt && numFmt !== 'General' ? { fa: numFmt, t: 'n' } : undefined;
    } else if (Array.isArray(o.richText)) {
      v = o.richText.map((t) => t.text).join('');
      m = String(v);
    } else if (typeof o.text === 'string' || typeof o.error === 'string') {
      v = o.text ?? o.error;
      m = String(v);
    } else {
      return null;
    }
  } else if (typeof raw === 'number') {
    v = raw;
    m = cell.text?.trim() || String(raw);
  } else if (typeof raw === 'boolean') {
    v = raw;
    m = raw ? 'TRUE' : 'FALSE';
  } else if (typeof raw === 'string') {
    v = raw;
    m = raw;
    if (raw.startsWith('=')) qp = 1; // literal '=' text, NOT a formula
  } else {
    v = undefined;
  }

  // ---- style ----
  const fc: FCell = {};
  if (v !== undefined) fc.v = v;
  if (m !== undefined && m !== '') fc.m = m;
  if (f) fc.f = f;
  if (ct) fc.ct = ct;
  else if (typeof numFmt === 'string' && numFmt && numFmt !== 'General') {
    fc.ct = { fa: numFmt, t: 'n' };
  }
  if (qp) fc.qp = qp;

  const font = style?.font;
  if (font) {
    const fnt = font as unknown as Record<string, unknown>;
    // NOTE: ExcelJS reports a default font (Calibri 11 black) for EVERY cell —
    // importing it verbatim would stamp pointless attributes onto every
    // celldata entry, so the workbook defaults are suppressed here.
    if (fnt.bold) fc.bl = 1;
    if (fnt.italic) fc.it = 1;
    if (fnt.strike) fc.cl = 1;
    if (fnt.underline) fc.un = 1;
    if (typeof fnt.size === 'number' && fnt.size > 0 && fnt.size !== 11) fc.fs = fnt.size;
    if (typeof fnt.name === 'string' && fnt.name && fnt.name !== 'Calibri') fc.ff = fnt.name;
    const colorHex = excelColorToHex(fnt.color);
    if (colorHex && colorHex !== '000000') fc.fc = `#${colorHex}`;
  }

  const fill = style?.fill as unknown as { type?: string; pattern?: string; fgColor?: unknown } | undefined;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const bg = excelColorToHex(fill.fgColor);
    if (bg) fc.bg = `#${bg}`;
  }

  const align = style?.alignment;
  if (align) {
    if (align.horizontal === 'center') fc.ht = 0;
    else if (align.horizontal === 'right') fc.ht = 2;
    else if (align.horizontal === 'left') fc.ht = 1;
    if (align.vertical === 'top') fc.vt = 1;
    else if (align.vertical === 'bottom') fc.vt = 2;
    else if (align.vertical === 'middle') fc.vt = 0;
    if (align.wrapText) fc.tb = 'wrap';
    if (typeof align.textRotation === 'number' && align.textRotation > 0) {
      if (align.textRotation === 255) fc.tr = '4'; // vertical text ≈ 90°
      else fc.rt = align.textRotation;
    }
  }

  return fc;
}

function xlsxBorderToFortune(cell: XCell): FortuneBorderSides | null {
  const b = (cell.style as Partial<{ border: Record<string, { style?: string; color?: unknown }> }> | undefined)?.border;
  if (!b) return null;
  const side = (name: string) => {
    const s = b[name] as { style?: string; color?: unknown } | undefined;
    if (!s?.style || s.style === 'none') return undefined;
    const code = EXCEL_BORDER_TO_CODE[s.style];
    if (code == null) return undefined;
    const hex = excelColorToHex(s.color) ?? '000000';
    return { style: code, color: `#${hex}` };
  };
  const t = side('top');
  const bo = side('bottom');
  const l = side('left');
  const r = side('right');
  if (!t && !bo && !l && !r) return null;
  return { t, b: bo, l, r };
}

/** `A1:B2` merge strings → zero-based rects (defensive: malformed parts skipped). */
function mergeRectsOf(ws: XWorksheet): { r1: number; c1: number; r2: number; c2: number }[] {
  const out: { r1: number; c1: number; r2: number; c2: number }[] = [];
  const merges = (ws.model as unknown as { merges?: string[] } | null)?.merges ?? [];
  for (const range of merges) {
    if (typeof range !== 'string') continue;
    const [a, b] = range.split(':');
    const s = parseCellName(a ?? '');
    const e = parseCellName(b ?? a ?? '');
    if (!s || !e) continue;
    const r1 = Math.min(s.y, e.y);
    const c1 = Math.min(s.x, e.x);
    const r2 = Math.max(s.y, e.y);
    const c2 = Math.max(s.x, e.x);
    if (r2 < r1 || c2 < c1) continue;
    out.push({ r1, c1, r2, c2 });
  }
  return out;
}

function xlsxSheetToFortune(ws: XWorksheet, index: number): FSheet {
  const contentRows = Math.max(ws.rowCount ?? 0, 1);
  const contentCols = Math.max(ws.columnCount ?? 0, 1);
  const row = Math.min(Math.max(contentRows + PAD_ROWS, MIN_ROWS), MAX_GRID_ROWS);
  const col = Math.min(Math.max(contentCols + PAD_COLS, MIN_COLS), MAX_GRID_COLS);

  const celldata: CellWithRowAndCol[] = [];
  const borderInfo: FortuneCellBorderInfo[] = [];
  const config: SheetConfig = {};

  // 1) merges — non-anchor cells need `mc` even when they carry no value/style
  const mergeRects = mergeRectsOf(ws);
  const covered = new Map<string, { r: number; c: number }>(); // 'r_c' → anchor
  const anchors = new Map<string, { r: number; c: number; rs: number; cs: number }>();
  for (const { r1, c1, r2, c2 } of mergeRects) {
    anchors.set(`${r1}_${c1}`, { r: r1, c: c1, rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        covered.set(`${r}_${c}`, { r: r1, c: c1 });
      }
    }
  }
  if (anchors.size > 0) {
    config.merge = Object.fromEntries([...anchors.entries()].map(([k, v]) => [k, v]));
  }

  // 2) cells with content or styling
  const rowsToScan = Math.min(contentRows, MAX_GRID_ROWS);
  const colsToScan = Math.min(contentCols, MAX_GRID_COLS);
  for (let r = 0; r < rowsToScan; r++) {
    for (let c = 0; c < colsToScan; c++) {
      const coveredBy = covered.get(`${r}_${c}`);
      const cell = ws.findCell(r + 1, c + 1);
      const fcell = cell ? xlsxCellToFortune(cell, r, c) : null;
      const fborder = cell ? xlsxBorderToFortune(cell) : null;
      if (fborder) {
        borderInfo.push({ rangeType: 'cell', value: { row_index: r, col_index: c, ...fborder } });
      }
      const anchor = anchors.get(`${r}_${c}`);
      if (fcell || anchor || coveredBy) {
        const v: FCell = fcell ?? {};
        if (anchor) v.mc = { r, c, rs: anchor.rs, cs: anchor.cs };
        else if (coveredBy) v.mc = { r: coveredBy.r, c: coveredBy.c };
        if (Object.keys(v).length > 0) celldata.push({ r, c, v });
      }
    }
  }

  // 3) dimensions — explicit widths/heights/hidden.
  //    NOTE: columnCount/rowCount are CELL extents — a hidden or resized
  //    column/row without any cell would be missed, so also scan the parsed
  //    column definitions (ws.columns carries <col> defs of the source file).
  const columnlen: Record<string, number> = {};
  const colhidden: Record<string, number> = {};
  const colDefs = (ws.columns ?? []) as unknown[];
  const colScan = Math.min(Math.max(contentCols, colDefs.length, 1), MAX_GRID_COLS);
  for (let c = 0; c < colScan; c++) {
    const col = (colDefs[c] ?? ws.getColumn(c + 1)) as { width?: number; hidden?: boolean } | undefined;
    if (!col) continue;
    if (typeof col.width === 'number' && col.width > 0) columnlen[c] = charsToPx(col.width);
    if (col.hidden) colhidden[c] = 0;
  }
  const rowlen: Record<string, number> = {};
  const rowhidden: Record<string, number> = {};
  //    hidden-only rows keep a <row> model, so rowCount already includes them
  for (let r = 0; r < rowsToScan; r++) {
    const rowWs = ws.getRow(r + 1);
    if (typeof rowWs.height === 'number' && rowWs.height > 0) rowlen[r] = ptToPx(rowWs.height);
    if (rowWs.hidden) rowhidden[r] = 0;
  }
  if (Object.keys(columnlen).length) config.columnlen = columnlen;
  if (Object.keys(colhidden).length) config.colhidden = colhidden;
  if (Object.keys(rowlen).length) config.rowlen = rowlen;
  if (Object.keys(rowhidden).length) config.rowhidden = rowhidden;
  if (borderInfo.length) (config as { borderInfo?: FortuneCellBorderInfo[] }).borderInfo = borderInfo;

  // 4) frozen panes + saved zoom (xlsx views: xSplit/ySplit are 1-based
  //    counts of frozen rows/cols; FortuneSheet wants the index of the LAST
  //    frozen row/column; zoomScale % → zoomRatio)
  let frozen: FSheet['frozen'];
  let zoomRatio: number | undefined;
  try {
    const view = (ws.views as unknown as { state?: string; xSplit?: number; ySplit?: number; zoomScale?: number }[] | undefined)?.[0];
    if (view?.state === 'frozen' || view?.state === 'frozenSplit') {
      const xs = Math.max(0, Math.floor(view.xSplit ?? 0));
      const ys = Math.max(0, Math.floor(view.ySplit ?? 0));
      if (xs > 0 && ys > 0) frozen = { type: 'both', range: { row_focus: ys - 1, column_focus: xs - 1 } };
      else if (ys > 0) frozen = { type: 'row', range: { row_focus: ys - 1, column_focus: 0 } };
      else if (xs > 0) frozen = { type: 'column', range: { row_focus: 0, column_focus: xs - 1 } };
    }
    const zs = view?.zoomScale;
    if (typeof zs === 'number' && zs > 0 && zs !== 100) {
      zoomRatio = Math.min(4, Math.max(0.1, Math.round((zs / 100) * 10) / 10));
    }
  } catch { /* views unreadable — no freeze / zoom */ }

  const sheetId = `fs_${index}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: ws.name || `Sheet${index + 1}`,
    celldata,
    // calcChain tells the engine which cells hold formulas, so editing an
    // input cell live-recalculates every imported formula that depends on it
    calcChain: celldata
      .filter((cd) => typeof cd.v?.f === 'string' && cd.v.f.startsWith('='))
      .map((cd) => ({ r: cd.r, c: cd.c, id: sheetId })),
    config,
    row,
    column: col,
    order: index,
    id: sheetId,
    ...(frozen ? { frozen } : {}),
    ...(zoomRatio ? { zoomRatio } : {}),
  };
}

// ---------------------------------------------------------------------------
// Legacy .xls / .csv (SheetJS) → FortuneSheet — values, formulas, merges, dims
// ---------------------------------------------------------------------------
function legacySheetToFortune(
  name: string,
  ws: Record<string, unknown>,
  index: number,
): FSheet {
  type SJSCell = { v?: unknown; f?: string; w?: string; t?: string };
  const range = decodeRange(String(ws['!ref'] ?? 'A1'));
  const contentRows = Math.min(range.e.r - range.s.r + 1, MAX_GRID_ROWS);
  const contentCols = Math.min(range.e.c - range.s.c + 1, MAX_GRID_COLS);
  const row = Math.min(Math.max(contentRows + PAD_ROWS, MIN_ROWS), MAX_GRID_ROWS);
  const col = Math.min(Math.max(contentCols + PAD_COLS, MIN_COLS), MAX_GRID_COLS);

  const celldata: CellWithRowAndCol[] = [];
  const config: SheetConfig = {};
  const covered = new Map<string, { r: number; c: number }>();
  const anchors = new Map<string, { r: number; c: number; rs: number; cs: number }>();

  for (const m of (ws['!merges'] as unknown as { s: { r: number; c: number }; e: { r: number; c: number } }[] | undefined) ?? []) {
    if (!m?.s || !m?.e) continue;
    const r1 = Math.min(m.s.r, m.e.r);
    const c1 = Math.min(m.s.c, m.e.c);
    const r2 = Math.max(m.s.r, m.e.r);
    const c2 = Math.max(m.s.c, m.e.c);
    if (r2 < r1 || c2 < c1) continue;
    anchors.set(`${r1}_${c1}`, { r: r1, c: c1, rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      if (r === r1 && c === c1) continue;
      covered.set(`${r}_${c}`, { r: r1, c: c1 });
    }
  }
  if (anchors.size) config.merge = Object.fromEntries(anchors.entries());

  for (let r = 0; r < contentRows; r++) {
    for (let c = 0; c < contentCols; c++) {
      const key = encodeCell({ r: range.s.r + r, c: range.s.c + c });
      const cell = ws[key] as SJSCell | undefined;
      const fcell: FCell = {};
      if (cell?.f) {
        fcell.f = cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
        const res = cell.v;
        if (typeof res === 'number' || typeof res === 'boolean') fcell.v = res;
        else if (res instanceof Date) fcell.v = formatFortuneDate(res);
        else fcell.v = cell.w ?? '';
        fcell.m = cell.w ?? String(fcell.v);
      } else if (cell?.v != null) {
        if (cell.v instanceof Date) {
          fcell.v = formatFortuneDate(cell.v);
          fcell.ct = { fa: 'yyyy-mm-dd', t: 'd' };
        } else if (typeof cell.v === 'number' || typeof cell.v === 'boolean') {
          fcell.v = cell.v;
        } else {
          fcell.v = String(cell.v);
          if (String(cell.v).startsWith('=')) fcell.qp = 1;
        }
        fcell.m = cell.w ?? String(fcell.v);
      }
      const anchor = anchors.get(`${r}_${c}`);
      const coveredBy = covered.get(`${r}_${c}`);
      if (Object.keys(fcell).length > 0 || anchor || coveredBy) {
        if (anchor) fcell.mc = { r, c, rs: anchor.rs, cs: anchor.cs };
        else if (coveredBy) fcell.mc = { r: coveredBy.r, c: coveredBy.c };
        celldata.push({ r, c, v: fcell });
      }
    }
  }

  const colsMeta = (ws['!cols'] as unknown as { wch?: number; wpx?: number; hidden?: boolean }[] | undefined) ?? [];
  const columnlen: Record<string, number> = {};
  const colhidden: Record<string, number> = {};
  colsMeta.forEach((cm, c) => {
    if (!cm) return;
    if (cm.wch != null) columnlen[c] = charsToPx(cm.wch);
    else if (cm.wpx != null) columnlen[c] = Math.max(10, Math.round(cm.wpx));
    if (cm.hidden) colhidden[c] = 0;
  });
  const rowsMeta = (ws['!rows'] as unknown as { hpt?: number; hpx?: number; hidden?: boolean }[] | undefined) ?? [];
  const rowlen: Record<string, number> = {};
  const rowhidden: Record<string, number> = {};
  rowsMeta.forEach((rm, r) => {
    if (!rm) return;
    if (rm.hpt != null) rowlen[r] = ptToPx(rm.hpt);
    else if (rm.hpx != null) rowlen[r] = Math.max(10, Math.round(rm.hpx));
    if (rm.hidden) rowhidden[r] = 0;
  });
  if (Object.keys(columnlen).length) config.columnlen = columnlen;
  if (Object.keys(colhidden).length) config.colhidden = colhidden;
  if (Object.keys(rowlen).length) config.rowlen = rowlen;
  if (Object.keys(rowhidden).length) config.rowhidden = rowhidden;

  const sheetId = `fs_${index}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: name || `Sheet${index + 1}`,
    celldata,
    calcChain: celldata
      .filter((cd) => typeof cd.v?.f === 'string' && cd.v.f.startsWith('='))
      .map((cd) => ({ r: cd.r, c: cd.c, id: sheetId })),
    config,
    row,
    column: col,
    order: index,
    id: sheetId,
  };
}

// minimal SheetJS range/cell codecs (avoid importing SheetJS types in this module)
function decodeRange(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const [a, b] = ref.split(':');
  const s = parseCellName(a ?? 'A1') ?? { x: 0, y: 0 };
  const e = parseCellName(b ?? a ?? 'A1') ?? s;
  return { s: { r: s.y, c: s.x }, e: { r: e.y, c: e.x } };
}
function encodeCell(at: { r: number; c: number }): string {
  return `${colName(at.c)}${at.r + 1}`;
}

// ---------------------------------------------------------------------------
// Parse entry point
// ---------------------------------------------------------------------------
export async function parseToFortuneDoc(bytes: ArrayBuffer): Promise<FortuneDoc | null> {
  // ---- validate the container BEFORE handing anything to the engines ----
  // (PRD §9: never pass unvalidated data to the spreadsheet engine — this is
  //  the class of bug behind the old "Cannot read properties of undefined".)
  if (bytes.byteLength < 8) {
    // tiny payloads: only a CSV with a delimiter is worth a try
    const head = new TextDecoder().decode(new Uint8Array(bytes)).trim();
    return head.includes(',') || head.includes(';') || head.includes('\t') || head.includes('\n')
      ? await parseLegacy(bytes)
      : null;
  }
  const magic = new Uint8Array(bytes.slice(0, 8));
  const isZip = magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07);
  const isOle = magic[0] === 0xd0 && magic[1] === 0xcf && magic[2] === 0x11 && magic[3] === 0xe0;
  if (!isZip && !isOle) {
    // plain text — only treat as CSV when it looks tabular (no NUL bytes and
    // it carries a delimiter or more than one line)
    const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 1024)));
    const tabular = !head.includes('\u0000')
      && (head.includes(',') || head.includes(';') || head.includes('\t') || head.includes('\n'));
    if (!tabular) return null;
    return parseLegacy(bytes);
  }

  if (isZip) {
    // 1) real .xlsx — full fidelity through ExcelJS (styles + formulas + dims)
    try {
      const { Workbook } = (await import('exceljs')) as unknown as { Workbook: new () => XWorkbook };
      const wb = new Workbook();
      await wb.xlsx.load(bytes as unknown as Parameters<XWorkbook['xlsx']['load']>[0]);
      const sheets = wb.worksheets
        .filter((ws) => (ws.rowCount ?? 0) >= 0)
        .map((ws, i) => xlsxSheetToFortune(ws, i));
      if (sheets.length === 0) return null;
      return { sheets, base: wb };
    } catch {
      // a zip, but not a workbook — fall through to the legacy reader
    }
  }
  return parseLegacy(bytes);
}

async function parseLegacy(bytes: ArrayBuffer): Promise<FortuneDoc | null> {
  // legacy .xls / .csv via SheetJS (values & formulas & dims)
  try {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(new Uint8Array(bytes), { type: 'array' });
    const sheets = wb.SheetNames.map((n, i) => legacySheetToFortune(n, wb.Sheets[n] as Record<string, unknown>, i));
    if (sheets.length === 0) return null;
    const hasContent = sheets.some((s) => s.celldata && s.celldata.length > 0);
    if (!hasContent) return null;
    return { sheets, base: null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FortuneSheet → XLSX (ExcelJS) — full WYSIWYG export
// ---------------------------------------------------------------------------

/** Resolve a FortuneSheet border style (number or numeric string) to a code. */
function borderCode(style: unknown): number {
  const n = typeof style === 'string' ? parseInt(style, 10) : Number(style);
  return Number.isFinite(n) && n >= 0 && n <= 13 ? n : 1;
}

/** Expand cfg.borderInfo (cell + range entries) into absolute per-cell sides. */
function computeCellBorders(cfg: SheetConfig | undefined): Map<string, Record<string, { style: string; color: string }>> {
  const out = new Map<string, Record<string, { style: string; color: string }>>();
  const list = (cfg as { borderInfo?: FortuneCellBorderInfo[] } | undefined)?.borderInfo ?? [];
  const put = (r: number, c: number, side: 't' | 'b' | 'l' | 'r', style: string, color: string) => {
    const key = `${r}_${c}`;
    const cur = out.get(key) ?? {};
    cur[side] = { style, color };
    out.set(key, cur);
  };
  for (const bi of list) {
    if (!bi || typeof bi !== 'object') continue;
    if (bi.rangeType === 'cell' && bi.value) {
      const { row_index, col_index } = bi.value;
      if (!Number.isFinite(row_index) || !Number.isFinite(col_index)) continue;
      const r = Number(row_index);
      const c = Number(col_index);
      for (const side of ['t', 'b', 'l', 'r'] as const) {
        const s = bi.value[side];
        if (s && (s.style != null || s.color)) {
          put(r, c, side, CODE_TO_EXCEL_BORDER[borderCode(s.style)] ?? 'thin', normalizeHexColor(s.color) ?? '000000');
        }
      }
    } else if (bi.rangeType === 'range') {
      const style = CODE_TO_EXCEL_BORDER[borderCode(bi.style)] ?? 'thin';
      const color = normalizeHexColor(bi.color) ?? '000000';
      const type = String(bi.borderType ?? 'border-all');
      if (type === 'border-none') continue;
      for (const sel of bi.range ?? []) {
        const rows = sel?.row;
        const cols = sel?.column;
        if (!Array.isArray(rows) || !Array.isArray(cols)) continue;
        const r1 = Math.min(Number(rows[0]) || 0, Number(rows[1]) || 0);
        const r2 = Math.max(Number(rows[0]) || 0, Number(rows[1]) || 0);
        const c1 = Math.min(Number(cols[0]) || 0, Number(cols[1]) || 0);
        const c2 = Math.max(Number(cols[0]) || 0, Number(cols[1]) || 0);
        if (r2 < r1 || c2 < c1 || r2 - r1 > MAX_GRID_ROWS || c2 - c1 > MAX_GRID_COLS) continue;
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            if (type === 'border-all') {
              put(r, c, 't', style, color); put(r, c, 'b', style, color);
              put(r, c, 'l', style, color); put(r, c, 'r', style, color);
            } else if (type === 'border-out') {
              if (r === r1) put(r, c, 't', style, color);
              if (r === r2) put(r, c, 'b', style, color);
              if (c === c1) put(r, c, 'l', style, color);
              if (c === c2) put(r, c, 'r', style, color);
            } else if (type === 'border-top') {
              if (r === r1) put(r, c, 't', style, color);
            } else if (type === 'border-bottom') {
              if (r === r2) put(r, c, 'b', style, color);
            } else if (type === 'border-left') {
              if (c === c1) put(r, c, 'l', style, color);
            } else if (type === 'border-right') {
              if (c === c2) put(r, c, 'r', style, color);
            }
          }
        }
      }
    }
  }
  return out;
}

/** FortuneSheet data matrix — `data` when present, else expand `celldata`. */
function sheetMatrix(fs: FSheet): (FCell | null)[][] {
  if (Array.isArray(fs.data)) return fs.data;
  const rows = Math.max(fs.row ?? 0, 0);
  const cols = Math.max(fs.column ?? 0, 0);
  let maxR = 0;
  let maxC = 0;
  for (const cd of fs.celldata ?? []) {
    if (!cd || !cd.v) continue;
    if (cd.r > maxR) maxR = cd.r;
    if (cd.c > maxC) maxC = cd.c;
  }
  const matrix: (FCell | null)[][] = [];
  const nRows = Math.max(rows, maxR + 1);
  const nCols = Math.max(cols, maxC + 1);
  for (let r = 0; r < nRows; r++) {
    matrix.push(new Array(nCols).fill(null));
  }
  for (const cd of fs.celldata ?? []) {
    if (!cd || !cd.v) continue;
    if (cd.r < nRows && cd.c < nCols) matrix[cd.r][cd.c] = cd.v;
  }
  return matrix;
}

/** Wipe every existing cell (value + style) of a base worksheet so deleted
 *  rows/columns never resurrect on save. Falls back to a clean rebuild for
 *  pathological sizes. Returns true when the sheet can be reused. */
function clearWorksheet(ws: XWorksheet): boolean {
  const maxR = ws.rowCount ?? 0;
  const maxC = ws.columnCount ?? 0;
  if (maxR * maxC > 400_000) return false; // too big to touch cell-by-cell
  // dissolve merges first so every cell is writable
  const merges = (ws.model as unknown as { merges?: string[] } | null)?.merges ?? [];
  for (const range of merges) {
    try { ws.unMergeCells(range); } catch { /* already dissolved */ }
  }
  for (let r = 1; r <= maxR; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= maxC; c++) {
      const cell = row.getCell(c);
      cell.value = null;
      cell.style = {} as XCell['style'];
    }
  }
  return true;
}

function writeFortuneSheet(ws: XWorksheet, fs: FSheet): void {
  const data = sheetMatrix(fs);
  const cfg = fs.config ?? {};
  const nRows = data.length;
  const nCols = nRows > 0 ? Math.max(...data.map((r) => r?.length ?? 0)) : 0;
  const borders = computeCellBorders(cfg);

  // 1) cells (a cell with ONLY a border still needs to be written)
  for (let r = 0; r < nRows; r++) {
    const rowCells = data[r] ?? [];
    for (let c = 0; c < nCols; c++) {
      const fcell = rowCells[c] && typeof rowCells[c] === 'object' ? rowCells[c] : null;
      const bi = borders.get(`${r}_${c}`);
      if (!fcell && !bi) continue;
      const mc = fcell?.mc as { r?: number; c?: number; rs?: number; cs?: number } | undefined;
      if (mc && mc.rs == null) continue; // covered by a merge — keep empty

      const cell = ws.getCell(r + 1, c + 1);
      // ---- value ----
      if (fcell && typeof fcell.f === 'string' && fcell.f.startsWith('=')) {
        const result = fcell.v;
        cell.value = {
          formula: fcell.f.slice(1),
          ...(typeof result === 'number' || typeof result === 'boolean'
            ? { result }
            : typeof result === 'string' && result !== '' ? { result } : {}),
        } as XCell['value'];
      } else if (fcell?.ct?.t === 'd') {
        const d = parseFortuneDate(fcell.v);
        cell.value = (d ?? (fcell.m != null && fcell.m !== '' ? String(fcell.m) : String(fcell.v ?? ''))) as XCell['value'];
      } else if (typeof fcell?.v === 'number') {
        cell.value = fcell.v;
      } else if (typeof fcell?.v === 'boolean') {
        cell.value = fcell.v;
      } else if (typeof fcell?.v === 'string' && fcell.v !== '') {
        cell.value = fcell.v;
      } else if (fcell && fcell.m != null && fcell.m !== '' && typeof fcell.m !== 'number') {
        cell.value = String(fcell.m);
      }

      // ---- style ----
      const style: Record<string, unknown> = {};
      const fa = fcell?.ct?.fa;
      if (typeof fa === 'string' && fa && fa !== 'General') style.numFmt = fa;

      const font: Record<string, unknown> = {};
      if (fcell?.bl) font.bold = true;
      if (fcell?.it) font.italic = true;
      if (fcell?.cl) font.strike = true;
      if (fcell?.un) font.underline = 'single';
      if (typeof fcell?.fs === 'number' && fcell.fs > 0) font.size = fcell.fs;
      if (typeof fcell?.ff === 'string' && fcell.ff) font.name = fcell.ff.replace(/["']/g, '');
      const fcHex = normalizeHexColor(fcell?.fc);
      if (fcHex) font.color = { argb: `FF${fcHex}` };
      if (Object.keys(font).length) style.font = font;

      const bgHex = normalizeHexColor(fcell?.bg);
      if (bgHex) style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${bgHex}` } };

      const align: Record<string, unknown> = {};
      if (fcell?.ht === 0) align.horizontal = 'center';
      else if (fcell?.ht === 2) align.horizontal = 'right';
      else if (fcell?.ht === 1) align.horizontal = 'left';
      if (fcell?.vt === 1) align.vertical = 'top';
      else if (fcell?.vt === 2) align.vertical = 'bottom';
      else if (fcell?.vt === 0) align.vertical = 'middle';
      if (fcell?.tb === 'wrap') align.wrapText = true;
      const rt = typeof fcell?.rt === 'number' ? fcell.rt : undefined;
      if (rt != null && rt > 0 && rt <= 180) align.textRotation = rt;
      else if (fcell?.tr === '1') align.textRotation = 45;
      else if (fcell?.tr === '2') align.textRotation = 135;
      else if (fcell?.tr === '4') align.textRotation = 255;
      else if (fcell?.tr === '5') align.textRotation = 180;
      if (Object.keys(align).length) style.alignment = align;

      if (bi) {
        const border: Record<string, { style: string; color: { argb: string } }> = {};
        const map: [string, keyof typeof bi][] = [['top', 't'], ['bottom', 'b'], ['left', 'l'], ['right', 'r']];
        for (const [excelSide, fortuneSide] of map) {
          const s = bi[fortuneSide];
          if (s) border[excelSide] = { style: s.style, color: { argb: `FF${s.color}` } };
        }
        if (Object.keys(border).length) style.border = border;
      }

      if (Object.keys(style).length) {
        cell.style = style as XCell['style'];
      }
    }
  }

  // 2) merges
  for (const m of Object.values(cfg.merge ?? {})) {
    if (!m || typeof m.r !== 'number' || typeof m.c !== 'number') continue;
    const rs = Math.max(1, m.rs ?? 1);
    const cs = Math.max(1, m.cs ?? 1);
    try { ws.mergeCells(m.r + 1, m.c + 1, m.r + rs, m.c + cs); } catch { /* overlap — keep the rest */ }
  }

  // 3) dimensions + hidden (FortuneSheet config is the source of truth)
  const maxRows = Math.max(nRows, ws.rowCount ?? 0);
  const maxCols = Math.max(nCols, ws.columnCount ?? 0);
  const rowlen = cfg.rowlen ?? {};
  const rowhidden = cfg.rowhidden ?? {};
  for (let r = 0; r < maxRows; r++) {
    const optRow = ws.getRow(r + 1) as { height?: number; hidden?: boolean };
    optRow.height = rowlen[r] != null ? pxToPt(rowlen[r]) : undefined;
    optRow.hidden = rowhidden[r] != null ? true : false;
  }
  const columnlen = cfg.columnlen ?? {};
  const colhidden = cfg.colhidden ?? {};
  for (let c = 0; c < maxCols; c++) {
    const optCol = ws.getColumn(c + 1) as { width?: number; hidden?: boolean };
    optCol.width = columnlen[c] != null ? pxToChars(columnlen[c]) : undefined;
    optCol.hidden = colhidden[c] != null ? true : false;
  }

  // 4) frozen panes + zoom
  const views: Record<string, unknown>[] = [];
  const frozen = fs.frozen;
  if (frozen && (frozen.type === 'row' || frozen.type === 'column' || frozen.type === 'both'
    || frozen.type === 'rangeRow' || frozen.type === 'rangeColumn' || frozen.type === 'rangeBoth')) {
    const isRow = frozen.type === 'row' || frozen.type === 'both' || frozen.type === 'rangeRow' || frozen.type === 'rangeBoth';
    const isCol = frozen.type === 'column' || frozen.type === 'both' || frozen.type === 'rangeColumn' || frozen.type === 'rangeBoth';
    views.push({
      state: 'frozen',
      ySplit: isRow ? Math.max(1, (frozen.range?.row_focus ?? 0) + 1) : 0,
      xSplit: isCol ? Math.max(1, (frozen.range?.column_focus ?? 0) + 1) : 0,
    });
  }
  if (typeof fs.zoomRatio === 'number' && fs.zoomRatio > 0 && fs.zoomRatio !== 1) {
    if (views.length === 0) views.push({});
    views[0].zoomScale = Math.round(fs.zoomRatio * 100);
  }
  if (views.length) ws.views = views as XWorksheet['views'];
}

/**
 * Build the output .xlsx. `base` (the workbook the file was parsed from) is
 * reused sheet-by-sheet so untouched sheet-level extras survive; sheets added
 * or renamed in the editor are created fresh.
 */
export async function fortuneToXlsxBytes(
  sheets: FSheet[],
  base: XWorkbook | null,
): Promise<Uint8Array> {
  const { Workbook } = (await import('exceljs')) as unknown as { Workbook: new () => XWorkbook };
  const wb: XWorkbook = base ?? new Workbook();
  if (!base) wb.created = new Date();

  // drop base sheets the editor deleted
  const wantedNames = new Set(sheets.map((s) => s.name));
  for (const ws of [...wb.worksheets]) {
    if (!wantedNames.has(ws.name)) wb.removeWorksheet(ws.id);
  }

  for (const fs of sheets) {
    if (!fs || !fs.name) continue;
    let ws = wb.worksheets.find((w) => w.name === fs.name) ?? null;
    if (ws && !clearWorksheet(ws)) {
      wb.removeWorksheet(ws.id);
      ws = null;
    }
    if (!ws) ws = wb.addWorksheet(fs.name);
    writeFortuneSheet(ws, fs);
  }

  // mirror the editor's sheet order
  try {
    const mover = wb as unknown as { moveSheet?: (name: string, index: number) => void };
    if (typeof mover.moveSheet === 'function') sheets.forEach((fs, i) => mover.moveSheet!(fs.name, i));
  } catch { /* best effort */ }

  // let Excel refresh formulas when the file opens
  wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true } as XWorkbook['calcProperties'];

  const buf = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return new Uint8Array(buf);
}

/** First sheet as CSV (quick text export alongside the real .xlsx). */
export async function fortuneFirstSheetCsv(sheets: FSheet[]): Promise<string> {
  const XLSX = await import('xlsx');
  const first = sheets[0];
  if (!first) return '';
  const data = sheetMatrix(first);
  const aoa: unknown[][] = data.map((row) =>
    (row ?? []).map((cell) => {
      if (!cell) return '';
      if (typeof cell.f === 'string' && cell.f.startsWith('=')) {
        return typeof cell.v === 'number' ? cell.v : cell.v ?? '';
      }
      return cell.v ?? '';
    }),
  );
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  return XLSX.utils.sheet_to_csv(ws);
}
