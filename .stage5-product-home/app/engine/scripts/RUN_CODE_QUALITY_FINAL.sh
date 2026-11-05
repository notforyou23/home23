#!/bin/bash
# COSMO Code Quality Analysis - FINAL CLEAN RUN
# Simple config, agents handle code reading, no planner discovery

set -e

echo "💻 COSMO Code Quality Analysis - FINAL RUN"
echo ""
echo "CLEAN approach:"
echo "  - Simple config: 'analyze code quality'"
echo "  - NO planner file discovery"
echo "  - Research agent handles code reading"
echo "  - Code agent analyzes from memory"
echo ""

# MCP check
if ! lsof -i :3337 > /dev/null 2>&1; then
    echo "Starting MCP server..."
    node mcp/filesystem-server.js 3337 > filesystem-mcp.log 2>&1 &
    sleep 2
fi

echo "📦 Backing up..."
./CLEAN_RESTART.sh code_quality_final_$(date +%Y%m%d_%H%M%S)

echo "📝 Installing CLEAN config..."
cp config_code_quality_clean.yaml src/config.yaml
echo "✅ Config installed"

echo ""
echo "🚀 Running with:"
echo "  - Domain: 'Production Code Quality Analysis'"
echo "  - Context: Simple 4-line instruction"
echo "  - Agents: Handle code reading themselves"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

