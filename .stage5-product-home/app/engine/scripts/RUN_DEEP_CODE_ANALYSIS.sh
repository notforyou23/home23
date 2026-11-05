#!/bin/bash
# COSMO Deep Code Quality Analysis
# Analyzes actual implementation code, not just file counts
# Ultra-careful: Production code only, no legacy, explicit file lists

set -e

echo "💻 COSMO Deep Code Quality Analysis"
echo ""
echo "This is LEVEL 2 self-assessment - analyzing actual code implementation:"
echo "  📖 READ: 20 production files (~12,000 lines of code)"
echo "  🔍 ANALYZE: Quality metrics, architecture patterns, technical debt"
echo "  📊 SCORE: Error handling, documentation, complexity, maintainability"
echo "  🎯 RECOMMEND: Specific files + line numbers + actions"
echo ""
echo "What COSMO will analyze:"
echo "  ✓ 7 agent implementations (analysis, base, code-execution, etc.)"
echo "  ✓ 3 agent infrastructure files (executor, mcp-bridge, results-queue)"
echo "  ✓ 4 core orchestration files (orchestrator-gpt5, clients, planner)"
echo "  ✓ 4 key subsystems (memory, coordinator, goals, cognition)"
echo "  ✓ 2 MCP servers"
echo ""
echo "What COSMO will NOT analyze:"
echo "  ✗ _old/* (legacy code)"
echo "  ✗ cosmo_backup_*/ (49 backup directories)"
echo "  ✗ test files, .OLD files, node_modules"
echo ""
echo "Expected output:"
echo "  - Code quality scores (0-10 scale)"
echo "  - Error handling coverage %"
echo "  - Documentation coverage %"
echo "  - Technical debt density (markers per 1000 lines)"
echo "  - Specific refactoring recommendations (file + line + action)"
echo "  - Production readiness assessment"
echo ""
echo "Duration: ~40-50 minutes (15 cycles)"
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
./CLEAN_RESTART.sh deep_code_analysis_$(date +%Y%m%d_%H%M%S)

echo ""
echo "📝 Installing deep code analysis configuration..."
cp config_deep_code_analysis.yaml src/config.yaml
echo "✅ Configuration installed"

echo ""
echo "🎯 Watch for these milestones:"
echo "  📖 'Detected code reading mission'"
echo "  📋 'Using X explicitly-listed files from mission'"
echo "  ✓ 'Analyzed: base-agent.js (654 lines...)' (20 files)"
echo "  💻 'Starting deep source code quality analysis'"
echo "  📊 'quality_scores: error_handling_coverage: X%'"
echo "  🎯 'recommendations: priority: high, file: ...'"
echo ""
echo "Success means:"
echo "  ✅ 20 production files read and analyzed"
echo "  ✅ Quality scores calculated (error handling, docs, complexity)"
echo "  ✅ Specific recommendations with file names + line numbers"
echo "  ✅ NO legacy or backup files analyzed"
echo "  ✅ Production readiness assessment generated"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

echo ""
echo "🎉 Deep code analysis complete!"
echo ""
echo "Check results:"
echo "  Code quality report: Look for 'code_quality_analysis' in findings"
echo "  Quality scores: Error handling %, documentation %, overall score"
echo "  Recommendations: Specific files + priorities + actions"
echo "  Coordinator review: runtime/coordinator/review_5.md"
echo "  Insights: runtime/coordinator/insights_curated_cycle_15.md"
echo ""
echo "This report shows:"
echo "  - Actual code quality metrics (not just file counts)"
echo "  - Architecture consistency assessment"
echo "  - Technical debt quantified and prioritized"
echo "  - Specific refactoring recommendations"
echo ""
echo "To restore:"
echo "  ./RESTORE_BACKUP.sh"


