#!/bin/bash
# COSMO Ultimate Test: Self-Improvement Analysis
# Uses all agent types, all tools, produces improvement roadmap

set -e

echo "🚀 COSMO Ultimate Test: Self-Improvement Analysis"
echo ""
echo "This test will demonstrate COSMO's full capabilities:"
echo "  📁 Phase 1: Read 3 curator files via MCP (31KB)"
echo "  🧪 Phase 2: Run statistical analysis in Python"
echo "  🌐 Phase 3: Benchmark against industry standards"
echo "  🔬 Phase 4: Deep multi-framework analysis"
echo "  📊 Phase 5: Synthesize improvement roadmap"
echo "  ✅ Phase 6: QA validate all citations and stats"
echo ""
echo "Expected output:"
echo "  - Statistical report (correlation, trends, outliers)"
echo "  - Industry comparison (COSMO vs OpenAI/DeepMind/Anthropic)"
echo "  - 5 prioritized improvements with timelines"
echo "  - 15-page roadmap (100% citations)"
echo ""
echo "Duration: ~25 minutes (8 cycles)"
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
./CLEAN_RESTART.sh ultimate_test_$(date +%Y%m%d_%H%M%S)

echo ""
echo "📝 Installing ultimate test configuration..."
cp config_ultimate_test.yaml src/config.yaml
echo "✅ Configuration installed"

echo ""
echo "🎯 Key Success Indicators to Watch:"
echo "  📁 'Read 3 files via MCP' (planner startup)"
echo "  🧪 'Running statistical analysis' (code execution)"
echo "  📊 'Correlation: r=X.XX, p<0.XX' (statistical results)"
echo "  🌐 'Found X industry sources' (benchmarking)"
echo "  📋 '5 recommendations generated' (roadmap)"
echo "  ✅ 'QA confidence: 0.XX' (final validation)"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

echo ""
echo "🎉 Ultimate test complete!"
echo ""
echo "Check results:"
echo "  Improvement Roadmap: Look for 'IMPROVEMENT ROADMAP' in synthesis findings"
echo "  Statistical Report: Look for 'STATISTICAL ANALYSIS' in code execution results"
echo "  Coordinator Review: runtime/coordinator/review_5.md"
echo "  Curator Insights: runtime/coordinator/insights_curated_cycle_8.md"
echo ""
echo "To restore:"
echo "  ./RESTORE_BACKUP.sh"

