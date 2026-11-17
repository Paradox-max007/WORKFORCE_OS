#!/usr/bin/env python3
"""Patch @fortune-sheet/core dist bundles (esm + cjs) for PULSE dark mode.

Makes the canvas-rendered spreadsheet theme-aware:
  - paper (grid area + default cell bg)  : #ffffff -> #13131c in dark
  - row/column header background         : #ffffff -> #1b1b26 in dark
  - header text + default cell text      : #000000 -> #f2f2f7 in dark
  - gridlines (defaultStyle.strokeStyle) : #dfdfdf -> rgba(255,255,255,.55)
  - default font/border colour (fc/bc)   : #000000 -> #f2f2f7 (normalizedCellAttr)

Dark rendering is active iff <html> has class "dark" and the global
__PULSE_FORTUNE_LIGHT__ escape hatch (used for printing) is not set.
Light-mode output is byte-for-byte identical behaviour (same colours).

Idempotent: running twice changes nothing the second time.
"""
import re
import sys

PAPER = "#13131c"
HEADER_BG = "#1b1b26"
TEXT = "#f2f2f7"
GRIDLINE = "rgba(255, 255, 255, 0.55)"

HELPERS = '''function __pulseFortuneDark() {
  try {
    return typeof document !== "undefined" && document.documentElement.classList.contains("dark") && !(typeof globalThis !== "undefined" && globalThis.__PULSE_FORTUNE_LIGHT__);
  } catch (e) {
    return false;
  }
}
function __pulseFortuneTheme(light, dark) {
  return __pulseFortuneDark() ? dark : light;
}
var defaultStyle = {
  get fillStyle() {
    return __pulseFortuneTheme("#000000", "%s");
  },
  textBaseline: "middle",
  get strokeStyle() {
    return __pulseFortuneTheme("#dfdfdf", "%s");
  },
  get rowFillStyle() {
    return __pulseFortuneTheme("#5e5e5e", "%s");
  },
  textAlign: "center"
};''' % (TEXT, GRIDLINE, TEXT)

OLD_DEFAULT_STYLE = '''var defaultStyle = {
  fillStyle: "#000000",
  textBaseline: "middle",
  strokeStyle: "#dfdfdf",
  rowFillStyle: "#5e5e5e",
  textAlign: "center"
};'''


def die(msg):
    print("FAIL:", msg)
    sys.exit(1)


def must_count(hay, needle, n, what):
    c = hay.count(needle)
    if c != n:
        die("expected %d of %s, found %d" % (n, what, c))


def patch(path):
    with open(path) as f:
        src = f.read()

    if "__pulseFortuneTheme" in src:
        print("already patched:", path)
        return

    # ---- 1. helpers + getter-based defaultStyle --------------------------
    must_count(src, OLD_DEFAULT_STYLE, 1, "defaultStyle block")
    src = src.replace(OLD_DEFAULT_STYLE, HELPERS)

    # ---- 2. row header bg + text (anchored on the row fillRect) ----------
    row_old = (
        'renderCtx.fillStyle = "#ffffff";\n'
        '          renderCtx.fillRect(0, start_r + offsetTop + firstOffset, '
        'this.sheetCtx.rowHeaderWidth - 1, end_r - start_r + 1 + lastOffset - firstOffset);\n'
        '          renderCtx.fillStyle = "#000000";'
    )
    row_new = (
        'renderCtx.fillStyle = __pulseFortuneTheme("#ffffff", "%s");\n'
        '          renderCtx.fillRect(0, start_r + offsetTop + firstOffset, '
        'this.sheetCtx.rowHeaderWidth - 1, end_r - start_r + 1 + lastOffset - firstOffset);\n'
        '          renderCtx.fillStyle = __pulseFortuneTheme("#000000", "%s");'
        % (HEADER_BG, TEXT)
    )
    must_count(src, row_old, 1, "row header block")
    src = src.replace(row_old, row_new)

    # ---- 3. column header bg + text (anchored on the column fillRect) ----
    col_old = (
        'renderCtx.fillStyle = "#ffffff";\n'
        '          renderCtx.fillRect(start_c + offsetLeft - 1, 0, end_c - start_c, '
        'this.sheetCtx.columnHeaderHeight - 1);\n'
        '          renderCtx.fillStyle = "#000000";'
    )
    col_new = (
        'renderCtx.fillStyle = __pulseFortuneTheme("#ffffff", "%s");\n'
        '          renderCtx.fillRect(start_c + offsetLeft - 1, 0, end_c - start_c, '
        'this.sheetCtx.columnHeaderHeight - 1);\n'
        '          renderCtx.fillStyle = __pulseFortuneTheme("#000000", "%s");'
        % (HEADER_BG, TEXT)
    )
    must_count(src, col_old, 1, "column header block")
    src = src.replace(col_old, col_new)

    # ---- 4. main grid paper background ------------------------------------
    paper_old = (
        'renderCtx.fillStyle = "#ffffff";\n'
        '      renderCtx.fillRect(offsetLeft - 1, offsetTop - 1, colEndX - scrollWidth, rowEndY - scrollHeight);'
    )
    paper_new = (
        'renderCtx.fillStyle = __pulseFortuneTheme("#ffffff", "%s");\n'
        '      renderCtx.fillRect(offsetLeft - 1, offsetTop - 1, colEndX - scrollWidth, rowEndY - scrollHeight);'
        % PAPER
    )
    must_count(src, paper_old, 1, "paper background block")
    src = src.replace(paper_old, paper_new)

    # ---- 5. default cell background (nullCellRender + cellRender) --------
    cellbg_old = 'renderCtx.fillStyle = "#FFFFFF";'
    must_count(src, cellbg_old, 2, "default cell bg fill")
    src = src.replace(
        cellbg_old,
        'renderCtx.fillStyle = __pulseFortuneTheme("#FFFFFF", "%s");' % PAPER,
    )

    # ---- 6. dynamic-array spill text (the only remaining one) ------------
    dyn_old = 'renderCtx.fillStyle = "#000000";'
    must_count(src, dyn_old, 1, "dynamic array text fill")
    src = src.replace(
        dyn_old,
        'renderCtx.fillStyle = __pulseFortuneTheme("#000000", "%s");' % TEXT,
    )

    # ---- 7. default font/border colour for unstyled cells ----------------
    norm_old = 'value || (value = "#000000");'
    must_count(src, norm_old, 1, "normalizedCellAttr fc/bc default")
    src = src.replace(
        norm_old,
        'value || (value = __pulseFortuneTheme("#000000", "%s"));' % TEXT,
    )

    with open(path, "w") as f:
        f.write(src)
    print("patched:", path)


targets = sys.argv[1:] or ["node_modules/@fortune-sheet/core/dist/index.esm.js", "node_modules/@fortune-sheet/core/dist/index.js"]
for p in targets:
    patch(p)
