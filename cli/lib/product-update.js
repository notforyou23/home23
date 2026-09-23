/** Product installation preview and managed/source adoption. Preview stays read-only. */
import { createHash } from 'node:crypto';
import {
  copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { choosePortPlan, privateJSON, readPrivateJSON } from './product-environment.js';
import { assertWritersIdle, rebindAdoptedHome, residentInstancePortSets } from './product-backup.js';
import { installProductPayload, readProductManifest, verifyProductPayload } from './product-payload.js';
import { inspectProductInstallation, previewRoot } from './product-update-preview.js';
import { acquireSupervisorLock } from '../../scripts/release/supervisor.mjs';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const { agentProcessNames, managedResidentWriters } = require('../../shared/agent-process-names.cjs');

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

function walkAdoptionPaths(root, reasons) {
  const paths = [];
  const visit = relative => {
    const absolute = relative ? join(root, relative) : root;
    const stat = lstatSync(absolute);
    if (relative) {
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      const role = type === 'other' ? 'unknown' : classifyAdoptionPath(relative);
      const entry = { path: relative, type, role };
      if (sensitivePresenceOnly(relative)) entry.contents = 'unopened';
      if (type === 'symlink') {
        const info = symlinkTargetInfo(root, relative);
        entry.external = true;
        entry.target = info.target;
        // Broad instances/config preserve must not swallow linked external state.
        if (role !== 'rebuildable' && (info.dangling || info.outside || role === 'preserve' || role === 'rebind')) {
          reasons.push(reason('external_state', `Linked path ${relative} is not a captured file inside this home.`, { path: relative }));
        }
      }
      paths.push(entry);
      if (type !== 'directory') return;
      // Neither subtree can be copied. Unknown roots already block adoption;
      // rebuildable roots are replaced by the package. Avoid walking source
      // checkouts and dependency trees when planning an existing home.
      if (role === 'unknown' || role === 'rebuildable') return;
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return;
    }
    for (const name of readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
  };
  visit('');
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
  if (entry.type === 'symlink') {
    return { ok: true, action: 'external' };
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
  for (const entry of paths) {
    if (entry.role !== 'preserve' && entry.role !== 'rebind') continue;
    if (entry.type === 'directory' || entry.type === 'symlink') continue;
    const mapped = mapAdoptionEntry(entry, rootResident);
    entry.mapping = mapped;
    if (!mapped.ok) {
      reasons.push(reason(mapped.code || 'unmapped_preserve', mapped.message || `Path ${entry.path} is not mapped for adoption.`, { path: entry.path }));
    }
  }
}

/**
 * Read-only managed/source adoption plan. Never writes, never opens secrets or
 * token files, never runs home birth, and never claims product install adoption.
 */
export function planManagedSourceAdoption(homeRoot) {
  const current = inspectProductInstallation(homeRoot);
  const root = current.root;
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
  let paths;
  try { paths = walkAdoptionPaths(root, result.reasons); }
  catch {
    result.reasons.push(reason('inventory_unreadable', 'The adoption inventory could not be walked.'));
    return result;
  }
  result.inventory.paths = paths;
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
  return hash.digest('hex');
}

function copyPreservedState(source, destination, paths) {
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
    if (entry.path === 'engine/.env') chmodSync(to, 0o600);
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

async function writeStoppedHost(destination, identity, dependencies = {}) {
  const choose = dependencies.choosePortPlan || choosePortPlan;
  const ports = identity.ports && typeof identity.ports === 'object'
    ? identity.ports
    : await choose({ encoderRequired: identity.encoderRequired === true });
  const state = {
    schema: 'home23.host.v2',
    homeRoot: destination,
    ports,
    phase: 'stopped',
    desiredRunning: false,
    // Preserve the source encoder contract. Do not invent encoderRequired:true.
    encoderRequired: identity.encoderRequired === true,
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
    const portSets = residents.length > 1 ? residentInstancePortSets(ports, residents) : null;
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
export async function adoptManagedSourceHome({ sourceHome, destinationRoot, payloadPath } = {}, dependencies = {}) {
  const source = previewRoot(sourceHome);
  const destination = previewRoot(destinationRoot);
  const payload = previewRoot(payloadPath);
  disjointRoots(source, destination, payload);

  const plan = planManagedSourceAdoption(source);
  if (!plan.canAdopt) return refuseAdoption(plan, plan.reasons, destination);

  const identity = resolveAdoptionIdentity(source);
  if (!identity.ok) {
    return refuseAdoption(plan, [reason(identity.code, identity.message)], destination);
  }

  let manifest;
  try { manifest = readProductManifest(payload); }
  catch {
    return refuseAdoption(plan, [reason('candidate_manifest_invalid', 'The candidate manifest is missing or invalid.')], destination);
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
        sourceSnapshot,
        phase: 'installing',
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
      try { livePaths = walkAdoptionPaths(source, liveReasons); }
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
      await writeStoppedHost(destination, identity, dependencies);
      journal = { ...journal, phase: 'rebind', residents: identity.residents, residentMap: identity.residentMap || null };
      writeAdoptionJournal(destination, journal);
      if (dependencies.afterPreserve) await dependencies.afterPreserve({ source, destination, journal, releaseLock });
    }

    if (journal.phase !== 'completed') {
      try { verifyProductPayload(payload); }
      catch (error) {
        return refuseAdoption(plan, [reason('package_integrity_failed', error.message)], destination);
      }
      await rebind(source, destination);
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
      writeFileSync(join(destination, '.home23-host.json'), `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
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
