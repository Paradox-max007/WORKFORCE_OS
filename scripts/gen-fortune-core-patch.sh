#!/bin/bash
# Regenerate patches/@fortune-sheet%2Fcore@1.0.4.patch from the current
# node_modules/@fortune-sheet/core dist bundles.
#
#   pristine  = node_modules dist with the COMMITTED patch reverse-applied
#   edited    = node_modules dist as-is (v1 + v2 PULSE patches)
#
# The output is a proper git diff (diff --git + full 40-char index lines),
# the format bun's patchedDependencies expects. Re-runnable at any time.
set -euo pipefail

ROOT=/home/z/my-project
PATCH_FILE="$ROOT/patches/@fortune-sheet%2Fcore@1.0.4.patch"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---- 1. pristine: revert v2, then reverse the committed patch -------------
mkdir -p "$TMP/pristine/dist"
cp "$ROOT/node_modules/@fortune-sheet/core/dist/index.esm.js" "$TMP/pristine/dist/"
cp "$ROOT/node_modules/@fortune-sheet/core/dist/index.js" "$TMP/pristine/dist/"
python3 "$ROOT/scripts/patch-fortune-core.py" --revert-v2 \
  "$TMP/pristine/dist/index.esm.js" "$TMP/pristine/dist/index.js"
# the committed patch only touches the dist files
(cd "$TMP/pristine" && git apply --whitespace=nowarn -R "$PATCH_FILE")

# sanity: pristine must not contain any PULSE markers
if grep -q '__pulseFortune' "$TMP/pristine/dist/index.esm.js"; then
  echo "FAIL: pristine copy still contains PULSE markers — patch did not reverse cleanly" >&2
  exit 1
fi

# ---- 2. edited: the patched node_modules as-is -----------------------------
mkdir -p "$TMP/edited/dist"
cp "$ROOT/node_modules/@fortune-sheet/core/dist/index.esm.js" "$TMP/edited/dist/"
cp "$ROOT/node_modules/@fortune-sheet/core/dist/index.js" "$TMP/edited/dist/"

# ---- 3. git diff pristine -> edited ----------------------------------------
REPO="$TMP/repo"
mkdir -p "$REPO"
cd "$REPO"
git init -q .
git config user.email p@p; git config user.name p
cp -r "$TMP/pristine/dist" ./dist
git add -A && git commit -qm base
cp "$TMP/edited/dist/index.esm.js" "$TMP/edited/dist/index.js" ./dist/
git add -A
git diff --cached --full-index --no-renames --no-color > "$PATCH_FILE"
echo "wrote $PATCH_FILE ($(grep -c '^diff --git' "$PATCH_FILE") file diffs, $(grep -c '^@@' "$PATCH_FILE") hunks)"
