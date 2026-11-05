# Step 22: Update System — One Command, Full Lifecycle

**Date:** 2026-04-13
**Status:** Design approved, ready for implementation

## Problem

Home23 has no update mechanism. Users who cloned the repo have no way to get new code, run migrations, or update bundled dependencies (evobrew, cosmo23) without manually performing 7+ steps. Separate `home23 evobrew update` and `home23 cosmo23 update` commands exist but treat the bundled systems as independent, which they're not — they ship with the repo.

There is no version tracking, no changelog, no migration system, and no way for the dashboard to notify users that an update is available.

## Design Principle

**One command updates everything.** `home23 update` handles git pull, dependency installation, TypeScript rebuild, migrations, config regeneration, and process restarts. Evobrew and cosmo23 are fully bundled — they update when the repo updates. No separate update paths.

## Section 1: The `home23 update` Command

```
home23 update           # Full update: pull, build, migrate, restart
home23 update --check   # Just check if an update is available
```

### Full Update Flow

1. **Check for updates** — `git fetch origin --tags`. Compare local `package.json` version against latest `v*` tag. If already up to date, report and exit.

2. **Show what's coming** — Display current version, target version, and changelog entries between the two (read from CHANGELOG.md in the fetched code).

3. **Guard against local changes** — Run `git status --porcelain`. If there are uncommitted changes to tracked files, warn and abort. Config files (secrets.yaml, instances/) are gitignored so they're safe. The guard prevents the update from destroying in-progress code modifications.

4. **Stop all Home23 processes** — `pm2 stop` all `home23-*` processes (scoped to home23, never global `pm2 stop all`). Display what was stopped.

5. **Pull the code** — `git fetch origin main --tags && git merge --ff-only v<target>` to advance main to the tagged release. Fast-forward only — if the merge can't fast-forward (user has local commits), abort and tell them to resolve manually. This updates everything: core code, evobrew, cosmo23, engine, CLI.

6. **Install dependencies** — `npm install` in directories where `package.json` changed (hash comparison before/after). Directories: home23 root, engine, evobrew, cosmo23, cosmo23/engine.

7. **Rebuild TypeScript** — `npx tsc` in home23 root.

8. **Run migrations** — Execute `ensureSystemHealth()` (self-healing, always runs), then any numbered migration scripts between old and new version.

9. **Restart all processes** — Regenerate ecosystem.config.cjs, then `pm2 start ecosystem.config.cjs` plus evobrew and cosmo23.

10. **Report** — Display new version, what changed (dep updates, migrations run), and any action items.

### `--check` Flag

`home23 update --check` does steps 1-2 only (fetch tags, compare versions, show changelog). No modifications. Exit code 0 if update available, 1 if already up to date.

## Section 2: Versioning — Tags, package.json, Changelog

### Version Source of Truth

`package.json` `version` field. Bumped as part of the release process.

### Git Tags

Every release gets a `v0.2.0`-style tag on `main`. The update command fetches tags and compares against the current `package.json` version to determine what's available. Only tags matching `v*` semver pattern are considered.

### CHANGELOG.md

Root-level file. Simple format:

```markdown
# Changelog

## 0.2.0 (2026-04-13)
- Provider authority — Home23 owns all provider config
- Guided onboarding wizard for first-run
- Update system with migrations and versioning

## 0.1.0 (2026-04-07)
- Initial release — engine, harness, dashboard, evobrew, cosmo23
```

The update command parses this and shows relevant sections between old and new version during the update process.

### Release Workflow

When ready to ship a release:

1. Bump version in `package.json`
2. Update `CHANGELOG.md` with new section
3. `git commit -m "release: v0.2.0"`
4. `git tag v0.2.0`
5. `git push origin main --tags`

Users run `home23 update` and get everything up to that tag.

## Section 3: Migration System

### Self-Healing (`ensureSystemHealth()`)

Runs on every update AND every `home23 start`. Idempotent — safe to run repeatedly.

- Ensure `cosmo23.encryptionKey` exists in secrets.yaml (generate if missing)
- Seed cosmo23 config from secrets.yaml
- Regenerate ecosystem.config.cjs
- Generate evobrew config
- Verify Prisma DB exists (create if missing)

Handles all additive changes: new env vars, new config fields, missing plumbing. No migration script needed for these.

### Numbered Migration Scripts

**Directory:** `cli/migrations/`
**Format:** `NNN-description.js` (e.g., `001-initial.js`, `002-provider-authority.js`)
**Tracking:** `.home23-state.json` in home23 root (gitignored)

```json
{
  "lastMigration": 2,
  "version": "0.2.0",
  "updatedAt": "2026-04-13T..."
}
```

Each migration exports:

```js
export async function up(home23Root) {
  // Idempotent — check if already applied before doing work
}
export const description = 'Short description of what this migration does';
```

The update command runs all migrations between `lastMigration` and the highest available, in order. Each is logged to the console.

### When to Use Which

| Change Type | Mechanism |
|---|---|
| New config field with default | Self-healing |
| New env var | Self-healing (ecosystem regen) |
| Missing Prisma DB | Self-healing |
| Renamed config field | Migration script |
| Data format change | Migration script |
| Removed feature cleanup | Migration script |
| Structural move (file/dir) | Migration script |

### Retroactive Migration 001

`001-initial.js` covers everything up to the current state — the "baseline" migration. Handles users who cloned before the migration system existed. Ensures encryption key, Prisma DB, cosmo23 config, and ecosystem are all correct.

## Section 4: Removing Separate Update Commands

### Commands Removed

- `home23 evobrew update` — gone. Evobrew is bundled.
- `home23 cosmo23 update` — gone. Cosmo23 is bundled.

If someone runs the old commands, print a helpful message: "evobrew and cosmo23 are now bundled with Home23. Run `home23 update` to update everything."

### Files Removed

- `cli/lib/evobrew-update.js` — delete
- `cli/lib/cosmo23-update.js` — delete

### Config Removed

- `cosmo23.source` in `config/home.yaml` — no longer needed (was the path to the standalone COSMO repo for rsync)

### Vendored Patches

`COSMO23-VENDORED-PATCHES.md` becomes internal reference only. Since there's no `cosmo23 update` that could wipe patches, they're safe in the repo. The doc remains useful for tracking what was patched and why, but users never need to think about it.

## Section 5: Dashboard Update Notification

### Backend Check

The dashboard server checks for updates periodically:
- Once on startup (after a 30-second delay to let things settle)
- Every 6 hours thereafter

Check mechanism: `git fetch origin --tags` (lightweight, only fetches tag refs), then compare latest `v*` tag against current `package.json` version.

Result stored in memory as:

```js
{
  updateAvailable: true,
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  checkedAt: '2026-04-13T...'
}
```

### API Endpoint

`GET /home23/api/settings/update-status` returns the cached check result.

### Frontend Notification

When an update is available, the dashboard home screen shows a subtle notification bar (not blocking, not a modal):

"Home23 v0.3.0 available — run `home23 update` in your terminal"

Styled as an info bar at the top of the page. Dismissible. Reappears on next page load if update still available.

### What It Does NOT Do

- Does not auto-update
- Does not show a blocking modal or nag
- Does not fetch on every page load (uses cached result)
- Does not require any external API or service (pure git)

## Files Changed (Complete List)

### New Files

| File | Purpose |
|---|---|
| `cli/lib/update.js` | The `home23 update` command implementation |
| `cli/lib/system-health.js` | `ensureSystemHealth()` — self-healing function used by update and start |
| `cli/migrations/001-initial.js` | Baseline migration — encryption key, Prisma DB, config seeding |
| `.home23-state.json` | Migration tracking (gitignored) |
| `CHANGELOG.md` | Release changelog |

### Modified Files

| File | Change |
|---|---|
| `cli/home23.js` | Add `update` command, deprecate `evobrew update` and `cosmo23 update` |
| `cli/lib/pm2-commands.js` | `runStart()` calls `ensureSystemHealth()` before launching |
| `package.json` | Bump version for release |
| `engine/src/dashboard/server.js` | Add periodic update check + `/home23/api/settings/update-status` endpoint |
| `engine/src/dashboard/home23-dashboard.js` | Show update notification bar on home screen |
| `engine/src/dashboard/home23-dashboard.html` | Notification bar HTML |
| `config/home.yaml` | Remove `cosmo23.source` |
| `.gitignore` | Add `.home23-state.json` |

### Removed Files

| File | Reason |
|---|---|
| `cli/lib/evobrew-update.js` | Evobrew is bundled, updates with repo |
| `cli/lib/cosmo23-update.js` | Cosmo23 is bundled, updates with repo |
