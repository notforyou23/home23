/** Packaged Home23 lifecycle. All operations belong to one installed home. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { absoluteHome, choosePortPlan, privateJSON, productEnvironment, providerEndpoint, readPrivateJSON, socketRootFor, validatePortPlan, withReservedPorts } from './product-environment.js';
import { inspectProductMemory } from './product-memory.js';
import {
  OWNED_EMBEDDER_PROCESS, OWNED_PROFILE_ID, OWNED_RECIPE_HASH,
  beginSemanticPrepare, encoderRequiredFor, ensureOwnedEncoderStopped, probeOwnedReady, semanticStatusView,
} from './product-embedder.js';

const executeFile = promisify(execFile);
const PROVIDERS = new Set(['anthropic', 'openai', 'minimax', 'xai', 'ollama-cloud', 'ollama-local']);
const statePath = root => join(root, '.home23-host.json');
const receiptPath = root => join(root, '.home23-install.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function validateInstallation(root, { full = false } = {}) {
  const { readProductManifest, verifyProductPayload } = await import('./product-payload.js');
  const receipt = readPrivateJSON(receiptPath(root));
  const manifest = readProductManifest(root);
  if (receipt?.schema !== 'home23.product-install.v1' || receipt.status !== 'installed'
    || receipt.homeRoot !== root || receipt.appRoot !== join(root, 'app') || receipt.packageId !== manifest.packageId
    || receipt.nodePath !== join(root, 'bin', 'node') || receipt.pm2Path !== join(root, 'tools', 'node_modules', 'pm2', 'bin', 'pm2')) throw new Error('The Home23 installation receipt does not match this home.');
  if (full) verifyProductPayload(root, { allowRuntimeState: true });
}
function stateFor(root) {
  const state = readPrivateJSON(statePath(root));
  if (!state) return state;
  if (state.homeRoot !== root) throw new Error('This Home23 state belongs to another installation.');
  if (state.schema === 'home23.host.v2') {
    if (state.encoderRequired !== true) throw new Error('This Home23 state belongs to another installation.');
    validatePortPlan(state.ports, { encoderRequired: true });
    return state;
  }
  if (state.schema !== 'home23.host.v1' || state.encoderRequired === true) throw new Error('This Home23 state belongs to another installation.');
  validatePortPlan(state.ports);
  return state;
}
export function ownedProcessNames(name, { encoderRequired = false } = {}) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || '')) throw new Error('Invalid resident name.');
  const names = ['home23-coordination', `home23-${name}`, `home23-${name}-dash`, `home23-${name}-harness`, `home23-${name}-seed`, `home23-${name}-shipper`, 'home23-seed-observatory', 'home23-evobrew'];
  if (encoderRequired) names.push(OWNED_EMBEDDER_PROCESS);
  return names;
}
export function safeProcesses(rows, homeRoot, names) {
  const appRoot = join(homeRoot, 'app');
  return rows.filter(row => names.includes(row.name)).map(row => {
    const env = row.pm2_env || {};
    const script = env.pm_exec_path || '';
    const args = Array.isArray(env.args) ? env.args : [];
    const ownScript = script === join(homeRoot, 'bin', 'node') && args.some(arg => typeof arg === 'string' && arg.startsWith(appRoot + '/'));
    return { name: row.name, status: env.status || 'unknown', pid: row.pid || 0, restarts: env.restart_time || 0,
      owned: ownScript && typeof env.pm_cwd === 'string' && (env.pm_cwd === appRoot || env.pm_cwd.startsWith(appRoot + '/')) };
  });
}
function withoutStartupProfiling(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const flag = String(args[index]).replaceAll('_', '-');
    const profile = /^--(?:cpu|heap)-prof(-[a-z-]+)?(?:=.*)?$/.exec(flag);
    if (!profile) { result.push(args[index]); continue; }
    // Directory, name and interval options can carry a separate value. Drop
    // that value too, while leaving the next independent Node flag intact.
    if (profile[1] && !flag.includes('=') && index + 1 < args.length && !String(args[index + 1]).startsWith('--')) index++;
  }
  return result;
}
export function productDefinitions(apps, homeRoot, name, { encoderRequired = false, embedderPort } = {}) {
  const allowed = ownedProcessNames(name, { encoderRequired });
  const appRoot = join(homeRoot, 'app');
  const nodePath = join(homeRoot, 'bin', 'node');
  const baseEnv = productEnvironment(homeRoot, { encoderRequired, embedderPort });
  return allowed.map(processName => {
    const definition = apps.find(app => app.name === processName);
    if (!definition) throw new Error(`Required Home23 process is not configured: ${processName}`);
    const cwd = resolve(definition.cwd || appRoot);
    const script = isAbsolute(definition.script) ? definition.script : resolve(cwd, definition.script);
    if (!script.startsWith(appRoot + '/') || !(cwd === appRoot || cwd.startsWith(appRoot + '/'))) throw new Error('Home23 process escapes its installed application.');
    const nodeArgs = Array.isArray(definition.node_args) ? definition.node_args : String(definition.node_args || '').split(/\s+/).filter(Boolean);
    const args = Array.isArray(definition.args) ? definition.args : definition.args ? [definition.args] : [];
    // PM2 treats a space anywhere in `script` as a shell command and discards
    // `args`. A relative path avoids that rewrite; prepareAppConf resolves it
    // against this explicit cwd to the exact installation-owned Node binary.
    const executable = relative(cwd, nodePath);
    if (!executable || /\s/.test(executable) || resolve(cwd, executable) !== nodePath) throw new Error('Cannot safely resolve the bundled Home23 executable.');
    return { ...definition, script: executable, interpreter: 'none', node_args: [], args: [...withoutStartupProfiling(nodeArgs), script, ...args], cwd,
      autostart: true, autorestart: true, min_uptime: 10000, max_restarts: 5, restart_delay: 2000,
      env: { ...definition.env, ...baseEnv },
      // No profiling flags or dumps are required to run a user's home.
      filter_env: definition.filter_env || [],
    };
  });
}
function driver(homeRoot, dependencies, state) {
  const encoderRequired = encoderRequiredFor(state);
  const env = productEnvironment(homeRoot, { prepare: true, encoderRequired, embedderPort: state?.ports?.embedder });
  const nodePath = join(homeRoot, 'bin', 'node');
  const pm2Path = join(homeRoot, 'tools', 'node_modules', 'pm2', 'bin', 'pm2');
  const execute = dependencies.execute || executeFile;
  async function pm2(args) {
    try { return await execute(nodePath, [pm2Path, ...args], { cwd: join(homeRoot, 'app'), env, timeout: args[0] === 'stop' ? 240000 : 45000, maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) {
      if (args[0] === 'stop' && String(args[1] || '').includes('embedder')) return { stdout: '' };
      throw new Error(`Home23 process ${args[0]} failed. Check this home's runtime/pm2 logs.`);
    }
  }
  return {
    env,
    async list() {
      if (!dependencies.execute) {
        const pidPath = join(env.PM2_HOME, 'pm2.pid');
        if (!existsSync(pidPath)) return [];
        try { process.kill(Number(readFileSync(pidPath, 'utf8').trim()), 0); } catch { return []; }
      }
      const { stdout } = await pm2(['jlist', '--silent']);
      try { const rows = JSON.parse(stdout); if (!Array.isArray(rows)) throw new Error(); return rows; }
      catch { throw new Error('Home23 supervisor returned an invalid process inventory.'); }
    },
    pm2,
    async definitions(name) {
      const { generateEcosystem } = await import('./generate-ecosystem.js');
      generateEcosystem(join(homeRoot, 'app'), { quiet: true });
      const config = join(homeRoot, 'app', 'ecosystem.config.cjs');
      const { stdout } = await execute(nodePath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).apps))', config], { cwd: join(homeRoot, 'app'), env, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      return productDefinitions(JSON.parse(stdout), homeRoot, name, { encoderRequired, embedderPort: state?.ports?.embedder });
    },
  };
}
const TERMINAL_SESSION_FAILURES = new Map([
  ['refresh_invalid', 401], ['refresh_expired', 401], ['session_inactive', 401],
  ['session_revoked', 401], ['device_revoked', 401], ['refresh_replay_family_revoked', 409],
]);
const ACCESS_FAILURES = new Set(['access_expired', 'access_invalid', 'session_inactive', 'session_revoked', 'device_revoked']);
function terminalSessionFailure(error) { return TERMINAL_SESSION_FAILURES.has(error?.code) && TERMINAL_SESSION_FAILURES.get(error.code) === error.status; }
function recoveryNeeded(reason) {
  return Object.assign(new Error('The Host connection needs recovery. Choose Start to reconnect this Host device.'),
    { code: 'host_session_recovery_required', reason });
}
async function requestJSON(url, { responseType = 'json', ...options } = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2500) });
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { /* An unreadable response is not proof that a session is invalid. */ }
    const error = new Error(`Home23 local API returned HTTP ${response.status}.`);
    error.status = response.status;
    if (typeof body?.error?.code === 'string' && /^[a-z_]{1,80}$/.test(body.error.code)) error.code = body.error.code;
    throw error;
  }
  return responseType === 'text' ? response.text() : response.json();
}
async function withHostSessionLock(homeRoot, operation) {
  const { default: lockfile } = await import('proper-lockfile');
  const runtime = join(homeRoot, 'runtime');
  const release = await lockfile.lock(runtime, { realpath: false, lockfilePath: join(runtime, '.host-session.lock'), stale: 30000,
    retries: { retries: 50, minTimeout: 100, maxTimeout: 100 } });
  try { return await operation(); } finally { await release(); }
}
async function hostSession(homeRoot, localURL, options = {}) {
  return withHostSessionLock(homeRoot, () => loadHostSession(homeRoot, localURL, options));
}
async function authorizeInitialHostPairing(homeRoot, authorized) {
  return withHostSessionLock(homeRoot, () => {
    const path = join(homeRoot, 'runtime', 'host-session.json');
    const session = readPrivateJSON(path);
    if (!authorized) {
      if (session?.initialPairingAuthorized) privateJSON(path, { ...session, initialPairingAuthorized: false });
      return;
    }
    // Start can admit the first session before Core is ready. This receipt is
    // consumed with the first tokens; it never authorizes recovery of an
    // existing or revoked session during a later read-only status check.
    if (session?.accessToken || session?.refreshToken || session?.recoveryRequired || (session?.pending && session.pending.kind !== 'pairing')) return;
    privateJSON(path, { ...session, initialPairingAuthorized: true,
      pending: session?.pending || { kind: 'pairing', issueKey: randomUUID(), redeemKey: randomUUID() } });
  });
}
async function loadHostSession(homeRoot, localURL, { create = false, resumeInitialPairing = false, request = requestJSON, rejectedAccess } = {}) {
  const path = join(homeRoot, 'runtime', 'host-session.json');
  let session = readPrivateJSON(path) || {};
  create ||= resumeInitialPairing && session.initialPairingAuthorized === true && session.pending?.kind === 'pairing'
    && !session.accessToken && !session.refreshToken && !session.recoveryRequired;
  const persist = value => { privateJSON(path, value); session = value; };
  const post = (route, body, key) => request(localURL + route, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  const saveCredentials = credentials => {
    const stored = Object.fromEntries(['accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt'].map(key => [key, credentials[key]]));
    if (!stored.accessToken || !stored.refreshToken) throw new Error('Home23 Host pairing did not issue credentials.');
    // The tokens and removal of the pending mutation are one atomic publication.
    // A crash before it leaves the original token AND original mutation key.
    persist(stored);
    return stored;
  };
  const markRecovery = reason => persist({ ...session, pending: undefined, recoveryRequired: reason });
  // Another probe may have received an old access rejection while a durable
  // refresh/pairing was in flight. Resolve that mutation before interpreting
  // the rejection; dropping its key could strand a committed successor.
  if (rejectedAccess && rejectedAccess.token === session.accessToken && !session.pending && terminalSessionFailure(rejectedAccess.error)) markRecovery(rejectedAccess.error.code);
  if (session.recoveryRequired && !create) throw recoveryNeeded(session.recoveryRequired);
  const rejectedCurrent = rejectedAccess && rejectedAccess.token === session.accessToken;
  if (!session.pending && !session.recoveryRequired && !rejectedCurrent && Date.parse(session.accessExpiresAt) > Date.now() + 30000) return session;

  if (!session.recoveryRequired && session.refreshToken && session.pending?.kind !== 'pairing') {
    if (!session.pending) persist({ ...session, pending: { kind: 'refresh', idempotencyKey: randomUUID(), refreshToken: session.refreshToken } });
    const pending = session.pending;
    if (pending.kind !== 'refresh' || !pending.idempotencyKey || !pending.refreshToken) throw new Error('The saved Host refresh operation is incomplete.');
    let refreshed;
    try { refreshed = await post('/api/v1/sessions/refresh', { refreshToken: pending.refreshToken }, pending.idempotencyKey); }
    catch (error) {
      if (!terminalSessionFailure(error)) throw error; // Timeout/5xx/unknown: retain exact pending request.
      markRecovery(error.code);
      if (!create) throw recoveryNeeded(error.code);
    }
    if (refreshed) return saveCredentials(refreshed);
  }
  if (!create) throw recoveryNeeded(session.recoveryRequired || 'pairing_required');
  // Starting a new pairing is explicit Host recovery. A pending pairing always
  // resumes its issue and redemption keys, even if the response was lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (session.pending?.kind !== 'pairing') persist({ ...session, pending: { kind: 'pairing', issueKey: randomUUID(), redeemKey: randomUUID() } });
    let pending = session.pending;
    if (!pending.issueKey || !pending.redeemKey) throw new Error('The saved Host pairing operation is incomplete.');
    if (!pending.pairingSessionId) {
      const pairing = await post('/api/v1/pairing/sessions', { deviceName: 'Home23 Host' }, pending.issueKey);
      if (!pairing.pairingSession?.id || !pairing.pairingCode) throw new Error('Home23 did not return a usable Host pairing.');
      pending = { ...pending, pairingSessionId: pairing.pairingSession.id, pairingCode: pairing.pairingCode };
      persist({ ...session, pending });
    }
    let paired;
    try {
      paired = await post(`/api/v1/pairing/sessions/${encodeURIComponent(pending.pairingSessionId)}/redeem`, {
        pairingCode: pending.pairingCode, credentialProfile: 'product', device: { platform: 'macos', name: 'Home23 Host', appBuild: '1' },
      }, pending.redeemKey);
    } catch (error) {
      // A confirmed unused terminal pairing can be replaced. An ambiguous or
      // already-redeemed result retains its key rather than creating a device.
      if (!((error.code === 'pairing_expired' && error.status === 410) || (error.code === 'pairing_locked' && error.status === 409)
        || (error.code === 'pairing_not_found' && error.status === 404))) throw error;
      markRecovery(error.code);
      if (attempt === 1) throw recoveryNeeded(error.code);
      continue;
    }
    return saveCredentials(paired);
  }
}
export async function probeReadiness(homeRoot, state, processes, { createSession = false, request = requestJSON } = {}) {
  const missing = ownedProcessNames(state.profile.name, { encoderRequired: encoderRequiredFor(state) }).filter(name => !processes.some(row => row.name === name && row.status === 'online' && row.owned));
  if (missing.length) return { ready: false, issues: missing.map(name => `${name} is not running from this installation.`) };
  if (encoderRequiredFor(state)) {
    const ready = await probeOwnedReady(state.ports.embedder);
    if (!ready.warm) return { ready: false, issues: ['The owned semantic encoder is not warm yet.'] };
  }
  const localURL = `http://127.0.0.1:${state.ports.coordination}`;
  const issues = [];
  let recoveryRequired = false;
  try {
    const capabilities = await request(localURL + '/api/v1/capabilities');
    if (!capabilities.pairingAvailable || !capabilities.capabilities?.bootstrap || !capabilities.capabilities?.messageSubmission) throw new Error('Home23 chat and pairing are not available yet.');
    let session = await hostSession(homeRoot, localURL, { create: createSession, resumeInitialPairing: state.desiredRunning === true, request });
    let bootstrap;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { bootstrap = await request(localURL + '/api/v1/bootstrap', { headers: { authorization: `Bearer ${session.accessToken}` } }); break; }
      catch (error) {
        if (error.status !== 401 || !ACCESS_FAILURES.has(error.code) || attempt === 2) throw error;
        session = await hostSession(homeRoot, localURL, { create: createSession, resumeInitialPairing: state.desiredRunning === true, request, rejectedAccess: { token: session.accessToken, error } });
      }
    }
    const bot = bootstrap.snapshot?.bots?.find(bot => bot.id === state.birth?.coordination?.botId);
    if (bootstrap.home?.id !== state.birth?.home?.id) throw new Error('The local API belongs to a different home.');
    if (!bot || !['available', 'busy'].includes(bot.availability) || !bot.conversationId) throw new Error('The resident has not completed signed registration and become available.');
  } catch (error) { recoveryRequired = error.code === 'host_session_recovery_required'; issues.push(error.message); }
  const checks = [
    ['Resident engine', `http://127.0.0.1:${state.ports.engine}/health`],
    ['Resident dashboard', `http://127.0.0.1:${state.ports.dashboard}/home23/process.json`],
    ['Seed observatory', `http://127.0.0.1:${state.ports.observatory}/healthz`, 'text'],
    ['Evobrew', `http://127.0.0.1:${state.ports.evobrew}/api/health`],
  ];
  await Promise.all(checks.map(async ([label, url, responseType = 'json']) => {
    try {
      const value = await request(url, { responseType });
      if (label === 'Seed observatory' && (typeof value !== 'string' || value.trim() !== 'ok')) throw new Error('Observatory liveness response differs.');
      if (label === 'Resident dashboard' && value.pid !== processes.find(row => row.name === `home23-${state.profile.name}-dash`)?.pid) throw new Error('Dashboard process identity differs.');
    } catch { issues.push(`${label} is not responding from this installation yet.`); }
  }));
  const memory = await inspectProductMemory(homeRoot);
  const semantic = semanticStatusView(homeRoot, state);
  return { ready: issues.length === 0, issues, memory, warnings: memory.warnings, semantic, ...(recoveryRequired ? { recoveryRequired: true } : {}) };
}
async function status(homeRoot, dependencies = {}, createSession = false) {
  if (!existsSync(receiptPath(homeRoot))) return { ok: true, status: 'absent', homeRoot, desiredRunning: false, processes: [] };
  await validateInstallation(homeRoot);
  const state = stateFor(homeRoot);
  if (!state) return { ok: true, status: 'installed', homeRoot, desiredRunning: false, processes: [] };
  const output = { ok: true, homeRoot, profile: state.profile, desiredRunning: state.desiredRunning === true,
    encoderRequired: encoderRequiredFor(state), semantic: semanticStatusView(homeRoot, state),
    connection: { localURL: `http://127.0.0.1:${state.ports.coordination}`, dashboardURL: `http://127.0.0.1:${state.ports.dashboard}`, pairing: 'owner pairing code', access: 'loopback; use a trusted HTTPS or VPN transport for other devices' } };
  const rows = await driver(homeRoot, dependencies, state).list();
  const processes = safeProcesses(rows, homeRoot, ownedProcessNames(state.profile.name, { encoderRequired: encoderRequiredFor(state) }));
  if (state.phase === 'creating') return { ...output, status: 'creating', processes };
  if (!processes.some(row => row.status === 'online' || row.status === 'launching')) return { ...output, status: state.desiredRunning ? 'degraded' : state.phase === 'prepared' ? 'prepared' : 'stopped', processes };
  const readiness = await (dependencies.probeReadiness || probeReadiness)(homeRoot, state, processes, { createSession });
  const starting = state.desiredRunning && !readiness.recoveryRequired && !processes.some(row => row.status === 'errored' || !row.owned)
    && Date.now() - Date.parse(state.startedAt || '') < 120000;
  return { ...output, status: readiness.ready ? 'ready' : starting ? 'starting' : 'degraded', processes, readiness };
}
async function seedAndCreate(homeRoot, input, state, dependencies) {
  const appRoot = join(homeRoot, 'app');
  const { default: yaml } = await import('js-yaml');
  const { profileFrom, createHome } = await import('./create-home.js');
  const { default: secretsStore } = await import('../../shared/home23-secrets.cjs');
  const profile = profileFrom(input.profile || {});
  if (!PROVIDERS.has(profile.provider)) throw new Error('Choose a supported API-key provider or local Ollama. Account OAuth setup is not available in Host yet.');
  const credential = input.credential || {};
  if (credential.provider && credential.provider !== profile.provider) throw new Error('The credential provider must match the selected provider.');
  const apiKey = typeof credential.apiKey === 'string' ? credential.apiKey.trim() : '';
  if (apiKey.length > 16000 || apiKey.includes('\0')) throw new Error('Invalid provider credential.');
  const baseUrl = credential.baseUrl ? providerEndpoint(credential.baseUrl).replace(/\/v1$/, '') : undefined;
  if (baseUrl && profile.provider !== 'ollama-local') throw new Error('Custom model endpoints currently require local Ollama.');
  if (state && state.fingerprint !== fingerprint(profile)) throw new Error('This home already has a saved profile. Resume it with the same profile.');
  if (state?.phase !== 'creating' && state) return status(homeRoot, dependencies);
  if (!apiKey && profile.provider !== 'ollama-local' && !existsSync(join(appRoot, 'config', 'secrets.yaml'))) throw new Error('Enter your selected provider API key.');
  if (!state) {
    state = { schema: 'home23.host.v2', homeRoot, profile, fingerprint: fingerprint(profile), ports: await choosePortPlan({ encoderRequired: true }), phase: 'creating', desiredRunning: false, encoderRequired: true };
    await withReservedPorts(state.ports, async () => privateJSON(statePath(homeRoot), state), { encoderRequired: true });
  }
  for (const file of ['home.yaml', 'targets.yaml', 'cron-jobs.json']) {
    const target = join(appRoot, 'config', file);
    if (!existsSync(target)) copyFileSync(target + '.example', target);
  }
  const homePath = join(appRoot, 'config', 'home.yaml');
  const home = yaml.load(readFileSync(homePath, 'utf8')) || {};
  home.coordination = { ...home.coordination, socketDirectory: socketRootFor(homeRoot), publicApi: { ...home.coordination?.publicApi, port: state.ports.coordination } };
  home.evobrew = { ...home.evobrew, port: state.ports.evobrew };
  home.substrate = { ...home.substrate, observatory: { ...home.substrate?.observatory, port: state.ports.observatory } };
  home.screenlogic = { enabled: false };
  if (baseUrl) home.providers[profile.provider] = { ...home.providers[profile.provider], baseUrl };
  if (profile.provider === 'ollama-local') {
    home.providers[profile.provider] = { ...home.providers[profile.provider], defaultModels: [...new Set([...(home.providers[profile.provider]?.defaultModels || []), profile.model])] };
    home.models = { ...home.models, aliases: { ...home.models?.aliases, 'host-resident': { provider: profile.provider, model: profile.model } } };
  }
  if (encoderRequiredFor(state)) {
    const endpoint = `http://127.0.0.1:${state.ports.embedder}/api/embeddings`;
    home.embedder = { owned: true, port: state.ports.embedder, bind: '127.0.0.1' };
    home.embeddings = { providers: [{ provider: 'home23-owned', model: OWNED_PROFILE_ID, dimensions: 768, endpoint, recipeId: OWNED_RECIPE_HASH }] };
    home.substrate = { ...home.substrate, embedding: { endpoint, model: OWNED_PROFILE_ID, recipeId: OWNED_RECIPE_HASH } };
  }
  writeFileSync(homePath, yaml.dump(home), { mode: 0o600 });
  await secretsStore.updateHome23Secrets(appRoot, secrets => {
    secrets.providers ||= {};
    if (apiKey) secrets.providers[profile.provider] = { apiKey };
    if (profile.provider !== 'ollama-local' && !secrets.providers[profile.provider]?.apiKey) throw new Error('Enter your selected provider API key.');
    return { changed: true };
  });
  const ports = Object.fromEntries(['engine', 'dashboard', 'mcp', 'bridge'].map(key => [key, state.ports[key]]));
  const birth = await (dependencies.createHome || createHome)(appRoot, profile, { ports, coordinationPort: state.ports.coordination });
  state = { ...state, phase: 'prepared', birth };
  privateJSON(statePath(homeRoot), state);
  return status(homeRoot, dependencies);
}
export async function runHostAction(action, { homeRoot, payloadPath, input = {} } = {}, dependencies = {}) {
  homeRoot = absoluteHome(homeRoot);
  if (action === 'preview') {
    if (typeof payloadPath !== 'string' || !isAbsolute(payloadPath)) throw new Error('Choose the absolute candidate Home23 payload directory.');
    const { previewProductUpdate } = await import('./product-update.js');
    return previewProductUpdate({ homeRoot, candidatePayload: payloadPath });
  }
  if (action === 'stage') {
    if (typeof payloadPath !== 'string' || !isAbsolute(payloadPath) || typeof input.staging !== 'string' || !isAbsolute(input.staging)) throw new Error('Choose absolute candidate and staging directories.');
    const { stageProductPayload } = await import('./product-update-stage.js');
    return stageProductPayload({ homeRoot, candidatePayload: payloadPath, staging: input.staging });
  }
  if (action === 'catalog') {
    const require = createRequire(import.meta.url);
    const { buildHome23ModelAuthority } = require('../../engine/src/dashboard/home23-model-catalog.js');
    const yaml = require('js-yaml');
    const configPath = new URL('../../config/home.yaml.example', import.meta.url);
    const authority = buildHome23ModelAuthority({ homeConfig: yaml.load(readFileSync(configPath, 'utf8')) });
    return { ok: true, status: existsSync(receiptPath(homeRoot)) ? 'installed' : 'absent', homeRoot,
      providers: Object.entries(authority.executionCatalog.providers).filter(([id]) => PROVIDERS.has(id)).map(([id, provider]) => ({ id, name: provider.label || id, models: provider.models.filter(model => model.kind === 'chat').map(model => ({ id: model.id, name: model.label || model.id })) })) };
  }
  if (action === 'status') return status(homeRoot, dependencies);
  if (!['install', 'create', 'start', 'stop', 'semantic-prepare'].includes(action)) throw new Error('Unknown Home23 Host action.');
  if (action === 'install') {
    if (typeof payloadPath !== 'string' || !isAbsolute(payloadPath)) throw new Error('Choose the absolute bundled Home23 payload directory.');
    const { installProductPayload } = await import('./product-payload.js');
    const receipt = await (dependencies.installProductPayload || installProductPayload)({ payloadPath, homeRoot });
    return { ok: true, status: 'installed', homeRoot, packageId: receipt.packageId };
  }
  if (!existsSync(receiptPath(homeRoot))) throw new Error('Install the Home23 runtime before creating or starting a home.');
  await validateInstallation(homeRoot, { full: action === 'create' || action === 'start' });
  productEnvironment(homeRoot, { prepare: true });
  const { default: lockfile } = await import('proper-lockfile');
  const release = await lockfile.lock(homeRoot, { realpath: false, lockfilePath: join(homeRoot, 'runtime', '.host.lock'), stale: 180000, update: 10000, retries: 0 });
  try {
    let state = stateFor(homeRoot);
    if (action === 'create') return await seedAndCreate(homeRoot, input, state, dependencies);
    if (!state || state.phase === 'creating') throw new Error('Finish creating this Home23 home before starting it.');
    if (action === 'semantic-prepare') {
      if (!encoderRequiredFor(state)) return await status(homeRoot, dependencies);
      const prep = beginSemanticPrepare(homeRoot, state, { spawnWorker: dependencies.spawnWorker, nodePath: join(homeRoot, 'bin', 'node') });
      return { ...await status(homeRoot, dependencies), semantic: semanticStatusView(homeRoot, state), handle: prep.handle };
    }
    const processDriver = driver(homeRoot, dependencies, state);
    const names = ownedProcessNames(state.profile.name, { encoderRequired: encoderRequiredFor(state) });
    const rows = await processDriver.list();
    const processes = safeProcesses(rows, homeRoot, names);
    if (rows.some(row => !names.includes(row.name)) || processes.some(row => !row.owned) || new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('This private supervisor contains an unexpected process; no processes were changed.');
    if (action === 'stop') {
      state = { ...state, desiredRunning: false, phase: 'stopped' };
      privateJSON(statePath(homeRoot), state);
      await authorizeInitialHostPairing(homeRoot, false);
      for (const name of [...names].reverse()) {
        const row = processes.find(item => item.name === name);
        if (row?.status === 'stopped') continue;
        try {
          await processDriver.pm2(['stop', name, '--silent']);
        } catch (error) {
          if (row) throw error;
        }
      }
      if (encoderRequiredFor(state)) {
        try {
          await ensureOwnedEncoderStopped(state, {
            probe: dependencies.probeOwnedReady || probeOwnedReady,
            ...(dependencies.signalProcess ? { signalProcess: dependencies.signalProcess } : {}),
            ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
            ...(Number.isInteger(dependencies.stopTimeoutMs) ? { timeoutMs: dependencies.stopTimeoutMs } : {}),
          });
        } catch (error) {
          return {
            ...await status(homeRoot, dependencies),
            ok: false,
            desiredRunning: false,
            error: {
              code: error.code || 'host_encoder_still_warm',
              message: error.message || 'The owned encoder is still answering /ready after Stop.',
            },
          };
        }
      }
      return await status(homeRoot, dependencies);
    }
    if (encoderRequiredFor(state) && semanticStatusView(homeRoot, state).semanticReady !== true) {
      return { ...await status(homeRoot, dependencies), ok: false, status: 'prepared',
        error: { code: 'host_semantic_prepare_required', message: 'Semantic memory is still preparing. Resume preparation before starting this home. Your saved home stays in place.' } };
    }
    const allRunning = names.every(name => processes.some(row => row.name === name && row.status === 'online'));
    if (!processes.some(row => row.status === 'online')) await withReservedPorts(state.ports, async () => {}, { encoderRequired: encoderRequiredFor(state) });
    state = { ...state, desiredRunning: true, phase: 'starting', startedAt: new Date().toISOString() };
    privateJSON(statePath(homeRoot), state);
    await authorizeInitialHostPairing(homeRoot, true);
    if (!allRunning) {
      const definitions = dependencies.definitions ? await dependencies.definitions(state.profile.name) : await processDriver.definitions(state.profile.name);
      const config = join(homeRoot, 'runtime', 'ecosystem.config.json');
      privateJSON(config, { apps: definitions });
      const startOrder = encoderRequiredFor(state) ? [OWNED_EMBEDDER_PROCESS, ...names.filter(name => name !== OWNED_EMBEDDER_PROCESS)] : names;
      for (const name of startOrder) {
        const current = processes.find(row => row.name === name);
        if (current?.status === 'online') continue;
        await processDriver.pm2([current ? 'restart' : 'start', current ? name : config, ...(current ? [] : ['--only', name]), '--update-env', '--silent']);
        if (name === OWNED_EMBEDDER_PROCESS) {
          // A cold ONNX launch includes artifact verification and model loading.
          // The integrated Mac trial took 32 seconds on external storage, so a
          // 30-second gate rejected a healthy encoder before admitting writers.
          const deadline = Date.now() + 90000;
          let warm = false;
          while (Date.now() < deadline) {
            warm = (await probeOwnedReady(state.ports.embedder)).warm;
            if (warm) break;
            await (dependencies.sleep || sleep)(500);
          }
          if (!warm) return { ...await status(homeRoot, dependencies), ok: false, status: 'degraded',
            error: { code: 'host_encoder_not_ready', message: 'The owned semantic encoder did not become ready. Check status, then retry Start. Your saved home stays in place.' } };
        }
      }
    }
    const deadline = Date.now() + (dependencies.readinessWaitMs ?? 45000);
    let result;
    do {
      result = await status(homeRoot, dependencies, true);
      if (result.status === 'ready') break;
      if (result.processes?.some(row => row.status === 'errored')) return { ...result, ok: false, status: 'degraded',
        error: { code: 'host_process_failed', message: 'A Home23 service could not stay running. Check this home\'s process logs, then retry Start.' } };
      if (Date.now() >= deadline) break;
      await (dependencies.sleep || sleep)(1000);
    } while (true);
    return result;
  } finally { await release(); }
}
