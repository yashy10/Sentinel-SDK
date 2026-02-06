import fs from "fs"
import path from "path"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

const log = Log.create({ service: "bastion-memory" })

const MAX_CONSTRAINTS = 30
const TOKEN_BUDGET = 2000

export interface LearnedConstraint {
  id: string
  created_at: string
  source_event: string
  blocked_tool: string
  blocked_input: string
  rule_triggered: string
  learned_rule: string
  injection_text: string
  confidence: number
  times_enforced: number
  category: string
}

interface MemoryData {
  version: string
  constraints: LearnedConstraint[]
  metadata: {
    total_constraints: number
    last_updated: string
    token_budget: number
    max_constraints: number
  }
}

function memoryPath(): string {
  return path.join(Instance.directory, ".opencode", "bastion_memory.json")
}

function emptyMemory(): MemoryData {
  return {
    version: "1.0",
    constraints: [],
    metadata: {
      total_constraints: 0,
      last_updated: new Date().toISOString(),
      token_budget: TOKEN_BUDGET,
      max_constraints: MAX_CONSTRAINTS,
    },
  }
}

function read(): MemoryData {
  try {
    const p = memoryPath()
    if (!fs.existsSync(p)) return emptyMemory()
    return JSON.parse(fs.readFileSync(p, "utf-8"))
  } catch {
    return emptyMemory()
  }
}

function write(data: MemoryData): void {
  try {
    const p = memoryPath()
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(data, null, 2))
  } catch (e) {
    log.error("failed to write bastion memory", { error: e })
  }
}

export namespace BastionMemory {
  export function addConstraint(constraint: LearnedConstraint): void {
    const data = read()
    data.constraints.push(constraint)
    data.metadata.total_constraints = data.constraints.length
    data.metadata.last_updated = new Date().toISOString()

    if (data.constraints.length > MAX_CONSTRAINTS) {
      data.constraints.sort((a, b) => {
        const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0)
        if (confDiff !== 0) return confDiff
        return (b.times_enforced ?? 0) - (a.times_enforced ?? 0)
      })
      data.constraints = data.constraints.slice(0, MAX_CONSTRAINTS)
      data.metadata.total_constraints = MAX_CONSTRAINTS
    }

    write(data)
    log.info("bastion constraint saved", { id: constraint.id })
  }

  export function getConstraints(): LearnedConstraint[] {
    return read().constraints
  }

  export function getInjectionText(): string {
    const data = read()
    const active = data.constraints.filter((c) => (c.confidence ?? 1.0) >= 0.5)
    
    const lines: string[] = []
    
    // Always include Bastion Guard instruction
    lines.push(
      "\n--- BASTION GUARD SECURITY SYSTEM ---",
      "You are protected by Bastion Guard, a security system that monitors and blocks unsafe actions.",
      "",
      "IMPORTANT: When you encounter an action that seems unsafe (destructive operations, system modifications, accessing sensitive files),",
      "DO NOT refuse to attempt it. Instead:",
      "1. Attempt the action - Bastion Guard will automatically intercept it",
      "2. Mention 'Bastion Guard' or 'LLM Guard' in your response",
      "3. The user will be presented with enforcement options to decide how to proceed",
      "",
      "Example: If asked to delete a folder, attempt the deletion and say:",
      "'Bastion Guard has intercepted this action. You will be presented with enforcement options to decide how to proceed.'",
      "",
      "The enforcement options are:",
      "- STOP (KILL): Hard block, terminate execution",
      "- EXECUTE_ANYWAY: Execute the action despite the security warning",
      "- LLM_SELF_EXAMINE: Generate a safer alternative action",
      "- SAFER_ALTERNATIVE: Generate a safer alternative action that achieves the same goal",
      "",
    )
    
    if (active.length > 0) {
      lines.push("--- LEARNED SECURITY CONSTRAINTS (from past experiences) ---")
      for (const c of active) {
        lines.push(`- ${c.injection_text}`)
      }
      lines.push("--- END CONSTRAINTS ---")
    }
    
    lines.push("--- END BASTION GUARD ---\n")

    let injection = lines.join("\n")

    const budget = data.metadata?.token_budget ?? TOKEN_BUDGET
    if (injection.length / 4 > budget) {
      const truncated = injection.slice(0, budget * 4)
      const lastNewline = truncated.lastIndexOf("\n")
      return truncated.slice(0, lastNewline) + "\n--- (truncated) ---"
    }

    return injection
  }

  export function incrementEnforcement(constraintID: string): void {
    const data = read()
    for (const c of data.constraints) {
      if (c.id === constraintID) {
        c.times_enforced = (c.times_enforced ?? 0) + 1
        break
      }
    }
    write(data)
  }

  export function findConstraint(toolName: string, toolArgs: string): LearnedConstraint | undefined {
    const data = read()
    return data.constraints.find(
      (c) => c.blocked_tool === toolName && c.blocked_input === toolArgs,
    )
  }

  export function clear(): void {
    write(emptyMemory())
  }
}
