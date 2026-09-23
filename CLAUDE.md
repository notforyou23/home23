# Current working instructions

Read `AGENTS.md` and `docs/reference/DEVELOPMENT-WORKFLOW.md` before work. They establish source ownership, concurrent-work handling and release boundaries. The developer reference below does not supersede them.

Upgrade/Host/embedding work follows `docs/design/HOME-UPDATES-AND-PORTABILITY.md`. Its continuity reset supersedes the old product-completion and embedder handoff sequences. Do not treat lifecycle adoption, software delivery and changing an existing encoder as one mandatory migration.

The lead owns review, relevant verification, local commits and integration. Worker restrictions do not remove those responsibilities or create new owner approval requirements. Follow the shared agreement's task record and completion rules, preserving the owner's explicit scope and authorization.

# Home23 Developer Guide

Home23 is an installable AI operating system for persistent local agents. Keep the public repository portable and keep user-specific runtime state outside Git.

## Quick Start

```bash
git clone https://github.com/notforyou23/home23.git
cd home23
node cli/home23.js setup
```

`setup` creates local config, opens the web-guided first-run page, and walks through providers, first personal agent, owner/user facts, purpose, starter ingestion folders, model choice, and launch.

For the older terminal-guided flow:

```bash
node cli/home23.js setup --cli
```

For automation or repeat agent creation, use the lower-level commands:

```bash
node cli/home23.js init
node cli/home23.js agent create <name>
node cli/home23.js start <name>
```

## Repository Shape

- `src/` - TypeScript harness, agent loop, tools, and scheduler.
- `src/substrate/` - Seed-owned surfaces (v2): turn expression, lived RECENT/NOW/facts/identity, the shared semantic matcher, perception-at-contact embedding.
- `substrate/` - the Seed itself (v2): hash-chained ledger, situation cells, metabolism, development rules (including sleep: consolidation + dream), membrane, growth, lobe recruitment, runner, journal, observatory. See `docs/design/HOME23-V2-SUBSTRATE-DESIGN.md`.
- `engine/src/` - engine, dashboard, cognition, memory, live-problem, and sensor modules.
- `engine/src/substrate/` - engine-side Seed readers (cognition grounding, dream day-residue).
- `cli/` - installer, PM2 management, agent creation, updates, and templates.
- Cosmo is a standalone research application reached through its configured API; it is no longer a vendored `cosmo23/` source tree. Read `docs/reference/COSMO-SEPARATION.md` for ownership and cross-product test prerequisites.
- `evobrew/` - optional standalone application retained in source. Consumer Host packages omit it; Home23's chat/device/agency bridge remains in `src/routes/evobrew-bridge.ts`, and saved home state is preserved.
- `config/*.example` - public config seeds.
- `instances/` - generated per-agent runtime state. Ignored by Git.


## The Substrate (v2)

Agents can be given a **Seed** — a persistent computational individual that
metabolizes the agent's actual life (conversations, teachings, worker
outcomes, optionally the home via Home Assistant) into a hash-chained,
fail-closed record and a continuously-developing body of situation cells.
Seed-owned surfaces then compose the agent's memory from the chain at read
time; the v1 files remain only as degraded-honest fallbacks. The observatory
(`substrate/bin/seed-observatory.ts`, port 5050) carries the cutover board:
every migrated function with its live-probed owner.

Substrate law (non-negotiable):

- **Never two live instances of one individual.** The `.runner.lock` in each
  state dir is mechanical and is the authoritative pid registry — to find a
  runner, read its lock; never trust `pgrep`.
- **The chain is never repaired.** A forked or torn chain is archived as
  evidence; restore refuses it. Repairing a hash chain is forging history.
- **Typed deltas only.** No lobe writes state via prose; the membrane and
  the `LOBE_DELTA_ALLOWLIST` are code-review items on every change.
- **Degraded-honest.** Composers return null over fabricating; the organ
  owns a function only while it is actually alive.
- **No manufactured life.** Organic events only. Teaching channels belong to
  the owner; never simulate them.
- **Event-time, never wall clock.** Gaps, freshness windows, sleep, and
  dreams are measured in chain records and event timestamps so replay is
  deterministic.

The substrate suite is `npm run test:substrate` (substrate/tests/). Harness
surface tests live in tests/agent/ (seed-context, lived-recent, seed-now,
lived-facts, lived-identity, triggered-surfaces) and are registered
explicitly in package.json's test list.

## Local State Boundary

Do not commit generated local files:

- `instances/`
- `config/home.yaml`
- `config/targets.yaml`
- `config/cron-jobs.json`
- `config/agents.json`
- `config/secrets.yaml`
- `ecosystem.config.cjs`
- runtime logs, caches, reports, temporary files, generated certs, and private keys

Use `git rm --cached <path>` when a local file is already tracked but must remain on disk.

## Runtime Commands

```bash
node cli/home23.js status
node cli/home23.js logs <name>
node cli/home23.js stop <name>
node cli/home23.js update --check
```

PM2 process names are generated from agent names as `home23-<name>`, `home23-<name>-dash`, `home23-<name>-mcp` (unless `mcp.enabled: false`), `home23-<name>-harness`, and `home23-<name>-seed` (when `substrate.enabled: true`). Lifecycle code must derive an agent's process set from `shared/agent-process-names.cjs`, never a hardcoded triplet.

## Development Checks

Select checks for the changed behavior under the shared agreement. The full suite below requires `COSMO23_SOURCE_ROOT` to identify the standalone Cosmo checkout; report pretest failures separately from tests that never ran.

```bash
npm run build
npm test
npm run test:substrate
npm run test:contracts
```

Use live-contract tests only against a running local instance:

```bash
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```
