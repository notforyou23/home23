#!/bin/bash
# Start Phase 2B with Real-Time Dashboard

echo "╔══════════════════════════════════════════════════╗"
echo "║   Phase 2B + Dashboard Starting...              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

cd "$(dirname "$0")"

# Check dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Start dashboard server
echo "Starting dashboard server..."
node phase2/dashboard/server.js &
DASHBOARD_PID=$!
sleep 2

# Start Phase 2B
echo "Starting Phase 2B system..."
node phase2/index-system.js &
SYSTEM_PID=$!

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Phase 2B System Running                       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  🧠 Phase 2B:  PID $SYSTEM_PID"
echo "  📊 Dashboard: http://localhost:3334"
echo ""
echo "To stop:"
echo "  pkill -f 'node phase2'"
echo ""
echo "Press Ctrl+C to stop both..."

# Wait for interrupt
trap "kill $DASHBOARD_PID $SYSTEM_PID 2>/dev/null; exit" INT TERM

wait

