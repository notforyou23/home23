# Step 8: Evobrew Integration Design

**Date:** 2026-04-07
**Status:** Approved

## Summary

Package evobrew (AI IDE with Brain Studio, query engine, graph explorer, terminal, multi-provider chat) into Home23 as a bundled component. One shared evobrew process serves all agents. Config is auto-generated from Home23's existing sources of truth. Dashboard button opens evobrew in a new tab, pre-wired to the selected agent's brain and chat bridge.

## 1. Packaging

Evobrew source lives at `Home23/evobrew/` as a committed directory. It ships with the repo and works on any machine (Mac, Pi, etc.).

- `evobrew/node_modules/` is gitignored. Everything else is committed.
- `home23 init` installs evobrew's npm dependencies alongside the rest of Home23.
- `home23 evobrew update` pulls the latest from evobrew's GitHub repo (downloads tarball, extracts, replaces files, reinstalls deps if package.json changed). No git submodules, no symlinks. The user never touches git for this.

### Directory Structure

```
Home23/
  evobrew/                  <- Committed evobrew source
    server/                 <- Express + WebSocket backend
    public/                 <- Single-page IDE UI
    lib/                    <- Config, query engine, utilities
    bin/                    <- CLI entry point (unused in Home23 context)
    node_modules/           <- Gitignored, installed by home23 init
    .evobrew-config.json    <- Auto-generated, gitignored
  ...
```

## 2. Process Architecture

One shared evobrew process at the home level (not per-agent):

| Process | Script | Purpose | Port |
|---|---|---|---|
| `home23-evobrew` | `evobrew/server/server.js` | AI IDE server | Configurable (default 3405) |

Added to `ecosystem.config.cjs` alongside the per-agent processes.

Every agent is registered as a `local:` provider in evobrew's config. The model dropdown shows `local:test-agent`, `local:cosmo`, etc. The user picks which agent to talk to from the dropdown — standard evobrew UX.

## 3. Config Auto-Generation

On startup, Home23 generates `Home23/evobrew/.evobrew-config.json` from existing sources of truth:

- **API keys** from `config/secrets.yaml` (Anthropic, OpenAI, xAI, Ollama)
- **Local agents** from scanning `instances/` — each agent becomes a `local:<name>` provider pointing at that agent's harness bridge endpoint (`http://localhost:<harness-webhook-port>/api/chat`)
- **Default brain path** set to the first agent's `instances/<agent>/brain/` (alphabetical by instance directory name)

Config is regenerated on every start. Adding a new agent via `home23 agent create` automatically appears in evobrew on next restart. No manual config needed.

This config is local to the Home23 instance (not `~/.evobrew/config.json`) so multiple installs don't collide. Evobrew is pointed at it via environment variable or CLI flag.

API keys are plaintext in the generated config since it's local-only and gitignored. Home23's `secrets.yaml` is already the secure store.

## 4. Brain Auto-Connect

On launch, evobrew auto-loads the first agent's brain (alphabetical by instance directory) from `instances/<agent>/brain/state.json.gz`. Query tab and Explore tab are populated immediately — no manual "Connect Brain" step.

The brain picker button still works for:
- Switching to other agents' brains (`instances/<other-agent>/brain/`)
- Loading external `.brain` packages (same as today)

When opened with `?agent=<name>`, evobrew loads that specific agent's brain and selects its `local:<name>` model.

## 5. Dashboard Wiring

The evobrew button already exists in the dashboard HTML (`href="#"` stub, purple accent styling).

Wire it to open `http://localhost:<evobrew-port>/?agent=<agent-name>` in a new tab.

The evobrew port comes from config. The dashboard JS gets it from the dashboard API (which already serves agent config data).

## 6. Bridge Endpoint

The harness already has `src/routes/evobrew-bridge.ts` — an SSE chat handler that runs the agent with full identity (SOUL, MISSION, MEMORY), conversation history, and tools.

Each agent's harness exposes this on its webhook port at `/api/chat`. Evobrew's auto-generated config points each `local:<agent>` provider at the correct port.

### Protocol

Evobrew's `LocalAgentAdapter` sends:
```json
POST http://localhost:<harness-port>/api/chat
Content-Type: application/json
Authorization: Bearer <optional-token>

{
  "messages": [{"role": "user", "content": "..."}],
  "tools": [...],
  "model": "local:<agent>",
  "maxTokens": 64000,
  "temperature": 0.1,
  "systemPrompt": "..."
}
```

Bridge responds with Server-Sent Events:
```
data: {"type": "text", "text": "..."}
data: {"type": "tool_use_start", "toolId": "...", "toolName": "..."}
data: {"type": "tool_use_delta", "argumentsDelta": "..."}
data: {"type": "tool_use_end"}
data: [DONE]
```

Verify request/response format alignment between `LocalAgentAdapter` and `evobrew-bridge.ts` during implementation. Fix any gaps in message shape, tool format, or event types.

## 7. CLI Commands

### New

- `home23 evobrew update` — Downloads latest from evobrew's GitHub repo, replaces files in `Home23/evobrew/`, reinstalls deps if package.json changed.

### Modified

- `home23 init` — Now also runs `npm install` in `Home23/evobrew/`.
- `home23 start [agent]` — Now also starts `home23-evobrew` (if not already running). Generates evobrew config before launch.
- `home23 stop` — Stops evobrew alongside agent processes.
- `home23 status` — Shows evobrew process status.
- `home23 logs evobrew` — Tails evobrew logs.

### No New Config

Everything derives from what Home23 already knows. No setup wizard, no new config files for the user to manage.

## 8. What Already Exists

| Component | Status | Location |
|---|---|---|
| Dashboard evobrew button | Rendered, stub href | `engine/src/dashboard/home23-dashboard.html:34` |
| Button styling (purple accent) | Live | `engine/src/dashboard/home23-dashboard.css:134-143` |
| Bridge route handler (SSE) | Built | `src/routes/evobrew-bridge.ts` |
| Bridge import in harness | Present | `src/home.ts:35` |
| Evobrew local agent adapter | Built (in evobrew) | `evobrew/server/providers/adapters/local-agent.js` |
| Evobrew setup API for agents | Built (in evobrew) | `evobrew/server/server.js:4900-5115` |
| Evobrew brain loader | Built (in evobrew) | `evobrew/server/brain-loader-module.js` |

## 9. What Needs Building

1. Copy evobrew source into `Home23/evobrew/`
2. Config generator — reads home.yaml, secrets.yaml, scans instances, writes `.evobrew-config.json`
3. Evobrew config path override — make evobrew read from `.evobrew-config.json` instead of `~/.evobrew/`
4. Brain auto-connect — evobrew reads default brain path from config on startup
5. `?agent=` query param support — pre-selects model + brain
6. Ecosystem config — add `home23-evobrew` process
7. Dashboard JS — wire button href to evobrew URL
8. CLI `evobrew update` command
9. CLI `init` / `start` / `stop` modifications
10. Protocol verification — align bridge SSE format with LocalAgentAdapter expectations

## 10. Design Principles

- Evobrew is a dependency, not a fork. It stays recognizable as evobrew.
- Config auto-generation means zero manual setup for evobrew.
- One process, all agents. Leverage evobrew's existing multi-provider architecture.
- Brain auto-connect with manual override. Sensible defaults, full flexibility.
- The bridge handler is the integration point. Evobrew talks to agents through it, agents respond with full identity and tools. Evobrew is "just a chat window" — the agent IS the agent.
