/**
 * Home23 CLI — Self-updater
 *
 * Fetches latest release tag from origin, compares against package.json,
 * shows changelog, fast-forward merges, reinstalls deps where changed,
 * runs migrations, rebuilds TS, restarts all home23-* PM2 processes.
 *
 * Usage:
 *   home23 update          — full update
 *   home23 update --check  — version check only (no modifications)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureSystemHealth } from './system-health.js';

// ── Helpers ──────────────────────────────────────────────────────────

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function hashFile(filePath) {
  if (!existsSync(filePath)) return '';
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}

/** Parse "0.2.1" from "v0.2.1" or "0.2.1". Returns [major, minor, patch]. */
function parseSemver(str) {
  const m = str.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two semver tuples. Returns -1, 0, or 1. */
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function semverToString(parts) {
  return parts.join('.');
}

/** Get list of running home23-* PM2 process names. */
function getHome23Processes() {
  try {
    const jlist = exec('pm2 jlist');
    const procs = JSON.parse(jlist);
    return procs.filter(p => p.name.startsWith('home23-'));
  } catch {
    return [];
  }
}

/** Stop all home23-* PM2 processes individually (never pm2 stop all). */
function stopHome23Processes() {
  const procs = getHome23Processes();
  const running = procs.filter(p => p.pm2_env?.status === 'online');
  if (running.length === 0) {
    console.log('  No running Home23 processes');
    return [];
  }
  console.log(`  Stopping ${running.length} Home23 process(es)...`);
  const stopped = [];
  for (const p of running) {
    try {
      execSync(`pm2 stop ${p.name}`, { stdio: 'pipe' });
      stopped.push(p.name);
    } catch {
      // Already stopped
    }
  }
  console.log(`  Stopped: ${stopped.join(', ') || '(none)'}`);
  return stopped;
}

/** Restart all home23-* PM2 processes from ecosystem config. */
function restartHome23Processes(home23Root) {
  const ecosystemPath = join(home23Root, 'ecosystem.config.cjs');
  if (!existsSync(ecosystemPath)) {
    console.log('  No ecosystem.config.cjs — skipping process restart');
    return;
  }
  console.log('  Restarting Home23 processes...');
  try {
    execSync(`pm2 start ${ecosystemPath}`, { cwd: home23Root, stdio: 'inherit' });
  } catch {
    console.error('  PM2 restart failed — run "home23 start" manually');
  }
}

/** Load .home23-state.json (or create default). */
function loadState(home23Root) {
  const statePath = join(home23Root, '.home23-state.json');
  if (!existsSync(statePath)) return { lastMigration: 0 };
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return { lastMigration: 0 };
  }
}

/** Save .home23-state.json. */
function saveState(home23Root, state) {
  const statePath = join(home23Root, '.home23-state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── Version detection ────────────────────────────────────────────────

function getCurrentVersion(home23Root) {
  const pkgPath = join(home23Root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return pkg.version; // e.g. "0.1.0"
}

function fetchLatestTag(home23Root) {
  // Fetch tags from origin
  try {
    execSync('git fetch origin --tags --quiet', { cwd: home23Root, stdio: 'pipe', timeout: 30000 });
  } catch (err) {
    throw new Error(`Failed to fetch from origin: ${err.message}`);
  }

  // Get all v* tags, parse semver, find highest
  let tagOutput;
  try {
    tagOutput = exec('git tag -l "v*"', { cwd: home23Root });
  } catch {
    return null;
  }

  if (!tagOutput) return null;

  const tags = tagOutput.split('\n').filter(Boolean);
  let best = null;
  let bestParts = null;

  for (const tag of tags) {
    const parts = parseSemver(tag);
    if (!parts) continue;
    if (!bestParts || compareSemver(parts, bestParts) > 0) {
      best = tag;
      bestParts = parts;
    }
  }

  return best ? { tag: best, version: semverToString(bestParts) } : null;
}

// ── Changelog extraction ─────────────────────────────────────────────

function extractChangelog(home23Root, targetTag, currentVersion, targetVersion) {
  // Try to read CHANGELOG.md from the target tag
  let changelog;
  try {
    changelog = exec(`git show ${targetTag}:CHANGELOG.md`, { cwd: home23Root });
  } catch {
    // No CHANGELOG.md in target tag — fall back to commit log
    return extractCommitLog(home23Root, currentVersion, targetTag);
  }

  // Extract sections between current and target version
  const lines = changelog.split('\n');
  const sections = [];
  let capturing = false;
  const currentHeader = new RegExp(`^##\\s+.*${escapeRegex(currentVersion)}`);
  const versionHeader = /^##\s+/;

  for (const line of lines) {
    if (currentHeader.test(line)) {
      // Reached current version — stop
      break;
    }
    if (versionHeader.test(line)) {
      capturing = true;
    }
    if (capturing) {
      sections.push(line);
    }
  }

  if (sections.length === 0) {
    // Changelog exists but no structured sections found — show commits
    return extractCommitLog(home23Root, currentVersion, targetTag);
  }

  return sections.join('\n').trim();
}

function extractCommitLog(home23Root, currentVersion, targetTag) {
  try {
    const currentTag = `v${currentVersion}`;
    // Try range from current tag to target
    const log = exec(
      `git log --oneline ${currentTag}..${targetTag} 2>/dev/null || git log --oneline HEAD..${targetTag}`,
      { cwd: home23Root }
    );
    return log || '(no commits between versions)';
  } catch {
    return '(unable to determine changes)';
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Dependency installation ──────────────────────────────────────────

function installDepsWhereChanged(home23Root, preHashes) {
  const dirs = [
    { path: home23Root, label: 'home23 (root)' },
    { path: join(home23Root, 'engine'), label: 'engine' },
    { path: join(home23Root, 'evobrew'), label: 'evobrew' },
    { path: join(home23Root, 'cosmo23'), label: 'cosmo23' },
    { path: join(home23Root, 'cosmo23', 'engine'), label: 'cosmo23/engine' },
  ];

  let installed = 0;
  for (const dir of dirs) {
    const pkgPath = join(dir.path, 'package.json');
    if (!existsSync(pkgPath)) continue;

    const newHash = hashFile(pkgPath);
    const oldHash = preHashes[pkgPath] || '';

    if (newHash !== oldHash) {
      console.log(`  Installing deps: ${dir.label}...`);
      try {
        execSync('npm install', { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
        installed++;
      } catch (err) {
        console.error(`  npm install failed in ${dir.label}: ${err.message}`);
      }
    }
  }

  if (installed === 0) {
    console.log('  Dependencies unchanged — no installs needed');
  }
}

// ── Prisma ───────────────────────────────────────────────────────────

function runPrismaGenerate(home23Root) {
  const cosmo23Dir = join(home23Root, 'cosmo23');
  const schemaPath = join(cosmo23Dir, 'prisma', 'schema.prisma');
  if (!existsSync(schemaPath)) return;

  console.log('  Running prisma generate...');
  try {
    execSync('npx prisma generate', { cwd: cosmo23Dir, stdio: 'pipe', timeout: 30000 });
  } catch (err) {
    console.warn(`  Prisma generate failed: ${err.message}`);
  }
}

// ── TypeScript build ─────────────────────────────────────────────────

function buildTypeScript(home23Root) {
  console.log('  Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
    console.log('  Build complete');
  } catch (err) {
    const output = err.stdout || err.stderr || '';
    console.error('  TypeScript build FAILED');
    if (output) {
      // Show first 20 lines of errors
      const errorLines = output.split('\n').slice(0, 20).join('\n');
      console.error(errorLines);
    }
    throw new Error('TypeScript build failed — aborting update');
  }
}

// ── Migration system ─────────────────────────────────────────────────

async function runMigrations(home23Root) {
  const migrationsDir = join(home23Root, 'cli', 'migrations');
  if (!existsSync(migrationsDir)) {
    return 0;
  }

  const state = loadState(home23Root);
  const lastRun = state.lastMigration || 0;

  // Find NNN-*.js files
  const files = readdirSync(migrationsDir)
    .filter(f => /^\d{3}-.*\.js$/.test(f))
    .sort();

  const pending = [];
  for (const file of files) {
    const num = parseInt(file.slice(0, 3), 10);
    if (num > lastRun) {
      pending.push({ file, num });
    }
  }

  if (pending.length === 0) return 0;

  console.log(`  Running ${pending.length} migration(s)...`);
  for (const { file, num } of pending) {
    console.log(`    ${file}...`);
    try {
      const mod = await import(join(migrationsDir, file));
      if (typeof mod.up === 'function') {
        await mod.up(home23Root);
      }
      state.lastMigration = num;
      saveState(home23Root, state);
    } catch (err) {
      console.error(`    Migration ${file} failed: ${err.message}`);
      throw new Error(`Migration ${file} failed — aborting. Last successful: ${state.lastMigration}`);
    }
  }

  return pending.length;
}

// ── Guard: uncommitted changes ───────────────────────────────────────

function checkUncommittedChanges(home23Root) {
  // Check for uncommitted changes to tracked files
  const status = exec('git status --porcelain', { cwd: home23Root });
  if (!status) return null; // Clean

  // Filter to tracked-file modifications (M, D, R, etc. — not ?? untracked)
  const tracked = status
    .split('\n')
    .filter(line => line && !line.startsWith('??'))
    .map(line => line.trim());

  if (tracked.length === 0) return null;
  return tracked;
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runUpdate(home23Root, checkOnly = false) {
  console.log('');
  console.log('Home23 Update');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // Step 1: Current version
  const currentVersion = getCurrentVersion(home23Root);
  console.log(`Current version: ${currentVersion}`);

  // Step 2: Fetch latest tag
  console.log('Fetching latest release...');
  const latest = fetchLatestTag(home23Root);

  if (!latest) {
    console.log('No release tags found on origin.');
    console.log('This is expected for new installations. Updates will be available after the first tagged release.');
    return;
  }

  console.log(`Latest release:  ${latest.version} (${latest.tag})`);

  // Step 3: Compare
  const currentParts = parseSemver(currentVersion);
  const latestParts = parseSemver(latest.version);

  if (!currentParts) {
    console.error(`Cannot parse current version "${currentVersion}" as semver.`);
    process.exit(1);
  }

  const cmp = compareSemver(currentParts, latestParts);

  if (cmp >= 0) {
    console.log('');
    console.log('Already up to date.');
    return;
  }

  console.log('');
  console.log(`Update available: ${currentVersion} -> ${latest.version}`);
  console.log('');

  // Step 3b: Changelog
  const changelog = extractChangelog(home23Root, latest.tag, currentVersion, latest.version);
  if (changelog) {
    console.log('Changes:');
    console.log('───────────────────────────────────────────────────');
    // Indent changelog for readability
    for (const line of changelog.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log('───────────────────────────────────────────────────');
    console.log('');
  }

  // Check-only mode stops here
  if (checkOnly) {
    console.log('Run "home23 update" to apply this update.');
    return;
  }

  // Step 4: Guard against uncommitted changes
  const dirty = checkUncommittedChanges(home23Root);
  if (dirty) {
    console.error('Uncommitted changes to tracked files:');
    for (const line of dirty) {
      console.error(`  ${line}`);
    }
    console.error('');
    console.error('Commit or stash your changes before updating.');
    process.exit(1);
  }

  // Step 5: Snapshot pre-update package.json hashes
  const depDirs = [
    home23Root,
    join(home23Root, 'engine'),
    join(home23Root, 'evobrew'),
    join(home23Root, 'cosmo23'),
    join(home23Root, 'cosmo23', 'engine'),
  ];
  const preHashes = {};
  for (const dir of depDirs) {
    const pkgPath = join(dir, 'package.json');
    preHashes[pkgPath] = hashFile(pkgPath);
  }

  // Step 6: Stop processes
  console.log('Stopping processes...');
  const stoppedNames = stopHome23Processes();

  // Step 7: Fast-forward merge
  console.log(`Merging to ${latest.tag}...`);
  let mergeFailed = false;
  try {
    exec(`git merge --ff-only ${latest.tag}`, { cwd: home23Root });
    console.log('  Merge complete');
  } catch (err) {
    console.error('  Fast-forward merge failed.');
    console.error('  Your branch has diverged from the release tag.');
    console.error('  Resolve manually with: git merge or git rebase');
    mergeFailed = true;
  }

  if (mergeFailed) {
    // Restart what we stopped — don't leave the user without running processes
    if (stoppedNames.length > 0) {
      console.log('');
      console.log('Restarting previously running processes...');
      restartHome23Processes(home23Root);
    }
    process.exit(1);
  }

  // Step 8: Install deps where package.json changed
  console.log('Checking dependencies...');
  installDepsWhereChanged(home23Root, preHashes);

  // Step 9: Prisma generate
  runPrismaGenerate(home23Root);

  // Step 10: Build TypeScript
  try {
    buildTypeScript(home23Root);
  } catch (err) {
    console.error('');
    console.error(err.message);
    console.error('Processes NOT restarted. Fix build errors, then run "home23 start".');
    process.exit(1);
  }

  // Step 11: System health
  await ensureSystemHealth(home23Root);

  // Step 12: Migrations
  let migrationCount = 0;
  try {
    migrationCount = await runMigrations(home23Root);
  } catch (err) {
    console.error('');
    console.error(err.message);
    console.error('Fix the migration issue, then run "home23 start".');
    process.exit(1);
  }

  // Step 13: Restart processes
  console.log('');
  restartHome23Processes(home23Root);

  // Step 14: Summary
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Updated: ${currentVersion} -> ${latest.version}`);
  if (migrationCount > 0) {
    console.log(`  Migrations: ${migrationCount} applied`);
  }
  console.log('  All processes restarted');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
}
