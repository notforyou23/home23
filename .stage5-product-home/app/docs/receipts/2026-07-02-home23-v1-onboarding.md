# Home23 v1.0 Onboarding Hardening Receipt

Date: 2026-07-02
Implementation reference: `v1.0.0` tag target
Release tag: `v1.0.0`

## Objective

Make the Home23 1.0 fresh-install path simple for a nontechnical user: connect providers, create a personal agent, tell it who the user is, set its purpose, point it at starter project/import folders, choose a model, and start cleanly without relying on jtr's local runtime state.

## Changes

- Added `node cli/home23.js setup` as the guided first-run command.
- Updated `init` final guidance so fresh installs create an agent before trying to start the dashboard.
- Extended CLI and dashboard agent creation with:
  - agent purpose
  - starter project folders for ingestion
  - `MISSION.md`, `PROJECTS.md`, and `RECENT.md` seed content that records those choices
- Updated the dashboard agent roster/edit form so purpose is visible and editable.
- Updated README and `docs/ONBOARDING.md` to make the true first-run order explicit.
- Added settings-router coverage proving dashboard-created agents persist purpose, starter feeder watch paths, and mission updates.

## Second-Pass Hardening

- Updated `AGENTS.md`, `CLAUDE.md`, and `docs/MANIFEST.md` so assistant/operator docs point to `setup` first and no longer imply generated local files ship in the public repo.
- Fixed CLI-created first agents to persist `home.primaryAgent` in local `config/home.yaml`, matching the dashboard-created-agent path.
- Fixed first-agent port generation so `ports.bridge` is set to `5004` instead of `undefined`.
- Hardened `node cli/home23.js start <agent>` so missing/invalid agents and PM2 start failures exit nonzero instead of printing a misleading success message.
- Added CLI onboarding regression coverage for fresh purpose capture, starter project/Claude-style import folders, primary-agent config, generated PM2 metadata, complete first-agent ports, and existing-install primary-agent auto-heal.

## Web-First Onboarding Hardening

- Changed `node cli/home23.js setup` to run initialization and then open a browser-based first-run page at `/home23/setup` on a temporary local setup server.
- Kept the terminal-guided path available as `node cli/home23.js setup --cli`.
- Added a setup checklist covering system prepared, provider connected, agent identity, user context, project imports, and live launch.
- Made the setup page a true first-run flow: provider OAuth/API key setup, personal agent creation, owner name, up-front user facts, purpose, project/import folders, model choice, and launch.
- Confirmed provider/model coverage in the setup flow for Anthropic OAuth, OpenAI Codex OAuth, OpenAI API, Ollama Cloud, MiniMax, xAI, and fallback Anthropic API key access.
- Stored dashboard-created user facts into the agent config and `PERSONAL.md`, matching the CLI-created personal-context surface.
- Enabled memory search by default for dashboard-created agents, matching CLI-created agent behavior.
- Added `/home23/setup` as a direct web route and pointed the zero-agent welcome page at it.
- Updated README, `docs/ONBOARDING.md`, `AGENTS.md`, and `CLAUDE.md` so fresh users and future agents start from the web-guided setup path.

## Verification

Passed:

```bash
node --check cli/home23.js
node --check cli/lib/setup.js
node --check cli/lib/agent-create.js
node --check cli/lib/pm2-commands.js
node --check cli/lib/init.js
node --check engine/src/dashboard/home23-settings-api.js
node --check engine/src/dashboard/home23-settings.js
node --check engine/src/dashboard/server.js
node --check tests/engine/cli-onboarding.test.js
node --test --test-concurrency=1 tests/engine/cli-onboarding.test.js
node --test --test-concurrency=1 tests/engine/dashboard/vibe-image-settings.test.js
node --import tsx --test --test-concurrency=1 tests/agent/good-life-identity.test.ts
npm run build
npm test
npm run test:contracts
npm run test:contracts:live
node cli/home23.js help
node cli/home23.js status
```

Key receipts:

- `npm test`: 585 tests passed.
- `npm run test:contracts`: 12 passed, 1 skipped live placeholder.
- `npm run test:contracts:live`: read-only live routes checked; action-writing probes stayed skipped because `HOME23_LIVE_CONTRACTS_ACTIONS` was not enabled.
- Live dashboard `/home23/api/settings/agents` returned `agentCount=2` and confirmed the primary agent roster now includes the `purpose` field.
- Browser QA captured the settled setup flow at `output/playwright/home23-onboarding/01-setup-provider-fixed2.png`, `output/playwright/home23-onboarding/02-create-agent.png`, and `output/playwright/home23-onboarding/03-model-choice.png`.

## Live State

After code changes, only the dashboard process that loads the settings API was restarted:

```bash
pm2 restart home23-jerry-dash --update-env
```

Post-restart checks:

- Home23-family PM2 processes were online.
- Jerry `/api/state` responded at cycle `37826` with `126338` memory nodes.
- COSMO23 `/api/status` was reachable and idle: `running=false`, `lifecycle=idle`, `activeRun=false`.

## Notes

- No live `instances/` data was deleted or reset.
- The first-run dashboard wizard is now also a direct setup page. The documented zero-agent path is CLI `setup`, then browser `/home23/setup`, then launch.
- Starter ingestion folders can be ordinary project directories, Claude/Codex exports, notes, reports, or other local folders the user wants watched by the Document Feeder.
