/**
 * Test Composio env and API. Run from packages/opencode with .env set:
 *   bun run script/composio-test.ts
 * Loads .env automatically. Requires COMPOSIO_API_KEY; COMPOSIO_USER_ID is optional.
 */
const API_KEY = process.env.COMPOSIO_API_KEY
const USER_ID = process.env.COMPOSIO_USER_ID
const BASE = "https://backend.composio.dev/api/v3"

if (!API_KEY) {
  console.error("❌ COMPOSIO_API_KEY is not set. Add it to packages/opencode/.env")
  process.exit(1)
}

const q = new URLSearchParams()
if (USER_ID) q.set("user_ids", USER_ID)
const path = `/connected_accounts${q.toString() ? `?${q}` : ""}`
const url = `${BASE}${path}`

console.log("Composio API test")
console.log("  COMPOSIO_API_KEY: set")
console.log("  COMPOSIO_USER_ID:", USER_ID ?? "(not set, listing all)")
console.log("  GET", url)

const res = await fetch(url, {
  headers: {
    "x-api-key": API_KEY,
    Accept: "application/json",
  },
})

if (!res.ok) {
  const text = await res.text()
  console.error("❌ Composio API error:", res.status, text)
  process.exit(1)
}

const data = (await res.json()) as { items?: Array<{ id: string; user_id: string; status: string; toolkit?: { slug: string } }> }
const items = data.items ?? []
const apps = [...new Set(items.map((i) => i.toolkit?.slug).filter(Boolean))].sort() as string[]

console.log("✅ Composio API OK")
console.log("  Connected accounts:", items.length)
console.log("  Apps:", apps.length ? apps.join(", ") : "(none)")
process.exit(0)
