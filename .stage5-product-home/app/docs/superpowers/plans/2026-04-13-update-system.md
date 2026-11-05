# Update System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `home23 update` command that pulls tagged releases, runs migrations, rebuilds, and restarts — plus dashboard update notifications.

**Architecture:** Semantic versioning via git tags. `home23 update` does: fetch → compare → stop → merge → deps → build → migrate → restart. Self-healing `ensureSystemHealth()` runs on every start. Numbered migration scripts for breaking changes. Dashboard polls for new tags every 6 hours.

**Tech Stack:** Node.js, git CLI, PM2, js-yaml, semver comparison (hand-rolled, no dep needed)

**Spec:** `docs/design/STEP22-UPDATE-SYSTEM-DESIGN.md`

---

### Task 1: Create `ensureSystemHealth()` — Self-Healing Function

**Files:**
- Create: `cli/lib/system-health.js`

This function is the foundation — used by both `home23 update` and `home23 start`. It makes sure all plumbing is correct every time the system boots.

- [ ] **Step 1: Create the system-health module**

```js
/**
 * Home23 — System Health
 *
 * Self-healing function that ensures all plumbing is correct.
 * Runs on every start and after every update. Idempotent.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

function loadYaml(filePath) {
  if (!existsSync(filePath)) return {};
  try { return yaml.load(readFileSync(filePath, 'utf8')) || {}; }
  catch { return {}; }
}

export async function ensureSystemHealth(home23Root) {
  console.log('Checking system health...');
  let changed = false;

  // 1. Ensure cosmo23 encryption key exists in secrets.yaml
  const secretsPath = join(home23Root, 'config', 'secrets.yaml');
  const secrets = loadYaml(secretsPath);
  if (!secrets.cosmo23?.encryptionKey) {
    if (!secrets.cosmo23) secrets.cosmo23 = {};
    secrets.cosmo23.encryptionKey = randomBytes(32).toString('hex');
    const header = '# Home23 secrets — API keys and tokens\n# This file is gitignored. Never commit it.\n\n';
    writeFileSync(secretsPath, header + yaml.dump(secrets, { lineWidth: 120 }), 'utf8');
    console.log('  Generated encryption key');
    changed = true;
  }

  // 2. Ensure Prisma DB exists
  const dbPath = join(home23Root, 'cosmo23', 'prisma', 'dev.db');
  if (!existsSync(dbPath)) {
    console.log('  Creating Prisma database...');
    try {
      execSync(`DATABASE_URL="file:${dbPath}" npx prisma db push`, {
        cwd: join(home23Root, 'cosmo23'), stdio: 'pipe', timeout: 30000,
      });
      console.log('  Prisma DB created');
      changed = true;
    } catch (err) {
      console.warn(`  Prisma DB creation failed: ${err.message}`);
    }
  }

  // 3. Seed cosmo23 config
  try {
    const { seedCosmo23Config } = await import('./cosmo23-config.js');
    seedCosmo23Config(home23Root);
  } catch (err) {
    console.warn(`  cosmo23 config seed failed: ${err.message}`);
  }

  // 4. Regenerate ecosystem.config.cjs
  try {
    const { generateEcosystem } = await import('./generate-ecosystem.js');
    generateEcosystem(home23Root);
  } catch {
    // No agents yet — fine, ecosystem generated on first agent create
  }

  // 5. Generate evobrew config
  try {
    const { writeEvobrewConfig } = await import('./evobrew-config.js');
    writeEvobrewConfig(home23Root);
  } catch (err) {
    console.warn(`  evobrew config failed: ${err.message}`);
  }

  if (!changed) {
    console.log('  System healthy');
  }
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cli/lib/system-health.js`
Expected: No output (clean)

- [ ] **Step 3: Test it runs without errors**

Run: `node -e "import('./cli/lib/system-health.js').then(m => m.ensureSystemHealth('.'))"`
Expected: "Checking system health..." followed by "System healthy" (or generation messages if something was missing)

- [ ] **Step 4: Commit**

```bash
git add cli/lib/system-health.js
git commit -m "feat: ensureSystemHealth() — self-healing plumbing check for start and update"
```

---

### Task 2: Wire `ensureSystemHealth()` into `home23 start`

**Files:**
- Modify: `cli/lib/pm2-commands.js:29-96`

The start command should call `ensureSystemHealth()` before launching processes, replacing the inline cosmo23 config seeding and evobrew config generation.

- [ ] **Step 1: Add ensureSystemHealth import and call at top of runStart**

In `cli/lib/pm2-commands.js`, add the import and call `ensureSystemHealth()` at the beginning of `runStart()`, right after the TypeScript build (line 38). Then remove the inline `seedCosmo23Config` call (lines 88-91) and `writeEvobrewConfig` call (lines 73-74) since `ensureSystemHealth` handles both.

```js
// At the top of the file, add import:
import { ensureSystemHealth } from './system-health.js';

// In runStart(), after the TypeScript build block (after line 38):
  // Ensure system plumbing is healthy
  await ensureSystemHealth(home23Root);

// Remove the inline seedCosmo23Config block (lines 88-91):
//   const { seedCosmo23Config } = await import('./cosmo23-config.js');
//   seedCosmo23Config(home23Root);

// Remove the inline writeEvobrewConfig block (lines 73-74):
//   const { writeEvobrewConfig } = await import('./evobrew-config.js');
//   writeEvobrewConfig(home23Root);
```

Also update the cosmo23 failure message (line 95) — remove the "run home23 cosmo23 update" suggestion since that command is being deprecated:

```js
// Change:
//   console.log('  Run "home23 cosmo23 update" to install, or check logs/cosmo23-err.log');
// To:
    console.log('  Check logs/cosmo23-err.log for details');
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cli/lib/pm2-commands.js`
Expected: No output (clean)

- [ ] **Step 3: Commit**

```bash
git add cli/lib/pm2-commands.js
git commit -m "feat: home23 start calls ensureSystemHealth() before launching processes"
```

---

### Task 3: Create the `home23 update` Command

**Files:**
- Create: `cli/lib/update.js`

- [ ] **Step 1: Create the update module**

```js
/**
 * Home23 CLI — update command
 *
 * Pulls latest tagged release, installs deps, rebuilds,
 * runs migrations, and restarts all processes.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensureSystemHealth } from './system-health.js';

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function hashFile(filePath) {
  if (!existsSync(filePath)) return '';
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function getCurrentVersion(home23Root) {
  try {
    const pkg = JSON.parse(readFileSync(join(home23Root, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function getLatestTag(home23Root) {
  try {
    // Fetch latest tags from remote
    execSync('git fetch origin --tags --quiet', { cwd: home23Root, stdio: 'pipe', timeout: 30000 });
    // Get the latest v* tag by version sort
    const tags = exec('git tag -l "v*" --sort=-version:refname', { cwd: home23Root });
    if (!tags) return null;
    return tags.split('\n')[0].trim(); // e.g., "v0.2.0"
  } catch { return null; }
}

function parseVersion(tag) {
  if (!tag) return null;
  const m = tag.match(/^v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function getChangelog(home23Root, fromVersion, toTag) {
  // Read CHANGELOG.md from the target version (not current, which may be old)
  try {
    const content = exec(`git show ${toTag}:CHANGELOG.md`, { cwd: home23Root });
    // Extract sections between fromVersion and toVersion
    const lines = content.split('\n');
    const relevant = [];
    let capturing = false;
    for (const line of lines) {
      const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
      if (versionMatch) {
        const v = versionMatch[1];
        if (compareVersions(v, fromVersion) <= 0) break; // reached current or older
        capturing = true;
      }
      if (capturing) relevant.push(line);
    }
    return relevant.join('\n').trim();
  } catch { return ''; }
}

function stopHome23Processes() {
  try {
    const jlist = JSON.parse(exec('pm2 jlist'));
    const home23Procs = jlist.filter(p => p.name.startsWith('home23-'));
    if (home23Procs.length === 0) return [];
    const names = home23Procs.map(p => p.name);
    for (const name of names) {
      try { execSync(`pm2 stop ${name}`, { stdio: 'pipe' }); } catch {}
    }
    return names;
  } catch { return []; }
}

function startHome23Processes(home23Root) {
  const ecosystemPath = join(home23Root, 'ecosystem.config.cjs');
  if (!existsSync(ecosystemPath)) return;
  try {
    execSync(`pm2 start ${ecosystemPath}`, { cwd: home23Root, stdio: 'inherit' });
  } catch {}
}

async function runMigrations(home23Root, fromVersion) {
  const migrationsDir = join(home23Root, 'cli', 'migrations');
  const statePath = join(home23Root, '.home23-state.json');

  // Read current state
  let state = { lastMigration: 0, version: fromVersion };
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  }

  // Find and run pending migrations
  if (!existsSync(migrationsDir)) return;
  const files = readdirSync(migrationsDir)
    .filter(f => f.match(/^\d{3}-.*\.js$/))
    .sort();

  let ran = 0;
  for (const file of files) {
    const num = parseInt(file.slice(0, 3), 10);
    if (num <= state.lastMigration) continue;

    const mod = await import(join(migrationsDir, file));
    console.log(`  Migration ${file}: ${mod.description || file}`);
    try {
      await mod.up(home23Root);
      state.lastMigration = num;
      ran++;
    } catch (err) {
      console.error(`  Migration ${file} FAILED: ${err.message}`);
      break; // Stop on first failure
    }
  }

  // Update state
  state.version = getCurrentVersion(home23Root);
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

  if (ran > 0) console.log(`  ${ran} migration(s) applied`);
  return ran;
}

export async function runUpdate(home23Root, checkOnly = false) {
  const currentVersion = getCurrentVersion(home23Root);
  console.log('');
  console.log(`Home23 v${currentVersion}`);
  console.log('Checking for updates...');

  const latestTag = getLatestTag(home23Root);
  if (!latestTag) {
    console.log('  No releases found. Are you connected to the internet?');
    process.exit(1);
  }

  const latestVersion = parseVersion(latestTag);
  if (!latestVersion) {
    console.log(`  Could not parse version from tag: ${latestTag}`);
    process.exit(1);
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    console.log(`  Already up to date (v${currentVersion})`);
    process.exit(0);
  }

  console.log(`  Update available: v${currentVersion} → v${latestVersion}`);
  console.log('');

  // Show changelog
  const changelog = getChangelog(home23Root, currentVersion, latestTag);
  if (changelog) {
    console.log('What\'s new:');
    console.log(changelog);
    console.log('');
  }

  if (checkOnly) {
    process.exit(0);
  }

  // Guard against local changes
  try {
    const status = exec('git status --porcelain', { cwd: home23Root });
    // Filter out untracked and gitignored files — only care about modified tracked files
    const tracked = status.split('\n').filter(l => l && !l.startsWith('??'));
    if (tracked.length > 0) {
      console.log('Cannot update — you have uncommitted changes to tracked files:');
      for (const line of tracked.slice(0, 10)) console.log(`  ${line}`);
      console.log('');
      console.log('Commit or stash your changes, then try again.');
      process.exit(1);
    }
  } catch {}

  // ── Stop all processes ──
  console.log('Stopping Home23 processes...');
  const stopped = stopHome23Processes();
  if (stopped.length > 0) {
    console.log(`  Stopped ${stopped.length} process(es)`);
  }

  // ── Pull the code ──
  console.log(`Updating to ${latestTag}...`);
  try {
    execSync(`git merge --ff-only ${latestTag}`, { cwd: home23Root, stdio: 'pipe' });
    console.log('  Code updated');
  } catch (err) {
    console.error('  Fast-forward merge failed. You may have local commits.');
    console.error('  Resolve manually: git merge ' + latestTag);
    // Try to restart what we stopped
    startHome23Processes(home23Root);
    process.exit(1);
  }

  // ── Install dependencies (only where package.json changed) ──
  console.log('Checking dependencies...');
  const depDirs = [
    { name: 'home23', path: home23Root },
    { name: 'engine', path: join(home23Root, 'engine') },
    { name: 'evobrew', path: join(home23Root, 'evobrew') },
    { name: 'cosmo23', path: join(home23Root, 'cosmo23') },
    { name: 'cosmo23/engine', path: join(home23Root, 'cosmo23', 'engine') },
  ];

  for (const dir of depDirs) {
    const pkgPath = join(dir.path, 'package.json');
    if (!existsSync(pkgPath)) continue;
    // Check if package.json changed in this update
    try {
      const diff = exec(`git diff ${latestTag}~1..${latestTag} -- ${pkgPath}`, { cwd: home23Root });
      if (diff) {
        process.stdout.write(`  ${dir.name}: npm install...`);
        execSync('npm install', { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
        console.log(' done');
      }
    } catch {
      // If diff check fails, install anyway to be safe
      process.stdout.write(`  ${dir.name}: npm install...`);
      try {
        execSync('npm install', { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
        console.log(' done');
      } catch (err) {
        console.log(` FAILED: ${err.message?.split('\n')[0]}`);
      }
    }
  }

  // ── Prisma generate (if cosmo23 schema changed) ──
  try {
    execSync('npx prisma generate', { cwd: join(home23Root, 'cosmo23'), stdio: 'pipe', timeout: 30000 });
  } catch {}

  // ── Build TypeScript ──
  process.stdout.write('Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
    console.log(' done');
  } catch {
    console.log(' FAILED (run npx tsc --noEmit to see errors)');
  }

  // ── Self-healing ──
  await ensureSystemHealth(home23Root);

  // ── Migrations ──
  console.log('Running migrations...');
  await runMigrations(home23Root, currentVersion);

  // ── Restart ──
  console.log('Starting Home23...');
  startHome23Processes(home23Root);

  // ── Report ──
  const newVersion = getCurrentVersion(home23Root);
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Home23 updated to v${newVersion}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cli/lib/update.js`
Expected: No output (clean)

- [ ] **Step 3: Commit**

```bash
git add cli/lib/update.js
git commit -m "feat: home23 update command — full lifecycle update with migrations"
```

---

### Task 4: Wire Update Command into CLI + Deprecate Old Commands

**Files:**
- Modify: `cli/home23.js`

- [ ] **Step 1: Add update command, deprecate evobrew/cosmo23 update**

Replace the entire `cli/home23.js` with updated routing:

```js
#!/usr/bin/env node

/**
 * Home23 CLI — Install, configure, and manage agents
 *
 * Usage:
 *   node cli/home23.js init                 — First-time setup
 *   node cli/home23.js start [name]         — Start agent(s) via PM2
 *   node cli/home23.js stop [name]          — Stop agent(s) via PM2
 *   node cli/home23.js update               — Update to latest release
 *   node cli/home23.js update --check       — Check if update available
 *   node cli/home23.js agent create <name>  — Create a new agent
 *   node cli/home23.js status               — Show running processes
 *   node cli/home23.js logs [name]          — Tail PM2 logs
 */

import { resolve } from 'node:path';

const HOME23_ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`
Home23 — Installable AI operating system

Commands:
  init                    First-time setup (deps, build, plumbing)
  start [name]            Start agent(s) via PM2
  stop [name]             Stop agent(s) via PM2
  update                  Update to latest release
  update --check          Check if an update is available
  agent create <name>     Create a new agent instance
  status                  Show running processes
  logs [name]             Tail PM2 logs
  help                    Show this help
`);
    process.exit(0);
  }

  if (command === 'init') {
    const { runInit } = await import('./lib/init.js');
    await runInit(HOME23_ROOT);
  } else if (command === 'update') {
    const { runUpdate } = await import('./lib/update.js');
    const checkOnly = args.includes('--check');
    await runUpdate(HOME23_ROOT, checkOnly);
  } else if (command === 'agent' && subcommand === 'create') {
    const name = args[2];
    if (!name) {
      console.error('Usage: home23 agent create <name>');
      process.exit(1);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      console.error('Agent name must be lowercase alphanumeric with hyphens (e.g., "cosmo", "my-agent")');
      process.exit(1);
    }
    const { runAgentCreate } = await import('./lib/agent-create.js');
    await runAgentCreate(HOME23_ROOT, name);
  } else if (command === 'start') {
    const { runStart } = await import('./lib/pm2-commands.js');
    await runStart(HOME23_ROOT, args[1]);
  } else if (command === 'stop') {
    const { runStop } = await import('./lib/pm2-commands.js');
    await runStop(HOME23_ROOT, args[1]);
  } else if (command === 'status') {
    const { runStatus } = await import('./lib/pm2-commands.js');
    await runStatus();
  } else if (command === 'logs') {
    const { runLogs } = await import('./lib/pm2-commands.js');
    await runLogs(args[1]);
  } else if (command === 'evobrew' || command === 'cosmo23') {
    // Deprecated — bundled systems update with home23 update
    console.log(`${command} is now bundled with Home23 and updates automatically.`);
    console.log('Run "home23 update" to update everything.');
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Run "node cli/home23.js help" for usage');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cli/home23.js`
Expected: No output (clean)

- [ ] **Step 3: Test deprecation message**

Run: `node cli/home23.js evobrew update`
Expected: "evobrew is now bundled with Home23 and updates automatically." + "Run 'home23 update' to update everything."

- [ ] **Step 4: Commit**

```bash
git add cli/home23.js
git commit -m "feat: add update command to CLI, deprecate evobrew/cosmo23 update"
```

---

### Task 5: Create Baseline Migration + State File

**Files:**
- Create: `cli/migrations/001-initial.js`
- Modify: `.gitignore`

- [ ] **Step 1: Create migrations directory and baseline migration**

```js
/**
 * Migration 001: Initial baseline
 *
 * Ensures all plumbing from pre-migration era is in place.
 * This is a no-op if ensureSystemHealth() already handled everything,
 * but it establishes the migration tracking baseline.
 */

export const description = 'Baseline — establish migration tracking';

export async function up(home23Root) {
  // ensureSystemHealth() already handles all additive plumbing.
  // This migration exists solely to set the lastMigration baseline
  // so future migrations know where to start.
  console.log('    Baseline migration applied');
}
```

- [ ] **Step 2: Add .home23-state.json to .gitignore**

Add this line to `.gitignore`:

```
.home23-state.json
```

- [ ] **Step 3: Verify syntax**

Run: `node --check cli/migrations/001-initial.js`
Expected: No output (clean)

- [ ] **Step 4: Commit**

```bash
mkdir -p cli/migrations
git add cli/migrations/001-initial.js .gitignore
git commit -m "feat: migration system baseline — 001-initial.js + state tracking"
```

---

### Task 6: Create CHANGELOG.md + Version Bump

**Files:**
- Create: `CHANGELOG.md`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Create CHANGELOG.md**

```markdown
# Changelog

## 0.2.0 (2026-04-13)

### Provider Authority
- Home23 is the single authority for all provider configuration
- Guided onboarding wizard for first-run (Providers → Agent Create → Launch)
- COSMO 2.3 and evobrew show "Managed by Home23" UI when running under Home23
- Single encryption key flows from secrets.yaml to all subsystems
- OAuth wiring fixed — ENCRYPTION_KEY and DATABASE_URL reach cosmo23 via PM2

### Update System
- `home23 update` — one command updates everything (code, deps, build, migrate, restart)
- Semantic versioning with tagged releases
- Self-healing `ensureSystemHealth()` runs on every start
- Migration system for breaking changes between versions
- Dashboard shows notification when updates are available
- `evobrew update` and `cosmo23 update` deprecated — bundled systems update with core

### Infrastructure
- COSMO 2.3 health watchdog in dashboard — auto-restarts if process dies
- Dashboard COSMO tab shows actionable offline state with restart button

## 0.1.0 (2026-04-07)
- Initial release — cognitive engine, agent harness, dashboard, evobrew, cosmo23
- Telegram channel integration
- Document ingestion with LLM-powered compiler
- Intelligence synthesis agent
- Brain map visualization
- Agent research toolkit (11 COSMO tools)
- Situational awareness engine
```

- [ ] **Step 2: Bump version in package.json**

Change `"version": "0.1.0"` to `"version": "0.2.0"` in `package.json`.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "release: v0.2.0 — provider authority, update system, infrastructure fixes"
```

---

### Task 7: Dashboard Update Notification — Backend

**Files:**
- Modify: `engine/src/dashboard/server.js`

- [ ] **Step 1: Add update check poller and API endpoint**

In `server.js`, after the COSMO watchdog block (around line 1045, before "Chat History API"), add:

```js
    // ── Update check (STEP 22) ──
    // Periodically check if a newer tagged release exists on origin.
    // Results served via /home23/api/settings/update-status.
    try {
      const home23RootForUpdate = this.getHome23Root();
      let updateStatus = { updateAvailable: false, currentVersion: '', latestVersion: '', checkedAt: null };

      const checkForUpdates = () => {
        try {
          const { execSync: execS } = require('child_process');
          const fs = require('fs');
          const pkgPath = path.join(home23RootForUpdate, 'package.json');
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const currentVersion = pkg.version || '0.0.0';

          execS('git fetch origin --tags --quiet', { cwd: home23RootForUpdate, stdio: 'pipe', timeout: 30000 });
          const tags = execS('git tag -l "v*" --sort=-version:refname', { cwd: home23RootForUpdate, encoding: 'utf8', stdio: 'pipe' }).trim();
          if (!tags) { updateStatus = { updateAvailable: false, currentVersion, latestVersion: currentVersion, checkedAt: new Date().toISOString() }; return; }

          const latestTag = tags.split('\n')[0].trim();
          const latestMatch = latestTag.match(/^v?(\d+\.\d+\.\d+)/);
          const latestVersion = latestMatch ? latestMatch[1] : currentVersion;

          const cv = currentVersion.split('.').map(Number);
          const lv = latestVersion.split('.').map(Number);
          const hasUpdate = lv[0] > cv[0] || (lv[0] === cv[0] && lv[1] > cv[1]) || (lv[0] === cv[0] && lv[1] === cv[1] && lv[2] > cv[2]);

          updateStatus = { updateAvailable: hasUpdate, currentVersion, latestVersion, checkedAt: new Date().toISOString() };
          if (hasUpdate) console.log(`[Update check] v${latestVersion} available (current: v${currentVersion})`);
        } catch (err) {
          console.warn('[Update check] failed:', err.message);
        }
      };

      // Initial check after 30s, then every 6 hours
      setTimeout(() => {
        checkForUpdates();
        setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
      }, 30_000);

      this.app.get('/home23/api/settings/update-status', (req, res) => {
        res.json(updateStatus);
      });
    } catch (err) {
      console.warn('[Update check] setup failed:', err.message);
    }
```

- [ ] **Step 2: Verify syntax of server.js**

Run: `node --check engine/src/dashboard/server.js`
Expected: No output (clean)

- [ ] **Step 3: Test the endpoint**

Run: `pm2 restart home23-jerry-dash && sleep 1 && curl -s http://localhost:5002/home23/api/settings/update-status`
Expected: JSON with `updateAvailable`, `currentVersion`, `latestVersion` fields

- [ ] **Step 4: Commit**

```bash
git add engine/src/dashboard/server.js
git commit -m "feat: dashboard update check — periodic git tag polling + API endpoint"
```

---

### Task 8: Dashboard Update Notification — Frontend

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-dashboard.js`

- [ ] **Step 1: Add notification bar HTML**

In `home23-dashboard.html`, add an update notification bar right after the opening body/container tag (before the tab bar):

```html
<!-- Update notification bar -->
<div id="update-notification" class="h23-update-bar" style="display:none;">
  <span id="update-notification-text"></span>
  <button id="update-dismiss" style="background:none; border:none; color:rgba(255,255,255,0.6); cursor:pointer; font-size:16px; margin-left:12px;">×</button>
</div>
```

Add styles (either inline or in the CSS):

```css
.h23-update-bar {
  background: rgba(99, 102, 241, 0.15);
  border-bottom: 1px solid rgba(99, 102, 241, 0.3);
  color: #a5b4fc;
  padding: 8px 16px;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

- [ ] **Step 2: Add notification logic to dashboard JS**

In `home23-dashboard.js`, add a function that checks the update status endpoint and shows the notification:

```js
// ── Update notification ──

async function checkUpdateNotification() {
  try {
    const res = await fetch('/home23/api/settings/update-status');
    if (!res.ok) return;
    const data = await res.json();
    if (data.updateAvailable) {
      const bar = document.getElementById('update-notification');
      const text = document.getElementById('update-notification-text');
      if (bar && text) {
        text.textContent = `Home23 v${data.latestVersion} available — run "home23 update" in your terminal`;
        bar.style.display = 'flex';
      }
    }
  } catch {}
}

// Call on page load (after init), wire dismiss button
// Add to the end of the init/DOMContentLoaded handler:
checkUpdateNotification();
document.getElementById('update-dismiss')?.addEventListener('click', () => {
  document.getElementById('update-notification').style.display = 'none';
});
```

- [ ] **Step 3: Commit**

```bash
git add engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-dashboard.js
git commit -m "feat: dashboard update notification bar — shows when new version available"
```

---

### Task 9: Delete Deprecated Update Files + Update Docs

**Files:**
- Delete: `cli/lib/evobrew-update.js`
- Delete: `cli/lib/cosmo23-update.js`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Delete deprecated files**

```bash
git rm cli/lib/evobrew-update.js cli/lib/cosmo23-update.js
```

- [ ] **Step 2: Update README.md**

In the Commands section, replace:
```
node cli/home23.js evobrew update      # Pull latest Evobrew from GitHub
node cli/home23.js cosmo23 update      # Sync latest COSMO from source
```

With:
```
node cli/home23.js update              # Update to latest release
node cli/home23.js update --check      # Check for updates
```

Also update the Quick Start section in CLAUDE.md similarly:
```
node cli/home23.js update              # Update to latest release
```

Replace the `evobrew update` and `cosmo23 update` lines.

- [ ] **Step 3: Add Step 22 to CLAUDE.md Key Documents table**

Add after the Step 21 entry:
```
| `docs/design/STEP22-UPDATE-SYSTEM-DESIGN.md` | Update system — one command, versioned releases, migration system |
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: update README + CLAUDE.md for update system, remove deprecated update scripts"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Verify update --check works**

Run: `node cli/home23.js update --check`
Expected: "Already up to date (v0.2.0)" (since we haven't pushed a newer tag)

- [ ] **Step 2: Verify start calls ensureSystemHealth**

Run: `node cli/home23.js start 2>&1 | head -10`
Expected: "Checking system health..." appears before "Starting all agents..."

- [ ] **Step 3: Verify deprecation messages**

Run: `node cli/home23.js evobrew update`
Expected: "evobrew is now bundled with Home23 and updates automatically."

Run: `node cli/home23.js cosmo23 update`
Expected: "cosmo23 is now bundled with Home23 and updates automatically."

- [ ] **Step 4: Verify migration system initializes**

Run: `node -e "import('./cli/lib/update.js').then(m => m.runUpdate('.', true))" 2>/dev/null; cat .home23-state.json 2>/dev/null || echo 'no state yet'`
Verify .home23-state.json is created on first migration run.

- [ ] **Step 5: Verify dashboard update endpoint**

Run: `curl -s http://localhost:5002/home23/api/settings/update-status | python3 -m json.tool`
Expected: JSON with `currentVersion: "0.2.0"`, `updateAvailable: false`

- [ ] **Step 6: Tag the release**

```bash
git tag v0.2.0
```

Note: Don't push the tag until the user is ready. The tag marks this as a release point.

- [ ] **Step 7: Final commit**

```bash
git add -A
git status  # review
git commit -m "verified: Step 22 update system end-to-end — update command, migrations, dashboard notification"
```
