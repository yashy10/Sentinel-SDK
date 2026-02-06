#!/bin/bash
# Tail OpenCode logs in real-time
# Usage: ./scripts/tail-logs.sh [filter]

LOG_DIR="$HOME/.local/share/opencode/log"
LOG_FILE="$LOG_DIR/dev.log"

# Fallback to most recent log file if dev.log doesn't exist
if [ ! -f "$LOG_FILE" ]; then
  LOG_FILE=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
fi

if [ ! -f "$LOG_FILE" ]; then
  echo "No log files found in $LOG_DIR"
  echo "Make sure OpenCode is running first."
  exit 1
fi

echo "Tailing log file: $LOG_FILE"
echo "Press Ctrl+C to stop"
echo "---"

if [ -n "$1" ]; then
  # Filter logs if a filter is provided
  tail -f "$LOG_FILE" | grep -i --line-buffered "$1"
else
  # Show all logs
  tail -f "$LOG_FILE"
fi
