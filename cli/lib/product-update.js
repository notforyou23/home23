/** Product installation preview and managed/source adoption. Preview stays read-only. */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { absoluteHome, choosePortPlan, privateJSON, readPrivateJSON } from './product-environment.js';
import { rebindAdoptedHome } from './product-backup.js';
import { installProductPayload, readProductManifest, verifyProductPayload } from './product-payload.js';
import { compareUpdateContracts, inspectStatePreservation } from './product-update-plan.js';

const INSTALL_SCHEMA = 'home23.product-install.v1';
const ADOPTION_SCHEMA = 'home23.managed-source-adoption.v1';
const ADOPTION_JOURNAL_SCHEMA = 'home23.managed-source-adoption-journal.v1';
const reason = (code, message, extra = {}) => ({ code, message, ...extra });

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
  'node_modules', 'dist', 'logs', '.git',
]);
const ADOPTION_REBUILDABLE_PREFIXES = [
  'node_modules/', 'dist/', 'logs/', '.git/',
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

function mapPreservedRelative(relative) {
  if (relative === 'ecosystem.config.cjs') return 'app/ecosystem.config.cjs';
  if (relative === 'runtime/semantic-prep.json') return 'runtime/semantic-prep.json';
  if (relative.startsWith('config/')) return `app/${relative}`;
  if (relative.startsWith('instances/')) return `app/${relative}`;
  return null;
}

function shouldCopyForAdoption(entry) {
  if (entry.type !== 'file' || entry.external) return false;
  if (entry.path === 'runtime/semantic-prep.json') return true;
  if (entry.path === 'ecosystem.config.cjs') return true;
  if (entry.role !== 'preserve') return false;
  if (entry.path === 'instances/.house/coordination/active-release.json') return false;
  if (entry.path === 'instances/.house/source-authority.json') return false;
  return Boolean(mapPreservedRelative(entry.path));
}

function copyPreservedState(source, destination, paths) {
  for (const entry of paths) {
    if (!shouldCopyForAdoption(entry)) continue;
    const mapped = mapPreservedRelative(entry.path);
    if (!mapped) continue;
    const from = join(source, entry.path);
    const stat = lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const to = join(destination, mapped);
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    copyFileSync(from, to);
  }
}

function sourceResidentName(source) {
  const hostPath = join(source, '.home23-host.json');
  if (existsSync(hostPath) && lstatSync(hostPath).isFile() && !lstatSync(hostPath).isSymbolicLink()) {
    try {
      const host = JSON.parse(readFileSync(hostPath, 'utf8'));
      if (/^[a-z][a-z0-9-]{0,62}$/.test(host?.profile?.name || '')) return host.profile.name;
    } catch { /* fall through to directory scan */ }
  }
  const instances = join(source, 'instances');
  if (!existsSync(instances)) return null;
  for (const name of readdirSync(instances).sort()) {
    if (name.startsWith('.')) continue;
    if (lstatSync(join(instances, name)).isDirectory()) return name;
  }
  return null;
}

async function writeStoppedHost(source, destination) {
  const name = sourceResidentName(source);
  let encoderRequired = false;
  let profile = name ? { name } : undefined;
  const hostPath = join(source, '.home23-host.json');
  if (existsSync(hostPath) && lstatSync(hostPath).isFile() && !lstatSync(hostPath).isSymbolicLink()) {
    try {
      const host = JSON.parse(readFileSync(hostPath, 'utf8'));
      encoderRequired = host.encoderRequired === true;
      if (host.profile && typeof host.profile === 'object') profile = { ...host.profile, ...(name ? { name } : {}) };
    } catch { /* keep scanned profile */ }
  }
  const ports = await choosePortPlan({ encoderRequired });
  const state = {
    schema: 'home23.host.v2',
    homeRoot: destination,
    profile: profile || { name: 'resident' },
    fingerprint: 'adopted',
    ports,
    phase: 'stopped',
    desiredRunning: false,
    encoderRequired,
  };
  writeFileSync(join(destination, '.home23-host.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

/**
 * Adopt a stopped managed/source home into a new product destination.
 * Never installs over the source, never runs home birth, never starts writers.
 */
export async function adoptManagedSourceHome({ sourceHome, destinationRoot, payloadPath } = {}, dependencies = {}) {
  const source = previewRoot(sourceHome);
  const destination = previewRoot(destinationRoot);
  const payload = previewRoot(payloadPath);
  disjointRoots(source, destination, payload);

  const plan = planManagedSourceAdoption(source);
  if (!plan.canAdopt) {
    return {
      ok: false,
      status: 'refused',
      schema: ADOPTION_SCHEMA,
      canAdopt: false,
      reasons: plan.reasons,
      destinationCreated: existsSync(destination),
      plan,
    };
  }

  let journal = null;
  try { journal = readAdoptionJournal(destination); }
  catch (error) { throw error; }

  const destinationPresent = existsSync(destination);
  if (!journal && destinationPresent) throw new Error('Adoption destination already exists.');
  if (journal && journal.sourceHome !== source) throw new Error('Adoption journal belongs to another source.');
  if (journal && journal.payloadPath !== payload) throw new Error('Adoption journal belongs to another payload.');

  const rebind = dependencies.rebindAdoptedHome || rebindAdoptedHome;
  const install = dependencies.installProductPayload || installProductPayload;
  const resumed = Boolean(journal && journal.phase !== 'installing');

  if (!journal) {
    journal = {
      schema: ADOPTION_JOURNAL_SCHEMA,
      sourceHome: source,
      destinationRoot: destination,
      payloadPath: payload,
      phase: 'installing',
      homeBirth: 'not_run',
    };
    writeAdoptionJournal(destination, journal);
  }

  if (!['preserving', 'rebind', 'completed'].includes(journal.phase)) {
    if (destinationPresent && marker(destination, '.home23-install.json')) {
      const receipt = readPrivateJSON(join(destination, '.home23-install.json'));
      const manifest = readProductManifest(payload);
      if (receipt?.schema === INSTALL_SCHEMA && receipt.status === 'installed' && receipt.packageId === manifest.packageId) {
        // Owned same-package receipt: resume without a second full install copy.
      } else {
        throw new Error('Adoption destination receipt does not match the candidate package.');
      }
    } else {
      journal = { ...journal, phase: 'installing' };
      writeAdoptionJournal(destination, journal);
      install({ payloadPath: payload, homeRoot: destination });
    }
    journal = { ...journal, phase: 'preserving' };
    writeAdoptionJournal(destination, journal);
    if (dependencies.afterInstall) await dependencies.afterInstall({ source, destination, journal });
  }

  if (!['rebind', 'completed'].includes(journal.phase)) {
    copyPreservedState(source, destination, plan.inventory.paths);
    await writeStoppedHost(source, destination);
    journal = { ...journal, phase: 'rebind' };
    writeAdoptionJournal(destination, journal);
    if (dependencies.afterPreserve) await dependencies.afterPreserve({ source, destination, journal });
  }

  if (journal.phase !== 'completed') {
    await rebind(source, destination);
    const host = JSON.parse(readFileSync(join(destination, '.home23-host.json'), 'utf8'));
    host.desiredRunning = false;
    host.phase = 'stopped';
    host.homeRoot = destination;
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
    plan,
  };
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
