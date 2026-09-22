/** Prepare a local candidate without changing or starting the current home. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { privateDirectory, privateJSON, readPrivateJSON } from './product-environment.js';
import { inspectProductInstallation, previewProductUpdate, previewRoot } from './product-update-preview.js';
import { acquireInstallLock, inventoryProductPayload, verifyProductPayload as verifyProductPayloadDefault } from './product-payload.js';

const SCHEMA = 'home23.product-stage.v1';
const inside = (root, target) => target === root || target.startsWith(root + sep);
function present(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function stageResult(staging, receipt, replayed) {
  return { ok: true, status: 'staged', staging, payloadPath: join(staging, 'payload'), receipt, replayed,
    canInstall: false, publisherTrust: 'unverified', stateMigrationCompatibility: 'unverified' };
}

/** Check all existing package entries before any resumed write. */
function inspectPartial(payload, manifest) {
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]));
  for (const entry of inventoryProductPayload(payload)) {
    if (!equal(entry, expected.get(entry.path))) throw new Error('Staged package content changed or contains an unknown file.');
  }
  const file = join(payload, 'manifest.json');
  if (present(file)) {
    if (!fs.lstatSync(file).isFile()) throw new Error('Unsafe staged manifest.');
    let saved; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid staged manifest.'); }
    if (!equal(saved, manifest)) throw new Error('Staged manifest belongs to another candidate.');
  }
}

export function stageProductPayload({ homeRoot, candidatePayload, staging, verifyProductPayload = verifyProductPayloadDefault }) {
  const home = previewRoot(homeRoot), candidate = previewRoot(candidatePayload), destination = previewRoot(staging);
  const roots = [home, candidate, destination];
  if (roots.some((root, i) => roots.some((other, j) => i !== j && inside(root, other)))) {
    throw new Error('Home, candidate, and staging directories must be separate.');
  }
  const preview = previewProductUpdate({ homeRoot: home, candidatePayload: candidate });
  if (preview.reasons.length !== 1 || !['same_package', 'different_package'].includes(preview.reasons[0].code)) {
    throw new Error('The home or candidate is not eligible for local staging.');
  }
  const manifest = verifyProductPayload(candidate);
  if (manifest.packageId !== preview.candidate.identity.packageId) throw new Error('Candidate changed during staging inspection.');
  const binding = { schema: SCHEMA, homeRoot: home, staging: destination,
    currentPackageId: preview.current.identity.packageId, candidatePackageId: manifest.packageId,
    candidateSourceCommit: manifest.sourceCommit };
  const claimPath = `${destination}.home23-stage.json`, lockPath = `${destination}.home23-stage.lock`;
  for (const file of [claimPath, lockPath]) {
    if ([home, candidate].some(root => inside(root, file) || inside(file, root))) throw new Error('Stage ownership paths overlap an input.');
  }
  fs.mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const unlock = acquireInstallLock(lockPath);
  try {
    let receipt;
    if (present(claimPath)) {
      try { receipt = readPrivateJSON(claimPath); }
      catch { throw new Error('Staging claim is unreadable or invalid.'); }
      if (!receipt || !Object.entries(binding).every(([key, value]) => receipt[key] === value) ||
          !/^[a-f0-9-]{36}$/.test(receipt.id || '') || !['copying', 'staged'].includes(receipt.status)) {
        throw new Error('Staging claim belongs to another home, baseline, or candidate.');
      }
    } else {
      if (present(destination)) throw new Error('Existing staging destination has no Home23 stage claim.');
      receipt = { ...binding, id: randomUUID(), status: 'copying' };
      privateJSON(claimPath, receipt);
    }
    const payload = join(destination, 'payload'), temporary = join(destination, 'copy.tmp');
    if (receipt.status === 'staged') {
      privateDirectory(destination);
      if (fs.readdirSync(destination).some(name => name !== 'payload')) throw new Error('Unexpected staging contents.');
      if (verifyProductPayload(payload).packageId !== manifest.packageId) throw new Error('Staged package identity changed.');
      return stageResult(destination, receipt, true);
    }
    privateDirectory(destination);
    if (fs.readdirSync(destination).some(name => !['payload', 'copy.tmp'].includes(name))) throw new Error('Unexpected staging contents.');
    previewRoot(payload);
    if (!present(payload)) fs.mkdirSync(payload, { mode: 0o755 });
    inspectPartial(payload, manifest);
    // Only this owned regular file may contain incomplete bytes from a failed copy.
    if (present(temporary)) {
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe interrupted copy.');
      fs.unlinkSync(temporary);
    }
    const remaining = manifest.files.filter(entry => entry.type === 'file' && !present(join(payload, entry.path)))
      .reduce((bytes, entry) => bytes + BigInt(entry.size), 0n);
    const space = fs.statfsSync(destination, { bigint: true });
    // This is a capacity preflight, not a reservation against other disk users.
    if (space.bavail * space.bsize < remaining + 64n * 1024n * 1024n) {
      throw new Error('Insufficient free space to stage the candidate with 64 MiB of headroom.');
    }
    const directories = manifest.files.filter(entry => entry.type === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const entry of directories) {
      const target = join(payload, entry.path); previewRoot(target);
      if (!present(target)) fs.mkdirSync(target, { mode: entry.mode });
    }
    for (const entry of manifest.files.filter(entry => entry.type === 'file')) {
      const target = join(payload, entry.path);
      previewRoot(dirname(target));
      if (present(target)) continue; // inspectPartial already verified these bytes.
      fs.copyFileSync(join(candidate, entry.path), temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, entry.mode); fs.renameSync(temporary, target);
    }
    // Create links only after their targets, so interruption never strands a
    // legitimate dangling link that the next integrity inspection would reject.
    let pending = manifest.files.filter(entry => entry.type === 'symlink' && !present(join(payload, entry.path)));
    while (pending.length) {
      const next = [];
      for (const entry of pending) {
        if (!fs.existsSync(join(payload, dirname(entry.path), entry.target))) { next.push(entry); continue; }
        previewRoot(dirname(join(payload, entry.path)));
        fs.symlinkSync(entry.target, join(payload, entry.path));
      }
      if (next.length === pending.length) throw new Error('Staged symlink targets cannot be resolved.');
      pending = next;
    }
    // Retain the verified in-memory manifest rather than rereading mutable source metadata.
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, join(payload, 'manifest.json'));
    verifyProductPayload(payload, { fresh: true });
    const current = inspectProductInstallation(home);
    if (current.reasons.length || current.identity?.packageId !== binding.currentPackageId) throw new Error('Home baseline changed during staging.');
    receipt = { ...receipt, status: 'staged' }; privateJSON(claimPath, receipt);
    return stageResult(destination, receipt, false);
  } finally { unlock(); }
}

/**
 * Reuse an already-staged payload in place. Caller must hold the stage lock so a
 * download/retry cannot mutate the tree while apply or resume owns it.
 * Revalidates the claim binding and payload bytes; never copies.
 */
export function adoptVerifiedStage({ homeRoot, staging, verifyProductPayload = verifyProductPayloadDefault }) {
  const home = previewRoot(homeRoot), destination = previewRoot(staging);
  if (inside(home, destination) || inside(destination, home)) {
    throw new Error('Home and staging directories must be separate.');
  }
  const payload = join(destination, 'payload');
  const claimPath = `${destination}.home23-stage.json`;
  if (!present(claimPath)) throw new Error('Staging claim is missing; cannot reuse an unclaimed stage.');
  let receipt;
  try { receipt = readPrivateJSON(claimPath); }
  catch { throw new Error('Staging claim is unreadable or invalid.'); }
  if (!receipt || receipt.schema !== SCHEMA || !/^[a-f0-9-]{36}$/.test(receipt.id || '') ||
      !['copying', 'staged'].includes(receipt.status)) {
    throw new Error('Staging claim belongs to another home, baseline, or candidate.');
  }
  if (receipt.status !== 'staged') {
    throw new Error('Staging claim belongs to another home, baseline, or candidate.');
  }
  privateDirectory(destination);
  if (fs.readdirSync(destination).some(name => name !== 'payload')) throw new Error('Unexpected staging contents.');
  // Revalidate staged bytes before trust or baseline checks so tampering fails closed.
  const manifest = verifyProductPayload(payload);
  const preview = previewProductUpdate({ homeRoot: home, candidatePayload: payload });
  if (preview.reasons.length !== 1 || !['same_package', 'different_package'].includes(preview.reasons[0].code)) {
    throw new Error('The home or candidate is not eligible for local staging.');
  }
  if (manifest.packageId !== preview.candidate.identity.packageId) throw new Error('Candidate changed during staging inspection.');
  const binding = { schema: SCHEMA, homeRoot: home, staging: destination,
    currentPackageId: preview.current.identity.packageId, candidatePackageId: manifest.packageId,
    candidateSourceCommit: manifest.sourceCommit };
  if (!Object.entries(binding).every(([key, value]) => receipt[key] === value)) {
    throw new Error('Staging claim belongs to another home, baseline, or candidate.');
  }
  if (verifyProductPayload(payload).packageId !== manifest.packageId) throw new Error('Staged package identity changed.');
  const current = inspectProductInstallation(home);
  if (current.reasons.length || current.identity?.packageId !== binding.currentPackageId) throw new Error('Home baseline changed during staging.');
  return stageResult(destination, receipt, true);
}

export function stageLockPath(staging) {
  return `${previewRoot(staging)}.home23-stage.lock`;
}
