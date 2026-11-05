#!/bin/bash
# Stop all processes for a named agent
# Usage: bash scripts/stop-agent.sh test-agent

AGENT_NAME="${1:?Usage: stop-agent.sh <agent-name>}"
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_DIR="$HOME23_ROOT/instances/$AGENT_NAME"

echo "Stopping $AGENT_NAME..."

# Stop in reverse order: harness → feeder → dashboard → engine
for PROC in harness feeder dashboard engine; do
  PID_FILE="$INSTANCE_DIR/.$PROC.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "  Stopped $PROC (PID $PID)"
    else
      echo "  $PROC already stopped (PID $PID)"
    fi
    rm -f "$PID_FILE"
  else
    echo "  No PID file for $PROC"
  fi
done

echo "$AGENT_NAME stopped."
