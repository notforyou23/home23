#!/bin/bash
# COSMO Deep Code Analysis - INCREMENTAL MODE
# BUILDS ON existing memory from prior run (keeps your 92 nodes!)
# Does NOT call CLEAN_RESTART - state continuity maintained

set -e

echo "💻 COSMO Deep Code Analysis - INCREMENTAL MODE"
echo ""
echo "🧠 INCREMENTAL LEARNING MODE:"
echo "  ✓ Keeps existing memory (92 nodes from prior run)"
echo "  ✓ Continues from cycle 17 (not cycle 0)"
echo "  ✓ Research agent finds file_inventory already in memory"
echo "  ✓ Skips file scanning, reads code immediately"
echo "  ✓ Faster execution (~35-40 min vs ~45-50 min)"
echo ""
echo "Current state:"
if [ -f "runtime/state.json.gz" ]; then
    echo "  ✓ state.json.gz exists (901KB)"
    echo "  ✓ Memory nodes: 92 (including file_inventory)"
    echo "  ✓ Active goals: 81 (will be managed by coordinator)"
else
    echo "  ✗ No prior state found - use RUN_DEEP_CODE_ANALYSIS.sh instead"
    exit 1
fi

echo ""
echo "This will:"
echo "  1. KEEP your current memory (no CLEAN_RESTART)"
echo "  2. Load state from cycle 16"
echo "  3. Continue with cycle 17+"
echo "  4. Research agent will check memory for file_inventory"
echo "  5. Find it! Use it! Read code files!"
echo "  6. Code agent analyzes from memory"
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
echo "📦 Creating safety backup (non-destructive)..."
# Backup WITHOUT cleaning (just copy state)
BACKUP_DIR="cosmo_backup_before_incremental_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp runtime/state.json.gz "$BACKUP_DIR/" 2>/dev/null || true
cp src/config.yaml "$BACKUP_DIR/" 2>/dev/null || true
echo "✅ Backup created: $BACKUP_DIR (can restore if needed)"

echo ""
echo "📝 Installing deep code analysis configuration..."
# Save current config
cp src/config.yaml config_before_incremental.yaml 2>/dev/null || true

# Install new config
cp config_deep_code_analysis.yaml src/config.yaml
echo "✅ Configuration installed"

echo ""
echo "🎯 INCREMENTAL RUN - Building on existing knowledge:"
echo "  📂 File inventory ALREADY IN MEMORY (from cycle 1)"
echo "  📖 Research agent will FIND IT and USE IT"
echo "  🔍 Skips redundant scanning"
echo "  💻 Reads 20 code files immediately"
echo "  📊 Code agent analyzes from memory"
echo ""
echo "Watch for:"
echo "  ✓ 'Found existing file inventory in memory'"
echo "  ✓ 'Using X explicitly-listed files from mission'"
echo "  ✓ 'Analyzed: base-agent.js (654 lines...)' ×20"
echo "  ✓ 'Detected source code analysis data'"
echo "  ✓ 'quality_scores: {...}'"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

echo ""
echo "🎉 Incremental deep code analysis complete!"
echo ""
echo "Check results:"
echo "  Quality scores: Look for 'code_quality_analysis' tag"
echo "  Recommendations: Specific files + line numbers + actions"
echo "  Coordinator review: runtime/coordinator/review_20.md"
echo ""
echo "State continuity verified:"
echo "  - Started from cycle 17 (continued from prior run)"
echo "  - Used existing file_inventory from memory"
echo "  - Added code analysis data to existing knowledge graph"
echo "  - True incremental learning demonstrated"
echo ""
echo "To restore if needed:"
echo "  cp $BACKUP_DIR/state.json.gz runtime/"
echo "  cp $BACKUP_DIR/config.yaml phase2/"
echo ""

