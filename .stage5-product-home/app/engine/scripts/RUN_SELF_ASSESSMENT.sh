#!/bin/bash
# COSMO Complete Self-Assessment Test
# The ultimate meta-cognitive test: COSMO analyzing itself

set -e

echo "🔍 COSMO Complete Self-Assessment"
echo ""
echo "This test demonstrates COSMO's ultimate capability:"
echo "  Meta-Cognition - AI Understanding AI"
echo ""
echo "What COSMO will do:"
echo "  1. 📂 DISCOVER: Scan directories, find all .md files (~25 files)"
echo "  2. 📖 READ: Read all documentation (~200KB total)"
echo "  3. 🧪 ANALYZE: Python code analysis of structure"
echo "  4. 🌐 BENCHMARK: Compare to Oct 2025 industry (LangChain/AutoGen/OpenAI)"
echo "  5. 🔬 GAP ANALYSIS: Multi-framework competitive assessment"
echo "  6. 📊 REPORT: 20-30 page self-assessment + roadmap"
echo ""
echo "Expected output:"
echo "  - What COSMO is (from reading own docs)"
echo "  - What COSMO can do (from code analysis)"
echo "  - How COSMO compares (vs Oct 2025 industry)"
echo "  - What to build next (prioritized gaps)"
echo ""
echo "Duration: ~35-40 minutes (12 cycles)"
echo ""

# Check MCP server
echo "🔍 Checking MCP filesystem server..."
if lsof -i :3337 > /dev/null 2>&1; then
    echo "✅ MCP server running on port 3337"
else
    echo "⚠️  Starting MCP server..."
    node mcp/filesystem-server.js 3337 > filesystem-mcp.log 2>&1 &
    sleep 2
    if lsof -i :3337 > /dev/null 2>&1; then
        echo "✅ MCP server started"
    else
        echo "❌ Failed to start MCP server"
        exit 1
    fi
fi

echo ""
echo "📦 Backing up current state..."
./CLEAN_RESTART.sh self_assessment_$(date +%Y%m%d_%H%M%S)

echo ""
echo "📝 Installing self-assessment configuration..."
cp config_self_assessment.yaml src/config.yaml
echo "✅ Configuration installed"

echo ""
echo "🎯 Watch for these milestones:"
echo "  📂 'Discovered X .md files' (should be 20-30)"
echo "  📖 'Read X files via MCP' (should be 20-30)"
echo "  🧪 'Code inventory: X agent types' (Python analysis)"
echo "  🌐 'Industry sources: X' (benchmarking)"
echo "  📊 'Gap analysis: X priorities'"
echo "  📋 'Self-assessment report: X pages'"
echo ""
echo "Success means:"
echo "  ✅ All major .md files discovered and read"
echo "  ✅ Code analysis completes (agent count, features, structure)"
echo "  ✅ Industry benchmark with Oct 2025 sources"
echo "  ✅ 20+ page comprehensive report"
echo "  ✅ Actionable roadmap with priorities"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

echo ""
echo "🎉 Self-assessment complete!"
echo ""
echo "Check results:"
echo "  Main report: Look for 'SELF-ASSESSMENT' or 'COMPETITIVE ANALYSIS' in synthesis"
echo "  Code inventory: Look for code execution results with capability counts"
echo "  Coordinator review: runtime/coordinator/review_5.md"
echo "  Insights: runtime/coordinator/insights_curated_cycle_12.md"
echo ""
echo "This report shows:"
echo "  - What COSMO is (from own docs)"
echo "  - What COSMO has (from code)"
echo "  - How COSMO compares (vs Oct 2025 industry)"
echo "  - What to build next (roadmap)"
echo ""
echo "To restore:"
echo "  ./RESTORE_BACKUP.sh"

