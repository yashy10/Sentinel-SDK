import { RULES, type BastionRule } from "./rules"
import { BastionMemory, type LearnedConstraint } from "./memory"
import { Log } from "@/util/log"

const log = Log.create({ service: "bastion-guard" })

export type VerdictStatus = "SAFE" | "UNSAFE"

export type EnforcementAction = "NONE" | "KILL" | "USER_INPUT" | "LLM_EXAMINE" | "INVOKE_ACTION"

export interface GuardVerdict {
  status: VerdictStatus
  enforcement: EnforcementAction
  reason: string
  ruleID?: string
  constraintID?: string
  matchedPattern?: string
  suggestedAlternative?: string
}

function flattenInput(toolName: string, toolArgs: Record<string, any>): string {
  const parts = [toolName]
  for (const value of Object.values(toolArgs)) {
    parts.push(String(value))
  }
  return parts.join(" ").toLowerCase()
}

function ruleAppliesToTool(rule: BastionRule, toolName: string): boolean {
  return rule.tool_scope.includes("*") || rule.tool_scope.includes(toolName)
}

function matchesRule(rule: BastionRule, inputStr: string, toolArgs: Record<string, any>): boolean {
  const pattern = rule.pattern
  const ruleType = rule.type

  if (ruleType === "regex") {
    return new RegExp(pattern, "i").test(inputStr)
  }
  if (ruleType === "command_prefix") {
    const cmd = (toolArgs.command ?? "").trim().toLowerCase()
    return cmd.startsWith(pattern.toLowerCase())
  }
  if (ruleType === "contains") {
    return inputStr.includes(pattern.toLowerCase())
  }
  if (ruleType === "exact") {
    const cmd = (toolArgs.command ?? toolArgs.path ?? toolArgs.file_path ?? "").trim().toLowerCase()
    return cmd === pattern.toLowerCase()
  }
  return false
}

function matchesConstraint(constraint: LearnedConstraint, inputStr: string, toolName: string, toolArgs: Record<string, any>): boolean {
  const blockedInput = constraint.blocked_input ?? ""
  const blockedTool = constraint.blocked_tool ?? ""
  
  // Exact match: same tool and same args
  if (blockedTool === toolName && blockedInput === JSON.stringify(toolArgs)) {
    return true
  }
  
  // Partial match: check if blocked input is contained in current input
  const blockedInputLower = blockedInput.toLowerCase()
  const inputStrLower = inputStr.toLowerCase()
  if (blockedInputLower && inputStrLower.includes(blockedInputLower)) {
    return true
  }

  // Category-based matching for similar actions
  const category = constraint.category ?? ""

  if (category === "secrets") {
    const patterns = [".env", ".credentials", "id_rsa", ".ssh", "secret", "token", "api_key", ".pem"]
    if (patterns.some((p) => inputStrLower.includes(p))) return true
  }

  if (category === "destructive") {
    const patterns = ["rm -rf", "rm -r", "rmdir", "del /f", "format", "mkfs", "dd if="]
    if (patterns.some((p) => inputStrLower.includes(p))) return true
  }

  if (category === "exfiltration") {
    const patterns = ["curl", "wget", "nc ", "netcat", "base64", "|", ">"]
    const matches = patterns.filter((p) => inputStrLower.includes(p)).length
    if (matches >= 2) return true
  }

  return false
}

export function check(toolName: string, toolArgs: Record<string, any>): GuardVerdict {
  const inputStr = flattenInput(toolName, toolArgs)

  // Layer 1: Static rules
  for (const rule of RULES) {
    if (!rule.enabled) continue
    if (!ruleAppliesToTool(rule, toolName)) continue
    if (matchesRule(rule, inputStr, toolArgs)) {
      log.info("bastion rule triggered", { rule: rule.id, tool: toolName })
      return {
        status: "UNSAFE",
        enforcement: rule.enforcement,
        reason: `Bastion rule '${rule.name}': ${rule.description}`,
        ruleID: rule.id,
        matchedPattern: rule.pattern,
        suggestedAlternative: rule.suggested_alternative,
      }
    }
  }

  // Layer 2: Learned constraints
  const constraints = BastionMemory.getConstraints()
  for (const constraint of constraints) {
    if ((constraint.confidence ?? 1.0) < 0.5) continue
    if (matchesConstraint(constraint, inputStr, toolName, toolArgs)) {
      log.info("bastion constraint triggered", { constraint: constraint.id, tool: toolName })
      // Check if this exact action was blocked before
      const exactMatch = constraint.blocked_tool === toolName && 
                         constraint.blocked_input === JSON.stringify(toolArgs)
      
      return {
        status: "UNSAFE",
        enforcement: "USER_INPUT", // Default to USER_INPUT for learned constraints to allow user choice
        reason: exactMatch 
          ? `🧠 LEARNED: This exact action was previously blocked by Bastion Guard and learned to be unsafe. ${constraint.learned_rule}`
          : `🧠 LEARNED: Similar action was previously blocked. ${constraint.learned_rule}`,
        constraintID: constraint.id,
        matchedPattern: constraint.blocked_input ?? "",
      }
    }
  }

  return {
    status: "SAFE",
    enforcement: "NONE",
    reason: "No rules or constraints triggered",
  }
}
