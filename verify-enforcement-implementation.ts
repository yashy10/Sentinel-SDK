#!/usr/bin/env bun

/**
 * Verification script to check that enforcement selection is properly implemented
 * Run with: bun verify-enforcement-implementation.ts
 */

import { readFileSync } from "fs"
import { join } from "path"

const checks = [
  {
    name: "Permission system handles bastion_enforcement",
    file: "packages/opencode/src/permission/next.ts",
    pattern: /if \(request\.permission === "bastion_enforcement"\)/,
  },
  {
    name: "Prompt.ts calls bastion_enforcement permission",
    file: "packages/opencode/src/session/prompt.ts",
    pattern: /permission: "bastion_enforcement"/,
  },
  {
    name: "TUI permission component handles bastion_enforcement",
    file: "packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx",
    pattern: /props\.request\.permission === "bastion_enforcement"/,
  },
  {
    name: "Enforcement selection message function exists",
    file: "packages/opencode/src/bastion/enforcement.ts",
    pattern: /enforcementSelectionMessage/,
  },
  {
    name: "Enforcement action type is exported",
    file: "packages/opencode/src/bastion/index.ts",
    pattern: /EnforcementAction/,
  },
]

console.log("🔍 Verifying Enforcement Selection Implementation\n")

let allPassed = true

for (const check of checks) {
  try {
    const filePath = join(process.cwd(), check.file)
    const content = readFileSync(filePath, "utf-8")
    
    if (check.pattern.test(content)) {
      console.log(`✅ ${check.name}`)
    } else {
      console.log(`❌ ${check.name} - Pattern not found`)
      allPassed = false
    }
  } catch (error) {
    console.log(`❌ ${check.name} - File not found or error: ${error}`)
    allPassed = false
  }
}

console.log("\n" + "=".repeat(50))

if (allPassed) {
  console.log("✅ All checks passed! Implementation looks correct.")
  console.log("\n📝 Next steps:")
  console.log("   1. Run: bun dev")
  console.log("   2. In the TUI, try: Read ../../../../.ssh/id_rsa")
  console.log("   3. You should see the enforcement selection prompt")
  process.exit(0)
} else {
  console.log("❌ Some checks failed. Please review the implementation.")
  process.exit(1)
}
