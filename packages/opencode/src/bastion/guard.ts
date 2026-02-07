import { RULES, type BastionRule } from "./rules"
import { BastionMemory, type LearnedConstraint } from "./memory"
import { Log } from "@/util/log"
import * as YouGuard from "./you-guard"

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

/** Result of evaluate(): verdict + You.com note; youBlocked set when You.com blocks (caller should audit and throw). */
export interface EvaluateResult {
  verdict: GuardVerdict
  youVerdictNote: string
  youBlocked?: { reason: string; findings: string[]; threatKeywordsFound: string[] }
}

/**
 * You.com is priority for bash: run You.com first. If it blocks, return immediately.
 * Otherwise run Bastion rules and return that verdict.
 */
export async function evaluate(
  toolName: string,
  toolArgs: Record<string, any>,
  signal: AbortSignal,
): Promise<EvaluateResult> {
  let youVerdictNote = "You.com was not used for this check.\n"

  if (toolName === "bash") {
    try {
      const youVerdict = await YouGuard.verify(toolName, toolArgs, signal)
      if (youVerdict.checked && youVerdict.source === "youcom") {
        if (youVerdict.status === "SAFE") {
          youVerdictNote = `You.com was used for this check. [SAFE] No threat indicators found.\n`
        } else if (youVerdict.status === "WARN") {
          youVerdictNote = `You.com was used for this check. [WARN] ${youVerdict.reason}\n`
        } else if (youVerdict.status === "BLOCKED") {
          youVerdictNote = "You.com was used for this check.\n"
        }
      } else {
        youVerdictNote = "You.com was used for this check.\n"
      }
      if (youVerdict.status === "BLOCKED") {
        return {
          verdict: check(toolName, toolArgs),
          youVerdictNote,
          youBlocked: {
            reason: youVerdict.reason ?? "",
            findings: youVerdict.findings ?? [],
            threatKeywordsFound: youVerdict.threatKeywordsFound ?? [],
          },
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e
      log.warn("you.com check failed, continuing with bastion rules", {
        error: e instanceof Error ? e.message : String(e),
      })
      youVerdictNote = "You.com was used for this check.\n"
    }
    if (youVerdictNote === "You.com was not used for this check.\n") youVerdictNote = "You.com was used for this check.\n"
  }

  const verdict = check(toolName, toolArgs)
  return { verdict, youVerdictNote }
}
