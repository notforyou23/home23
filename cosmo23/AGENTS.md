# AGENTS.md - COSMO 2.3 Strict Playbook

Read this before touching the repo.

## Startup Rules

1. Read [README.md](cosmo23/README.md) before making assumptions about the standalone surface.
2. If work touches guided runs, read [investigations/cosmo-2.3-master-synthesis.md](cosmo23/investigations/cosmo-2.3-master-synthesis.md) first, then only the supporting investigation files needed for the task.
3. Verify the current implementation files before editing. Some investigation file references are stale even when the conclusions are still correct.

## Non-Negotiable Safety Rules

- Treat `runs/` as historical evidence. Do not delete, rewrite, or “clean up” run artifacts unless the user explicitly asks.
- Do not mutate archived plans, archived tasks, or old outputs to make current code easier.
- Do not deploy, sync, or restart any external environment from this repo unless the user explicitly asks.
- Prefer additive metadata and guards over destructive state changes.
- If a guided-run fix would change autonomous mode behavior, isolate it so autonomous runs still work.

## What COSMO 2.3 Is

COSMO 2.3 is the standalone carve-out:

- `server/index.js` is the standalone web app and launch API.
- `launcher/` is the standalone config/process wrapper.
- `engine/src/` is the actual runtime: planner, orchestrator, agents, dashboard, memory, coordinator.
- `public/` is the standalone launcher/watch/query frontend.

The wrapper is not the engine. Guided-run behavior changes usually belong in `engine/src/`, not only in the standalone server.

## Primary Edit Surfaces

- Guided planning: [engine/src/core/guided-mode-planner.js](cosmo23/engine/src/core/guided-mode-planner.js)
- Runtime loop and spawn paths: [engine/src/core/orchestrator.js](cosmo23/engine/src/core/orchestrator.js)
- Strategic coordination and tier spawning: [engine/src/coordinator/meta-coordinator.js](cosmo23/engine/src/coordinator/meta-coordinator.js)
- Agent result integration and follow-ups: [engine/src/agents/agent-executor.js](cosmo23/engine/src/agents/agent-executor.js)
- Research handoff/output generation: [engine/src/agents/research-agent.js](cosmo23/engine/src/agents/research-agent.js)
- Agent startup context: [engine/src/agents/ide-agent.js](cosmo23/engine/src/agents/ide-agent.js)
- Introspection ingestion: [engine/src/system/introspection.js](cosmo23/engine/src/system/introspection.js)
- Standalone launch normalization: [server/index.js](cosmo23/server/index.js), [launcher/config-generator.js](cosmo23/launcher/config-generator.js), [public/index.html](cosmo23/public/index.html), [public/app.js](cosmo23/public/app.js)

## Ports And Runtime Facts

- App: `43110`
- WebSocket: `43140`
- Watch dashboard: `43144`
- MCP HTTP: `43147`

Primary runtime paths:

- Local runs: [runs](cosmo23/runs)
- Active runtime link: [runtime](cosmo23/runtime)
- Investigation corpus: [investigations](cosmo23/investigations)

## External / merged run guardrail

For external or merged runs (example: `runs/merged-jgscrapes`), do not assume dashboard/MCP surfaces are pointed at the correct run just because the run itself is live.

Verify all three when diagnosing a "blank slate" or false-zero report:

1. MCP runtime path (`COSMO_RUNTIME_DIR` for the MCP HTTP server)
2. Dashboard runtime path (`COSMO_RUNTIME_DIR` for the dashboard server)
3. Route handling for `current` / `runtime` so those aliases resolve to the actual active run dir rather than a bogus default folder

A live run can be healthy on disk while dashboard/intelligence surfaces still report cycle 0 / zero nodes if any of the above are miswired.

## Current Architectural Priorities

Default to these unless the user explicitly says otherwise:

1. Guided runs are exclusive. No autonomous discovery or autonomous slot reservation during guided execution.
2. Planner decisions must be brain-informed once prior findings exist.
3. Continuation belongs to the guided planner, not a separate fallback generator.
4. Spawn-time dedup must happen before new agents launch.
5. Research outputs must be surfaced forward through digests and handoffs, not left in flat files.
6. UI copy must not imply `strict/mixed/advisory` still matters for guided launches.

## Cross-Agent Safety (iOS App / External Agents)

- If an iOS app shares this backend, agents working on the iOS app may modify backend files here.
- **Two GPT5Client files exist:** `lib/gpt5-client.js` (query engine, web app) and `engine/src/core/gpt5-client.js` (engine runtime). They are independent — changes to one do not propagate to the other. Both must stay compatible with code that sets `.client` directly (e.g., xAI Responses client init in `lib/query-engine.js`).
- After any backend modification by an external agent, verify queries work across all providers: OpenAI (`gpt-5.2`), xAI (`grok-4.20-0309-reasoning`), Anthropic (`claude-sonnet-4-6`), and local models.
- Do not convert simple instance properties to getter-only accessors without checking all call sites — other code may assign to them directly.

## Editing Guidance

- Use the master synthesis as the policy target, but verify every change against current code.
- Prefer small helper functions over scattered conditionals when normalizing guided behavior.
- Preserve backward compatibility at API boundaries when feasible, but normalize old inputs to current semantics internally.
- Add tests when changing planner/orchestrator behavior. Guided-run regressions are easy to reintroduce silently.
