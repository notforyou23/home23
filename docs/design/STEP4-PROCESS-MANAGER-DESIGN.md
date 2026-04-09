# Step 4 Design: Process Manager + System Service

> Approved 2026-04-07. Approach: PM2 with static ecosystem.config.cjs.

**Goal:** Replace the bash start/stop scripts as the primary way to run Home23 with PM2 process management. Auto-restart on crash, centralized logging, boot persistence via `pm2 startup`.

**Scope:** Create ecosystem.config.cjs for the 4-process test-agent architecture. Add PM2 npm scripts. Keep bash scripts for quick dev use. Add boot persistence instructions.

---

## PM2 Process Configuration

Create `ecosystem.config.cjs` at repo root with 4 process entries for test-agent:

| PM2 process name | Script | Purpose |
|---|---|---|
| `home23-test-agent` | `engine/src/index.js` | Cognitive engine (WS port 5001) |
| `home23-test-agent-dash` | `engine/src/dashboard/server.js` | Dashboard HTTP API (port 5002) |
| `home23-test-agent-feeder` | `feeder/server.js` | File watcher + embedder |
| `home23-test-agent-harness` | `dist/home.js` | TS harness (Telegram, tools, LLM) |

### Env var strategy

- **Engine + Dashboard + Feeder**: env vars in ecosystem.config.cjs (same vars as start-agent.sh). Read paths at config-file-load time using JS.
- **Harness**: only needs `HOME23_AGENT=test-agent` — it reads everything else from Home23 YAML config directly.
- **API keys**: loaded from `config/secrets.yaml` by a small inline YAML reader in the ecosystem config. Never hardcoded in the ecosystem file itself.

### Process settings

All processes get:
- `autorestart: true`
- `watch: false`
- `merge_logs: true`
- Per-process log files in `instances/test-agent/logs/`
- `max_memory_restart: '900M'` for engine (can be memory-hungry)
- `node_args: '--expose-gc'` for engine

### Start order

PM2 doesn't guarantee start order, but:
- Engine and dashboard start first (no `wait_ready` needed — they're resilient)
- Feeder is independent
- Harness has reconnection logic for engine WS and will retry if dashboard isn't ready

The harness's `EngineEventListener` already has reconnect logic. The brain tools fail gracefully if the dashboard isn't up yet. No explicit dependency ordering needed — all processes are resilient to temporary unavailability.

---

## What Changes

### Created new
| File | Purpose |
|---|---|
| `ecosystem.config.cjs` | PM2 process configuration |

### Modified
| File | Purpose |
|---|---|
| `package.json` | Add PM2 npm scripts (`pm2:start`, `pm2:stop`, `pm2:logs`, `pm2:restart`) |
| `.gitignore` | Add PM2 log files if needed |

### Stays the same
- `scripts/start-agent.sh` and `scripts/stop-agent.sh` — kept for quick dev use
- All source code — no TS or JS changes
- All config files — no YAML changes

---

## npm scripts

```json
{
  "scripts": {
    "build": "tsc",
    "pm2:start": "npm run build && pm2 start ecosystem.config.cjs",
    "pm2:stop": "pm2 stop ecosystem.config.cjs",
    "pm2:restart": "npm run build && pm2 restart ecosystem.config.cjs",
    "pm2:logs": "pm2 logs --lines 50",
    "start:test-agent": "bash scripts/start-agent.sh test-agent"
  }
}
```

---

## Boot Persistence

After first successful `pm2 start`:
```bash
pm2 save
pm2 startup
```

This generates a launchd plist (Mac) or systemd unit (Linux) that starts PM2 on boot, which in turn starts all saved processes.

---

## Verification

Step 4 is done when:

1. `npm run pm2:start` starts all 4 processes
2. `pm2 status` shows all 4 as "online"
3. `pm2 logs home23-test-agent-harness` shows Telegram polling
4. Kill a process manually — PM2 auto-restarts it
5. `npm run pm2:stop` stops all 4
6. `pm2 save && pm2 startup` sets up boot persistence
7. Agent responds on Telegram via PM2 (same as via bash scripts)

---

## What's Next

Step 5: CLI installer — `npx home23 init` to create a new Home23 installation, `npx home23 agent create` to add agents.
