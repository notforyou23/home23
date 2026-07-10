'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const lockfile = require('proper-lockfile');

const CAPABILITY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_NAME = '.brain-operations-capability.lock';
const SECRET_HEADER = '# Home23 secrets — API keys and tokens\n# This file is gitignored. Never commit it.\n\n';
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 180_000;

function secretsError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function lockCoordinates(home23Root) {
  const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
  const configDir = path.dirname(secretsPath);
  return {
    secretsPath,
    configDir,
    lockPath: path.join(configDir, LOCK_NAME),
  };
}

function lockOptions(lockPath, retries = 0) {
  return {
    realpath: false,
    lockfilePath: lockPath,
    stale: LOCK_STALE_MS,
    update: 30_000,
    retries,
  };
}

async function withHome23SecretsLock(home23Root, callback, options = {}) {
  if (typeof callback !== 'function') throw secretsError('home23_secrets_callback_invalid');
  const coordinates = lockCoordinates(home23Root);
  const timeoutMs = Number.isFinite(options.lockTimeoutMs)
    ? Math.max(0, options.lockTimeoutMs)
    : DEFAULT_LOCK_TIMEOUT_MS;
  let release;
  try {
    await fs.promises.mkdir(coordinates.configDir, { recursive: true });
    release = await lockfile.lock(coordinates.configDir, lockOptions(coordinates.lockPath, {
      retries: Math.ceil(timeoutMs / 100),
      minTimeout: 20,
      maxTimeout: 100,
      factor: 1.15,
    }));
    return await callback(coordinates);
  } finally {
    if (release) await release();
  }
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

function snapshotsEqual(left, right) {
  return left.exists === right.exists
    && identityEqual(left.identity, right.identity)
    && ((!left.exists && !right.exists) || left.bytes.equals(right.bytes));
}

async function readStableFileSnapshot(filePath) {
  let before;
  try {
    before = await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, identity: null, bytes: null };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw secretsError('home23_secrets_invalid');

  let bytes;
  try {
    bytes = await fs.promises.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw secretsError('home23_secrets_state_changed', error);
    throw error;
  }

  let after;
  try {
    after = await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') throw secretsError('home23_secrets_state_changed', error);
    throw error;
  }
  if (!identityEqual(snapshotIdentity(before), snapshotIdentity(after))) {
    throw secretsError('home23_secrets_state_changed');
  }
  return { exists: true, identity: snapshotIdentity(after), bytes };
}

function parseSecretsSnapshot(snapshot) {
  if (!snapshot.exists) return {};
  let secrets;
  try {
    secrets = yaml.load(snapshot.bytes.toString('utf8'));
  } catch (error) {
    throw secretsError('home23_secrets_invalid', error);
  }
  if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') {
    throw secretsError('home23_secrets_invalid');
  }
  const brainOperations = secrets.brainOperations;
  if (brainOperations !== undefined
      && (!brainOperations || Array.isArray(brainOperations) || typeof brainOperations !== 'object')) {
    throw secretsError('home23_secrets_invalid');
  }
  const capabilityKey = brainOperations?.capabilityKey;
  if (capabilityKey !== undefined
      && (typeof capabilityKey !== 'string' || !CAPABILITY_KEY_PATTERN.test(capabilityKey))) {
    throw secretsError('home23_secrets_invalid');
  }
  return secrets;
}

function fingerprintBrainOperations(secrets) {
  try {
    return JSON.stringify(secrets.brainOperations);
  } catch (error) {
    throw secretsError('home23_secrets_invalid', error);
  }
}

async function syncDirectory(directoryPath) {
  const descriptor = await fs.promises.open(directoryPath, 'r');
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function writeSecretsAtomic(filePath, value, baseline, options = {}) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(SECRET_HEADER + yaml.dump(value, { lineWidth: 120 }), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    await options.beforeRename?.();
    const current = await readStableFileSnapshot(filePath);
    if (!snapshotsEqual(baseline, current)) throw secretsError('home23_secrets_state_changed');

    await fs.promises.rename(temporary, filePath);
    await fs.promises.chmod(filePath, 0o600);
    await syncDirectory(path.dirname(filePath));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function updateHome23Secrets(home23Root, mutator, options = {}) {
  if (typeof mutator !== 'function') throw secretsError('home23_secrets_callback_invalid');
  return withHome23SecretsLock(home23Root, async ({ secretsPath }) => {
    const snapshot = await readStableFileSnapshot(secretsPath);
    const secrets = parseSecretsSnapshot(snapshot);
    const brainOperationsBefore = fingerprintBrainOperations(secrets);
    const outcome = await mutator(secrets) || {};
    if (fingerprintBrainOperations(secrets) !== brainOperationsBefore) {
      throw secretsError('capability_secret_mutation_forbidden');
    }
    if (outcome.changed !== true) return { changed: false, value: outcome.value };
    await writeSecretsAtomic(secretsPath, secrets, snapshot, options);
    return { changed: true, value: outcome.value };
  }, options);
}

module.exports = {
  LOCK_NAME,
  SECRET_HEADER,
  readStableFileSnapshot,
  updateHome23Secrets,
  withHome23SecretsLock,
};
