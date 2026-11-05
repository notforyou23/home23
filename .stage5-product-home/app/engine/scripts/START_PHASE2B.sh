#!/bin/bash
# Start Phase 2B Adaptive AI System (Full Implementation)

echo "╔══════════════════════════════════════════════════╗"
echo "║   Starting Phase 2B Adaptive AI System         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

cd "$(dirname "$0")"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Run Phase 2B
echo "Launching Phase 2B (Full Feature Set)..."
echo ""
node phase2/index-system.js

