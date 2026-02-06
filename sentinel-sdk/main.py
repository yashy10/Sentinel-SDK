"""
Sentinel-SDK: Agent Loop (The Brain)
Entry point — orchestrates the LLM, Bastion Guard, enforcement, and sandbox.
"""

import asyncio
import json
import os
import uuid

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

TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
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
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file to read"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
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
        }
    },
    {
        "type": "function",
        "function": {
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
    }
]

# Anthropic tool format
TOOLS_ANTHROPIC = [
    {
        "name": "bash",
        "description": "Execute a bash command in the terminal",
        "input_schema": {
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
        "input_schema": {
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
        "input_schema": {
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
        "input_schema": {
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

# ─── LLM Client Adapters ─────────────────────────────────────────────────────

LLM_PROVIDER = None


def detect_provider():
    global LLM_PROVIDER
    if os.getenv("ANTHROPIC_API_KEY"):
        LLM_PROVIDER = "anthropic"
    elif os.getenv("OPENAI_API_KEY"):
        LLM_PROVIDER = "openai"
    else:
        raise ValueError(
            "No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY."
        )
    return LLM_PROVIDER


async def call_llm(messages, tools):
    if LLM_PROVIDER == "anthropic":
        return await call_anthropic(messages, tools)
    else:
        return await call_openai(messages, tools)


# ─── OpenAI Adapter ──────────────────────────────────────────────────────────

class LLMResponse:
    """Unified response object for both providers."""
    def __init__(self, content=None, tool_calls=None, raw=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.raw = raw

    def to_dict_openai(self):
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

    def to_dict_anthropic(self):
        content_blocks = []
        if self.content:
            content_blocks.append({"type": "text", "text": self.content})
        if self.tool_calls:
            for tc in self.tool_calls:
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc.id,
                    "name": tc.function.name,
                    "input": json.loads(tc.function.arguments)
                })
        return {"role": "assistant", "content": content_blocks}

    def to_dict(self):
        if LLM_PROVIDER == "anthropic":
            return self.to_dict_anthropic()
        return self.to_dict_openai()


class ToolCallInfo:
    """Normalized tool call info."""
    def __init__(self, id, name, arguments):
        self.id = id
        self.function = type('Function', (), {
            'name': name,
            'arguments': arguments
        })()


async def call_openai(messages, tools):
    from openai import AsyncOpenAI
    client = AsyncOpenAI()

    kwargs = {
        "model": os.getenv("OPENAI_MODEL", "gpt-4o"),
        "messages": messages,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"

    response = await client.chat.completions.create(**kwargs)
    msg = response.choices[0].message

    tool_calls = []
    if msg.tool_calls:
        for tc in msg.tool_calls:
            tool_calls.append(ToolCallInfo(
                id=tc.id,
                name=tc.function.name,
                arguments=tc.function.arguments
            ))

    return LLMResponse(
        content=msg.content,
        tool_calls=tool_calls,
        raw=msg
    )


async def call_anthropic(messages, tools):
    import anthropic
    client = anthropic.AsyncAnthropic()

    # Separate system message from conversation
    system_text = ""
    conv_messages = []
    for msg in messages:
        if msg["role"] == "system":
            system_text = msg["content"]
        elif msg["role"] == "tool":
            # Anthropic uses tool_result content blocks
            conv_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": msg["tool_call_id"],
                    "content": msg["content"]
                }]
            })
        else:
            conv_messages.append(msg)

    # Merge consecutive same-role messages (Anthropic requires alternation)
    merged = []
    for msg in conv_messages:
        if merged and merged[-1]["role"] == msg["role"]:
            # Merge content
            prev_content = merged[-1]["content"]
            new_content = msg["content"]
            if isinstance(prev_content, str) and isinstance(new_content, str):
                merged[-1]["content"] = prev_content + "\n" + new_content
            elif isinstance(prev_content, list) and isinstance(new_content, list):
                merged[-1]["content"] = prev_content + new_content
            elif isinstance(prev_content, str) and isinstance(new_content, list):
                merged[-1]["content"] = [{"type": "text", "text": prev_content}] + new_content
            elif isinstance(prev_content, list) and isinstance(new_content, str):
                merged[-1]["content"] = prev_content + [{"type": "text", "text": new_content}]
        else:
            merged.append(dict(msg))
    conv_messages = merged

    kwargs = {
        "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929"),
        "max_tokens": 4096,
        "messages": conv_messages,
    }
    if system_text:
        kwargs["system"] = system_text
    if tools:
        kwargs["tools"] = tools

    response = await client.messages.create(**kwargs)

    content_text = ""
    tool_calls = []
    for block in response.content:
        if block.type == "text":
            content_text += block.text
        elif block.type == "tool_use":
            tool_calls.append(ToolCallInfo(
                id=block.id,
                name=block.name,
                arguments=json.dumps(block.input)
            ))

    return LLMResponse(
        content=content_text if content_text else None,
        tool_calls=tool_calls,
        raw=response
    )


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

    # Select tools format based on provider
    tools = TOOLS_ANTHROPIC if LLM_PROVIDER == "anthropic" else TOOLS_OPENAI

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

        # === STEP 1: Ask LLM to propose a tool call ===
        response = await call_llm(messages, tools=tools)

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

            if LLM_PROVIDER == "anthropic":
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call.id,
                        "content": result
                    }]
                })
            else:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result
                })

            # Update audit with execution result
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

            # Let LLM continue or generate final response
            continue

        elif verdict.enforcement == EnforcementAction.KILL:
            error_msg = kill_action(verdict)
            print(f"[KILL] {error_msg}")

            tool_result = f"ERROR: Action blocked by security policy. {error_msg}"
            if LLM_PROVIDER == "anthropic":
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call.id,
                        "content": tool_result,
                        "is_error": True
                    }]
                })
            else:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": tool_result
                })
            retry_count += 1

        elif verdict.enforcement == EnforcementAction.USER_INPUT:
            approved = await user_input_action(tool_name, tool_args, verdict)
            if approved:
                result = sandbox.execute(tool_name, tool_args)
                print(f"[EXECUTION] (Human approved) {result[:300]}")

                if LLM_PROVIDER == "anthropic":
                    messages.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_call.id,
                            "content": result
                        }]
                    })
                else:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result
                    })
                continue
            else:
                tool_result = "ERROR: Action denied by human operator."
                if LLM_PROVIDER == "anthropic":
                    messages.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_call.id,
                            "content": tool_result,
                            "is_error": True
                        }]
                    })
                else:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_result
                    })
                retry_count += 1

        elif verdict.enforcement == EnforcementAction.LLM_EXAMINE:
            new_constraint = await llm_examine_action(
                tool_name=tool_name,
                tool_args=tool_args,
                verdict=verdict,
                user_request=user_input,
                llm_call_fn=call_llm
            )

            memory.add_constraint(new_constraint)
            print(f"[LEARNED] New constraint: {new_constraint['injection_text']}")

            # Reload constraints and rebuild system prompt
            constraints = memory.get_injection_text()
            messages[0]["content"] = SYSTEM_PROMPT_BASE.format(
                learned_constraints=constraints
            )

            tool_result = (
                f"ERROR: Action blocked by security policy. {verdict.reason}. "
                f"New constraint learned: {new_constraint['learned_rule']}. "
                f"Please try a different, safer approach."
            )

            if LLM_PROVIDER == "anthropic":
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call.id,
                        "content": tool_result,
                        "is_error": True
                    }]
                })
            else:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": tool_result
                })
            retry_count += 1

            audit.log(
                session_id=session_id,
                tool_name="system",
                tool_input={"action": "constraint_learned"},
                status="LEARNED",
                enforcement="LLM_EXAMINE",
                risk_reason=f"New constraint: {new_constraint['learned_rule']}",
                rule_matched=new_constraint.get("id"),
                user_request=user_input,
                retry_number=retry_count
            )

        elif verdict.enforcement == EnforcementAction.INVOKE_ACTION:
            sanitized = invoke_action(tool_name, tool_args, verdict)
            print(f"[INVOKE] Sanitized: {json.dumps(sanitized)}")

            re_verdict = guard.check(tool_name, sanitized)
            if re_verdict.status == VerdictStatus.SAFE:
                result = sandbox.execute(tool_name, sanitized)
                print(f"[EXECUTION] (Sanitized) {result[:300]}")

                if LLM_PROVIDER == "anthropic":
                    messages.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_call.id,
                            "content": result
                        }]
                    })
                else:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result
                    })

                audit.log(
                    session_id=session_id,
                    tool_name=tool_name,
                    tool_input=tool_args,
                    status="SANITIZED_EXECUTED",
                    enforcement="INVOKE_ACTION",
                    risk_reason="Auto-sanitized and executed",
                    user_request=user_input,
                    retry_number=retry_count,
                    sanitized_command=sanitized,
                    execution_result=result
                )
                continue
            else:
                tool_result = "ERROR: Action blocked. Auto-fix also failed safety check."
                if LLM_PROVIDER == "anthropic":
                    messages.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_call.id,
                            "content": tool_result,
                            "is_error": True
                        }]
                    })
                else:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_result
                    })
                retry_count += 1

    print(f"\n[SENTINEL] Max retries ({max_retries}) exceeded. Ending session.")
    return "I was unable to complete the task safely within the allowed attempts."


# ─── Entry Point ─────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  SENTINEL-SDK  —  Secure Agent Runtime")
    print("=" * 60)

    detect_provider()
    print(f"  LLM Provider: {LLM_PROVIDER}")
    print("=" * 60)

    while True:
        try:
            user_input = input("\n[YOU] What would you like the agent to do?\n> ")
            if user_input.strip().lower() in ("exit", "quit", "q"):
                print("\nGoodbye!")
                break
            if user_input.strip().lower() == "reset":
                memory = MemoryManager(
                    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "config", "bastion_memory.json")
                )
                memory.clear()
                audit = AuditLogger(
                    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "audit.json")
                )
                audit.clear()
                print("[SENTINEL] Memory and audit log cleared.")
                continue
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
