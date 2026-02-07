import { Log } from "@/util/log"
import { readFileSync } from "fs"
import path from "path"

const log = Log.create({ service: "you-guard" })

// --- .env Loader ---
// Bun's auto .env loading may miss package-level .env files in monorepos.
// Explicitly load packages/opencode/.env as a fallback.

function loadEnvFile() {
  try {
    const envPath = path.resolve(import.meta.dir, "../../.env")
    const content = readFileSync(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIndex = trimmed.indexOf("=")
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  } catch {
    // .env file not found or unreadable — env vars must be set externally
  }
}

loadEnvFile()

const rawKey = process.env.YOU_API_KEY ?? ""
const keyLooksValid =
  rawKey.length > 40 && !rawKey.includes("...") && !rawKey.includes("your-key-here") && rawKey.startsWith("ydc-")

if (process.env.YOU_ENABLED === "true" && rawKey && !keyLooksValid) {
  log.warn(
    "YOU_API_KEY may be masked or placeholder — use the full key from the You.com API Keys dashboard (copy icon), not the masked value (e.g. ydc-sk-398a...7e)",
  )
}

log.info("you-guard initialized", {
  enabled: process.env.YOU_ENABLED === "true",
  hasApiKey: !!process.env.YOU_API_KEY,
})

// --- Types ---

export interface YouVerdict {
  status: "SAFE" | "BLOCKED" | "WARN"
  source: "youcom" | "fallback"
  checked: boolean
  reason?: string
  findings: string[]
  threatKeywordsFound: string[]
}

interface YouComHit {
  title?: string
  description?: string
  url?: string
  snippets?: string[]
}

/** Official API returns results.web + results.news; legacy uses hits. */
interface YouComResponse {
  hits?: YouComHit[]
  results?: {
    web?: YouComHit[]
    news?: Array<{ title?: string; description?: string; url?: string; snippets?: string[] }>
  }
}

// --- Constants ---

const THREAT_KEYWORDS = [
  "malware",
  "exploit",
  "cve-",
  "vulnerability",
  "dangerous",
  "attack",
  "malicious",
  "threat",
  "backdoor",
  "trojan",
  "ransomware",
  "injection",
  "remote code execution",
  "privilege escalation",
  "data exfiltration",
]

const SAFE_VERDICT: YouVerdict = {
  status: "SAFE",
  source: "youcom",
  checked: true,
  findings: [],
  threatKeywordsFound: [],
}

const FALLBACK_VERDICT: YouVerdict = {
  status: "SAFE",
  source: "fallback",
  checked: false,
  findings: [],
  threatKeywordsFound: [],
}

// --- Configuration ---

function getConfig() {
  return {
    enabled: process.env.YOU_ENABLED === "true",
    apiKey: process.env.YOU_API_KEY ?? "",
    timeoutMs: parseInt(process.env.YOU_TIMEOUT_MS ?? "5000", 10),
    maxResults: parseInt(process.env.YOU_MAX_RESULTS ?? "5", 10),
  }
}

// --- Query Building ---

export function buildSecurityQueries(command: string): string[] {
  const truncated = command.slice(0, 80).trim()
  const queries: string[] = []

  queries.push(`${truncated} security risk exploit`)
  queries.push(`${truncated} command dangerous vulnerability`)

  return queries
}

// --- Threat Analysis ---

export function countThreatKeywords(text: string): string[] {
  const lower = text.toLowerCase()
  return THREAT_KEYWORDS.filter((kw) => lower.includes(kw))
}

export function analyzeResults(hits: YouComHit[], command: string): YouVerdict {
  const allFindings: string[] = []
  const allKeywords: Set<string> = new Set()

  for (const hit of hits) {
    const parts = [hit.title ?? "", hit.description ?? "", ...(hit.snippets ?? [])]
    const combined = parts.join(" ")
    const found = countThreatKeywords(combined)

    if (found.length > 0) {
      allFindings.push(`${hit.title ?? hit.url ?? "result"}: ${found.join(", ")}`)
      for (const kw of found) allKeywords.add(kw)
    }
  }

  if (allKeywords.size >= 2) {
    return {
      status: "BLOCKED",
      source: "youcom",
      checked: true,
      reason: `You.com security intelligence found ${allKeywords.size} threat indicators for: ${command.slice(0, 60)}`,
      findings: allFindings,
      threatKeywordsFound: [...allKeywords],
    }
  }

  if (allKeywords.size === 1) {
    return {
      status: "WARN",
      source: "youcom",
      checked: true,
      reason: `You.com detected a potential risk indicator for: ${command.slice(0, 60)}`,
      findings: allFindings,
      threatKeywordsFound: [...allKeywords],
    }
  }

  return { ...SAFE_VERDICT }
}

// --- API Client ---

async function searchYouCom(
  query: string,
  apiKey: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<YouComHit[]> {
  const url = `https://ydc-index.io/v1/search?query=${encodeURIComponent(query)}&count=${maxResults}`

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    },
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown")
    throw new Error(`You.com API error (${response.status}): ${errorText}`)
  }

  const text = await response.text()
  let data: YouComResponse
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("Failed to parse JSON")
  }
  // Official API: results.web + results.news; legacy: hits
  if (data.results?.web?.length || data.results?.news?.length) {
    const web = data.results.web ?? []
    const news = (data.results.news ?? []).map((n) => ({
      title: n.title,
      description: n.description,
      url: n.url,
      snippets: n.snippets ?? (n.description ? [n.description] : []),
    }))
    return [...web, ...news]
  }
  return data.hits ?? []
}

// --- Main Entry Point ---

export async function verify(
  toolName: string,
  toolArgs: Record<string, any>,
  signal: AbortSignal,
): Promise<YouVerdict> {
  const config = getConfig()

  if (!config.enabled) {
    return FALLBACK_VERDICT
  }

  if (!config.apiKey) {
    log.warn("YOU_API_KEY not set, skipping You.com check")
    return FALLBACK_VERDICT
  }

  if (toolName !== "bash") {
    return { ...SAFE_VERDICT, checked: false }
  }

  const command = toolArgs.command ?? toolArgs.input ?? ""
  if (!command || typeof command !== "string") {
    return { ...SAFE_VERDICT }
  }

  try {
    const queries = buildSecurityQueries(command)

    log.info("you.com security check initiated", {
      command: command.slice(0, 80),
      queries: queries.length,
    })

    const allHits: YouComHit[] = []
    let failedQueries = 0

    for (const query of queries) {
      try {
        const hits = await searchYouCom(query, config.apiKey, config.maxResults, signal)
        allHits.push(...hits)
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e
        failedQueries++
        log.warn("you.com query failed, continuing with partial results", {
          query: query.slice(0, 60),
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (failedQueries === queries.length) {
      log.warn("all you.com queries failed, falling back", { command: command.slice(0, 60) })
      return FALLBACK_VERDICT
    }

    if (allHits.length === 0) {
      log.info("you.com returned no results", { command: command.slice(0, 60) })
      return { ...SAFE_VERDICT }
    }

    const verdict = analyzeResults(allHits, command)

    log.info("you.com verdict", {
      status: verdict.status,
      findings: verdict.findings.length,
      keywords: verdict.threatKeywordsFound,
    })

    return verdict
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      log.warn("you.com check timed out", { command: command.slice(0, 60) })
    } else {
      log.error("you.com check failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    return FALLBACK_VERDICT
  }
}
