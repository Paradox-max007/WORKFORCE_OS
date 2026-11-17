#!/usr/bin/env python3
"""Patch @fortune-sheet/core dist bundles (esm + cjs) for PULSE dark mode.

v1 — theme-aware canvas chrome:
  - paper (grid area + default cell bg)  : #ffffff -> #13131c in dark
  - row/column header background         : #ffffff -> #1b1b26 in dark
  - header text + default cell text      : #000000 -> #f2f2f7 in dark
  - gridlines (defaultStyle.strokeStyle) : #dfdfdf -> rgba(255,255,255,.55)
  - default font/border colour (fc/bc)   : #000000 -> #f2f2f7 (normalizedCellAttr)

v2 — uploaded documents go dark too (display-only, nothing is re-saved):
  - white-ish GREY cell fills (the default fill real Excel files carry, e.g.
    #ffffff / #f2f2f2 / #e7e6e6) render as the dark paper instead of chips of
    white — chromatic fills (yellow, green, brand…) still win untouched
  - black-ish GREY font colours on paper (no fill / white-ish fill) render as
    the light theme ink, so text inside uploaded files stays readable
  - black-ish GREY border colours render as light ink (borders white in dark)
  - the data-verification checkbox stroke follows the theme ink

Dark rendering is active iff <html> has class "dark" and the global
__PULSE_FORTUNE_LIGHT__ escape hatch (used for printing) is not set.
Light-mode output is byte-for-byte identical behaviour (same colours).

Idempotent: running twice changes nothing the second time (v1 and v2 are
detected and skipped independently, so a v1-patched tree only receives v2).
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

# ---- v2 helpers: colour maths for paper-fill / dark-ink decisions ----------
V2_HELPERS = r'''function __pulseFortuneRgb(color) {
  try {
    if (!color || typeof color !== "string") return null;
    var t = color.trim();
    var m6 = /^#?([0-9a-f]{6})$/i.exec(t);
    if (m6) {
      return [parseInt(m6[1].slice(0, 2), 16), parseInt(m6[1].slice(2, 4), 16), parseInt(m6[1].slice(4, 6), 16)];
    }
    var m3 = /^#?([0-9a-f]{3})$/i.exec(t);
    if (m3) {
      return [parseInt(m3[1].charAt(0) + m3[1].charAt(0), 16), parseInt(m3[1].charAt(1) + m3[1].charAt(1), 16), parseInt(m3[1].charAt(2) + m3[1].charAt(2), 16)];
    }
    var mrgb = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(t);
    if (mrgb) return [+mrgb[1], +mrgb[2], +mrgb[3]];
    return null;
  } catch (e) {
    return null;
  }
}
function __pulseFortuneIsGrey(rgb) {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]) <= 10;
}
function __pulseFortunePaperFill(color) {
  try {
    if (!__pulseFortuneDark()) return false;
    var rgb = __pulseFortuneRgb(color);
    return !!rgb && __pulseFortuneIsGrey(rgb) && Math.min(rgb[0], rgb[1], rgb[2]) >= 225;
  } catch (e) {
    return false;
  }
}
function __pulseFortuneDarkInk(color) {
  try {
    if (!__pulseFortuneDark()) return false;
    var rgb = __pulseFortuneRgb(color);
    return !!rgb && __pulseFortuneIsGrey(rgb) && Math.max(rgb[0], rgb[1], rgb[2]) <= 72;
  } catch (e) {
    return false;
  }
}
function __pulseFortuneBorderInk(color) {
  return __pulseFortuneDarkInk(color) ? "#f2f2f7" : color;
}'''

THEME_FN = '''function __pulseFortuneTheme(light, dark) {
  return __pulseFortuneDark() ? dark : light;
}'''


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

    v1_done = "__pulseFortuneTheme" in src
    v2_done = "__pulseFortunePaperFill" in src
    if v1_done and v2_done:
        print("already patched:", path)
        return

    changed = False

    # ================= v1 =================
    if not v1_done:
        # ---- 1. helpers + getter-based defaultStyle ----------------------
        must_count(src, OLD_DEFAULT_STYLE, 1, "defaultStyle block")
        src = src.replace(OLD_DEFAULT_STYLE, HELPERS)
        changed = True

        # ---- 2. row header bg + text (anchored on the row fillRect) ------
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

        # ---- 3. column header bg + text (anchored on the column fillRect)
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

        # ---- 4. main grid paper background --------------------------------
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

        # ---- 5. default cell background (nullCellRender + cellRender) ----
        cellbg_old = 'renderCtx.fillStyle = "#FFFFFF";'
        must_count(src, cellbg_old, 2, "default cell bg fill")
        src = src.replace(
            cellbg_old,
            'renderCtx.fillStyle = __pulseFortuneTheme("#FFFFFF", "%s");' % PAPER,
        )

        # ---- 6. dynamic-array spill text (the only remaining one) --------
        dyn_old = 'renderCtx.fillStyle = "#000000";'
        must_count(src, dyn_old, 1, "dynamic array text fill")
        src = src.replace(
            dyn_old,
            'renderCtx.fillStyle = __pulseFortuneTheme("#000000", "%s");' % TEXT,
        )

        # ---- 7. default font/border colour for unstyled cells ------------
        norm_old = 'value || (value = "#000000");'
        must_count(src, norm_old, 1, "normalizedCellAttr fc/bc default")
        src = src.replace(
            norm_old,
            'value || (value = __pulseFortuneTheme("#000000", "%s"));' % TEXT,
        )

    # ================= v2 =================
    if not v2_done:
        # ---- 8. colour-maths helpers (after __pulseFortuneTheme) ---------
        must_count(src, THEME_FN, 1, "__pulseFortuneTheme definition")
        src = src.replace(THEME_FN, THEME_FN + "\n" + V2_HELPERS)
        changed = True

        # ---- 9. white-ish fills render as the dark paper ------------------
        # (both nullCellRender and cellRender share this exact block)
        fill_old = (
            'if (!fillStyle) {\n'
            '        renderCtx.fillStyle = __pulseFortuneTheme("#FFFFFF", "%s");\n'
            '      } else {\n'
            '        renderCtx.fillStyle = fillStyle;\n'
            '      }' % PAPER
        )
        fill_new = (
            'if (!fillStyle || __pulseFortunePaperFill(fillStyle)) {\n'
            '        renderCtx.fillStyle = __pulseFortuneTheme("#FFFFFF", "%s");\n'
            '      } else {\n'
            '        renderCtx.fillStyle = fillStyle;\n'
            '      }' % PAPER
        )
        must_count(src, fill_old, 2, "cell bg if/else block")
        src = src.replace(fill_old, fill_new)

        # ---- 10. explicit black-ish fc/bc render as light ink -------------
        norm_old = (
            'if (((_value = value) === null || _value === void 0 ? void 0 : _value.indexOf("rgba")) > -1) {\n'
            '      value = rgbToHex(value);\n'
            '    }'
        )
        norm_new = norm_old + (
            '\n    if (__pulseFortuneDark() && attr !== "bg" && typeof value === "string" && value) {\n'
            '      if (attr === "fc") {\n'
            '        var __pbg = cell === null || cell === void 0 ? void 0 : cell.bg;\n'
            '        if ((!__pbg || __pulseFortunePaperFill(__pbg)) && __pulseFortuneDarkInk(value)) {\n'
            '          value = "#f2f2f7";\n'
            '        }\n'
            '      } else if (__pulseFortuneDarkInk(value)) {\n'
            '        value = "#f2f2f7";\n'
            '      }\n'
            '    }'
        )
        must_count(src, norm_old, 1, "normalizedCellAttr rgba conversion")
        src = src.replace(norm_old, norm_new)

        # ---- 11. borders: black-ish grey strokes read as light ink --------
        border_old = "canvas.strokeStyle = color;"
        must_count(src, border_old, 5, "border stroke color")
        src = src.replace(border_old, "canvas.strokeStyle = __pulseFortuneBorderInk(color);")

        # ---- 12. data-verification checkbox follows the theme ink --------
        cb_old = 'renderCtx.strokeStyle = "#000";'
        must_count(src, cb_old, 1, "checkbox stroke")
        src = src.replace(
            cb_old,
            'renderCtx.strokeStyle = __pulseFortuneTheme("#000", "%s");' % TEXT,
        )

    if changed or not (v1_done and v2_done):
        with open(path, "w") as f:
            f.write(src)
        print("patched:", path)


def revert_v2(path):
    """Undo the v2 edits in place (used to rebuild the pristine bundle before
    regenerating the committed patch file)."""
    with open(path) as f:
        src = f.read()
    if "__pulseFortunePaperFill" not in src:
        print("v2 not present:", path)
        return

    fill_new = (
        'if (!fillStyle || __pulseFortunePaperFill(fillStyle)) {\n'
        '        renderCtx.fillStyle = __pulseFortuneTheme("#FFFFFF", "%s");\n'
        '      } else {\n'
        '        renderCtx.fillStyle = fillStyle;\n'
        '      }' % PAPER
    )
    fill_old = (
        'if (!fillStyle) {\n'
        '        renderCtx.fillStyle = __pulseFortuneTheme("#FFFFFF", "%s");\n'
        '      } else {\n'
        '        renderCtx.fillStyle = fillStyle;\n'
        '      }' % PAPER
    )
    must_count(src, fill_new, 2, "v2 cell bg if/else block")
    src = src.replace(fill_new, fill_old)

    norm_old = (
        'if (((_value = value) === null || _value === void 0 ? void 0 : _value.indexOf("rgba")) > -1) {\n'
        '      value = rgbToHex(value);\n'
        '    }'
    )
    norm_new = norm_old + (
        '\n    if (__pulseFortuneDark() && attr !== "bg" && typeof value === "string" && value) {\n'
        '      if (attr === "fc") {\n'
        '        var __pbg = cell === null || cell === void 0 ? void 0 : cell.bg;\n'
        '        if ((!__pbg || __pulseFortunePaperFill(__pbg)) && __pulseFortuneDarkInk(value)) {\n'
        '          value = "#f2f2f7";\n'
        '        }\n'
        '      } else if (__pulseFortuneDarkInk(value)) {\n'
        '        value = "#f2f2f7";\n'
        '      }\n'
        '    }'
    )
    must_count(src, norm_new, 1, "v2 ink transform block")
    src = src.replace(norm_new, norm_old)

    border_new = "canvas.strokeStyle = __pulseFortuneBorderInk(color);"
    must_count(src, border_new, 5, "v2 border stroke")
    src = src.replace(border_new, "canvas.strokeStyle = color;")

    cb_new = 'renderCtx.strokeStyle = __pulseFortuneTheme("#000", "%s");' % TEXT
    must_count(src, cb_new, 1, "v2 checkbox stroke")
    src = src.replace(cb_new, 'renderCtx.strokeStyle = "#000";')

    must_count(src, THEME_FN + "\n" + V2_HELPERS, 1, "v2 helpers block")
    src = src.replace(THEME_FN + "\n" + V2_HELPERS, THEME_FN)

    with open(path, "w") as f:
        f.write(src)
    print("reverted v2:", path)


targets = sys.argv[1:] or ["node_modules/@fortune-sheet/core/dist/index.esm.js", "node_modules/@fortune-sheet/core/dist/index.js"]
if sys.argv[1:] and sys.argv[1] == "--revert-v2":
    for p in sys.argv[2:]:
        revert_v2(p)
else:
    for p in targets:
        patch(p)
