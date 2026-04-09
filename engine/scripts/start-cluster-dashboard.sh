#!/usr/bin/env bash
# Start COSMO Cluster Dashboard
# Unified monitoring for multi-instance hive mind

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

CLUSTER_PORT=${1:-3350}
INSTANCE_COUNT=${2:-3}
BASE_PORT=${3:-3343}

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   COSMO Cluster Dashboard                        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Configuration:${NC}"
echo -e "  Dashboard Port:    $CLUSTER_PORT"
echo -e "  Monitoring:        $INSTANCE_COUNT instances"
echo -e "  Instance Ports:    $BASE_PORT - $((BASE_PORT + INSTANCE_COUNT - 1))"
echo ""

# Check if already running
if lsof -Pi :$CLUSTER_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo -e "${GREEN}✓ Cluster Dashboard already running on port $CLUSTER_PORT${NC}"
  echo -e ""
  echo -e "${CYAN}Access at: http://localhost:$CLUSTER_PORT${NC}"
  exit 0
fi

# Start the dashboard
echo -e "${CYAN}Starting Cluster Dashboard...${NC}"

CLUSTER_DASHBOARD_PORT=$CLUSTER_PORT \
INSTANCE_COUNT=$INSTANCE_COUNT \
BASE_DASHBOARD_PORT=$BASE_PORT \
node src/dashboard/cluster-server.js > logs/cluster-dashboard.log 2>&1 &

PID=$!
echo $PID > .cluster_dashboard_pid

# Wait a moment for it to start
sleep 2

# Verify it started
if ps -p $PID > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Cluster Dashboard started (PID $PID)${NC}"
  echo -e ""
  echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║   Dashboard Running                              ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
  echo -e ""
  echo -e "  ${CYAN}🌐 Cluster View:  http://localhost:$CLUSTER_PORT${NC}"
  echo -e ""
  echo -e "${CYAN}Commands:${NC}"
  echo -e "  Stop:      kill $PID"
  echo -e "  View log:  tail -f logs/cluster-dashboard.log"
  echo ""
else
  echo -e "${RED}✗ Failed to start Cluster Dashboard${NC}"
  echo -e "  Check logs/cluster-dashboard.log for errors"
  exit 1
fi

