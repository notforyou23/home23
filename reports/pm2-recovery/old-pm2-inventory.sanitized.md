# Old PM2 Inventory (Sanitized)

Sources: `/Users/jtr/.pm2/dump.pm2.predisaster-backup`, `/Users/jtr/.pm2/dump.pm2.45-app-backup`, `/Users/jtr/.pm2/safety-backups/post-save.dump.pm2.20260331-201244`.
Secrets and token-like env vars are intentionally omitted.

## althea-dashboard
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/dashboard (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/althea-dashboard-out.log
- err: /Users/jtr/.pm2/logs/althea-dashboard-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-home={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/dashboard/server.js`

## brain-agent
- source: predisaster-60
- status/restarts at backup: online / 2
- cwd: /Users/jtr/.openclaw/workspace/agents/brain (exists)
- script: /Users/jtr/.openclaw/workspace/agents/brain/bin/brain-agent.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/brain-agent-out.log
- err: /Users/jtr/.pm2/logs/brain-agent-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/.openclaw/workspace/agents/brain/bin/brain-agent.js`

## cosmo-admin
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/cosmos.evobrew.com/admin (exists)
- script: /Users/jtr/websites/cosmos.evobrew.com/admin/server.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/cosmo-admin-out-6.log
- err: /Users/jtr/.pm2/logs/cosmo-admin-error-6.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, cosmo-admin={}, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/websites/cosmos.evobrew.com/admin/server.js`

## cosmo-backend
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/regina6.com/html/cosmo (exists)
- script: /Users/jtr/websites/regina6.com/html/cosmo/server/index.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/cosmo-backend-out.log
- err: /Users/jtr/.pm2/logs/cosmo-backend-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, SUPABASE_URL=https://hgbpdluiybaycfnylfrl.supabase.co, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/websites/regina6.com/html/cosmo/server/index.js`

## cosmo-gallery
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home (exists)
- script: /Users/jtr/websites/cosmoimages.evobrew.com/server/index.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/cosmo-gallery-out.log
- err: /Users/jtr/.pm2/logs/cosmo-gallery-error.log
- selected env: `APPLICATIONINSIGHTS_CONFIGURATION_CONTENT={}, MACH_PORT_RENDEZVOUS_PEER_VALDATION=0, NODE_APP_INSTANCE=0, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, instance_var=NODE_APP_INSTANCE`
- command hint: `node /Users/jtr/websites/cosmoimages.evobrew.com/server/index.js`

## cosmo-ide-local [CWD_MISSING SCRIPT_MISSING]
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo_ide_v2_dev (missing)
- script: /Users/jtr/_JTR23_/cosmo_ide_v2_dev/server/server.js (missing)
- interpreter: /opt/homebrew/Cellar/node/25.4.0/bin/node
- args: `/Users/jtr/_JTR23_/cosmo-home/runs/terrapin`
- out: /Users/jtr/.pm2/logs/cosmo-ide-local-out.log
- err: /Users/jtr/.pm2/logs/cosmo-ide-local-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/Cellar/node/25.4.0/bin/node /Users/jtr/_JTR23_/cosmo_ide_v2_dev/server/server.js /Users/jtr/_JTR23_/cosmo-home/runs/terrapin`

## cosmo-studio
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/cosmos.evobrew.com (exists)
- script: /Users/jtr/websites/cosmos.evobrew.com/studio/server/server.js (exists)
- interpreter: node
- args: `/tmp/studio-default`
- out: /Users/jtr/websites/cosmos.evobrew.com/logs/cosmo-studio-out.log
- err: /Users/jtr/websites/cosmos.evobrew.com/logs/cosmo-studio-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, DOCKER_CONFIG=/tmp/docker-nokeychain, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, HTTPS_PORT=3409, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, PORT=3406, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo-studio={}, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/websites/cosmos.evobrew.com/studio/server/server.js /tmp/studio-default`

## cosmo-unified
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/cosmos.evobrew.com (exists)
- script: /Users/jtr/websites/cosmos.evobrew.com/server/index.js (exists)
- interpreter: <empty>
- out: /Users/jtr/.pm2/logs/cosmo-unified-out.log
- err: /Users/jtr/.pm2/logs/cosmo-unified-error.log
- selected env: `APPLICATIONINSIGHTS_CONFIGURATION_CONTENT={}, COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, LaunchInstanceID=86993CD9-342C-4C1D-A83A-3A6211BBC3FC, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/Users/jtr/websites/cosmos.evobrew.com/server/index.js`

## cosmo23-coz
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3 (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/coz-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/coz-err.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js`

## cosmo23-edison
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3 (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/edison-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/edison-err.log
- selected env: `COSMO_INSTANCE=edison, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4601, HOME_PORT=4612, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-edison, cosmo23-coz={}, cosmo23-edison={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js`

## cosmo23-home
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3 (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/home-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/home-err.log
- selected env: `COSMO_INSTANCE=althea, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4610, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-home, cosmo23-coz={}, cosmo23-home={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js`

## cosmo23-jtr
- source: predisaster-60
- status/restarts at backup: online / 3
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/index.js (exists)
- interpreter: node
- node_args: `['--expose-gc', '--max-old-space-size=2048']`
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/jtr-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/jtr-err.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home_2.3/configs/jtr.yaml, COSMO_DASHBOARD_PORT=4601, COSMO_INSTANCE=coz, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/runs/jtr, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=4640, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-edison={}, cosmo23-jtr={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/index.js`

## cosmo23-jtr-dash
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/dashboard/server.js (exists)
- interpreter: /opt/homebrew/bin/node
- out: /Users/jtr/.pm2/logs/cosmo23-jtr-dash-out.log
- err: /Users/jtr/.pm2/logs/cosmo23-jtr-dash-error.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home_2.3/configs/jtr.yaml, COSMO_DASHBOARD_PORT=4601, COSMO_INSTANCE=coz, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo_2.3/runs/merged-jgscrapes, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=4640, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/bin/node /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/dashboard/server.js`

## cosmo23-jtr-feeder
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/feeder (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/feeder/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/jtr-feeder-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/jtr-feeder-err.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, FEEDER_CONFIG=feeder.yaml, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-jtr-feeder={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/feeder/server.js`

## cosmo23-knowledge
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/knowledge-dashboard (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/knowledge-dashboard/server.js (exists)
- interpreter: node
- args: `--port 3700`
- out: /Users/jtr/.pm2/logs/cosmo23-knowledge-out.log
- err: /Users/jtr/.pm2/logs/cosmo23-knowledge-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-home={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/knowledge-dashboard/server.js --port 3700`

## cosmo23-mcp
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/engine/mcp/http-server.js (exists)
- interpreter: node
- args: `4650`
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/mcp-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/mcp-err.log
- selected env: `COSMO_INSTANCE=coz, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo_2.3/runs/merged-jgscrapes, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-mcp={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/engine/mcp/http-server.js 4650`

## cosmo23-terrapin
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/index.js (exists)
- interpreter: node
- node_args: `['--expose-gc', '--max-old-space-size=2048']`
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/terrapin-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/terrapin-err.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home_2.3/configs/terrapin.yaml, COSMO_DASHBOARD_PORT=4609, COSMO_INSTANCE=coz, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/runs/terrapin, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=4647, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-terrapin={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/index.js`

## cosmo23-terrapin-dash
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/terrapin-dash-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/terrapin-dash-err.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home_2.3/configs/terrapin.yaml, COSMO_DASHBOARD_PORT=4609, COSMO_INSTANCE=coz, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/runs/terrapin, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=4647, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-terrapin-dash={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/engine/src/dashboard/server.js`

## cosmo23-terrapin-feeder
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/feeder (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/feeder/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/terrapin-feeder-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/terrapin-feeder-err.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, FEEDER_CONFIG=terrapin-feeder.yaml, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-terrapin-feeder={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/feeder/server.js`

## cosmo23-tick
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3 (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/tick-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/tick-err.log
- selected env: `COSMO_INSTANCE=tick, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4601, HOME_PORT=4613, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-tick, cosmo23-coz={}, cosmo23-home={}, cosmo23-tick={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/dist/home.js`

## cosmo23-voice
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home_2.3/voice (exists)
- script: /Users/jtr/_JTR23_/cosmo-home_2.3/voice/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/voice-out.log
- err: /Users/jtr/_JTR23_/cosmo-home_2.3/logs/voice-err.log
- selected env: `COSMO_BRAIN_PATH=/Users/jtr/_JTR23_/cosmo-home_2.3/runs/jtr, COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OLLAMA_URL=http://192.168.6.205:11434, OPENCLAW_GATEWAY_PORT=18789, PORT=4670, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, cosmo23-voice={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home_2.3/voice/server.js`

## coz-cortex
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr (exists)
- script: /Users/jtr/.openclaw/workspace/bin/coz-cortex.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/coz-cortex-out.log
- err: /Users/jtr/.pm2/logs/coz-cortex-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/.openclaw/workspace/bin/coz-cortex.js`

## coz-dashboard
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/.openclaw/workspace/projects/coz-dashboard (exists)
- script: /Users/jtr/.openclaw/workspace/projects/coz-dashboard/api/server.js (exists)
- interpreter: node
- out: /Users/jtr/.openclaw/workspace/projects/coz-dashboard/logs/output-13.log
- err: /Users/jtr/.openclaw/workspace/projects/coz-dashboard/logs/error-13.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, PORT=3500, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, coz-dashboard={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/.openclaw/workspace/projects/coz-dashboard/api/server.js`

## drop-converter
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home/feeder (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/feeder/drop-converter.js (exists)
- interpreter: node
- node_args: `['--max-old-space-size=128']`
- out: /Users/jtr/_JTR23_/cosmo-home/logs/drop-converter-out-42.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/drop-converter-err-42.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/feeder/drop-converter.js`

## ecosystem.walkaway
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/.openclaw/workspace/projects/walk-away-automation (exists)
- script: /Users/jtr/.openclaw/workspace/projects/walk-away-automation/ecosystem.walkaway.cjs (exists)
- interpreter: /opt/homebrew/Cellar/node/25.4.0/bin/node
- out: /Users/jtr/.pm2/logs/ecosystem.walkaway-out.log
- err: /Users/jtr/.pm2/logs/ecosystem.walkaway-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/Cellar/node/25.4.0/bin/node /Users/jtr/.openclaw/workspace/projects/walk-away-automation/ecosystem.walkaway.cjs`

## evobrew
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/evobrew (exists)
- script: /Users/jtr/_JTR23_/evobrew/server/server.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/evobrew-out.log
- err: /Users/jtr/.pm2/logs/evobrew-error.log
- selected env: `COSMO_ADMIN_MODE=true, COSMO_BRAIN_DIRS=/Users/jtr/_JTR23_/cosmo-home/runs/,/Volumes/COSMO/Cosmo_MenloPark/priorRuns/, NODE_APP_INSTANCE=0, OPENCLAW_GATEWAY_HOST=localhost, OPENCLAW_GATEWAY_PORT=18789, PORT=3405, instance_var=NODE_APP_INSTANCE`
- command hint: `node /Users/jtr/_JTR23_/evobrew/server/server.js`

## from-the-inside-api
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/olddeadshows.com (exists)
- script: /Users/jtr/websites/olddeadshows.com/api/server.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/from-the-inside-api-out.log
- err: /Users/jtr/.pm2/logs/from-the-inside-api-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/websites/olddeadshows.com/api/server.js`

## home23-chrome-cdp [CURRENT]
- source: predisaster-60
- status/restarts at backup: online / 1
- cwd: /Users/jtr/_JTR23_/release/home23 (exists)
- script: /Users/jtr/_JTR23_/release/home23/scripts/chrome-cdp.sh (exists)
- interpreter: none
- out: /Users/jtr/_JTR23_/release/home23/logs/chrome-cdp-out.log
- err: /Users/jtr/_JTR23_/release/home23/logs/chrome-cdp-err.log
- selected env: `CDP_PORT=9222, COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5012, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/forrest/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/forrest/workspace, DASHBOARD_PORT=5012, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, INSTANCE_ID=home23-forrest, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5013, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5011, SEARXNG_URL=http://localhost:8888, home23-chrome-cdp={}, home23-forrest={}, home23-jerry={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `none /Users/jtr/_JTR23_/release/home23/scripts/chrome-cdp.sh`

## home23-cosmo23 [CURRENT]
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/release/home23/cosmo23 (exists)
- script: /Users/jtr/_JTR23_/release/home23/cosmo23/server/index.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/logs/cosmo23-out.log
- err: /Users/jtr/_JTR23_/release/home23/logs/cosmo23-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO23_CONFIG_DIR=/Users/jtr/_JTR23_/release/home23/cosmo23/.cosmo23-config, COSMO23_DASHBOARD_PORT=43244, COSMO23_MCP_HTTP_PORT=43247, COSMO23_PORT=43210, COSMO23_WS_PORT=43240, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_REFERENCE_RUNS_PATHS=, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/cosmo23/runs, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, DATABASE_URL=file:/Users/jtr/_JTR23_/release/home23/cosmo23/prisma/dev.db, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, HOME23_DASHBOARD_PORT=5002, HOME23_MANAGED=true, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-cosmo23={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/cosmo23/server/index.js`

## home23-dashboard [CURRENT]
- source: predisaster-60
- status/restarts at backup: online / 2
- cwd: /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/Dashboard (exists)
- script: /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/Dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/Dashboard/logs/out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/Dashboard/logs/err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/jerry/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, PORT=8090, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-dashboard={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/instances/jerry/projects/Dashboard/server.js`

## home23-evobrew [CURRENT]
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/release/home23/evobrew (exists)
- script: /Users/jtr/_JTR23_/release/home23/evobrew/server/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/logs/evobrew-out.log
- err: /Users/jtr/_JTR23_/release/home23/logs/evobrew-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_ADMIN_MODE=true, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/jerry/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, EVOBREW_CONFIG_DIR=/Users/jtr/_JTR23_/release/home23/evobrew, HOME23_AGENT=jerry, HOME23_MANAGED=true, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, PORT=3415, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-evobrew={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/evobrew/server/server.js`

## home23-forrest [CURRENT]
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/release/home23/engine (exists)
- script: /Users/jtr/_JTR23_/release/home23/engine/src/index.js (exists)
- interpreter: node
- node_args: `['--expose-gc', '--max-old-space-size=4096']`
- out: /Users/jtr/_JTR23_/release/home23/instances/forrest/logs/engine-out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/forrest/logs/engine-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5012, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/forrest/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/forrest/workspace, DASHBOARD_PORT=5012, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, INSTANCE_ID=home23-forrest, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5013, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5011, SEARXNG_URL=http://localhost:8888, home23-forrest={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/engine/src/index.js`

## home23-forrest-dash [CURRENT]
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/release/home23/engine (exists)
- script: /Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/instances/forrest/logs/dashboard-out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/forrest/logs/dashboard-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5012, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/forrest/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/forrest/workspace, DASHBOARD_PORT=5012, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, INSTANCE_ID=home23-forrest, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5013, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5011, SEARXNG_URL=http://localhost:8888, home23-forrest-dash={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js`

## home23-forrest-harness [CURRENT]
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/release/home23 (exists)
- script: /Users/jtr/_JTR23_/release/home23/dist/home.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/instances/forrest/logs/harness-out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/forrest/logs/harness-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/jerry/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=forrest, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-forrest-harness={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/dist/home.js`

## home23-jerry [CURRENT]
- source: predisaster-60
- status/restarts at backup: online / 22
- cwd: /Users/jtr/_JTR23_/release/home23/engine (exists)
- script: /Users/jtr/_JTR23_/release/home23/engine/src/index.js (exists)
- interpreter: node
- node_args: `['--expose-gc', '--max-old-space-size=4096']`
- out: /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/engine-out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/engine-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/jerry/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, HOME23_APPLY_MIGRATION=, HOME23_FORCE_MIGRATION_RERUN=, HOME23_PIN_CANONICAL_NODES=1, HOME23_UNARCHIVE_GOALS=, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-jerry={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/engine/src/index.js`

## home23-jerry-dash [CURRENT]
- source: predisaster-60
- status/restarts at backup: online / 3
- cwd: /Users/jtr/_JTR23_/release/home23/engine (exists)
- script: /Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/dashboard-out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/dashboard-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/jerry/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, HOME23_APPLY_MIGRATION=, HOME23_FORCE_MIGRATION_RERUN=, HOME23_PIN_CANONICAL_NODES=1, HOME23_UNARCHIVE_GOALS=, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-forrest={}, home23-jerry={}, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js`

## home23-jerry-harness [CURRENT]
- source: predisaster-60
- status/restarts at backup: online / 19
- cwd: /Users/jtr/_JTR23_/release/home23 (exists)
- script: /Users/jtr/_JTR23_/release/home23/dist/home.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/harness-out.log
- err: /Users/jtr/_JTR23_/release/home23/instances/jerry/logs/harness-err.log
- selected env: `COPILOT_OTEL_EXPORTER_TYPE=file, COPILOT_OTEL_FILE_EXPORTER_PATH=/dev/null, COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml, COSMO_DASHBOARD_PORT=5002, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/release/home23/instances/jerry/brain, COSMO_WORKSPACE_PATH=/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace, DASHBOARD_PORT=5002, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, HOME23_AGENT=jerry, INSTANCE_ID=home23-jerry, LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1, MCP_CONNECTION_NONBLOCKING=true, MCP_HTTP_PORT=5003, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, REALTIME_PORT=5001, SEARXNG_URL=http://localhost:8888, home23-jerry-dash={}, home23-jerry-harness={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/release/home23/dist/home.js`

## intel-agent
- source: predisaster-60
- status/restarts at backup: online / 2
- cwd: /Users/jtr/.openclaw/workspace/agents/intel (exists)
- script: /Users/jtr/.openclaw/workspace/agents/intel/bin/intel-agent.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/intel-agent-out-24.log
- err: /Users/jtr/.pm2/logs/intel-agent-error-24.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/.openclaw/workspace/agents/intel/bin/intel-agent.js`

## jerry-api
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/shakedownshuffle.com/jerry-api (exists)
- script: /Users/jtr/websites/shakedownshuffle.com/jerry-api/src/server.ts (exists)
- interpreter: bun
- out: /Users/jtr/.pm2/logs/jerry-api-out.log
- err: /Users/jtr/.pm2/logs/jerry-api-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, LaunchInstanceID=59752E90-63A8-4D7A-B43D-C04D20646456, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `bun /Users/jtr/websites/shakedownshuffle.com/jerry-api/src/server.ts`

## jerry-daily [SCRIPT_MISSING]
- source: predisaster-60
- status/restarts at backup: stopped / 22
- cwd: /Users/jtr/.openclaw/workspace/projects/walk-away-automation (exists)
- script: /Users/jtr/.openclaw/workspace/projects/walk-away-automation/jerry-daily.cjs (missing)
- interpreter: /opt/homebrew/bin/node
- out: /Users/jtr/.pm2/logs/jerry-daily-out.log
- err: /Users/jtr/.pm2/logs/jerry-daily-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/bin/node /Users/jtr/.openclaw/workspace/projects/walk-away-automation/jerry-daily.cjs`

## jerry-tool
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/jerry-tool (exists)
- script: /Users/jtr/jerry-tool/app.py (exists)
- interpreter: /usr/bin/python3
- out: /Users/jtr/.pm2/logs/jerry-tool-out.log
- err: /Users/jtr/.pm2/logs/jerry-tool-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/usr/bin/python3 /Users/jtr/jerry-tool/app.py`

## jogging-with-ghosts
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/websites/joggingwithghosts.com/html (exists)
- script: /Users/jtr/websites/joggingwithghosts.com/html/server.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/jogging-with-ghosts-out.log
- err: /Users/jtr/.pm2/logs/jogging-with-ghosts-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/websites/joggingwithghosts.com/html/server.js`

## jtr-feeder
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/feeder/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home/logs/jtr-feeder-out-39.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/jtr-feeder-err-39.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/feeder/server.js`

## mission-control-api
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/.openclaw/workspace/projects/mission-control/api (exists)
- script: /opt/homebrew/bin/npm (exists)
- interpreter: /opt/homebrew/Cellar/node/25.4.0/bin/node
- args: `run start`
- out: /Users/jtr/.pm2/logs/mission-control-api-out.log
- err: /Users/jtr/.pm2/logs/mission-control-api-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/Cellar/node/25.4.0/bin/node /opt/homebrew/bin/npm run start`

## mission-control-ui
- source: predisaster-60
- status/restarts at backup: stopped / 3984
- cwd: /Users/jtr/.openclaw/workspace/projects/mission-control/ui (exists)
- script: /opt/homebrew/bin/npm (exists)
- interpreter: /opt/homebrew/Cellar/node/25.4.0/bin/node
- args: `run start -- -p 3401`
- out: /Users/jtr/.pm2/logs/mission-control-ui-out.log
- err: /Users/jtr/.pm2/logs/mission-control-ui-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/Cellar/node/25.4.0/bin/node /opt/homebrew/bin/npm run start -- -p 3401`

## project-board-site
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/.openclaw/workspace/projects/project-board-site (exists)
- script: /Users/jtr/.openclaw/workspace/projects/project-board-site/server.cjs (exists)
- interpreter: /opt/homebrew/Cellar/node/25.4.0/bin/node
- out: /Users/jtr/.pm2/logs/project-board-site-out.log
- err: /Users/jtr/.pm2/logs/project-board-site-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/opt/homebrew/Cellar/node/25.4.0/bin/node /Users/jtr/.openclaw/workspace/projects/project-board-site/server.cjs`

## regina-jtr
- source: predisaster-60
- status/restarts at backup: stopped / 1
- cwd: /Users/jtr/_JTR23_/cosmo-home/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/engine/src/index.js (exists)
- interpreter: node
- node_args: `['--expose-gc', '--max-old-space-size=2048']`
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-jtr-out-35.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-jtr-err-35.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home/configs/jtr.yaml, COSMO_DASHBOARD_PORT=3501, COSMO_INSTANCE=coz, COSMO_REALTIME_PORT=3540, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home/runs/jtr, COSMO_TUI=false, COSMO_TUI_SPLIT=false, DASHBOARD_PORT=3501, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, INSTANCE_ID=cosmo-jtr, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=3540, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/engine/src/index.js`

## regina-jtr-dash
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/engine/src/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-jtr-dash-out-18.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-jtr-dash-err-18.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home/configs/jtr.yaml, COSMO_DASHBOARD_PORT=3501, COSMO_INSTANCE=coz, COSMO_REALTIME_PORT=3540, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home/runs/jtr, COSMO_TUI=false, COSMO_TUI_SPLIT=false, DASHBOARD_PORT=3501, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, INSTANCE_ID=cosmo-jtr-dash, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=3540, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/engine/src/dashboard/server.js`

## regina-mcp
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/engine/mcp/http-server.js (exists)
- interpreter: node
- args: `3510`
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-mcp-out-20.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-mcp-err-20.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, regina-mcp={}, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/engine/mcp/http-server.js 3510`

## regina-terrapin
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/engine/src/index.js (exists)
- interpreter: node
- node_args: `['--expose-gc', '--max-old-space-size=2048']`
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-terrapin-out-36.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-terrapin-err-36.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home/configs/terrapin.yaml, COSMO_DASHBOARD_PORT=3509, COSMO_INSTANCE=coz, COSMO_REALTIME_PORT=3547, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home/runs/terrapin, COSMO_TUI=false, COSMO_TUI_SPLIT=false, DASHBOARD_PORT=3509, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, INSTANCE_ID=cosmo-terrapin, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=3547, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/engine/src/index.js`

## regina-terrapin-dash
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home/engine (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/engine/src/dashboard/server.js (exists)
- interpreter: node
- node_args: `['--max-old-space-size=1792']`
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-terrapin-dash-out-37.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-terrapin-dash-err-37.log
- selected env: `COSMO_CONFIG_PATH=/Users/jtr/_JTR23_/cosmo-home/configs/terrapin.yaml, COSMO_DASHBOARD_PORT=3509, COSMO_INSTANCE=coz, COSMO_REALTIME_PORT=3547, COSMO_RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home/runs/terrapin, COSMO_TUI=false, COSMO_TUI_SPLIT=false, DASHBOARD_PORT=3509, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, INSTANCE_ID=cosmo-terrapin-dash, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, REALTIME_PORT=3547, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/engine/src/dashboard/server.js`

## regina-tile-dash
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/_JTR23_/cosmo-home/dashboard (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-tile-dash-out-19.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-tile-dash-err-19.log
- selected env: `COSMO_INSTANCE=coz, COSMO_PORT=3501, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/dashboard/server.js`

## regina-voice
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home/voice (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/voice/server.js (exists)
- interpreter: node
- out: /Users/jtr/_JTR23_/cosmo-home/logs/regina-voice-out-38.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/regina-voice-err-38.log
- selected env: `COSMO_BRAIN_PATH=/Users/jtr/_JTR23_/cosmo-home/engine/../runs/jtr, COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_URL=http://192.168.6.205:11434, OPENCLAW_GATEWAY_PORT=18789, PORT=3570, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/voice/server.js`

## shakedown-agent
- source: predisaster-60
- status/restarts at backup: online / 2
- cwd: /Users/jtr/.openclaw/workspace/agents/shakedown (exists)
- script: /Users/jtr/.openclaw/workspace/agents/shakedown/bin/shakedown-agent.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/shakedown-agent-out.log
- err: /Users/jtr/.pm2/logs/shakedown-agent-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/.openclaw/workspace/agents/shakedown/bin/shakedown-agent.js`

## shakedown-audio-static
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/shakedownshuffle.com/html (exists)
- script: /opt/homebrew/opt/caddy/bin/caddy (exists)
- interpreter: none
- args: `file-server --listen 127.0.0.1:18089 --root /Volumes/Althea/Jerry/audio`
- out: /Users/jtr/.pm2/logs/shakedown-audio-static-out.log
- err: /Users/jtr/.pm2/logs/shakedown-audio-static-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OLLAMA_HOST=0.0.0.0, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `none /opt/homebrew/opt/caddy/bin/caddy file-server --listen 127.0.0.1:18089 --root /Volumes/Althea/Jerry/audio`

## shakedown-dashboard
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/.openclaw/workspace/projects/shakedownshuffle/dashboard (exists)
- script: /Users/jtr/.openclaw/workspace/projects/shakedownshuffle/dashboard/server.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/shakedown-dashboard-out.log
- err: /Users/jtr/.pm2/logs/shakedown-dashboard-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/.openclaw/workspace/projects/shakedownshuffle/dashboard/server.js`

## shakedown-image-filter
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/.openclaw/workspace (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/scripts/shakedown-filter-cron.js (exists)
- interpreter: node
- out: /Users/jtr/.pm2/logs/shakedown-image-filter-out.log
- err: /Users/jtr/.pm2/logs/shakedown-image-filter-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/scripts/shakedown-filter-cron.js`

## shore-collectibles
- source: predisaster-60
- status/restarts at backup: online /
- cwd: /Users/jtr/websites/shorecollectiblesnj.com/html (exists)
- script: /Users/jtr/.nvm/versions/node/v22.19.0/bin/npm (exists)
- interpreter: /Users/jtr/.nvm/versions/node/v22.19.0/bin/node
- args: `start`
- out: /Users/jtr/.pm2/logs/shore-collectibles-out.log
- err: /Users/jtr/.pm2/logs/shore-collectibles-error.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, PORT=3847, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `/Users/jtr/.nvm/versions/node/v22.19.0/bin/node /Users/jtr/.nvm/versions/node/v22.19.0/bin/npm start`

## terrapin-feeder
- source: predisaster-60
- status/restarts at backup: stopped /
- cwd: /Users/jtr/_JTR23_/cosmo-home/feeder (exists)
- script: /Users/jtr/_JTR23_/cosmo-home/feeder/server.js (exists)
- interpreter: node
- node_args: `['--max-old-space-size=2048']`
- out: /Users/jtr/_JTR23_/cosmo-home/logs/terrapin-feeder-out-41.log
- err: /Users/jtr/_JTR23_/cosmo-home/logs/terrapin-feeder-err-41.log
- selected env: `COSMO_INSTANCE=coz, COSMO_TUI=false, COSMO_TUI_SPLIT=false, EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1, ENGINE_PORT=4651, FEEDER_CONFIG=terrapin-feeder.yaml, HOME_PORT=4611, MCP_HTTP_PORT=4650, MCP_PORT=4650, NODE_APP_INSTANCE=0, NODE_ENV=production, OPENCLAW_GATEWAY_PORT=18789, RUNTIME_DIR=/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz, cosmo23-coz={}, instance_var=NODE_APP_INSTANCE, source_map_support=true`
- command hint: `node /Users/jtr/_JTR23_/cosmo-home/feeder/server.js`
