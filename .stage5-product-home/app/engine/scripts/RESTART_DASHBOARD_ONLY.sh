#!/bin/bash

# Restart Dashboard Server Only
# Kills existing dashboard and starts a new one

PORT=3334

echo "🔄 Restarting Dashboard Server..."

# Kill existing dashboard server
echo "Stopping existing dashboard server on port $PORT..."
lsof -ti:$PORT | xargs kill -9 2>/dev/null || true

# Wait a moment
sleep 1

# Start dashboard
echo "Starting dashboard server..."
cd "$(dirname "$0")"
node phase2/dashboard/server.js > phase2-dashboard.log 2>&1 &

# Wait for server to start
sleep 2

# Check if it's running
if lsof -ti:$PORT > /dev/null; then
    echo "✅ Dashboard server running at http://localhost:$PORT"
    echo "📋 Logs: tail -f phase2-dashboard.log"
else
    echo "❌ Failed to start dashboard server"
    echo "Check logs: cat phase2-dashboard.log"
    exit 1
fi

