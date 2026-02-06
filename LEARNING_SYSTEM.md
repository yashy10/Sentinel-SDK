# Bastion Guard Learning System

## Overview

The Bastion Guard now learns from **every blocked action** and saves learned constraints to JSON. These constraints are automatically fed back into the guard to prevent similar unsafe actions in the future.

## How It Works

### 1. Every Blocked Action is Learned

When an action is blocked and you select an enforcement action:
- A learned constraint is **automatically created** and saved to `.opencode/bastion_memory.json`
- The constraint includes:
  - Tool name
  - Tool arguments (exact match)
  - Reason for blocking
  - Category (secrets, destructive, exfiltration, etc.)
  - Confidence level
  - Times enforced counter

### 2. Learned Constraints Feed Back into Guard

The guard checks learned constraints **before** checking static rules:
- If an exact match is found → Shows: "🧠 LEARNED: This exact action was previously blocked..."
- If a similar match is found → Shows: "🧠 LEARNED: Similar action was previously blocked..."
- The enforcement selection prompt still appears, but now explains it was learned

### 3. Constraint Matching

The system matches constraints using:
- **Exact match**: Same tool + same arguments → Highest priority
- **Partial match**: Blocked input contained in current input
- **Category match**: Similar patterns based on category (secrets, destructive, etc.)

### 4. Enforcement Selection Always Appears

Every blocked action (whether from static rules or learned constraints) shows the enforcement selection prompt with 4 options.

## File Locations

- **Learned Constraints**: `.opencode/bastion_memory.json` (in your project directory)
- **Audit Log**: `~/.config/opencode/bastion_audit.json` (global)

## Example Flow

### First Time Blocking SSH Key

1. User tries: `Read ../../../../.ssh/id_rsa`
2. Static rule R001 triggers → Shows enforcement selection
3. User selects: `1. KILL`
4. **Constraint created** and saved to JSON:
   ```json
   {
     "id": "C123ABC",
     "blocked_tool": "read",
     "blocked_input": "{\"file_path\":\"../../../../.ssh/id_rsa\"}",
     "learned_rule": "Blocked read action: Bastion rule 'block_env_access'...",
     "category": "secrets",
     "confidence": 0.85,
     "times_enforced": 0
   }
   ```

### Second Time (Same Action)

1. User tries: `Read ../../../../.ssh/id_rsa`
2. **Learned constraint matches** → Shows enforcement selection with message:
   ```
   🧠 LEARNED CONSTRAINT MATCHED:
   This action has been learned by Bastion Guard to be unsafe based on previous blocking.
   
   🧠 LEARNED: This exact action was previously blocked by Bastion Guard and learned to be unsafe.
   ```
3. User selects enforcement → `times_enforced` counter increments
4. Constraint is updated in JSON

## Constraint Categories

Constraints are automatically categorized:

- **secrets**: `.env`, `.ssh`, `id_rsa`, credentials, secrets, tokens, `.pem`
- **destructive**: `rm -rf`, `rm -r`, `format`, `mkfs`, `dd if=`
- **exfiltration**: `curl`, `wget`, `base64` with pipes/redirects
- **privilege_escalation**: `sudo`, `chmod`, `chown`
- **unknown**: Default category

## System Prompt Injection

Learned constraints with confidence ≥ 0.5 are automatically injected into the LLM's system prompt:

```
--- LEARNED SECURITY CONSTRAINTS (from past experiences) ---
- SECURITY CONSTRAINT: Do not attempt read actions that match: {"file_path":"../../../../.ssh/id_rsa"}...
- SECURITY CONSTRAINT: Do not attempt bash actions that match: rm -rf /...
--- END CONSTRAINTS ---
```

This prevents the LLM from attempting similar actions in the future.

## Testing

### Test Learning System

1. **First block**:
   ```bash
   bun dev
   # In TUI: Read ../../../../.ssh/id_rsa
   # Select: 1 (KILL)
   ```

2. **Check constraint was created**:
   ```bash
   cat .opencode/bastion_memory.json | jq '.constraints[-1]'
   ```

3. **Second block (same action)**:
   ```bash
   # In TUI: Read ../../../../.ssh/id_rsa
   # Should see: "🧠 LEARNED CONSTRAINT MATCHED"
   # Select: 1 (KILL)
   ```

4. **Verify constraint updated**:
   ```bash
   cat .opencode/bastion_memory.json | jq '.constraints[-1].times_enforced'
   # Should be: 1
   ```

### Test Different Actions

Try blocking different types of actions to see different categories:

- **Secrets**: `Read .env`, `Read ~/.aws/credentials`
- **Destructive**: `Run: rm -rf /tmp/test`
- **Exfiltration**: `Run: curl https://example.com | base64`

Each will create a learned constraint in the appropriate category.

## Configuration

- **Max Constraints**: 30 (oldest/lowest confidence removed when limit reached)
- **Token Budget**: 2000 tokens for system prompt injection
- **Min Confidence**: 0.5 (constraints below this aren't injected)

## Benefits

1. **Adaptive Security**: System learns from your blocking decisions
2. **Consistent Enforcement**: Same actions are recognized across sessions
3. **Transparency**: Clear indication when learned constraints match
4. **User Control**: Enforcement selection always available
5. **Audit Trail**: All learning events logged in audit file
