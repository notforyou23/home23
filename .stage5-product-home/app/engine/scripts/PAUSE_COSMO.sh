#!/bin/bash
# Pause COSMO Orchestrator (stop new cycles, keep dashboards running)
# Useful for querying research without consuming more API credits

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo "╔════════════════════════════════════════════════════════════╗"
echo "║              ⏸️  Pausing COSMO Orchestrator                ║"
echo "║         Dashboards will continue running                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Find COSMO orchestrator process
ORCHESTRATOR_PID=$(ps aux | grep "node.*index.js" | grep -v grep | awk '{print $2}')

if [ -z "$ORCHESTRATOR_PID" ]; then
    echo -e "${YELLOW}⚠️  COSMO orchestrator is not running${NC}"
    echo ""
    echo "Nothing to pause. Dashboard may still be running."
    exit 0
fi

echo -e "${BLUE}Found COSMO orchestrator (PID: $ORCHESTRATOR_PID)${NC}"
echo ""

# Check dashboard status before stopping
DASHBOARD_RUNNING=false
if lsof -Pi :3344 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    DASHBOARD_RUNNING=true
    echo -e "${GREEN}✓ Dashboard is running on port 3344${NC}"
else
    echo -e "${YELLOW}⚠️  Dashboard is not running${NC}"
fi
echo ""

# Stop orchestrator only
echo -e "${BLUE}Stopping orchestrator (keeping dashboards alive)...${NC}"
kill $ORCHESTRATOR_PID 2>/dev/null

# Wait for it to stop
sleep 2

if ps -p $ORCHESTRATOR_PID > /dev/null 2>&1; then
    echo -e "${YELLOW}Orchestrator didn't stop cleanly, forcing...${NC}"
    kill -9 $ORCHESTRATOR_PID 2>/dev/null
    sleep 1
fi

echo -e "${GREEN}✓ COSMO orchestrator stopped${NC}"
echo ""

# Verify dashboard still running
if $DASHBOARD_RUNNING; then
    if lsof -Pi :3344 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
        echo -e "${GREEN}✓ Dashboard still running${NC}"
    else
        echo -e "${YELLOW}⚠️  Dashboard stopped too (may have been part of same process)${NC}"
        echo ""
        echo "To restart dashboard only:"
        echo "  ./scripts/START_DASHBOARD_ONLY.sh"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ COSMO Paused${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Current Status:"
echo "  • Research cycles: PAUSED (no new API calls)"
echo "  • Dashboard: RUNNING (you can query existing data)"
echo "  • ./ask CLI: WORKS (queries existing data)"
echo "  • Web query: WORKS (http://localhost:3344/query)"
echo ""
echo "🌐 Access:"
echo "  • Main Dashboard:     http://localhost:3344/"
echo "  • Query Interface:    http://localhost:3344/query"
echo "  • Insights:           http://localhost:3344/insights"
echo ""
echo "▶️  To resume research:"
echo "  cd src && node --expose-gc index.js"
echo "  OR: ./scripts/LAUNCH_COSMO.sh (full restart)"
echo ""
echo "🛑 To stop everything:"
echo "  ./scripts/STOP_ALL.sh"
echo ""



