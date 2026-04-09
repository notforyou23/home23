#!/bin/bash
# Start COSMO Dashboard Without Running the Core Orchestrator
# Useful for querying existing research without running more cycles

set -e

cd "$(dirname "$0")/.."

COSMO_ROOT="$(pwd)"

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         🧠 COSMO Research Lab - Dashboard Only            ║"
echo "║      Explore existing research without running cycles     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check if runtime data exists
if [ ! -f "runtime/state.json.gz" ]; then
    echo -e "${YELLOW}⚠️  No runtime data found!${NC}"
    echo ""
    echo "The dashboard needs existing COSMO research data to query."
    echo "Please run COSMO at least once first:"
    echo ""
    echo "  ./scripts/LAUNCH_COSMO.sh"
    echo ""
    echo "Then you can use this script to start just the dashboard."
    exit 1
fi

echo -e "${GREEN}✓ Runtime data found${NC}"
echo ""

# Check for required ports
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 ; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Kill any existing dashboard processes
echo -e "${BLUE}Cleaning up old dashboard processes...${NC}"
pkill -f "node src/dashboard/server.js" 2>/dev/null || true
pkill -f "node src/dashboard/cluster-server.js" 2>/dev/null || true
pkill -f "node mcp/dashboard-server.js" 2>/dev/null || true
pkill -f "node mcp/http-server.js 3347" 2>/dev/null || true
rm -f .cosmo_cluster_dashboard_pids .cluster_dashboard_pid
sleep 2
echo ""

# Ensure logs directory exists
mkdir -p logs

# Start MCP HTTP Server (needed for filesystem operations)
echo -e "${BLUE}Starting MCP HTTP Server (port 3347)...${NC}"
nohup node mcp/http-server.js 3347 > logs/mcp-http.log 2>&1 &
sleep 2

if check_port 3347; then
    echo -e "${GREEN}✓ MCP HTTP Server running on port 3347${NC}"
else
    echo -e "${YELLOW}⚠️  MCP HTTP Server may not be running (optional)${NC}"
fi
echo ""

# Start MCP Dashboard (optional)
echo -e "${BLUE}Starting MCP Dashboard (port 3346)...${NC}"
nohup node mcp/dashboard-server.js > logs/mcp-dashboard.log 2>&1 &
sleep 2

if check_port 3346; then
    echo -e "${GREEN}✓ MCP Dashboard running on port 3346${NC}"
else
    echo -e "${YELLOW}⚠️  MCP Dashboard may not be running (optional)${NC}"
fi
echo ""

# Determine if current run used hive cluster
cluster_enabled=false
cluster_size=1
cluster_backend="filesystem"
fs_root="/tmp/cosmo_cluster"

if [ -f "runtime/run-metadata.json" ]; then
    cluster_info=$(python3 - <<'PY'
import json
from pathlib import Path
meta_path = Path('runtime/run-metadata.json')
data = json.loads(meta_path.read_text()) if meta_path.exists() else {}
enabled = bool(data.get('clusterEnabled'))
size = data.get('clusterSize') or 1
backend = data.get('clusterBackend') or 'filesystem'
print("{}|{}|{}".format('1' if enabled else '0', size, backend))
PY
    )
    IFS='|' read -r cluster_enabled cluster_size cluster_backend <<< "$cluster_info"
    cluster_enabled=$(echo "$cluster_enabled" | tr -d '\r' | xargs)
    cluster_size=$(echo "$cluster_size" | tr -d '\r' | xargs)
    cluster_backend=$(echo "$cluster_backend" | tr -d '\r' | xargs)

    if [ "$cluster_backend" = "filesystem" ] && [ -f "src/config.yaml" ]; then
        root_line=$(grep -A 10 "cluster:" src/config.yaml | grep "root:" | head -1)
        if [ -n "$root_line" ]; then
            fs_root=$(echo "$root_line" | sed 's/.*root: *"\(.*\)".*/\1/')
        fi
    fi
fi

# Start dashboards depending on cluster mode
if [ "$cluster_enabled" != "1" ]; then
    echo -e "${BLUE}Starting Dashboard (port 3344)...${NC}"
    nohup node src/dashboard/server.js > logs/dashboard.log 2>&1 &
    sleep 3

    if check_port 3344; then
        echo -e "${GREEN}✓ Dashboard running on port 3344${NC}"
    else
        echo -e "${RED}✗ Failed to start Dashboard${NC}"
        echo "Check logs: tail -f logs/dashboard.log"
        exit 1
    fi
else
    : > logs/dashboard.log
fi

# If hive mode, start per-instance dashboards and the observatory
if [ "$cluster_enabled" = "1" ]; then
    echo ""
    echo -e "${BLUE}Hive run detected — starting per-instance dashboards...${NC}"
    BASE_DASHBOARD_PORT=3343
    rm -f .cosmo_cluster_dashboard_pids
    for i in $(seq 1 "$cluster_size"); do
        PORT=$((BASE_DASHBOARD_PORT + i - 1))
        LOG_FILE="logs/cluster-cosmo-${i}-dashboard.log"
        COSMO_DASHBOARD_PORT="$PORT" \
        node src/dashboard/server.js > "$LOG_FILE" 2>&1 &
        echo $! >> .cosmo_cluster_dashboard_pids
        sleep 1
        if check_port "$PORT"; then
            echo -e "    ${GREEN}• cosmo-$i dashboard ready on port $PORT${NC}"
        else
            echo -e "    ${YELLOW}• cosmo-$i dashboard failed to start (check $LOG_FILE)${NC}"
        fi
    done

    echo -e "${BLUE}Starting Hive Mind Observatory (port 3360)...${NC}"
    CLUSTER_DASHBOARD_PORT=3360 \
    INSTANCE_COUNT="$cluster_size" \
    BASE_DASHBOARD_PORT=3343 \
    CLUSTER_BACKEND="$cluster_backend" \
    CLUSTER_FS_ROOT="$fs_root" \
    node src/dashboard/cluster-server.js > logs/cluster-dashboard.log 2>&1 &
    echo $! > .cluster_dashboard_pid
    sleep 2
    if check_port 3360; then
        echo -e "${GREEN}✓ Hive observatory running on port 3360${NC}"
    else
        echo -e "${YELLOW}⚠️  Hive observatory failed to start (check logs/cluster-dashboard.log)${NC}"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Dashboard Running - COSMO Core Paused${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐 Browser opened to: http://localhost:3344 (Research Lab)"
echo ""
echo "📊 Available Views:"
if [ "$cluster_enabled" = "1" ]; then
    echo "  • Instance dash (cosmo-1): http://localhost:3343"
    echo "  • Instance dash (cosmo-2): http://localhost:3344"
    if [ "$cluster_size" -gt 2 ]; then
        echo "  • Instance dash (cosmo-3): http://localhost:3345"
    fi
    echo "  • Hive Observatory:   http://localhost:3360"
else
    echo "  • Research Lab (Home):     http://localhost:3344/"
    echo "  • Intelligence Dashboard:  http://localhost:3344/intelligence"
    echo "  • Query Interface:         http://localhost:3344/query"
    echo "  • Insights Explorer:       http://localhost:3344/insights"
    echo "  • Dreams Explorer:         http://localhost:3344/dreams"
    echo "  • Legacy Observatory:      http://localhost:3344/legacy"
    echo ""
    echo "  • MCP Flow Dashboard:      http://localhost:3346/"
    echo "  • MCP Classic View:        http://localhost:3346/classic"
fi
echo ""
echo "📋 Logs:"
if [ "$cluster_enabled" != "1" ]; then
    echo "  • Dashboard:          tail -f logs/dashboard.log"
fi
echo "  • MCP Dashboard:      tail -f logs/mcp-dashboard.log"
echo "  • MCP HTTP:           tail -f logs/mcp-http.log"
if [ "$cluster_enabled" = "1" ]; then
    echo "  • Hive Observatory:   tail -f logs/cluster-dashboard.log"
fi
echo ""
echo "💡 Notes:"
echo "  • COSMO orchestrator is NOT running (no new cycles)"
echo "  • Dashboard is reading EXISTING research data"
echo "  • Use ./ask or web query to explore what COSMO learned"
echo "  • To resume research: ./scripts/LAUNCH_COSMO.sh"
echo ""
echo "🛑 To stop dashboard:"
echo "  ./scripts/STOP_DASHBOARD_ONLY.sh"
echo ""
