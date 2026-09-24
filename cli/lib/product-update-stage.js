/** Prepare a local candidate without changing or starting the current home. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { privateDirectory, privateJSON, readPrivateJSON } from './product-environment.js';
import { inspectProductInstallation, previewProductUpdate, previewRoot } from './product-update-preview.js';
import { acquireInstallLock, inventoryProductPayload, readProductManifest, verifyProductPayload as verifyProductPayloadDefault } from './product-payload.js';

const SCHEMA = 'home23.product-stage.v1';
const BULK_COPY_MIN_ENTRIES = 512;
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

function tryBulkCopy({ candidate, destination, payload, temporary, probe }) {
  if (process.platform !== 'darwin') return false;
  const sameVolume = fs.statSync(candidate).dev === fs.statSync(destination).dev;
  if (sameVolume) {
    // Node's FICLONE flag falls back on some macOS volumes; /bin/cp -c uses
    // clonefile directly. Probe the volume before taking the bulk path.
    try { execFileSync('/bin/cp', ['-c', join(candidate, 'bin/node'), probe], { stdio: 'ignore', timeout: 30000 }); }
    catch { if (present(probe)) fs.unlinkSync(probe); return false; }
    fs.unlinkSync(probe);
  }
  fs.rmdirSync(payload); // Only an empty, newly owned payload can take this path.
  if (sameVolume) execFileSync('/bin/cp', ['-Rc', candidate, temporary], { timeout: 180000 });
  else {
    // ditto traverses and copies the tree in one process across volumes. Its
    // destination remains private until the complete copy is renamed and
    // verified against the manifest. The manifest does not include metadata
    // forks, attributes, quarantine, or ACLs, so do not carry them forward.
    execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', '--noacl', '--noqtn', '--nopersistRootless', '--noclone',
      candidate, temporary], { timeout: 600000 });
  }
  fs.renameSync(temporary, payload);
  return true;
}

export function stageProductPayload({ homeRoot, candidatePayload, staging, verifyProductPayload = verifyProductPayloadDefault }) {
  const home = previewRoot(homeRoot), candidate = previewRoot(candidatePayload), destination = previewRoot(staging);
  const roots = [home, candidate, destination];
  if (roots.some((root, i) => roots.some((other, j) => i !== j && inside(root, other)))) {
    throw new Error('Home, candidate, and staging directories must be separate.');
  }
  // Stage cannot change the current home. Hash the finished stage once; Install
  // checks the current home immediately before selection and the selected tree
  // before writers start.
  const preview = previewProductUpdate({ homeRoot: home, candidatePayload: candidate }, { verifyFiles: false });
  if (preview.reasons.length !== 1 || !['same_package', 'different_package'].includes(preview.reasons[0].code)) {
    throw new Error('The home or candidate is not eligible for local staging.');
  }
  // Preview checked structure and compatibility. Re-read candidate identity;
  // the completed stage is checked byte-for-byte before its claim commits.
  const manifest = readProductManifest(candidate);
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
    // Keep the existing temporary names so interrupted stages from an older
    // version are recognized and cleaned before either bulk copy strategy.
    const cloneTemporary = join(destination, 'payload.clone.tmp'), cloneProbe = join(destination, 'clone-probe.tmp');
    const finish = () => {
      verifyProductPayload(payload, { fresh: true });
      const current = inspectProductInstallation(home, { verifyFiles: false });
      if (current.reasons.length || current.identity?.packageId !== binding.currentPackageId) throw new Error('Home baseline changed during staging.');
      receipt = { ...receipt, status: 'staged' }; privateJSON(claimPath, receipt);
      return stageResult(destination, receipt, false);
    };
    if (receipt.status === 'staged') {
      privateDirectory(destination);
      if (fs.readdirSync(destination).some(name => name !== 'payload')) throw new Error('Unexpected staging contents.');
      if (verifyProductPayload(payload).packageId !== manifest.packageId) throw new Error('Staged package identity changed.');
      return stageResult(destination, receipt, true);
    }
    privateDirectory(destination);
    if (fs.readdirSync(destination).some(name => !['payload', 'copy.tmp', 'payload.clone.tmp', 'clone-probe.tmp'].includes(name))) throw new Error('Unexpected staging contents.');
    const interruptedBulkCopy = present(cloneTemporary);
    if (interruptedBulkCopy) {
      if (!fs.lstatSync(cloneTemporary).isDirectory()) throw new Error('Unsafe interrupted bulk copy.');
      fs.rmSync(cloneTemporary, { recursive: true });
    }
    if (present(cloneProbe)) {
      if (!fs.lstatSync(cloneProbe).isFile()) throw new Error('Unsafe interrupted clone probe.');
      fs.unlinkSync(cloneProbe);
    }
    previewRoot(payload);
    const hadPayload = present(payload);
    if (!hadPayload) fs.mkdirSync(payload, { mode: 0o755 });
    inspectPartial(payload, manifest);
    const emptyPayload = fs.readdirSync(payload).length === 0;
    // Only this owned regular file may contain incomplete bytes from a failed copy.
    if (present(temporary)) {
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe interrupted copy.');
      fs.unlinkSync(temporary);
    }
    const remaining = manifest.files.filter(entry => entry.type === 'file' && (emptyPayload || !present(join(payload, entry.path))))
      .reduce((bytes, entry) => bytes + BigInt(entry.size), 0n);
    const space = fs.statfsSync(destination, { bigint: true });
    // This is a capacity preflight, not a reservation against other disk users.
    if (space.bavail * space.bsize < remaining + 64n * 1024n * 1024n) {
      throw new Error('Insufficient free space to stage the candidate with 64 MiB of headroom.');
    }
    if (emptyPayload && !interruptedBulkCopy && manifest.files.length >= BULK_COPY_MIN_ENTRIES &&
        tryBulkCopy({ candidate, destination, payload, temporary: cloneTemporary, probe: cloneProbe })) {
      return finish();
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
      // Request a clone where Node supports it; its fallback remains a copy.
      fs.copyFileSync(join(candidate, entry.path), temporary,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
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
    return finish();
  } finally { unlock(); }
}

/**
 * Reuse an already-staged payload in place. Caller must hold the stage lock so a
 * download/retry cannot mutate the tree while apply or resume owns it.
 * Revalidates the claim binding; the default also rechecks payload bytes.
 * Install can defer that byte check until selection, before writer admission.
 */
export function adoptVerifiedStage({ homeRoot, staging, verifyProductPayload = verifyProductPayloadDefault, trustStagedReceipt = false }) {
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
  // Install may rely on a completed stage while holding its exclusive lock.
  // The selected home is checked byte-for-byte before any writer is admitted;
  // if the stage changed outside that lock, selection rolls back under the fence.
  const manifest = trustStagedReceipt ? readProductManifest(payload) : verifyProductPayload(payload);
  const preview = previewProductUpdate({ homeRoot: home, candidatePayload: payload }, { verifyFiles: !trustStagedReceipt });
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
  if (!trustStagedReceipt && verifyProductPayload(payload).packageId !== manifest.packageId) throw new Error('Staged package identity changed.');
  const current = inspectProductInstallation(home, { verifyFiles: !trustStagedReceipt });
  if (current.reasons.length || current.identity?.packageId !== binding.currentPackageId) throw new Error('Home baseline changed during staging.');
  return stageResult(destination, receipt, true);
}

export function stageLockPath(staging) {
  return `${previewRoot(staging)}.home23-stage.lock`;
}
