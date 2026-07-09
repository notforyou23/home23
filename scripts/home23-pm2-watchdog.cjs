#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ECOSYSTEM_PATH = path.join(ROOT, 'ecosystem.config.cjs');
const LEGACY_DASHBOARD_PORT = '3344';
const START_TIMEOUT_MS = 15_000;
const PM2_COMMAND_TIMEOUT_MS = 8_000;
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
];
const PM2_ENV_UNSET_ARGS = PM2_ENV_BLOCKLIST.flatMap((key) => ['-u', key]);
const SHARED_SERVICE_NAMES = new Set([
  'home23-evobrew',
  'home23-cosmo23',
  'home23-screenlogic',
]);

function cleanCommandEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of PM2_ENV_BLOCKLIST) delete env[key];
  return env;
}

function parseArgs(argv) {
  const args = { agent: process.env.HOME23_AGENT || '', repair: false, json: false, save: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repair') args.repair = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--save') args.save = true;
    else if (arg === '--agent') args.agent = argv[++i] || '';
    else if (arg.startsWith('--agent=')) args.agent = arg.slice('--agent='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.agent) throw new Error('Missing --agent or HOME23_AGENT');
  return args;
}

function loadExpectedContract(agent, root = ROOT) {
  const ecosystemPath = path.join(root, 'ecosystem.config.cjs');
  delete require.cache[require.resolve(ecosystemPath)];
  const ecosystem = require(ecosystemPath);
  const apps = Array.isArray(ecosystem.apps) ? ecosystem.apps : [];
  const roleNames = {
    engine: `home23-${agent}`,
    dashboard: `home23-${agent}-dash`,
    harness: `home23-${agent}-harness`,
  };
  const byName = new Map(apps.map((app) => [app.name, app]));
  const engine = byName.get(roleNames.engine);
  const dashboard = byName.get(roleNames.dashboard);
  const harness = byName.get(roleNames.harness);
  if (!engine || !dashboard || !harness) {
    throw new Error(`ecosystem.config.cjs does not define full PM2 triplet for ${agent}`);
  }

  const dashEnv = dashboard.env || {};
  const engineEnv = engine.env || {};
  const dashboardPort = String(dashEnv.DASHBOARD_PORT || dashEnv.COSMO_DASHBOARD_PORT || '');
  const realtimePort = String(engineEnv.REALTIME_PORT || '');
  if (!dashboardPort) throw new Error(`Missing dashboard port for ${roleNames.dashboard}`);

  return {
    root,
    agent,
    ecosystemPath,
    roles: {
      engine: { name: roleNames.engine, app: engine, requiredEnv: pickEnv(engineEnv, ['HOME23_AGENT', 'DASHBOARD_PORT', 'COSMO_DASHBOARD_PORT', 'REALTIME_PORT', 'MCP_HTTP_PORT']) },
      dashboard: { name: roleNames.dashboard, app: dashboard, requiredEnv: pickEnv(dashEnv, ['HOME23_AGENT', 'DASHBOARD_PORT', 'COSMO_DASHBOARD_PORT', 'REALTIME_PORT', 'MCP_HTTP_PORT']) },
      harness: { name: roleNames.harness, app: harness, requiredEnv: pickEnv(harness.env || {}, ['HOME23_AGENT', 'DASHBOARD_PORT', 'COSMO_DASHBOARD_PORT', 'REALTIME_PORT', 'MCP_HTTP_PORT']) },
    },
    dashboardPort,
    realtimePort,
    legacyDashboardPort: LEGACY_DASHBOARD_PORT,
  };
}

function pickEnv(env, keys) {
  const out = {};
  for (const key of keys) {
    if (env[key] !== undefined) out[key] = String(env[key]);
  }
  return out;
}

function inspectContract(expected, observed) {
  const pm2List = Array.isArray(observed.pm2List) ? observed.pm2List : [];
  const listeners = Array.isArray(observed.listeners) ? observed.listeners : [];
  const isPidAlive = typeof observed.pidAlive === 'function' ? observed.pidAlive : () => true;
  const issues = [];
  const pm2ByName = groupBy(pm2List, (proc) => proc.name);

  for (const [role, spec] of Object.entries(expected.roles)) {
    const records = pm2ByName.get(spec.name) || [];
    if (records.length === 0) {
      issues.push({ type: 'pm2_missing', role, name: spec.name, repair: 'start_triplet' });
      continue;
    }
    if (records.length > 1) {
      issues.push({ type: 'pm2_duplicate', role, name: spec.name, pids: records.map((p) => p.pid).filter(Boolean), repair: 'manual' });
    }
    const proc = records[0];
    const status = proc.pm2_env?.status || 'unknown';
    if (status !== 'online') {
      issues.push({ type: 'pm2_not_online', role, name: spec.name, status, repair: 'start_triplet' });
    }
    if (!Number(proc.pid)) {
      issues.push({ type: 'pm2_missing_pid', role, name: spec.name, status, repair: 'start_triplet' });
    } else if (!isPidAlive(Number(proc.pid))) {
      issues.push({ type: 'pm2_pid_dead', role, name: spec.name, pid: Number(proc.pid), status, repair: 'delete_and_start' });
    }
    const env = proc.pm2_env || {};
    for (const [key, expectedValue] of Object.entries(spec.requiredEnv)) {
      const actual = env[key] === undefined ? '' : String(env[key]);
      if (actual !== expectedValue) {
        issues.push({ type: 'pm2_env_mismatch', role, name: spec.name, key, expected: expectedValue, actual, repair: 'delete_and_start' });
      }
    }
    if (env.cron_restart) {
      issues.push({ type: 'pm2_unexpected_cron_restart', role, name: spec.name, cronRestart: String(env.cron_restart), repair: 'delete_and_start' });
    }
  }

  const dashboardProc = (pm2ByName.get(expected.roles.dashboard.name) || [])[0];
  checkPortOwner({
    issues,
    role: 'dashboard',
    name: expected.roles.dashboard.name,
    expectedPid: Number(dashboardProc?.pid || 0),
    port: expected.dashboardPort,
    listeners,
    root: expected.root,
    repair: 'kill_orphan_and_start',
  });

  const engineProc = (pm2ByName.get(expected.roles.engine.name) || [])[0];
  if (expected.realtimePort) {
    checkPortOwner({
      issues,
      role: 'engine',
      name: expected.roles.engine.name,
      expectedPid: Number(engineProc?.pid || 0),
      port: expected.realtimePort,
      listeners,
      root: expected.root,
      repair: 'kill_orphan_and_start',
    });
  }

  if (expected.legacyDashboardPort && expected.legacyDashboardPort !== expected.dashboardPort) {
    for (const listener of listeners.filter((l) => String(l.port) === expected.legacyDashboardPort)) {
      if (isHome23DashboardListener(listener, expected.root)) {
        issues.push({
          type: 'legacy_dashboard_listener',
          role: 'dashboard',
          name: expected.roles.dashboard.name,
          port: expected.legacyDashboardPort,
          pid: Number(listener.pid),
          command: listener.command || '',
          repair: 'kill_orphan',
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    agent: expected.agent,
    expected: {
      roles: Object.fromEntries(Object.entries(expected.roles).map(([role, spec]) => [role, spec.name])),
      dashboardPort: expected.dashboardPort,
      realtimePort: expected.realtimePort,
      legacyDashboardPort: expected.legacyDashboardPort,
    },
    issues,
  };
}

function checkPortOwner({ issues, role, name, expectedPid, port, listeners, root, repair }) {
  const portListeners = listeners.filter((l) => String(l.port) === String(port));
  const pids = portListeners.map((l) => Number(l.pid)).filter(Boolean);
  if (!expectedPid) {
    if (pids.length > 0) {
      for (const listener of portListeners) {
        if (isHome23ProcessListener(listener, root)) {
          issues.push({ type: 'orphan_port_listener', role, name, port: String(port), pid: Number(listener.pid), command: listener.command || '', repair });
        }
      }
    }
    return;
  }
  if (!pids.includes(expectedPid)) {
    issues.push({ type: 'pm2_port_not_owned', role, name, port: String(port), expectedPid, listenerPids: pids, repair });
  }
  for (const listener of portListeners) {
    const pid = Number(listener.pid);
    if (pid && pid !== expectedPid && isHome23ProcessListener(listener, root)) {
      issues.push({ type: 'orphan_port_listener', role, name, port: String(port), pid, command: listener.command || '', repair });
    }
  }
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function isHome23ProcessListener(listener, root) {
  const command = String(listener.command || '');
  return command.includes(root) || command.includes('/engine/src/dashboard/server') || command.includes('/engine/src/index.js');
}

function isHome23DashboardListener(listener, root) {
  const command = String(listener.command || '');
  return command.includes(root) && command.includes('/engine/src/dashboard/server');
}

function planRepair(expected, inspection) {
  const killPids = new Set();
  const deleteNames = new Set();
  const startNames = new Set();
  let startTriplet = false;

  for (const issue of inspection.issues) {
    if (issue.repair === 'manual') continue;
    if (issue.repair === 'kill_orphan' || issue.repair === 'kill_orphan_and_start') {
      if (Number(issue.pid)) killPids.add(Number(issue.pid));
      if (issue.repair === 'kill_orphan_and_start' && issue.name) startNames.add(issue.name);
    }
    if (issue.repair === 'start_triplet') {
      if (issue.name) startNames.add(issue.name);
      else startTriplet = true;
    }
    if (issue.repair === 'delete_and_start') {
      deleteNames.add(issue.name);
      startNames.add(issue.name);
    }
  }

  const roleNames = Object.values(expected.roles).map((role) => role.name);
  return {
    killPids: Array.from(killPids).sort((a, b) => a - b),
    deleteNames: Array.from(deleteNames).sort(),
    startNames: startTriplet
      ? roleNames
      : roleNames.filter((name) => startNames.has(name)),
    manualIssues: inspection.issues.filter((issue) => issue.repair === 'manual'),
  };
}

function collectObserved(expected) {
  const pm2Output = execFileSync('pm2', ['jlist'], {
    encoding: 'utf8',
    env: cleanCommandEnv(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: PM2_COMMAND_TIMEOUT_MS,
  });
  const pm2List = parsePm2JlistOutput(pm2Output);
  const ports = Array.from(new Set([expected.dashboardPort, expected.realtimePort, expected.legacyDashboardPort].filter(Boolean).map(String)));
  const listeners = [];
  for (const port of ports) {
    listeners.push(...collectListenersForPort(port));
  }
  return { pm2List, listeners, pidAlive };
}

function parsePm2JlistOutput(output) {
  const text = String(output || '').trim();
  const lines = text.split(/\r?\n/);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join('\n').trim();
    if (candidate.startsWith('[')) candidates.push(candidate);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate. PM2 can print daemon startup chatter before JSON.
    }
  }

  const sample = text.slice(0, 160).replace(/\s+/g, ' ');
  throw new Error(`pm2 jlist did not return a JSON process list; refusing repair from output: ${sample || '<empty>'}`);
}

function collectListenersForPort(port) {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const lines = output.trim().split(/\r?\n/).slice(1);
  const listeners = [];
  for (const line of lines) {
    const match = line.trim().match(/^(\S+)\s+(\d+)\s+/);
    if (!match) continue;
    const pid = Number(match[2]);
    listeners.push({
      port: String(port),
      pid,
      process: match[1],
      command: commandForPid(pid),
    });
  }
  return listeners;
}

function commandForPid(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function repairContract(expected, plan, options = {}) {
  const actions = [];

  const sharedName = [...plan.deleteNames, ...plan.startNames]
    .find((name) => SHARED_SERVICE_NAMES.has(name));
  if (sharedName) {
    actions.push({
      action: 'pm2_repair_rejected',
      names: plan.startNames,
      error: `shared service requires coordinated startup: ${sharedName}`,
    });
    return actions;
  }

  for (const pid of plan.killPids) {
    actions.push({ action: 'kill', pid });
    try {
      process.kill(pid, 'TERM');
    } catch (err) {
      actions[actions.length - 1].error = err.message;
    }
  }

  if (plan.killPids.length > 0) {
    await sleep(1500);
    for (const pid of plan.killPids) {
      if (pidAlive(pid)) {
        const action = { action: 'kill_force', pid };
        actions.push(action);
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          action.error = err.message;
        }
      }
    }
  }

  for (const name of plan.deleteNames) {
    actions.push({ action: 'pm2_delete', name });
    try {
      execFileSync('pm2', ['delete', name], { cwd: expected.root, env: cleanCommandEnv(), stdio: 'pipe' });
    } catch (err) {
      actions[actions.length - 1].error = commandError(err);
    }
  }

  if (plan.startNames.length > 0) {
    const action = { action: 'pm2_start', names: plan.startNames };
    actions.push(action);
    try {
      execFileSync('env', [...PM2_ENV_UNSET_ARGS, 'pm2', 'start', expected.ecosystemPath, '--only', plan.startNames.join(','), '--update-env', '--silent'], {
        cwd: expected.root,
        env: cleanCommandEnv(),
        stdio: 'pipe',
        timeout: 45_000,
      });
    } catch (err) {
      action.error = commandError(err);
    }
  }

  if (options.save && actions.length > 0) {
    actions.push({ action: 'pm2_save' });
    execFileSync('pm2', ['save'], { cwd: expected.root, env: cleanCommandEnv(), stdio: 'pipe' });
  }

  return actions;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(expected, deadlineMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + deadlineMs;
  let lastInspection = null;
  do {
    await sleep(1000);
    const observed = collectObserved(expected);
    lastInspection = inspectContract(expected, observed);
    if (lastInspection.ok) return lastInspection;
  } while (Date.now() < deadline);
  return lastInspection;
}

function writeReceipt(agent, receipt, root = ROOT) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, 'instances', agent, 'brain', 'evidence', 'pm2-watchdog');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
  return file;
}

function commandError(err) {
  const stderr = err?.stderr ? String(err.stderr).trim() : '';
  const stdout = err?.stdout ? String(err.stdout).trim() : '';
  return stderr || stdout || err.message || String(err);
}

async function main() {
  const args = parseArgs(process.argv);
  const expected = loadExpectedContract(args.agent, ROOT);
  const before = inspectContract(expected, collectObserved(expected));
  const plan = planRepair(expected, before);
  let actions = [];
  let after = before;

  if (!before.ok && args.repair && plan.manualIssues.length === 0) {
    actions = await repairContract(expected, plan, { save: args.save });
    after = await waitForHealthy(expected);
  }

  const receipt = {
    schema: 'home23.pm2-watchdog.receipt.v1',
    agent: args.agent,
    recordedAt: new Date().toISOString(),
    repaired: actions.length > 0,
    ok: Boolean(after?.ok),
    before,
    plan,
    actions,
    after,
  };
  const receiptPath = writeReceipt(args.agent, receipt, ROOT);
  receipt.receiptPath = receiptPath;

  if (args.json) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  } else if (after?.ok) {
    const verb = actions.length > 0 ? 'repaired' : 'healthy';
    process.stdout.write(`[pm2-watchdog] ${args.agent} ${verb}: engine/dashboard/harness online, dashboard:${expected.dashboardPort}, realtime:${expected.realtimePort || 'n/a'}\nreceipt=${receiptPath}\n`);
  } else {
    process.stdout.write(`[pm2-watchdog] ${args.agent} unhealthy: ${after?.issues?.map(describeIssue).join('; ') || 'unknown'}\nreceipt=${receiptPath}\n`);
  }

  process.exit(after?.ok ? 0 : 2);
}

function describeIssue(issue) {
  if (!issue) return 'unknown issue';
  if (issue.type === 'pm2_env_mismatch') return `${issue.name} ${issue.key}=${issue.actual || '<empty>'} expected ${issue.expected}`;
  if (issue.type === 'pm2_port_not_owned') return `${issue.name} not listening on ${issue.port}`;
  if (issue.type === 'orphan_port_listener' || issue.type === 'legacy_dashboard_listener') return `orphan listener pid ${issue.pid} on ${issue.port}`;
  if (issue.type === 'pm2_not_online') return `${issue.name} ${issue.status}`;
  if (issue.type === 'pm2_pid_dead') return `${issue.name} pid ${issue.pid} is not alive`;
  return `${issue.type} ${issue.name || ''}`.trim();
}

module.exports = {
  LEGACY_DASHBOARD_PORT,
  loadExpectedContract,
  inspectContract,
  planRepair,
  parsePm2JlistOutput,
  isHome23ProcessListener,
  isHome23DashboardListener,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[pm2-watchdog] ${err.stack || err.message || err}\n`);
    process.exit(2);
  });
}
