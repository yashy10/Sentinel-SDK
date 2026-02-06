"""
Sentinel-SDK: Sandbox Executor
Safe execution environment using subprocess with cwd restriction.
"""

import subprocess
import os


class SandboxExecutor:
    def __init__(self, sandbox_dir: str, timeout: int = 10):
        self.sandbox_dir = os.path.abspath(sandbox_dir)
        self.timeout = timeout
        os.makedirs(self.sandbox_dir, exist_ok=True)
        os.makedirs(os.path.join(self.sandbox_dir, "trash_bin"), exist_ok=True)

    def execute(self, tool_name: str, tool_args: dict) -> str:
        if tool_name == "bash":
            return self._exec_bash(tool_args.get("command", ""))
        elif tool_name == "read_file":
            return self._exec_read(tool_args.get("path", ""))
        elif tool_name == "write_file":
            return self._exec_write(
                tool_args.get("path", ""),
                tool_args.get("content", "")
            )
        elif tool_name == "list_files":
            return self._exec_list(tool_args.get("path", "."))
        else:
            return f"Error: Unknown tool '{tool_name}'"

    def _exec_bash(self, command: str) -> str:
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                cwd=self.sandbox_dir,
                timeout=self.timeout,
                env={
                    **os.environ,
                    "HOME": self.sandbox_dir,
                }
            )
            output = result.stdout
            if result.stderr:
                output += f"\n[stderr]: {result.stderr}"
            return output if output.strip() else "(empty output)"
        except subprocess.TimeoutExpired:
            return f"Error: Command timed out after {self.timeout}s"
        except Exception as e:
            return f"Error: {str(e)}"

    def _exec_read(self, path: str) -> str:
        full_path = os.path.normpath(os.path.join(self.sandbox_dir, path))
        if not full_path.startswith(self.sandbox_dir):
            return "Error: Access denied. Path is outside sandbox."
        try:
            with open(full_path) as f:
                return f.read()
        except FileNotFoundError:
            return f"Error: File not found: {path}"
        except Exception as e:
            return f"Error: {str(e)}"

    def _exec_write(self, path: str, content: str) -> str:
        full_path = os.path.normpath(os.path.join(self.sandbox_dir, path))
        if not full_path.startswith(self.sandbox_dir):
            return "Error: Access denied. Path is outside sandbox."
        try:
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, 'w') as f:
                f.write(content)
            return f"Successfully wrote {len(content)} bytes to {path}"
        except Exception as e:
            return f"Error: {str(e)}"

    def _exec_list(self, path: str) -> str:
        full_path = os.path.normpath(os.path.join(self.sandbox_dir, path))
        if not full_path.startswith(self.sandbox_dir):
            return "Error: Access denied. Path is outside sandbox."
        try:
            entries = os.listdir(full_path)
            return "\n".join(sorted(entries)) if entries else "(empty directory)"
        except Exception as e:
            return f"Error: {str(e)}"
