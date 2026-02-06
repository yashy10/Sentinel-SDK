#!/bin/bash

# Demo script for testing Enforcement Selection feature
# This script provides step-by-step instructions

echo "🚀 OpenCode Enforcement Selection Demo"
echo "======================================"
echo ""
echo "This demo will guide you through testing the enforcement selection feature."
echo ""
echo "STEP 1: Start the OpenCode TUI"
echo "-------------------------------"
echo "Run this command in your terminal:"
echo ""
echo "  cd /Users/yashy/Desktop/opencode"
echo "  bun dev"
echo ""
echo "Wait for the TUI to start..."
echo ""
read -p "Press Enter when the TUI is running..."

echo ""
echo "STEP 2: Trigger a Blocked Action"
echo "---------------------------------"
echo "In the OpenCode TUI, type one of these prompts:"
echo ""
echo "  Option A (SSH Key - Recommended):"
echo "    Read ../../../../.ssh/id_rsa"
echo ""
echo "  Option B (Environment File):"
echo "    Read .env"
echo ""
echo "  Option C (AWS Credentials):"
echo "    Read ~/.aws/credentials"
echo ""
read -p "Press Enter after you've typed the prompt..."

echo ""
echo "STEP 3: Verify Enforcement Selection Prompt"
echo "--------------------------------------------"
echo "You should now see:"
echo ""
echo "  📋 Title: '🚫 Security Action Blocked - Select Enforcement'"
echo ""
echo "  📝 Details showing:"
echo "     - Tool name"
echo "     - Action details"
echo "     - Rule ID (e.g., R001)"
echo "     - Reason for blocking"
echo ""
echo "  🔘 Four options:"
echo "     1. KILL ⭐ (Recommended)"
echo "     2. USER_INPUT"
echo "     3. LLM_EXAMINE"
echo "     4. INVOKE_ACTION"
echo ""
read -p "Do you see the enforcement selection prompt? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "✅ Great! The prompt is working."
else
    echo "❌ The prompt didn't appear. Check:"
    echo "   - Are you in the OpenCode TUI (bun dev)?"
    echo "   - Did you trigger a blocked action?"
    echo "   - Check the terminal for any errors"
    exit 1
fi

echo ""
echo "STEP 4: Select an Enforcement Action"
echo "------------------------------------"
echo "Try selecting different options:"
echo ""
echo "  Press '1' - Select KILL (hard block)"
echo "  Press '2' - Select USER_INPUT (human approval)"
echo "  Press '3' - Select LLM_EXAMINE (learn constraint)"
echo "  Press '4' - Select INVOKE_ACTION (sanitize)"
echo ""
read -p "Which option did you select? (1/2/3/4) " -n 1 -r
echo ""

case $REPLY in
    1)
        echo "✅ You selected KILL - The action should be blocked with an error."
        ;;
    2)
        echo "✅ You selected USER_INPUT - You should see another approval prompt."
        ;;
    3)
        echo "✅ You selected LLM_EXAMINE - The system will learn a constraint."
        ;;
    4)
        echo "✅ You selected INVOKE_ACTION - The command will be sanitized."
        ;;
    *)
        echo "⚠️  Unknown option selected."
        ;;
esac

echo ""
echo "STEP 5: Verify Audit Logging"
echo "-----------------------------"
echo "Check the audit log to see your selection was recorded:"
echo ""
echo "  cat ~/.config/opencode/bastion_audit.json | tail -5"
echo ""
read -p "Press Enter to continue..."

echo ""
echo "✅ Demo Complete!"
echo ""
echo "Summary:"
echo "  - Enforcement selection prompt appears when actions are blocked"
echo "  - Four options are available with recommended option marked"
echo "  - Your selection determines how the blocked action is handled"
echo "  - All selections are logged in the audit trail"
echo ""
echo "For more details, see: TEST_ENFORCEMENT_SELECTION.md"
