# Testing Delete Operation Blocking

## Rules Added

1. **R002**: Blocks `rm -rf`, `rm -r` (recursive delete)
2. **R017**: Blocks any `rm ` command (all rm commands)
3. **R016**: Blocks `apply_patch` delete operations (`*** Delete File:`)

## Test Scenarios

### Test 1: Bash rm -rf command
```bash
# In OpenCode TUI, try:
Run: rm -rf ~/Desktop/deleteThis
```
**Expected**: Should be blocked by R002 or R017, enforcement selection appears

### Test 2: Bash rm command (non-recursive)
```bash
# In OpenCode TUI, try:
Run: rm ~/Desktop/deleteThis/file.txt
```
**Expected**: Should be blocked by R017, enforcement selection appears

### Test 3: apply_patch delete
```bash
# In OpenCode TUI, try:
Apply patch:
*** Begin Patch
*** Delete File: ~/Desktop/deleteThis
*** End Patch
```
**Expected**: Should be blocked by R016, enforcement selection appears

## Verification

After adding these rules, ALL delete operations should:
1. Trigger Bastion Guard
2. Show enforcement selection prompt
3. Require user approval before proceeding

## Files Modified

- `packages/opencode/src/bastion/rules.ts`:
  - Updated R002 to catch all `rm -rf` patterns
  - Added R016 for `apply_patch` delete operations
  - Added R017 for all `rm` commands
