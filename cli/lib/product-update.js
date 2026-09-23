/** Product installation preview and managed/source adoption. Preview stays read-only. */
import { createHash } from 'node:crypto';
import {
  copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative as relativePath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { choosePortPlan, privateJSON, readPrivateJSON, validatePortPlan } from './product-environment.js';
import { assertWritersIdle, rebindAdoptedHome, residentInstancePortSets } from './product-backup.js';
import { installProductPayload, PRODUCT_STATE_PATHS, readProductManifest, verifyProductPayload } from './product-payload.js';
import { inspectProductInstallation, previewRoot } from './product-update-preview.js';
import { acquireSupervisorLock } from '../../scripts/release/supervisor.mjs';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const { agentProcessNames, managedResidentWriters } = require('../../shared/agent-process-names.cjs');
const yaml = require('js-yaml');

const CREATION_JOURNAL = 'instances/.house/creation.json';

/** Same supervisor contract as the managed dashboard: PATH `pm2`, no product-private PM2 sockets. */
const MANAGED_PM2_ENV_BLOCKLIST = [
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
  // Product Host private daemon — must not invent an empty inventory.
  'PM2_HOME',
  'PM2_DAEMON_RPC_PORT',
  'PM2_DAEMON_PUB_PORT',
  'PM2_INTERACTOR_RPC_PORT',
  'HOME23_PRODUCT_HOST',
];

export function managedSupervisorEnvironment(base = process.env) {
  const env = { ...base };
  for (const key of MANAGED_PM2_ENV_BLOCKLIST) delete env[key];
  return env;
}

/**
 * Existing home/bot identity for readiness. Prefer Host birth, else the create-home receipt.
 * Never invents ids.
 */
export function resolveAdoptionBirth(sourceRoot, host = null) {
  const fromHost = host?.birth;
  if (typeof fromHost?.home?.id === 'string' && fromHost.home.id
    && typeof fromHost?.coordination?.botId === 'string' && fromHost.coordination.botId) {
    return {
      home: {
        id: fromHost.home.id,
        ...(typeof fromHost.home.name === 'string' && fromHost.home.name ? { name: fromHost.home.name } : {}),
      },
      coordination: { botId: fromHost.coordination.botId },
    };
  }
  const journalPath = join(sourceRoot, CREATION_JOURNAL);
  if (!existsSync(journalPath)) return null;
  try {
    const creation = JSON.parse(readFileSync(journalPath, 'utf8'));
    const receipt = creation?.receipt && typeof creation.receipt === 'object' ? creation.receipt : null;
    const homeId = typeof receipt?.home?.id === 'string' ? receipt.home.id
      : (typeof creation?.home?.id === 'string' ? creation.home.id : null);
    const botId = typeof receipt?.coordination?.botId === 'string' ? receipt.coordination.botId : null;
    const homeName = typeof receipt?.home?.name === 'string' ? receipt.home.name
      : (typeof creation?.home?.name === 'string' ? creation.home.name : null);
    if (!homeId || !botId) return null;
    return {
      home: { id: homeId, ...(homeName ? { name: homeName } : {}) },
      coordination: { botId },
    };
  } catch {
    return null;
  }
}

const INSTALL_SCHEMA = 'home23.product-install.v1';
const ADOPTION_SCHEMA = 'home23.managed-source-adoption.v1';
const ADOPTION_JOURNAL_SCHEMA = 'home23.managed-source-adoption-journal.v1';
const reason = (code, message, extra = {}) => ({ code, message, ...extra });
const RESIDENT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const PRESERVATION_SCHEMA = 'home23.adoption-preservation.v1';

function safeRelativePath(value) {
  return typeof value === 'string' && value && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function allowedPreserveDestination(path) {
  return PRODUCT_STATE_PATHS.some(entry => path === entry.path ||
    ((entry.type === 'directory' || entry.allowDescendants) && path.startsWith(`${entry.path}/`)));
}

function validateContinuingNetworkBindings(source, bindings) {
  if (!bindings) return null;
  const evidencePaths = ['config/home.yaml', 'evobrew/config.json',
    'instances/.house/coordination/active-release.json', 'instances/.house/coordination/ecosystem.config.cjs',
    'instances/jerry/config.yaml', 'instances/forrest/config.yaml'];
  if (bindings.schema !== 'home23.adoption-network-bindings.v1'
    || !bindings.shared || !bindings.residents || !bindings.evidence
    || Object.keys(bindings.evidence).sort().join('|') !== evidencePaths.sort().join('|')) throw new Error('Invalid continuing-home network bindings.');
  for (const relative of evidencePaths) {
    const file = join(source, relative);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()
      || createHash('sha256').update(readFileSync(file)).digest('hex') !== bindings.evidence[relative]) {
      throw new Error(`Continuing-home network source changed: ${relative}`);
    }
  }
  validatePortPlan(bindings.shared, { continuingBindings: true });
  const home = yaml.load(readFileSync(join(source, 'config/home.yaml'), 'utf8'));
  const release = JSON.parse(readFileSync(join(source, 'instances/.house/coordination/active-release.json'), 'utf8'));
  const saved = readFileSync(join(source, 'instances/.house/coordination/ecosystem.config.cjs'), 'utf8');
  const coordination = Number(saved.match(/HOME23_COORDINATION_PORT:\s*["']?(\d+)/)?.[1]);
  const evobrew = JSON.parse(readFileSync(join(source, 'evobrew/config.json'), 'utf8'));
  const names = Object.keys(release.residents || {}).sort();
  if (Object.keys(bindings.residents).sort().join('|') !== names.join('|')
    || bindings.shared.coordination !== coordination
    || bindings.shared.observatory !== home?.substrate?.observatory?.port
    || bindings.shared.evobrew !== evobrew?.server?.port) throw new Error('Continuing-home network binding differs from source services.');
  const used = new Set([coordination, bindings.shared.observatory, bindings.shared.evobrew]);
  for (const name of names) {
    const sourcePorts = yaml.load(readFileSync(join(source, `instances/${name}/config.yaml`), 'utf8'))?.ports;
    const selected = bindings.residents[name];
    const values = ['engine', 'dashboard', 'mcp', 'bridge'].map(key => selected?.[key]);
    if (!sourcePorts || !selected || new Set(values).size !== values.length
      || ['engine', 'dashboard', 'mcp', 'bridge'].some(key => selected[key] !== sourcePorts[key]
      || !Number.isInteger(selected[key]) || selected[key] < 1024 || selected[key] > 60999 || used.has(selected[key]))) {
      throw new Error(`Continuing-home resident network binding changed: ${name}`);
    }
    for (const key of ['engine', 'dashboard', 'mcp', 'bridge']) used.add(selected[key]);
  }
  const primary = home?.home?.primaryAgent;
  if (!names.includes(primary) || ['engine', 'dashboard', 'mcp', 'bridge'].some(key => bindings.shared[key] !== bindings.residents[primary][key])) {
    throw new Error('Continuing-home primary network binding changed.');
  }
  return bindings;
}

/** A reviewed plan pins every exception, including link targets, before copying. */
export function validateAdoptionPreservationPlan(source, plan, expectedHash) {
  if (!plan) return null;
  const bytes = JSON.stringify(plan);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && hash !== expectedHash) throw new Error('Adoption preservation plan hash changed.');
  if (plan.schema !== PRESERVATION_SCHEMA || plan.sourceRoot !== source || !Array.isArray(plan.entries)) throw new Error('Invalid adoption preservation plan.');
  const entries = new Map();
  for (const item of plan.entries) {
    if (!safeRelativePath(item.path) || entries.has(item.path) || !['replace', 'preserve', 'retain-link', 'historical-link', 'retain-authority'].includes(item.action)) throw new Error('Invalid adoption preservation entry.');
    if (item.action === 'preserve' || item.action.endsWith('-link') || item.action === 'retain-authority') {
      if (!safeRelativePath(item.destination) || !allowedPreserveDestination(item.destination)) throw new Error('Preserved state needs an explicit installed-state destination.');
    }
    if (item.action.endsWith('-link') && typeof item.target !== 'string') throw new Error('Preserved link needs its exact target.');
    if (item.action === 'retain-authority' && item.target !== join(source, item.path)) throw new Error('Retained authority must name the exact source directory.');
    if (item.action === 'historical-link' && item.inertHistorical !== true) throw new Error('Historical link needs an explicit inert declaration.');
    entries.set(item.path, item);
  }
  const references = Array.isArray(plan.references) ? plan.references : [];
  const seenReferences = new Set();
  for (const reference of references) {
    if (!['app/config/home.yaml', 'app/config/targets.yaml', 'app/config/agents.json', 'app/config/secrets.yaml', 'app/.home23-state.json'].includes(reference.path)
      || typeof reference.target !== 'string' || !reference.target.startsWith('/')
      || reference.target === source || reference.target.startsWith(`${source}${sep}`)
      || seenReferences.has(`${reference.path}\0${reference.target}`)) {
      throw new Error('Invalid reviewed external reference.');
    }
    seenReferences.add(`${reference.path}\0${reference.target}`);
  }
  const identity = plan.identity || null;
  if (identity && (!/^home_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity.homeId || '')
    || typeof identity.botId !== 'string' || !identity.botId.startsWith('bot_')
    || typeof identity.homeName !== 'string' || !identity.homeName.trim())) throw new Error('Invalid reviewed continuing-home identity.');
  const services = plan.services || [];
  if (!Array.isArray(services)) throw new Error('Invalid continuing-service map.');
  const seenServices = new Set();
  const validCommand = command => command && typeof command === 'object'
    && typeof command.executable === 'string' && command.executable.startsWith('/')
    && typeof command.cwd === 'string' && command.cwd.startsWith('/')
    && Array.isArray(command.args) && command.args.every(arg => typeof arg === 'string' && !arg.includes('\0'));
  for (const service of services) {
    if (!RESIDENT_NAME.test(service?.name || '') || seenServices.has(service.name)
      || !validCommand(service.source) || !validCommand(service.run)
      || typeof service.source.interpreter !== 'string' || !service.source.interpreter
      || (service.source.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(service.source.sha256))
      || !service.source.env || typeof service.source.env !== 'object' || Array.isArray(service.source.env)
      || Object.entries(service.source.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
      || !service.run.env || typeof service.run.env !== 'object' || Array.isArray(service.run.env)
      || Object.entries(service.run.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
      || !Array.isArray(service.run.stateRoots) || service.run.stateRoots.some(path => typeof path !== 'string' || !path.startsWith('/'))
      || typeof service.run.startOnHomeStart !== 'boolean') {
      throw new Error('Invalid continuing-service definition.');
    }
    seenServices.add(service.name);
  }
  const rewrites = plan.rewrites || [];
  if (!Array.isArray(rewrites)) throw new Error('Invalid reviewed path rewrites.');
  const seenRewrites = new Set();
  for (const rewrite of rewrites) {
    if (!safeRelativePath(rewrite.path) || seenRewrites.has(rewrite.path)
      || !/^[a-f0-9]{64}$/.test(rewrite.beforeSha256 || '')
      || !/^[a-f0-9]{64}$/.test(rewrite.afterSha256 || '')
      || !Array.isArray(rewrite.replacements) || !rewrite.replacements.length
      || rewrite.replacements.some(item => typeof item.from !== 'string' || !item.from
        || typeof item.to !== 'string' || !item.to || item.from === item.to)) {
      throw new Error('Invalid reviewed path rewrite.');
    }
    seenRewrites.add(rewrite.path);
  }
  const networkBindings = validateContinuingNetworkBindings(source, plan.networkBindings || null);
  return { hash, entries, references, identity, services, rewrites, networkBindings };
}

const ADOPTION_REBIND = new Set([
  '.home23-host.json',
  'ecosystem.config.cjs',
  'instances/.house/coordination/active-release.json',
  'instances/.house/source-authority.json',
]);
const ADOPTION_PRESERVE_FILES = new Set([
  'config/home.yaml', 'config/targets.yaml', 'config/secrets.yaml',
  'config/agents.json', 'config/cron-jobs.json',
  'runtime/semantic-prep.json',
  'engine/.env',
  'evobrew/.evobrew-config.json', 'evobrew/config.json',
  'evobrew/runtime-state.json', 'evobrew/model-catalog-cache.json',
]);
const ADOPTION_ENGINE_STATE_DIRS = ['runtime', 'logs', 'runs', 'data', 'artifacts', 'outputs', 'backups', '.backups'];
const ADOPTION_EVOBREW_STATE_DIRS = ['.evobrew-workspaces', 'conversations', 'snapshots'];
const ADOPTION_REBUILDABLE = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'node_modules', 'dist', 'logs', '.git', 'bin', 'tools', 'app',
  'instances/.house/maintenance',
]);
const ADOPTION_REBUILDABLE_PREFIXES = [
  'node_modules/', 'dist/', 'logs/', '.git/',
  'bin/', 'tools/', 'app/',
  'instances/.house/maintenance/',
];

function marker(root, relative) {
  try { lstatSync(join(root, relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sensitivePresenceOnly(relative) {
  const name = basename(relative);
  return name === '.env' || name === 'secrets.yaml' || /token/i.test(name);
}

/** Classify one relative path for managed/source adoption. Presence only; never opens files. */
export function classifyAdoptionPath(relative) {
  if (ADOPTION_REBIND.has(relative)) return 'rebind';
  if (relative === 'birth-receipt.json' || relative.endsWith('/birth-receipt.json')) return 'preserve';
  if (relative === 'seed-ledger.jsonl' || relative.endsWith('/seed-ledger.jsonl')) return 'preserve';
  if (ADOPTION_PRESERVE_FILES.has(relative)) return 'preserve';
  if (relative === 'config' || relative.startsWith('config/')) return 'preserve';
  if (relative === 'engine' || relative === 'evobrew') return 'container';
  if (ADOPTION_ENGINE_STATE_DIRS.some(name => relative === `engine/${name}` || relative.startsWith(`engine/${name}/`))) return 'preserve';
  if (ADOPTION_EVOBREW_STATE_DIRS.some(name => relative === `evobrew/${name}` || relative.startsWith(`evobrew/${name}/`))) return 'preserve';
  // Supervisor lock artifacts are created under the fence and must not alter the preserve snapshot.
  if (relative === 'instances/.house/maintenance' || relative.startsWith('instances/.house/maintenance/')) return 'rebuildable';
  // The selected product package replaces old managed release caches.
  if (relative === 'instances/.house/coordination/releases' || relative.startsWith('instances/.house/coordination/releases/')) return 'rebuildable';
  if (relative === 'instances' || relative.startsWith('instances/')) return 'preserve';
  if (relative === 'runtime') return 'preserve';
  if (ADOPTION_REBUILDABLE.has(relative)) return 'rebuildable';
  if (ADOPTION_REBUILDABLE_PREFIXES.some(prefix => relative.startsWith(prefix))) return 'rebuildable';
  return 'unknown';
}

function symlinkTargetInfo(root, relative) {
  const absolute = join(root, relative);
  const target = readlinkSync(absolute);
  const resolved = resolve(dirname(absolute), target);
  let dangling = false;
  let outside = false;
  try {
    const real = realpathSync(absolute);
    outside = real !== root && !real.startsWith(`${root}${sep}`);
  } catch {
    dangling = true;
    outside = !resolved.startsWith(`${root}${sep}`) && resolved !== root;
  }
  return { target, resolved, dangling, outside };
}

function walkAdoptionPaths(root, reasons, reviewed = null) {
  const paths = [];
  const visited = new Set();
  const visit = (relative, inherited = null) => {
    const absolute = relative ? join(root, relative) : root;
    const stat = lstatSync(absolute);
    if (relative) {
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      let role = type === 'other' ? 'unknown' : classifyAdoptionPath(relative);
      const decision = reviewed?.entries.get(relative);
      if (decision) {
        visited.add(relative);
        if (decision.action === 'replace') {
          if (role !== 'unknown' || type === 'symlink') reasons.push(reason('invalid_preservation_choice', `Path ${relative} cannot be replaced.`, { path: relative }));
          else role = 'rebuildable';
        } else if (decision.action === 'retain-authority') {
          if (type !== 'directory') reasons.push(reason('invalid_preservation_choice', `Retained authority ${relative} is not a directory.`, { path: relative }));
          role = 'preserve';
        } else if (decision.action === 'preserve') {
          if (type === 'symlink') reasons.push(reason('invalid_preservation_choice', `Link ${relative} needs an exact link choice.`, { path: relative }));
          if (role !== 'unknown' && role !== 'preserve') reasons.push(reason('invalid_preservation_choice', `Path ${relative} cannot use this preserve choice.`, { path: relative }));
          role = 'preserve';
        } else if (type !== 'symlink') reasons.push(reason('invalid_preservation_choice', `Path ${relative} is not a link.`, { path: relative }));
        else if (role !== 'rebind') role = 'preserve';
      } else if (inherited && role === 'unknown') role = 'preserve';
      const entry = { path: relative, type, role };
      if (decision?.action === 'retain-authority') { entry.reviewedAuthority = true; entry.target = decision.target; }
      if (decision?.destination) entry.reviewedDestination = decision.destination;
      else if (inherited && role === 'preserve') entry.reviewedDestination = `${inherited.destination}/${relativePath(inherited.path, relative).split(sep).join('/')}`;
      if (sensitivePresenceOnly(relative)) entry.contents = 'unopened';
      if (type === 'symlink') {
        const info = symlinkTargetInfo(root, relative);
        entry.external = true;
        entry.target = info.target;
        // Broad instances/config preserve must not swallow linked external state.
        if (decision?.action === 'retain-link' || decision?.action === 'historical-link') {
          if (decision.target !== info.target || (decision.action === 'retain-link' && info.dangling)) reasons.push(reason('link_target_changed', `Reviewed link ${relative} changed.`, { path: relative }));
          else entry.reviewedLink = decision.action;
        } else if (role !== 'rebuildable' && (info.dangling || info.outside || role === 'preserve' || role === 'rebind')) {
          reasons.push(reason('external_state', `Linked path ${relative} is not a captured file inside this home.`, { path: relative }));
        }
      }
      paths.push(entry);
      if (type !== 'directory') return;
      // Neither subtree can be copied. Unknown roots already block adoption;
      // rebuildable roots are replaced by the package. Avoid walking source
      // checkouts and dependency trees when planning an existing home.
      if (role === 'unknown' || role === 'rebuildable' || entry.reviewedAuthority) return;
      inherited = decision?.action === 'preserve' ? { path: relative, destination: decision.destination } : inherited;
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return;
    }
    for (const name of readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name, inherited);
  };
  visit('');
  for (const path of reviewed?.entries.keys() || []) if (!visited.has(path)) reasons.push(reason('preservation_entry_missing', `Reviewed path ${path} is no longer present.`, { path }));
  return paths;
}

function adoptionHasHomeState(paths) {
  return paths.some(entry => {
    if (entry.role !== 'preserve' || entry.type === 'directory' || entry.type === 'symlink') return false;
    if (ADOPTION_PRESERVE_FILES.has(entry.path)) return true;
    if (entry.path === 'birth-receipt.json' || entry.path.endsWith('/birth-receipt.json')) return true;
    if (entry.path === 'seed-ledger.jsonl' || entry.path.endsWith('/seed-ledger.jsonl')) return true;
    return entry.path.startsWith('instances/') && !entry.path.includes('/.house/');
  });
}

/** Resolve residents and Host profile without inventing names or fingerprints. */
export function resolveAdoptionIdentity(sourceRoot) {
  let release = null;
  const releasePath = join(sourceRoot, 'instances/.house/coordination/active-release.json');
  if (existsSync(releasePath)) {
    if (!lstatSync(releasePath).isFile() || lstatSync(releasePath).isSymbolicLink()) {
      return { ok: false, code: 'unsupported_layout', message: 'Managed/source adoption needs a readable active-release residents record when present.' };
    }
    try { release = JSON.parse(readFileSync(releasePath, 'utf8')); }
    catch {
      return { ok: false, code: 'unsupported_layout', message: 'The active-release residents record could not be read.' };
    }
  }

  const residentsRecord = release?.residents;
  const residentNames = (residentsRecord && typeof residentsRecord === 'object' && !Array.isArray(residentsRecord))
    ? Object.keys(residentsRecord).filter(name => RESIDENT_NAME.test(name))
    : [];

  let host = null;
  const hostPath = join(sourceRoot, '.home23-host.json');
  if (existsSync(hostPath)) {
    try {
      const stat = lstatSync(hostPath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const parsed = JSON.parse(readFileSync(hostPath, 'utf8'));
        if (RESIDENT_NAME.test(parsed?.profile?.name || '')) host = parsed;
      }
    } catch { /* Host is optional when active-release names residents. */ }
  }

  // When there is no Host profile, prefer home.yaml primaryAgent over residentMap key order.
  let primaryFromConfig = null;
  const homeYamlPath = join(sourceRoot, 'config/home.yaml');
  if (existsSync(homeYamlPath)) {
    try {
      const text = readFileSync(homeYamlPath, 'utf8');
      const match = text.match(/^\s*primaryAgent:\s*([a-z][a-z0-9-]{0,62})\s*$/m);
      if (match && residentNames.includes(match[1])) primaryFromConfig = match[1];
    } catch { /* config is optional for identity */ }
  }

  if (residentNames.length === 0) {
    if (!host) {
      return { ok: false, code: 'unsupported_layout', message: 'Managed/source adoption needs a Host record or active-release residents.' };
    }
    const birth = resolveAdoptionBirth(sourceRoot, host);
    return {
      ok: true,
      profile: { ...host.profile },
      encoderRequired: host.encoderRequired === true,
      fingerprint: typeof host.fingerprint === 'string' ? host.fingerprint : undefined,
      ports: host.ports && typeof host.ports === 'object' ? host.ports : undefined,
      ...(birth ? { birth } : {}),
      source: 'host',
      residents: [host.profile.name],
      residentMap: null,
      writers: agentProcessNames({ home23Root: sourceRoot, agentName: host.profile.name }),
    };
  }

  if (host && !residentNames.includes(host.profile.name)) {
    return { ok: false, code: 'unsupported_layout', message: 'Host profile.name must be one of the active-release residents.' };
  }

  const residentMap = {};
  for (const name of residentNames) {
    residentMap[name] = {
      processNames: agentProcessNames({ home23Root: sourceRoot, agentName: name }),
    };
  }
  const writers = managedResidentWriters(sourceRoot, Object.fromEntries(residentNames.map(name => [name, residentsRecord[name]])));
  const birth = resolveAdoptionBirth(sourceRoot, host);

  if (residentNames.length === 1) {
    const name = residentNames[0];
    if (host) {
      return {
        ok: true,
        profile: { ...host.profile },
        encoderRequired: host.encoderRequired === true,
        fingerprint: typeof host.fingerprint === 'string' ? host.fingerprint : undefined,
        ports: host.ports && typeof host.ports === 'object' ? host.ports : undefined,
        ...(birth ? { birth } : {}),
        source: 'host',
        residents: residentNames,
        residentMap: null,
        writers,
      };
    }
    return {
      ok: true,
      profile: { name },
      encoderRequired: false,
      fingerprint: undefined,
      ...(birth ? { birth } : {}),
      source: 'active-release',
      residents: residentNames,
      residentMap: null,
      writers,
    };
  }

  return {
    ok: true,
    profile: host
      ? { ...host.profile }
      : (primaryFromConfig ? { name: primaryFromConfig } : undefined),
    encoderRequired: host?.encoderRequired === true,
    fingerprint: typeof host?.fingerprint === 'string' ? host.fingerprint : undefined,
    ports: host?.ports && typeof host.ports === 'object' ? host.ports : undefined,
    ...(birth ? { birth } : {}),
    source: host ? 'host+active-release' : 'active-release',
    residents: residentNames,
    residentMap,
    writers,
  };
}

/** Explicit destination mapping for preserve/rebind entries. Silent omission is not allowed. */
export function mapAdoptionEntry(entry, residentName) {
  if (entry.role === 'rebuildable' || entry.type === 'directory') {
    return { ok: true, action: entry.type === 'directory' ? 'container' : 'rebuildable' };
  }
  if (entry.role === 'unknown' || entry.type === 'other') {
    return { ok: false, code: 'unknown_state' };
  }
  if (entry.reviewedDestination) {
    if (entry.type === 'symlink' && !entry.reviewedLink) return { ok: false, code: 'external_state' };
    return { ok: true, action: entry.type === 'symlink' ? 'copy_link' : 'copy', destination: entry.reviewedDestination };
  }
  if (entry.type === 'symlink') {
    // A link needs an exact reviewed target even when its ordinary state path
    // already has a known destination.
    if (!entry.reviewedLink) return { ok: false, code: 'external_state' };
    const mapped = mapAdoptionEntry({ ...entry, type: 'file' }, residentName);
    return mapped.ok ? { ...mapped, action: 'copy_link' } : mapped;
  }
  if (entry.role === 'rebind') {
    if (entry.path === 'ecosystem.config.cjs') {
      return { ok: true, action: 'copy', destination: 'app/ecosystem.config.cjs' };
    }
    if (entry.path === '.home23-host.json') {
      return { ok: true, action: 'source_only', reason: 'host_rewritten' };
    }
    if (entry.path === 'instances/.house/coordination/active-release.json'
      || entry.path === 'instances/.house/source-authority.json') {
      return { ok: true, action: 'source_only', reason: 'managed_marker_source_only' };
    }
    return { ok: false, code: 'unmapped_rebind', message: `Rebind path ${entry.path} has no adoption mapping.` };
  }
  if (entry.role === 'preserve') {
    if (entry.path === 'runtime/semantic-prep.json') {
      return { ok: true, action: 'copy', destination: 'runtime/semantic-prep.json' };
    }
    if (entry.path.startsWith('config/')) {
      return { ok: true, action: 'copy', destination: `app/${entry.path}` };
    }
    if (entry.path.startsWith('instances/')) {
      return { ok: true, action: 'copy', destination: `app/${entry.path}` };
    }
    if (entry.path.startsWith('engine/') || entry.path.startsWith('evobrew/')) {
      return { ok: true, action: 'copy', destination: `app/${entry.path}` };
    }
    if (entry.path === 'birth-receipt.json') {
      if (!residentName) return { ok: false, code: 'unmapped_preserve', message: 'Root birth-receipt.json needs a resolved resident.' };
      return { ok: true, action: 'copy', destination: `app/instances/${residentName}/substrate/seed-01/birth-receipt.json` };
    }
    if (entry.path === 'seed-ledger.jsonl') {
      if (!residentName) return { ok: false, code: 'unmapped_preserve', message: 'Root seed-ledger.jsonl needs a resolved resident.' };
      return { ok: true, action: 'copy', destination: `app/instances/${residentName}/substrate/seed-01/seed-ledger.jsonl` };
    }
    if (entry.path.endsWith('/birth-receipt.json') || entry.path.endsWith('/seed-ledger.jsonl')) {
      if (entry.path.startsWith('instances/')) {
        return { ok: true, action: 'copy', destination: `app/${entry.path}` };
      }
    }
    return { ok: false, code: 'unmapped_preserve', message: `Preserve path ${entry.path} has no adoption mapping.` };
  }
  return { ok: false, code: 'unmapped_preserve', message: `Path ${entry.path} has no adoption mapping.` };
}

function annotateMappings(paths, identity, reasons) {
  const rootResident = identity.residents?.length === 1 ? identity.residents[0] : null;
  const destinations = new Map();
  for (const entry of paths) {
    if (entry.role !== 'preserve' && entry.role !== 'rebind') continue;
    if (entry.reviewedAuthority) {
      entry.mapping = { ok: true, action: 'copy_link', destination: entry.reviewedDestination };
      destinations.set(entry.reviewedDestination, entry.path);
      continue;
    }
    if (entry.type === 'directory') continue;
    const mapped = mapAdoptionEntry(entry, rootResident);
    entry.mapping = mapped;
    if (!mapped.ok) {
      reasons.push(reason(mapped.code || 'unmapped_preserve', mapped.message || `Path ${entry.path} is not mapped for adoption.`, { path: entry.path }));
    } else if (mapped.destination) {
      const existing = destinations.get(mapped.destination);
      if (existing && existing !== entry.path) reasons.push(reason('destination_collision', `Preserved paths ${existing} and ${entry.path} share one destination.`, { path: entry.path }));
      else destinations.set(mapped.destination, entry.path);
    }
  }
}

/**
 * Read-only managed/source adoption plan. Never writes, never opens secrets or
 * token files, never runs home birth, and never claims product install adoption.
 */
export function planManagedSourceAdoption(homeRoot, { preservationPlan = null, planHash } = {}) {
  const current = inspectProductInstallation(homeRoot);
  const root = current.root;
  const reviewed = validateAdoptionPreservationPlan(root, preservationPlan, planHash);
  const plan = {
    homeBirth: 'not_run',
    seedLedgers: 'preserve',
    encoderRecipe: 'unchanged',
  };
  const result = {
    schema: ADOPTION_SCHEMA,
    root,
    layout: current.layout,
    canAdopt: false,
    reasons: [],
    inventory: { complete: false, paths: [] },
    plan,
    identity: null,
  };
  if (current.layout === 'absent') {
    result.reasons.push(reason('layout_absent', 'No home directory is present to adopt.'));
    return result;
  }
  if (current.layout === 'product') {
    result.reasons.push(reason('product_layout', 'Owned product installations are not adopted through the managed/source adapter.'));
    return result;
  }
  if (current.layout !== 'managed' && current.layout !== 'source') {
    result.reasons.push(reason('unsupported_layout', 'Only managed or source layouts produce an adoption plan.'));
    return result;
  }
  const identity = resolveAdoptionIdentity(root);
  if (!identity.ok) {
    result.reasons.push(reason(identity.code, identity.message));
    return result;
  }
  result.identity = {
    profile: identity.profile || null,
    source: identity.source,
    residents: identity.residents,
    residentMap: identity.residentMap || null,
  };
  if (!identity.birth && marker(root, 'instances/.house/coordination/home23-coordination.sqlite3') && !reviewed?.identity) {
    result.reasons.push(reason('birth_identity_unresolved', 'The continuing home and primary bot IDs need a reviewed plan bound to canonical state.'));
  }
  let paths;
  try { paths = walkAdoptionPaths(root, result.reasons, reviewed); }
  catch {
    result.reasons.push(reason('inventory_unreadable', 'The adoption inventory could not be walked.'));
    return result;
  }
  result.inventory.paths = paths;
  if (reviewed) result.preservationPlanHash = reviewed.hash;
  const unknown = paths.filter(entry => entry.role === 'unknown');
  for (const entry of unknown) {
    result.reasons.push(reason('unknown_state', `Unclassified path ${entry.path} blocks adoption until it is preserve, rebind, or rebuildable.`, { path: entry.path }));
  }
  if (!adoptionHasHomeState(paths)) {
    result.reasons.push(reason('inventory_incomplete', 'Managed/source adoption requires classified home state beyond release or source markers.'));
  }
  for (const name of identity.residents) {
    const prefix = `instances/${name}/`;
    if (!paths.some(entry => entry.path.startsWith(prefix) && entry.role === 'preserve' && entry.type === 'file')) {
      result.reasons.push(reason('inventory_incomplete', `Resident ${name} has no preserved instance state to adopt.`, { resident: name }));
    }
  }
  annotateMappings(paths, identity, result.reasons);
  for (const rewrite of reviewed?.rewrites || []) {
    const entry = paths.find(item => item.path === rewrite.path);
    if (!entry || entry.type !== 'file' || entry.mapping?.action !== 'copy') {
      result.reasons.push(reason('rewrite_source_missing', `Reviewed rewrite source ${rewrite.path} is not preserved.`, { path: rewrite.path }));
      continue;
    }
    const before = readFileSync(join(root, rewrite.path));
    if (createHash('sha256').update(before).digest('hex') !== rewrite.beforeSha256) {
      result.reasons.push(reason('rewrite_source_changed', `Reviewed rewrite source ${rewrite.path} changed.`, { path: rewrite.path }));
    }
  }
  result.inventory.complete = result.reasons.length === 0;
  result.canAdopt = result.inventory.complete;
  return result;
}

function adoptionJournalPath(destination) {
  return join(dirname(destination), `.${basename(destination)}.home23-adoption.json`);
}

function readAdoptionJournal(destination) {
  const file = adoptionJournalPath(destination);
  if (!existsSync(file)) return null;
  const journal = JSON.parse(readFileSync(file, 'utf8'));
  if (journal?.schema !== ADOPTION_JOURNAL_SCHEMA || journal.destinationRoot !== destination) {
    throw new Error('Adoption journal belongs to another destination.');
  }
  return journal;
}

function writeAdoptionJournal(destination, journal) {
  privateJSON(adoptionJournalPath(destination), { ...journal, schema: ADOPTION_JOURNAL_SCHEMA, destinationRoot: destination });
}

function disjointRoots(...roots) {
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const left = roots[i], right = roots[j];
      if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
        throw new Error('Adoption payload, source, and destination must be separate directories.');
      }
    }
  }
}

function copyableEntries(paths) {
  return paths.filter(entry => entry.mapping?.action === 'copy' && entry.type === 'file' && !entry.external);
}

function preservedDirectories(paths) {
  return paths.filter(entry => entry.type === 'directory' && !entry.reviewedAuthority && (entry.reviewedDestination || entry.role === 'preserve'));
}
function retainedAuthorities(paths) {
  return paths.filter(entry => entry.type === 'directory' && entry.reviewedAuthority && entry.reviewedDestination);
}
function preservedDirectoryDestination(entry) {
  if (entry.reviewedDestination) return entry.reviewedDestination;
  if (entry.path === 'runtime' || entry.path.startsWith('runtime/')) return entry.path;
  if (['instances', 'config', 'engine', 'evobrew'].some(root => entry.path === root || entry.path.startsWith(`${root}/`))) return `app/${entry.path}`;
  return null;
}

function linkedEntries(paths) {
  return paths.filter(entry => entry.mapping?.action === 'copy_link' && entry.type === 'symlink' && entry.reviewedLink);
}
function writeAdoptedLinks(destination, paths, source, reviewed = null) {
  const links = [...linkedEntries(paths), ...retainedAuthorities(paths)].map(entry => {
    const mapped = entry.mapping?.destination || entry.reviewedDestination;
    const file = join(destination, mapped);
    if (!lstatSync(file).isSymbolicLink()) throw new Error(`Preserved link is missing: ${mapped}`);
    return { path: mapped, target: readlinkSync(file), sourcePath: entry.path,
      sourceTarget: entry.target, kind: entry.reviewedAuthority ? 'retain-authority' : entry.reviewedLink };
  }).sort((left, right) => left.path.localeCompare(right.path));
  for (const reference of reviewed?.references || []) {
    const file = join(destination, reference.path);
    if (!existsSync(file) || !lstatSync(file).isFile() || !readFileSync(file, 'utf8').includes(reference.target)) {
      throw new Error(`Reviewed external reference changed: ${reference.path}`);
    }
  }
  privateJSON(join(destination, 'runtime/adoption-preservation.json'), {
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: source,
    links,
    externalReferences: reviewed?.references || [],
    continuationServices: reviewed?.services || [],
    ...(reviewed?.networkBindings ? { networkBindings: reviewed.networkBindings } : {}),
  });
}

const ADOPTION_IDENTITY_FILES = [
  '.home23-host.json',
  'instances/.house/coordination/active-release.json',
  'instances/.house/source-authority.json',
];

/** Snapshot of preserved bytes, identity inputs, and mapping destinations. */
export function sourceAdoptionSnapshot(source, paths, identity) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    profileName: identity.profile?.name || null,
    encoderRequired: identity.encoderRequired === true,
    fingerprint: identity.fingerprint || null,
    identitySource: identity.source || null,
    residents: identity.residents || null,
    residentMap: identity.residentMap || null,
    writers: identity.writers || null,
  }));
  hash.update('\0');
  for (const relative of [...ADOPTION_IDENTITY_FILES].sort()) {
    const absolute = join(source, relative);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  for (const entry of copyableEntries(paths).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.mapping.destination);
    hash.update('\0');
    hash.update(readFileSync(join(source, entry.path)));
    hash.update('\0');
  }
  for (const entry of linkedEntries(paths).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify({ path: entry.path, destination: entry.mapping.destination, target: entry.target, reviewedLink: entry.reviewedLink }));
    hash.update('\0');
  }
  for (const entry of preservedDirectories(paths).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify({ path: entry.path, destination: preservedDirectoryDestination(entry), mode: lstatSync(join(source, entry.path)).mode & 0o777 }));
    hash.update('\0');
  }
  for (const entry of retainedAuthorities(paths).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify({ path: entry.path, destination: entry.reviewedDestination, target: entry.target,
      mode: lstatSync(join(source, entry.path)).mode & 0o777 }));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function copyPreservedState(source, destination, paths) {
  for (const entry of preservedDirectories(paths)) {
    const mapped = preservedDirectoryDestination(entry);
    if (!mapped) throw new Error(`Preserved directory has no destination: ${entry.path}`);
    const to = join(destination, mapped);
    mkdirSync(to, { recursive: true, mode: mapped.startsWith('runtime/') ? 0o700 : 0o755 });
    const mode = lstatSync(join(source, entry.path)).mode & 0o777;
    chmodSync(to, mode & (sensitivePresenceOnly(entry.path) ? 0o700 : 0o777));
  }
  for (const entry of copyableEntries(paths)) {
    const mapped = entry.mapping.destination;
    const from = join(source, entry.path);
    const stat = lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const to = join(destination, mapped);
    const mode = mapped === 'runtime' || mapped.startsWith('runtime/') ? 0o700 : 0o755;
    mkdirSync(dirname(to), { recursive: true, mode });
    if (mapped.startsWith('runtime/')) {
      try { chmodSync(join(destination, 'runtime'), 0o700); } catch { /* created mode may already be private */ }
    }
    copyFileSync(from, to);
    chmodSync(to, (stat.mode & 0o777) & (sensitivePresenceOnly(entry.path) || entry.path.endsWith('.key') || entry.path === 'evobrew/config.json' ? 0o600 : 0o777));
  }
  const destinationForSourcePath = absolute => {
    const relative = relativePath(source, absolute).split(sep).join('/');
    const candidates = paths.filter(item => item.path === relative || relative.startsWith(`${item.path}/`))
      .filter(item => item.mapping?.destination || item.reviewedDestination)
      .sort((left, right) => right.path.length - left.path.length);
    const anchor = candidates[0];
    if (anchor) {
      const mapped = anchor.mapping?.destination || anchor.reviewedDestination;
      return join(destination, mapped, relative.slice(anchor.path.length).replace(/^\//, ''));
    }
    if (['instances', 'config', 'engine', 'evobrew'].some(root => relative === root || relative.startsWith(`${root}/`))) return join(destination, 'app', relative);
    throw new Error(`Internal preserved link target has no reviewed destination: ${relative}`);
  };
  for (const entry of linkedEntries(paths)) {
    const to = join(destination, entry.mapping.destination);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    // Resolve source-internal links against their mapped destination, while
    // external links continue to name the exact existing target.
    const sourceTarget = resolve(dirname(join(source, entry.path)), entry.target);
    const target = entry.reviewedLink !== 'historical-link' && (sourceTarget === source || sourceTarget.startsWith(`${source}${sep}`))
      ? destinationForSourcePath(sourceTarget) : sourceTarget;
    if (existsSync(to) || marker(destination, entry.mapping.destination)) {
      if (lstatSync(to).isSymbolicLink() && readlinkSync(to) === target) continue;
      throw new Error(`Preserved link destination already differs: ${entry.mapping.destination}`);
    }
    symlinkSync(target, to);
  }
  for (const entry of retainedAuthorities(paths)) {
    const to = join(destination, entry.reviewedDestination);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (marker(destination, entry.reviewedDestination)) {
      if (lstatSync(to).isSymbolicLink() && readlinkSync(to) === entry.target) continue;
      throw new Error(`Retained authority destination already differs: ${entry.reviewedDestination}`);
    }
    symlinkSync(entry.target, to);
  }
}

function applyReviewedPathRewrites(destination, paths, rewrites = []) {
  for (const rewrite of rewrites) {
    const entry = paths.find(item => item.path === rewrite.path);
    if (entry?.mapping?.action !== 'copy' || entry.type !== 'file') throw new Error(`Reviewed rewrite source is not preserved: ${rewrite.path}`);
    const file = join(destination, entry.mapping.destination);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Reviewed rewrite destination is not a file: ${rewrite.path}`);
    const before = readFileSync(file);
    const currentHash = createHash('sha256').update(before).digest('hex');
    if (currentHash === rewrite.afterSha256) continue;
    if (currentHash !== rewrite.beforeSha256) throw new Error(`Reviewed rewrite source changed: ${rewrite.path}`);
    let text = before.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(before)) throw new Error(`Reviewed rewrite source is not UTF-8: ${rewrite.path}`);
    for (const item of rewrite.replacements) {
      if (!text.includes(item.from)) throw new Error(`Reviewed path is absent from ${rewrite.path}`);
      text = text.split(item.from).join(item.to);
    }
    const after = Buffer.from(text, 'utf8');
    if (createHash('sha256').update(after).digest('hex') !== rewrite.afterSha256) throw new Error(`Reviewed rewrite result differs: ${rewrite.path}`);
    const temporary = `${file}.adoption-rewrite-next`;
    writeFileSync(temporary, after, { mode: stat.mode & 0o777 });
    renameSync(temporary, file);
  }
}

function processPathOwnership(row, home) {
  const env = row?.pm2_env || {};
  const raw = [env.pm_cwd, env.cwd, env.HOME23_ROOT, env.HOME23_INSTANCE_DIR]
    .filter(value => typeof value === 'string' && value.startsWith('/'));
  if (!raw.length) return 'unattributed';
  let homeReal = home;
  try { homeReal = realpathSync(home); } catch { /* compare the given path */ }
  let sawThis = false;
  let sawOther = false;
  let unresolved = false;
  for (const value of raw) {
    let resolved = null;
    try { resolved = realpathSync(value); } catch { unresolved = true; continue; }
    if (resolved === homeReal || resolved.startsWith(`${homeReal}${sep}`) || homeReal.startsWith(`${resolved}${sep}`)) sawThis = true;
    else sawOther = true;
  }
  if (sawThis && !sawOther) return 'this';
  if (sawOther && !sawThis && !unresolved) return 'other';
  return 'ambiguous';
}

function keepSourceWriter(row, home, expected) {
  const ownership = processPathOwnership(row, home);
  if (ownership === 'other') return false;
  if (ownership === 'this') return true;
  return expected.has(row?.name);
}

/** Live process inventory for a managed/source home. Unavailable inventory refuses adoption. */
export async function listSourceWriters(home, dependencies = {}) {
  // Inventory the same supervisor the managed dashboard uses (PATH pm2 + clean env).
  // Never point PM2 at a product-private daemon — an empty private jlist is not proof.
  const env = dependencies.env || managedSupervisorEnvironment();
  const command = dependencies.pm2Command || 'pm2';
  const execute = dependencies.executeFile || executeFile;
  try {
    const { stdout } = await execute(command, ['jlist', '--silent'], {
      cwd: home,
      env,
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!String(stdout || '').trim()) {
      throw Object.assign(new Error('Home process inventory is unavailable.'), { code: 'process_inventory_unavailable' });
    }
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) {
      throw Object.assign(new Error('Home process inventory is unavailable.'), { code: 'process_inventory_unavailable' });
    }
    const expected = new Set(Array.isArray(dependencies.expectedWriters) ? dependencies.expectedWriters : []);
    // Another home's row is ignored only when its path is unambiguously elsewhere.
    // An expected writer with no usable path stays in the inventory.
    return rows.filter(row => keepSourceWriter(row, home, expected)).map(row => ({
      name: row.name,
      status: row.pm2_env?.status || 'unknown',
    }));
  } catch (error) {
    if (error.code === 'process_inventory_unavailable') throw error;
    throw Object.assign(new Error('Home process inventory is unavailable.'), { code: 'process_inventory_unavailable' });
  }
}

async function assertAdoptionWritersStopped(source, dependencies = {}, expectedWriters = []) {
  const list = dependencies.listWriters || listSourceWriters;
  let rows;
  try {
    rows = await list(source, { ...dependencies, expectedWriters });
  } catch (error) {
    throw Object.assign(
      new Error(error.message || 'Home process inventory is unavailable.'),
      { code: error.code || 'process_inventory_unavailable' },
    );
  }
  try {
    assertWritersIdle(rows);
  } catch (error) {
    throw Object.assign(
      new Error(error.message || 'Writers are still running or have unknown status.'),
      { code: error.code || 'writers_active' },
    );
  }
}

async function verifySourceServiceBindings(source, services, dependencies = {}) {
  if (!services.length) return;
  let rows;
  try {
    if (dependencies.listSourceServiceBindings) rows = await dependencies.listSourceServiceBindings(source);
    else {
      const { stdout } = await (dependencies.executeFile || executeFile)(dependencies.pm2Command || 'pm2', ['jlist', '--silent'], {
        cwd: source, env: dependencies.env || managedSupervisorEnvironment(), timeout: 20000, maxBuffer: 8 * 1024 * 1024,
      });
      rows = JSON.parse(stdout);
    }
  } catch {
    throw Object.assign(new Error('Continuing-service process inventory is unavailable.'), { code: 'process_inventory_unavailable' });
  }
  if (!Array.isArray(rows)) throw Object.assign(new Error('Continuing-service process inventory is invalid.'), { code: 'process_inventory_unavailable' });
  for (const service of services) {
    const matches = rows.filter(row => row.name === service.name);
    const env = matches[0]?.pm2_env || {};
    if (matches.length !== 1 || env.pm_exec_path !== service.source.executable || env.pm_cwd !== service.source.cwd
      || JSON.stringify(env.args || []) !== JSON.stringify(service.source.args)
      || env.exec_interpreter !== service.source.interpreter
      || Object.entries(service.source.env).some(([key, value]) => env[key] !== value)
      || env.status !== 'stopped'
      || (service.source.sha256 && createHash('sha256').update(readFileSync(service.source.executable)).digest('hex') !== service.source.sha256)) {
      throw Object.assign(new Error(`Reviewed service binding changed or remains active: ${service.name}`), { code: 'continuation_binding_changed' });
    }
  }
}

function loadBetterSqlite3(sourceRoot) {
  for (const candidate of [
    join(sourceRoot, 'package.json'),
    join(fileURLToPath(new URL('../..', import.meta.url)), 'package.json'),
  ]) {
    try {
      const Better = createRequire(candidate)('better-sqlite3');
      const probe = new Better(':memory:');
      probe.close();
      return Better;
    } catch { /* try next or fall through */ }
  }
  return null;
}

/** Hold the managed supervisor lock for every resident writer through the copy. */
export function holdAdoptionSupervisorLock(source, identity, dependencies = {}) {
  const maintenance = join(source, 'instances/.house/maintenance');
  mkdirSync(maintenance, { recursive: true, mode: 0o700 });
  // Prefer an explicit Database, then a working better-sqlite3, else node:sqlite —
  // mixed native builds across Node versions must not silently lose the fence.
  const Database = dependencies.Database || loadBetterSqlite3(source) || DatabaseSync;
  const acquire = dependencies.acquireSupervisorLock || acquireSupervisorLock;
  const writers = Array.isArray(identity.writers) ? identity.writers : [];
  try {
    return acquire(maintenance, Database, { purpose: 'adoption', writers });
  } catch (error) {
    throw Object.assign(
      new Error(error.message || 'Managed supervisor lock is unavailable for adoption.'),
      { code: 'supervisor_lock_unavailable' },
    );
  }
}

function verifyContinuingBirth(source, identity, reviewed) {
  if (identity.birth) {
    if (reviewed?.identity && (reviewed.identity.homeId !== identity.birth.home.id || reviewed.identity.botId !== identity.birth.coordination.botId)) {
      throw Object.assign(new Error('Reviewed identity differs from the source birth receipt.'), { code: 'birth_identity_changed' });
    }
    return identity;
  }
  const requested = reviewed?.identity;
  const databasePath = join(source, 'instances/.house/coordination/home23-coordination.sqlite3');
  // Fixture/source homes without a canonical DB retain the older adapter
  // behavior. A lived managed home with canonical state must bind its IDs.
  if (!existsSync(databasePath)) return identity;
  if (!requested) throw Object.assign(new Error('Canonical continuing-home identity is unavailable.'), { code: 'birth_identity_unresolved' });
  const savedLauncher = join(source, 'instances/.house/coordination/ecosystem.config.cjs');
  let savedHomeId = 'home_00000000-0000-7000-8000-000000000000';
  let savedHomeName = 'Home23';
  if (existsSync(savedLauncher)) {
    const apps = require(savedLauncher)?.apps;
    const coordination = apps?.find(app => app.name === 'home23-coordination');
    if (!coordination) throw Object.assign(new Error('Saved coordination launcher is missing.'), { code: 'birth_identity_unresolved' });
    savedHomeId = coordination.env?.HOME23_COORDINATION_HOME_ID || savedHomeId;
    savedHomeName = coordination.env?.HOME23_COORDINATION_HOME_NAME || savedHomeName;
  }
  if (requested.homeId !== savedHomeId || requested.homeName !== savedHomeName) {
    throw Object.assign(new Error('Reviewed home identity differs from the saved coordination launcher.'), { code: 'birth_identity_changed' });
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const bot = database.prepare('SELECT id FROM bots WHERE id = ? AND resident_binding = ? AND lifecycle = ?').get(requested.botId, identity.profile?.name, 'active');
    if (!bot) throw Object.assign(new Error('Reviewed primary bot is not active in canonical coordination state.'), { code: 'birth_identity_changed' });
  } finally { database.close(); }
  return { ...identity, birth: { home: { id: requested.homeId, name: requested.homeName }, coordination: { botId: requested.botId } } };
}

async function writeStoppedHost(destination, identity, dependencies = {}, reviewed = null) {
  const choose = dependencies.choosePortPlan || choosePortPlan;
  const ports = reviewed?.networkBindings?.shared || (identity.ports && typeof identity.ports === 'object'
    ? identity.ports
    : await choose({ encoderRequired: identity.encoderRequired === true }));
  const state = {
    schema: 'home23.host.v2',
    homeRoot: destination,
    ports,
    phase: 'stopped',
    desiredRunning: false,
    // Preserve the source encoder contract. Do not invent encoderRequired:true.
    encoderRequired: identity.encoderRequired === true,
    ...(reviewed?.networkBindings ? { networkBindings: reviewed.networkBindings } : {}),
  };
  if (identity.profile?.name) state.profile = { ...identity.profile };
  if (typeof identity.fingerprint === 'string') state.fingerprint = identity.fingerprint;
  if (identity.birth?.home?.id && identity.birth?.coordination?.botId) {
    state.birth = {
      home: {
        id: identity.birth.home.id,
        ...(typeof identity.birth.home.name === 'string' && identity.birth.home.name
          ? { name: identity.birth.home.name }
          : {}),
      },
      coordination: { botId: identity.birth.coordination.botId },
    };
  }
  if (identity.residentMap) {
    const residents = Object.keys(identity.residentMap);
    const portSets = reviewed?.networkBindings?.residents || (residents.length > 1 ? residentInstancePortSets(ports, residents) : null);
    state.residentMap = Object.fromEntries(residents.map(name => [
      name,
      {
        ...identity.residentMap[name],
        ...(portSets ? { ports: portSets[name] } : {}),
      },
    ]));
  }
  writeFileSync(join(destination, '.home23-host.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

function refuseAdoption(plan, reasons, destination) {
  return {
    ok: false,
    status: 'refused',
    schema: ADOPTION_SCHEMA,
    canAdopt: false,
    reasons: reasons || plan.reasons,
    destinationCreated: existsSync(destination),
    plan,
  };
}

function verifyAdoptionPackages(payload, destination, destinationPresent) {
  try { verifyProductPayload(payload); }
  catch (error) {
    throw Object.assign(new Error(error.message || 'Candidate package failed integrity verification.'), { code: 'package_integrity_failed' });
  }
  if (destinationPresent && marker(destination, '.home23-install.json')) {
    try { verifyProductPayload(destination, { allowRuntimeState: true }); }
    catch (error) {
      throw Object.assign(new Error(error.message || 'Destination package failed integrity verification.'), { code: 'package_integrity_failed' });
    }
  }
}

/**
 * Adopt a stopped managed/source home into a new product destination.
 * Holds the managed supervisor lock from before copy until the post-copy
 * snapshot matches. Never installs over the source, never runs home birth,
 * never starts writers.
 */
export async function adoptManagedSourceHome({ sourceHome, destinationRoot, payloadPath, preservationPlan = null, planHash } = {}, dependencies = {}) {
  const source = previewRoot(sourceHome);
  const destination = previewRoot(destinationRoot);
  const payload = previewRoot(payloadPath);
  disjointRoots(source, destination, payload);

  const plan = planManagedSourceAdoption(source, { preservationPlan, planHash });
  if (!plan.canAdopt) return refuseAdoption(plan, plan.reasons, destination);

  let identity = resolveAdoptionIdentity(source);
  if (!identity.ok) {
    return refuseAdoption(plan, [reason(identity.code, identity.message)], destination);
  }

  let manifest;
  try { manifest = readProductManifest(payload); }
  catch {
    return refuseAdoption(plan, [reason('candidate_manifest_invalid', 'The candidate manifest is missing or invalid.')], destination);
  }
  for (const authority of retainedAuthorities(plan.inventory.paths)) {
    const path = authority.reviewedDestination;
    if (manifest.files.some(entry => entry.path === path || entry.path.startsWith(`${path}/`))) {
      return refuseAdoption(plan, [reason('authority_payload_collision', `The candidate package owns retained authority path ${path}.`, { path })], destination);
    }
  }
  const packageId = manifest.packageId;
  const sourceSnapshot = sourceAdoptionSnapshot(source, plan.inventory.paths, identity);

  let journal = null;
  try { journal = readAdoptionJournal(destination); }
  catch (error) { throw error; }

  const destinationPresent = existsSync(destination);
  if (!journal && destinationPresent) throw new Error('Adoption destination already exists.');

  if (journal) {
    if (journal.sourceHome !== source) throw new Error('Adoption journal belongs to another source.');
    if ((journal.preservationPlanHash || null) !== (plan.preservationPlanHash || null)) throw new Error('Adoption preservation plan changed since adoption started.');
    if (JSON.stringify(journal.preservationPlan || null) !== JSON.stringify(preservationPlan || null)) throw new Error('Adoption preservation choices changed since adoption started.');
    if (journal.payloadPath !== payload) throw new Error('Adoption journal belongs to another payload.');
    try { verifyAdoptionPackages(payload, destination, destinationPresent); }
    catch (error) {
      return refuseAdoption(plan, [reason(error.code || 'package_integrity_failed', error.message)], destination);
    }
    if (journal.packageId !== packageId) {
      return refuseAdoption(plan, [reason('package_identity_changed', 'The candidate package identity changed since adoption started.')], destination);
    }
    if (journal.sourceSnapshot !== sourceSnapshot) {
      return refuseAdoption(plan, [reason('source_identity_changed', 'Preserved source or adoption identity inputs changed since adoption started.')], destination);
    }
    if (destinationPresent && marker(destination, '.home23-install.json')) {
      const receipt = readPrivateJSON(join(destination, '.home23-install.json'));
      if (!(receipt?.schema === INSTALL_SCHEMA && receipt.status === 'installed' && receipt.packageId === packageId)) {
        return refuseAdoption(plan, [reason('receipt_mismatch', 'The destination receipt does not match the recorded package identity.')], destination);
      }
    }
  }

  if (journal?.phase === 'completed') {
    return refuseAdoption(plan, [reason(
      'supervisor_fence_unavailable',
      'Managed/source adoption is unavailable. A journal already marked completed is not adoption success.',
    )], destination);
  }

  let releaseLock;
  try {
    releaseLock = holdAdoptionSupervisorLock(source, identity, dependencies);
  } catch (error) {
    return refuseAdoption(plan, [reason(error.code || 'supervisor_lock_unavailable', error.message)], destination);
  }

  try {
    // Inventory the managed supervisor before any destination mutation or preserve copy.
    await assertAdoptionWritersStopped(source, dependencies, identity.writers);
    const reviewed = validateAdoptionPreservationPlan(source, preservationPlan, planHash);
    await verifySourceServiceBindings(source, reviewed?.services || [], dependencies);
    identity = verifyContinuingBirth(source, identity, reviewed);
  } catch (error) {
    try { releaseLock(); } catch { /* unlock best-effort */ }
    return refuseAdoption(plan, [reason(error.code || 'process_inventory_unavailable', error.message)], destination);
  }

  const resumed = Boolean(journal && journal.phase !== 'installing');
  const rebind = dependencies.rebindAdoptedHome || rebindAdoptedHome;
  const install = dependencies.installProductPayload || installProductPayload;

  try {
    if (!journal) {
      journal = {
        schema: ADOPTION_JOURNAL_SCHEMA,
        sourceHome: source,
        destinationRoot: destination,
        payloadPath: payload,
        packageId,
        preservationPlanHash: plan.preservationPlanHash || null,
        sourceSnapshot,
        phase: 'installing',
        preservationPlan: preservationPlan || null,
        homeBirth: 'not_run',
        residents: identity.residents,
        residentMap: identity.residentMap || null,
      };
      writeAdoptionJournal(destination, journal);
    }

    if (!['preserving', 'rebind', 'completed'].includes(journal.phase)) {
      if (destinationPresent && marker(destination, '.home23-install.json')) {
        const receipt = readPrivateJSON(join(destination, '.home23-install.json'));
        if (!(receipt?.schema === INSTALL_SCHEMA && receipt.status === 'installed' && receipt.packageId === packageId)) {
          return refuseAdoption(plan, [reason('receipt_mismatch', 'The destination receipt does not match the recorded package identity.')], destination);
        }
        try { verifyProductPayload(destination, { allowRuntimeState: true }); }
        catch (error) {
          return refuseAdoption(plan, [reason('package_integrity_failed', error.message)], destination);
        }
      } else {
        journal = { ...journal, phase: 'installing', packageId, sourceSnapshot };
        writeAdoptionJournal(destination, journal);
        install({ payloadPath: payload, homeRoot: destination });
        try { verifyProductPayload(destination, { allowRuntimeState: true }); }
        catch (error) {
          return refuseAdoption(plan, [reason('package_integrity_failed', error.message)], destination);
        }
      }
      journal = { ...journal, phase: 'preserving', packageId, sourceSnapshot };
      writeAdoptionJournal(destination, journal);
      if (dependencies.afterInstall) await dependencies.afterInstall({ source, destination, journal });
    }

    if (!['rebind', 'completed'].includes(journal.phase)) {
      const currentSnapshot = sourceAdoptionSnapshot(source, plan.inventory.paths, identity);
      if (currentSnapshot !== journal.sourceSnapshot) {
        return refuseAdoption(plan, [reason('source_identity_changed', 'Preserved source or adoption identity inputs changed before preservation completed.')], destination);
      }
      // Re-check under the held lock immediately before the preserve copy.
      try {
        await assertAdoptionWritersStopped(source, dependencies, identity.writers);
      } catch (error) {
        return refuseAdoption(plan, [reason(error.code || 'process_inventory_unavailable', error.message)], destination);
      }
      if (dependencies.beforePreserveCopy) await dependencies.beforePreserveCopy({ source, destination, journal, releaseLock });
      copyPreservedState(source, destination, plan.inventory.paths);
      if (dependencies.afterPreserveCopy) await dependencies.afterPreserveCopy({ source, destination, journal, releaseLock });
      // Re-walk after copy so files created during the window change the snapshot.
      const liveReasons = [];
      let livePaths;
      try { livePaths = walkAdoptionPaths(source, liveReasons, validateAdoptionPreservationPlan(source, preservationPlan, planHash)); }
      catch {
        return refuseAdoption(plan, [reason('inventory_unreadable', 'The adoption inventory could not be re-walked after preservation.')], destination);
      }
      if (liveReasons.length) {
        return refuseAdoption(plan, liveReasons, destination);
      }
      const afterIdentity = resolveAdoptionIdentity(source);
      if (!afterIdentity.ok) {
        return refuseAdoption(plan, [reason(afterIdentity.code, afterIdentity.message)], destination);
      }
      annotateMappings(livePaths, afterIdentity, liveReasons);
      if (liveReasons.length) {
        return refuseAdoption(plan, liveReasons, destination);
      }
      if (sourceAdoptionSnapshot(source, livePaths, afterIdentity) !== journal.sourceSnapshot) {
        return refuseAdoption(plan, [reason('source_identity_changed', 'Preserved source changed during the copy window; newly created files cannot finish as adopted.')], destination);
      }
      await writeStoppedHost(destination, identity, dependencies, validateAdoptionPreservationPlan(source, preservationPlan, planHash));
      journal = { ...journal, phase: 'rebind', residents: identity.residents, residentMap: identity.residentMap || null };
      writeAdoptionJournal(destination, journal);
      if (dependencies.afterPreserve) await dependencies.afterPreserve({ source, destination, journal, releaseLock });
    }

    if (journal.phase !== 'completed') {
      try { verifyProductPayload(payload); }
      catch (error) {
        return refuseAdoption(plan, [reason('package_integrity_failed', error.message)], destination);
      }
      // Make reviewed external authorities visible to the rebind before it
      // examines config files beneath retained directory links.
      writeAdoptedLinks(destination, plan.inventory.paths, source, validateAdoptionPreservationPlan(source, preservationPlan, planHash));
      await rebind(source, destination);
      applyReviewedPathRewrites(destination, plan.inventory.paths,
        validateAdoptionPreservationPlan(source, preservationPlan, planHash)?.rewrites || []);
      const host = JSON.parse(readFileSync(join(destination, '.home23-host.json'), 'utf8'));
      host.desiredRunning = false;
      host.phase = 'stopped';
      host.homeRoot = destination;
      if (identity.profile?.name) {
        host.profile = { ...(host.profile || {}), ...identity.profile };
      }
      if (identity.residentMap) {
        const current = host.residentMap && typeof host.residentMap === 'object' ? host.residentMap : {};
        host.residentMap = Object.fromEntries(Object.keys(identity.residentMap).map(name => [
          name,
          {
            ...identity.residentMap[name],
            ...(current[name] && typeof current[name] === 'object' ? current[name] : {}),
            ...identity.residentMap[name],
            ...(current[name]?.ports ? { ports: current[name].ports } : {}),
          },
        ]));
      } else {
        delete host.residentMap;
      }
      if (typeof identity.fingerprint === 'string') host.fingerprint = identity.fingerprint;
      host.continuationServices = (validateAdoptionPreservationPlan(source, preservationPlan, planHash)?.services || []).map(service => ({
        name: service.name, ...service.run,
      }));
      writeFileSync(join(destination, '.home23-host.json'), `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
      // The source remains intact for recovery, but its managed start paths
      // must not admit a second authoritative writer after this point.
      privateJSON(join(source, 'instances/.house/maintenance/adopted-source.json'), {
        schema: 'home23.adopted-source-fence.v1', sourceRoot: source, destinationRoot: destination,
        packageId, sourceSnapshot, preservationPlanHash: plan.preservationPlanHash || null,
        transferredWriters: [...new Set(['home23-coordination', 'home23-seed-observatory', ...identity.writers,
          ...(validateAdoptionPreservationPlan(source, preservationPlan, planHash)?.services || []).map(service => service.name)])].sort(),
      });
      journal = { ...journal, phase: 'completed', homeBirth: 'not_run' };
      writeAdoptionJournal(destination, journal);
    }

    const host = JSON.parse(readFileSync(join(destination, '.home23-host.json'), 'utf8'));
    return {
      ok: true,
      status: 'adopted',
      schema: ADOPTION_SCHEMA,
      canAdopt: true,
      sourceHome: source,
      destinationRoot: destination,
      resumed,
      homeBirth: 'not_run',
      desiredRunning: host.desiredRunning === true,
      phase: host.phase,
      profile: host.profile || null,
      residentMap: host.residentMap || null,
      residents: identity.residents,
      plan,
    };
  } finally {
    try { releaseLock(); } catch { /* lock release is best-effort after adoption outcome */ }
  }
}

export { previewRoot, inspectProductInstallation, previewProductUpdate } from './product-update-preview.js';
