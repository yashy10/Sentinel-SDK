"""
Sentinel-SDK: Bastion Guard
Deterministic security gate — regex matching, string checking, JSON lookup.
No LLM calls. Pure Python.
"""

import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class VerdictStatus(Enum):
    SAFE = "SAFE"
    UNSAFE = "UNSAFE"


class EnforcementAction(Enum):
    NONE = "NONE"
    KILL = "KILL"
    USER_INPUT = "USER_INPUT"
    LLM_EXAMINE = "LLM_EXAMINE"
    INVOKE_ACTION = "INVOKE_ACTION"


@dataclass
class GuardVerdict:
    status: VerdictStatus
    enforcement: EnforcementAction
    reason: str
    rule_id: Optional[str] = None
    constraint_id: Optional[str] = None
    matched_pattern: Optional[str] = None
    suggested_alternative: Optional[str] = None


class BastionGuard:
    def __init__(self, rules_path: str, memory_path: str):
        with open(rules_path) as f:
            self.rules = json.load(f)["rules"]
        self.memory_path = memory_path
        self._load_memory()

    def _load_memory(self):
        try:
            with open(self.memory_path) as f:
                data = json.load(f)
                self.constraints = data.get("constraints", [])
        except (FileNotFoundError, json.JSONDecodeError):
            self.constraints = []

    def check(self, tool_name: str, tool_args: dict) -> GuardVerdict:
        # Reload memory each time (picks up newly learned constraints)
        self._load_memory()

        input_str = self._flatten_input(tool_name, tool_args)

        # --- Layer 1: Check static rules ---
        for rule in self.rules:
            if not rule.get("enabled", True):
                continue
            if not self._rule_applies_to_tool(rule, tool_name):
                continue
            if self._matches_rule(rule, input_str, tool_args):
                return GuardVerdict(
                    status=VerdictStatus.UNSAFE,
                    enforcement=EnforcementAction(rule["enforcement"]),
                    reason=f"Static rule '{rule['name']}': {rule['description']}",
                    rule_id=rule["id"],
                    matched_pattern=rule["pattern"],
                    suggested_alternative=rule.get("suggested_alternative")
                )

        # --- Layer 2: Check dynamic constraints ---
        for constraint in self.constraints:
            if constraint.get("confidence", 1.0) < 0.5:
                continue
            if self._matches_constraint(constraint, input_str, tool_name):
                return GuardVerdict(
                    status=VerdictStatus.UNSAFE,
                    enforcement=EnforcementAction.LLM_EXAMINE,
                    reason=f"Learned constraint '{constraint['id']}': {constraint['learned_rule']}",
                    constraint_id=constraint["id"],
                    matched_pattern=constraint.get("blocked_input", "")
                )

        # --- No matches: SAFE ---
        return GuardVerdict(
            status=VerdictStatus.SAFE,
            enforcement=EnforcementAction.NONE,
            reason="No rules or constraints triggered"
        )

    def _flatten_input(self, tool_name: str, tool_args: dict) -> str:
        parts = [tool_name]
        for key, value in tool_args.items():
            parts.append(str(value))
        return " ".join(parts).lower()

    def _rule_applies_to_tool(self, rule: dict, tool_name: str) -> bool:
        scope = rule.get("tool_scope", ["*"])
        return "*" in scope or tool_name in scope

    def _matches_rule(self, rule: dict, input_str: str, tool_args: dict) -> bool:
        pattern = rule["pattern"]
        rule_type = rule.get("type", "regex")

        if rule_type == "regex":
            return bool(re.search(pattern, input_str, re.IGNORECASE))
        elif rule_type == "command_prefix":
            cmd = tool_args.get("command", "")
            return cmd.strip().lower().startswith(pattern.lower())
        elif rule_type == "contains":
            return pattern.lower() in input_str
        elif rule_type == "exact":
            cmd = tool_args.get("command", tool_args.get("path", ""))
            return cmd.strip().lower() == pattern.lower()
        return False

    def _matches_constraint(self, constraint: dict, input_str: str, tool_name: str) -> bool:
        blocked_input = constraint.get("blocked_input", "").lower()
        blocked_tool = constraint.get("blocked_tool", "")

        # Direct match on the blocked input pattern
        if blocked_input and blocked_input in input_str:
            return True

        # Category-based matching for generalization
        category = constraint.get("category", "")
        if category == "secrets":
            secret_patterns = [".env", ".credentials", "id_rsa", ".ssh",
                               "secret", "token", "api_key", ".pem"]
            for pat in secret_patterns:
                if pat in input_str:
                    return True

        if category == "destructive":
            destructive_patterns = ["rm -rf", "rm -r", "rmdir", "del /f",
                                    "format", "mkfs", "dd if="]
            for pat in destructive_patterns:
                if pat in input_str:
                    return True

        if category == "exfiltration":
            exfil_patterns = ["curl", "wget", "nc ", "netcat",
                              "base64", "|", ">"]
            matches = sum(1 for pat in exfil_patterns if pat in input_str)
            if matches >= 2:
                return True

        return False
