#!/bin/bash
# COSMO Comprehensive Stress Test Runner
# Tests all agent types, all tools, full coordination

set -e

echo "🔥 COSMO Comprehensive Stress Test"
echo ""
echo "This stress test will:"
echo "  1. Read 3 curator files via MCP"
echo "  2. Extract and analyze 60+ insights"
echo "  3. Fact-check claims via web search"
echo "  4. Run statistical validation code"
echo "  5. Perform deep multi-framework analysis"
echo "  6. Synthesize comprehensive validation report"
echo "  7. QA validate all citations"
echo ""
echo "Duration: ~15-20 minutes (8 cycles)"
echo ""

# Check if MCP filesystem server is running on 3337
echo "🔍 Checking MCP filesystem server..."
if lsof -i :3337 > /dev/null 2>&1; then
    echo "✅ MCP filesystem server running on port 3337"
else
    echo ""
    echo "⚠️  MCP filesystem server not detected on port 3337"
    echo ""
    echo "Starting it now..."
    node mcp/filesystem-server.js 3337 > filesystem-mcp.log 2>&1 &
    sleep 2
    if lsof -i :3337 > /dev/null 2>&1; then
        echo "✅ MCP server started"
    else
        echo "❌ Failed to start MCP server"
        echo "Please start manually:"
        echo "  node mcp/filesystem-server.js 3337"
        exit 1
    fi
fi

echo ""
echo "📦 Step 1: Backing up current state..."
./CLEAN_RESTART.sh stress_test_$(date +%Y%m%d_%H%M%S)

echo ""
echo "📝 Step 2: Installing stress test configuration..."
cp config_stress_test.yaml src/config.yaml
echo "✅ Stress test config installed"

echo ""
echo "🚀 Step 3: Starting COSMO stress test..."
echo ""
echo "Watch for:"
echo "  ✅ Planner reading 3 curator files via MCP"
echo "  ✅ 6 agent types spawning"
echo "  ✅ Code execution agent running statistical tests"
echo "  ✅ Synthesis assembling validation report"
echo "  ✅ QA validating citations"
echo ""
echo "Success indicators:"
echo "  📁 'Read file via MCP' messages"
echo "  🧪 'Code execution' and Python output"
echo "  📊 'Statistical findings' in reports"
echo "  ✅ '100% citation coverage' from QA"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

echo ""
echo "✅ Stress test complete!"
echo ""
echo "Check results:"
echo "  Coordinator review: runtime/coordinator/review_5.md"
echo "  Agent outputs: runtime/agent-results.json"
echo "  Synthesis reports: Look for 'SYNTHESIS REPORT' in findings"
echo ""
echo "To restore previous state:"
echo "  ./RESTORE_BACKUP.sh"

