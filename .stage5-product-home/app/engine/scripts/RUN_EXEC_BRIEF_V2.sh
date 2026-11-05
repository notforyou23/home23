#!/bin/bash
# Executive Brief Test V2 - Coordinator-Driven Approach

echo "🧪 Executive Brief Test V2 (Coordinator-Driven)"
echo ""
echo "✅ How it works:"
echo "   - Cycle 1: Main loop runs (warm up)"
echo "   - Cycle 1 end: COORDINATOR REVIEW triggered"
echo "   - Coordinator reads guided domain/context"
echo "   - Coordinator spawns SPECIALIST AGENTS with MCP tools:"
echo "     • Research agents (can read files via MCP)"
echo "     • Analysis agents (can cross-reference)"
echo "     • Synthesis agents (can assemble brief)"
echo "     • QA agents (can validate citations)"
echo ""
echo "📝 Watch for:"
echo "   - 'Meta-Coordinator Review' starting at cycle 1"
echo "   - 'Spawning agent:' messages (research/analysis/synthesis)"
echo "   - 'MCP tool call:' or agent logs mentioning file reads"
echo "   - Agent results in runtime/agents/"
echo ""
echo "⏱️  This will take ~10-15 minutes (10 cycles)"
echo ""
echo "🚀 Starting COSMO..."
echo ""

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT/src"
node --expose-gc index.js

