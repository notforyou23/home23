#!/bin/bash
# Stop Dashboard Servers Only (keep COSMO core running if it is)
# Stops: Main Dashboard (3344), MCP Dashboard (3346), MCP HTTP (3347), Cluster Dashboards

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         🛑 Stopping COSMO Dashboard Services              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Kill dashboard processes
echo "Stopping services..."
echo ""

pkill -f "node src/dashboard/server.js" 2>/dev/null && echo -e "${GREEN}  ✓ Main Dashboard (port 3344)${NC}" || echo -e "${YELLOW}  • Main Dashboard not running${NC}"
pkill -f "node src/dashboard/cluster-server.js" 2>/dev/null && echo -e "${GREEN}  ✓ Hive Observatory (port 3360)${NC}" || echo -e "${YELLOW}  • Hive Observatory not running${NC}"
pkill -f "node mcp/dashboard-server.js" 2>/dev/null && echo -e "${GREEN}  ✓ MCP Dashboard (port 3346)${NC}" || echo -e "${YELLOW}  • MCP Dashboard not running${NC}"
pkill -f "node mcp/http-server.js 3347" 2>/dev/null && echo -e "${GREEN}  ✓ MCP HTTP Server (port 3347)${NC}" || echo -e "${YELLOW}  • MCP HTTP not running${NC}"

# Clean up PID files
rm -f .cosmo_cluster_dashboard_pids .cluster_dashboard_pid

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Dashboard Services Stopped${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Notes:"
echo "  • COSMO orchestrator (if running) is still active"
echo "  • To stop everything: ./scripts/STOP_ALL.sh"
echo "  • To restart dashboards: ./scripts/START_DASHBOARD_ONLY.sh"
echo ""


