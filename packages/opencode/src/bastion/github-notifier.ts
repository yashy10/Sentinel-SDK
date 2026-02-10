import { Log } from "@/util/log"
import type { GuardVerdict } from "./guard"

const log = Log.create({ service: "bastion-github-notifier" })

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPO = process.env.GITHUB_REPO?.replace(/^(GITHUB_REPO=)+/, "").trim() // allow typo GITHUB_REPO=owner/repo
const ENABLED = process.env.ENABLE_GITHUB_NOTIFICATIONS === "true" && !!GITHUB_TOKEN && !!GITHUB_REPO

export function notifyBastionBlock(verdict: GuardVerdict, toolName: string, toolArgs: Record<string, unknown>, sessionID?: string): void {
  if (!ENABLED) return
  const title = "🚨 Bastion Guard blocked action"
  const body = [
    "This issue was created when Bastion Guard detected and blocked a potentially dangerous action.",
    "",
    "## Details",
    `- **Tool:** \`${toolName}\``,
    `- **Rule/Constraint:** ${verdict.ruleID ?? verdict.constraintID ?? "—"}`,
    `- **Reason:** ${verdict.reason}`,
    verdict.suggestedAlternative ? `- **Suggested alternative:** ${verdict.suggestedAlternative}` : null,
    sessionID ? `- **Session:** ${sessionID}` : null,
    "",
    "## Blocked input (sanitized)",
    "```json",
    JSON.stringify(toolArgs, null, 2),
    "```",
  ]
    .filter(Boolean)
    .join("\n")

  const payload = {
    title,
    body,
    labels: ["sentinel-sdk", "bastion", "security"],
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/issues`
  fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      if (res.status === 201) {
        const data = res.json() as Promise<{ html_url: string }>
        return data.then((d) => log.info("github issue created", { url: d.html_url }))
      }
      return res.text().then((text) => log.warn("github issue failed", { status: res.status, body: text }))
    })
    .catch((err) => log.warn("github notifier error", { err: err instanceof Error ? err.message : String(err) }))
}

