#!/bin/bash
# Executive Brief Test - Proper Config Strategy
# Uses backup/restore to maintain clean config state

set -e

echo "🧪 Executive Brief Test - Setup"
echo ""
echo "This test will:"
echo "  1. Backup your current config/state"
echo "  2. Copy test config to src/config.yaml"
echo "  3. Run COSMO with guided mode planner"
echo "  4. You can restore previous state after test"
echo ""

# Check prerequisites
if [ ! -f "mcp/filesystem-server.js" ]; then
    echo "❌ Error: filesystem-server.js not found"
    exit 1
fi

if [ ! -f "config_exec_brief_test.yaml" ]; then
    echo "❌ Error: config_exec_brief_test.yaml not found"
    exit 1
fi

# Check if filesystem MCP server is running
echo "🔍 Checking filesystem MCP server..."
if curl -s -f http://localhost:3337 > /dev/null 2>&1; then
    echo "✅ Filesystem MCP server is running on port 3337"
else
    echo ""
    echo "⚠️  Filesystem MCP server not detected on port 3337"
    echo ""
    echo "Please start it in a separate terminal:"
    echo "  ./START_FILESYSTEM_MCP.sh"
    echo ""
    echo "Or manually:"
    echo "  node mcp/filesystem-server.js 3337"
    echo ""
    read -p "Press Enter when filesystem server is running, or Ctrl+C to cancel..."
fi

echo ""
echo "📦 Step 1: Backing up current state..."
./CLEAN_RESTART.sh exec_brief_test_$(date +%Y%m%d_%H%M%S)

echo ""
echo "📝 Step 2: Installing test configuration..."
cp config_exec_brief_test.yaml src/config.yaml
echo "✅ Test config installed"

echo ""
echo "🚀 Step 3: Starting COSMO with guided mode planner..."
echo ""
echo "Watch for:"
echo "  - GUIDED MODE PLANNER - MISSION SETUP"
echo "  - Agent missions being queued"
echo "  - MCP tool calls in agent logs"
echo ""
echo "The test will run for ~10 cycles (~10-15 minutes)"
echo "Press Ctrl+C to stop early"
echo ""
echo "═══════════════════════════════════════"
echo ""

cd src
node --expose-gc index.js

echo ""
echo "✅ Test complete!"
echo ""
echo "To restore your previous configuration:"
echo "  ./RESTORE_BACKUP.sh"
echo "  (select the backup from today)"
