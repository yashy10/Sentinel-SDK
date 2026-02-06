"""
Sentinel-SDK: Agent Loop (The Brain)
Entry point — orchestrates the LLM, Bastion Guard, enforcement, and sandbox.
"""

import asyncio
import json
import os
import uuid
import requests

# Load .env file from project root
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _val = _line.split("=", 1)
                os.environ.setdefault(_key.strip(), _val.strip())

from bastion_guard import BastionGuard, VerdictStatus, EnforcementAction
from enforcement import kill_action, user_input_action, llm_examine_action, invoke_action
from memory import MemoryManager
from sandbox import SandboxExecutor
from audit import AuditLogger

# ─── Tool Definitions ────────────────────────────────────────────────────────

TOOLS_LLAMA = [
    {
        "name": "bash",
        "description": "Execute a bash command in the terminal",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The bash command to run"},
                "description": {"type": "string", "description": "Why you are running this command"}
            },
            "required": ["command"]
        }
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file to read"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Write content to a file",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file"},
                "content": {"type": "string", "description": "Content to write"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "list_files",
        "description": "List files and directories at a given path",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path to list"}
            },
            "required": ["path"]
        }
    }
]

# ─── System Prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT_BASE = """You are a helpful coding assistant. You have access to tools
to execute bash commands, read files, write files, and list directories.
You are working inside a project directory. Help the user with their request.

IMPORTANT: You operate inside a sandboxed environment. All file paths are relative
to the project root. Do not attempt to access files outside the project.

{learned_constraints}"""

# ─── Llama Client Adapter ────────────────────────────────────────────────────

async def call_llama(messages, tools):
    """Call the Llama API."""
    llama_api_url = os.getenv("LLAMA_API_URL")
    if not llama_api_url:
        raise ValueError("LLAMA_API_URL is not set in the environment variables.")

    llama_model = os.getenv("LLAMA_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct")
    headers = {
        "Content-Type": "application/json",
    }

    data = {
        "model": llama_model,
        "messages": messages,
        "max_tokens": 150
    }

    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(llama_api_url, headers=headers, json=data) as response:
                if response.status != 200:
                    raise Exception(f"Llama API call failed with status {response.status}: {await response.text()}")
                result = await response.json()
                return LLMResponse(
                    content=result["choices"][0]["message"]["content"],
                    tool_calls=result.get("tool_calls", []),
                    raw=result
                )
    except Exception as e:
        raise RuntimeError(f"Error while calling Llama API: {e}")

# ─── LLMResponse Class ───────────────────────────────────────────────────────

class LLMResponse:
    """Unified response object for Llama."""
    def __init__(self, content=None, tool_calls=None, raw=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.raw = raw

    def to_dict(self):
        """Convert the response to a dictionary."""
        msg = {"role": "assistant"}
        if self.content:
            msg["content"] = self.content
        if self.tool_calls:
            msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments
                    }
                }
                for tc in self.tool_calls
            ]
        return msg


class ToolCallInfo:
    """Normalized tool call info."""
    def __init__(self, id, name, arguments):
        self.id = id
        self.function = type('Function', (), {
            'name': name,
            'arguments': arguments
        })()

# ─── Agent Loop ──────────────────────────────────────────────────────────────

async def run_agent(user_input: str):
    session_id = str(uuid.uuid4())[:8]

    base_dir = os.path.dirname(os.path.abspath(__file__))
    rules_path = os.path.join(base_dir, "config", "rules.json")
    memory_path = os.path.join(base_dir, "config", "bastion_memory.json")
    sandbox_dir = os.path.join(base_dir, "playground_sandbox", "sample_project")
    audit_path = os.path.join(base_dir, "audit.json")

    guard = BastionGuard(rules_path, memory_path)
    memory = MemoryManager(memory_path)
    sandbox = SandboxExecutor(sandbox_dir)
    audit = AuditLogger(audit_path)

    tools = TOOLS_LLAMA

    constraints = memory.get_injection_text()
    system_prompt = SYSTEM_PROMPT_BASE.format(learned_constraints=constraints)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_input}
    ]

    retry_count = 0
    max_retries = 3
    step = 0

    while retry_count <= max_retries:
        step += 1
        print(f"\n{'─' * 60}")
        print(f"  Step {step} (retries: {retry_count}/{max_retries})")
        print(f"{'─' * 60}")

        # === STEP 1: Ask Llama to propose a tool call ===
        response = await call_llama(messages, tools=tools)

        if not response.tool_calls:
            print(f"\n[AGENT] {response.content}")
            return response.content

        tool_call = response.tool_calls[0]
        tool_name = tool_call.function.name
        tool_args = json.loads(tool_call.function.arguments)

        print(f"[AGENT PROPOSES] Tool: {tool_name}")
        print(f"                 Args: {json.dumps(tool_args, indent=2)}")

        messages.append(response.to_dict())

        # === STEP 2: Bastion Guard checks the proposal ===
        verdict = guard.check(tool_name, tool_args)

        status_icon = {
            VerdictStatus.SAFE: "SAFE",
            VerdictStatus.UNSAFE: "UNSAFE",
        }.get(verdict.status, "?")

        print(f"[BASTION GUARD] Status: {status_icon}")
        print(f"                Enforcement: {verdict.enforcement.value}")
        print(f"                Reason: {verdict.reason}")

        # === STEP 3: Audit log ===
        audit.log(
            session_id=session_id,
            tool_name=tool_name,
            tool_input=tool_args,
            status=verdict.status.value,
            enforcement=verdict.enforcement.value,
            risk_reason=verdict.reason,
            rule_matched=verdict.rule_id or verdict.constraint_id,
            user_request=user_input,
            retry_number=retry_count
        )

        # === STEP 4: Route based on verdict ===
        if verdict.status == VerdictStatus.SAFE:
            result = sandbox.execute(tool_name, tool_args)
            print(f"[EXECUTION] Result: {result[:300]}")

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result
            })

            audit.log(
                session_id=session_id,
                tool_name=tool_name,
                tool_input=tool_args,
                status="EXECUTED",
                enforcement="NONE",
                risk_reason="Execution completed",
                user_request=user_input,
                retry_number=retry_count,
                execution_result=result
            )
            continue

        elif verdict.enforcement == EnforcementAction.KILL:
            error_msg = kill_action(verdict)
            print(f"[KILL] {error_msg}")
            retry_count += 1

    print(f"\n[SENTINEL] Max retries ({max_retries}) exceeded. Ending session.")
    return "I was unable to complete the task safely within the allowed attempts."


# ─── Entry Point ─────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  SENTINEL-SDK  —  Secure Agent Runtime")
    print("=" * 60)

    print(f"  LLM Provider: Llama")
    print("=" * 60)

    while True:
        try:
            user_input = input("\n[YOU] What would you like the agent to do?\n> ")
            if user_input.strip().lower() in ("exit", "quit", "q"):
                print("\nGoodbye!")
                break
            if not user_input.strip():
                continue

            asyncio.run(run_agent(user_input))
        except KeyboardInterrupt:
            print("\n\nGoodbye!")
            break
        except Exception as e:
            print(f"\n[ERROR] {e}")
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    main()