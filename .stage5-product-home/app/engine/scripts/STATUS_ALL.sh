#!/bin/bash
# Check status of all COSMO servers

SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR"

PIDS_FILE="$SCRIPT_DIR/.cosmo_pids"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "╔════════════════════════════════════════════════════════════╗"
echo "║              COSMO System Status                           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check by ports (more reliable)
declare -A services=(
    [3344]="Main Dashboard"
    [3347]="MCP HTTP Server"
    [3346]="MCP Dashboard"
    [3337]="Filesystem MCP Server"
)

echo "Service Status:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

all_running=true

for port in 3344 3347 3346 3337; do
    service="${services[$port]}"
    pid=$(lsof -ti:$port 2>/dev/null)
    
    if [ -n "$pid" ]; then
        echo -e "${GREEN}✓${NC} $service (Port $port, PID $pid)"
    else
        echo -e "${RED}✗${NC} $service (Port $port) - NOT RUNNING"
        all_running=false
    fi
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if $all_running; then
    echo -e "${GREEN}✓ All services running${NC}"
    echo ""
    echo "Access URLs:"
    echo "  • Main Dashboard:      http://localhost:3344"
    echo "  • MCP HTTP Server:     http://localhost:3347/mcp"
    echo "  • MCP Dashboard:       http://localhost:3346"
    echo "  • Filesystem MCP:      http://localhost:3337"
else
    echo -e "${YELLOW}⚠ Some services not running${NC}"
    echo ""
    echo "To start all services: ./START_ALL.sh"
fi

echo ""

# Show log locations
if [ -d "logs" ]; then
    echo "Recent logs (last 5 lines):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    for log in logs/*.log; do
        if [ -f "$log" ]; then
            echo ""
            echo "$(basename $log):"
            tail -n 5 "$log" 2>/dev/null | sed 's/^/  /'
        fi
    done
fi

