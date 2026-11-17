#!/bin/bash
# Generate bun-compatible patch files for @fortune-sheet/core and react.
# Uses a scratch git repo so the output is a proper git diff (diff --git a/... b/...
# with index lines), the format bun's patchedDependencies expects.
set -euo pipefail

OUT=/home/z/my-project/patches
TMP=$(mktemp -d)

gen() { # $1=pristine dir (files in dist/ or at top)  $2=edited dir (same)  $3=patch output path
  local repo="$TMP/repo-$(basename "$3" | tr -cd 'a-zA-Z0-9')"
  mkdir -p "$repo"
  cd "$repo"
  git init -q .
  git config user.email p@p; git config user.name p
  mkdir -p dist
  if [ -d "$1/dist" ]; then cp "$1"/dist/index.esm.js "$1"/dist/index.js dist/; else cp "$1"/index.esm.js "$1"/index.js dist/; fi
  git add -A && git commit -qm base
  if [ -d "$2/dist" ]; then cp "$2"/dist/index.esm.js "$2"/dist/index.js dist/; else cp "$2"/index.esm.js "$2"/index.js dist/; fi
  git add -A
  # --full-index: bun's patch applier expects full 40-char blob hashes on the
  # index line (same format as `bun patch` itself emits)
  git diff --cached --full-index --no-renames --no-color > "$3"
  echo "wrote $3 ($(grep -c '^diff --git' "$3") file diffs)"
}

mkdir -p "$OUT"

# core: pristine snapshot vs patched node_modules
mkdir -p "$TMP/core-pri/dist" && cp /tmp/fpatch/core/index.esm.js /tmp/fpatch/core/index.js "$TMP/core-pri/dist/"
gen "$TMP/core-pri" /tmp/fpatch/core-edited "$OUT/@fortune-sheet%2Fcore@1.0.4.patch"

# react: pristine (patch1 reversed) vs patched node_modules (patch1 + dark mode)
gen /tmp/fpatch/react-pristine /tmp/fpatch/react-edited "$OUT/@fortune-sheet%2Freact@1.0.4.patch"

rm -rf "$TMP"
