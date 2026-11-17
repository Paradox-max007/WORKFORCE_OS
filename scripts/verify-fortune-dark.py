#!/usr/bin/env python3
"""Pixel-verify the FortuneSheet dark-mode rendering from screenshots.

Checks regions of the 1600x900 harness page:
  - toolbar strip, column-header band, row-header strip, grid paper,
  - popup surfaces, and presence of light ink (text) on dark surfaces.
"""
import sys
from PIL import Image

def near(c1, c2, tol=28):
    return all(abs(a - b) <= tol for a, b in zip(c1, c2))

def region_colors(img, box, topn=6):
    crop = img.crop(box).convert('RGB')
    colors = crop.getcolors(maxcolors=100000) or []
    colors.sort(reverse=True)
    total = sum(c for c, _ in colors)
    return [(round(100 * c / total, 1), rgb) for c, rgb in colors[:topn]], total

def has_ink(img, box, predicate, min_frac=0.002):
    crop = img.crop(box).convert('RGB')
    data = list(crop.getdata())
    n = sum(1 for p in data if predicate(p))
    return n / max(1, len(data)), n

def analyze(path, mode):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    print(f'== {mode} {path} ({W}x{H}) ==')
    checks = []

    # toolbar strip (below the harness buttons, y ~64..108)
    tb, _ = region_colors(img, (100, 64, W - 100, 104))
    print(' toolbar top colors:', tb[:3])

    # column header band: scan for the header row between toolbar and grid
    # FortuneSheet default header height 25px at ~y 105..130
    ch, _ = region_colors(img, (200, 106, 500, 128))
    print(' column-header colors:', ch[:3])

    # row header strip x 0..45 at grid area
    rh, _ = region_colors(img, (2, 140, 44, 400))
    print(' row-header colors:', rh[:3])

    # grid paper (empty area right of data)
    gp, _ = region_colors(img, (700, 150, 1100, 350))
    print(' grid-paper colors:', gp[:3])

    # text ink inside the used grid area
    if mode == 'dark':
        ok_paper = any(near(rgb, (19, 19, 28)) for _, rgb in gp)
        ok_header = any(near(rgb, (27, 27, 38), 20) for _, rgb in ch) or any(near(rgb, (27, 27, 38), 20) for _, rgb in rh)
        frac, n = has_ink(img, (60, 140, 640, 340), lambda p: p[0] > 200 and p[1] > 200 and p[2] > 200)
        ok_ink = frac > 0.004
        # toolbar icons: light strokes present on dark toolbar
        tfrac, _ = has_ink(img, (100, 66, W - 100, 102), lambda p: p[0] > 150 and p[1] > 150 and p[2] > 150)
        ok_toolbar_icons = tfrac > 0.001
        print(f' paper #13131c: {ok_paper} | headers #1b1b26: {ok_header} | light text frac={frac:.4f} ({ok_ink}) | toolbar light ink frac={tfrac:.4f} ({ok_toolbar_icons})')
        checks = [ok_paper, ok_header, ok_ink, ok_toolbar_icons]
    else:
        ok_paper = any(near(rgb, (255, 255, 255), 6) for _, rgb in gp)
        frac, n = has_ink(img, (60, 140, 640, 340), lambda p: p[0] < 90 and p[1] < 90 and p[2] < 90)
        ok_ink = frac > 0.004
        print(f' paper white: {ok_paper} | dark text frac={frac:.4f} ({ok_ink})')
        checks = [ok_paper, ok_ink]

    print(' RESULT:', 'PASS' if all(checks) else 'FAIL')
    return all(checks)

if __name__ == '__main__':
    ok = True
    for path, mode in [(sys.argv[1], sys.argv[2])]:
        ok = analyze(path, mode) and ok
    sys.exit(0 if ok else 1)
