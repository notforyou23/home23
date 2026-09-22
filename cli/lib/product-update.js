/** Read-only product installation and candidate preview. No network or writes. */
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { absoluteHome, readPrivateJSON } from './product-environment.js';
import { readProductManifest, verifyProductPayload } from './product-payload.js';
import { compareUpdateContracts, inspectStatePreservation } from './product-update-plan.js';

const INSTALL_SCHEMA = 'home23.product-install.v1';
const ADOPTION_SCHEMA = 'home23.managed-source-adoption.v1';
const reason = (code, message, extra = {}) => ({ code, message, ...extra });

const ADOPTION_REBIND = new Set([
  'ecosystem.config.cjs',
  'instances/.house/coordination/active-release.json',
  'instances/.house/source-authority.json',
]);
const ADOPTION_PRESERVE_FILES = new Set([
  'config/home.yaml', 'config/targets.yaml', 'config/secrets.yaml',
  'config/agents.json', 'config/cron-jobs.json',
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
  if (ADOPTION_REBUILDABLE.has(relative)) return 'rebuildable';
  if (ADOPTION_REBUILDABLE_PREFIXES.some(prefix => relative.startsWith(prefix))) return 'rebuildable';
  return 'unknown';
}

function walkAdoptionPaths(root) {
  const paths = [];
  const visit = relative => {
    const absolute = relative ? join(root, relative) : root;
    const stat = lstatSync(absolute);
    if (relative) {
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      const role = type === 'other' ? 'unknown' : classifyAdoptionPath(relative);
      const entry = { path: relative, type, role };
      if (sensitivePresenceOnly(relative)) entry.contents = 'unopened';
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
    if (entry.role !== 'preserve' || entry.type === 'directory') return false;
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
  try { paths = walkAdoptionPaths(root); }
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
