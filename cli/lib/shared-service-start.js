import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SHARED_SERVICES = Object.freeze([
  Object.freeze({ name: 'home23-evobrew', label: 'Evobrew' }),
  Object.freeze({ name: 'home23-cosmo23', label: 'COSMO 2.3' }),
  Object.freeze({ name: 'home23-screenlogic', label: 'ScreenLogic bridge' }),
]);

export function isSharedServiceName(name) {
  return SHARED_SERVICES.some((service) => service.name === name);
}

const LOCK_SCHEMA = 'home23.shared-service-start.lock.v1';
const RECEIPT_SCHEMA = 'home23.shared-service-start.receipt.v1';
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

const waitDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const activeLockReleases = new Map();

function ownerPathFor(lockPath, token) {
  const safeToken = String(token).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(lockPath, `owner-${safeToken}.json`);
}

function readLockOwner(lockPath) {
  try {
    const ownerFile = readdirSync(lockPath).find((name) => /^owner-.*\.json$/.test(name));
    if (!ownerFile) return null;
    return JSON.parse(readFileSync(join(lockPath, ownerFile), 'utf8'));
  } catch {
    return null;
  }
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'operation failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|authorization|secret)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function callerIdentity(processId) {
  return {
    pid: processId,
    source: 'home23-shared-service-start',
  };
}

export async function acquireStartupLock({
  lockPath,
  home23Root,
  timeoutMs,
  pollMs,
  staleLockAgeMs,
  dependencies,
}) {
  const startedAtMs = dependencies.now();
  const token = dependencies.randomId();
  const timeout = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 30_000;
  const poll = Number.isFinite(Number(pollMs)) ? Number(pollMs) : 100;
  const staleMs = Math.max(
    Number.isFinite(Number(staleLockAgeMs)) ? Number(staleLockAgeMs) : 120_000,
    2_000,
  );
  const heartbeatMs = Math.max(1_000, Math.floor(staleMs / 2));
  let recovered = 0;
  const owner = {
    schema: LOCK_SCHEMA,
    token,
    ...callerIdentity(dependencies.processId),
    createdAt: new Date(startedAtMs).toISOString(),
    home23Root,
  };

  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      // mkdir is the atomic ownership claim. The token-specific owner file
      // makes release safe even if a stale takeover happens while an old
      // process is unwinding.
      mkdirSync(lockPath, { recursive: false, mode: 0o700 });
      try {
        writeFileSync(ownerPathFor(lockPath, token), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      const heartbeat = setInterval(() => {
        try {
          if (!existsSync(ownerPathFor(lockPath, token))) return;
          const now = new Date();
          utimesSync(lockPath, now, now);
        } catch {
          // Release or stale takeover owns cleanup after the path moves.
        }
      }, heartbeatMs);
      heartbeat.unref?.();
      activeLockReleases.set(token, { lockPath, heartbeat });
      return {
        lockPath,
        token,
        owner,
        waitMs: dependencies.now() - startedAtMs,
        staleLocksRecovered: recovered,
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }

      if (ageMs >= staleMs) {
        const quarantinePath = `${lockPath}.stale-${String(token).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        try {
          // Atomic rename claims this exact stale directory. A contender that
          // moved/replaced it first produces ENOENT and is left untouched.
          renameSync(lockPath, quarantinePath);
          rmSync(quarantinePath, { recursive: true, force: true });
          recovered += 1;
        } catch (recoverError) {
          if (recoverError.code !== 'ENOENT' && recoverError.code !== 'EEXIST') throw recoverError;
        }
        continue;
      }

      if (dependencies.now() - startedAtMs >= timeout) {
        const current = readLockOwner(lockPath);
        throw new Error(
          `Timed out waiting for shared-service startup lock owned by pid ${current?.pid || 'unknown'}`,
        );
      }
      await dependencies.wait(poll);
    }
  }
}

export function releaseStartupLock(lockPath, token) {
  const active = activeLockReleases.get(token);
  if (!active || active.lockPath !== lockPath) return false;
  activeLockReleases.delete(token);
  clearInterval(active.heartbeat);
  try {
    // Refresh before the atomic owner-file rename so a stale contender cannot
    // treat a normal release as an expired lease. If takeover already won,
    // rename fails and we never touch the replacement directory.
    const now = new Date();
    utimesSync(lockPath, now, now);
    const releasedPath = join(lockPath, `released-${String(token).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    renameSync(ownerPathFor(lockPath, token), releasedPath);
    unlinkSync(releasedPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTEMPTY') return false;
    throw error;
  }
}

export async function coordinateSharedServiceStartup(options) {
  const home23Root = options.home23Root;
  const lockPath = options.lockPath || join(tmpdir(), 'home23', 'shared-service-start.lock');
  const receiptPath = options.receiptPath || join(home23Root, 'logs', 'shared-service-startup.jsonl');
  const dependencies = {
    listProcesses: listProcessesDefault,
    startService: (service) => startServiceDefault(service, home23Root),
    restartService: (service) => restartServiceDefault(service, home23Root),
    appendReceipt: (receipt) => appendReceiptDefault(receiptPath, receipt),
    wait: waitDefault,
    now: Date.now,
    randomId: randomUUID,
    processId: process.pid,
    warn: (message) => console.warn(message),
    ...options.dependencies,
  };
  const receipt = {
    schema: RECEIPT_SCHEMA,
    recordedAt: new Date(dependencies.now()).toISOString(),
    caller: callerIdentity(dependencies.processId),
    services: [],
    ok: false,
  };
  let lock;
  let failure;

  try {
    lock = await acquireStartupLock({
      lockPath,
      home23Root,
      timeoutMs: options.lockTimeoutMs ?? 30_000,
      pollMs: options.pollMs ?? 100,
      staleLockAgeMs: options.staleLockAgeMs ?? 120_000,
      dependencies,
    });
    receipt.lock = {
      waitMs: lock.waitMs,
      staleLocksRecovered: lock.staleLocksRecovered,
    };

    for (const service of options.services || SHARED_SERVICES) {
      const before = exactRecords(await dependencies.listProcesses(), service.name);
      if (before.length > 1) {
        const message = `Duplicate PM2 records for ${service.name}`;
        const summary = summarizeRecords(before);
        receipt.services.push({
          name: service.name,
          before: summary,
          action: 'failed',
          after: summary,
          error: message,
        });
        throw new Error(message);
      }
      const restartOnline = isOnline(before[0]) && options.restartOnline === true;
      if (isOnline(before[0]) && !restartOnline) {
        const beforeSummary = summarizeRecords(before);
        receipt.services.push({
          name: service.name,
          before: beforeSummary,
          action: 'already-online',
          after: beforeSummary,
        });
        continue;
      }

      const serviceReceipt = {
        name: service.name,
        before: summarizeRecords(before),
        action: restartOnline ? 'restarting' : 'starting',
        after: [],
      };
      receipt.services.push(serviceReceipt);
      try {
        if (restartOnline) await dependencies.restartService(service);
        else await dependencies.startService(service);
        const after = await waitForOnline(
          service.name,
          dependencies,
          options.startupTimeoutMs ?? 15_000,
          options.pollMs ?? 100,
        );
        serviceReceipt.after = summarizeRecords(after);
        serviceReceipt.action = restartOnline ? 'restarted' : 'started';
      } catch (error) {
        serviceReceipt.action = 'failed';
        serviceReceipt.error = safeErrorMessage(error);
        try {
          serviceReceipt.after = summarizeRecords(
            exactRecords(await dependencies.listProcesses(), service.name),
          );
        } catch (afterError) {
          serviceReceipt.afterError = safeErrorMessage(afterError);
        }
        throw error;
      }
    }
    receipt.ok = true;
  } catch (error) {
    failure = error;
    receipt.error = safeErrorMessage(error);
  } finally {
    if (lock) {
      try {
        await releaseStartupLock(lockPath, lock.token);
      } catch (error) {
        if (!failure) failure = error;
        receipt.ok = false;
        receipt.error = safeErrorMessage(error);
      }
    }
    try {
      await dependencies.appendReceipt(receipt);
    } catch (error) {
      dependencies.warn(`[shared-service-start] receipt write failed: ${safeErrorMessage(error)}`);
    }
  }

  if (failure) throw failure;
  return receipt;
}

function exactRecords(processes, name) {
  return processes.filter((entry) => entry.name === name);
}

function isOnline(entry) {
  return entry?.pm2_env?.status === 'online' && Number(entry.pid) > 0;
}

function summarizeRecords(records) {
  return records.map((entry) => ({
    name: entry.name,
    pid: Number(entry.pid) || 0,
    pmId: entry.pm_id,
    status: entry.pm2_env?.status || 'unknown',
    restarts: Number(entry.pm2_env?.restart_time) || 0,
    script: entry.pm2_env?.pm_exec_path,
    cwd: entry.pm2_env?.pm_cwd,
  }));
}

async function waitForOnline(name, dependencies, timeoutMs, pollMs) {
  const deadline = dependencies.now() + timeoutMs;
  for (;;) {
    const records = exactRecords(await dependencies.listProcesses(), name);
    if (records.length > 1) throw new Error(`Duplicate PM2 records for ${name}`);
    if (isOnline(records[0])) return records;
    if (dependencies.now() >= deadline) {
      throw new Error(`Timed out waiting for ${name} to become online`);
    }
    await dependencies.wait(pollMs);
  }
}

function parsePm2List(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next suffix because PM2 can print startup chatter before JSON.
    }
  }
  throw new Error('pm2 jlist did not return a JSON process list');
}

function cleanCommandEnv(source = process.env) {
  const env = { ...source };
  for (const key of PM2_ENV_BLOCKLIST) delete env[key];
  return env;
}

export function startEcosystemProcesses({
  home23Root,
  names,
  env = process.env,
  execFile = execFileSync,
  stdio = 'pipe',
  timeoutMs = 45_000,
}) {
  return runEcosystemProcessCommand('start', {
    home23Root,
    names,
    env,
    execFile,
    stdio,
    timeoutMs,
  });
}

export function restartEcosystemProcesses({
  home23Root,
  names,
  env = process.env,
  execFile = execFileSync,
  stdio = 'pipe',
  timeoutMs = 45_000,
}) {
  return runEcosystemProcessCommand('restart', {
    home23Root,
    names,
    env,
    execFile,
    stdio,
    timeoutMs,
  });
}

function runEcosystemProcessCommand(command, {
  home23Root,
  names,
  allowShared,
  env,
  execFile,
  stdio,
  timeoutMs,
}) {
  if (command !== 'start' && command !== 'restart') {
    throw new Error(`Unsupported PM2 ecosystem command: ${command}`);
  }
  const exactNames = [...new Set(names || [])];
  if (exactNames.length === 0) return [];
  if (exactNames.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name))) {
    throw new Error('PM2 process names must be lowercase alphanumeric with hyphens');
  }
  if (!allowShared && exactNames.some(isSharedServiceName)) {
    const sharedName = exactNames.find(isSharedServiceName);
    throw new Error(`Refusing generic PM2 mutation for shared service: ${sharedName}`);
  }

  const unsetArgs = PM2_ENV_BLOCKLIST.flatMap((key) => ['-u', key]);
  execFile('env', [
    ...unsetArgs,
    'pm2',
    command,
    join(home23Root, 'ecosystem.config.cjs'),
    '--only',
    exactNames.join(','),
    '--update-env',
    '--silent',
  ], {
    cwd: home23Root,
    env: cleanCommandEnv(env),
    stdio,
    timeout: timeoutMs,
  });
  return exactNames;
}

async function listProcessesDefault() {
  return parsePm2List(execFileSync('pm2', ['jlist'], {
    encoding: 'utf8',
    env: cleanCommandEnv(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: 8_000,
  }));
}

async function startServiceDefault(service, home23Root) {
  runEcosystemProcessCommand('start', {
    home23Root,
    names: [service.name],
    allowShared: true,
    env: process.env,
    execFile: execFileSync,
    stdio: 'pipe',
    timeoutMs: 45_000,
  });
}

async function restartServiceDefault(service, home23Root) {
  runEcosystemProcessCommand('restart', {
    home23Root,
    names: [service.name],
    allowShared: true,
    env: process.env,
    execFile: execFileSync,
    stdio: 'pipe',
    timeoutMs: 45_000,
  });
}

async function appendReceiptDefault(receiptPath, receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true });
  appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
}
