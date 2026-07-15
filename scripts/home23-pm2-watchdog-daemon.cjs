#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WATCHDOG = path.join(ROOT, 'scripts', 'home23-pm2-watchdog.cjs');
const DEFAULT_INTERVAL_MS = 60_000;
const DUPLICATE_LOCK_RETRY_MS = 10_000;
const STATUS_PATH = path.join(ROOT, 'logs', 'pm2-watchdog-daemon.status.jsonl');
const LOCK_PATH = path.join(ROOT, 'logs', 'pm2-watchdog-daemon.lock');
const PM2_ENV_BLOCKLIST = [
  'cron_restart',
  'watch',
  'HOME23_AGENT',
  'INSTANCE_ID',
  'DASHBOARD_PORT',
  'COSMO_DASHBOARD_PORT',
  'REALTIME_PORT',
  'MCP_HTTP_PORT',
  'COSMO_RUNTIME_DIR',
  'COSMO_WORKSPACE_PATH',
  'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY',
  'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY',
];

function cleanChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of PM2_ENV_BLOCKLIST) delete env[key];
  return env;
}

function parseArgs(argv) {
  const args = {
    agents: [],
    intervalMs: Number(process.env.HOME23_WATCHDOG_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agents') {
      args.agents = String(argv[++i] || '').split(',').map((agent) => agent.trim()).filter(Boolean);
    } else if (arg.startsWith('--agents=')) {
      args.agents = arg.slice('--agents='.length).split(',').map((agent) => agent.trim()).filter(Boolean);
    } else if (arg === '--interval-ms') {
      args.intervalMs = Number(argv[++i] || DEFAULT_INTERVAL_MS);
    } else if (arg.startsWith('--interval-ms=')) {
      args.intervalMs = Number(arg.slice('--interval-ms='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.intervalMs) || args.intervalMs < 10_000) args.intervalMs = DEFAULT_INTERVAL_MS;
  return args;
}

function discoverAgents(root = ROOT) {
  const ecosystem = require(path.join(root, 'ecosystem.config.cjs'));
  const names = new Set((ecosystem.apps || []).map((app) => app.name));
  const agents = [];
  for (const name of names) {
    const match = /^home23-([a-z0-9_-]+)$/.exec(name);
    if (!match) continue;
    const agent = match[1];
    if (names.has(`home23-${agent}-dash`) && names.has(`home23-${agent}-harness`)) {
      agents.push(agent);
    }
  }
  return agents.sort();
}

function runWatchdog(agent) {
  const output = execFileSync(process.execPath, [WATCHDOG, '--agent', agent, '--repair'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanChildEnv(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return output.trim();
}

function appendStatus(entry) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.appendFileSync(STATUS_PATH, JSON.stringify({ recordedAt: new Date().toISOString(), ...entry }) + '\n');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandForPid(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isPm2ManagedProcess() {
  return process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined;
}

function duplicateLockMode(env = process.env) {
  return 'exit';
}

function watchdogDaemonDisabled(env = process.env) {
  const value = String(env.HOME23_WATCHDOG_DAEMON_DISABLED || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shouldReplaceLockHolder(lock, holderPid) {
  if (!isPm2ManagedProcess()) return false;
  if (!holderPid || holderPid === process.pid) return false;
  const command = commandForPid(holderPid);
  return shouldReplaceLockHolderWithCommand(lock, holderPid, command, process.env);
}

function shouldReplaceLockHolderWithCommand(lock, holderPid, command, env = process.env) {
  if (!command.includes('home23-pm2-watchdog-daemon.cjs')) return false;
  const currentPmId = String(env.pm_id ?? '');
  const holderPmId = lock?.pmId === undefined ? '' : String(lock.pmId);
  const currentPmName = String(env.name ?? env.pm_name ?? '');
  const holderPmName = lock?.pmName === undefined ? '' : String(lock.pmName);
  return !holderPmId || holderPmId === currentPmId || (currentPmName && holderPmName === currentPmName);
}

function replaceLockHolder(pid) {
  try {
    process.kill(pid, 'TERM');
  } catch {
    return false;
  }

  for (let i = 0; i < 15; i++) {
    if (!pidAlive(pid)) return true;
    waitSync(100);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }

  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pid)) return true;
    waitSync(100);
  }

  return false;
}

function acquireDaemonLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

  const lockPayload = (extra = {}) => JSON.stringify({
    pid: process.pid,
    pmId: process.env.pm_id ?? null,
    pmName: process.env.name ?? process.env.pm_name ?? null,
    startedAt: new Date().toISOString(),
    ...extra,
  }) + '\n';

  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, lockPayload());
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let existingPid = 0;
  let existingLock = {};
  try {
    existingLock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    existingPid = Number(existingLock.pid || 0);
  } catch {
    existingPid = 0;
    existingLock = {};
  }

  if (existingPid && pidAlive(existingPid)) {
    if (shouldReplaceLockHolder(existingLock, existingPid)) {
      appendStatus({ event: 'lock_takeover', pid: process.pid, holderPid: existingPid });
      const replaced = replaceLockHolder(existingPid);
      if (!replaced || pidAlive(existingPid)) {
        appendStatus({ event: 'lock_held', pid: process.pid, holderPid: existingPid });
        return false;
      }
    } else {
      appendStatus({ event: 'lock_held', pid: process.pid, holderPid: existingPid });
      return false;
    }
  }

  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const fd = fs.openSync(LOCK_PATH, 'wx');
  fs.writeFileSync(fd, lockPayload({ replacedStalePid: existingPid || null }));
  fs.closeSync(fd);
  return true;
}

function releaseDaemonLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (Number(lock.pid || 0) === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    // Best effort only; stale locks are handled on the next start.
  }
}

async function waitForDaemonLock() {
  while (!acquireDaemonLock()) {
    console.log('[pm2-watchdog-daemon] another watchdog owns the repair lock; waiting to take over');
    await sleep(DUPLICATE_LOCK_RETRY_MS);
  }
}

async function main() {
  if (watchdogDaemonDisabled()) {
    appendStatus({ event: 'disabled', pid: process.pid });
    console.log('[pm2-watchdog-daemon] disabled; one-shot watchdog remains available via scripts/home23-pm2-watchdog.cjs');
    return;
  }

  const args = parseArgs(process.argv);
  const agents = args.agents.length ? args.agents : discoverAgents(ROOT);
  if (agents.length === 0) throw new Error('No Home23 agent triplets found in ecosystem.config.cjs');

  if (!acquireDaemonLock()) {
    if (duplicateLockMode() === 'exit') {
      console.log('[pm2-watchdog-daemon] another watchdog owns the repair lock; exiting duplicate');
      return;
    }
    await waitForDaemonLock();
  }

  process.once('exit', releaseDaemonLock);
  process.once('SIGINT', () => {
    releaseDaemonLock();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    releaseDaemonLock();
    process.exit(143);
  });

  appendStatus({ event: 'start', agents, intervalMs: args.intervalMs });
  console.log(`[pm2-watchdog-daemon] watching ${agents.join(', ')} every ${args.intervalMs}ms`);
  let running = false;

  const tick = () => {
    if (running) return;
    running = true;
    appendStatus({ event: 'tick_start', agents });
    try {
      for (const agent of agents) {
        try {
          const output = runWatchdog(agent);
          appendStatus({ event: 'agent_ok', agent });
          if (output) console.log(output);
        } catch (err) {
          const stderr = err?.stderr ? String(err.stderr).trim() : '';
          const stdout = err?.stdout ? String(err.stdout).trim() : '';
          appendStatus({ event: 'agent_error', agent, error: stderr || stdout || err.message || String(err) });
          console.error(`[pm2-watchdog-daemon] ${agent} failed: ${stderr || stdout || err.message || err}`);
        }
      }
    } finally {
      appendStatus({ event: 'tick_end', agents });
      running = false;
    }
  };

  tick();
  setInterval(tick, args.intervalMs);
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined || process.env.pm_id !== undefined) {
  main().catch((err) => {
    console.error(`[pm2-watchdog-daemon] fatal: ${err.stack || err.message || err}`);
    process.exit(2);
  });
}

module.exports = { discoverAgents, parseArgs, duplicateLockMode, watchdogDaemonDisabled, shouldReplaceLockHolder, shouldReplaceLockHolderWithCommand };
