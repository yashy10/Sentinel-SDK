# Demo: You.com + Akash (Llama) in OpenCode

This guide walks you through running OpenCode with **You.com** security checks and **Akash** (Llama) as the default LLM, and how to **visually confirm** both are working.

## Prerequisites

- OpenCode dev setup (e.g. `bun install`, `bun dev` from repo root or `packages/opencode`)
- **You.com:** API key from [you.com/api](https://you.com/api) (full key, not the masked value)
- **Akash (display only):** Set `LLAMA_API_URL` to show "Akash Llama" as the default; under the hood OpenAI is used, so **OPENAI_API_KEY** is required.

## 1. Set environment variables

From the repo root (or where you run `bun dev`):

```bash
# You.com (for bash command security checks)
export YOU_ENABLED=true
export YOU_API_KEY="ydc-sk-xxxxxxxxxxxxxxxxxxxx"   # paste your full key from you.com/api

# Show "Akash Llama" as default provider ()
export LLAMA_API_URL="http://provider.h100.ams2.val.akash.pub:30216/v1/chat/completions"
export OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxx"  # required when LLAMA_API_URL is set
```

Optional: put these in `packages/opencode/.env` so they load automatically.

**Composio (optional):** To enable the Composio tool (list connected apps, e.g. GitHub/Slack) set `COMPOSIO_API_KEY` and optionally `COMPOSIO_USER_ID` (entity id from [app.composio.dev](https://app.composio.dev)). The tool is registered only when the API key is set. Test with: `cd packages/opencode && bun run script/composio-test.ts`.

**GitHub notifications (Bastion blocks):** To create a GitHub issue whenever Bastion Guard blocks a dangerous action (rule/constraint or You.com):

```bash
export ENABLE_GITHUB_NOTIFICATIONS=true
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"   # Personal access token (repo scope)
export GITHUB_REPO="owner/repo"                   # e.g. AbeBhatti/Test
```

## 2. Start OpenCode

```bash
bun dev
```

Or from repo root: `cd packages/opencode && bun dev`. The TUI should open.

## 3. How to see it working (visual verification)

### Akash (Llama) as default

- **Model selector:** In the TUI header/status bar, open the model selector (e.g. click the model name or use the keybind for “Open provider list”). You should see **Akash Llama** as the first provider and **llama** as the model. When `LLAMA_API_URL` is set, Akash is the default, so the first provider in the list is Akash and it’s used when you haven’t chosen another.
- **Responses:** Send a simple message (e.g. *“What is 2+2?”*). The reply should come from the Llama model on the Akash endpoint. If you see a normal, coherent answer, Akash/Llama is working.

### You.com on bash commands

- **Bash output line:** Ask the agent to run a **shell command**, e.g.:
  - *“List files in the current directory.”*
  - *“Run `ls -la` in the project root and tell me what’s there.”*
  When the agent uses the **bash** tool, the **first line** of the tool output in the TUI will be either:
  - **“You.com was used for this check.”** — You.com was queried and its verdict was used.
  - **“You.com was not used for this check.”** — You.com was skipped (e.g. key missing or disabled).
  So you can visually confirm You.com is in the loop by checking that this line appears on every bash run.
- **Logs (optional):** In another terminal:
  ```bash
  tail -f ~/.local/share/opencode/log/dev.log | grep "you-guard\|you.com"
  ```
  For each bash command you should see lines like:
  - `you.com security check initiated`
  - `you.com verdict` with `status=SAFE` or `status=BLOCKED`

### Quick checklist

| What to check | Where to look |
|---------------|----------------|
| Akash is default | Model selector: “Akash Llama” / “llama” is first (or selected). |
| Llama is responding | Send any message; reply is coherent and from the model. |
| You.com is used for bash | Run a bash command; first line of bash output is “You.com was used…” or “…not used…”. |
| You.com blocks bad commands | Try *“Run rm -rf /”*; should be blocked; logs show `status=BLOCKED`. |
| GitHub issue on Bastion block | Set `ENABLE_GITHUB_NOTIFICATIONS=true`, `GITHUB_TOKEN`, `GITHUB_REPO`; trigger a block; check repo **Issues** for a new issue with labels `sentinel-sdk`, `bastion`. |

### GitHub issues when Bastion blocks

When **ENABLE_GITHUB_NOTIFICATIONS=true** and **GITHUB_TOKEN** / **GITHUB_REPO** are set, every time Bastion blocks an action (static rule, learned constraint, or You.com), a new issue is created in your repo.

**How to see it:**

1. Set the three env vars above and restart OpenCode.
2. In the TUI or web app, ask the agent to do something Bastion will block, e.g.:
   - *“Run `rm -rf /`”* or *“Delete everything in the project.”*
   - *“Read the contents of `.env`.”*
3. Bastion will prompt you (or block). When it does, a GitHub issue is created in the background.
4. Open your repo on GitHub → **Issues**. You should see a new issue with:
   - Title like **🚨 Bastion Guard blocked action** or **🚨 You.com Security Intelligence blocked action**
   - Labels: `sentinel-sdk`, `bastion`, `security` (and `you.com` for You.com blocks)
   - Body with tool name, rule/constraint, reason, and the blocked input.

If no issue appears, check that the repo has the **sentinel-sdk** and **bastion** labels (create them if your repo requires existing labels), and that `GITHUB_TOKEN` has `repo` scope.

## 5. Optional: explicit default model

If you want to force **akash/llama** even when other providers are available, set in `opencode.json` (project or global config):

```json
{
  "model": "akash/llama"
}
```

When `LLAMA_API_URL` is set, Akash is already placed first in the provider list, so in most cases you’ll get Akash/llama by default without this.

## 6. Troubleshooting

- **You.com line never appears:** Ensure `YOU_ENABLED=true` (exact) and `YOU_API_KEY` is the full key. Restart OpenCode after changing env.
- **“You.com was not used” every time:** Same as above; also check `packages/opencode/.env` if you use it.
- **No Akash in the list:** Ensure `LLAMA_API_URL` is set. Restart OpenCode.
- **Akash/llama errors when sending a message:** When `LLAMA_API_URL` is set, requests use OpenAI; set `OPENAI_API_KEY` and ensure it is valid.

For more on You.com (prompts, logs, audit), see `sentinel-sdk/README.md` and `packages/opencode/src/bastion/README.md`.

---

## 7. Master prompt (test all in one)

Paste this **once** to exercise **Akash**, **You.com**, and **Composio** in a single turn.

**What to check after:** (1) Model selector shows **Akash Llama** and the reply is from it. (2) You.com/Bastion blocks the dangerous delete — you see a permission prompt or block message, and the bash tool output (if it ran) shows **“You.com was used for this check.”** (3) The agent used the **composio** tool and reported connected apps or said Composio is not configured.

**Master prompt (copy-paste):**

```
Do these three things in order and report the result for each:

1) Akash: Answer in one sentence: what is 2+2? (Confirms the default model — Akash Llama — is responding.)

2) You.com: Try to delete the opencode folder (e.g. run "rm -rf opencode" or equivalent). Report what happens: whether the action was blocked by You.com or Bastion, and if a bash tool ran, what the first line of its output was ("You.com was used..." or "You.com was not used...").

3) Composio: Use the composio tool to list connected apps (action: list_connected_apps). Report the result: either the list of connected apps (e.g. github, slack) or that Composio is not configured.
```

---

## 8. One prompt per functionality

Use these when you want to test a single piece.

| Functionality | Prompt | What to verify |
|---------------|--------|----------------|
| **Akash (Llama)** | `What is 2+2? Reply in one short sentence.` | Model selector shows **Akash Llama**; reply is coherent from the default model. |
| **You.com** | `Run ls -la in the current directory and tell me the first line of the bash tool output (it should say "You.com was used..." or "You.com was not used...").` | First line of bash output shows You.com check status. |
| **Composio** | `List my connected Composio apps.` or `Use the composio tool to list connected apps.` | When `COMPOSIO_API_KEY` is set, the **composio** tool is available; the agent will call it and report connected apps (e.g. GitHub, Slack). Verify with `bun run script/composio-test.ts` from `packages/opencode`. |
| **Bastion Guard** | See prompt below. | Bastion runs when the agent executes a guarded tool (e.g. bash, read). Use a prompt that makes the agent try a blocked action so you see the enforcement dialog. |

**One prompt that will get Bastion Guard to be called (copy-paste):**

```
Run this command in the project: rm -rf opencode
```

The agent will call the **bash** tool with `rm -rf opencode`. Bastion Guard will evaluate it, match rule R002 (destructive rm), and show the enforcement prompt (Block / Execute anyway / LLM examine / Invoke action). If `ENABLE_GITHUB_NOTIFICATIONS=true` and `GITHUB_TOKEN` / `GITHUB_REPO` are set, a GitHub issue will also be created.