#!/bin/bash

# Run Self-Propelled AI Agent with Visual Dashboard
# This starts both the thinking agent and the web dashboard

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Self-Propelled AI - Starting System          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Starting components:"
echo "  1. AI Agent (autonomous thinking loop)"
echo "  2. Visual Dashboard (mind visualization)"
echo ""

# Start dashboard server in background
echo "🌐 Starting dashboard server..."
node self-agent/dashboard-server.js > dashboard.log 2>&1 &
DASHBOARD_PID=$!
echo "   Dashboard PID: $DASHBOARD_PID"
sleep 2

# Open browser (macOS)
echo "🚀 Opening dashboard in browser..."
open http://localhost:3333

echo ""
echo "✅ Dashboard ready at: http://localhost:3333"
echo ""
echo "Now starting AI agent..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Start agent (runs in foreground so you can see logs)
node self-agent/index.js

# Cleanup when agent stops
echo ""
echo "Stopping dashboard server..."
kill $DASHBOARD_PID 2>/dev/null
echo "✅ Shutdown complete"

