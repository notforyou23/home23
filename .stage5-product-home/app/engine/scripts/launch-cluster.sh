#!/usr/bin/env bash
# COSMO Hive Mind - Production Cluster Launcher
# Launches N instances with proper port assignment, environment setup, and health verification

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CONFIG=${1:-"src/config.yaml"}
INSTANCES=${2:-3}
BASE_DASHBOARD_PORT=${3:-3343}
BASE_MCP_PORT=${4:-3344}
STARTUP_WAIT=${5:-5}  # Seconds to wait between instance starts

# Validate arguments
if [ $INSTANCES -lt 1 ] || [ $INSTANCES -gt 15 ]; then
  echo -e "${RED}❌ Instance count must be between 1 and 15${NC}"
  exit 1
fi

# Validate config file
if [ ! -f "$CONFIG" ]; then
  echo -e "${RED}❌ Config file not found: $CONFIG${NC}"
  exit 1
fi

# Check if clustering is enabled in config
if ! grep -q "enabled: true" "$CONFIG" | grep -A 5 "cluster:" > /dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  Warning: cluster.enabled may not be set to true in $CONFIG${NC}"
  echo -e "${YELLOW}   Continuing anyway...${NC}"
fi

# Detect cluster backend
BACKEND="unknown"
if grep -A 10 "cluster:" "$CONFIG" | grep -q "backend: redis"; then
  BACKEND="redis"
elif grep -A 10 "cluster:" "$CONFIG" | grep -q "backend: filesystem"; then
  BACKEND="filesystem"
fi

# Get Redis URL if using Redis backend
REDIS_URL="redis://localhost:6379"
if [ "$BACKEND" = "redis" ]; then
  REDIS_URL_LINE=$(grep -A 20 "cluster:" "$CONFIG" | grep "url:" | head -1 || echo "")
  if [ -n "$REDIS_URL_LINE" ]; then
    REDIS_URL=$(echo "$REDIS_URL_LINE" | sed 's/.*url: *"\(.*\)".*/\1/')
  fi
fi

# Get filesystem root if using filesystem backend
FS_ROOT="/tmp/cosmo_cluster"
if [ "$BACKEND" = "filesystem" ]; then
  FS_ROOT_LINE=$(grep -A 20 "cluster:" "$CONFIG" | grep "root:" | head -1 || echo "")
  if [ -n "$FS_ROOT_LINE" ]; then
    FS_ROOT=$(echo "$FS_ROOT_LINE" | sed 's/.*root: *"\(.*\)".*/\1/')
  fi
fi

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   COSMO Hive Mind - Cluster Launcher            ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo -e "  Config File:      $CONFIG"
echo -e "  Instances:        $INSTANCES"
echo -e "  Backend:          $BACKEND"
if [ "$BACKEND" = "redis" ]; then
  echo -e "  Redis URL:        ${REDIS_URL/\/\/.*@/\/\/<credentials>@}"  # Hide credentials
elif [ "$BACKEND" = "filesystem" ]; then
  echo -e "  Filesystem Root:  $FS_ROOT"
fi
echo -e "  Dashboard Ports:  $BASE_DASHBOARD_PORT - $((BASE_DASHBOARD_PORT + INSTANCES - 1))"
echo -e "  MCP Ports:        $BASE_MCP_PORT - $((BASE_MCP_PORT + INSTANCES - 1))"
echo ""

# Verify backend connectivity
echo -e "${YELLOW}🔍 Verifying backend connectivity...${NC}"

if [ "$BACKEND" = "redis" ]; then
  # Test Redis connection
  if command -v redis-cli > /dev/null; then
    # Parse Redis URL
    REDIS_HOST=$(echo "$REDIS_URL" | sed 's#.*://##' | sed 's/:.*//')
    REDIS_PORT=$(echo "$REDIS_URL" | sed 's#.*:##' | sed 's#/.*##')
    
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; then
      echo -e "${GREEN}✅ Redis is reachable at $REDIS_HOST:$REDIS_PORT${NC}"
    else
      echo -e "${RED}❌ Cannot connect to Redis at $REDIS_HOST:$REDIS_PORT${NC}"
      echo -e "${YELLOW}   Make sure Redis is running and accessible${NC}"
      exit 1
    fi
  else
    echo -e "${YELLOW}⚠️  redis-cli not found, skipping connectivity test${NC}"
  fi
elif [ "$BACKEND" = "filesystem" ]; then
  # Test filesystem access
  if mkdir -p "$FS_ROOT" 2>/dev/null; then
    if [ -w "$FS_ROOT" ]; then
      echo -e "${GREEN}✅ Filesystem root is writable at $FS_ROOT${NC}"
    else
      echo -e "${RED}❌ Filesystem root is not writable: $FS_ROOT${NC}"
      exit 1
    fi
  else
    echo -e "${RED}❌ Cannot create filesystem root: $FS_ROOT${NC}"
    exit 1
  fi
fi

# Clean up old PID file
rm -f .cosmo_cluster_pids

echo ""
echo -e "${YELLOW}🚀 Launching instances...${NC}"

# Launch instances
for i in $(seq 1 $INSTANCES); do
  INSTANCE_ID="cosmo-$i"
  DASHBOARD_PORT=$((BASE_DASHBOARD_PORT + i - 1))
  MCP_PORT=$((BASE_MCP_PORT + i - 1))
  LOG_FILE="logs/cluster-$INSTANCE_ID.log"
  
  echo -e "${BLUE}   Starting $INSTANCE_ID${NC}"
  echo -e "     Dashboard: http://localhost:$DASHBOARD_PORT"
  echo -e "     MCP:       http://localhost:$MCP_PORT"
  echo -e "     Log:       $LOG_FILE"
  
  # Create logs directory if needed
  mkdir -p logs
  
  # Start dashboard server for this instance
  DASHBOARD_LOG="logs/cluster-$INSTANCE_ID-dashboard.log"
  COSMO_DASHBOARD_PORT="$DASHBOARD_PORT" \
  node src/dashboard/server.js > "$DASHBOARD_LOG" 2>&1 &
  DASHBOARD_PID=$!
  
  # Give dashboard a moment to start
  sleep 1
  
  # Launch instance in background
  INSTANCE_ID="$INSTANCE_ID" \
  DASHBOARD_PORT="$DASHBOARD_PORT" \
  MCP_PORT="$MCP_PORT" \
  node --expose-gc src/index.js --config "$CONFIG" > "$LOG_FILE" 2>&1 &
  
  PID=$!
  echo "$PID" >> .cosmo_cluster_pids
  echo "$DASHBOARD_PID" >> .cosmo_cluster_dashboard_pids
  
  echo -e "     ${GREEN}Instance PID: $PID${NC}"
  echo -e "     ${GREEN}Dashboard PID: $DASHBOARD_PID${NC}"
  
  # Wait a bit between instances to stagger startup
  if [ $i -lt $INSTANCES ]; then
    sleep $STARTUP_WAIT
  fi
done

echo ""
echo -e "${YELLOW}⏳ Waiting for instances to initialize...${NC}"
sleep 10

# Health check
echo ""
echo -e "${YELLOW}🏥 Checking instance health...${NC}"
echo ""

HEALTHY=0
UNHEALTHY=0

while read pid; do
  if ps -p $pid > /dev/null 2>&1; then
    INSTANCE_NUM=$((HEALTHY + UNHEALTHY + 1))
    INSTANCE_ID="cosmo-$INSTANCE_NUM"
    echo -e "${GREEN}✅ $INSTANCE_ID (PID $pid): RUNNING${NC}"
    ((HEALTHY++))
  else
    INSTANCE_NUM=$((HEALTHY + UNHEALTHY + 1))
    INSTANCE_ID="cosmo-$INSTANCE_NUM"
    echo -e "${RED}❌ $INSTANCE_ID (PID $pid): CRASHED${NC}"
    ((UNHEALTHY++))
  fi
done < .cosmo_cluster_pids

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cluster Status                                 ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo -e "  Backend:     $BACKEND"
echo -e "  Running:     ${GREEN}$HEALTHY${NC}"
echo -e "  Crashed:     ${RED}$UNHEALTHY${NC}"
echo -e "  Total:       $INSTANCES"
echo ""

if [ $UNHEALTHY -gt 0 ]; then
  echo -e "${RED}⚠️  Some instances failed to start. Check logs:${NC}"
  echo -e "  tail -f logs/cluster-cosmo-*.log"
  echo ""
  exit 1
fi

echo -e "${GREEN}✅ Cluster launched successfully!${NC}"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo -e "  • Monitor health:   ./scripts/cluster-health-check.sh"
echo -e "  • View dashboards:  http://localhost:${BASE_DASHBOARD_PORT} - $((BASE_DASHBOARD_PORT + INSTANCES - 1))"
echo -e "  • Stop cluster:     ./scripts/stop-cluster.sh"
echo -e "  • View logs:        tail -f logs/cluster-cosmo-*.log"
echo ""

# Display cluster topology
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cluster Topology                               ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"

for i in $(seq 1 $INSTANCES); do
  INSTANCE_ID="cosmo-$i"
  DASHBOARD_PORT=$((BASE_DASHBOARD_PORT + i - 1))
  MCP_PORT=$((BASE_MCP_PORT + i - 1))
  
  PID=$(sed -n "${i}p" .cosmo_cluster_pids)
  
  echo -e "${GREEN}$INSTANCE_ID${NC} (PID $PID)"
  echo -e "  Dashboard: http://localhost:$DASHBOARD_PORT"
  echo -e "  MCP:       http://localhost:$MCP_PORT"
  echo ""
done

echo -e "${BLUE}PIDs saved to: .cosmo_cluster_pids${NC}"
echo ""

# Launch cluster dashboard
echo -e "${YELLOW}🌐 Launching Cluster Dashboard...${NC}"
CLUSTER_DASHBOARD_PORT=3350 \
INSTANCE_COUNT=$INSTANCES \
BASE_DASHBOARD_PORT=$BASE_DASHBOARD_PORT \
node src/dashboard/cluster-server.js > logs/cluster-dashboard.log 2>&1 &

DASHBOARD_PID=$!
echo $DASHBOARD_PID > .cluster_dashboard_pid

# Wait for dashboard to start
sleep 2

if ps -p $DASHBOARD_PID > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Cluster Dashboard started on port 3350${NC}"
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║   🌐 UNIFIED CLUSTER DASHBOARD                  ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
  echo -e ""
  echo -e "  ${CYAN}Open: http://localhost:3350${NC}"
  echo -e ""
  echo -e "  This dashboard shows:"
  echo -e "    • All instances in one view"
  echo -e "    • Leader/follower status"
  echo -e "    • Aggregate cluster metrics"
  echo -e "    • Real-time health monitoring"
  echo ""
else
  echo -e "${YELLOW}⚠️  Cluster Dashboard failed to start${NC}"
  echo -e "   You can still access individual dashboards"
fi
