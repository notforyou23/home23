/** Product installation and candidate preview. Kept independent of adoption so
 * the recovery controller can inspect a home without loading managed services. */
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { absoluteHome, readPrivateJSON } from './product-environment.js';
import { readProductManifest, verifyProductPayload } from './product-payload.js';
import { compareUpdateContracts, inspectStatePreservation } from './product-update-plan.js';

const INSTALL_SCHEMA = 'home23.product-install.v1';
const reason = (code, message, extra = {}) => ({ code, message, ...extra });

function marker(root, relative) {
  try { lstatSync(join(root, relative)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
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

/** Inspect an installation; callers may defer declared-file verification until selection. */
export function inspectProductInstallation(homeRoot, { verifyFiles = true } = {}) {
  const root = previewRoot(homeRoot);
  try { return inspectRoot(root, verifyFiles); }
  catch { return { root, layout: 'unknown', identity: null, reasons: [reason('layout_unreadable', 'The installation layout could not be inspected.')] }; }
}

function inspectRoot(root, verifyFiles) {
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
  if (verifyFiles) {
    try { verifyProductPayload(root, { allowRuntimeState: true }); }
    catch { return { root, layout: 'product', identity, reasons: [reason('modified_installation', 'A declared installed file, mode, link, or layout has changed.')] }; }
  }
  if (marker(root, 'app/instances/.house/coordination/active-release.json')) return { root, layout: 'product', identity, reasons: [reason('mixed_managed_layout', 'A managed release marker is present inside this product installation.')] };
  return { root, layout: 'product', identity, reasons: [] };
}

/** Compare an owned installation with one explicit candidate package, without claiming readiness. */
export function previewProductUpdate({ homeRoot, candidatePayload }, { verifyFiles = true } = {}) {
  const current = inspectProductInstallation(homeRoot, { verifyFiles });
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
  if (verifyFiles) {
    try { verifyProductPayload(candidateRoot); }
    catch {
      result.reasons.push(reason('candidate_integrity_failed', 'The candidate package failed its integrity checks.'));
      return result;
    }
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
