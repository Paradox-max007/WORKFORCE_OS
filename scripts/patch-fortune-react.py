#!/usr/bin/env python3
"""Patch @fortune-sheet/react dist bundles (esm + cjs) for PULSE dark mode.

1. Toolbar icons: the SVG sprite (<symbol> defs) hard-codes dark-slate ink
   (#525C6F / #535A68 / #424A59 / ...) that vanishes on a dark toolbar.
   Ink strokes/fills become `currentColor` (follows CSS `color`), and the
   light-grey secondary strokes (#CCCED2) become the CSS variable
   `--fortune-icon-muted` (set by fortune-theme.css per theme).
   The deliberately-white `filter-fill-white` symbol is left untouched.
2. Border / colour-picker defaults: `useState("#000000")` becomes
   theme-aware (white when <html> is dark) so "apply borders" in dark mode
   produces visible white borders — chosen colours still win.
3. Quick-formula menu rows: hard-coded `#000`/`#666` text becomes
   var(--foreground)/var(--muted-foreground).

Idempotent; light-mode output is unchanged (same colours resolve).
"""
import sys

INK_STROKES = ["#525C6F", "#535A68", "#424A59", "#262A33", "#666"]
INK_FILLS = ["#525C6F", "#535A68", "#394259", "#535B68", "#A6A6A6", "#A8ABB0", "#272636"]
MUTED = "#CCCED2"

# expected counts inside the SVGDefines region (esm and cjs)
EXP_STROKE = {**{k: 0 for k in INK_STROKES}, "#525C6F": 33, "#535A68": 32, "#424A59": 1, "#262A33": 2, "#666": 1}
EXP_FILL = {**{k: 0 for k in INK_FILLS}, "#525C6F": 45, "#535A68": 29, "#394259": 9, "#535B68": 2, "#A6A6A6": 1, "#A8ABB0": 1, "#272636": 1}


def die(msg):
    print("FAIL:", msg)
    sys.exit(1)


def patch(path, use_react_prefix):
    with open(path) as f:
        src = f.read()

    if "var(--fortune-icon-muted" in src:
        print("already patched:", path)
        return

    useState = "React.useState" if use_react_prefix else "useState"

    # ---- 1. theme-aware picker/border colour defaults --------------------
    old = '%s("#000000")' % useState
    new = ('%s((typeof document !== "undefined" && '
           'document.documentElement.classList.contains("dark")) ? "#ffffff" : "#000000")' % useState)
    n = src.count(old)
    if n != 4:
        die("expected 4 %s defaults, found %d in %s" % (useState, n, path))
    src = src.replace(old, new)

    # ---- 2. quick-formula menu row colours -------------------------------
    for key in ("locationConstant", "locationFormula"):
        old = 'color: isSelect("%s") ? "#000" : "#666"' % key
        new = ('color: isSelect("%s") ? "var(--foreground, #000)" : '
               '"var(--muted-foreground, #666)"' % key)
        if src.count(old) != 1:
            die("quick-formula colour anchor missing for %s in %s" % (key, path))
        src = src.replace(old, new)

    # ---- 3. SVG sprite ink -> currentColor (scoped to SVGDefines) --------
    start = src.find("var SVGDefines = function SVGDefines")
    end = src.find("var ChangeColor = function ChangeColor")
    if start == -1 or end == -1 or end <= start:
        die("SVGDefines region not found in %s" % path)
    region = src[start:end]

    for hexc, exp in EXP_STROKE.items():
        needle = 'stroke: "%s"' % hexc
        c = region.count(needle)
        if c != exp:
            die("stroke %s expected %d, found %d in %s" % (hexc, exp, c, path))
        region = region.replace(needle, 'stroke: "currentColor"')

    for hexc, exp in EXP_FILL.items():
        needle = 'fill: "%s"' % hexc
        c = region.count(needle)
        if c != exp:
            die("fill %s expected %d, found %d in %s" % (hexc, exp, c, path))
        region = region.replace(needle, 'fill: "currentColor"')

    muted_needle = 'stroke: "%s"' % MUTED
    if region.count(muted_needle) != 29:
        die("muted stroke count wrong in %s" % path)
    region = region.replace(
        muted_needle, 'stroke: "var(--fortune-icon-muted, %s)"' % MUTED
    )

    # sanity: the white filter symbol must remain untouched
    if 'fill: "#ffffff"' not in region:
        die("filter-fill-white disappeared in %s" % path)

    src = src[:start] + region + src[end:]

    with open(path, "w") as f:
        f.write(src)
    print("patched:", path)


targets = [
    ("node_modules/@fortune-sheet/react/dist/index.esm.js", False),
    ("node_modules/@fortune-sheet/react/dist/index.js", True),
]
if len(sys.argv) > 1:  # explicit file paths override the defaults
    targets = [(p, p.endswith("index.js")) for p in sys.argv[1:]]
for path, use_react_prefix in targets:
    patch(path, use_react_prefix=use_react_prefix)
