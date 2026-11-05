#!/bin/bash
# Stop all COSMO servers

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PIDS_FILE="$SCRIPT_DIR/.cosmo_pids"
CLUSTER_PIDS_FILE=".cosmo_cluster_pids"
CLUSTER_DASH_PIDS_FILE=".cosmo_cluster_dashboard_pids"
HIVE_PID_FILE=".cluster_dashboard_pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Stopping all COSMO servers..."
echo ""

if [ -f "$CLUSTER_PIDS_FILE" ]; then
    echo "Detected active hive cluster. Initiating shutdown..."
    ./stop-cluster.sh || true
fi

if [ -f "$CLUSTER_DASH_PIDS_FILE" ]; then
    echo "Stopping per-instance dashboards..."
    while read -r dash_pid; do
        if [ -n "$dash_pid" ] && ps -p "$dash_pid" > /dev/null 2>&1; then
            kill "$dash_pid" 2>/dev/null || kill -9 "$dash_pid" 2>/dev/null
        fi
    done < "$CLUSTER_DASH_PIDS_FILE"
    rm -f "$CLUSTER_DASH_PIDS_FILE"
fi

if [ -f "$HIVE_PID_FILE" ]; then
    hive_pid=$(cat "$HIVE_PID_FILE" 2>/dev/null)
    if [ -n "$hive_pid" ] && ps -p "$hive_pid" > /dev/null 2>&1; then
        echo "Stopping hive observatory (PID $hive_pid)..."
        kill "$hive_pid" 2>/dev/null || kill -9 "$hive_pid" 2>/dev/null
    fi
    rm -f "$HIVE_PID_FILE"
fi

if [ -f "$PIDS_FILE" ]; then
    while IFS=: read -r name pid port; do
        if [ -n "$pid" ] && ps -p "$pid" > /dev/null 2>&1; then
            echo "Stopping $name (PID: $pid, Port: $port)..."
            kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
            echo -e "${GREEN}✓ Stopped $name${NC}"
        fi
    done < "$PIDS_FILE"
    rm -f "$PIDS_FILE"
fi

# Fallback: ensure core processes are not lingering
pkill -f "node.*src/index.js" >/dev/null 2>&1 || true
pkill -f "node src/dashboard/server.js" >/dev/null 2>&1 || true

# Clear common ports if anything still bound
for port in 3343 3344 3345 3346 3347 3360; do
    pid=$(lsof -ti:$port 2>/dev/null)
    if [ -n "$pid" ]; then
        echo "Cleaning port $port (PID: $pid)"
        kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
    fi
done

echo ""
echo -e "${GREEN}All COSMO servers stopped${NC}"
