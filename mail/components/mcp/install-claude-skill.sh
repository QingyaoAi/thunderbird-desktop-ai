#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.
#
# Installs the "thunderbird-mail" Claude Code skill: the SKILL.md that
# teaches an agent how to use the mailbox tools well, plus the MCP bridge
# that speaks to Thunderbird's local endpoint (MailMcpServer.sys.mjs).
#
# This assumes Thunderbird itself already has "Mail Access for AI" built
# in — it does not build or patch Thunderbird. Get that from a build that
# includes comm/mail/components/mcp/ first.
#
# Usage:
#   ./install-claude-skill.sh [token]
#   curl -fsSL <raw-url>/install-claude-skill.sh | bash -s -- [token]
#
# With no token, the script installs the skill and prints the command to
# register the MCP server yourself once you have created a password in
# Thunderbird (Tools -> Mail Access for AI...).

set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/QingyaoAi/thunderbird-desktop-ai/main/mail/components/mcp"
SKILL_DIR="${CLAUDE_SKILL_DIR:-$HOME/.claude/skills/thunderbird-mail}"
TOKEN="${1:-${MAIL_MCP_TOKEN:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

log() { printf '%s\n' "$*" >&2; }

fetch() {
  # $1 = filename, $2 = destination
  local name="$1" dest="$2"
  if [ -f "$SCRIPT_DIR/$name" ]; then
    cp "$SCRIPT_DIR/$name" "$dest"
  else
    curl -fsSL "$RAW_BASE/$name" -o "$dest"
  fi
}

command -v node >/dev/null 2>&1 || {
  log "error: node is required to run the MCP bridge (https://nodejs.org)."
  exit 1
}
command -v claude >/dev/null 2>&1 || {
  log "error: the 'claude' CLI was not found on PATH."
  exit 1
}

mkdir -p "$SKILL_DIR"
fetch "SKILL.md" "$SKILL_DIR/SKILL.md"
fetch "mail-mcp-bridge.js" "$SKILL_DIR/mail-mcp-bridge.js"
chmod +x "$SKILL_DIR/mail-mcp-bridge.js"

log "Installed the skill and bridge to $SKILL_DIR"

if [ -z "$TOKEN" ]; then
  cat >&2 <<EOF

No token given, so the MCP server was not registered.

1. In Thunderbird: Tools -> Mail Access for AI... -> turn access on ->
   Create a password.
2. Register the server:

     claude mcp add thunderbird -s user \\
       -e MAIL_MCP_TOKEN=<the password> \\
       -- node "$SKILL_DIR/mail-mcp-bridge.js"

   (Or re-run this script with the password as the first argument.)
EOF
  exit 0
fi

claude mcp remove thunderbird -s user >/dev/null 2>&1 || true
claude mcp add thunderbird -s user \
  -e MAIL_MCP_TOKEN="$TOKEN" \
  -- node "$SKILL_DIR/mail-mcp-bridge.js"

log "Registered the 'thunderbird' MCP server (scope: user)."
log "Verify with: claude mcp list"
log "Thunderbird must be running with mail access on for it to answer."
