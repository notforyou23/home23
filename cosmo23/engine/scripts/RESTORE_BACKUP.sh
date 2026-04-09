#!/bin/bash
# Restore Backup - Load Any Previous Run
# Non-destructive: Current state is backed up before restoration

if [ -z "$1" ]; then
  echo "❌ Error: Please specify backup directory to restore"
  echo ""
  echo "Usage: ./RESTORE_BACKUP.sh <backup_directory> [options]"
  echo ""
  echo "Options:"
  echo "  --state-only    Restore only state files (keep current config)"
  echo "  --config-only   Restore only configuration (keep current state)"
  echo ""
  echo "Available backups:"
  ls -dt cosmo_backup_* 2>/dev/null | head -10 | while read dir; do
    if [ -f "$dir/state.json.gz" ]; then
      SIZE=$(du -h "$dir/state.json.gz" | cut -f1)
      CYCLE="unknown"
      if command -v python3 &> /dev/null; then
        CYCLE=$(python3 -c "
import gzip, json, sys
try:
    with gzip.open('$dir/state.json.gz', 'rt') as f:
        state = json.load(f)
        print(state.get('cycleCount', 'unknown'))
except: pass
" 2>/dev/null)
      fi
      echo "  • $dir (cycle: $CYCLE, size: $SIZE)"
    else
      echo "  • $dir"
    fi
  done
  echo ""
  exit 1
fi

BACKUP_DIR="$1"
STATE_ONLY=false
CONFIG_ONLY=false

# Parse options
if [ "$2" = "--state-only" ]; then
  STATE_ONLY=true
elif [ "$2" = "--config-only" ]; then
  CONFIG_ONLY=true
fi

# Validate backup directory
if [ ! -d "$BACKUP_DIR" ]; then
  echo "❌ Error: Backup directory not found: $BACKUP_DIR"
  exit 1
fi

echo "🔄 Restoring from backup: $BACKUP_DIR"
echo ""

# ============================================================================
# SAFETY: Backup current state before restoration
# ============================================================================

SAFETY_BACKUP="cosmo_pre_restore_$(date +%Y%m%d_%H%M%S)"
echo "🛡️  Safety backup of current state: $SAFETY_BACKUP"
mkdir -p "$SAFETY_BACKUP"
mkdir -p "$SAFETY_BACKUP/coordinator"

# Backup current files that will be replaced
if [ -f "runtime/state.json.gz" ]; then
  cp "runtime/state.json.gz" "$SAFETY_BACKUP/" 2>/dev/null
fi
if [ -f "runtime/thoughts.jsonl" ]; then
  cp "runtime/thoughts.jsonl" "$SAFETY_BACKUP/" 2>/dev/null
fi
if [ -f "src/config.yaml" ]; then
  cp "src/config.yaml" "$SAFETY_BACKUP/" 2>/dev/null
fi
cp runtime/topics-*.json "$SAFETY_BACKUP/" 2>/dev/null
cp runtime/coordinator/*.json "$SAFETY_BACKUP/coordinator/" 2>/dev/null
cp runtime/coordinator/*.jsonl "$SAFETY_BACKUP/coordinator/" 2>/dev/null

echo "   ✓ Current state safely backed up"
echo ""

# ============================================================================
# RESTORATION
# ============================================================================

echo "📥 Restoring files..."

if [ "$CONFIG_ONLY" = false ]; then
  # Restore state files
  if [ -f "$BACKUP_DIR/state.json.gz" ]; then
    cp "$BACKUP_DIR/state.json.gz" "runtime/"
    echo "   ✓ state.json.gz"
  fi
  
  if [ -f "$BACKUP_DIR/state.json" ]; then
    cp "$BACKUP_DIR/state.json" "runtime/"
    echo "   ✓ state.json"
  fi
  
  # Restore OLD files if they exist in backup
  if [ -f "$BACKUP_DIR/state.json.gz.OLD" ]; then
    cp "$BACKUP_DIR/state.json.gz.OLD" "runtime/"
    echo "   ✓ state.json.gz.OLD"
  fi
  
  if [ -f "$BACKUP_DIR/state.json.OLD" ]; then
    cp "$BACKUP_DIR/state.json.OLD" "runtime/"
    echo "   ✓ state.json.OLD"
  fi
  
  # Restore thought journal
  if [ -f "$BACKUP_DIR/thoughts.jsonl" ]; then
    cp "$BACKUP_DIR/thoughts.jsonl" "runtime/"
    echo "   ✓ thoughts.jsonl"
  fi
  
  if [ -f "$BACKUP_DIR/thoughts.jsonl.OLD" ]; then
    cp "$BACKUP_DIR/thoughts.jsonl.OLD" "runtime/"
    echo "   ✓ thoughts.jsonl.OLD"
  fi
  
  # Restore topic queue
  if [ -f "$BACKUP_DIR/topics-queue.json" ]; then
    cp "$BACKUP_DIR/topics-queue.json" "runtime/"
    echo "   ✓ topics-queue.json"
  fi
  
  if [ -f "$BACKUP_DIR/topics-processed.json" ]; then
    cp "$BACKUP_DIR/topics-processed.json" "runtime/"
    echo "   ✓ topics-processed.json"
  fi
  
  # Restore coordinator files
  if [ -d "$BACKUP_DIR/coordinator" ]; then
    # Context
    if [ -f "$BACKUP_DIR/coordinator/context.json" ]; then
      cp "$BACKUP_DIR/coordinator/context.json" "runtime/coordinator/"
      echo "   ✓ coordinator/context.json"
    fi
    
    if [ -f "$BACKUP_DIR/coordinator/context.json.OLD" ]; then
      cp "$BACKUP_DIR/coordinator/context.json.OLD" "runtime/coordinator/"
      echo "   ✓ coordinator/context.json.OLD"
    fi
    
    # Results queue
    if [ -f "$BACKUP_DIR/coordinator/results_queue.jsonl" ]; then
      cp "$BACKUP_DIR/coordinator/results_queue.jsonl" "runtime/coordinator/"
      echo "   ✓ coordinator/results_queue.jsonl"
    fi
    
    # Review reports
    REVIEW_COUNT=$(ls "$BACKUP_DIR/coordinator/review_"*.json 2>/dev/null | wc -l | tr -d ' ')
    if [ "$REVIEW_COUNT" -gt 0 ]; then
      cp "$BACKUP_DIR/coordinator/review_"*.json "runtime/coordinator/" 2>/dev/null
      cp "$BACKUP_DIR/coordinator/review_"*.md "runtime/coordinator/" 2>/dev/null
      echo "   ✓ coordinator review reports ($REVIEW_COUNT reviews)"
    fi
  fi
fi

if [ "$STATE_ONLY" = false ]; then
  # Restore configuration
  if [ -f "$BACKUP_DIR/config.yaml" ]; then
    cp "$BACKUP_DIR/config.yaml" "phase2/"
    echo "   ✓ config.yaml"
  fi
  
  # Restore run metadata (launcher settings)
  if [ -f "$BACKUP_DIR/run-metadata.json" ]; then
    cp "$BACKUP_DIR/run-metadata.json" "runtime/"
    echo "   ✓ run-metadata.json (original launcher settings)"
  fi
fi

# ============================================================================
# SUMMARY
# ============================================================================

echo ""
echo "✅ RESTORATION COMPLETE"
echo ""
echo "📦 Restored from: $BACKUP_DIR"
echo "🛡️  Previous state saved: $SAFETY_BACKUP"
echo ""

# Check if MCP server is running
MCP_RUNNING=false
if lsof -i :3336 -sTCP:LISTEN >/dev/null 2>&1; then
  MCP_RUNNING=true
fi

if [ "$CONFIG_ONLY" = true ]; then
  echo "⚙️  Configuration restored (state unchanged)"
elif [ "$STATE_ONLY" = true ]; then
  echo "💾 State restored (configuration unchanged)"
else
  echo "🎯 RESTORED:"
  
  # Show what was restored
  if [ -f "runtime/state.json.gz" ]; then
    # Try to get cycle count
    if command -v python3 &> /dev/null; then
      CYCLE_INFO=$(python3 -c "
import gzip, json, sys
try:
    with gzip.open('runtime/state.json.gz', 'rt') as f:
        state = json.load(f)
        nodes = len(state.get('memory', {}).get('nodes', []))
        goals = len(state.get('goals', {}).get('goals', []))
        cycle = state.get('cycleCount', 0)
        print(f'   • Cycle: {cycle}')
        print(f'   • Memory nodes: {nodes}')
        print(f'   • Active goals: {goals}')
except Exception as e:
    print(f'   • State file present')
" 2>/dev/null)
      if [ ! -z "$CYCLE_INFO" ]; then
        echo "$CYCLE_INFO"
      fi
    fi
  fi
  
  echo ""
fi

# MCP server status and instructions
echo ""
if [ "$MCP_RUNNING" = true ]; then
  echo "🎯 INSPECT RESTORED STATE (MCP Dashboards):"
  echo "   Stream:   http://localhost:3336"
  echo "   Graph:    http://localhost:3336/graph"
  echo "   Classic:  http://localhost:3336/classic"
  echo "   (Dashboards show restored state immediately!)"
else
  echo "📊 TO VIEW RESTORED STATE (Optional):"
  echo "   Start MCP Server: node mcp/dashboard-server.js"
  echo "   Then visit: http://localhost:3336"
  echo "   (Browse backup before running Cosmo)"
fi

echo ""
echo "🚀 TO CONTINUE THIS RUN:"
echo "   ./START_SYSTEM_GPT5.sh"
echo "   (Loads restored state and continues from saved cycle)"

echo ""
echo "🔙 TO UNDO THIS RESTORE:"
echo "   ./RESTORE_BACKUP.sh $SAFETY_BACKUP"
echo ""

