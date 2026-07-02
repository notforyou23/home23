# Home23 v1.0 Onboarding Hardening Receipt

Date: 2026-07-02
Implementation commit: `1b01f9188cf7d0b05f61a027ed11893d8a5da40b`
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

## Verification

Passed:

```bash
node --check cli/home23.js
node --check cli/lib/setup.js
node --check cli/lib/agent-create.js
node --check cli/lib/init.js
node --check engine/src/dashboard/home23-settings-api.js
node --check engine/src/dashboard/home23-settings.js
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

- `npm test`: 583 tests passed.
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
