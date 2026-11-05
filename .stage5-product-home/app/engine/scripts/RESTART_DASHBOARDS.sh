#!/bin/bash
# Restart Phase 2B Dashboards

echo "🔄 Restarting Phase 2B Dashboards..."
echo ""

# Kill any existing dashboard servers
pkill -f "phase2/dashboard/server.js" 2>/dev/null
pkill -f "self-agent/dashboard-server.js" 2>/dev/null
sleep 1

# Start Phase 2B dashboard (GPT-5.2 version)
cd "$(dirname "$0")"
nohup node phase2/dashboard/server.js > phase2-dashboard.log 2>&1 &
DASH_PID=$!

sleep 2

# Check if it started
if lsof -ti:3334 > /dev/null 2>&1; then
  echo "✅ Dashboard server started successfully!"
  echo ""
  echo "📊 Phase 2B Dashboard: http://localhost:3334"
  echo "   (Showing runtime/ data)"
  echo ""
  echo "Logs: phase2-dashboard.log"
  echo ""
  
  # Open in browser (macOS)
  open http://localhost:3334
else
  echo "❌ Dashboard failed to start"
  echo "Check phase2-dashboard.log for errors"
fi
