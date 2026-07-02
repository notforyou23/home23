# Home23 v1.0 Onboarding Hardening Receipt

Date: 2026-07-02
Implementation reference: `v1.0.0` tag target
Release tag: `v1.0.0`

## Objective

Make the Home23 1.0 fresh-install path simple for a nontechnical user: create a personal agent, set its purpose, point it at starter project/import folders, and start cleanly without relying on jtr's local runtime state.

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
- The first-run dashboard wizard is still available when a dashboard process exists, but the documented zero-agent path is now CLI `setup` first, then browser Settings.
- Starter ingestion folders can be ordinary project directories, Claude/Codex exports, notes, reports, or other local folders the user wants watched by the Document Feeder.
