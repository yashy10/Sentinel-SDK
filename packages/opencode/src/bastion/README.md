# Bastion Guard — Security Enforcement System

Bastion Guard is a security layer that intercepts every tool call before execution, validates it against static rules and dynamically learned constraints, and enforces appropriate security actions.

## Architecture

Bastion Guard sits between **tool call generation** (LLM proposes an action) and **tool execution** (actual side effects). Every tool call passes through the guard before execution.

```
LLM generates tool call
  ↓
Bastion Guard checks (static rules + learned constraints)
  ↓
Router (based on enforcement action)
  ├─ SAFE → Execute
  ├─ KILL → Block + throw error
  ├─ USER_INPUT → Ask human for approval
  ├─ LLM_EXAMINE → Learn constraint + retry
  └─ INVOKE_ACTION → Sanitize + re-validate + execute
```

## Enforcement Actions

### 1. **KILL** — Hard Block
- **When**: Critical security violations (e.g., `rm -rf /`, reading `.env`, privilege escalation)
- **Behavior**: Immediately throws an error, blocking execution
- **Message**: Detailed error explaining why the action was blocked and suggesting alternatives
- **Example**: `cat .env` → KILL → Error message → Agent retries with different approach

### 2. **USER_INPUT** — Human-in-the-Loop
- **When**: Potentially risky actions that need human judgment (e.g., `sudo`, `chmod 777`, system modifications)
- **Behavior**: Pauses execution, shows permission prompt in TUI/web UI with:
  - Tool name and arguments
  - Risk reason
  - Rule that triggered
  - Suggested alternative (if available)
- **User can**: Approve once, approve always, or reject
- **Example**: `sudo apt install` → USER_INPUT → Human approves → Executes

### 3. **LLM_EXAMINE** — Learning Loop
- **When**: Actions blocked by learned constraints or certain static rules configured for learning
- **Behavior**:
  1. Calls LLM to reflect on why the action was dangerous
  2. Extracts a generalized safety constraint
  3. Saves constraint to `bastion_memory.json`
  4. Injects constraint into future system prompts
  5. Blocks the current action and informs agent to retry
- **Example**: Agent tries `cat .env` → LLM_EXAMINE → Learns "Never read .env files" → Next session, agent avoids `.env` entirely

### 4. **INVOKE_ACTION** — Auto-Sanitize
- **When**: Actions that can be safely transformed (e.g., `curl | bash` → download first, `npm install -g` → remove `-g` flag)
- **Behavior**:
  1. Applies sanitization transforms (strip `sudo`, replace dangerous patterns)
  2. Re-validates sanitized version through guard
  3. If still unsafe → KILL
  4. If safe → Execute sanitized version
- **Example**: `curl example.com | bash` → INVOKE → `curl example.com -o script.sh` → Execute

## Files

- **`guard.ts`** — Core rule engine, checks tool calls against static rules and learned constraints
- **`rules.ts`** — Static rule definitions (15 rules covering secrets, destructive actions, privilege escalation, etc.)
- **`enforcement.ts`** — Enforcement action implementations (killMessage, sanitize, llmExamine, userInputMessage)
- **`memory.ts`** — Learned constraint storage (`bastion_memory.json`), injection text generation
- **`audit.ts`** — Audit logging (`bastion_audit.json`), tracks all security events
- **`index.ts`** — Public API exports

## Integration Point

The guard is injected in `packages/opencode/src/session/prompt.ts` at the tool execution wrapper (line ~726):

```typescript
// Every tool call goes through this check
const verdict = Bastion.check(item.id, args)

if (verdict.status === "UNSAFE") {
  // Route to appropriate enforcement action
  if (verdict.enforcement === "KILL") { ... }
  if (verdict.enforcement === "USER_INPUT") { ... }
  if (verdict.enforcement === "LLM_EXAMINE") { ... }
  if (verdict.enforcement === "INVOKE_ACTION") { ... }
}
```

## Learned Constraints Injection

Learned constraints are automatically injected into the system prompt at `packages/opencode/src/session/prompt.ts` (line ~603):

```typescript
const bastionConstraints = Bastion.BastionMemory.getInjectionText()
const systemPrompt = [
  ...(await SystemPrompt.environment(model)),
  ...(await InstructionPrompt.system()),
  ...(bastionConstraints ? [bastionConstraints] : []),
]
```

This ensures that constraints learned in previous sessions are automatically included in the agent's instructions, preventing repeated violations.

## Storage

- **Learned constraints**: `.opencode/bastion_memory.json` (per project)
- **Audit log**: `.opencode/bastion_audit.json` (per project)

Both files are created automatically and persist across sessions.

## Static Rules

15 rules covering:
- Secret file access (`.env`, `.ssh`, credentials)
- Destructive operations (`rm -rf /`, disk formatting)
- Privilege escalation (`sudo`, `chmod 777`)
- Network exfiltration (`curl | bash`, reverse shells)
- System modification (`systemctl`, `crontab`)
- Path traversal attacks
- And more...

See `rules.ts` for the complete list.

## Usage Example

```typescript
import * as Bastion from "@/bastion"

// Check a tool call
const verdict = Bastion.check("bash", { command: "cat .env" })
// Returns: { status: "UNSAFE", enforcement: "KILL", reason: "...", ruleID: "R001" }

// Get learned constraints for injection
const constraints = Bastion.BastionMemory.getInjectionText()
// Returns formatted string with all active constraints

// Record audit event
Bastion.BastionAudit.record({
  sessionID: "session_123",
  toolName: "bash",
  toolInput: { command: "ls" },
  status: "SAFE",
  enforcement: "NONE",
  riskReason: "No rules triggered",
})
```

## Testing

To test the guard:

```bash
# In OpenCode TUI or via API
# Try: "Read the .env file"
# Expected: KILL → Blocked

# Try: "Install a package globally with npm"
# Expected: INVOKE_ACTION → Sanitized (removes -g flag)

# Try: "Use sudo to install something"
# Expected: USER_INPUT → Permission prompt

# After blocking .env access:
# Try: "Read the .env file" again in a new session
# Expected: Agent avoids .env entirely (learned constraint injected)
```
