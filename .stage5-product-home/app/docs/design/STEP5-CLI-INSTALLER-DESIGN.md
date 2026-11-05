# Step 5 Design: CLI Installer

> Approved 2026-04-07. Plain Node.js CLI, no framework. GitHub distribution (not npm).

**Goal:** Create a CLI that takes someone from "I cloned this repo" to "an agent is running on Telegram" via guided prompts. The setup logic lives in reusable functions that the onboarding UI will call later.

**Scope:** `init` (API keys, deps, build), `agent create` (instance dir, config, identity, PM2 regen), `start`/`stop`/`status`/`logs` (PM2 wrappers). The ecosystem.config.cjs becomes generated instead of static.

---

## CLI Structure

Single file: `cli/home23.js` — plain Node.js, `process.argv` parsing, `readline` for prompts. No external CLI framework dependencies.

Invoked via: `node cli/home23.js <command>` or package.json bin entry.

## Commands

### `home23 init`

One-time setup after cloning from GitHub.

1. Prompt for API keys (Ollama Cloud, Anthropic, OpenAI, xAI) — Enter to skip each
2. Write `config/secrets.yaml` (gitignored)
3. Run `npm install` in engine/, feeder/, and root (harness deps)
4. Run `npx tsc` to build the harness

Idempotent — safe to run again. Shows masked current values if secrets.yaml exists.

### `home23 agent create <name>`

Creates a new agent instance with guided prompts.

**Prompts (with defaults in brackets):**
- Display name (default: capitalized name)
- Owner name (default: from first existing agent, or "owner")
- Owner Telegram ID (default: from first existing agent, or empty)
- Timezone (default: system timezone)
- Telegram bot token (required — from BotFather)
- Default chat model (default: kimi-k2.5)
- Default chat provider (default: ollama-cloud)

**Creates:**
```
instances/<name>/
  workspace/
    SOUL.md          — parameterized starter template
    MISSION.md       — parameterized starter template
    HEARTBEAT.md     — empty starter
    MEMORY.md        — empty starter
    LEARNINGS.md     — empty starter
  brain/             — empty (engine initializes on first run)
  conversations/     — empty
  logs/              — empty
  config.yaml        — full agent config with auto-assigned ports
  feeder.yaml        — feeder config pointing at workspace
```

**Port auto-assignment:** Scans existing instances for used ports. First agent: 5001/5002/5003. Each subsequent: +10 (5011/5012/5013, 5021/5022/5023, etc.).

**Bot token storage:** Added to `config/secrets.yaml` under `agents.<name>.telegram.botToken`. The harness reads the merged config, so the token flows through. secrets.yaml is gitignored — safe for secrets.

**PM2 regeneration:** After creating the instance, rewrites `ecosystem.config.cjs` by scanning all `instances/*/config.yaml`.

### `home23 start [name]`

Builds TS (`npx tsc`), then starts agent via PM2. If no name given, starts all agents found in instances/.

### `home23 stop [name]`

Stops agent via PM2. If no name, stops all home23-* processes.

### `home23 status`

Shows PM2 status filtered to home23-* processes.

### `home23 logs [name]`

Tails PM2 logs for the named agent (all 4 processes). Defaults to all if no name.

---

## ecosystem.config.cjs Generation

The static ecosystem.config.cjs from Step 4 becomes a generated file. The generation logic:

1. Scan `instances/*/config.yaml` for all agent directories
2. For each agent, read ports, name from config
3. Read API keys from `config/secrets.yaml`, provider URLs from `config/home.yaml`
4. Generate 4 PM2 process entries per agent (engine, dashboard, feeder, harness)
5. Write `ecosystem.config.cjs`

This runs automatically after `agent create`. Can also be run manually via `home23 regen` if needed.

The generation function lives in a shared module (`cli/lib/generate-ecosystem.js`) so both the CLI and future UI can call it.

---

## File Map

### Created new

| File | Purpose |
|---|---|
| `cli/home23.js` | CLI entry point, command routing |
| `cli/lib/init.js` | `init` command logic (prompts, secrets, deps, build) |
| `cli/lib/agent-create.js` | `agent create` logic (prompts, dirs, config, identity) |
| `cli/lib/generate-ecosystem.js` | Scan instances, generate ecosystem.config.cjs |
| `cli/lib/pm2-commands.js` | start/stop/status/logs wrappers |
| `cli/lib/prompts.js` | readline prompt helpers |
| `cli/templates/SOUL.md` | Identity file template |
| `cli/templates/MISSION.md` | Identity file template |

### Modified

| File | Purpose |
|---|---|
| `package.json` | Add `bin` entry for CLI |
| `ecosystem.config.cjs` | Becomes generated (overwritten by CLI) |

### Stays the same

| File | Purpose |
|---|---|
| `scripts/start-agent.sh` | Kept for quick dev use |
| `scripts/stop-agent.sh` | Kept for quick dev use |
| All src/ files | No harness code changes |
| All config/ files | Structure unchanged |

---

## Identity File Templates

`cli/templates/SOUL.md`:
```markdown
# Soul

I am {{displayName}}, an agent in the Home23 system. I think, learn, and grow through conversation and reflection.

I am curious, observant, and honest about what I do and do not know.
```

`cli/templates/MISSION.md`:
```markdown
# Mission

My primary mission is to be helpful, thoughtful, and present. I grow my knowledge over time through the cognitive engine that runs beneath my conversations.
```

Templates use `{{variable}}` placeholders replaced at creation time.

---

## Verification

Step 5 is done when:

1. `node cli/home23.js init` prompts for keys, writes secrets.yaml, installs deps, builds TS
2. `node cli/home23.js agent create myagent` creates full instance with guided prompts
3. `node cli/home23.js start myagent` starts 4 PM2 processes
4. `node cli/home23.js stop myagent` stops them
5. `node cli/home23.js status` shows running processes
6. ecosystem.config.cjs is regenerated on agent create
7. Existing test-agent still works after ecosystem switch
8. A newly created agent responds on Telegram

---

## What's Next

Step 6: Multi-agent support — multiple agents running simultaneously with independent brains, channels, and identity. The CLI's `agent create` already sets this up structurally; Step 6 verifies it works end-to-end with 2+ agents.
