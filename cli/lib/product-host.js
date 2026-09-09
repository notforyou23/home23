/** Packaged Home23 lifecycle. All operations belong to one installed home. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { absoluteHome, choosePortPlan, privateDirectory, privateJSON, productEnvironment, providerEndpoint, readPrivateJSON, socketRootFor, validatePortPlan, withReservedPorts } from './product-environment.js';
import { inspectProductMemory } from './product-memory.js';

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
  if (state && (state.schema !== 'home23.host.v1' || state.homeRoot !== root)) throw new Error('This Home23 state belongs to another installation.');
  if (state) validatePortPlan(state.ports);
  return state;
}
export function ownedProcessNames(name) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || '')) throw new Error('Invalid resident name.');
  return ['home23-coordination', `home23-${name}`, `home23-${name}-dash`, `home23-${name}-harness`, `home23-${name}-seed`, `home23-${name}-shipper`, 'home23-seed-observatory', 'home23-evobrew'];
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
export function productDefinitions(apps, homeRoot, name) {
  const allowed = ownedProcessNames(name);
  const appRoot = join(homeRoot, 'app');
  const nodePath = join(homeRoot, 'bin', 'node');
  return allowed.map(processName => {
    const definition = apps.find(app => app.name === processName);
    if (!definition) throw new Error(`Required Home23 process is not configured: ${processName}`);
    const cwd = resolve(definition.cwd || appRoot);
    const script = isAbsolute(definition.script) ? definition.script : resolve(cwd, definition.script);
    if (!script.startsWith(appRoot + '/') || !(cwd === appRoot || cwd.startsWith(appRoot + '/'))) throw new Error('Home23 process escapes its installed application.');
    const nodeArgs = Array.isArray(definition.node_args) ? definition.node_args : String(definition.node_args || '').split(/\s+/).filter(Boolean);
    const args = Array.isArray(definition.args) ? definition.args : definition.args ? [definition.args] : [];
    return { ...definition, script: nodePath, interpreter: 'none', node_args: [], args: [...nodeArgs, script, ...args], cwd,
      autostart: true, autorestart: true, min_uptime: 10000, max_restarts: 5, restart_delay: 2000,
      env: { ...definition.env, ...productEnvironment(homeRoot) },
      // No profiling flags or dumps are required to run a user's home.
      filter_env: definition.filter_env || [],
    };
  }).map(definition => ({ ...definition, args: definition.args.filter(arg => !/^--(?:cpu|heap)-prof(?:$|=)/.test(arg)) }));
}
function driver(homeRoot, dependencies) {
  const env = productEnvironment(homeRoot, { prepare: true });
  const nodePath = join(homeRoot, 'bin', 'node');
  const pm2Path = join(homeRoot, 'tools', 'node_modules', 'pm2', 'bin', 'pm2');
  const execute = dependencies.execute || executeFile;
  async function pm2(args) {
    try { return await execute(nodePath, [pm2Path, ...args], { cwd: join(homeRoot, 'app'), env, timeout: args[0] === 'stop' ? 240000 : 45000, maxBuffer: 8 * 1024 * 1024 }); }
    catch { throw new Error(`Home23 process ${args[0]} failed. Check this home's runtime/pm2 logs.`); }
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
      return productDefinitions(JSON.parse(stdout), homeRoot, name);
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
async function requestJSON(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2500) });
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { /* An unreadable response is not proof that a session is invalid. */ }
    const error = new Error(`Home23 local API returned HTTP ${response.status}.`);
    error.status = response.status;
    if (typeof body?.error?.code === 'string' && /^[a-z_]{1,80}$/.test(body.error.code)) error.code = body.error.code;
    throw error;
  }
  return response.json();
}
async function hostSession(homeRoot, localURL, options = {}) {
  const { default: lockfile } = await import('proper-lockfile');
  const runtime = join(homeRoot, 'runtime');
  const release = await lockfile.lock(runtime, { realpath: false, lockfilePath: join(runtime, '.host-session.lock'), stale: 30000,
    retries: { retries: 50, minTimeout: 100, maxTimeout: 100 } });
  try { return await loadHostSession(homeRoot, localURL, options); } finally { await release(); }
}
async function loadHostSession(homeRoot, localURL, { create = false, request = requestJSON, rejectedAccess } = {}) {
  const path = join(homeRoot, 'runtime', 'host-session.json');
  let session = readPrivateJSON(path) || {};
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
  const missing = ownedProcessNames(state.profile.name).filter(name => !processes.some(row => row.name === name && row.status === 'online' && row.owned));
  if (missing.length) return { ready: false, issues: missing.map(name => `${name} is not running from this installation.`) };
  const localURL = `http://127.0.0.1:${state.ports.coordination}`;
  const issues = [];
  let recoveryRequired = false;
  try {
    const capabilities = await request(localURL + '/api/v1/capabilities');
    if (!capabilities.pairingAvailable || !capabilities.capabilities?.bootstrap || !capabilities.capabilities?.messageSubmission) throw new Error('Home23 chat and pairing are not available yet.');
    let session = await hostSession(homeRoot, localURL, { create: createSession, request });
    let bootstrap;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { bootstrap = await request(localURL + '/api/v1/bootstrap', { headers: { authorization: `Bearer ${session.accessToken}` } }); break; }
      catch (error) {
        if (error.status !== 401 || !ACCESS_FAILURES.has(error.code) || attempt === 2) throw error;
        session = await hostSession(homeRoot, localURL, { create: createSession, request, rejectedAccess: { token: session.accessToken, error } });
      }
    }
    const bot = bootstrap.snapshot?.bots?.find(bot => bot.id === state.birth?.coordination?.botId);
    if (bootstrap.home?.id !== state.birth?.home?.id) throw new Error('The local API belongs to a different home.');
    if (!bot || !['available', 'busy'].includes(bot.availability) || !bot.conversationId) throw new Error('The resident has not completed signed registration and become available.');
  } catch (error) { recoveryRequired = error.code === 'host_session_recovery_required'; issues.push(error.message); }
  const checks = [
    ['Resident engine', `http://127.0.0.1:${state.ports.engine}/health`],
    ['Resident dashboard', `http://127.0.0.1:${state.ports.dashboard}/home23/process.json`],
    ['Seed observatory', `http://127.0.0.1:${state.ports.observatory}/healthz`],
    ['Evobrew', `http://127.0.0.1:${state.ports.evobrew}/api/health`],
  ];
  await Promise.all(checks.map(async ([label, url]) => {
    try {
      const value = await request(url);
      if (label === 'Resident dashboard' && value.pid !== processes.find(row => row.name === `home23-${state.profile.name}-dash`)?.pid) throw new Error('Dashboard process identity differs.');
    } catch { issues.push(`${label} is not responding from this installation yet.`); }
  }));
  const memory = await inspectProductMemory(homeRoot);
  return { ready: issues.length === 0, issues, memory, warnings: memory.warnings, ...(recoveryRequired ? { recoveryRequired: true } : {}) };
}
async function status(homeRoot, dependencies = {}, createSession = false) {
  if (!existsSync(receiptPath(homeRoot))) return { ok: true, status: 'absent', homeRoot, desiredRunning: false, processes: [] };
  await validateInstallation(homeRoot);
  const state = stateFor(homeRoot);
  if (!state) return { ok: true, status: 'installed', homeRoot, desiredRunning: false, processes: [] };
  const output = { ok: true, homeRoot, profile: state.profile, desiredRunning: state.desiredRunning === true,
    connection: { localURL: `http://127.0.0.1:${state.ports.coordination}`, dashboardURL: `http://127.0.0.1:${state.ports.dashboard}`, pairing: 'owner pairing code', access: 'loopback; use a trusted HTTPS or VPN transport for other devices' } };
  const rows = await driver(homeRoot, dependencies).list();
  const processes = safeProcesses(rows, homeRoot, ownedProcessNames(state.profile.name));
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
    state = { schema: 'home23.host.v1', homeRoot, profile, fingerprint: fingerprint(profile), ports: await choosePortPlan(), phase: 'creating', desiredRunning: false };
    await withReservedPorts(state.ports, async () => privateJSON(statePath(homeRoot), state));
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
    if (baseUrl) {
      const endpoint = `${baseUrl.replace(/\/v1$/, '')}/api/embeddings`;
      home.embeddings = { ...home.embeddings, providers: [{ provider: 'ollama-local', model: 'nomic-embed-text', dimensions: 768, endpoint }] };
      home.substrate = { ...home.substrate, embedding: { endpoint, model: 'nomic-embed-text' } };
    }
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
  if (!['install', 'create', 'start', 'stop'].includes(action)) throw new Error('Unknown Home23 Host action.');
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
    const processDriver = driver(homeRoot, dependencies);
    const names = ownedProcessNames(state.profile.name);
    const rows = await processDriver.list();
    const processes = safeProcesses(rows, homeRoot, names);
    if (rows.some(row => !names.includes(row.name)) || processes.some(row => !row.owned) || new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('This private supervisor contains an unexpected process; no processes were changed.');
    if (action === 'stop') {
      state = { ...state, desiredRunning: false, phase: 'stopped' };
      privateJSON(statePath(homeRoot), state);
      for (const row of [...processes].reverse()) if (row.status !== 'stopped') await processDriver.pm2(['stop', row.name, '--silent']);
      return await status(homeRoot, dependencies);
    }
    const allRunning = names.every(name => processes.some(row => row.name === name && row.status === 'online'));
    if (!processes.some(row => row.status === 'online')) await withReservedPorts(state.ports, async () => {});
    state = { ...state, desiredRunning: true, phase: 'starting', startedAt: new Date().toISOString() };
    privateJSON(statePath(homeRoot), state);
    if (!allRunning) {
      const definitions = dependencies.definitions ? await dependencies.definitions(state.profile.name) : await processDriver.definitions(state.profile.name);
      const config = join(homeRoot, 'runtime', 'ecosystem.config.json');
      privateJSON(config, { apps: definitions });
      for (const name of names) {
        const current = processes.find(row => row.name === name);
        if (current?.status === 'online') continue;
        await processDriver.pm2([current ? 'restart' : 'start', current ? name : config, ...(current ? [] : ['--only', name]), '--update-env', '--silent']);
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
