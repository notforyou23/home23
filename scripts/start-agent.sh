#!/bin/bash
# Compatibility wrapper for older npm scripts.
# Usage: bash scripts/start-agent.sh test-agent

set -euo pipefail

AGENT_NAME="${1:?Usage: start-agent.sh <agent-name>}"
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

exec node "$HOME23_ROOT/cli/home23.js" start "$AGENT_NAME"
