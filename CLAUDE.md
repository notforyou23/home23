# Home23 backend: instructions for Claude

`AGENTS.md` is the instruction file for every agent tool in this repository. Read it and `docs/reference/DEVELOPMENT-WORKFLOW.md` before work. This file adds only what `AGENTS.md` does not say.

@AGENTS.md

Upgrade, Host and embedding work follows `docs/design/HOME-UPDATES-AND-PORTABILITY.md`. Its continuity reset supersedes the old product-completion and embedder handoffs.

The lead owns review, verification, local commits and integration. A worker restriction does not create an owner approval requirement.

## Repository shape

- `src/`: TypeScript harness, agent loop, tools, scheduler.
- `src/substrate/`: Seed-owned surfaces: turn expression, lived RECENT/NOW/facts/identity, the shared semantic matcher.
- `substrate/`: the Seed itself: hash-chained ledger, situation cells, metabolism, sleep and dream rules, membrane, growth, runner, journal, observatory. Design: `docs/design/HOME23-V2-SUBSTRATE-DESIGN.md`.
- `engine/src/`: engine, dashboard, cognition, memory, live-problem and sensor modules.
- `cli/`: installer, process management, agent creation, updates, templates.
- `shared/lifecycles.cjs`: the one declaration of each record lifecycle's states and legal moves. See `docs/reference/LIFECYCLES.md`.
- `evobrew/`: optional standalone application kept in source. Consumer Host packages omit it. The bridge lives in `src/routes/evobrew-bridge.ts`.
- Cosmo is a separate application reached through its API. Read `docs/reference/COSMO-SEPARATION.md`.

## Substrate law

- **Never two live instances of one individual.** The `.runner.lock` in each state directory is the pid registry. Read the lock; do not trust `pgrep`.
- **Never repair a chain.** Archive a forked or torn chain as evidence. Repairing a hash chain forges history.
- **Typed deltas only.** No lobe writes state through prose. The membrane and `LOBE_DELTA_ALLOWLIST` are review items on every change.
- **Degraded-honest.** A composer returns null rather than fabricate. An organ owns a function only while it is alive.
- **No manufactured life.** Organic events only. Teaching channels belong to the owner; never simulate them.
- **Event time, never wall clock.** Gaps, freshness, sleep and dreams are measured in chain records so replay is deterministic.

## Persistence is the dangerous code

`engine/src/core/orchestrator.js` saveState and loadState, `state-compression.js`, `memory-sidecar.js` and `brain-snapshot.js` can erase a resident's brain.

1. Trace the full path before you edit.
2. Run a standalone load test against the real brain files. Confirm the node count matches the snapshot.
3. Only then restart, one engine at a time.
4. After the restart, confirm the "Memory loaded" count in the engine log. If it reads 0, stop the engine at once.

A graceful stop saves state. If a load failed, a graceful stop can write an empty brain over a good one.

## Process names

Process names are generated from agent names: `home23-<name>`, `-dash`, `-mcp`, `-harness`, `-seed`. Lifecycle code derives the set from `shared/agent-process-names.cjs`. Never hardcode the list.

## Product rules the owner has stated

- A control does exactly one visible thing. No hidden sweep or overlay may change a value the interface shows. The chat model dropdown changes the chat session only.
- A surface that reports a problem must give the owner a control that changes state and returns a real result.
- Do not add an approval step the owner did not ask for. Residents have standing local authority to work on and repair Home23. Verification, receipts and rollback are the safety mechanism.
- Do not re-enable an engine feeder without checking why it is off.
- Never run `yaml.dump()` on a hand-maintained config file; it deletes the comments.

## Checks

```sh
npm run build
npm test
npm run test:substrate
npm run test:contracts
```

The full suite needs `COSMO23_SOURCE_ROOT` set to the standalone Cosmo checkout. Report a failed pretest separately from tests that never ran. Run `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` only against a running local instance.
