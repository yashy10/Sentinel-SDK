#!/bin/bash
# Sync sentinel-sdk folder to the empty https://github.com/yashy10/Sentinel-SDK repo
# Run from opencode repo root. Uses a temp clone so you don't need to commit sentinel-sdk in opencode.

set -e
REPO_URL="https://github.com/yashy10/Sentinel-SDK.git"
OPencode_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SENTINEL_SRC="$OPencode_ROOT/sentinel-sdk"
TMP_CLONE="${TMPDIR:-/tmp}/Sentinel-SDK-clone"

if [ ! -d "$SENTINEL_SRC" ]; then
  echo "Error: sentinel-sdk not found at $SENTINEL_SRC"
  exit 1
fi

echo "Cloning $REPO_URL into $TMP_CLONE ..."
rm -rf "$TMP_CLONE"
git clone "$REPO_URL" "$TMP_CLONE"
cd "$TMP_CLONE"

echo "Copying sentinel-sdk contents (excluding __pycache__, .pyc, audit.json, playground_sandbox) ..."
rsync -av --delete \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='audit.json' \
  --exclude='playground_sandbox' \
  --exclude='.DS_Store' \
  "$SENTINEL_SRC/" .

echo "Committing and pushing ..."
git add -A
if git diff --staged --quiet; then
  echo "No changes to push."
  exit 0
fi
git commit -m "Initial commit: Sentinel-SDK from opencode"
git push -u origin main
rm -rf "$TMP_CLONE"
echo "Done. See https://github.com/yashy10/Sentinel-SDK"
echo ""
