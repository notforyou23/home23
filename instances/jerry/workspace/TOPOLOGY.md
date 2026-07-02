# House Topology

Root: `/Users/jtr/_JTR23_/release/home23`

Core services
- 5001 Engine WebSocket (`home23-jerry`)
- 5002 Dashboard HTTP/API (`home23-jerry-dash`; `/home23`, `/api/live-problems`, `/api/good-life`)
- 5003 MCP Server (embedded in `home23-jerry`)
- 5004 Evobrew Bridge (`home23-jerry-harness`)
- 3415 Evobrew IDE (`home23-evobrew`, shared)
- 43210 COSMO 2.3 Research (`home23-cosmo23`, shared)
- 8090 Home23 Dashboard (Node/Express, pm2 `home23-dashboard`; replaced Python docs on 2026-04-14)
- URLs: http://100.72.171.58:8090 | http://localhost:5002/home23 | http://localhost:3415

Runtime
- `instances/jerry/` holds workspace/brain/conversations
- Cron jobs: `instances/jerry/conversations/cron-jobs.json`; logs: `instances/jerry/conversations/cron-runs/`
- Scheduler cmds: `schedule list delete enable disable update`
- Jobs persist across restarts; exec jobs run from project root unless `cwd` overrides
- Durable delivery IDs required (Telegram numeric, Discord channel)
- jtr Telegram DM: `8317115546`
- Discord guild: `1480393008791818474`
- Timezone: America/New_York (ET)
- Confirmed: 2026-04-28

iOS app (Home23)
- Xcode: `/Users/jtr/xCode_Builds/Home23/`
- Bundle: `com.regina6.home23`
- Connects via Tailscale to bridge port 5004
- APNs key: `~/secrets/AuthKey_W2N4N6UGYS.p8`

Brain/runtime constraints
- Good Life governance live 2026-05-01; brain files in `instances/jerry/brain/`; engine good-life files in `engine/src/good-life/`
- Telemetry is governance evidence, not personal diagnosis
- `localhost:5002` brain has no `/health`; verify correct health endpoint
- If brain is unavailable, operate reduced-context; core tools/research/shell/web still work
- OpenAI required for core embeddings; Ollama optional except home23 requires Ollama embedding
- Duplicate same-role agent or PM2/script mismatch is suspicious

Distributed nodes
- Pi (`jtrpi`): use mDNS, not raw IP; `jtrpi.local` / `192.168.4.63`; SSH `ssh pi` or `ssh jtr@jtrpi.local`; Tailscale `100.72.171.59`; `jerry-node.service` user systemd, lingering, enabled, reboot-proof; agent `~/.jerry-node/bin/node-agent.py` v2; state `~/.jerry-node/state/` (`ticks.jsonl`, `node-state.json`); queue `~/.jerry-node/work/` -> `~/.jerry-node/work-output/`; pulse bridge `pi-node-bridge` logs to `brain/pi-node-pulses.jsonl` every 10 min; hw 4-core ARM, 8GB RAM, 76G disk, Python 3.13, Node 22
- iMac (Regina): `ssh imac` (`192.168.6.248`; `HostKeyAlgorithms=+ssh-rsa`, `KexAlgorithms=diffie-hellman-group1-sha1`); macOS 10.10.5 Yosemite, x86_64, 2 cores, 4 GB RAM, 931 GB disk (662 GB free), Python 2.7 only; launchd `com.jerry.node-agent` (KeepAlive, RunAtLoad, 300s interval), agent v3; body ALIVE with state server on 8766 serving room context, vision tracking, voice listening, heartbeat/health score; services: `regina-state-server`, `regina-vision-tracker`, `regina-voice-listener`, `regina-voice-reactor`, `regina-room-observer`, `regina-recognizer`, `regina-face-watchdog`; bridge `imac-node-bridge` cron pulls pulses + room + vision state every 10 min

Empire network
- `scripts/empire-dispatch.sh <node> <action> [args]` sends commands from the mini
  - iMac actions: say, display, browse, ear-capture, status
  - Pi actions: status, cortex-query
- Cross-node execution: mini → iMac MQ (`192.168.6.248:9879`) → iMac task-worker → screen display + result back to Pi MQ
- iMac speak: POST `http://192.168.6.248:8766/api/say` `{"text":"..."}` -> macOS `say`
- iMac hear: POST `http://192.168.6.248:8766/api/record-ear` -> 6s m4a clip
- iMac live state: GET `http://192.168.6.248:8766/api/live`
- Pi latest sensor API: GET `http://192.168.4.63:8765/api/latest`
- Pi cortex-mq: POST `http://192.168.4.63:9878/mq/send`
- Empire status: `scripts/empire-status.sh` -> `brain/empire-status.json` (cron every 10 min)
- Empire think: `scripts/empire-think.py` -> `brain/empire-thoughts.jsonl` (cron every 10 min)
- Empire speak: `scripts/empire-speak.sh` (cron every 10 min)
- Empire dashboard: `scripts/empire-server.py` (PM2 `empire-dashboard`, port 5013) -> http://localhost:5013; also opened on iMac Safari
- iMac task-worker IP fixed from stale `192.168.7.136` to `192.168.4.63` on 2026-06-24
- Pi sensor altitude/pressure bug patched with `abs()` to avoid complex values on 2026-06-24