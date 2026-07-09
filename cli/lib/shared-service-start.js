import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SHARED_SERVICES = Object.freeze([
  Object.freeze({ name: 'home23-evobrew', label: 'Evobrew' }),
  Object.freeze({ name: 'home23-cosmo23', label: 'COSMO 2.3' }),
  Object.freeze({ name: 'home23-screenlogic', label: 'ScreenLogic bridge' }),
]);

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

function pidAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
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
  const owner = {
    schema: LOCK_SCHEMA,
    token,
    pid: dependencies.processId,
    createdAt: new Date(startedAtMs).toISOString(),
    argv: dependencies.argv,
    home23Root,
  };
  let staleLocksRecovered = 0;

  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        lockPath,
        token,
        owner,
        waitMs: dependencies.now() - startedAtMs,
        staleLocksRecovered,
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const current = readLock(lockPath);
      let ageMs = 0;
      try {
        ageMs = dependencies.now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      const stale = current?.pid
        ? !dependencies.pidAlive(Number(current.pid))
        : ageMs >= staleLockAgeMs;

      if (stale) {
        const latest = readLock(lockPath);
        if (latest?.token !== current?.token) continue;
        try {
          unlinkSync(lockPath);
          staleLocksRecovered += 1;
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }

      if (dependencies.now() - startedAtMs >= timeoutMs) {
        throw new Error(
          `Timed out waiting for shared-service startup lock owned by pid ${current?.pid || 'unknown'}`,
        );
      }
      await dependencies.wait(pollMs);
    }
  }
}

export function releaseStartupLock(lockPath, token) {
  const current = readLock(lockPath);
  if (!current || current.token !== token) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
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
    appendReceipt: (receipt) => appendReceiptDefault(receiptPath, receipt),
    pidAlive: pidAliveDefault,
    wait: waitDefault,
    now: Date.now,
    randomId: randomUUID,
    processId: process.pid,
    argv: process.argv,
    warn: (message) => console.warn(message),
    ...options.dependencies,
  };
  const receipt = {
    schema: RECEIPT_SCHEMA,
    recordedAt: new Date(dependencies.now()).toISOString(),
    caller: { pid: dependencies.processId, argv: dependencies.argv },
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
      if (before.length > 1) throw new Error(`Duplicate PM2 records for ${service.name}`);
      if (isOnline(before[0])) {
        receipt.services.push({
          name: service.name,
          before,
          action: 'already-online',
          after: before,
        });
        continue;
      }

      await dependencies.startService(service);
      const after = await waitForOnline(
        service.name,
        dependencies,
        options.startupTimeoutMs ?? 15_000,
        options.pollMs ?? 100,
      );
      receipt.services.push({ name: service.name, before, action: 'started', after });
    }
    receipt.ok = true;
  } catch (error) {
    failure = error;
    receipt.error = error.message;
  } finally {
    if (lock) releaseStartupLock(lockPath, lock.token);
    try {
      await dependencies.appendReceipt(receipt);
    } catch (error) {
      dependencies.warn(`[shared-service-start] receipt write failed: ${error.message}`);
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

function cleanCommandEnv() {
  const env = { ...process.env };
  for (const key of PM2_ENV_BLOCKLIST) delete env[key];
  return env;
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
  const unsetArgs = PM2_ENV_BLOCKLIST.flatMap((key) => ['-u', key]);
  execFileSync('env', [
    ...unsetArgs,
    'pm2',
    'start',
    join(home23Root, 'ecosystem.config.cjs'),
    '--only',
    service.name,
    '--update-env',
    '--silent',
  ], {
    cwd: home23Root,
    env: cleanCommandEnv(),
    stdio: 'pipe',
    timeout: 45_000,
  });
}

async function appendReceiptDefault(receiptPath, receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true });
  appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
}
