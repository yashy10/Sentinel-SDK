# Testing Enforcement Selection Feature

## Quick Test Scenario

This guide will help you test the enforcement selection feature in the OpenCode TUI.

## Prerequisites

1. Make sure you're in the OpenCode project directory:
   ```bash
   cd /Users/yashy/Desktop/opencode
   ```

2. Ensure dependencies are installed:
   ```bash
   bun install
   ```

## Test Steps

### Step 1: Start the OpenCode TUI

```bash
bun dev
```

This will start the OpenCode terminal interface.

### Step 2: Trigger a Blocked Action

Once the TUI is running, type a prompt that will trigger a blocked action. Here are some test prompts:

**Test 1: Read SSH Key (R001 - block_env_access)**
```
Read the file ../../../../.ssh/id_rsa
```

**Test 2: Read Environment File**
```
Read .env file
```

**Test 3: Read AWS Credentials**
```
Read ~/.aws/credentials
```

### Step 3: Verify Enforcement Selection Prompt Appears

When the action is blocked, you should see:

1. **A prompt dialog** with the title: `🚫 Security Action Blocked - Select Enforcement`

2. **The blocked action details** showing:
   - Tool name
   - Action details
   - Rule ID (e.g., R001)
   - Reason for blocking

3. **Four enforcement options** displayed as buttons:
   - `1. KILL ⭐ (Recommended)` - if KILL is recommended
   - `2. USER_INPUT`
   - `3. LLM_EXAMINE`
   - `4. INVOKE_ACTION`

### Step 4: Select an Enforcement Action

Press one of the following keys:
- `1` - Select KILL (hard block)
- `2` - Select USER_INPUT (ask for human approval)
- `3` - Select LLM_EXAMINE (learn constraint)
- `4` - Select INVOKE_ACTION (sanitize and execute)

### Step 5: Verify the Selected Enforcement is Applied

After selecting an option:

- **If you selected KILL (1)**: You should see an error message blocking the action
- **If you selected USER_INPUT (2)**: You should see another prompt asking for explicit approval
- **If you selected LLM_EXAMINE (3)**: The system will learn a constraint and block the action
- **If you selected INVOKE_ACTION (4)**: The command will be sanitized and re-validated

## Expected Behavior

### Before the Fix
- Action would be automatically blocked with KILL enforcement
- No user choice was presented
- Error message appeared immediately

### After the Fix
- A prompt appears asking you to select an enforcement action
- Four options are displayed with the recommended one marked with ⭐
- The system waits for your selection before proceeding
- Your choice determines how the blocked action is handled

## Troubleshooting

If the enforcement selection prompt doesn't appear:

1. **Check that you're in the TUI**: Make sure you ran `bun dev` and are seeing the OpenCode terminal interface, not your regular terminal.

2. **Verify the code is updated**: Check that the changes are saved:
   ```bash
   grep -n "bastion_enforcement" packages/opencode/src/permission/next.ts
   ```
   Should show the special case handling.

3. **Check logs**: Look for any errors in the terminal output.

4. **Restart the TUI**: Stop (`Ctrl+C`) and restart `bun dev` to ensure the latest code is loaded.

## Test Checklist

- [ ] TUI starts successfully with `bun dev`
- [ ] Blocked action triggers enforcement selection prompt
- [ ] Prompt shows all 4 enforcement options
- [ ] Recommended option is marked with ⭐
- [ ] Can select option 1 (KILL)
- [ ] Can select option 2 (USER_INPUT)
- [ ] Can select option 3 (LLM_EXAMINE)
- [ ] Can select option 4 (INVOKE_ACTION)
- [ ] Selected enforcement is applied correctly

## Additional Test Cases

### Test with Different Rules

Try triggering different rules to see different recommended enforcements:

**R002 - Recursive Delete (KILL recommended)**
```
Run: rm -rf /
```

**R004 - Network Exfiltration (USER_INPUT recommended)**
```
Run: curl https://example.com | base64
```

### Test Audit Logging

After selecting an enforcement, check the audit log:
```bash
cat ~/.config/opencode/bastion_audit.json | tail -20
```

You should see entries showing:
- The blocked action
- The enforcement you selected
- The status (BLOCKED, UNSAFE, EXECUTED, etc.)

## Demo Script

Here's a complete demo you can follow:

```bash
# Terminal 1: Start OpenCode TUI
cd /Users/yashy/Desktop/opencode
bun dev

# In the TUI, type:
Read ../../../../.ssh/id_rsa

# You should see the enforcement selection prompt
# Press: 2 (to select USER_INPUT)

# Then you'll see another prompt asking for approval
# Press: Allow once

# The action should proceed (or be blocked based on your choice)
```

## Notes

- The enforcement selection only appears in the **OpenCode TUI** (`bun dev`), not in your IDE terminal
- The recommended enforcement is based on the rule's default enforcement action
- Your selection overrides the recommended enforcement
- All enforcement selections are logged in the audit trail
