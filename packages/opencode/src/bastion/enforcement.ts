import crypto from "crypto"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import type { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import type { GuardVerdict, EnforcementAction } from "./guard"
import type { LearnedConstraint } from "./memory"

const log = Log.create({ service: "bastion-enforcement" })

// === KILL ===
// Hard block. Returns a detailed error message the LLM receives as tool output.
export function killMessage(verdict: GuardVerdict): string {
  const parts = [
    `🚫 BLOCKED by Bastion Guard`,
    ``,
    `Enforcement: ${verdict.enforcement}`,
    `Rule: ${verdict.ruleID ?? verdict.constraintID ?? "unknown"}`,
    `Reason: ${verdict.reason}`,
  ]
  if (verdict.suggestedAlternative) {
    parts.push(``, `💡 Suggested alternative: ${verdict.suggestedAlternative}`)
  }
  parts.push(``, `This action is not permitted. You must use a different, safer approach.`)
  return parts.join("\n")
}

// === USER_INPUT ===
// Returns a formatted message for the permission prompt UI
export function userInputMessage(verdict: GuardVerdict, toolName: string, toolArgs: Record<string, any>): string {
  const parts = [
    `⚠️  HUMAN APPROVAL REQUIRED`,
    ``,
    `Tool: ${toolName}`,
    `Action: ${JSON.stringify(toolArgs, null, 2)}`,
    `Risk: ${verdict.reason}`,
    `Rule: ${verdict.ruleID ?? verdict.constraintID ?? "unknown"}`,
  ]
  if (verdict.suggestedAlternative) {
    parts.push(`💡 Suggested alternative: ${verdict.suggestedAlternative}`)
  }
  parts.push(``, `This action requires explicit human approval before execution.`)
  return parts.join("\n")
}

// === ENFORCEMENT SELECTION ===
// Returns a formatted message showing the blocked action details (options shown separately in UI)
export function enforcementSelectionMessage(
  verdict: GuardVerdict,
  toolName: string,
  toolArgs: Record<string, any>,
): string {
  const isLearned = !!verdict.constraintID
  const parts = [
    `Action blocked by Bastion Guard security rules.`,
    ``,
  ]
  
  if (isLearned) {
    parts.push(
      `🧠 LEARNED CONSTRAINT MATCHED:`,
      `This action has been learned by Bastion Guard to be unsafe based on previous blocking.`,
      ``,
    )
  }
  
  parts.push(
    `Tool: ${toolName}`,
    `Action: ${JSON.stringify(toolArgs, null, 2)}`,
    `Rule: ${verdict.ruleID ?? verdict.constraintID ?? "unknown"}`,
    `Reason: ${verdict.reason}`,
  )
  
  if (verdict.suggestedAlternative) {
    parts.push(``, `💡 Suggested alternative: ${verdict.suggestedAlternative}`)
  }
  
  parts.push(
    ``,
    `Please select an enforcement action below:`,
  )
  
  return parts.join("\n")
}

// Enforcement action descriptions for UI
export const ENFORCEMENT_DESCRIPTIONS = {
  KILL: "STOP: Halts execution of current action and terminates agent's operation. Absolute safety cut-off for high-risk violations.",
  USER_INPUT: "EXECUTE_ANYWAY: Execute the action despite the security warning. No additional confirmation required.",
  LLM_EXAMINE: "LLM_SELF_EXAMINE: LLM generates a corrected/safer action that replaces the original unsafe action in the execution trajectory.",
  INVOKE_ACTION: "SAFER_ALTERNATIVE: LLM generates a safer alternative action that achieves the same goal without violating security policy.",
} as const

// === INVOKE_ACTION (auto-sanitizer) ===
// Modifies the tool args to neutralize the threat, then the caller re-validates.
export function sanitize(toolName: string, toolArgs: Record<string, any>): Record<string, any> {
  const sanitized = { ...toolArgs }

  if (toolName === "bash") {
    let cmd = sanitized.command ?? ""

    // Strip sudo
    cmd = cmd.replace(/\bsudo\s+/g, "")

    // Replace rm -rf / rm -r with a safe echo
    cmd = cmd.replace(
      /rm\s+(-[rf]+\s+)+(.+)/g,
      'echo "BLOCKED: destructive delete not allowed for: $2"',
    )

    // Neutralize pipe-to-shell
    cmd = cmd.replace(
      /(curl|wget)\s+.*\|\s*(bash|sh|zsh|python|perl|ruby)/g,
      'echo "BLOCKED: pipe-to-shell not allowed"',
    )

    // Strip global npm install flag
    cmd = cmd.replace(/\s+-g\b/g, "")

    sanitized.command = cmd
  }

  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const filePath = sanitized.file_path ?? sanitized.path ?? ""
    if (/\.(env|credentials|secret|pem|key)$|id_rsa|\.ssh[\/]|authorized_keys/.test(filePath)) {
      sanitized.file_path = "./SENTINEL_BLOCKED_ACCESS.txt"
      if (sanitized.path) sanitized.path = "./SENTINEL_BLOCKED_ACCESS.txt"
    }
  }

  return sanitized
}

// Returns a human-readable description of what sanitize() changed.
export function describeSanitization(
  toolName: string,
  original: Record<string, any>,
  sanitized: Record<string, any>,
): string {
  if (toolName === "bash") {
    return `Original command: ${original.command}\nSanitized to: ${sanitized.command}`
  }
  const origPath = original.file_path ?? original.path ?? ""
  const sanPath = sanitized.file_path ?? sanitized.path ?? ""
  if (origPath !== sanPath) {
    return `Original path: ${origPath}\nRedirected to: ${sanPath}`
  }
  return "Arguments were sanitized for safety."
}

// === LLM_EXAMINE ===
// LLM self-examination: Generates a corrected/safer action that replaces the original unsafe action.
export interface CorrectedAction {
  toolName: string
  toolArgs: Record<string, any>
  explanation: string
  learnedConstraint?: LearnedConstraint
}

export async function llmExamine(input: {
  toolName: string
  toolArgs: Record<string, any>
  verdict: GuardVerdict
  sessionID: string
  modelProviderID: string
  modelID: string
  userRequest?: string
}): Promise<CorrectedAction> {
  const constraintID = makeConstraintID()

  try {
    const agent = await Agent.get("title")
    if (!agent) throw new Error("no agent available for LLM examine")

    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : ((await Provider.getSmallModel(input.modelProviderID)) ??
        (await Provider.getModel(input.modelProviderID, input.modelID)))

    const userMsg: MessageV2.User = {
      id: `bastion-${Date.now()}`,
      sessionID: input.sessionID,
      role: "user",
      agent: "bastion",
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: Date.now() },
    }

    const examinePrompt = `You are a security analyst for an AI coding agent.
The agent attempted an action that was blocked by our security policy.

BLOCKED ACTION:
- Tool: ${input.toolName}
- Input: ${JSON.stringify(input.toolArgs)}
- Block Reason: ${input.verdict.reason}
- Rule Matched: ${input.verdict.ruleID ?? input.verdict.constraintID}
${input.userRequest ? `- User's Original Request: ${input.userRequest}` : ""}

YOUR TASK:
1. Analyze why this action is dangerous.
2. Generate a CORRECTED, SAFER action that achieves a similar goal without violating security policy.
3. Extract a GENERAL safety constraint for future prevention.

Respond ONLY with a JSON object (no markdown, no backticks):
{
  "corrected_tool": "tool_name",
  "corrected_args": { "param": "value" },
  "explanation": "Why the original was unsafe and how the corrected action is safer",
  "learned_rule": "A general description of what to avoid",
  "injection_text": "SECURITY CONSTRAINT: [Specific instruction for the agent to follow]",
  "category": "One of: secrets, destructive, privilege_escalation, exfiltration, system_modification, code_execution",
  "confidence": 0.0 to 1.0
}`

    const stream = await LLM.stream({
      agent,
      user: userMsg,
      model,
      tools: {},
      system: [],
      small: true,
      retries: 2,
      abort: new AbortController().signal,
      sessionID: input.sessionID,
      messages: [{ role: "user" as const, content: examinePrompt }],
    })

    const text = await stream.text
    log.info("llm examine response", { text })

    // Parse the LLM's JSON response
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(cleaned)

    // Create learned constraint for future prevention
    const learnedConstraint: LearnedConstraint = {
      id: constraintID,
      created_at: new Date().toISOString(),
      source_event: `Agent attempted: ${input.toolName}(${JSON.stringify(input.toolArgs)})`,
      blocked_tool: input.toolName,
      blocked_input: JSON.stringify(input.toolArgs),
      rule_triggered: input.verdict.ruleID ?? input.verdict.constraintID ?? "",
      learned_rule: parsed.learned_rule ?? input.verdict.reason,
      injection_text: parsed.injection_text ?? `SECURITY CONSTRAINT: ${input.verdict.reason}`,
      confidence: parsed.confidence ?? 0.85,
      times_enforced: 0,
      category: parsed.category ?? "unknown",
    }

    // Return corrected action that replaces the original unsafe action
    return {
      toolName: parsed.corrected_tool ?? input.toolName,
      toolArgs: parsed.corrected_args ?? input.toolArgs,
      explanation: parsed.explanation ?? `Original action was unsafe: ${input.verdict.reason}`,
      learnedConstraint,
    }
  } catch (e) {
    log.error("llm examine failed, using fallback", { error: e })

    // Fallback: return original action with explanation (not ideal, but prevents crash)
    const fallbackConstraint: LearnedConstraint = {
      id: constraintID,
      created_at: new Date().toISOString(),
      source_event: `Agent attempted: ${input.toolName}(${JSON.stringify(input.toolArgs)})`,
      blocked_tool: input.toolName,
      blocked_input: JSON.stringify(input.toolArgs),
      rule_triggered: input.verdict.ruleID ?? input.verdict.constraintID ?? "",
      learned_rule: input.verdict.reason,
      injection_text: `SECURITY CONSTRAINT: ${input.verdict.reason}. Do not attempt similar actions.`,
      confidence: 0.7,
      times_enforced: 0,
      category: "unknown",
    }

    return {
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      explanation: `LLM examination failed. Original action blocked: ${input.verdict.reason}`,
      learnedConstraint: fallbackConstraint,
    }
  }
}

// === GENERATE ALTERNATIVE ===
// Generates a safer alternative action (similar to llmExamine but focused on alternatives)
export async function generateAlternative(input: {
  toolName: string
  toolArgs: Record<string, any>
  verdict: GuardVerdict
  sessionID: string
  modelProviderID: string
  modelID: string
  userRequest?: string
  allowedToolNames: string[]
}): Promise<CorrectedAction> {
  try {
    const agent = await Agent.get("title")
    if (!agent) throw new Error("no agent available for generating alternative")

    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : ((await Provider.getSmallModel(input.modelProviderID)) ??
        (await Provider.getModel(input.modelProviderID, input.modelID)))

    const userMsg: MessageV2.User = {
      id: `bastion-alt-${Date.now()}`,
      sessionID: input.sessionID,
      role: "user",
      agent: "bastion",
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: Date.now() },
    }

    const toolList = input.allowedToolNames.join(", ")
    const alternativePrompt = `You are a security analyst for an AI coding agent.
The agent attempted an action that was blocked by our security policy.

BLOCKED ACTION:
- Tool: ${input.toolName}
- Input: ${JSON.stringify(input.toolArgs)}
- Block Reason: ${input.verdict.reason}
- Rule Matched: ${input.verdict.ruleID ?? input.verdict.constraintID}
${input.userRequest ? `- User's Original Request: ${input.userRequest}` : ""}

YOUR TASK:
Generate a SAFER ALTERNATIVE action that achieves the same goal as the blocked action but without violating security policy.
Focus on providing a practical, executable alternative that the user can use immediately.

CRITICAL: corrected_tool MUST be exactly one of these tool names (no other names allowed): ${toolList}
- To fetch a URL safely (instead of curl or pipe-to-shell), use: webfetch with corrected_args: { "url": "<the URL>" } — the key must be "url", not "param".
- To run a shell command: bash with corrected_args: { "command": "...", "description": "..." }.
- To read a file: read with corrected_args: { "path": "..." }.
- Do not use "curl", "safe_script_runner", or any name not in the list above.

Respond ONLY with a JSON object (no markdown, no backticks):
{
  "corrected_tool": "tool_name",
  "corrected_args": { "param": "value" },
  "explanation": "Why the original was unsafe and how this alternative is safer while achieving the same goal"
}`

    const stream = await LLM.stream({
      agent,
      user: userMsg,
      model,
      tools: {},
      system: [],
      small: true,
      retries: 2,
      abort: new AbortController().signal,
      sessionID: input.sessionID,
      messages: [{ role: "user" as const, content: alternativePrompt }],
    })

    const text = await stream.text
    log.info("generate alternative response", { text })

    // Parse the LLM's JSON response
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim()
    const parsed = JSON.parse(cleaned)

    // Return alternative action
    return {
      toolName: parsed.corrected_tool ?? input.toolName,
      toolArgs: parsed.corrected_args ?? input.toolArgs,
      explanation: parsed.explanation ?? `Safer alternative to: ${input.verdict.reason}`,
    }
  } catch (e) {
    log.error("generate alternative failed, using fallback", { error: e })

    // Fallback: return original action with explanation (not ideal, but prevents crash)
    return {
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      explanation: `Failed to generate alternative. Original action blocked: ${input.verdict.reason}`,
    }
  }
}

export function makeConstraintID(): string {
  return `C${crypto.randomBytes(3).toString("hex").toUpperCase()}`
}

// === CREATE LEARNED CONSTRAINT ===
// Creates a learned constraint from any blocked action (not just LLM_EXAMINE)
export function createLearnedConstraint(input: {
  toolName: string
  toolArgs: Record<string, any>
  verdict: GuardVerdict
  enforcement: EnforcementAction
}): LearnedConstraint {
  const constraintID = makeConstraintID()
  const inputStr = JSON.stringify(input.toolArgs)
  
  // Determine category based on tool and args
  let category = "unknown"
  const lowerInput = inputStr.toLowerCase()
  
  if (lowerInput.includes("id_rsa") || lowerInput.includes(".ssh") || lowerInput.includes(".env") || 
      lowerInput.includes("credentials") || lowerInput.includes("secret") || lowerInput.includes(".pem")) {
    category = "secrets"
  } else if (lowerInput.includes("rm -rf") || lowerInput.includes("rm -r") || lowerInput.includes("format")) {
    category = "destructive"
  } else if (lowerInput.includes("curl") || lowerInput.includes("wget") || lowerInput.includes("base64")) {
    category = "exfiltration"
  } else if (lowerInput.includes("sudo") || lowerInput.includes("chmod") || lowerInput.includes("chown")) {
    category = "privilege_escalation"
  }
  
  // Create a simple learned rule based on the blocked action
  const learnedRule = `Blocked ${input.toolName} action: ${input.verdict.reason}`
  const injectionText = `SECURITY CONSTRAINT: Do not attempt ${input.toolName} actions that match: ${inputStr.substring(0, 100)}. This was blocked because: ${input.verdict.reason}`
  
  return {
    id: constraintID,
    created_at: new Date().toISOString(),
    source_event: `Agent attempted: ${input.toolName}(${inputStr}) - Blocked with ${input.enforcement}`,
    blocked_tool: input.toolName,
    blocked_input: inputStr,
    rule_triggered: input.verdict.ruleID ?? input.verdict.constraintID ?? "",
    learned_rule: learnedRule,
    injection_text: injectionText,
    confidence: 0.85, // High confidence for user-blocked actions
    times_enforced: 0,
    category,
  }
}
