"""
Sentinel-SDK: Reflexive Memory Module
Manages bastion_memory.json — the continual learning store.
Constraints persist across sessions and are injected into the system prompt.
"""

import json
import os
from datetime import datetime, timezone


class MemoryManager:
    def __init__(self, memory_path: str):
        self.memory_path = memory_path
        self._ensure_file()

    def _ensure_file(self):
        if not os.path.exists(self.memory_path):
            os.makedirs(os.path.dirname(self.memory_path), exist_ok=True)
            self._write({
                "version": "1.0",
                "constraints": [],
                "metadata": {
                    "total_constraints": 0,
                    "last_updated": datetime.now(timezone.utc).isoformat(),
                    "token_budget": 2000,
                    "max_constraints": 30
                }
            })

    def _read(self) -> dict:
        with open(self.memory_path) as f:
            return json.load(f)

    def _write(self, data: dict):
        with open(self.memory_path, 'w') as f:
            json.dump(data, f, indent=2)

    def add_constraint(self, constraint: dict):
        data = self._read()
        data["constraints"].append(constraint)
        data["metadata"]["total_constraints"] = len(data["constraints"])
        data["metadata"]["last_updated"] = datetime.now(timezone.utc).isoformat()

        max_c = data["metadata"].get("max_constraints", 30)
        if len(data["constraints"]) > max_c:
            data["constraints"].sort(
                key=lambda c: (c.get("confidence", 0), c.get("times_enforced", 0)),
                reverse=True
            )
            data["constraints"] = data["constraints"][:max_c]
            data["metadata"]["total_constraints"] = max_c

        self._write(data)

    def get_injection_text(self) -> str:
        data = self._read()
        constraints = data.get("constraints", [])

        if not constraints:
            return ""

        active = [c for c in constraints if c.get("confidence", 1.0) >= 0.5]

        if not active:
            return ""

        lines = ["\n--- LEARNED SECURITY CONSTRAINTS (from past experiences) ---"]
        for c in active:
            lines.append(f"• {c['injection_text']}")
        lines.append("--- END CONSTRAINTS ---\n")

        injection = "\n".join(lines)

        budget = data.get("metadata", {}).get("token_budget", 2000)
        if len(injection) / 4 > budget:
            truncated = injection[:budget * 4]
            truncated = truncated[:truncated.rfind("\n")]
            return truncated + "\n--- (truncated) ---"

        return injection

    def increment_enforcement(self, constraint_id: str):
        data = self._read()
        for c in data["constraints"]:
            if c["id"] == constraint_id:
                c["times_enforced"] = c.get("times_enforced", 0) + 1
                break
        self._write(data)

    def get_all_constraints(self) -> list:
        return self._read().get("constraints", [])

    def clear(self):
        self._write({
            "version": "1.0",
            "constraints": [],
            "metadata": {
                "total_constraints": 0,
                "last_updated": datetime.now(timezone.utc).isoformat(),
                "token_budget": 2000,
                "max_constraints": 30
            }
        })
