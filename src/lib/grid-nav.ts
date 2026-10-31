// ============================================================================
// PULSE Workforce OS — spreadsheet-style keyboard navigation for input grids
// ----------------------------------------------------------------------------
// Shared by the attendance marking sheet (day cells), the bulk-day dialog
// (per-employee value cells) and the printable A4 attendance sheet (editable
// fields). Behaviour is consistent everywhere:
//
//   ↑ / ↓                  move one cell up / down inside the same COLUMN
//   Enter / Shift+Enter    move down / up inside the same column — at the end
//                          of a column Enter blurs the cell (which commits
//                          the value, exactly like the pre-navigation era)
//   ← / →                  move one cell left / right inside the same ROW, but
//                          only when the text caret is already at the edge of
//                          the value, so normal in-cell caret movement keeps
//                          working
//
// Cells that are not <input>s — locked future dates, merged moved-away day
// segments, print-only text cells — are simply skipped: navigation always
// lands on the nearest EDITABLE cell in the chosen direction. Tab keeps its
// native browser behaviour.
// ============================================================================

import type { KeyboardEvent } from 'react';

export interface GridNavConfig {
  /**
   * CSS selector matching every navigable input of THIS grid. Keeps grids
   * that are mounted at the same time (e.g. the sheet behind the bulk-day
   * dialog) in separate navigation pools.
   */
  selector: string;
  /** Column identity: cells with the same value are vertically adjacent. */
  colOf: (el: HTMLInputElement) => unknown;
  /** Row identity: cells with the same value are horizontally adjacent. */
  rowOf: (el: HTMLInputElement) => unknown;
}

export function gridCellKeyDown(e: KeyboardEvent<HTMLInputElement>, cfg: GridNavConfig): void {
  if (e.nativeEvent.isComposing) return; // never hijack IME confirmations

  const key = e.key;
  const vertical = key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter';
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  if (!vertical && !horizontal) return;

  const el = e.currentTarget;
  const pool = Array.from(document.querySelectorAll<HTMLInputElement>(cfg.selector)).filter(
    // skip busy (saving) and hidden cells
    (i) => !i.disabled && i.offsetParent !== null,
  );
  const idx = pool.indexOf(el);
  if (idx < 0) return;

  const focusTarget = (target: HTMLInputElement | undefined): boolean => {
    if (!target) return false;
    target.focus();
    target.select(); // spreadsheet feel: typing overwrites the current value
    return true;
  };

  if (vertical) {
    const down = key === 'ArrowDown' || (key === 'Enter' && !e.shiftKey);
    const col = cfg.colOf(el);
    const candidates = down ? pool.slice(idx + 1) : pool.slice(0, idx).reverse();
    // ↑/↓ have no useful in-cell meaning for these short values
    e.preventDefault();
    if (!focusTarget(candidates.find((i) => cfg.colOf(i) === col)) && key === 'Enter') {
      el.blur(); // end of the column → commit, exactly like the old behaviour
    }
    return;
  }

  // Horizontal: only leave the cell when the caret is already at an edge,
  // so editing the middle of a value with the arrows still works.
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const atLeftEdge = start === 0 && end === 0;
  const atRightEdge = start === el.value.length && end === el.value.length;
  if (key === 'ArrowLeft' && atLeftEdge) {
    const row = cfg.rowOf(el);
    if (focusTarget(pool.slice(0, idx).reverse().find((i) => cfg.rowOf(i) === row))) {
      e.preventDefault();
    }
  } else if (key === 'ArrowRight' && atRightEdge) {
    const row = cfg.rowOf(el);
    if (focusTarget(pool.slice(idx + 1).find((i) => cfg.rowOf(i) === row))) {
      e.preventDefault();
    }
  }
}
