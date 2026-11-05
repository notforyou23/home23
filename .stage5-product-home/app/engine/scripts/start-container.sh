#!/bin/bash
# COSMO container entrypoint
set -e

# Ensure working dir is repo root
cd "$(dirname "$0")/.."

# Fail fast if API key missing
if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: OPENAI_API_KEY not set" >&2
  exit 1
fi

# Create minimal .env for app to read
if [ ! -f .env ]; then
  echo "OPENAI_API_KEY=$OPENAI_API_KEY" > .env
fi

# Install deps if needed (for dev builds with bind mounts)
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

# Start full stack (non-interactive) using launcher services and orchestrator
export COSMO_TUI=false
export COSMO_TUI_SPLIT=false

# Start services like LAUNCH_COSMO.sh does, but without prompts
node mcp/http-server.js 3347 > logs/mcp-http.log 2>&1 &
node mcp/dashboard-server.js > logs/mcp-dashboard.log 2>&1 &
COSMO_DASHBOARD_PORT=3344 node src/dashboard/server.js > logs/dashboard.log 2>&1 &

# Run orchestrator
exec node --expose-gc src/index.js

