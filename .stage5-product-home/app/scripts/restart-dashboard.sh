#!/bin/bash
# Restart ONLY the dashboard server for a named agent, mirroring start-agent.sh env.
# Leaves engine, feeder, and harness untouched. Usage: bash scripts/restart-dashboard.sh jerry
set -e

AGENT_NAME="${1:?Usage: restart-dashboard.sh <agent-name>}"
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_DIR="$HOME23_ROOT/instances/$AGENT_NAME"
BRAIN_DIR="$INSTANCE_DIR/brain"
LOGS_DIR="$INSTANCE_DIR/logs"
WORKSPACE_DIR="$INSTANCE_DIR/workspace"

ENGINE_PORT=$(grep 'engine:' "$INSTANCE_DIR/config.yaml" | head -1 | awk '{print $2}' || echo 5001)
DASHBOARD_PORT=$(grep 'dashboard:' "$INSTANCE_DIR/config.yaml" | head -1 | awk '{print $2}' || echo 5002)
MCP_PORT=$(grep 'mcp:' "$INSTANCE_DIR/config.yaml" | head -1 | awk '{print $2}' || echo 5003)

OLLAMA_CLOUD_KEY=$(grep -A1 'ollama-cloud:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
ANTHROPIC_KEY=$(grep -A1 'anthropic:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
OPENAI_KEY=$(grep -A1 'openai:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
XAI_KEY=$(grep -A1 'xai:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
OLLAMA_LOCAL_URL=$(grep -A1 'ollama-local:' "$HOME23_ROOT/config/home.yaml" | grep 'baseUrl:' | awk '{print $2}' | tr -d '"' || echo "http://127.0.0.1:11434")

export COSMO_CONFIG_PATH="$HOME23_ROOT/configs/base-engine.yaml"
export COSMO_RUNTIME_DIR="$BRAIN_DIR"
export COSMO_WORKSPACE_PATH="$WORKSPACE_DIR"
export DASHBOARD_PORT="$DASHBOARD_PORT"
export COSMO_DASHBOARD_PORT="$DASHBOARD_PORT"
export REALTIME_PORT="$ENGINE_PORT"
export MCP_HTTP_PORT="$MCP_PORT"
export EMBEDDING_BASE_URL="${OLLAMA_LOCAL_URL}/v1"
export LOCAL_LLM_BASE_URL="${OLLAMA_LOCAL_URL}/v1"
export OLLAMA_CLOUD_API_KEY="$OLLAMA_CLOUD_KEY"
export ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_KEY"
export OPENAI_API_KEY="$OPENAI_KEY"
export XAI_API_KEY="$XAI_KEY"
export INSTANCE_ID="home23-$AGENT_NAME"

# Kill whatever is actually listening on the dashboard port (pidfile may be stale)
OLD_PID=$(lsof -nP -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
if [ -n "$OLD_PID" ]; then
  echo "Stopping dashboard pid $OLD_PID on port $DASHBOARD_PORT"
  kill "$OLD_PID" 2>/dev/null || true
  for i in $(seq 1 15); do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  kill -9 "$OLD_PID" 2>/dev/null || true
fi

node "$HOME23_ROOT/engine/src/dashboard/server.js" \
  > "$LOGS_DIR/dashboard.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$INSTANCE_DIR/.dashboard.pid"
echo "Dashboard restarted: pid $NEW_PID on port $DASHBOARD_PORT"

echo -n "Waiting for dashboard..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$DASHBOARD_PORT/api/state" > /dev/null 2>&1; then
    echo " ready"
    exit 0
  fi
  sleep 1
done
echo " timeout (check $LOGS_DIR/dashboard.log)"
exit 1
