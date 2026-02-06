"""
Sentinel-SDK: Enforcement Engine
Four enforcement paths: KILL, USER_INPUT, LLM_EXAMINE, INVOKE_ACTION.
"""

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from bastion_guard import GuardVerdict


# === KILL ===
def kill_action(verdict: GuardVerdict) -> str:
    return (
        f"BLOCKED: {verdict.reason}. "
        f"Rule: {verdict.rule_id or verdict.constraint_id}. "
        f"This action is not permitted. Try a different approach."
    )


# === USER_INPUT ===
async def user_input_action(tool_name: str, tool_args: dict, verdict: GuardVerdict) -> bool:
    print("\n" + "=" * 50)
    print("  HUMAN APPROVAL REQUIRED")
    print("=" * 50)
    print(f"  Tool:    {tool_name}")
    print(f"  Args:    {json.dumps(tool_args, indent=2)}")
    print(f"  Risk:    {verdict.reason}")
    if verdict.suggested_alternative:
        print(f"  Suggest: {verdict.suggested_alternative}")
    print("=" * 50)

    response = input("  Allow this action? [y/N]: ").strip().lower()
    return response == "y"


# === LLM_EXAMINE ===
async def llm_examine_action(
    tool_name: str,
    tool_args: dict,
    verdict: GuardVerdict,
    user_request: str,
    llm_call_fn
) -> dict:
    examine_prompt = f"""You are a security analyst for an AI coding agent.
The agent attempted an action that was blocked by our security policy.

BLOCKED ACTION:
- Tool: {tool_name}
- Input: {json.dumps(tool_args)}
- Block Reason: {verdict.reason}
- Rule Matched: {verdict.rule_id or verdict.constraint_id}
- User's Original Request: {user_request}

YOUR TASK:
1. Analyze why this action is dangerous.
2. Extract a GENERAL safety constraint (not just for this specific command,
   but for the entire category of similar dangerous actions).
3. Write a concise instruction that, if injected into the agent's prompt,
   would prevent the agent from attempting this or similar actions in the future.

Respond ONLY with a JSON object (no markdown, no backticks):
{{
    "learned_rule": "A general description of what to avoid",
    "injection_text": "SECURITY CONSTRAINT: [Specific instruction for the agent to follow]",
    "category": "One of: secrets, destructive, privilege_escalation, exfiltration, system_modification",
    "confidence": 0.0 to 1.0
}}"""

    response = await llm_call_fn(
        messages=[{"role": "user", "content": examine_prompt}],
        tools=[]
    )

    try:
        text = response.content if hasattr(response, 'content') else str(response)
        # Handle Anthropic response format (list of content blocks)
        if isinstance(text, list):
            text = "".join(
                block.text for block in text
                if hasattr(block, 'text')
            )
        text = text.replace("```json", "").replace("```", "").strip()
        constraint_data = json.loads(text)
    except (json.JSONDecodeError, AttributeError):
        constraint_data = {
            "learned_rule": f"Do not use {tool_name} with arguments matching: {json.dumps(tool_args)}",
            "injection_text": (
                f"SECURITY CONSTRAINT: Do not attempt actions similar to "
                f"'{tool_name}: {json.dumps(tool_args)}' as they violate security policy."
            ),
            "category": "unknown",
            "confidence": 0.7
        }

    constraint = {
        "id": f"C{uuid.uuid4().hex[:6].upper()}",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_event": f"Agent attempted: {tool_name}({json.dumps(tool_args)})",
        "blocked_tool": tool_name,
        "blocked_input": json.dumps(tool_args),
        "rule_triggered": verdict.rule_id or verdict.constraint_id,
        "learned_rule": constraint_data["learned_rule"],
        "injection_text": constraint_data["injection_text"],
        "confidence": constraint_data.get("confidence", 0.8),
        "times_enforced": 0,
        "category": constraint_data.get("category", "unknown")
    }

    return constraint


# === INVOKE_ACTION (Auto-Fix Sanitizer) ===
def invoke_action(tool_name: str, tool_args: dict, verdict: GuardVerdict) -> dict:
    sanitized = dict(tool_args)

    if tool_name == "bash":
        cmd = sanitized.get("command", "")

        # Strip sudo
        cmd = re.sub(r'\bsudo\s+', '', cmd)

        # Replace rm -rf with mv to trash
        cmd = re.sub(
            r'rm\s+(-[rf]+\s+)+(.+)',
            r'mv \2 ./trash_bin/',
            cmd
        )

        # Convert absolute paths to relative (within project)
        cmd = re.sub(r'(?<!\.)(/[a-zA-Z])', r'.\1', cmd)

        # Block pipe-to-shell patterns
        cmd = re.sub(
            r'(curl|wget)\s+.*\|\s*(bash|sh|zsh)',
            r'echo "BLOCKED: pipe-to-shell not allowed"',
            cmd
        )

        sanitized["command"] = cmd

    elif tool_name in ("read_file", "write_file"):
        path = sanitized.get("path", "")
        if re.search(r'\.(env|credentials|secret|pem)$|id_rsa', path):
            sanitized["path"] = "./SENTINEL_BLOCKED_ACCESS.txt"

    return sanitized
