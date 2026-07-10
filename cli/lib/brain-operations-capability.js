import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import home23Secrets from '../../shared/home23-secrets.cjs';

const CAPABILITY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_HEADER = '# Home23 secrets — API keys and tokens\n# This file is gitignored. Never commit it.\n\n';
const {
  updateHome23Secrets: updateSharedHome23Secrets,
  withHome23SecretsLock,
} = home23Secrets;

function typedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function preparationError(error) {
  if (error?.code === 'capability_secret_invalid'
      || error?.code === 'preparation_state_changed'
      || error?.code === 'capability_preparation_failed'
      || error?.code === 'capability_secret_mutation_forbidden') {
    return error;
  }
  return typedError('capability_preparation_failed', error);
}

export function modeString(mode) {
  return Number(mode).toString(8).padStart(4, '0');
}

function snapshotIdentity(stat) {
  if (!stat) return null;
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function identityEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export function snapshotsEqual(left, right) {
  return left.exists === right.exists
    && identityEqual(left.identity, right.identity)
    && ((!left.exists && !right.exists) || left.bytes.equals(right.bytes));
}

export async function readStableFileSnapshot(filePath) {
  let before;
  try {
    before = await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, identity: null, bytes: null };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw typedError('capability_secret_invalid');
  let bytes;
  try {
    bytes = await fs.promises.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw typedError('preparation_state_changed', error);
    throw error;
  }
  let after;
  try {
    after = await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw typedError('preparation_state_changed', error);
    throw error;
  }
  const beforeIdentity = snapshotIdentity(before);
  const afterIdentity = snapshotIdentity(after);
  if (!identityEqual(beforeIdentity, afterIdentity)) throw typedError('preparation_state_changed');
  return { exists: true, identity: afterIdentity, bytes };
}

function parseSecretsSnapshot(snapshot) {
  if (!snapshot.exists) return {};
  let parsed;
  try {
    parsed = yaml.load(snapshot.bytes.toString('utf8'));
  } catch (error) {
    throw typedError('capability_secret_invalid', error);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw typedError('capability_secret_invalid');
  }
  return parsed;
}

function inspectParsedSecrets(snapshot) {
  const secrets = parseSecretsSnapshot(snapshot);
  const brainOperations = secrets.brainOperations;
  if (brainOperations !== undefined
      && (!brainOperations || Array.isArray(brainOperations) || typeof brainOperations !== 'object')) {
    throw typedError('capability_secret_invalid');
  }
  const existingKey = brainOperations?.capabilityKey;
  if (existingKey !== undefined
      && (typeof existingKey !== 'string' || !CAPABILITY_KEY_PATTERN.test(existingKey))) {
    throw typedError('capability_secret_invalid');
  }
  const mode = snapshot.exists ? Number(snapshot.identity.mode & 0o777n) : null;
  return { secrets, existingKey: existingKey || null, mode };
}

export async function inspectBrainOperationsCapabilityState(home23Root) {
  const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
  let snapshot;
  try {
    snapshot = await readStableFileSnapshot(secretsPath);
    const { existingKey, mode } = inspectParsedSecrets(snapshot);
    return {
      capabilityKey: existingKey,
      keyWouldBeCreated: !existingKey,
      permissionsWouldBeRepaired: snapshot.exists && mode !== 0o600,
      secretsModeBefore: snapshot.exists ? modeString(mode) : null,
      secretsModeAfter: snapshot.exists ? modeString(mode) : null,
      snapshot,
    };
  } catch (error) {
    throw preparationError(error);
  }
}

async function syncDirectory(directoryPath) {
  const directory = await fs.promises.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeYamlAtomic(filePath, value, baseline, options) {
  const directoryPath = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(SECRET_HEADER + yaml.dump(value, { lineWidth: 120 }), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await options.beforeRename?.();
    const current = await readStableFileSnapshot(filePath);
    if (!snapshotsEqual(baseline, current)) {
      return { stateChanged: true };
    }
    await fs.promises.rename(temporary, filePath);
    await fs.promises.chmod(filePath, 0o600);
    await syncDirectory(directoryPath);
    return { stateChanged: false };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function repairPermissions(filePath, baseline, options) {
  await options.beforePermissionRepair?.();
  const current = await readStableFileSnapshot(filePath);
  if (!snapshotsEqual(baseline, current)) return { stateChanged: true };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!identityEqual(snapshotIdentity(opened), baseline.identity)) {
      return { stateChanged: true };
    }
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
  const repaired = await readStableFileSnapshot(filePath);
  if (repaired.identity.ino !== baseline.identity.ino
      || Number(repaired.identity.mode & 0o777n) !== 0o600) {
    return { stateChanged: true };
  }
  return { stateChanged: false };
}

// This lock is the explicit coordination boundary for Home23 secret writers.
// Snapshot comparisons detect observed drift, but cannot make non-participating
// writers atomic across the final portable check/rename syscall window.
export async function withBrainOperationsCapabilityLock(home23Root, callback, options = {}) {
  try {
    return await withHome23SecretsLock(home23Root, callback, options);
  } catch (error) {
    throw preparationError(error);
  }
}

async function ensureBrainOperationsCapabilityKeyLocked(home23Root, options = {}) {
  const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await readStableFileSnapshot(secretsPath);
    const { secrets, existingKey, mode } = inspectParsedSecrets(snapshot);
    if (existingKey) {
      const modeBefore = modeString(mode);
      if (mode === 0o600) {
        return {
          capabilityKey: existingKey,
          keyCreated: false,
          permissionsRepaired: false,
          secretsModeBefore: modeBefore,
          secretsModeAfter: modeBefore,
        };
      }
      const repaired = await repairPermissions(secretsPath, snapshot, options);
      if (repaired.stateChanged) continue;
      return {
        capabilityKey: existingKey,
        keyCreated: false,
        permissionsRepaired: true,
        secretsModeBefore: modeBefore,
        secretsModeAfter: '0600',
      };
    }

    const capabilityKey = randomBytes(32).toString('hex');
    secrets.brainOperations = { ...(secrets.brainOperations || {}), capabilityKey };
    const written = await writeYamlAtomic(secretsPath, secrets, snapshot, options);
    if (written.stateChanged) continue;
    return {
      capabilityKey,
      keyCreated: true,
      permissionsRepaired: false,
      secretsModeBefore: snapshot.exists ? modeString(mode) : null,
      secretsModeAfter: '0600',
    };
  }
  throw typedError('preparation_state_changed');
}

export async function ensureBrainOperationsCapabilityKey(home23Root, options = {}) {
  return withBrainOperationsCapabilityLock(
    home23Root,
    () => ensureBrainOperationsCapabilityKeyLocked(home23Root, options),
    options,
  );
}

export async function updateHome23Secrets(home23Root, mutator, options = {}) {
  try {
    return await updateSharedHome23Secrets(home23Root, mutator, options);
  } catch (error) {
    if (error?.code === 'home23_secrets_invalid') {
      throw typedError('capability_secret_invalid', error);
    }
    if (error?.code === 'home23_secrets_state_changed') {
      throw typedError('preparation_state_changed', error);
    }
    throw preparationError(error);
  }
}
