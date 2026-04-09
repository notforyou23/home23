#!/bin/bash
# Start engine + dashboard + feeder + harness for a named agent
# Usage: bash scripts/start-agent.sh test-agent

set -e

AGENT_NAME="${1:?Usage: start-agent.sh <agent-name>}"
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_DIR="$HOME23_ROOT/instances/$AGENT_NAME"
BRAIN_DIR="$INSTANCE_DIR/brain"
LOGS_DIR="$INSTANCE_DIR/logs"
WORKSPACE_DIR="$INSTANCE_DIR/workspace"

if [ ! -d "$INSTANCE_DIR" ]; then
  echo "ERROR: Instance directory not found: $INSTANCE_DIR"
  exit 1
fi

mkdir -p "$BRAIN_DIR" "$LOGS_DIR" "$INSTANCE_DIR/conversations/sessions"

# Parse ports from agent config
ENGINE_PORT=$(grep 'engine:' "$INSTANCE_DIR/config.yaml" | head -1 | awk '{print $2}' || echo 5001)
DASHBOARD_PORT=$(grep 'dashboard:' "$INSTANCE_DIR/config.yaml" | head -1 | awk '{print $2}' || echo 5002)
MCP_PORT=$(grep 'mcp:' "$INSTANCE_DIR/config.yaml" | head -1 | awk '{print $2}' || echo 5003)

# Read API keys from config/secrets.yaml (single source of truth)
OLLAMA_CLOUD_KEY=$(grep -A1 'ollama-cloud:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
ANTHROPIC_KEY=$(grep -A1 'anthropic:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
OPENAI_KEY=$(grep -A1 'openai:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")
XAI_KEY=$(grep -A1 'xai:' "$HOME23_ROOT/config/secrets.yaml" | grep 'apiKey:' | awk '{print $2}' | tr -d '"' || echo "")

# Read provider URLs from config/home.yaml (single source of truth)
OLLAMA_LOCAL_URL=$(grep -A1 'ollama-local:' "$HOME23_ROOT/config/home.yaml" | grep 'baseUrl:' | awk '{print $2}' | tr -d '"' || echo "http://127.0.0.1:11434")
OLLAMA_CLOUD_URL=$(grep -A1 'ollama-cloud:' "$HOME23_ROOT/config/home.yaml" | grep 'baseUrl:' | awk '{print $2}' | tr -d '"' || echo "https://ollama.com/v1")
EMBEDDING_URL=$(grep 'endpoint:' "$HOME23_ROOT/config/home.yaml" | head -1 | awk '{print $2}' | tr -d '"' || echo "http://127.0.0.1:11434/api/embeddings")

# Common env vars for all processes
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

echo "Starting $AGENT_NAME..."
echo "  Brain:      $BRAIN_DIR"
echo "  Workspace:  $WORKSPACE_DIR"
echo "  Engine WS:  port $ENGINE_PORT"
echo "  Dashboard:  port $DASHBOARD_PORT"

# ── 1. Start engine ──
node "$HOME23_ROOT/engine/src/index.js" \
  > "$LOGS_DIR/engine.log" 2>&1 &
ENGINE_PID=$!
echo "$ENGINE_PID" > "$INSTANCE_DIR/.engine.pid"
echo "  Engine PID: $ENGINE_PID"

# Wait for engine WS to be ready
echo -n "  Waiting for engine..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$ENGINE_PORT/health" > /dev/null 2>&1; then
    echo " ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo " timeout (continuing anyway)"
  fi
  sleep 1
done

# ── 2. Start dashboard server ──
node "$HOME23_ROOT/engine/src/dashboard/server.js" \
  > "$LOGS_DIR/dashboard.log" 2>&1 &
DASHBOARD_PID=$!
echo "$DASHBOARD_PID" > "$INSTANCE_DIR/.dashboard.pid"
echo "  Dashboard PID: $DASHBOARD_PID"

# Wait for dashboard API to be ready
echo -n "  Waiting for dashboard..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$DASHBOARD_PORT/api/state" > /dev/null 2>&1; then
    echo " ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo " timeout (continuing anyway)"
  fi
  sleep 1
done

# ── 3. Start feeder ──
FEEDER_CONFIG="$INSTANCE_DIR/feeder.yaml" \
node "$HOME23_ROOT/feeder/server.js" \
  > "$LOGS_DIR/feeder.log" 2>&1 &
FEEDER_PID=$!
echo "$FEEDER_PID" > "$INSTANCE_DIR/.feeder.pid"
echo "  Feeder PID: $FEEDER_PID"

# ── 4. Build and start harness ──
echo -n "  Building harness..."
cd "$HOME23_ROOT"
if npx tsc > "$LOGS_DIR/build.log" 2>&1; then
  echo " done"
else
  echo " FAILED (check $LOGS_DIR/build.log)"
  echo "  Starting without harness. Fix build errors and restart."
  echo ""
  echo "$AGENT_NAME partially running (engine + dashboard + feeder only)."
  exit 1
fi

HOME23_AGENT="$AGENT_NAME" \
node "$HOME23_ROOT/dist/home.js" \
  > "$LOGS_DIR/harness.log" 2>&1 &
HARNESS_PID=$!
echo "$HARNESS_PID" > "$INSTANCE_DIR/.harness.pid"
echo "  Harness PID: $HARNESS_PID"

echo ""
echo "$AGENT_NAME is running."
echo "  Engine log:    $LOGS_DIR/engine.log"
echo "  Dashboard log: $LOGS_DIR/dashboard.log"
echo "  Feeder log:    $LOGS_DIR/feeder.log"
echo "  Harness log:   $LOGS_DIR/harness.log"
echo "  Dashboard:     http://localhost:$DASHBOARD_PORT"
echo ""
echo "To stop: bash scripts/stop-agent.sh $AGENT_NAME"
