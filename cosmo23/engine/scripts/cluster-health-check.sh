#!/usr/bin/env bash
# COSMO Hive Mind - Cluster Health Check
# Checks running instances, leader status, and cluster coordination

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   COSMO Hive Mind - Cluster Health Check        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Check if cluster is running
if [ ! -f .cosmo_cluster_pids ]; then
  echo -e "${RED}❌ No cluster PIDs found${NC}"
  echo -e "${YELLOW}   Start cluster with: ./scripts/launch-cluster.sh${NC}"
  exit 1
fi

# Count PIDs
TOTAL_PIDS=$(wc -l < .cosmo_cluster_pids | tr -d ' ')

echo -e "${CYAN}📊 Process Status${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"

RUNNING=0
STOPPED=0
INSTANCE_NUM=0

declare -a RUNNING_INSTANCES
declare -a RUNNING_PIDS

while read pid; do
  ((INSTANCE_NUM++))
  INSTANCE_ID="cosmo-$INSTANCE_NUM"
  
  if ps -p $pid > /dev/null 2>&1; then
    echo -e "${GREEN}✅ $INSTANCE_ID (PID $pid): RUNNING${NC}"
    
    # Get process info
    CPU=$(ps -p $pid -o %cpu= | tr -d ' ' || echo "N/A")
    MEM=$(ps -p $pid -o %mem= | tr -d ' ' || echo "N/A")
    ELAPSED=$(ps -p $pid -o etime= | tr -d ' ' || echo "N/A")
    
    echo -e "   CPU: ${CPU}%  |  Memory: ${MEM}%  |  Uptime: $ELAPSED"
    
    ((RUNNING++))
    RUNNING_INSTANCES+=("$INSTANCE_ID")
    RUNNING_PIDS+=("$pid")
  else
    echo -e "${RED}❌ $INSTANCE_ID (PID $pid): STOPPED${NC}"
    ((STOPPED++))
  fi
  echo ""
done < .cosmo_cluster_pids

echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "  Running:  ${GREEN}$RUNNING${NC} / $TOTAL_PIDS"
echo -e "  Stopped:  ${RED}$STOPPED${NC} / $TOTAL_PIDS"
echo ""

# Determine backend from config
CONFIG="src/config.yaml"
BACKEND="unknown"

if [ -f "$CONFIG" ]; then
  if grep -A 10 "cluster:" "$CONFIG" | grep -q "backend: redis"; then
    BACKEND="redis"
  elif grep -A 10 "cluster:" "$CONFIG" | grep -q "backend: filesystem"; then
    BACKEND="filesystem"
  fi
fi

echo -e "${CYAN}🌐 Cluster Coordination${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "  Backend: ${YELLOW}$BACKEND${NC}"
echo ""

# Check log files for leader status and coordination
LEADER_FOUND=false
LEADER_INSTANCE="none"

for i in "${!RUNNING_INSTANCES[@]}"; do
  INSTANCE_ID="${RUNNING_INSTANCES[$i]}"
  LOG_FILE="logs/cluster-$INSTANCE_ID.log"
  
  if [ -f "$LOG_FILE" ]; then
    # Check for leadership in logs
    if tail -100 "$LOG_FILE" | grep -q "isLeader.*true\|Leadership acquired\|Became leader"; then
      echo -e "${GREEN}👑 $INSTANCE_ID: LEADER${NC}"
      LEADER_FOUND=true
      LEADER_INSTANCE="$INSTANCE_ID"
    else
      echo -e "${CYAN}👤 $INSTANCE_ID: FOLLOWER${NC}"
    fi
    
    # Check for recent activity (last 10 lines)
    RECENT_ACTIVITY=$(tail -10 "$LOG_FILE" | grep -c "cycle\|Cycle" || echo "0")
    if [ "$RECENT_ACTIVITY" -gt 0 ]; then
      echo -e "   Recent activity: ${GREEN}$RECENT_ACTIVITY cycles logged${NC}"
    else
      echo -e "   Recent activity: ${YELLOW}No recent cycles${NC}"
    fi
    
    # Check for errors
    ERROR_COUNT=$(tail -100 "$LOG_FILE" | grep -c "ERROR\|Error" || echo "0")
    if [ "$ERROR_COUNT" -gt 0 ]; then
      echo -e "   ${RED}⚠️  $ERROR_COUNT errors in last 100 lines${NC}"
    fi
    
    echo ""
  else
    echo -e "${YELLOW}⚠️  $INSTANCE_ID: Log file not found${NC}"
    echo ""
  fi
done

echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"

if [ "$LEADER_FOUND" = true ]; then
  echo -e "  Leader: ${GREEN}$LEADER_INSTANCE${NC}"
else
  echo -e "  Leader: ${RED}NONE DETECTED${NC}"
  echo -e "  ${YELLOW}⚠️  No leader found - cluster may be initializing${NC}"
fi
echo ""

# Backend-specific checks
if [ "$BACKEND" = "redis" ]; then
  echo -e "${CYAN}🔴 Redis Backend Status${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
  
  # Check if redis-cli is available
  if command -v redis-cli > /dev/null; then
    REDIS_HOST="localhost"
    REDIS_PORT="6379"
    
    # Try to get cluster keys
    KEY_COUNT=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --scan --pattern "cosmo:cluster:*" 2>/dev/null | wc -l || echo "N/A")
    
    if [ "$KEY_COUNT" != "N/A" ]; then
      echo -e "  Cluster keys: ${GREEN}$KEY_COUNT${NC}"
      
      # Check for heartbeats
      HEARTBEAT_KEYS=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --scan --pattern "cosmo:cluster:health:*" 2>/dev/null | wc -l || echo "0")
      echo -e "  Active heartbeats: ${GREEN}$HEARTBEAT_KEYS${NC}"
      
      # Check for leader key
      LEADER_KEY=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" get "cosmo:cluster:leader" 2>/dev/null || echo "none")
      if [ "$LEADER_KEY" != "none" ]; then
        echo -e "  Leader token: ${GREEN}present${NC}"
      else
        echo -e "  Leader token: ${YELLOW}absent${NC}"
      fi
    else
      echo -e "  ${YELLOW}⚠️  Cannot connect to Redis${NC}"
    fi
  else
    echo -e "  ${YELLOW}redis-cli not found, skipping Redis checks${NC}"
  fi
  echo ""
  
elif [ "$BACKEND" = "filesystem" ]; then
  echo -e "${CYAN}📁 Filesystem Backend Status${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
  
  # Get filesystem root from config
  FS_ROOT="/tmp/cosmo_cluster"
  if [ -f "$CONFIG" ]; then
    FS_ROOT_LINE=$(grep -A 20 "cluster:" "$CONFIG" | grep "root:" | head -1 || echo "")
    if [ -n "$FS_ROOT_LINE" ]; then
      FS_ROOT=$(echo "$FS_ROOT_LINE" | sed 's/.*root: *"\(.*\)".*/\1/')
    fi
  fi
  
  echo -e "  Root: $FS_ROOT"
  
  if [ -d "$FS_ROOT" ]; then
    # Check for leader lock
    LEADER_LOCK="$FS_ROOT/control/LEADER"
    if [ -f "$LEADER_LOCK" ]; then
      LEADER_HOLDER=$(cat "$LEADER_LOCK" 2>/dev/null || echo "unknown")
      echo -e "  Leader lock: ${GREEN}$LEADER_HOLDER${NC}"
    else
      echo -e "  Leader lock: ${YELLOW}No active leader${NC}"
    fi
    
    # Check for health beacons
    if [ -d "$FS_ROOT/health" ]; then
      BEACON_COUNT=$(find "$FS_ROOT/health" -name "*.json" -type f 2>/dev/null | wc -l || echo "0")
      echo -e "  Health beacons: ${GREEN}$BEACON_COUNT${NC}"
    fi
    
    # Check for recent barriers
    if [ -d "$FS_ROOT/barriers" ]; then
      BARRIER_COUNT=$(find "$FS_ROOT/barriers" -type d -name "cycle_*" 2>/dev/null | wc -l || echo "0")
      echo -e "  Cycle barriers: ${GREEN}$BARRIER_COUNT${NC}"
    fi
  else
    echo -e "  ${RED}⚠️  Filesystem root not found${NC}"
  fi
  echo ""
fi

# Summary
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Summary                                        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"

if [ $STOPPED -eq 0 ] && [ "$LEADER_FOUND" = true ]; then
  echo -e "  Status: ${GREEN}✅ HEALTHY${NC}"
  echo -e "  All instances running, leader active"
  exit 0
elif [ $STOPPED -eq 0 ] && [ "$LEADER_FOUND" = false ]; then
  echo -e "  Status: ${YELLOW}⚠️  DEGRADED${NC}"
  echo -e "  All instances running, but no leader detected"
  echo -e "  ${CYAN}Cluster may still be initializing${NC}"
  exit 1
else
  echo -e "  Status: ${RED}❌ UNHEALTHY${NC}"
  echo -e "  Some instances have stopped"
  echo -e "  ${YELLOW}Check logs: tail -f logs/cluster-cosmo-*.log${NC}"
  exit 1
fi
