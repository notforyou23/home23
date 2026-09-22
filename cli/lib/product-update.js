/** Product installation preview and managed/source adoption. Preview stays read-only. */
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteHome, choosePortPlan, privateJSON, readPrivateJSON } from './product-environment.js';
import { rebindAdoptedHome } from './product-backup.js';
import { installProductPayload, readProductManifest, verifyProductPayload } from './product-payload.js';
import { compareUpdateContracts, inspectStatePreservation } from './product-update-plan.js';
import { acquireSupervisorLock } from '../../scripts/release/supervisor.mjs';

const require = createRequire(import.meta.url);
const { agentProcessNames, managedResidentWriters } = require('../../shared/agent-process-names.cjs');

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
]);
const ADOPTION_REBUILDABLE = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'node_modules', 'dist', 'logs', '.git', 'bin', 'tools', 'app',
]);
const ADOPTION_REBUILDABLE_PREFIXES = [
  'node_modules/', 'dist/', 'logs/', '.git/',
  'bin/', 'tools/', 'app/',
  'engine/logs/',
];

function marker(root, relative) {
  try { lstatSync(join(root, relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sensitivePresenceOnly(relative) {
  const name = basename(relative);
  return name === 'secrets.yaml' || /token/i.test(name);
}

/** Classify one relative path for managed/source adoption. Presence only; never opens files. */
export function classifyAdoptionPath(relative) {
  if (ADOPTION_REBIND.has(relative)) return 'rebind';
  if (relative === 'birth-receipt.json' || relative.endsWith('/birth-receipt.json')) return 'preserve';
  if (relative === 'seed-ledger.jsonl' || relative.endsWith('/seed-ledger.jsonl')) return 'preserve';
  if (ADOPTION_PRESERVE_FILES.has(relative)) return 'preserve';
  if (relative === 'config' || relative.startsWith('config/')) return 'preserve';
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
        if (info.dangling || info.outside || role === 'preserve' || role === 'rebind') {
          reasons.push(reason('external_state', `Linked path ${relative} is not a captured file inside this home.`, { path: relative }));
        }
      }
      paths.push(entry);
      if (type === 'symlink' || type === 'other' || type !== 'directory') return;
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

  if (residentNames.length === 0) {
    if (!host) {
      return { ok: false, code: 'unsupported_layout', message: 'Managed/source adoption needs a Host record or active-release residents.' };
    }
    return {
      ok: true,
      profile: { ...host.profile },
      encoderRequired: host.encoderRequired === true,
      fingerprint: typeof host.fingerprint === 'string' ? host.fingerprint : undefined,
      ports: host.ports && typeof host.ports === 'object' ? host.ports : undefined,
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

  if (residentNames.length === 1) {
    const name = residentNames[0];
    if (host) {
      return {
        ok: true,
        profile: { ...host.profile },
        encoderRequired: host.encoderRequired === true,
        fingerprint: typeof host.fingerprint === 'string' ? host.fingerprint : undefined,
        ports: host.ports && typeof host.ports === 'object' ? host.ports : undefined,
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
      source: 'active-release',
      residents: residentNames,
      residentMap: null,
      writers,
    };
  }

  return {
    ok: true,
    profile: host ? { ...host.profile } : undefined,
    encoderRequired: host?.encoderRequired === true,
    fingerprint: typeof host?.fingerprint === 'string' ? host.fingerprint : undefined,
    ports: host?.ports && typeof host.ports === 'object' ? host.ports : undefined,
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
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    copyFileSync(from, to);
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
  const Database = dependencies.Database || loadBetterSqlite3(source);
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
    encoderRequired: identity.encoderRequired === true,
  };
  if (identity.profile?.name) state.profile = { ...identity.profile };
  if (typeof identity.fingerprint === 'string') state.fingerprint = identity.fingerprint;
  if (identity.residentMap) state.residentMap = identity.residentMap;
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
      if (dependencies.beforePreserveCopy) await dependencies.beforePreserveCopy({ source, destination, journal, releaseLock });
      copyPreservedState(source, destination, plan.inventory.paths);
      if (dependencies.afterPreserveCopy) await dependencies.afterPreserveCopy({ source, destination, journal, releaseLock });
      const afterIdentity = resolveAdoptionIdentity(source);
      if (!afterIdentity.ok
        || sourceAdoptionSnapshot(source, plan.inventory.paths, afterIdentity) !== journal.sourceSnapshot) {
        return refuseAdoption(plan, [reason('source_identity_changed', 'Preserved source or adoption identity inputs changed during preservation copy.')], destination);
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
      if (identity.residentMap) host.residentMap = identity.residentMap;
      else delete host.residentMap;
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

export function previewRoot(value) {
  const root = absoluteHome(value);
  // absoluteHome's existsSync guard skips dangling links. Do not mistake a
  // location below one for a new, absent home.
  for (let current = root; ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Home23 preview requires real directory ancestors.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  return root;
}

function safeIdentity(manifest) {
  return manifest && { packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
    platform: manifest.platform, arch: manifest.arch, nodeVersion: manifest.nodeVersion };
}

function classifyUninstalled(root) {
  if (marker(root, 'instances/.house/coordination/active-release.json')) return 'managed';
  if (marker(root, '.git') || marker(root, 'package.json')) return 'source';
  return 'unknown';
}

/** Inspect only the installation receipt, manifest, and declared package files. */
export function inspectProductInstallation(homeRoot) {
  const root = previewRoot(homeRoot);
  try { return inspectRoot(root); }
  catch { return { root, layout: 'unknown', identity: null, reasons: [reason('layout_unreadable', 'The installation layout could not be inspected.')] }; }
}

function inspectRoot(root) {
  let stat;
  try { stat = lstatSync(root); } catch (error) {
    if (error.code === 'ENOENT') return { root, layout: 'absent', identity: null, reasons: [] };
    return { root, layout: 'unknown', identity: null, reasons: [reason('layout_unreadable', 'The installation location could not be inspected.')] };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { root, layout: 'unknown', identity: null, reasons: [reason('unsupported_layout', 'The installation root is not a private directory.')] };
  const receiptPath = join(root, '.home23-install.json');
  if (!marker(root, '.home23-install.json')) {
    const layout = classifyUninstalled(root);
    return { root, layout, identity: null, reasons: [reason(layout === 'managed' ? 'managed_installation' : layout === 'source' ? 'source_installation' : 'unknown_layout',
      layout === 'managed' ? 'A managed release marker was found.' : layout === 'source' ? 'A source checkout marker was found.' : 'No owned product receipt identifies this layout.')] };
  }
  let receipt;
  try {
    if (!lstatSync(receiptPath).isFile()) throw new Error('Invalid receipt file');
    receipt = readPrivateJSON(receiptPath);
    if (!receipt) throw new Error('Missing receipt');
  } catch { return { root, layout: 'product', identity: null, reasons: [reason('invalid_private_receipt', 'The product receipt is missing, malformed, or not a private user-owned file.')] }; }
  let manifest;
  try { manifest = readProductManifest(root); } catch { return { root, layout: 'product', identity: null, reasons: [reason('invalid_manifest', 'The installed product manifest is missing or invalid.')] }; }
  const identity = safeIdentity(manifest);
  const receiptMatches = receipt?.schema === INSTALL_SCHEMA && receipt.status === 'installed' && receipt.homeRoot === root &&
    receipt.appRoot === join(root, 'app') && receipt.nodePath === join(root, 'bin', 'node') && receipt.pm2Path === join(root, 'tools', 'node_modules', 'pm2', 'bin', 'pm2') && receipt.packageId === manifest.packageId && receipt.sourceCommit === manifest.sourceCommit;
  if (!receiptMatches) return { root, layout: 'product', identity, reasons: [reason('receipt_mismatch', 'The installation receipt does not match its product manifest and paths.')] };
  try { verifyProductPayload(root, { allowRuntimeState: true }); }
  catch { return { root, layout: 'product', identity, reasons: [reason('modified_installation', 'A declared installed file, mode, link, or layout has changed.')] }; }
  if (marker(root, 'app/instances/.house/coordination/active-release.json')) return { root, layout: 'product', identity, reasons: [reason('mixed_managed_layout', 'A managed release marker is present inside this product installation.')] };
  return { root, layout: 'product', identity, reasons: [] };
}

/** Compare an owned installation with one explicit candidate package, without claiming readiness. */
export function previewProductUpdate({ homeRoot, candidatePayload }) {
  const current = inspectProductInstallation(homeRoot);
  const candidateRoot = candidatePayload ? previewRoot(candidatePayload) : null;
  const result = { ok: true, status: 'preview', homeRoot: current.root, current, candidate: null,
    canInstall: false, publisherTrust: 'unverified', stateMigrationCompatibility: 'unverified', reasons: [] };
  if (!candidatePayload) { result.reasons.push(reason('candidate_required', 'Choose an explicit candidate payload.')); return result; }
  let manifest;
  try { manifest = readProductManifest(candidateRoot); }
  catch { result.reasons.push(reason('candidate_manifest_invalid', 'The candidate manifest is missing or invalid.')); return result; }
  result.candidate = { root: candidateRoot, identity: safeIdentity(manifest) };
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    result.reasons.push(reason('candidate_platform_unsupported', 'The candidate targets another platform or architecture.'));
    return result;
  }
  try { verifyProductPayload(candidateRoot); }
  catch {
    result.reasons.push(reason('candidate_integrity_failed', 'The candidate package failed its integrity checks.'));
    return result;
  }
  if (current.layout !== 'product' || current.reasons.length) {
    result.reasons.push(...current.reasons);
    if (!current.reasons.length) result.reasons.push(reason('unsupported_layout', 'The current home is not an owned product installation.'));
    return result;
  }
  result.preservation = inspectStatePreservation(current.root);
  const installed = readProductManifest(current.root);
  if (installed.packageId !== current.identity.packageId) {
    result.reasons.push(reason('installation_changed', 'The installed package changed during preview.'));
    return result;
  }
  result.compatibility = compareUpdateContracts(installed, manifest);
  if (current.identity.packageId === manifest.packageId) result.reasons.push(reason('same_package', 'The candidate is the same package already installed.'));
  else result.reasons.push(reason('different_package', 'The candidate is a different structurally valid package.'));
  return result;
}
