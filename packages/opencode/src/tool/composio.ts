import z from "zod"
import { Tool } from "./tool"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.composio" })

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY
const COMPOSIO_USER_ID = process.env.COMPOSIO_USER_ID
const BASE = "https://backend.composio.dev/api/v3"

async function composioFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY is not set. Set it in .env to use Composio.")
  }
  const url = path.startsWith("http") ? path : `${BASE}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      "x-api-key": COMPOSIO_API_KEY,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    log.warn("composio api error", { status: res.status, path, body })
    throw new Error(`Composio API error: ${res.status} ${body}`)
  }
  return res.json() as Promise<T>
}

interface ConnectedAccountItem {
  id: string
  user_id: string
  status: string
  toolkit?: { slug: string }
  created_at?: string
}

interface ConnectedAccountsResponse {
  items?: ConnectedAccountItem[]
  next_cursor?: string
  total_items?: number
}

export const ComposioTool = Tool.define("composio", async () => ({
  description:
    "List connected Composio apps for the current user. Use this to see which integrations (e.g. GitHub, Slack) are connected. Requires COMPOSIO_API_KEY and optionally COMPOSIO_USER_ID in env.",
  parameters: z.object({
    action: z.literal("list_connected_apps").describe("List connected Composio applications"),
  }),
  async execute(params, ctx) {
    const userIds = COMPOSIO_USER_ID ? [COMPOSIO_USER_ID] : undefined
    const q = new URLSearchParams()
    if (userIds?.length) q.set("user_ids", userIds.join(","))
    const path = `/connected_accounts${q.toString() ? `?${q}` : ""}`
    const data = await composioFetch<ConnectedAccountsResponse>(path)
    const items = data.items ?? []
    const apps = items
      .map((i) => i.toolkit?.slug ?? "unknown")
      .filter((s) => s !== "unknown")
    const unique = [...new Set(apps)].sort()
    const summary =
      unique.length === 0
        ? "No connected Composio apps found. Connect apps at https://app.composio.dev"
        : `Connected Composio apps (${unique.length}): ${unique.join(", ")}`
    return {
      title: "Composio connected apps",
      output: summary,
      metadata: {},
    }
  },
}))
