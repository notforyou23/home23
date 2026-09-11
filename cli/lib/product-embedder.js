/** Host-owned semantic preparation and /ready probes. Does not author the encoder. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { embedderCacheDir, privateJSON, productEnvironment, readPrivateJSON } from './product-environment.js';
import { OWNED_RECIPE_ID } from '../../scripts/embedder/recipe.mjs';

export const OWNED_EMBEDDER_PROCESS = 'home23-embedder';
export const OWNED_RECIPE_HASH = OWNED_RECIPE_ID;
export const OWNED_PROFILE_ID = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';
export const SEMANTIC_PHASES = Object.freeze(['downloading', 'verifying', 'warming', 'ready', 'interrupted', 'failed']);
export const WORKER_LEASE_MS = 8000;
const PREP_SCHEMA = 'home23.semantic-prep.v1';
const workerPath = fileURLToPath(new URL('../../scripts/product/semantic-prepare-worker.mjs', import.meta.url));

export function semanticPrepPath(homeRoot) {
  return join(homeRoot, 'runtime', 'semantic-prep.json');
}

export function encoderRequiredFor(state) {
  return state?.schema === 'home23.host.v2' && state.encoderRequired === true;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readSemanticPrep(homeRoot) {
  const prep = readPrivateJSON(semanticPrepPath(homeRoot));
  if (!prep) return null;
  if (prep.schema !== PREP_SCHEMA || prep.homeRoot !== homeRoot) throw new Error('The saved semantic preparation belongs to another home.');
  return prep;
}

export function writeSemanticPrep(homeRoot, value) {
  privateJSON(semanticPrepPath(homeRoot), { ...value, schema: PREP_SCHEMA, homeRoot, updatedAt: new Date().toISOString() });
}

function leaseHolds(prep, now = Date.now()) {
  if (!prep || Number.isInteger(prep.workerPid) && prep.workerPid > 0) return false;
  const until = Date.parse(prep.workerLeaseUntil || '');
  return Number.isFinite(until) && until > now;
}

export function reconcileSemanticPrep(homeRoot, { now = Date.now() } = {}) {
  const prep = readSemanticPrep(homeRoot);
  if (!prep) return null;
  if (['ready', 'failed'].includes(prep.phase)) return prep;
  if (['downloading', 'verifying', 'warming'].includes(prep.phase)) {
    if (alive(prep.workerPid) || leaseHolds(prep, now)) return prep;
    const interrupted = { ...prep, phase: 'interrupted', workerPid: 0, workerLeaseUntil: undefined, error: prep.error || 'Semantic preparation was interrupted. Resume to continue with this home.' };
    writeSemanticPrep(homeRoot, interrupted);
    return interrupted;
  }
  return prep;
}

export async function probeOwnedReady(port, { request, timeoutMs = 2500 } = {}) {
  if (!Number.isInteger(port) || port < 20000 || port > 60999 || port === 11435) return { ok: false, warm: false };
  const url = `http://127.0.0.1:${port}/ready`;
  try {
    const get = request || (async target => {
      const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs), headers: { host: `127.0.0.1:${port}` } });
      const body = await response.json();
      return { status: response.status, body };
    });
    const { status, body } = await get(url);
    const warm = body?.warm === true && body.recipeId === OWNED_RECIPE_HASH && body.dimension === 768 && status === 200;
    return { ok: warm, warm, recipeId: body?.recipeId, dimension: body?.dimension, artifactDigests: body?.artifactDigests, lastError: body?.lastError, pid: body?.pid };
  } catch { return { ok: false, warm: false }; }
}

/** After desiredRunning=false, GET /ready must not stay warm. SIGTERM the /ready pid
 * if PM2 stop left the listener. Still-warm after the wait is a failed Stop. */
export async function ensureOwnedEncoderStopped(state, {
  probe = probeOwnedReady,
  signalProcess = (pid, signal) => process.kill(pid, signal),
  sleep: wait = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 4000,
} = {}) {
  if (!encoderRequiredFor(state)) return { warm: false, signaled: false };
  const port = state.ports?.embedder;
  const readyProbeMs = 2500;
  let ready = await probe(port, { timeoutMs: readyProbeMs });
  if (!ready.warm) return { warm: false, signaled: false };
  const pid = Number.isInteger(ready.pid) && ready.pid > 0 ? ready.pid : 0;
  if (pid) {
    try { signalProcess(pid, 'SIGTERM'); } catch { /* already gone or ORT aborting */ }
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await wait(100);
    ready = await probe(port, { timeoutMs: readyProbeMs });
    if (!ready.warm) return { warm: false, signaled: pid > 0 };
  }
  const error = new Error('The owned encoder is still answering /ready after Stop.');
  error.code = 'host_encoder_still_warm';
  throw error;
}

export function semanticStatusView(homeRoot, state) {
  if (!encoderRequiredFor(state)) return { encoderRequired: false, semanticReady: false };
  const prep = reconcileSemanticPrep(homeRoot);
  return {
    encoderRequired: true,
    handle: prep?.handle,
    phase: prep?.phase,
    bytesReceived: prep?.bytesReceived,
    bytesTotal: prep?.bytesTotal,
    semanticReady: prep?.phase === 'ready',
    recipeId: prep?.recipeId || OWNED_RECIPE_HASH,
    error: prep?.error,
  };
}

export function beginPhase(homeRoot, phase, extra = {}) {
  const prep = readSemanticPrep(homeRoot);
  if (!prep) throw new Error('Semantic preparation has no saved handle.');
  writeSemanticPrep(homeRoot, { ...prep, phase, error: undefined, ...extra });
}

export function failPrep(homeRoot, code, message) {
  const prep = readSemanticPrep(homeRoot) || { handle: 'unknown' };
  writeSemanticPrep(homeRoot, { ...prep, phase: 'failed', workerPid: 0, error: message || code });
}

export function finishReady(homeRoot) {
  const prep = readSemanticPrep(homeRoot);
  if (!prep) throw new Error('Semantic preparation has no saved handle.');
  writeSemanticPrep(homeRoot, { ...prep, phase: 'ready', workerPid: 0, error: undefined, recipeId: OWNED_RECIPE_HASH });
}

export function beginSemanticPrepare(homeRoot, state, { spawnWorker = spawn, nodePath } = {}) {
  if (!encoderRequiredFor(state)) throw new Error('This home does not use the owned encoder.');
  const existing = reconcileSemanticPrep(homeRoot);
  if (existing?.phase === 'ready') return existing;
  if (existing && ['downloading', 'verifying', 'warming'].includes(existing.phase)
    && (alive(existing.workerPid) || leaseHolds(existing))) {
    return existing;
  }
  const cache = embedderCacheDir(homeRoot);
  if (cache === process.env.HOME || cache.includes('/release/home23')) throw new Error('HOME23_EMBEDDER_CACHE must be this home\'s runtime cache.');
  const handle = existing?.handle || randomUUID();
  const env = productEnvironment(homeRoot, { prepare: true, encoderRequired: true, embedderPort: state.ports.embedder });
  const interpreter = nodePath || join(homeRoot, 'bin', 'node');
  const workerArgv = [interpreter, workerPath, '--home', homeRoot];
  const record = {
    schema: PREP_SCHEMA, handle, homeRoot, phase: 'downloading', cacheDir: cache,
    port: state.ports.embedder, recipeId: OWNED_RECIPE_HASH, workerPid: 0, error: undefined,
    workerArgv, workerLeaseUntil: new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
    startedAt: existing?.startedAt || new Date().toISOString(),
  };
  writeSemanticPrep(homeRoot, record);
  const worker = spawnWorker(interpreter, [workerPath, '--home', homeRoot], {
    cwd: join(homeRoot, 'app'), env, detached: true, stdio: 'ignore',
  });
  worker.unref?.();
  const started = { ...record, workerPid: worker.pid || 0 };
  writeSemanticPrep(homeRoot, started);
  return started;
}
