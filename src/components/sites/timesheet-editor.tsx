'use client';

// ============================================================================
// PULSE Workforce OS — in-app Timesheet (Excel) editor
// ----------------------------------------------------------------------------
// Opens a timesheet straight from the site document store and makes it
// editable like a normal spreadsheet. A save round-trips the WHOLE look of
// the sheet, not just the numbers:
//
//   • values & formulas ( =SUM(...), =IF(...), 300+ functions ) with cached
//     results so every viewer shows numbers immediately
//   • merged cells (kept, moved or removed — whatever you did in the grid)
//   • cell colours — fill + text colour, bold / italic / underline
//   • borders, text alignment, fonts
//   • column widths and row heights (drag the headers — saved as-is)
//
// Internals: ExcelJS (browser build) parses and re-serialises the workbook.
// A snapshot of every sheet is taken at load; on save only the cells that
// actually changed are rewritten, so untouched cells keep their original
// Excel styling bit-for-bit (number formats included). jspreadsheet CE (MIT)
// renders the editable grid with its live formula engine. Legacy .xls/.csv
// files are read with SheetJS and saved as real .xlsx.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as XLSX from 'xlsx';
import type {
  Cell as XCell,
  Fill as XFill,
  Font as XFont,
  Workbook as XWorkbook,
  Worksheet as XWorksheet,
} from 'exceljs';
import jspreadsheet from 'jspreadsheet-ce';
import 'jspreadsheet-ce/dist/jspreadsheet.css';
import {
  AlignCenter,
  AlignCenterVertical,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartVertical,
  Baseline,
  Bold,
  Italic,
  Loader2,
  PaintBucket,
  Save,
  Sheet as SheetIcon,
  TableCellsMerge,
  TableCellsSplit,
  TriangleAlert,
  Underline,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { uploadSiteDoc, type SiteDoc } from '@/lib/files/site-docs';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** safety caps for the in-memory grid (beyond this the sheet is read-only
 *  in the areas that are not shown; saving never touches what is hidden). */
const MAX_ROWS = 3000;
const MAX_COLS = 150;

/** toolbar font families (Excel-friendly, present on Windows/macOS/web) */
const FONT_FAMILIES = [
  'Calibri', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia',
  'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 36];

const BORDER_MODES = [
  { id: 'all', label: 'All borders' },
  { id: 'outer', label: 'Outer borders' },
  { id: 'top', label: 'Top border' },
  { id: 'bottom', label: 'Bottom border' },
  { id: 'left', label: 'Left border' },
  { id: 'right', label: 'Right border' },
  { id: 'none', label: 'No borders' },
] as const;
type BorderMode = (typeof BORDER_MODES)[number]['id'];

// ---------------------------------------------------------------------------
// Small helpers — cell names, units, colours
// ---------------------------------------------------------------------------
type Raw = string | number | boolean | null;

interface SheetSnapshot {
  name: string;
  /** content extent (rows/cols that carry data or styling) */
  rows: number;
  cols: number;
  /** raw content; formula cells keep their '=' source */
  grid: Raw[][];
  /** 'A1' → canonical inline CSS (only display-relevant properties) */
  css: Record<string, string>;
  /** 'A1' → computed display text of formula cells (cache results on save) */
  labels: Record<string, string>;
  /** anchor 'A1' → [colspan, rowspan] */
  merges: Record<string, [number, number]>;
  /** px per column index (undefined = default width) */
  colWidths: (number | undefined)[];
  /** px per row index (undefined = default height) */
  rowHeights: (number | undefined)[];
  /** grid extent was capped (huge file) */
  truncated?: boolean;
}

interface ParsedDoc {
  source: 'xlsx' | 'legacy';
  /** the original workbook (xlsx files) — patched in place on save */
  workbook: XWorkbook | null;
  /** live state (updated whenever the grid is captured) */
  sheets: SheetSnapshot[];
  /** pristine state at load — the diff baseline */
  pristine: SheetSnapshot[];
}

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

function cellName(x: number, y: number): string {
  return `${colName(x)}${y + 1}`;
}

function parseCellName(name: string): { x: number; y: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(name.trim());
  if (!m) return null;
  let x = 0;
  for (const ch of m[1].toUpperCase()) x = x * 26 + (ch.charCodeAt(0) - 64);
  return { x: x - 1, y: Number(m[2]) - 1 };
}

// Excel column width unit is "characters"; jspreadsheet works in pixels.
const charsToPx = (ch: number) => Math.max(10, Math.round(ch * 7 + 5));
const pxToChars = (px: number) => Math.max(1, Math.round(((px - 5) / 7) * 100) / 100);
// Excel row height is in points (1pt = 1/72"), CSS pixels are 1/96".
const ptToPx = (pt: number) => Math.max(10, Math.round(pt / 0.75));
const pxToPt = (px: number) => Math.max(1, Math.round(px * 0.75 * 10) / 10);

/** Office default theme palette (display approximation — the saved file keeps
 *  the real theme colour for every cell the user did not touch). */
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

/** rgb() / #hex / named css colour → 6-digit hex (null = none/transparent).
 *  NOTE: alpha-0 rgba() (how browsers serialise 'transparent') counts as
 *  "no colour" — otherwise clearing a fill would round-trip as black. */
function cssColorToHex(v: string | undefined): string | null {
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
    // Excel fills have no alpha — anything (semi-)transparent is "no fill"
    if (m[4] !== undefined && Number(m[4]) < 1) return null;
    const hex = [1, 2, 3].map((i) => Math.min(255, Number(m[i])).toString(16).padStart(2, '0')).join('');
    return hex.toUpperCase();
  }
  return NAMED_COLORS[s] ?? null;
}

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

const EXCEL_BORDER_TO_CSS: Record<string, string> = {
  thin: '1px solid', medium: '2px solid', thick: '3px solid', hair: '1px solid',
  dotted: '1px dotted', dashed: '1px dashed', double: '3px double',
};

function cssBorderToExcel(v: string | undefined): { style: string; color: { argb: string } } | null {
  if (!v || v.includes('none') || v.trim() === '') return null;
  const color = cssColorToHex((v.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/) ?? [])[1] ?? '') ?? '000000';
  // widths arrive pre-normalised from canonicalCss ('thin'/'medium'/'thick'
  // keywords → px), but accept them here as well (defensive)
  const w = normalizeBorderWidth(/^([^\s]+)/.exec(v)?.[1]);
  let style: string | null = null;
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
const dottedCheck = (v: string) => v.includes('dotted');
const dashedCheck = (v: string) => v.includes('dashed');

/** 'a: b; c: d' → { a: b, c: d } (keys lower-cased, junk dropped). */
function parseCss(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// ---- borders --------------------------------------------------------------
// The CSSOM plays tricks with border serialisation: setting the four sides to
// the SAME value ('All borders' — by far the most used preset) collapses the
// style attribute into the box shorthands
//     'border-width: 1px; border-style: solid; border-color: rgb(0, 0, 0);'
// (with multi-value forms like 'border-width: 2px 1px 1px' when sides differ
// only partially, and per-side longhands 'border-top-width', …, plus the full
// 'border' shorthand). The canonical form the save pipeline understands is
// one 'border-<side>: <width> <style> #<hex>' entry per side — everything the
// browser throws at us is resolved into that below, so borders survive the
// DOM → snapshot → xlsx round-trip bit-for-bit.

type BorderSide = 'top' | 'right' | 'bottom' | 'left';
const BORDER_SIDES: BorderSide[] = ['top', 'right', 'bottom', 'left'];

/** Split a declaration value on whitespace OUTSIDE parentheses —
 *  'rgb(255, 0, 0)' is ONE value, not three. */
function splitTopLevel(v: string): string[] {
  const parts: string[] = [];
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

/** CSS box shorthand expansion: '1px' | '1px 2px' | '1px 2px 3px' |
 *  '1px 2px 3px 4px' (top right bottom left) → one value per side. */
function expandCssBox(v: string): [string, string, string, string] {
  const p = splitTopLevel(v);
  if (p.length <= 1) return [p[0] ?? '', p[0] ?? '', p[0] ?? '', p[0] ?? ''];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];
  return [p[0], p[1], p[2], p[3]];
}

/** CSS width keywords → px, so canonical strings stay stable and comparable
 *  ('medium' is what the CSSOM emits for a side reset back to its default). */
function normalizeBorderWidth(w: string | undefined): string {
  const t = (w ?? '').trim().toLowerCase();
  if (t === 'thin') return '1px';
  if (t === 'medium') return '2px';
  if (t === 'thick') return '3px';
  if (/^0(?:[a-z]+)?$/.test(t)) return '0px';
  const m = /^([\d.]+)px$/.exec(t);
  return m ? `${m[1]}px` : t;
}

/** '1px solid #000' / '1px solid rgb(0, 0, 0)' → { width, style, color }. */
function splitBorderShorthand(v: string): { width: string; style: string; color: string } {
  let width = '';
  let style = '';
  let color = '';
  for (const t of v.trim().split(/\s+/)) {
    if (!width && /^([\d.]+px|thin|medium|thick)$/i.test(t)) width = t;
    else if (!style && /^(solid|dotted|dashed|double|none|hidden|groove|ridge|inset|outset)$/i.test(t)) style = t.toLowerCase();
    else color = color ? `${color} ${t}` : t;
  }
  return { width, style, color };
}

/** Parse a style declaration record and produce ONE canonical
 *  '<width> <style> #<hex>' string per bordered side ('none'/0-width sides
 *  are omitted). Inputs may come in any CSSOM shape — collapsed box
 *  shorthands, per-side longhands, per-side shorthands or the full shorthand. */
function resolveBorderSides(d: Record<string, string>): Partial<Record<BorderSide, string>> {
  const boxW = d['border-width'] ? expandCssBox(d['border-width']) : null;
  const boxS = d['border-style'] ? expandCssBox(d['border-style']) : null;
  const boxC = d['border-color'] ? expandCssBox(d['border-color']) : null;
  const full = d['border'] ? splitBorderShorthand(d['border']) : null;
  const out: Partial<Record<BorderSide, string>> = {};
  BORDER_SIDES.forEach((side, i) => {
    // per-side shorthand wins, then per-side longhands, then the collapsed
    // box shorthands, then the full 'border' shorthand
    const sh = d[`border-${side}`] ? splitBorderShorthand(d[`border-${side}`]) : null;
    const width = normalizeBorderWidth(d[`border-${side}-width`] ?? sh?.width ?? boxW?.[i] ?? full?.width);
    const style = (d[`border-${side}-style`] ?? sh?.style ?? boxS?.[i] ?? full?.style ?? '').toLowerCase();
    const color = d[`border-${side}-color`] ?? sh?.color ?? boxC?.[i] ?? full?.color ?? '';
    if (!style || style === 'none' || style === 'hidden') return; // no border
    if (!width || width === '0px') return;
    const hex = cssColorToHex(color) ?? '000000'; // 'currentcolor' etc. → black
    out[side] = `${width} ${style} #${hex}`;
  });
  return out;
}

/** Canonical serialisation of a cell's CSS so that load-time and DOM-time
 *  strings compare equal (the browser re-serialises rgb()/spacing/case and
 *  COLLAPSES equal border sides into border-width/style/color shorthands). */
function canonicalCss(css: string): string {
  const d = parseCss(css);
  const out: Record<string, string> = {};

  // borders first — every CSSOM form resolved into per-side entries
  const borders = resolveBorderSides(d);
  for (const side of BORDER_SIDES) {
    const b = borders[side];
    if (b) out[`border-${side}`] = b; // 'none'/empty borders are dropped entirely
  }

  for (const [k, v] of Object.entries(d)) {
    if (k === 'display') continue; // grid-internal (merged hidden cells)
    if (k.startsWith('border')) continue; // handled above
    if (k === 'background-color' || k === 'color') {
      const hex = cssColorToHex(v);
      // "no fill" / "automatic text" — drop the key so a cleared fill or
      // colour never round-trips as black (or 'transparent'/'inherit')
      if (!hex) continue;
      out[k] = `#${hex}`;
    } else if (k === 'font-weight') {
      out[k] = v === 'normal' || v === '400' ? 'normal' : 'bold';
    } else if (k === 'font-family') {
      // browsers re-quote font names — strip the quotes, keep the letter case
      // (Excel stores font names with their proper case)
      const fam = v.replace(/["']/g, '').trim();
      if (fam && fam !== 'inherit' && fam !== 'initial') out[k] = fam;
    } else if (k === 'text-decoration') {
      const set = ['underline', 'line-through'].filter((t) => v.includes(t));
      if (set.length) out[k] = set.join(' ');
    } else {
      // the grid renders every cell with the column default 'left' (Excel's
      // own default) — drop it so untouched cells never look "changed"
      if (k === 'text-align' && v === 'left') continue;
      out[k] = v.toLowerCase();
    }
  }
  return Object.keys(out).sort().map((k) => `${k}:${out[k]}`).join(';');
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

// ---------------------------------------------------------------------------
// LOAD — ExcelJS worksheet → snapshot
// ---------------------------------------------------------------------------
function rawOfExcel(cell: XCell): Raw {
  const v = cell.value as unknown;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) {
      const t = cell.text?.trim();
      return t || v.toISOString().slice(0, 10);
    }
    const o = v as { formula?: string; sharedFormula?: string; richText?: { text: string }[]; text?: string; error?: string };
    if (o.formula) return `=${o.formula}`;
    if (o.sharedFormula) return `=${o.sharedFormula}`;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
    if (typeof o.text === 'string') return o.text;
    if (typeof o.error === 'string') return o.error;
  }
  return v as Raw;
}

/** inline CSS for one cell (only what the grid can show). */
function cssOfExcel(cell: XCell): string {
  const s = cell.style as Partial<{ fill: XFill; font: XFont; alignment: Record<string, string>; border: Record<string, { style?: string; color?: unknown }> }> | undefined;
  if (!s) return '';
  const parts: string[] = [];
  if (s.fill && (s.fill as { type?: string }).type === 'pattern' && (s.fill as { pattern?: string }).pattern === 'solid') {
    const hex = excelColorToHex((s.fill as { fgColor?: unknown }).fgColor);
    if (hex) parts.push(`background-color:#${hex}`);
  }
  if (s.font) {
    const f = s.font as unknown as Record<string, unknown>;
    const fc = excelColorToHex(f.color);
    if (fc) parts.push(`color:#${fc}`);
    if (f.bold) parts.push('font-weight:bold');
    if (f.italic) parts.push('font-style:italic');
    const deco: string[] = [];
    if (f.underline) deco.push('underline');
    if (f.strike) deco.push('line-through');
    if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`);
    if (typeof f.size === 'number') parts.push(`font-size:${f.size}pt`);
    if (typeof f.name === 'string' && f.name) parts.push(`font-family:'${f.name.replace(/'/g, '')}'`);
  }
  if (s.alignment) {
    const h = s.alignment.horizontal;
    if (h === 'center' || h === 'right') parts.push(`text-align:${h}`);
    const v = s.alignment.vertical;
    if (v === 'top' || v === 'middle' || v === 'bottom') parts.push(`vertical-align:${v}`);
  }
  if (s.border) {
    for (const side of ['top', 'left', 'right', 'bottom'] as const) {
      const b = s.border[side] as { style?: string; color?: unknown } | undefined;
      if (!b?.style) continue;
      const css = EXCEL_BORDER_TO_CSS[b.style];
      if (!css) continue;
      const hex = excelColorToHex(b.color) ?? '000000';
      parts.push(`border-${side}:${css} #${hex}`);
    }
  }
  return canonicalCss(parts.join(';'));
}

function fromExcelSheet(ws: XWorksheet): SheetSnapshot {
  const rows = Math.min(Math.max(ws.rowCount, 1), MAX_ROWS);
  const cols = Math.min(Math.max(ws.columnCount, 1), MAX_COLS);
  const grid: Raw[][] = [];
  const css: Record<string, string> = {};

  for (let r = 0; r < rows; r++) {
    const row = ws.getRow(r + 1);
    const out: Raw[] = new Array(cols).fill('');
    for (let c = 0; c < cols; c++) {
      const cell = row.findCell(c + 1);
      if (!cell) continue;
      const raw = rawOfExcel(cell);
      if (raw !== '') out[c] = raw;
      const cellCss = cssOfExcel(cell);
      if (cellCss) css[cellName(c, r)] = cellCss;
    }
    grid.push(out);
  }

  const merges: Record<string, [number, number]> = {};
  const padRows = Math.max(rows + 6, 24);
  const padCols = Math.max(cols + 3, 10);
  for (const range of ws.model.merges ?? []) {
    const [a, b] = String(range).split(':');
    const s = parseCellName(a);
    const e = parseCellName(b ?? a);
    if (!s || !e) continue;
    const cs = e.x - s.x + 1;
    const rs = e.y - s.y + 1;
    if (cs < 1 || rs < 1) continue;
    if (e.y >= padRows || e.x >= padCols) continue; // outside the visible grid
    merges[cellName(s.x, s.y)] = [cs, rs];
  }

  const colWidths: (number | undefined)[] = [];
  for (let c = 0; c < cols; c++) {
    const w = ws.getColumn(c + 1).width;
    colWidths.push(typeof w === 'number' && w > 0 ? charsToPx(w) : undefined);
  }
  const rowHeights: (number | undefined)[] = [];
  for (let r = 0; r < rows; r++) {
    const h = ws.getRow(r + 1).height;
    rowHeights.push(typeof h === 'number' && h > 0 ? ptToPx(h) : undefined);
  }

  return {
    name: ws.name,
    rows,
    cols,
    grid,
    css,
    labels: {},
    merges,
    colWidths,
    rowHeights,
    truncated: ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS,
  };
}

/** legacy .xls / .csv — values & formulas only, but merges / sizes survive. */
function fromLegacySheet(name: string, ws: XLSX.WorkSheet): SheetSnapshot {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  const rows = Math.min(range.e.r - range.s.r + 1, MAX_ROWS);
  const cols = Math.min(range.e.c - range.s.c + 1, MAX_COLS);
  const grid: Raw[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Raw[] = new Array(cols).fill('');
    for (let c = 0; c < cols; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })] as XLSX.CellObject | undefined;
      if (!cell) continue;
      if (cell.f) row[c] = `=${cell.f}`;
      else if (cell.v instanceof Date) row[c] = cell.w ?? cell.v.toISOString().slice(0, 10);
      else if (typeof cell.v === 'number' || typeof cell.v === 'boolean') row[c] = cell.v;
      else row[c] = cell.w ?? cell.v ?? '';
    }
    grid.push(row);
  }
  const merges: Record<string, [number, number]> = {};
  for (const m of ws['!merges'] ?? []) {
    if (m.e.r - m.s.r + 1 < 1 || m.e.c - m.s.c + 1 < 1) continue;
    merges[cellName(m.s.c, m.s.r)] = [m.e.c - m.s.c + 1, m.e.r - m.s.r + 1];
  }
  const colWidths: (number | undefined)[] = (ws['!cols'] ?? []).map((c) =>
    c?.wch != null ? charsToPx(c.wch) : c?.wpx != null ? c.wpx : undefined,
  );
  const rowHeights: (number | undefined)[] = (ws['!rows'] ?? []).map((r) =>
    r?.hpt != null ? ptToPx(r.hpt) : r?.hpx != null ? r.hpx : undefined,
  );
  return {
    name,
    rows,
    cols,
    grid,
    css: {},
    labels: {},
    merges,
    colWidths,
    rowHeights,
    truncated: rows >= MAX_ROWS || cols >= MAX_COLS,
  };
}

function cloneSnap(s: SheetSnapshot): SheetSnapshot {
  return {
    ...s,
    grid: s.grid.map((r) => [...r]),
    css: { ...s.css },
    labels: { ...s.labels },
    merges: { ...s.merges },
    colWidths: [...s.colWidths],
    rowHeights: [...s.rowHeights],
  };
}

async function parseDoc(bytes: ArrayBuffer): Promise<ParsedDoc | null> {
  // 1) real .xlsx — full fidelity through ExcelJS
  try {
    const { Workbook } = (await import('exceljs')) as unknown as {
      Workbook: new () => XWorkbook;
    };
    const wb = new Workbook();
    await wb.xlsx.load(bytes as unknown as Parameters<XWorkbook['xlsx']['load']>[0]);
    const sheets = wb.worksheets.map((ws) => fromExcelSheet(ws));
    if (sheets.length === 0) return null;
    return { source: 'xlsx', workbook: wb, sheets, pristine: sheets.map(cloneSnap) };
  } catch {
    // not an xlsx (legacy .xls / .csv) — fall through
  }
  // 2) legacy via SheetJS
  try {
    const wb = XLSX.read(new Uint8Array(bytes), { type: 'array' });
    const sheets = wb.SheetNames.map((n) => fromLegacySheet(n, wb.Sheets[n]));
    if (sheets.length === 0 || sheets.every((s) => s.rows <= 1 && s.cols <= 1 && s.grid.every((r) => r.every((v) => v === '')))) return null;
    return { source: 'legacy', workbook: null, sheets, pristine: sheets.map(cloneSnap) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CAPTURE — live grid → snapshot
// ---------------------------------------------------------------------------
/** The jSS v4 API the editor relies on (bundled typings are loose). */
interface JssInstance {
  destroy: () => void;
  options: {
    data: Raw[][];
    mergeCells?: Record<string, [number, number, unknown?]>;
  };
  getLabelFromCoords: (x: number, y: number) => string;
  getHighlighted: () => HTMLTableCellElement[];
  getStyle: (cell?: string | [number, number], key?: string) => string | Record<string, string>;
  setStyle: (o: string | HTMLTableCellElement[], k: string, v: string, force?: boolean, ignore?: boolean) => void;
  setMerge: (cellName?: string | [number, number], colspan?: number, rowspan?: number, ignore?: boolean) => unknown;
  removeMerge: (cellName: string) => void;
  getWidth: (column?: number) => string[] | string;
  getHeight: (row?: number) => string[];
}

function tdName(td: HTMLTableCellElement): string | null {
  const x = Number(td.getAttribute('data-x'));
  const y = Number(td.getAttribute('data-y'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return cellName(x, y);
}

function sanitizeCss(css: string): string {
  return canonicalCss(css);
}

function captureSnapshot(inst: JssInstance, name: string, prev: SheetSnapshot): SheetSnapshot {
  const data = inst.options.data ?? [];
  const rows = data.length;
  const cols = data.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);

  const css: Record<string, string> = {};
  const styleMap = (inst.getStyle() ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(styleMap)) {
    const clean = sanitizeCss(String(v ?? ''));
    if (clean) css[k] = clean;
  }

  // computed results of formula cells (cached into the file on save)
  const labels: Record<string, string> = {};
  for (let y = 0; y < rows; y++) {
    const row = data[y] ?? [];
    for (let x = 0; x < cols; x++) {
      const v = row[x];
      if (typeof v === 'string' && v.trim().startsWith('=')) {
        labels[`${x}:${y}`] = stripHtml(String(inst.getLabelFromCoords(x, y) ?? '')).trim();
      }
    }
  }

  const merges: Record<string, [number, number]> = {};
  for (const [anchor, span] of Object.entries(inst.options.mergeCells ?? {})) {
    if (Array.isArray(span)) merges[anchor] = [Number(span[0]) || 1, Number(span[1]) || 1];
  }

  const widths = (inst.getWidth() ?? []) as string[];
  const colWidths: (number | undefined)[] = [];
  for (let i = 0; i < cols; i++) {
    const w = parseInt(String(widths[i] ?? ''), 10);
    colWidths.push(Number.isFinite(w) && w > 0 ? w : undefined);
  }
  const heights = (inst.getHeight() ?? []) as string[];
  const rowHeights: (number | undefined)[] = [];
  for (let i = 0; i < rows; i++) {
    const h = parseInt(String(heights[i] ?? ''), 10);
    rowHeights.push(Number.isFinite(h) && h > 0 ? h : undefined);
  }

  return {
    name,
    rows,
    cols,
    grid: data.map((r) => [...(r ?? [])]),
    css,
    labels,
    merges,
    colWidths,
    rowHeights,
    truncated: prev.truncated,
  };
}

// ---------------------------------------------------------------------------
// SAVE — snapshot (diffed against pristine) → ExcelJS worksheet
// ---------------------------------------------------------------------------
function cssToExcelStyle(css: string, numFmt?: string): Partial<XCell['style']> {
  const d = parseCss(css);
  const style: Record<string, unknown> = {};
  if (numFmt) style.numFmt = numFmt;

  const bg = cssColorToHex(d['background-color']);
  if (bg) style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${bg}` } };

  const fc = cssColorToHex(d.color);
  const fw = d['font-weight'];
  const fst = d['font-style'];
  const deco = d['text-decoration'];
  const sizeM = /^([0-9.]+)pt$/i.exec(d['font-size'] ?? '');
  const family = d['font-family'];
  if (fc || fw || fst || deco || sizeM || family) {
    const font: Record<string, unknown> = {};
    if (fc) font.color = { argb: `FF${fc}` };
    if (fw) font.bold = fw !== 'normal' && fw !== '400' && fw !== 'lighter';
    if (fst) font.italic = fst === 'italic';
    if (deco) {
      font.underline = deco.includes('underline') || undefined;
      font.strike = deco.includes('line-through') || undefined;
    }
    if (sizeM) font.size = Number(sizeM[1]);
    if (family) {
      const name = (family.split(',')[0] ?? '').replace(/['"]/g, '').trim();
      if (name) font.name = name;
    }
    style.font = font;
  }

  const ta = d['text-align'];
  const va = d['vertical-align'];
  if (ta === 'left' || ta === 'center' || ta === 'right' || va === 'top' || va === 'middle' || va === 'bottom') {
    const alignment: Record<string, string> = {};
    if (ta === 'left' || ta === 'center' || ta === 'right') alignment.horizontal = ta;
    if (va === 'top' || va === 'middle' || va === 'bottom') alignment.vertical = va;
    style.alignment = alignment;
  }

  const border: Record<string, unknown> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const b = cssBorderToExcel(d[`border-${side}`]);
    if (b) border[side] = b;
  }
  if (Object.keys(border).length) style.border = border;

  return style as Partial<XCell['style']>;
}

/** raw grid content → a typed exceljs value (formulas get a cached result). */
function typedValue(raw: Raw, shown: string | undefined): unknown {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '');
  if (s.trim().startsWith('=')) {
    const formula = s.trim().slice(1);
    const text = stripHtml(shown ?? '').trim();
    if (!text || text.startsWith('#')) return { formula };
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isNaN(n)) return { formula, result: n };
    return { formula, result: text };
  }
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

function mergeRange(anchor: string, span: [number, number]): string | null {
  const a = parseCellName(anchor);
  if (!a) return null;
  return `${anchor}:${cellName(a.x + Math.max(1, span[0]) - 1, a.y + Math.max(1, span[1]) - 1)}`;
}

/** Write the current snapshot into a worksheet, touching ONLY what changed
 *  against the pristine state — untouched cells keep their original Excel
 *  styling bit-for-bit (number formats, exotic fonts, …). */
function patchSheet(ws: XWorksheet, cur: SheetSnapshot, orig: SheetSnapshot | null): void {
  const rows = Math.max(cur.rows, orig?.rows ?? 0);
  const cols = Math.max(cur.cols, orig?.cols ?? 0);

  // 1) dissolve the original merges so cells can be written / re-merged
  if (orig) {
    for (const [anchor, span] of Object.entries(orig.merges)) {
      const range = mergeRange(anchor, span);
      if (range) {
        try { ws.unMergeCells(range); } catch { /* already dissolved */ }
      }
    }
  }

  // 2) values — only where they differ from the loaded state (formula cells
  //    cache the computed result that was captured with the grid)
  for (let y = 0; y < rows; y++) {
    const curRow = cur.grid[y] ?? [];
    const origRow = orig?.grid[y];
    for (let x = 0; x < cols; x++) {
      const cv = curRow[x] ?? '';
      const ov = orig ? (origRow?.[x] ?? '') : undefined;
      if (ov !== undefined && cv === ov) {
        // content unchanged — but a formula's cached result may be stale
        // after its INPUT cells were edited; refresh the cache so even
        // viewers that do not recalculate show the current number
        if (typeof cv === 'string' && cv.trim().startsWith('=')) {
          const label = cur.labels[`${x}:${y}`];
          if (label) {
            const cell = ws.getCell(y + 1, x + 1);
            const val = cell.value as { formula?: string; result?: unknown } | null;
            const prev = val && typeof val === 'object' && 'formula' in val ? String(val.result ?? '') : undefined;
            if (prev !== undefined && label !== prev) {
              cell.value = typedValue(cv, label) as never;
            }
          }
        }
        continue;
      }
      const cell = ws.getCell(y + 1, x + 1);
      if (cv === '' || cv == null) {
        cell.value = null;
      } else {
        const shown = cur.labels[`${x}:${y}`];
        cell.value = typedValue(cv, shown) as never;
      }
    }
  }

  // 3) styling — only where it differs from the loaded state
  const names = new Set([...Object.keys(orig?.css ?? {}), ...Object.keys(cur.css)]);
  for (const name of names) {
    const cv = cur.css[name] ?? '';
    const ov = orig?.css[name] ?? '';
    if (cv === ov) continue;
    const at = parseCellName(name);
    if (!at || at.y >= rows || at.x >= cols) continue;
    const cell = ws.getCell(at.y + 1, at.x + 1);
    const keep = (cell.style as { numFmt?: string } | undefined)?.numFmt;
    cell.style = (cv ? cssToExcelStyle(cv, keep) : {}) as XCell['style'];
  }

  // 4) apply the current merges (non-anchor cells are empty in the grid)
  for (const [anchor, span] of Object.entries(cur.merges)) {
    const range = mergeRange(anchor, span);
    if (!range) continue;
    const a = parseCellName(anchor);
    if (!a || a.y >= rows || a.x >= cols) continue;
    try { ws.mergeCells(range); } catch { /* overlapping / edge case — keep the rest */ }
  }

  // 5) sizes — only the columns / rows the user actually resized
  const maxW = Math.max(cur.colWidths.length, orig?.colWidths.length ?? 0);
  for (let x = 0; x < maxW; x++) {
    const cw = cur.colWidths[x];
    if (cw != null && cw !== orig?.colWidths?.[x]) ws.getColumn(x + 1).width = pxToChars(cw);
  }
  const maxH = Math.max(cur.rowHeights.length, orig?.rowHeights.length ?? 0);
  for (let y = 0; y < maxH; y++) {
    const ch = cur.rowHeights[y];
    if (ch != null && ch !== orig?.rowHeights?.[y]) ws.getRow(y + 1).height = pxToPt(ch);
  }
}

async function buildOutput(parsed: ParsedDoc): Promise<Uint8Array> {
  const { Workbook } = (await import('exceljs')) as unknown as {
    Workbook: new () => XWorkbook;
  };
  let wb: XWorkbook;
  let sheets: { ws: XWorksheet; cur: SheetSnapshot; orig: SheetSnapshot | null }[];

  if (parsed.workbook) {
    wb = parsed.workbook;
    sheets = parsed.sheets.map((snap, i) => ({
      ws: wb.worksheets[i] ?? wb.addWorksheet(snap.name),
      cur: snap,
      orig: parsed.pristine[i] ?? null,
    }));
  } else {
    wb = new Workbook();
    wb.created = new Date();
    sheets = parsed.sheets.map((snap) => ({ ws: wb.addWorksheet(snap.name), cur: snap, orig: null }));
  }
  // let Excel refresh formulas when the file opens
  wb.calcProperties = { ...wb.calcProperties, fullCalcOnLoad: true } as XWorkbook['calcProperties'];

  for (const { ws, cur, orig } of sheets) patchSheet(ws, cur, orig);

  const buf = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
interface ToolState {
  fill: string | null;
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  fontFamily?: string;
  fontSize?: string;
  count: number;
  merged: boolean;
  canMerge: boolean;
}

export function TimesheetEditorDialog({
  doc,
  bytes,
  onClose,
  onSaved,
}: {
  doc: SiteDoc;
  /** the downloaded file bytes */
  bytes: ArrayBuffer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [parsed, setParsed] = useState<ParsedDoc | null | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tools, setTools] = useState<ToolState | null>(null);

  // the editor fills the whole screen EXCEPT the side menu — it matches the
  // sidebar's animated width (264px open / 76px collapsed, 0 on mobile)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const isMobile = useIsMobile();
  const edge = { left: isMobile ? 0 : sidebarOpen ? 264 : 76 };

  const gridHostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<JssInstance | null>(null);
  const parsedRef = useRef<ParsedDoc | null | undefined>(undefined);
  const activeRef = useRef(0);

  activeRef.current = active;

  // ---- parse (async — ExcelJS is a dynamic chunk) ----
  useEffect(() => {
    let alive = true;
    setParsed(undefined);
    setActive(0);
    setDirty(false);
    setError(null);
    parseDoc(bytes).then((p) => {
      if (!alive) return;
      parsedRef.current = p;
      setParsed(p);
    });
    return () => { alive = false; };
  }, [bytes]);

  // ---- read the live grid into the snapshot model ----
  const captureActive = useCallback(() => {
    const inst = instanceRef.current;
    const p = parsedRef.current;
    if (!inst || !p) return;
    const idx = activeRef.current;
    const snap = p.sheets[idx];
    if (!snap) return;
    p.sheets[idx] = captureSnapshot(inst, snap.name, snap);
  }, []);

  const refreshTools = useCallback(() => {
    const inst = instanceRef.current;
    if (!inst) { setTools(null); return; }
    const cells = inst.getHighlighted();
    if (!cells.length) { setTools(null); return; }
    const first = tdName(cells[0]);
    if (!first) { setTools(null); return; }
    const d = parseCss(String(inst.getStyle(first) ?? ''));
    const merged = findMergeAnchor(inst, cells[0]) !== null;
    const sizeM = /^([\d.]+)pt$/i.exec(d['font-size'] ?? '');
    const va = d['vertical-align'];
    setTools({
      fill: cssColorToHex(d['background-color']),
      color: cssColorToHex(d.color),
      bold: !!d['font-weight'] && d['font-weight'] !== 'normal' && d['font-weight'] !== '400',
      italic: d['font-style'] === 'italic',
      underline: (d['text-decoration'] ?? '').includes('underline'),
      align: d['text-align'] === 'left' || d['text-align'] === 'center' || d['text-align'] === 'right' ? d['text-align'] : undefined,
      vAlign: va === 'top' || va === 'middle' || va === 'bottom' ? va : undefined,
      fontFamily: d['font-family'] ? d['font-family'].replace(/["']/g, '').trim() : undefined,
      fontSize: sizeM ? `${Number(sizeM[1])}pt` : undefined,
      count: cells.length,
      merged,
      canMerge: cells.length > 1,
    });
  }, []);

  // ---- (re)build the grid for the active sheet ----
  useEffect(() => {
    const host = gridHostRef.current;
    const p = parsed;
    if (!host || !p || p.sheets.length === 0) return;
    const snap = p.sheets[active] ?? p.sheets[0];
    if (!snap) return;

    const padCols = Math.max(snap.cols + 3, 10);
    const padRows = Math.max(snap.rows + 6, 24);
    const rowsRecord: Record<number, { height: number }> = {};
    snap.rowHeights.forEach((h, i) => { if (h != null) rowsRecord[i] = { height: h }; });

    host.innerHTML = '';
    // jspreadsheet stamps the column alignment on every cell — use 'left'
    // (Excel's default) so canonicalCss can tell "grid default" apart from
    // a real centre/right alignment coming from the file or the toolbar.
    //
    // `root: host` scopes the grid's document-level mouse handlers to the
    // grid area itself. Without it jspreadsheet attaches them to `document`,
    // and every click on the formatting toolbar cleared the cell selection
    // before the style could be applied (fills / alignment "did nothing").
    let initializing = true;
    const markDirty = () => { if (!initializing) setDirty(true); };
    try {
      instanceRef.current = jspreadsheet(host, {
        root: host,
        data: snap.grid.map((r) => [...r]) as unknown as (string | number | boolean)[][],
        minDimensions: [padCols, padRows],
        columns: Array.from({ length: padCols }, (_, i) => ({
          align: 'left' as const,
          ...(snap.colWidths[i] != null ? { width: snap.colWidths[i]! } : {}),
        })),
        rows: rowsRecord,
        mergeCells: Object.fromEntries(
          Object.entries(snap.merges).map(([k, v]) => [k, [v[0], v[1]]]),
        ),
        style: { ...snap.css },
        tableOverflow: true,
        tableWidth: '100%',
        tableHeight: '100%',
        about: false,
        rowResize: true,
        columnResize: true,
        columnSorting: false,
        rowDrag: false,
        columnDrag: false,
        onchange: markDirty,
        onchangestyle: markDirty,
        onmerge: markDirty,
        onresizecolumn: markDirty,
        onresizerow: markDirty,
        oninsertrow: markDirty,
        oninsertcolumn: markDirty,
        ondeleterow: markDirty,
        ondeletecolumn: markDirty,
        onpaste: markDirty,
        onmoverow: markDirty,
        onmovecolumn: markDirty,
        onselection: () => refreshTools(),
      }) as unknown as JssInstance;
      // jss fires events while applying merges/styles at init — those are
      // not user edits; clear the guard once the dust settles
      setTimeout(() => { initializing = false; }, 250);
      refreshTools();
    } catch {
      setError('This spreadsheet could not be opened in the editor.');
    }
    return () => {
      captureActive(); // keep any live edits in the snapshot model
      instanceRef.current = null;
      host.innerHTML = '';
    };
  }, [parsed, active, captureActive, refreshTools]);

  const switchSheet = (idx: number) => {
    if (idx === active) return;
    captureActive();
    setActive(idx);
  };

  // ---- toolbar actions ----
  const withSelection = (fn: (inst: JssInstance, cells: HTMLTableCellElement[]) => void) => {
    const inst = instanceRef.current;
    if (!inst) return;
    const cells = inst.getHighlighted();
    if (!cells.length) return;
    fn(inst, cells);
  };

  const applyStyle = (prop: string, value: string) => {
    withSelection((inst, cells) => {
      inst.setStyle(cells, prop, value);
      setDirty(true);
      refreshTools();
    });
  };

  const toggleFont = (prop: string, on: string) => {
    withSelection((inst, cells) => {
      const first = tdName(cells[0]);
      const d = parseCss(String(first ? inst.getStyle(first) ?? '' : ''));
      const isOn = prop === 'font-weight'
        ? !!d['font-weight'] && d['font-weight'] !== 'normal' && d['font-weight'] !== '400'
        : prop === 'font-style'
          ? d['font-style'] === 'italic'
          : (d['text-decoration'] ?? '').includes('underline');
      inst.setStyle(cells, prop, isOn ? 'normal' : on);
      setDirty(true);
      refreshTools();
    });
  };

  const toggleMerge = () => {
    withSelection((inst, cells) => {
      const anchor = findMergeAnchor(inst, cells[0]);
      if (anchor) {
        inst.removeMerge(anchor);
        setDirty(true);
      } else if (cells.length > 1) {
        inst.setMerge();
        setDirty(true);
      }
      refreshTools();
    });
  };

  /** apply a border preset to the current selection ('outer' walks the
   *  selection rectangle and only borders its perimeter). */
  const applyBorders = (mode: BorderMode) => {
    withSelection((inst, cells) => {
      const B = '1px solid #000000';
      const SIDES = ['top', 'right', 'bottom', 'left'] as const;
      if (mode === 'all' || mode === 'none') {
        for (const s of SIDES) inst.setStyle(cells, `border-${s}`, mode === 'all' ? B : 'none');
      } else if (mode === 'outer') {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const td of cells) {
          const x = Number(td.getAttribute('data-x'));
          const y = Number(td.getAttribute('data-y'));
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        for (const td of cells) {
          const x = Number(td.getAttribute('data-x'));
          const y = Number(td.getAttribute('data-y'));
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const sides: string[] = [];
          if (y === minY) sides.push('border-top');
          if (y === maxY) sides.push('border-bottom');
          if (x === minX) sides.push('border-left');
          if (x === maxX) sides.push('border-right');
          for (const p of sides) inst.setStyle([td], p, B);
        }
      } else {
        inst.setStyle(cells, `border-${mode}`, B);
      }
      setDirty(true);
      refreshTools();
    });
  };

  const save = async () => {
    const p = parsedRef.current;
    if (!p) return;
    setSaving(true);
    setError(null);
    try {
      captureActive();
      const out = await buildOutput(p);
      // always saved as .xlsx (legacy .xls / .csv become real xlsx) — the
      // upload replaces the slot, so a stale .xls twin is removed too
      const name = `timesheet-${doc.month}.xlsx`;
      const file = new File([out as unknown as BlobPart], name, { type: XLSX_MIME });
      await uploadSiteDoc(doc.siteId, doc.month, 'timesheet', file);
      setDirty(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the timesheet.');
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    captureActive(); // keep edits in the in-memory model while open
    onClose();
  };

  // ---- render ----
  if (parsed === undefined) {
    return createPortal(
      <div className="fixed inset-y-0 right-0 z-50 flex items-center justify-center bg-background transition-[left] duration-300" style={edge}>
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-6 py-4 shadow-2xl">
          <Loader2 className="size-5 animate-spin text-brand" />
          <p className="text-sm font-medium">Opening the spreadsheet…</p>
        </div>
      </div>,
      document.body,
    );
  }

  if (parsed === null || parsed.sheets.length === 0) {
    return createPortal(
      <div className="fixed inset-y-0 right-0 z-50 flex items-center justify-center bg-background p-4 transition-[left] duration-300" style={edge}>
        <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 text-center shadow-2xl">
          <TriangleAlert className="mx-auto size-10 text-amber-500" />
          <p className="mt-3 text-sm font-semibold">This file is not a readable spreadsheet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {doc.name} could not be parsed as XLSX / XLS / CSV. You can still download it.
          </p>
          <Button variant="outline" className="mt-4" onClick={onClose}>Close</Button>
        </div>
      </div>,
      document.body,
    );
  }

  const sheetNames = parsed.sheets.map((s) => s.name);

  return createPortal(
    <div
      className="fixed inset-y-0 right-0 z-50 flex flex-col bg-background transition-[left] duration-300"
      style={edge}
      role="dialog"
      aria-label="Timesheet editor"
    >
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden border-l border-border bg-card">
        {/* header */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <SheetIcon className="size-5 shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" title={doc.name}>{doc.name}</p>
            <p className="text-[11px] text-muted-foreground">
              Editable spreadsheet — formulas like <code className="rounded bg-muted px-1">=SUM(A1:A31)</code> recalculate live; colours, fonts, borders, merges and sizes are saved
            </p>
          </div>
          {sheetNames.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-background/60 p-1">
              {sheetNames.map((n, i) => (
                <button
                  key={`${n}-${i}`}
                  type="button"
                  onClick={() => switchSheet(i)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                    i === active ? 'brand-gradient text-brand-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          {dirty && <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">unsaved</span>}
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={close} aria-label="Close editor">
            <X className="size-4" />
          </Button>
        </div>

        {/* style toolbar */}
        {/* The mousedown guard is belt-and-braces (grid events are scoped to
            the grid host via the `root` option); the keydown guard stops the
            grid from hijacking arrow keys while a toolbar dropdown is focused. */}
        <div
          className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.nativeEvent.stopImmediatePropagation()}
        >
          <ToolbarSelect
            title="Font"
            value={tools?.fontFamily ?? ''}
            placeholder="Font"
            options={FONT_FAMILIES.map((f) => ({ value: f, label: f, style: { fontFamily: f } }))}
            disabled={!tools}
            onPick={(v) => applyStyle('font-family', `'${v}'`)}
          />
          <ToolbarSelect
            title="Font size"
            value={tools?.fontSize ?? ''}
            placeholder="Size"
            options={FONT_SIZES.map((s) => ({ value: `${s}pt`, label: String(s) }))}
            disabled={!tools}
            onPick={(v) => applyStyle('font-size', v)}
            className="w-[4.25rem]"
          />
          <ToolbarDivider />
          <ColorSwatchButton
            title="Fill colour"
            icon={<PaintBucket className="size-3.5" />}
            value={tools?.fill ?? undefined}
            onPick={(hex) => applyStyle('background-color', hex)}
            onClear={() => applyStyle('background-color', 'transparent')}
            disabled={!tools}
          />
          <ColorSwatchButton
            title="Text colour"
            icon={<Baseline className="size-3.5" />}
            value={tools?.color ?? undefined}
            onPick={(hex) => applyStyle('color', hex)}
            onClear={() => applyStyle('color', 'inherit')}
            disabled={!tools}
          />
          <ToolbarDivider />
          <ToolbarToggle title="Bold" active={!!tools?.bold} disabled={!tools} onClick={() => toggleFont('font-weight', 'bold')}>
            <Bold className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Italic" active={!!tools?.italic} disabled={!tools} onClick={() => toggleFont('font-style', 'italic')}>
            <Italic className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Underline" active={!!tools?.underline} disabled={!tools} onClick={() => toggleFont('text-decoration', 'underline')}>
            <Underline className="size-3.5" />
          </ToolbarToggle>
          <ToolbarDivider />
          <ToolbarToggle title="Align left" active={tools?.align === 'left'} disabled={!tools} onClick={() => applyStyle('text-align', 'left')}>
            <AlignLeft className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Align centre" active={tools?.align === 'center'} disabled={!tools} onClick={() => applyStyle('text-align', 'center')}>
            <AlignCenter className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Align right" active={tools?.align === 'right'} disabled={!tools} onClick={() => applyStyle('text-align', 'right')}>
            <AlignRight className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Align top" active={tools?.vAlign === 'top'} disabled={!tools} onClick={() => applyStyle('vertical-align', 'top')}>
            <AlignStartVertical className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Align middle" active={tools?.vAlign === 'middle'} disabled={!tools} onClick={() => applyStyle('vertical-align', 'middle')}>
            <AlignCenterVertical className="size-3.5" />
          </ToolbarToggle>
          <ToolbarToggle title="Align bottom" active={tools?.vAlign === 'bottom'} disabled={!tools} onClick={() => applyStyle('vertical-align', 'bottom')}>
            <AlignEndVertical className="size-3.5" />
          </ToolbarToggle>
          <ToolbarDivider />
          <ToolbarSelect
            title="Borders"
            value=""
            placeholder="Borders"
            options={BORDER_MODES.map((m) => ({ value: m.id, label: m.label }))}
            disabled={!tools}
            onPick={(v) => applyBorders(v as BorderMode)}
          />
          <ToolbarToggle
            title={tools?.merged ? 'Unmerge cells' : 'Merge selected cells'}
            active={!!tools?.merged}
            disabled={!tools || (!tools.merged && !tools.canMerge)}
            onClick={toggleMerge}
          >
            {tools?.merged ? <TableCellsSplit className="size-3.5" /> : <TableCellsMerge className="size-3.5" />}
          </ToolbarToggle>
          <span className="ml-auto hidden pr-1 text-[10px] text-muted-foreground sm:block">
            {tools ? `${tools.count} cell${tools.count === 1 ? '' : 's'} selected` : 'select cells to style them'}
          </span>
        </div>

        {/* the sheet — always paper-white so it reads like a real spreadsheet */}
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-100 p-2 dark:bg-neutral-900">
          <div className="mx-auto max-w-full rounded-lg bg-white text-black shadow-md [&_.jspreadsheet]:text-[13px]">
            <div ref={gridHostRef} />
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {error ? (
            <p className="min-w-0 flex-1 break-words rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</p>
          ) : (
            <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              Saving replaces this month&apos;s timesheet file — values, formulas, merged cells, colours, fonts, borders, column widths and row heights are all kept.
              {parsed.sheets[active]?.truncated ? ' (Very large sheet — only the first part is shown; the rest of the file is untouched.)' : ''}
            </p>
          )}
          <Button variant="outline" onClick={close} disabled={saving}>Close</Button>
          <Button className="gap-2" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save &amp; Upload
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Toolbar primitives
// ---------------------------------------------------------------------------
function ToolbarDivider() {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden />;
}

/** compact native <select> for font / size / borders — reliable, keyboard
 *  friendly and opens in place (no portal z-index fights with the overlay). */
function ToolbarSelect({
  title, value, placeholder, options, onPick, disabled, className,
}: {
  title: string;
  value: string;
  placeholder: string;
  options: { value: string; label: string; style?: React.CSSProperties }[];
  onPick: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      title={title}
      aria-label={title}
      disabled={disabled}
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        e.target.value = value || ''; // action selects snap back to the label
        e.currentTarget.blur(); // return focus to the page, not the dropdown
        if (v) onPick(v);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'h-7 max-w-[8.5rem] cursor-pointer truncate rounded-md border border-border bg-background px-1.5 text-[11px] font-medium text-foreground transition-colors hover:border-brand/40 disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value} style={o.style}>{o.label}</option>
      ))}
    </select>
  );
}

function ToolbarToggle({
  title, active, disabled, onClick, children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        active && 'border-border bg-brand/10 text-brand',
      )}
    >
      {children}
    </button>
  );
}

function ColorSwatchButton({
  title, icon, value, onPick, onClear, disabled,
}: {
  title: string;
  icon: React.ReactNode;
  value?: string;
  onPick: (hex: string) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex items-center', disabled && 'pointer-events-none opacity-40')}>
      <label
        title={title}
        className="relative flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {icon}
        <span
          className="size-3.5 rounded-[4px] border border-border shadow-sm"
          style={{ backgroundColor: value ? `#${value}` : 'transparent' }}
        />
        <input
          type="color"
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={value ? `#${value}` : '#ffffff'}
          onChange={(e) => onPick(e.target.value)}
          tabIndex={-1}
          aria-label={title}
        />
      </label>
      {value && (
        <button
          type="button"
          title={`Clear ${title.toLowerCase()}`}
          onClick={onClear}
          className="ml-0.5 flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground"
          aria-label={`Clear ${title.toLowerCase()}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** the anchor of the merge containing this cell, if any. */
function findMergeAnchor(inst: JssInstance, td: HTMLTableCellElement): string | null {
  const at = tdName(td);
  if (!at) return null;
  const p = parseCellName(at);
  if (!p) return null;
  for (const [anchor, span] of Object.entries(inst.options.mergeCells ?? {})) {
    if (!Array.isArray(span)) continue;
    const a = parseCellName(anchor);
    if (!a) continue;
    const cs = Number(span[0]) || 1;
    const rs = Number(span[1]) || 1;
    if (p.x >= a.x && p.x < a.x + cs && p.y >= a.y && p.y < a.y + rs) return anchor;
  }
  return null;
}
