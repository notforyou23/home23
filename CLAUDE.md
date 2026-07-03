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
- `engine/src/` - engine, dashboard, cognition, memory, live-problem, and sensor modules.
- `cli/` - installer, PM2 management, agent creation, updates, and templates.
- `cosmo23/` - vendored COSMO 2.3 integration. Read `docs/design/COSMO23-VENDORED-PATCHES.md` before editing.
- `evobrew/` - bundled Evobrew integration.
- `config/*.example` - public config seeds.
- `instances/` - generated per-agent runtime state. Ignored by Git.

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

PM2 process names are generated from agent names as `home23-<name>`, `home23-<name>-dash`, and `home23-<name>-harness`.

## Development Checks

```bash
npm run build
npm test
npm run test:contracts
```

Use live-contract tests only against a running local instance:

```bash
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```
