# Pushing Sentinel-SDK to https://github.com/yashy10/Sentinel-SDK

This folder can be published to the [Sentinel-SDK](https://github.com/yashy10/Sentinel-SDK) repo so the Python harness and docs live there.

## Option A: Add remote and push from opencode repo

From the **opencode repo root** (one level up from this folder):

```bash
# 1. Add the Sentinel-SDK repo as a remote (run once)
git remote add sentinel-sdk https://github.com/yashy10/Sentinel-SDK.git

# 2. Track and commit sentinel-sdk if not already
git add sentinel-sdk/
git commit -m "Add Sentinel-SDK package"

# 3. Push only this folder to Sentinel-SDK main
git subtree split --prefix=sentinel-sdk -b sentinel-sdk-export
git push sentinel-sdk sentinel-sdk-export:main
git branch -D sentinel-sdk-export
```

## Option B: Copy into a clone of Sentinel-SDK

```bash
# 1. Clone the (empty) repo
git clone https://github.com/yashy10/Sentinel-SDK.git /tmp/Sentinel-SDK
cd /tmp/Sentinel-SDK

# 2. Copy contents of sentinel-sdk (excluding cache and generated files)
#    Replace <YOUR_OPENCODE_PATH> with e.g. /Users/yashy/Desktop/opencode
rsync -av --exclude='__pycache__' --exclude='*.pyc' --exclude='audit.json' \
  --exclude='playground_sandbox' \
  <YOUR_OPENCODE_PATH>/sentinel-sdk/ .

# 3. Commit and push
git add .
git commit -m "Initial Sentinel-SDK package from opencode"
git push -u origin main
```

## Option C: Use the script

From opencode repo root:

```bash
chmod +x scripts/push-to-sentinel-sdk.sh
./scripts/push-to-sentinel-sdk.sh
```

If `sentinel-sdk/` is not yet committed, the script will tell you to add and commit it, then run again.
