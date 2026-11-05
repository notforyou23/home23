#!/bin/bash
# Start Phase 2 Adaptive AI System (Legacy - Use START_ALL.sh for full orchestration)

echo "╔══════════════════════════════════════════════════╗"
echo "║   Starting Phase 2 Adaptive AI System          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "⚠️  Note: This starts ONLY the core orchestrator."
echo "   For full system (with MCP servers), use: ./START_ALL.sh"
echo ""

cd "$(dirname "$0")"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Run Phase 2
echo "Launching Phase 2 Core..."
echo ""
node --expose-gc src/index.js

