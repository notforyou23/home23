#!/usr/bin/env bash
# COSMO Hive Mind - Graceful Cluster Shutdown
# Stops all instances with proper leader handoff and state cleanup

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   COSMO Hive Mind - Cluster Shutdown             ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""

if [ ! -f .cosmo_cluster_pids ]; then
  echo -e "${RED}❌ No cluster PIDs found${NC}"
  exit 1
fi

# Detect backend
CONFIG="src/config.yaml"
BACKEND="unknown"

if [ -f "$CONFIG" ]; then
  if grep -A 10 "cluster:" "$CONFIG" | grep -q "backend: redis"; then
    BACKEND="redis"
  elif grep -A 10 "cluster:" "$CONFIG" | grep -q "backend: filesystem"; then
    BACKEND="filesystem"
  fi
fi

echo -e "${YELLOW}Backend: $BACKEND${NC}"
echo ""

# Find current leader
echo -e "${YELLOW}🔍 Identifying leader instance...${NC}"

LEADER_PID=""
LEADER_INSTANCE=""
INSTANCE_NUM=0

declare -a FOLLOWER_PIDS
declare -a ALL_PIDS

while read pid; do
  ((INSTANCE_NUM++))
  INSTANCE_ID="cosmo-$INSTANCE_NUM"
  LOG_FILE="logs/cluster-$INSTANCE_ID.log"
  
  if ps -p $pid > /dev/null 2>&1; then
    ALL_PIDS+=("$pid")
    
    if [ -f "$LOG_FILE" ] && tail -100 "$LOG_FILE" | grep -q "isLeader.*true\|Leadership acquired\|Became leader"; then
      LEADER_PID="$pid"
      LEADER_INSTANCE="$INSTANCE_ID"
      echo -e "${GREEN}   Leader: $INSTANCE_ID (PID $pid)${NC}"
    else
      FOLLOWER_PIDS+=("$pid")
    fi
  fi
done < .cosmo_cluster_pids

echo ""

# Graceful shutdown strategy: Stop followers first, then leader last
echo -e "${YELLOW}🛑 Stopping cluster gracefully...${NC}"
echo ""

# Step 1: Stop followers first (graceful SIGTERM)
if [ ${#FOLLOWER_PIDS[@]} -gt 0 ]; then
  echo -e "${CYAN}Step 1: Stopping follower instances...${NC}"
  
  for pid in "${FOLLOWER_PIDS[@]}"; do
    if ps -p $pid > /dev/null 2>&1; then
      echo -e "  Sending SIGTERM to PID $pid..."
      kill -TERM $pid 2>/dev/null || true
    fi
  done
  
  # Wait for followers to shutdown
  echo -e "  Waiting for followers to shutdown (max 10s)..."
  for i in {1..10}; do
    ALL_STOPPED=true
    for pid in "${FOLLOWER_PIDS[@]}"; do
      if ps -p $pid > /dev/null 2>&1; then
        ALL_STOPPED=false
        break
      fi
    done
    
    if [ "$ALL_STOPPED" = true ]; then
      echo -e "${GREEN}  ✅ All followers stopped${NC}"
      break
    fi
    sleep 1
  done
  
  # Force kill any remaining followers
  for pid in "${FOLLOWER_PIDS[@]}"; do
    if ps -p $pid > /dev/null 2>&1; then
      echo -e "${YELLOW}  Force stopping PID $pid...${NC}"
      kill -9 $pid 2>/dev/null || true
    fi
  done
  echo ""
fi

# Step 2: Stop leader last
if [ -n "$LEADER_PID" ] && ps -p $LEADER_PID > /dev/null 2>&1; then
  echo -e "${CYAN}Step 2: Stopping leader instance ($LEADER_INSTANCE)...${NC}"
  echo -e "  Sending SIGTERM to PID $LEADER_PID..."
  kill -TERM $LEADER_PID 2>/dev/null || true
  
  # Wait for leader to shutdown (longer timeout)
  echo -e "  Waiting for leader to save state and shutdown (max 15s)..."
  for i in {1..15}; do
    if ! ps -p $LEADER_PID > /dev/null 2>&1; then
      echo -e "${GREEN}  ✅ Leader stopped${NC}"
      break
    fi
    sleep 1
  done
  
  # Force kill leader if still running
  if ps -p $LEADER_PID > /dev/null 2>&1; then
    echo -e "${YELLOW}  Force stopping leader PID $LEADER_PID...${NC}"
    kill -9 $LEADER_PID 2>/dev/null || true
  fi
  echo ""
fi

# Step 3: Force kill any remaining processes
echo -e "${CYAN}Step 3: Verifying all instances stopped...${NC}"

REMAINING=0
for pid in "${ALL_PIDS[@]}"; do
  if ps -p $pid > /dev/null 2>&1; then
    echo -e "${YELLOW}  Force stopping remaining PID $pid...${NC}"
    kill -9 $pid 2>/dev/null || true
    ((REMAINING++))
  fi
done

if [ $REMAINING -eq 0 ]; then
  echo -e "${GREEN}  ✅ All instances stopped${NC}"
else
  echo -e "${YELLOW}  Force stopped $REMAINING instance(s)${NC}"
fi
echo ""

# Step 4: Backend-specific cleanup
echo -e "${CYAN}Step 4: Cleaning up backend state...${NC}"

if [ "$BACKEND" = "redis" ]; then
  echo -e "  Backend: Redis"
  
  # Check if redis-cli is available
  if command -v redis-cli > /dev/null; then
    REDIS_HOST="localhost"
    REDIS_PORT="6379"
    
    # Optional: Clean up cluster keys (commented out for safety)
    # Uncomment if you want to clear Redis state on shutdown
    # echo -e "  Clearing cluster keys..."
    # redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --scan --pattern "cosmo:cluster:*" | xargs redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" del 2>/dev/null || true
    
    echo -e "${GREEN}  ✅ Redis cleanup complete${NC}"
    echo -e "  ${CYAN}Note: Redis keys preserved for restart${NC}"
  else
    echo -e "${YELLOW}  redis-cli not found, skipping Redis cleanup${NC}"
  fi
  
elif [ "$BACKEND" = "filesystem" ]; then
  echo -e "  Backend: Filesystem"
  
  # Get filesystem root from config
  FS_ROOT="/tmp/cosmo_cluster"
  if [ -f "$CONFIG" ]; then
    FS_ROOT_LINE=$(grep -A 20 "cluster:" "$CONFIG" | grep "root:" | head -1 || echo "")
    if [ -n "$FS_ROOT_LINE" ]; then
      FS_ROOT=$(echo "$FS_ROOT_LINE" | sed 's/.*root: *"\(.*\)".*/\1/')
    fi
  fi
  
  # Remove leader lock
  if [ -f "$FS_ROOT/control/LEADER" ]; then
    echo -e "  Removing leader lock..."
    rm -f "$FS_ROOT/control/LEADER"
  fi
  
  # Clean up health beacons
  if [ -d "$FS_ROOT/health" ]; then
    echo -e "  Cleaning health beacons..."
    rm -f "$FS_ROOT/health/"*.json 2>/dev/null || true
  fi
  
  # Clean up old barriers (optional, keeps recent ones for debugging)
  if [ -d "$FS_ROOT/barriers" ]; then
    echo -e "  Cleaning old cycle barriers..."
    find "$FS_ROOT/barriers" -type d -name "cycle_*" -mmin +60 -exec rm -rf {} \; 2>/dev/null || true
  fi
  
  echo -e "${GREEN}  ✅ Filesystem cleanup complete${NC}"
  echo -e "  ${CYAN}Note: State files preserved in $FS_ROOT${NC}"
fi

echo ""

# Step 5: Stop individual instance dashboard servers
echo -e "${CYAN}Step 5: Stopping Instance Dashboards...${NC}"

if [ -f .cosmo_cluster_dashboard_pids ]; then
  while read dashboard_pid; do
    if ps -p $dashboard_pid > /dev/null 2>&1; then
      echo -e "  Stopping dashboard PID $dashboard_pid..."
      kill -TERM $dashboard_pid 2>/dev/null || true
    fi
  done < .cosmo_cluster_dashboard_pids
  
  sleep 1
  
  # Force kill remaining
  while read dashboard_pid; do
    if ps -p $dashboard_pid > /dev/null 2>&1; then
      kill -9 $dashboard_pid 2>/dev/null || true
    fi
  done < .cosmo_cluster_dashboard_pids
  
  rm -f .cosmo_cluster_dashboard_pids
  echo -e "${GREEN}  ✅ Instance dashboards stopped${NC}"
else
  echo -e "  ${CYAN}No instance dashboards found${NC}"
fi
echo ""

# Step 6: Stop unified cluster dashboard
echo -e "${CYAN}Step 6: Stopping Unified Cluster Dashboard...${NC}"

if [ -f .cluster_dashboard_pid ]; then
  DASHBOARD_PID=$(cat .cluster_dashboard_pid)
  if ps -p $DASHBOARD_PID > /dev/null 2>&1; then
    echo -e "  Stopping Cluster Dashboard (PID $DASHBOARD_PID)..."
    kill -TERM $DASHBOARD_PID 2>/dev/null || true
    sleep 1
    
    if ps -p $DASHBOARD_PID > /dev/null 2>&1; then
      kill -9 $DASHBOARD_PID 2>/dev/null || true
    fi
  fi
  rm -f .cluster_dashboard_pid
  echo -e "${GREEN}  ✅ Unified dashboard stopped${NC}"
else
  echo -e "  ${CYAN}No unified dashboard running${NC}"
fi
echo ""

# Step 7: Clean up PID files
echo -e "${CYAN}Step 7: Removing PID files...${NC}"
rm -f .cosmo_cluster_pids .cosmo_cluster_dashboard_pids
echo -e "${GREEN}  ✅ PID files removed${NC}"
echo ""

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cluster Stopped                                ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo -e "  ${GREEN}All instances shutdown complete${NC}"
echo ""
echo -e "${CYAN}Next Steps:${NC}"
echo -e "  • Restart cluster:  ./scripts/launch-cluster.sh"
echo -e "  • View logs:        ls -lh logs/cluster-cosmo-*.log"
echo ""
