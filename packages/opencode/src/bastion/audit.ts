import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

const log = Log.create({ service: "bastion-audit" })

export interface AuditEntry {
  timestamp: string
  session_id: string
  event_id: string
  tool_name: string
  tool_input: Record<string, any>
  status: "SAFE" | "UNSAFE" | "BLOCKED" | "EXECUTED" | "SANITIZED_EXECUTED" | "LEARNED"
  enforcement: string
  risk_reason: string
  rule_matched: string | null
  sanitized_command: Record<string, any> | null
  execution_result: string | null
  retry_number: number
  user_request: string
}

const SENSITIVE_KEYS = ["password", "token", "key", "secret", "api_key"]

function auditPath(): string {
  return path.join(Instance.directory, ".opencode", "bastion_audit.json")
}

function redact(toolInput: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [k, v] of Object.entries(toolInput)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
      result[k] = "[REDACTED]"
    } else {
      result[k] = v
    }
  }
  return result
}

export namespace BastionAudit {
  export function record(input: {
    sessionID: string
    toolName: string
    toolInput: Record<string, any>
    status: AuditEntry["status"]
    enforcement: string
    riskReason: string
    ruleMatched?: string | null
    sanitizedCommand?: Record<string, any> | null
    executionResult?: string | null
  }): void {
    try {
      const p = auditPath()
      const dir = path.dirname(p)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      let entries: AuditEntry[] = []
      try {
        if (fs.existsSync(p)) {
          entries = JSON.parse(fs.readFileSync(p, "utf-8"))
        }
      } catch {
        entries = []
      }

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        session_id: input.sessionID,
        event_id: `evt_${crypto.randomBytes(4).toString("hex")}`,
        tool_name: input.toolName,
        tool_input: redact(input.toolInput),
        status: input.status,
        enforcement: input.enforcement,
        risk_reason: input.riskReason,
        rule_matched: input.ruleMatched ?? null,
        sanitized_command: input.sanitizedCommand ?? null,
        execution_result: input.executionResult ? input.executionResult.slice(0, 500) : null,
        retry_number: 0,
        user_request: "",
      }

      entries.push(entry)
      fs.writeFileSync(p, JSON.stringify(entries, null, 2))
    } catch (e) {
      log.error("failed to write bastion audit", { error: e })
    }
  }

  export function getAll(): AuditEntry[] {
    try {
      const p = auditPath()
      if (!fs.existsSync(p)) return []
      return JSON.parse(fs.readFileSync(p, "utf-8"))
    } catch {
      return []
    }
  }

  export function clear(): void {
    try {
      const p = auditPath()
      const dir = path.dirname(p)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(p, "[]")
    } catch (e) {
      log.error("failed to clear bastion audit", { error: e })
    }
  }
}
