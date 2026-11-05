#!/bin/bash
# Restore original config (undo executive brief test changes)

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "🔄 Restoring original config.yaml..."

git checkout src/config.yaml

echo "✅ Original config restored"
echo ""
echo "Note: This keeps the MCP filesystem server entry."
echo "To remove that too, edit src/config.yaml and delete lines 392-398"

