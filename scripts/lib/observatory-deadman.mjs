import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const THRESHOLD = 3;
export const COOLDOWN_MS = 30 * 60_000;
export const initialState = () => ({ version: 1, failures: 0, incident: null, lastRestartAt: null });

// Pure decisions: no process, HTTP, credentials, clock or filesystem access.
export function advance(previous, healthy, now) {
  const state = structuredClone(previous);
  const actions = [];
  if (healthy) {
    if (state.incident?.alerted) actions.push('recovery');
    state.failures = 0;
    state.incident = null;
  } else {
    state.failures = Math.min(THRESHOLD, state.failures + 1);
    if (state.failures === THRESHOLD) {
      if (!state.incident) {
        state.incident = { alerted: false, restartAttempted: false };
        actions.push('outage');
      }
      if (!state.incident.restartAttempted &&
          (state.lastRestartAt === null || now - state.lastRestartAt >= COOLDOWN_MS)) {
        state.incident.restartAttempted = true;
        state.lastRestartAt = now;
        actions.unshift('restart');
      }
    }
  }
  return { state, actions };
}

export function validateState(state) {
  if (state?.version !== 1 || !Number.isInteger(state.failures) || state.failures < 0 || state.failures > THRESHOLD ||
      !(state.lastRestartAt === null || (Number.isFinite(state.lastRestartAt) && state.lastRestartAt >= 0)) ||
      !(state.incident === null || (typeof state.incident?.alerted === 'boolean' && typeof state.incident?.restartAttempted === 'boolean')) ||
      (state.incident !== null && state.failures !== THRESHOLD)) {
    throw new Error('Invalid deadman state; refusing to reset incident suppression');
  }
  return state;
}

const log = (message) => console.log(`${new Date().toISOString()} [deadman] ${message}`);
const root = resolve(process.env.HOME23_ROOT || fileURLToPath(new URL('../../', import.meta.url)));
const pm2 = process.env.PM2_BIN || '/opt/homebrew/bin/pm2';
const command = (bin, args) => execFileSync(bin, args, {
  cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
});

export async function probe(url = 'http://127.0.0.1:5050/healthz') {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000), redirect: 'error' });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    return await response.text() === 'ok\n';
  } catch { return false; }
}

function bridgeToken() {
  // Read at use, resolve by app NAME, never a frozen PM2 id; never log tokens.
  try {
    const apps = JSON.parse(command(pm2, ['jlist']));
    for (const name of ['home23-jerry-harness', 'home23-forrest-harness', 'home23-evobrew']) {
      const app = apps.find((item) => item.name === name);
      if (app?.pm_id === undefined) continue;
      try {
        const env = command(pm2, ['env', String(app.pm_id)]);
        const token = env.match(/^(?:HOME23_)?BRIDGE_TOKEN:\s*(\S+)/m)?.[1];
        if (token) return token;
      } catch { /* Try the next existing bridge provider. */ }
    }
  } catch { /* Delivery can still work on a bridge without authentication. */ }
  return '';
}

async function notify(kind) {
  const outage = kind === 'outage';
  const token = bridgeToken();
  try {
    const response = await fetch('http://127.0.0.1:5004/api/notify', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6_000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        text: outage
          ? '🚨 [deadman] Observatory monitoring is unavailable: three consecutive local health checks failed.'
          : '✅ [deadman] Observatory monitoring is available again: the local health check recovered.',
        severity: outage ? 'alert' : 'notice', source: 'organ-sentinel', requiresAction: outage, isFailure: outage,
      }),
    });
    await response.body?.cancel();
    const accepted = [200, 201, 204].includes(response.status);
    log(`${kind} notification ${accepted ? 'accepted' : 'FAILED'} (bridge ${response.status})`);
    return accepted;
  } catch {
    log(`${kind} notification FAILED (delivery unknown; no automatic duplicate)`);
    return false;
  }
}

export async function main() {
  const directory = resolve(root, 'instances/.house/observatory-deadman');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Same heartbeat/stale-lock library used by guarded-pm2-save. A killed
  // invocation cannot disable the watchdog permanently after a reboot.
  const lockfile = createRequire(import.meta.url)('proper-lockfile');
  let release;
  try {
    release = await lockfile.lock(directory, { stale: 120_000, update: 10_000, retries: 0 });
  } catch (error) {
    if (error.code !== 'ELOCKED') throw error;
    log('another invocation holds the watchdog lock; skipping');
    return;
  }
  try {
    const path = resolve(directory, 'state.json');
    let previous;
    try { previous = validateState(JSON.parse(readFileSync(path, 'utf8'))); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      previous = initialState();
    }
    const save = (state) => {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    };
    const healthy = await probe();
    const { state, actions } = advance(previous, healthy, Date.now());
    // Persist action reservations BEFORE effects, including recovery suppression.
    save(state);
    if (!healthy) log(`health unavailable (${state.failures}/${THRESHOLD} consecutive failures)`);
    for (const action of actions) {
      if (action === 'restart') {
        try {
          command(pm2, ['restart', 'home23-seed-observatory', '--update-env']);
          log('scoped restart command succeeded; awaiting a healthy check');
        } catch { log('scoped restart FAILED; incident remains open'); }
      } else {
        const accepted = await notify(action);
        if (action === 'outage' && accepted) {
          state.incident.alerted = true;
          save(state);
        }
      }
    }
  } finally { await release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { log('watchdog FAILED; inspect local state/permissions (state was not reset)'); process.exitCode = 1; });
}
