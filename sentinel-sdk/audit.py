"""
Sentinel-SDK: Audit Logger
Append-only JSON log for all tool call events.
"""

import json
import os
import uuid
from datetime import datetime, timezone


class AuditLogger:
    def __init__(self, audit_path: str):
        self.audit_path = audit_path
        if not os.path.exists(self.audit_path):
            with open(self.audit_path, 'w') as f:
                json.dump([], f)

    def log(self, session_id: str, tool_name: str, tool_input: dict,
            status: str, enforcement: str, risk_reason: str,
            rule_matched: str = None, user_request: str = "",
            retry_number: int = 0, sanitized_command: dict = None,
            execution_result: str = None):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "event_id": f"evt_{uuid.uuid4().hex[:8]}",
            "tool_name": tool_name,
            "tool_input": self._redact(tool_input),
            "status": status,
            "enforcement": enforcement,
            "risk_reason": risk_reason,
            "rule_matched": rule_matched,
            "sanitized_command": sanitized_command,
            "execution_result": (execution_result[:500]
                                 if execution_result else None),
            "retry_number": retry_number,
            "user_request": user_request
        }

        try:
            with open(self.audit_path) as f:
                logs = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            logs = []

        logs.append(entry)

        with open(self.audit_path, 'w') as f:
            json.dump(logs, f, indent=2)

    def _redact(self, tool_input: dict) -> dict:
        redacted = {}
        sensitive_keys = ["password", "token", "key", "secret", "api_key"]
        for k, v in tool_input.items():
            if any(s in k.lower() for s in sensitive_keys):
                redacted[k] = "[REDACTED]"
            else:
                redacted[k] = v
        return redacted

    def get_all(self) -> list:
        try:
            with open(self.audit_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            return []

    def clear(self):
        with open(self.audit_path, 'w') as f:
            json.dump([], f)
