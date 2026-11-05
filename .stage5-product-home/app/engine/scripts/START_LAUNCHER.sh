#!/bin/bash
# Start COSMO Launcher Dashboard
# Web-based launcher with port offset support
#
# Usage:
#   ./scripts/START_LAUNCHER.sh
#   COSMO_PORT_OFFSET=100 ./scripts/START_LAUNCHER.sh

cd "$(dirname "$0")/.."

# Calculate launcher port with optional offset
PORT_OFFSET=${COSMO_PORT_OFFSET:-0}
LAUNCHER_PORT=$((3340 + PORT_OFFSET))

clear
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           🚀 STARTING COSMO LAUNCHER DASHBOARD               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [ "$PORT_OFFSET" -ne 0 ]; then
    echo "🔧 Port offset enabled: +$PORT_OFFSET"
    echo "   Launcher port: $LAUNCHER_PORT (default: 3340)"
    echo ""
fi

# Check if launcher is already running
if lsof -ti TCP:$LAUNCHER_PORT > /dev/null 2>&1; then
    echo "⚠️  Launcher already running on port $LAUNCHER_PORT"
    echo ""
    read -p "Kill and restart? (y/n) [y]: " restart
    restart=${restart:-y}
    
    if [[ "$restart" =~ ^[Yy]$ ]]; then
        echo "Stopping existing launcher..."
        lsof -ti TCP:$LAUNCHER_PORT | xargs kill -TERM 2>/dev/null
        sleep 2
    else
        echo ""
        echo "🌐 Launcher is running at: http://localhost:$LAUNCHER_PORT"
        exit 0
    fi
fi

echo "Starting launcher server..."
echo ""

# Start launcher with port offset passed through env vars
LAUNCHER_PORT=$LAUNCHER_PORT COSMO_PORT_OFFSET=$PORT_OFFSET node src/launcher/server.js &
LAUNCHER_PID=$!

# Wait for server to start
sleep 2

# Open browser
echo "Opening browser..."
if command -v open > /dev/null 2>&1; then
    # macOS
    open http://localhost:$LAUNCHER_PORT
elif command -v xdg-open > /dev/null 2>&1; then
    # Linux
    xdg-open http://localhost:$LAUNCHER_PORT
elif command -v start > /dev/null 2>&1; then
    # Windows
    start http://localhost:$LAUNCHER_PORT
else
    echo "🌐 Open manually: http://localhost:$LAUNCHER_PORT"
fi

echo ""
echo "✅ Launcher dashboard opened in browser"
echo "   URL: http://localhost:$LAUNCHER_PORT"
echo "   Close this terminal to stop the launcher"
echo ""

# Wait for launcher process
wait $LAUNCHER_PID

# Note: When launcher exits (Ctrl+C), it will clean up any COSMO processes it started

