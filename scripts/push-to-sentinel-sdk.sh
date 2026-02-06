#!/bin/bash
# Push the sentinel-sdk code to https://github.com/yashy10/Sentinel-SDK
# Run from the opencode repo root.

set -e
SENTINEL_REMOTE="${SENTINEL_REMOTE:-sentinel-sdk}"
SENTINEL_REPO="https://github.com/yashy10/Sentinel-SDK.git"

echo "Routing sentinel-sdk code to $SENTINEL_REPO"

# Add remote if not present
if ! git remote get-url "$SENTINEL_REMOTE" 2>/dev/null; then
  git remote add "$SENTINEL_REMOTE" "$SENTINEL_REPO"
  echo "Added remote: $SENTINEL_REMOTE"
fi

# Ensure sentinel-sdk is tracked (add and commit if needed)
if [ -z "$(git ls-files sentinel-sdk/)" ]; then
  echo "Adding sentinel-sdk to git..."
  git add sentinel-sdk/
  git status sentinel-sdk/
  echo ""
  echo "Commit the above with: git commit -m 'Add Sentinel-SDK package'"
  echo "Then run this script again to push to $SENTINEL_REPO"
  exit 0
fi

# Export only sentinel-sdk to a branch and push to Sentinel-SDK repo
BRANCH="sentinel-sdk-export"
git subtree split --prefix=sentinel-sdk -b "$BRANCH"
git push "$SENTINEL_REMOTE" "$BRANCH:main"
git branch -D "$BRANCH"
echo "Pushed to $SENTINEL_REMOTE (main)"
echo "Repo: $SENTINEL_REPO"
