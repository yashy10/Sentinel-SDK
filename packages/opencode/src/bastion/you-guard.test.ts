import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { verify, buildSecurityQueries, countThreatKeywords, analyzeResults } from "./you-guard"

// --- Helpers ---

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = mock(handler) as any
}

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
}

beforeEach(() => {
  setEnv({
    YOU_ENABLED: "true",
    YOU_API_KEY: "ydc-sk-398a109522d9704d-ba8LAtgDCmE58OjM35F1hobESoeMBEws-cc4f7e30",
    YOU_TIMEOUT_MS: "5000",
    YOU_MAX_RESULTS: "5",
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

// --- Unit Tests: buildSecurityQueries ---

describe("buildSecurityQueries", () => {
  test("generates 2 queries from a command", () => {
    const queries = buildSecurityQueries("rm -rf /")
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain("rm -rf /")
    expect(queries[0]).toContain("security risk exploit")
    expect(queries[1]).toContain("dangerous vulnerability")
  })

  test("truncates long commands to 80 chars", () => {
    const longCmd = "a".repeat(200)
    const queries = buildSecurityQueries(longCmd)
    for (const q of queries) {
      expect(q.length).toBeLessThan(200)
    }
  })
})

// --- Unit Tests: countThreatKeywords ---

describe("countThreatKeywords", () => {
  test("finds threat keywords in text", () => {
    const found = countThreatKeywords("This command has a malware vulnerability exploit")
    expect(found).toContain("malware")
    expect(found).toContain("vulnerability")
    expect(found).toContain("exploit")
  })

  test("returns empty array for safe text", () => {
    const found = countThreatKeywords("How to list files in a directory")
    expect(found).toHaveLength(0)
  })

  test("is case insensitive", () => {
    const found = countThreatKeywords("MALWARE detected in EXPLOIT")
    expect(found).toContain("malware")
    expect(found).toContain("exploit")
  })
})

// --- Unit Tests: analyzeResults ---

describe("analyzeResults", () => {
  test("returns BLOCKED when 2+ threat keywords found", () => {
    const hits = [
      {
        title: "Dangerous malware exploit",
        description: "This vulnerability is a known exploit vector",
      },
    ]
    const verdict = analyzeResults(hits, "bad command")
    expect(verdict.status).toBe("BLOCKED")
    expect(verdict.threatKeywordsFound.length).toBeGreaterThanOrEqual(2)
  })

  test("returns WARN when exactly 1 threat keyword found", () => {
    const hits = [
      {
        title: "Some tutorial",
        description: "Be careful as this could be dangerous",
      },
    ]
    const verdict = analyzeResults(hits, "some command")
    expect(verdict.status).toBe("WARN")
    expect(verdict.threatKeywordsFound).toHaveLength(1)
  })

  test("returns SAFE when no threat keywords found", () => {
    const hits = [
      {
        title: "How to use rm command",
        description: "Tutorial on removing files safely",
      },
    ]
    const verdict = analyzeResults(hits, "rm file.txt")
    expect(verdict.status).toBe("SAFE")
    expect(verdict.threatKeywordsFound).toHaveLength(0)
  })

  test("returns SAFE for empty hits", () => {
    const verdict = analyzeResults([], "ls -la")
    expect(verdict.status).toBe("SAFE")
  })

  test("checks snippets in hits", () => {
    const hits = [
      {
        title: "Some page",
        description: "Normal description",
        snippets: ["This contains a malware backdoor trojan"],
      },
    ]
    const verdict = analyzeResults(hits, "test")
    expect(verdict.status).toBe("BLOCKED")
    expect(verdict.threatKeywordsFound).toContain("malware")
    expect(verdict.threatKeywordsFound).toContain("backdoor")
  })
})

// --- Integration Tests: verify ---

describe("verify", () => {
  test("returns fallback when YOU_ENABLED is false", async () => {
    setEnv({ YOU_ENABLED: "false" })
    const verdict = await verify("bash", { command: "rm -rf /" }, AbortSignal.timeout(5000))
    expect(verdict.source).toBe("fallback")
    expect(verdict.checked).toBe(false)
  })

  test("returns fallback when YOU_API_KEY is missing", async () => {
    setEnv({ YOU_API_KEY: undefined })
    const verdict = await verify("bash", { command: "ls" }, AbortSignal.timeout(5000))
    expect(verdict.source).toBe("fallback")
    expect(verdict.checked).toBe(false)
  })

  test("skips non-bash tools", async () => {
    mockFetch(async () => new Response("should not be called"))
    const verdict = await verify("read", { file_path: "foo.txt" }, AbortSignal.timeout(5000))
    expect(verdict.status).toBe("SAFE")
    expect(verdict.checked).toBe(false)
  })

  test("returns SAFE for benign command", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          hits: [
            {
              title: "How to list files in Linux",
              description: "Use the ls command to list directory contents",
            },
          ],
        }),
      ),
    )

    const verdict = await verify("bash", { command: "ls -la" }, AbortSignal.timeout(5000))
    expect(verdict.status).toBe("SAFE")
    expect(verdict.checked).toBe(true)
  })

  test("returns BLOCKED for command with multiple threat keywords", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          hits: [
            {
              title: "rm -rf vulnerability",
              description: "This command is dangerous and can cause malware infection through exploit",
            },
          ],
        }),
      ),
    )

    const verdict = await verify("bash", { command: "rm -rf /" }, AbortSignal.timeout(5000))
    expect(verdict.status).toBe("BLOCKED")
    expect(verdict.threatKeywordsFound.length).toBeGreaterThanOrEqual(2)
  })

  test("returns fallback on API timeout", async () => {
    mockFetch(async (_url, init) => {
      const signal = init?.signal
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError")
      return new Promise<Response>((_, reject) => {
        const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"))
        if (signal) signal.addEventListener("abort", onAbort)
      })
    })

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const verdict = await verify("bash", { command: "ls" }, controller.signal)
    expect(verdict.source).toBe("fallback")
    expect(verdict.checked).toBe(false)
  })

  test("returns fallback on API error", async () => {
    mockFetch(async () => new Response("Internal Server Error", { status: 500 }))

    const verdict = await verify("bash", { command: "ls" }, AbortSignal.timeout(5000))
    expect(verdict.source).toBe("fallback")
    expect(verdict.checked).toBe(false)
  })

  test("returns SAFE for empty API response", async () => {
    mockFetch(async () => new Response(JSON.stringify({ hits: [] })))

    const verdict = await verify("bash", { command: "echo hello" }, AbortSignal.timeout(5000))
    expect(verdict.status).toBe("SAFE")
    expect(verdict.checked).toBe(true)
  })

  test("returns SAFE for empty command", async () => {
    const verdict = await verify("bash", { command: "" }, AbortSignal.timeout(5000))
    expect(verdict.status).toBe("SAFE")
  })

  test("handles malformed JSON response gracefully", async () => {
    mockFetch(async () => new Response("not json at all", { status: 200 }))

    const verdict = await verify("bash", { command: "ls" }, AbortSignal.timeout(5000))
    expect(verdict.source).toBe("fallback")
    expect(verdict.checked).toBe(false)
  })
})
