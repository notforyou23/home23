#!/bin/bash
# Executive Brief Test - Simple Runner

echo "🧪 Executive Brief Test"
echo ""
echo "✅ Config updated with:"
echo "   - Domain: Executive decision brief from COSMO's internal research"
echo "   - 5 specialized roles: evidence_auditor, analyst, critic, synthesizer, qa_guardian"
echo "   - Max 5 cycles"
echo "   - Strict QA mode"
echo "   - MCP filesystem server on port 3337"
echo ""
echo "📝 Watch for:"
echo "   - Agents using MCP tools to read files"
echo "   - Citations like [file:line]"
echo "   - Cross-referencing cycles 50, 100, 250"
echo ""
echo "🚀 Starting COSMO..."
echo ""

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT/src"
node --expose-gc index.js

