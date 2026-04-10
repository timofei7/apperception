#!/bin/bash
# Apperception nightly dream — reconsolidate memories
# Runs via launchd (macOS) or cron/systemd (Linux) at ~2am daily
#
# Configure via environment variables:
#   SOUL_REPO_PATH  — path to your data repo (required)

set -euo pipefail

REPO_DIR="${SOUL_REPO_PATH:?Set SOUL_REPO_PATH to your data repo path}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$REPO_DIR/.soul/dream-prompt.md"
LOG_DIR="$REPO_DIR/.soul/logs"
LOG_FILE="$LOG_DIR/dream-$(date +%Y-%m-%d).log"

if [ ! -f "$PROMPT_FILE" ]; then
  PROMPT_FILE="$SCRIPT_DIR/../templates/.soul/dream-prompt.md"
fi

mkdir -p "$LOG_DIR"

# Local MCP server only (--strict-mcp-config ignores global config)
DREAM_MCP="$LOG_DIR/.dream-mcp.json"
cat > "$DREAM_MCP" <<MCPEOF
{
  "mcpServers": {
    "apperception": {
      "command": "node",
      "args": ["$SCRIPT_DIR/dist/index.js", "$REPO_DIR"]
    }
  }
}
MCPEOF

# Permission-scoped settings:
#   dontAsk mode silently denies any tool not in the allow list.
#   Only the local apperception MCP tools and file access within the
#   data repo are permitted. Everything else is blocked — no Bash,
#   no WebFetch, no other MCP servers, no files outside the repo.
DREAM_SETTINGS="$LOG_DIR/.dream-settings.json"
cat > "$DREAM_SETTINGS" <<SETTINGSEOF
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": [
      "mcp__apperception__*",
      "Read(//$REPO_DIR/**)",
      "Edit(//$REPO_DIR/**)",
      "Write(//$REPO_DIR/**)"
    ]
  }
}
SETTINGSEOF

echo "=== Dream started at $(date) ===" >> "$LOG_FILE"

claude \
  --print \
  --mcp-config "$DREAM_MCP" \
  --strict-mcp-config \
  --settings "$DREAM_SETTINGS" \
  < "$PROMPT_FILE" \
  >> "$LOG_FILE" 2>&1

echo "=== Dream finished at $(date) ===" >> "$LOG_FILE"
