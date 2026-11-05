import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const AUTHORITY = new Set(['live', 'isolated-controlled']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_AUTHORITY_MAX_BYTES = 64 * 1024;
const JSONL_RECEIPT_MAX_BYTES = 32 * 1024 * 1024;
const RECEIPT_CONTEXT_BINDINGS = new WeakMap();
const RECEIPT_CONTEXT_FIELDS = Object.freeze([
  'receiptRunDir', 'receiptRunId', 'authority', 'implementationCommit', 'hostname', 'startedAt',
]);

export function typedError(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

export function parseCli(argv = process.argv.slice(2)) {
  const values = Object.create(null);
  const positionals = [];
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      command = argv.slice(index + 1);
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const key = token.slice(2, equals >= 0 ? equals : undefined);
    if (!key) throw typedError('invalid_arguments');
    let value;
    if (equals >= 0) value = token.slice(equals + 1);
    else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    } else value = true;
    if (Object.hasOwn(values, key)) {
      values[key] = Array.isArray(values[key]) ? [...values[key], value] : [values[key], value];
    } else values[key] = value;
  }
  return { values, positionals, command };
}

export function one(values, key, { required = false, defaultValue = undefined } = {}) {
  const value = values[key];
  if (Array.isArray(value)) throw typedError('duplicate_argument', `duplicate --${key}`);
  if (value === undefined || value === false || value === '') {
    if (required) throw typedError('missing_argument', `--${key} is required`);
    return defaultValue;
  }
  return value;
}

export function repeated(values, key) {
  const value = values[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function booleanFlag(values, key, defaultValue = false) {
  const value = values[key];
  if (value === undefined) return defaultValue;
  if (Array.isArray(value)) throw typedError('duplicate_argument', `duplicate --${key}`);
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw typedError('invalid_argument', `--${key} must be boolean`);
}

export function integer(values, key, {
  required = false,
  defaultValue = undefined,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
} = {}) {
  const raw = one(values, key, { required, defaultValue });
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw typedError('invalid_argument', `--${key} must be an integer in range`);
  }
  return value;
}

export function numberValue(values, key, {
  required = false,
  defaultValue = undefined,
  min = -Infinity,
  max = Infinity,
  exclusiveMin = false,
} = {}) {
  const raw = one(values, key, { required, defaultValue });
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (exclusiveMin ? value <= min : value < min) || value > max) {
    throw typedError('invalid_argument', `--${key} must be a finite number in range`);
  }
  return value;
}

export function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function directorySecurityMatches(stat, requiredMode, requiredUid) {
  return (requiredMode === undefined || Number(stat.mode & 0o777n) === requiredMode)
    && (requiredUid === undefined || requiredUid === null
      || stat.uid === BigInt(requiredUid));
}

export async function canonicalDirectory(input, label, {
  create = false,
  requiredMode = undefined,
  requiredUid = undefined,
} = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.normalize(input) !== input) {
    throw typedError('path_invalid', `${label} must be a normalized absolute path`);
  }
  if ((requiredMode !== undefined
      && (!Number.isSafeInteger(requiredMode) || requiredMode < 0 || requiredMode > 0o777))
      || (requiredUid !== undefined && requiredUid !== null
        && (!Number.isSafeInteger(requiredUid) || requiredUid < 0))) {
    throw typedError('path_invalid', `${label} security requirements are invalid`);
  }
  if (create) await fsp.mkdir(input, { recursive: true, mode: 0o700 });
  const before = await fsp.lstat(input, { bigint: true }).catch((error) => {
    throw typedError('path_unavailable', `${label} is unavailable`, { cause: error });
  });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw typedError('path_invalid', `${label} must be a nonsymlink directory`);
  }
  if (!directorySecurityMatches(before, requiredMode, requiredUid)) {
    throw typedError('path_permissions_invalid', `${label} permissions or owner are invalid`);
  }
  const canonical = await fsp.realpath(input);
  if (canonical !== input) throw typedError('path_invalid', `${label} must already be canonical`);
  const after = await fsp.lstat(input, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory()
      || !directorySecurityMatches(after, requiredMode, requiredUid)) {
    throw typedError('path_changed', `${label} changed during validation`);
  }
  return Object.freeze({
    path: canonical,
    dev: before.dev.toString(),
    ino: before.ino.toString(),
    ...(requiredMode === undefined ? {} : { mode: requiredMode }),
    ...(requiredUid === undefined || requiredUid === null
      ? {}
      : { uid: String(requiredUid) }),
  });
}

export async function assertCanonicalDirectoryIdentity(directory, label) {
  if (!directory || typeof directory.path !== 'string'
      || typeof directory.dev !== 'string' || typeof directory.ino !== 'string') {
    throw typedError('path_changed', `${label} identity is invalid`);
  }
  try {
    const before = await fsp.lstat(directory.path, { bigint: true });
    const canonical = await fsp.realpath(directory.path);
    const after = await fsp.lstat(directory.path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
        || !after.isDirectory() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino
        || before.dev.toString() !== directory.dev
        || before.ino.toString() !== directory.ino
        || (directory.mode !== undefined
          && Number(before.mode & 0o777n) !== directory.mode)
        || (directory.uid !== undefined && before.uid.toString() !== directory.uid)
        || (directory.mode !== undefined
          && Number(after.mode & 0o777n) !== directory.mode)
        || (directory.uid !== undefined && after.uid.toString() !== directory.uid)
        || canonical !== directory.path) {
      throw typedError('path_changed', `${label} identity changed`);
    }
  } catch (error) {
    if (error?.code === 'path_changed') throw error;
    throw typedError('path_changed', `${label} identity changed`, { cause: error });
  }
  return directory;
}

export async function assertReceiptContextDirectoryIdentity(context) {
  const binding = context && typeof context === 'object'
    ? RECEIPT_CONTEXT_BINDINGS.get(context)
    : null;
  if (!binding || !Object.isFrozen(context)
      || RECEIPT_CONTEXT_FIELDS.some((field) => context[field] !== binding.fields[field])) {
    throw typedError('receipt_context_invalid');
  }
  await assertCanonicalDirectoryIdentity(binding.directory, 'receipt run directory');
  let current;
  try {
    current = await readRunAuthority(binding.directory.path, binding.fields.receiptRunId);
  } catch (error) {
    throw typedError('receipt_run_authority_changed', 'run-authority.json changed', {
      cause: error,
    });
  }
  if (!sameFileIdentity(current.fileIdentity, binding.authority.fileIdentity)
      || current.sha256 !== binding.authority.sha256
      || !current.bytes.equals(binding.authority.bytes)) {
    throw typedError('receipt_run_authority_changed', 'run-authority.json changed');
  }
  return context;
}

function matchingAuthorityValue(cliValue, envValue, label) {
  if (Array.isArray(cliValue)) throw typedError('duplicate_argument', `duplicate --${label}`);
  if (cliValue !== undefined && envValue !== undefined && String(cliValue) !== String(envValue)) {
    throw typedError('receipt_authority_conflict', `${label} conflicts with environment`);
  }
  return cliValue !== undefined ? String(cliValue) : envValue;
}

function strictIsoTimestamp(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    nlink: stat.nlink.toString(),
    mode: Number(stat.mode & 0o777n),
    uid: stat.uid.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameFileIdentity(left, right) {
  return left && right && Object.keys(left).every((key) => left[key] === right[key]);
}

async function readRunAuthority(runDirectory, runId) {
  const authorityPath = path.join(runDirectory, 'run-authority.json');
  let before;
  let after;
  let bytes;
  let document;
  try {
    before = await fsp.lstat(authorityPath, { bigint: true });
    bytes = await readBoundedFile(authorityPath, {
      maxBytes: RUN_AUTHORITY_MAX_BYTES,
      errorCode: 'receipt_run_authority_invalid',
      requireSingleLink: true,
      requiredMode: 0o600,
      requiredUid: typeof process.getuid === 'function' ? process.getuid() : null,
    });
    after = await fsp.lstat(authorityPath, { bigint: true });
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(after))) {
      throw typedError('receipt_run_authority_invalid');
    }
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'receipt_run_authority_invalid') throw error;
    throw typedError('receipt_run_authority_invalid', 'run-authority.json is invalid', {
      cause: error,
    });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)
      || document.schemaVersion !== 1
      || document.receiptRunId !== runId
      || document.authority !== 'live'
      || !GIT_OID.test(document.implementationCommit)
      || !GIT_OID.test(document.expectedLiveTree)
      || !GIT_OID.test(document.actualLiveTree)
      || document.expectedLiveTree !== document.actualLiveTree
      || typeof document.hostname !== 'string' || !document.hostname.trim()
      || Buffer.byteLength(document.hostname, 'utf8') > 255
      || !strictIsoTimestamp(document.startedAt)) {
    throw typedError('receipt_run_authority_invalid', 'run-authority.json identity is invalid');
  }
  return Object.freeze({
    document: Object.freeze({ ...document }),
    bytes: Buffer.from(bytes),
    sha256: sha256Bytes(bytes),
    fileIdentity: fileIdentity(after),
  });
}

function declaredImplementationCommit(values, env, options) {
  const home23Value = env.HOME23_RECEIPT_IMPLEMENTATION_COMMIT;
  const deploymentValue = env.IMPLEMENTATION_PUSH_COMMIT;
  if (home23Value !== undefined && deploymentValue !== undefined
      && String(home23Value) !== String(deploymentValue)) {
    throw typedError('receipt_implementation_commit_mismatch',
      'implementation commit environment values conflict');
  }
  const envValue = home23Value ?? deploymentValue;
  const cliValue = values['implementation-commit'];
  if (Array.isArray(cliValue)) {
    throw typedError('duplicate_argument', 'duplicate --implementation-commit');
  }
  if (cliValue !== undefined && envValue !== undefined
      && String(cliValue) !== String(envValue)) {
    throw typedError('receipt_implementation_commit_mismatch',
      'implementation commit conflicts with environment');
  }
  const declared = cliValue !== undefined ? String(cliValue) : envValue;
  if (declared !== undefined && !GIT_OID.test(declared)) {
    throw typedError('receipt_implementation_commit_mismatch',
      'implementation commit is invalid');
  }
  if (options.implementationCommit !== undefined) {
    const optionValue = String(options.implementationCommit);
    if (!GIT_OID.test(optionValue)
        || (declared !== undefined && optionValue !== declared)) {
      throw typedError('receipt_implementation_commit_mismatch',
        'implementation commit option conflicts with declared authority');
    }
    return optionValue;
  }
  return declared;
}

export async function receiptContext(values, env = process.env, options = {}) {
  const runDirInput = matchingAuthorityValue(
    values['receipt-run-dir'], env.HOME23_RECEIPT_RUN_DIR, 'receipt-run-dir',
  );
  const runId = matchingAuthorityValue(
    values['receipt-run-id'], env.HOME23_RECEIPT_RUN_ID, 'receipt-run-id',
  );
  const authority = matchingAuthorityValue(
    values.authority, env.HOME23_RECEIPT_AUTHORITY, 'authority',
  );
  if (!runDirInput || !runId || !authority) {
    throw typedError('receipt_authority_required', 'receipt run directory, run ID, and authority are required');
  }
  if (!RUN_ID.test(runId)) throw typedError('receipt_run_id_invalid');
  if (!AUTHORITY.has(authority)) throw typedError('receipt_authority_invalid');
  const runDirectory = await canonicalDirectory(
    path.resolve(runDirInput),
    'receipt run directory',
    {
      requiredMode: 0o700,
      requiredUid: typeof process.getuid === 'function' ? process.getuid() : null,
    },
  );
  const runAuthority = await readRunAuthority(runDirectory.path, runId);
  await assertCanonicalDirectoryIdentity(runDirectory, 'receipt run directory');
  const declaredCommit = declaredImplementationCommit(values, env, options);
  if (declaredCommit !== undefined
      && declaredCommit !== runAuthority.document.implementationCommit) {
    throw typedError('receipt_implementation_commit_mismatch',
      'implementation commit does not match run-authority.json');
  }
  if (options.startedAt !== undefined && options.startedAt !== runAuthority.document.startedAt) {
    throw typedError('receipt_authority_conflict', 'startedAt conflicts with run-authority.json');
  }
  const fields = Object.freeze({
    receiptRunDir: runDirectory.path,
    receiptRunId: runId,
    authority,
    implementationCommit: runAuthority.document.implementationCommit,
    hostname: runAuthority.document.hostname,
    startedAt: runAuthority.document.startedAt,
  });
  const context = Object.freeze({
    ...fields,
  });
  RECEIPT_CONTEXT_BINDINGS.set(context, Object.freeze({
    fields,
    directory: runDirectory,
    authority: runAuthority,
  }));
  return context;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalReceiptRow(context, payload, completedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !strictIsoTimestamp(context?.startedAt)) {
    throw typedError('receipt_timestamp_invalid');
  }
  const { artifactSha256: _discardedArtifactHash, ...safePayload } = payload;
  const startedAt = Object.hasOwn(payload, 'startedAt') ? payload.startedAt : context.startedAt;
  const rowCompletedAt = Object.hasOwn(payload, 'completedAt') ? payload.completedAt : completedAt;
  delete safePayload.startedAt;
  delete safePayload.completedAt;
  delete safePayload.receiptRunStartedAt;
  if (!strictIsoTimestamp(startedAt) || !strictIsoTimestamp(rowCompletedAt)
      || Date.parse(rowCompletedAt) < Date.parse(startedAt)) {
    throw typedError('receipt_timestamp_invalid');
  }
  const core = {
    ...safePayload,
    receiptRunId: context.receiptRunId,
    authority: context.authority,
    implementationCommit: context.implementationCommit,
    hostname: context.hostname,
    receiptRunStartedAt: context.startedAt,
    startedAt,
    completedAt: rowCompletedAt,
  };
  const bytes = Buffer.from(JSON.stringify(core));
  return Object.freeze({ ...core, artifactSha256: sha256Bytes(bytes) });
}

export function assertOutputPath(context, output) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || path.normalize(output) !== output) {
    throw typedError('output_path_invalid', 'output must be a normalized absolute path');
  }
  const resolved = path.resolve(output);
  if (!isInsideOrEqual(context.receiptRunDir, resolved) || resolved === context.receiptRunDir) {
    throw typedError('output_path_invalid', 'output must be beneath the receipt run directory');
  }
  return resolved;
}

function directoryIdentity(stat, directoryPath) {
  return Object.freeze({
    path: directoryPath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: Number(stat.mode & 0o777n),
    uid: stat.uid.toString(),
  });
}

async function assertDirectoryIdentity(directory, code = 'output_path_changed') {
  try {
    const before = await fsp.lstat(directory.path, { bigint: true });
    const canonical = await fsp.realpath(directory.path);
    const after = await fsp.lstat(directory.path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
        || !after.isDirectory() || after.isSymbolicLink()
        || canonical !== directory.path
        || before.dev !== after.dev || before.ino !== after.ino
        || directory.dev !== before.dev.toString() || directory.ino !== before.ino.toString()
        || directory.mode !== 0o700 || Number(before.mode & 0o777n) !== directory.mode
        || Number(after.mode & 0o777n) !== directory.mode
        || directory.uid !== before.uid.toString() || directory.uid !== after.uid.toString()
        || (typeof process.getuid === 'function'
          && directory.uid !== String(process.getuid()))) {
      throw typedError(code);
    }
  } catch (error) {
    if (error?.code === code) throw error;
    throw typedError(code, undefined, { cause: error });
  }
  return directory;
}

async function ensureOutputParent(context, output) {
  const parent = path.dirname(output);
  const relative = path.relative(context.receiptRunDir, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw typedError('output_path_invalid');
  }
  let currentPath = context.receiptRunDir;
  let currentStat = await fsp.lstat(currentPath, { bigint: true });
  let current = directoryIdentity(currentStat, currentPath);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    await assertDirectoryIdentity(current);
    const nextPath = path.join(currentPath, component);
    try {
      await fsp.mkdir(nextPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const nextStat = await fsp.lstat(nextPath, { bigint: true }).catch((error) => {
      throw typedError('output_path_invalid', undefined, { cause: error });
    });
    if (!nextStat.isDirectory() || nextStat.isSymbolicLink()
        || await fsp.realpath(nextPath) !== nextPath
        || Number(nextStat.mode & 0o777n) !== 0o700
        || (typeof process.getuid === 'function'
          && nextStat.uid !== BigInt(process.getuid()))) {
      throw typedError('output_path_invalid', 'output ancestry must be canonical nonsymlink directories');
    }
    await assertDirectoryIdentity(current);
    currentPath = nextPath;
    current = directoryIdentity(nextStat, nextPath);
  }
  await assertDirectoryIdentity(current);
  return current;
}

const ownedJsonlOutputs = new Map();

async function publishCreateNew(temporary, target) {
  try {
    await fsp.link(temporary, target);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw typedError('receipt_output_exists', `receipt output already exists: ${target}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function receiptFileSecurityMatches(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && Number(stat.mode & 0o777n) === 0o600
    && (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()));
}

function sameInode(stat, identity) {
  return stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino;
}

async function assertNamedReceiptFile(target, identity, expectedSize = null) {
  let stat;
  try { stat = await fsp.lstat(target, { bigint: true }); }
  catch (error) { throw typedError('receipt_output_changed', undefined, { cause: error }); }
  if (!receiptFileSecurityMatches(stat) || !sameInode(stat, identity)
      || (expectedSize !== null && stat.size !== BigInt(expectedSize))
      || await fsp.realpath(target) !== target) {
    throw typedError('receipt_output_changed');
  }
  return stat;
}

async function readBackExactReceipt(target, expected, identity) {
  const actual = await readBoundedFile(target, {
    maxBytes: expected.length,
    errorCode: 'receipt_output_changed',
    requireSingleLink: true,
    requiredMode: 0o600,
    requiredUid: typeof process.getuid === 'function' ? process.getuid() : null,
  });
  await assertNamedReceiptFile(target, identity, expected.length);
  if (!Buffer.from(actual).equals(expected)) throw typedError('receipt_output_changed');
}

async function syncDirectory(directoryPath) {
  const handle = await fsp.open(directoryPath, fs.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeJsonReceipt(context, output, payload) {
  await assertReceiptContextDirectoryIdentity(context);
  const target = assertOutputPath(context, output);
  const parent = await ensureOutputParent(context, target);
  await assertReceiptContextDirectoryIdentity(context);
  const row = canonicalReceiptRow(context, payload);
  const encoded = Buffer.from(`${JSON.stringify(row, null, 2)}\n`);
  const temporary = path.join(parent.path, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  let opened;
  try {
    await handle.writeFile(encoded);
    await handle.sync();
    opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n
        || Number(opened.mode & 0o777n) !== 0o600
        || (typeof process.getuid === 'function' && opened.uid !== BigInt(process.getuid()))
        || opened.size !== BigInt(encoded.length)) {
      throw typedError('receipt_output_changed');
    }
  } finally {
    await handle.close();
  }
  const temporaryIdentity = fileIdentity(opened);
  await assertDirectoryIdentity(parent);
  await assertReceiptContextDirectoryIdentity(context);
  const namedTemporary = await fsp.lstat(temporary, { bigint: true });
  if (!sameFileIdentity(fileIdentity(namedTemporary), temporaryIdentity)) {
    throw typedError('receipt_output_changed');
  }
  await publishCreateNew(temporary, target);
  const targetStat = await fsp.lstat(target, { bigint: true });
  const targetIdentity = fileIdentity(targetStat);
  if (!receiptFileSecurityMatches(targetStat)
      || targetIdentity.dev !== temporaryIdentity.dev
      || targetIdentity.ino !== temporaryIdentity.ino
      || targetStat.size !== BigInt(encoded.length)) {
    throw typedError('receipt_output_changed');
  }
  await readBackExactReceipt(target, encoded, targetIdentity);
  await syncDirectory(parent.path);
  await assertDirectoryIdentity(parent);
  await assertReceiptContextDirectoryIdentity(context);
  return row;
}

export async function appendJsonlReceipt(context, output, payload) {
  await assertReceiptContextDirectoryIdentity(context);
  const target = assertOutputPath(context, output);
  const parent = await ensureOutputParent(context, target);
  await assertReceiptContextDirectoryIdentity(context);
  const row = canonicalReceiptRow(context, payload);
  const encoded = Buffer.from(`${JSON.stringify(row)}\n`);
  let handle;
  let stat;
  let ownershipKey;
  let owned;
  let finalIdentity;
  let expectedAfter;
  try {
    ownershipKey = `${context.receiptRunId}\0${context.authority}\0${target}`;
    owned = ownedJsonlOutputs.get(ownershipKey);
    if (owned) {
      if (!Buffer.isBuffer(owned.bytes)
          || owned.size !== owned.bytes.length
          || owned.sha256 !== sha256Bytes(owned.bytes)) {
        throw typedError('receipt_output_changed');
      }
      await readBackExactReceipt(target, owned.bytes, owned);
    }
    const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW
      | (owned ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
    try {
      handle = await fsp.open(target, flags, 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw typedError('receipt_output_exists', `receipt output already exists: ${target}`, {
          cause: error,
        });
      }
      throw error;
    }
    stat = await handle.stat({ bigint: true });
    if (!receiptFileSecurityMatches(stat)) {
      throw typedError('output_path_invalid', 'receipt output must be one regular nonsymlink file');
    }
    await assertDirectoryIdentity(parent);
    await assertNamedReceiptFile(target, fileIdentity(stat), Number(stat.size));
    if (owned && (!sameInode(stat, owned) || stat.size !== BigInt(owned.size))) {
      throw typedError('receipt_output_changed', 'receipt output identity changed');
    }
    const beforeSize = Number(stat.size);
    if (!Number.isSafeInteger(beforeSize)) throw typedError('receipt_output_changed');
    const expectedBefore = owned?.bytes ?? Buffer.alloc(0);
    if (beforeSize !== expectedBefore.length) throw typedError('receipt_output_changed');
    const beforeBytes = Buffer.allocUnsafe(beforeSize);
    let beforeOffset = 0;
    while (beforeOffset < beforeSize) {
      const { bytesRead } = await handle.read(
        beforeBytes, beforeOffset, beforeSize - beforeOffset, beforeOffset,
      );
      if (bytesRead === 0) throw typedError('receipt_output_changed');
      beforeOffset += bytesRead;
    }
    const beforeOverflow = Buffer.allocUnsafe(1);
    const { bytesRead: beforeOverflowBytes } = await handle.read(
      beforeOverflow, 0, 1, beforeSize,
    );
    const beforeReadStat = await handle.stat({ bigint: true });
    if (beforeOverflowBytes !== 0 || !sameInode(beforeReadStat, fileIdentity(stat))
        || beforeReadStat.size !== stat.size || !beforeBytes.equals(expectedBefore)) {
      throw typedError('receipt_output_changed');
    }
    expectedAfter = Buffer.concat([expectedBefore, encoded]);
    if (expectedAfter.length > JSONL_RECEIPT_MAX_BYTES) {
      throw typedError('receipt_output_too_large');
    }
    await handle.writeFile(encoded);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (!receiptFileSecurityMatches(after) || !sameInode(after, fileIdentity(stat))
        || after.size !== BigInt(beforeSize + encoded.length)) {
      throw typedError('receipt_output_changed');
    }
    finalIdentity = {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
    };
    await assertNamedReceiptFile(target, finalIdentity, expectedAfter.length);
    await readBackExactReceipt(target, expectedAfter, finalIdentity);
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      throw typedError('output_path_invalid', 'receipt output must not be a symlink', { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await readBackExactReceipt(target, expectedAfter, finalIdentity);
  await syncDirectory(parent.path);
  await assertDirectoryIdentity(parent);
  await readBackExactReceipt(target, expectedAfter, finalIdentity);
  await assertReceiptContextDirectoryIdentity(context);
  ownedJsonlOutputs.set(ownershipKey, {
    ...finalIdentity,
    size: expectedAfter.length,
    sha256: sha256Bytes(expectedAfter),
    bytes: Buffer.from(expectedAfter),
  });
  return row;
}

const DEFAULT_MAX_HASH_BYTES = 8 * 1024 * 1024 * 1024;

export function resolveHashByteCount(
  physicalSize,
  { maxBytes = DEFAULT_MAX_HASH_BYTES, prefixBytes } = {},
) {
  const physical = typeof physicalSize === 'bigint' ? physicalSize : BigInt(physicalSize);
  const size = prefixBytes === undefined ? Number(physical) : Number(prefixBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
      || !Number.isSafeInteger(size) || size < 0 || size > maxBytes
      || BigInt(size) > physical) {
    throw typedError('file_too_large', 'bounded file hash refused');
  }
  return size;
}

export async function hashFile(file, { maxBytes = DEFAULT_MAX_HASH_BYTES, prefixBytes } = {}) {
  const stat = await fsp.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw typedError('file_invalid', `not a regular file: ${file}`);
  let size;
  try { size = resolveHashByteCount(stat.size, { maxBytes, prefixBytes }); }
  catch (error) {
    if (error?.code === 'file_too_large') error.message = `bounded file hash refused: ${file}`;
    throw error;
  }
  const handle = await fsp.open(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const hash = createHash('sha256');
  let offset = 0;
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== stat.dev || opened.ino !== stat.ino
        || opened.size !== stat.size || opened.mtimeNs !== stat.mtimeNs
        || opened.ctimeNs !== stat.ctimeNs) {
      throw typedError('file_changed', `file changed before hashing: ${file}`);
    }
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw typedError('file_changed', `file shortened while hashing: ${file}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
        || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      throw typedError('file_changed', `file changed while hashing: ${file}`);
    }
  } finally {
    await handle.close();
  }
  return Object.freeze({
    size,
    physicalSize: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    sha256: hash.digest('hex'),
  });
}

export async function readBoundedFile(file, {
  maxBytes = 32 * 1024 * 1024,
  encoding = null,
  errorCode = 'file_invalid',
  requireSingleLink = false,
  requiredMode = null,
  requiredUid = null,
  beforeFinalIdentityCheck = null,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
      || (encoding !== null && typeof encoding !== 'string')
      || (requiredMode !== null
        && (!Number.isSafeInteger(requiredMode) || requiredMode < 0 || requiredMode > 0o777))
      || (requiredUid !== null
        && (!Number.isSafeInteger(requiredUid) || requiredUid < 0))
      || (beforeFinalIdentityCheck !== null
        && typeof beforeFinalIdentityCheck !== 'function')) {
    throw typedError('bounded_read_invalid');
  }
  const securityMatches = (stat) => (requiredMode === null
      || Number(stat.mode & 0o777n) === requiredMode)
    && (requiredUid === null || stat.uid === BigInt(requiredUid));
  let handle;
  try {
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)
        || (requireSingleLink && before.nlink !== 1n) || !securityMatches(before)) {
      throw typedError(errorCode, `bounded read refused: ${file}`);
    }
    handle = await fsp.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > BigInt(maxBytes)
        || (requireSingleLink && opened.nlink !== 1n) || !securityMatches(opened)) {
      throw typedError(errorCode, `bounded read identity changed: ${file}`);
    }
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) throw typedError(errorCode, `bounded read shortened: ${file}`);
      offset += bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, size);
    const after = await handle.stat({ bigint: true });
    if (overflowBytes !== 0 || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
        || after.ctimeNs !== opened.ctimeNs
        || (requireSingleLink && after.nlink !== 1n) || !securityMatches(after)) {
      throw typedError(errorCode, `bounded read changed concurrently: ${file}`);
    }
    await beforeFinalIdentityCheck?.();
    const namedAfter = await fsp.lstat(file, { bigint: true });
    if (!namedAfter.isFile() || namedAfter.isSymbolicLink()
        || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino
        || namedAfter.size !== opened.size || namedAfter.mtimeNs !== opened.mtimeNs
        || namedAfter.ctimeNs !== opened.ctimeNs
        || (requireSingleLink && namedAfter.nlink !== 1n)
        || !securityMatches(namedAfter)) {
      throw typedError(errorCode, `bounded read named identity changed: ${file}`);
    }
    return encoding === null ? bytes : bytes.toString(encoding);
  } catch (error) {
    if (error?.code === errorCode || error?.code === 'bounded_read_invalid') throw error;
    throw typedError(errorCode, `bounded read failed: ${file}`, { cause: error });
  } finally {
    await handle?.close();
  }
}

export async function readJson(file, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const text = await readBoundedFile(file, {
    maxBytes,
    encoding: 'utf8',
    errorCode: 'json_file_invalid',
  });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw typedError('json_file_invalid', `invalid JSON file: ${file}`, { cause: error });
  }
}

export function isMain(importMetaUrl, argv = process.argv) {
  return argv[1] && path.resolve(argv[1]) === path.resolve(fileURLToPath(importMetaUrl));
}

export function failCli(error) {
  const code = error?.code || 'acceptance_helper_failed';
  const message = error?.message || String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exitCode = Number.isSafeInteger(error?.exitCode)
    && error.exitCode >= 1 && error.exitCode <= 255
    ? error.exitCode
    : 1;
}

export async function sleep(ms, signal) {
  if (signal?.aborted) throw signal.reason;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const abort = () => {
      finish(() => reject(signal.reason));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export { fs, fsp, path };
