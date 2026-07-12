#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertOutputPath,
  assertReceiptContextDirectoryIdentity,
  canonicalReceiptRow,
  failCli,
  isInsideOrEqual,
  isMain,
  one,
  parseCli,
  readJson,
  receiptContext,
  sha256Bytes,
  typedError,
} from './lib/brain-acceptance-common.mjs';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

export const APPROVED_BRAIN_PROCESS_NAMES = Object.freeze([
  'home23-cosmo23',
  'home23-jerry',
  'home23-forrest',
  'home23-jerry-dash',
  'home23-forrest-dash',
  'home23-jerry-harness',
  'home23-forrest-harness',
  'home23-jerry-mcp',
  'home23-forrest-mcp',
]);
const APPROVED_ALLOWLIST = new Set(APPROVED_BRAIN_PROCESS_NAMES);
const REQUIRED_CONFIGURED_PROCESS_NAMES = Object.freeze(APPROVED_BRAIN_PROCESS_NAMES.slice(0, 7));
const APPROVED_ENV_ADDITION = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';
const CRITICAL_PROCESS_ENVIRONMENT_KEYS = Object.freeze([
  'HOME23_AGENT',
  'INSTANCE_ID',
  'DASHBOARD_PORT',
  'COSMO_DASHBOARD_PORT',
  'REALTIME_PORT',
  'MCP_HTTP_HOST',
  'MCP_HTTP_PORT',
  'HOME23_MCP_AVAILABLE',
  'COSMO_RUNTIME_DIR',
  'COSMO_WORKSPACE_PATH',
  'HOME23_ROOT',
  'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY',
]);
const PRIVATE_ENVIRONMENT_IDENTITIES = new WeakMap();
export const PM2_DUMP_MAX_BYTES = 32 * 1024 * 1024;
const GUARDED_SAVE_LOCK_STALE_MS = 5 * 60 * 1000;
const GUARDED_SAVE_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const GUARDED_TRANSACTION_BINDINGS = new WeakMap();
const GUARDED_TRANSACTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const GUARDED_PM2_CLI_KEYS = new Set([
  'dump', 'allow-changed', 'ecosystem', 'expected-configured', 'restart-baseline',
  'mode', 'receipt-run-dir', 'receipt-run-id', 'authority', 'implementation-commit',
  'output',
]);

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function directoryIdentity(directory, stat) {
  return Object.freeze({
    path: directory,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o777n),
  });
}

async function captureCanonicalDirectory(directory, errorCode) {
  try {
    const before = await fsp.lstat(directory, { bigint: true });
    const canonical = await fsp.realpath(directory);
    const after = await fsp.lstat(directory, { bigint: true });
    const uid = currentUid();
    const mode = Number(after.mode & 0o777n);
    if (!before.isDirectory() || before.isSymbolicLink()
        || !after.isDirectory() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino
        || canonical !== directory
        || (uid !== null && after.uid !== BigInt(uid))
        || (mode & 0o022) !== 0) {
      throw typedError(errorCode, `directory is not canonical and stable: ${directory}`);
    }
    return directoryIdentity(directory, after);
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, `directory authority is invalid: ${directory}`, { cause: error });
  }
}

async function assertDirectoryIdentity(identity, errorCode) {
  const current = await captureCanonicalDirectory(identity.path, errorCode);
  if (current.dev !== identity.dev || current.ino !== identity.ino
      || current.uid !== identity.uid || current.mode !== identity.mode) {
    throw typedError(errorCode, `directory identity changed: ${identity.path}`);
  }
  return identity;
}

async function ensureCanonicalDirectoryTree(directory, {
  context = null,
  errorCode = 'directory_authority_invalid',
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
      || path.normalize(directory) !== directory) {
    throw typedError(errorCode, 'directory must be a normalized absolute path');
  }
  if (context) {
    await assertReceiptContextDirectoryIdentity(context);
    if (!isInsideOrEqual(context.receiptRunDir, directory)) {
      throw typedError(errorCode, 'directory escapes the receipt run');
    }
  }

  let current;
  let components;
  if (context) {
    current = context.receiptRunDir;
    const relative = path.relative(current, directory);
    components = relative ? relative.split(path.sep) : [];
  } else {
    current = directory;
    components = [];
    while (true) {
      try {
        await fsp.lstat(current);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw typedError(errorCode, `directory authority is unavailable: ${current}`, {
            cause: error,
          });
        }
        const parent = path.dirname(current);
        if (parent === current) throw typedError(errorCode, 'no existing directory ancestor');
        components.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  let identity = await captureCanonicalDirectory(current, errorCode);
  if (context && identity.mode !== 0o700) {
    throw typedError(errorCode, `receipt directory must be exact mode 0700: ${identity.path}`);
  }
  for (const component of components) {
    if (!component || component === '.' || component === '..'
        || component.includes(path.sep) || /[\0\r\n]/.test(component)) {
      throw typedError(errorCode, 'directory component is invalid');
    }
    await assertDirectoryIdentity(identity, errorCode);
    const child = path.join(identity.path, component);
    try {
      await fsp.mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw typedError(errorCode, `directory creation failed: ${child}`, { cause: error });
      }
    }
    const childIdentity = await captureCanonicalDirectory(child, errorCode);
    if (context && childIdentity.mode !== 0o700) {
      throw typedError(errorCode, `receipt directory must be exact mode 0700: ${child}`);
    }
    await assertDirectoryIdentity(identity, errorCode);
    identity = childIdentity;
  }
  if (identity.path !== directory) {
    throw typedError(errorCode, 'directory authority resolved to the wrong path');
  }
  if (context) await assertReceiptContextDirectoryIdentity(context);
  return identity;
}

async function syncDirectory(identity, errorCode) {
  await assertDirectoryIdentity(identity, errorCode);
  let handle;
  try {
    handle = await fsp.open(
      identity.path,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    );
    await handle.sync();
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, `directory sync failed: ${identity.path}`, { cause: error });
  } finally {
    await handle?.close();
  }
  await assertDirectoryIdentity(identity, errorCode);
}

function ownedFileIdentity(file, stat) {
  return Object.freeze({
    path: file,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    nlink: stat.nlink.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o777n),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameOwnedFileIdentity(left, right) {
  return Boolean(left && right
    && left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function sameOwnedContentIdentity(left, right, { allowNameCtimeChange = false } = {}) {
  if (!left || !right) return false;
  const keys = [
    'path', 'dev', 'ino', 'nlink', 'uid', 'mode', 'size', 'mtimeNs',
    ...(allowNameCtimeChange ? [] : ['ctimeNs']),
  ];
  return keys.every((key) => left[key] === right[key]);
}

function assertOwnedFileStat(file, stat, errorCode) {
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || Number(stat.mode & 0o777n) !== 0o600
      || (uid !== null && stat.uid !== BigInt(uid))
      || stat.size > BigInt(PM2_DUMP_MAX_BYTES)) {
    throw typedError(errorCode, `owned mode-0600 file identity is invalid: ${file}`);
  }
}

const OWNED_FILE_CAPABILITIES = new WeakMap();

async function readOwnedCapabilityExact(capability, errorCode, {
  requireNamed = true,
  allowNameCtimeChange = false,
} = {}) {
  const binding = OWNED_FILE_CAPABILITIES.get(capability);
  if (!binding || binding.closed || !binding.handle) {
    throw typedError(errorCode, 'owned file capability is unavailable');
  }
  if (requireNamed) await assertDirectoryIdentity(binding.parentIdentity, errorCode);
  const opened = await binding.handle.stat({ bigint: true });
  assertOwnedFileStat(binding.file, opened, errorCode);
  const openedIdentity = ownedFileIdentity(binding.file, opened);
  if (!sameOwnedContentIdentity(openedIdentity, binding.identity, { allowNameCtimeChange })) {
    throw typedError(errorCode, `owned file descriptor changed: ${binding.file}`);
  }
  const size = Number(opened.size);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await binding.handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) throw typedError(errorCode, 'owned file shortened while reading');
    offset += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytes } = await binding.handle.read(overflow, 0, 1, size);
  const after = await binding.handle.stat({ bigint: true });
  if (overflowBytes !== 0
      || !sameOwnedFileIdentity(ownedFileIdentity(binding.file, after), openedIdentity)
      || !bytes.equals(binding.expectedBytes)) {
    throw typedError(errorCode, `owned file readback mismatch: ${binding.file}`);
  }
  if (requireNamed) {
    const named = await fsp.lstat(binding.file, { bigint: true });
    assertOwnedFileStat(binding.file, named, errorCode);
    if (!sameOwnedFileIdentity(ownedFileIdentity(binding.file, named), binding.identity)
        || await fsp.realpath(binding.file) !== binding.file) {
      throw typedError(errorCode, `owned file name changed: ${binding.file}`);
    }
    await assertDirectoryIdentity(binding.parentIdentity, errorCode);
  }
  return bytes;
}

async function createOwnedFileCapability(file, bytes, parentIdentity, {
  existsCode,
  invalidCode,
} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > PM2_DUMP_MAX_BYTES
      || path.dirname(file) !== parentIdentity.path) {
    throw typedError(invalidCode, 'exclusive file input is invalid');
  }
  await assertDirectoryIdentity(parentIdentity, invalidCode);
  try {
    await fsp.lstat(file);
    throw typedError(existsCode, `owned output already exists: ${file}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let handle;
  let capability;
  try {
    handle = await fsp.open(
      file,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    assertOwnedFileStat(file, opened, invalidCode);
    const identity = ownedFileIdentity(file, opened);
    const named = await fsp.lstat(file, { bigint: true });
    assertOwnedFileStat(file, named, invalidCode);
    if (!sameOwnedFileIdentity(ownedFileIdentity(file, named), identity)
        || await fsp.realpath(file) !== file) {
      throw typedError(invalidCode, `exclusive file name changed: ${file}`);
    }
    capability = Object.freeze({ path: file });
    OWNED_FILE_CAPABILITIES.set(capability, {
      file,
      parentIdentity,
      handle,
      identity,
      expectedBytes: Buffer.from(bytes),
      closed: false,
    });
    handle = null;
    await syncDirectory(parentIdentity, invalidCode);
    await readOwnedCapabilityExact(capability, invalidCode);
    return capability;
  } catch (error) {
    if (capability) await closeOwnedCapability(capability).catch(() => {});
    if (error?.code === 'EEXIST') {
      throw typedError(existsCode, `owned output already exists: ${file}`, { cause: error });
    }
    if (error?.code === invalidCode || error?.code === existsCode) throw error;
    throw typedError(invalidCode, `exclusive durable file creation failed: ${file}`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function rewriteOwnedCapability(capability, bytes, errorCode) {
  const binding = OWNED_FILE_CAPABILITIES.get(capability);
  if (!binding || binding.closed || !Buffer.isBuffer(bytes)
      || bytes.length > PM2_DUMP_MAX_BYTES) {
    throw typedError(errorCode, 'owned file rewrite input is invalid');
  }
  await readOwnedCapabilityExact(capability, errorCode);
  try {
    await binding.handle.truncate(0);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await binding.handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesWritten === 0) throw typedError(errorCode, 'owned file rewrite stalled');
      offset += bytesWritten;
    }
    await binding.handle.sync();
    const after = await binding.handle.stat({ bigint: true });
    assertOwnedFileStat(binding.file, after, errorCode);
    if (after.dev.toString() !== binding.identity.dev
        || after.ino.toString() !== binding.identity.ino
        || after.nlink.toString() !== binding.identity.nlink
        || after.size !== BigInt(bytes.length)) {
      throw typedError(errorCode, `owned file rewrite identity changed: ${binding.file}`);
    }
    binding.identity = ownedFileIdentity(binding.file, after);
    binding.expectedBytes = Buffer.from(bytes);
    await readOwnedCapabilityExact(capability, errorCode);
    await syncDirectory(binding.parentIdentity, errorCode);
    await readOwnedCapabilityExact(capability, errorCode);
    return capability;
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, `owned file rewrite failed: ${binding.file}`, { cause: error });
  }
}

async function closeOwnedCapability(capability) {
  const binding = OWNED_FILE_CAPABILITIES.get(capability);
  if (!binding || binding.closed) return;
  binding.closed = true;
  await binding.handle.close();
  binding.handle = null;
}

function encodeJsonRow(row) {
  return Buffer.from(`${JSON.stringify(row, null, 2)}\n`);
}

export async function prepareGuardedPm2ReceiptTransaction({
  context,
  outputPath,
  mode,
  dumpPath,
  beforeFinalReadback = null,
  beforeFailureIntent = null,
} = {}) {
  if (!context || (mode !== 'dry-run' && mode !== 'apply')
      || typeof outputPath !== 'string' || !path.isAbsolute(outputPath)
      || path.normalize(outputPath) !== outputPath
      || typeof dumpPath !== 'string' || !path.isAbsolute(dumpPath)
      || path.normalize(dumpPath) !== dumpPath
      || (beforeFinalReadback !== null && typeof beforeFinalReadback !== 'function')
      || (beforeFailureIntent !== null && typeof beforeFailureIntent !== 'function')) {
    throw typedError('receipt_transaction_invalid');
  }
  await assertReceiptContextDirectoryIdentity(context);
  const target = assertOutputPath(context, outputPath);
  const parentIdentity = await ensureCanonicalDirectoryTree(path.dirname(target), {
    context,
    errorCode: 'output_path_invalid',
  });
  await assertReceiptContextDirectoryIdentity(context);

  const transactionId = randomUUID();
  const intentPath = path.join(
    parentIdentity.path,
    `.${path.basename(target)}.${transactionId}.guarded-pm2-intent.json`,
  );
  if (!GUARDED_TRANSACTION_ID.test(transactionId)) {
    throw typedError('receipt_transaction_invalid');
  }
  const shared = {
    helper: 'guarded-pm2-save',
    transactionId,
    transactionState: 'reserved',
    mode,
    dumpPath,
    outputPath: target,
    ok: false,
    pm2SaveInvoked: false,
    restored: false,
    restorationVerified: false,
  };
  const resultReservation = canonicalReceiptRow(context, {
    ...shared,
    receiptKind: 'guarded-pm2-save-result',
    transactionRole: 'result',
    transactionIntentBasename: path.basename(intentPath),
    receiptPublicationVerified: false,
  });
  const intentReservation = canonicalReceiptRow(context, {
    ...shared,
    receiptKind: 'guarded-pm2-save-intent',
    transactionRole: 'intent',
    outputArtifactSha256: resultReservation.artifactSha256,
  });
  const outputCapability = await createOwnedFileCapability(
    target,
    encodeJsonRow(resultReservation),
    parentIdentity,
    {
      existsCode: 'receipt_output_exists',
      invalidCode: 'receipt_output_changed',
    },
  );
  let intentCapability;
  try {
    intentCapability = await createOwnedFileCapability(
      intentPath,
      encodeJsonRow(intentReservation),
      parentIdentity,
      {
        existsCode: 'receipt_intent_exists',
        invalidCode: 'receipt_intent_changed',
      },
    );
  } catch (error) {
    await closeOwnedCapability(outputCapability).catch(() => {});
    throw error;
  }
  const transaction = Object.freeze({
    transactionId,
    outputPath: target,
    intentPath,
  });
  GUARDED_TRANSACTION_BINDINGS.set(transaction, {
    transaction,
    context,
    mode,
    dumpPath,
    outputPath: target,
    intentPath,
    parentIdentity,
    outputCapability,
    intentCapability,
    beforeFinalReadback,
    beforeFailureIntent,
    state: 'reserved',
    publishedReceipt: null,
  });
  return transaction;
}

function claimGuardedTransaction(transaction, { context, mode, dumpPath }) {
  const binding = GUARDED_TRANSACTION_BINDINGS.get(transaction);
  if (!binding) throw typedError('pm2_receipt_transaction_required');
  if (binding.state !== 'reserved') throw typedError('pm2_receipt_transaction_replayed');
  const lease = Object.freeze({});
  binding.state = 'active';
  binding.activeLease = lease;
  return Object.freeze({
    binding,
    lease,
    matches: binding.context === context && binding.mode === mode && binding.dumpPath === dumpPath,
  });
}

async function assertActiveGuardedTransaction(binding, lease) {
  if (!binding || binding.state !== 'active' || binding.activeLease !== lease) {
    throw typedError('pm2_receipt_transaction_replayed');
  }
  await assertReceiptContextDirectoryIdentity(binding.context);
  await assertDirectoryIdentity(binding.parentIdentity, 'receipt_output_changed');
  await readOwnedCapabilityExact(binding.outputCapability, 'receipt_output_changed');
  await readOwnedCapabilityExact(binding.intentCapability, 'receipt_intent_changed');
  await assertReceiptContextDirectoryIdentity(binding.context);
}

function guardedTransactionFields(binding, state) {
  return {
    helper: 'guarded-pm2-save',
    transactionId: binding.transaction.transactionId,
    transactionState: state,
    mode: binding.mode,
    dumpPath: binding.dumpPath,
    outputPath: binding.outputPath,
  };
}

async function publishGuardedTransaction(binding, lease, result) {
  await assertActiveGuardedTransaction(binding, lease);
  binding.state = 'publishing';
  const resultRow = canonicalReceiptRow(binding.context, {
    ...result,
    ...guardedTransactionFields(binding, 'committed'),
    receiptKind: 'guarded-pm2-save-result',
    transactionRole: 'result',
    transactionIntentBasename: path.basename(binding.intentPath),
    ok: true,
    receiptPublicationVerified: true,
  });
  const intentRow = canonicalReceiptRow(binding.context, {
    ...guardedTransactionFields(binding, 'committed'),
    receiptKind: 'guarded-pm2-save-intent',
    transactionRole: 'intent',
    ok: true,
    pm2SaveInvoked: result.pm2SaveInvoked === true,
    restored: false,
    restorationVerified: false,
    backupBasename: result.backupBasename,
    outputArtifactSha256: resultRow.artifactSha256,
  });
  try {
    await rewriteOwnedCapability(
      binding.intentCapability,
      encodeJsonRow(intentRow),
      'receipt_intent_changed',
    );
    await binding.beforeFinalReadback?.();
    await assertReceiptContextDirectoryIdentity(binding.context);
    await assertDirectoryIdentity(binding.parentIdentity, 'receipt_output_changed');
    await readOwnedCapabilityExact(binding.intentCapability, 'receipt_intent_changed');
    await readOwnedCapabilityExact(binding.outputCapability, 'receipt_output_changed');
    await assertReceiptContextDirectoryIdentity(binding.context);
    await rewriteOwnedCapability(
      binding.outputCapability,
      encodeJsonRow(resultRow),
      'receipt_publication_failed',
    );
    await assertReceiptContextDirectoryIdentity(binding.context);
    await readOwnedCapabilityExact(binding.intentCapability, 'receipt_intent_changed');
    await readOwnedCapabilityExact(binding.outputCapability, 'receipt_publication_failed');
    await assertDirectoryIdentity(binding.parentIdentity, 'receipt_output_changed');
    await assertReceiptContextDirectoryIdentity(binding.context);
    binding.state = 'committed';
    binding.publishedReceipt = resultRow;
    return resultRow;
  } catch (error) {
    binding.state = 'publication-failed';
    throw error;
  }
}

async function failGuardedTransaction(binding, lease, error) {
  if (!binding || binding.activeLease !== lease
      || !['active', 'publication-failed'].includes(binding.state)) return null;
  binding.state = 'failing';
  const pm2Save = error?.pm2Save || {};
  const invoked = pm2Save.pm2SaveInvoked === true;
  const restored = pm2Save.restored === true;
  const restorationVerified = pm2Save.restorationVerified === true;
  const transactionState = invoked
    ? (restored && restorationVerified ? 'failed-restored' : 'failed-restore-unverified')
    : 'failed-nonmutating';
  const resultRow = canonicalReceiptRow(binding.context, {
    ...guardedTransactionFields(binding, transactionState),
    receiptKind: 'guarded-pm2-save-result',
    transactionRole: 'result',
    transactionIntentBasename: path.basename(binding.intentPath),
    ok: false,
    pm2SaveInvoked: invoked,
    restored,
    restorationVerified,
    receiptPublicationVerified: false,
    errorCode: typeof error?.code === 'string' ? error.code : 'guarded_pm2_save_failed',
    backupBasename: pm2Save.backupBasename || null,
  });
  const intentRow = canonicalReceiptRow(binding.context, {
    ...guardedTransactionFields(binding, transactionState),
    receiptKind: 'guarded-pm2-save-intent',
    transactionRole: 'intent',
    ok: false,
    pm2SaveInvoked: invoked,
    restored,
    restorationVerified,
    outputArtifactSha256: resultRow.artifactSha256,
    errorCode: resultRow.errorCode,
    backupBasename: resultRow.backupBasename,
  });
  try {
    await rewriteOwnedCapability(
      binding.outputCapability,
      encodeJsonRow(resultRow),
      'receipt_output_changed',
    );
    await binding.beforeFailureIntent?.();
    await rewriteOwnedCapability(
      binding.intentCapability,
      encodeJsonRow(intentRow),
      'receipt_intent_changed',
    );
  } catch (failure) {
    binding.state = 'failure-evidence-unavailable';
    binding.publishedReceipt = null;
    throw typedError(
      'receipt_failure_evidence_unavailable',
      'both guarded PM2 failure receipt sides could not be retained',
      { cause: failure },
    );
  }
  binding.state = transactionState;
  binding.publishedReceipt = resultRow;
  return resultRow;
}

async function closeGuardedTransaction(binding, lease) {
  if (!binding || binding.activeLease !== lease) return;
  await Promise.allSettled([
    closeOwnedCapability(binding.outputCapability),
    closeOwnedCapability(binding.intentCapability),
  ]);
  binding.activeLease = null;
}

function orderedStrings(value) {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => String(entry));
}

function orderedNodeArguments(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.split(/\s+/) : [];
  }
  return orderedStrings(value);
}

function normalizeExecMode(value) {
  const mode = String(value ?? 'fork_mode');
  if (mode === 'fork') return 'fork_mode';
  if (mode === 'cluster') return 'cluster_mode';
  return mode;
}

const PM2_PROCESS_METADATA_KEYS = new Set([
  'name', 'namespace', 'status', 'pm_id', 'pm_pid', 'pid', 'pm_uptime', 'created_at',
  'restart_time', 'unstable_restarts', 'exit_code', 'node_version', 'version',
  'pm_exec_path', 'pm_cwd', 'exec_mode', 'instances', 'args', 'node_args', 'interpreter',
  'exec_interpreter', 'autorestart', 'autostart', 'watch', 'merge_logs', 'out_file',
  'error_file', 'pm_out_log_path', 'pm_err_log_path', 'pm_log_path', 'kill_retry_time',
  'vizion', 'treekill', 'windowsHide', 'username', 'uid', 'gid', 'cwd', 'script',
  'axm_dynamic', 'axm_options', 'axm_monitor', 'axm_actions', 'env', 'filter_env',
  'envKeys', 'unique_id', 'prev_restart_delay', 'restart_delay', 'max_memory_restart',
  'cron_restart', 'exp_backoff_restart_delay', 'stop_exit_codes', 'source_map_support',
  'instance_var', 'increment_var', 'automation', 'km_link', 'pmx', 'log_type',
  'pmx_module', 'module_name', 'module_conf',
  'log_date_format', 'combine_logs', 'time', 'wait_ready', 'listen_timeout',
  'kill_timeout', 'shutdown_with_message', 'namespace_id', 'from_chokidar',
]);

function isPm2ProcessMetadataKey(key) {
  return PM2_PROCESS_METADATA_KEYS.has(key) || /^PM2_/.test(key);
}

function envKeys(row) {
  const keys = new Set();
  for (const container of [row?.env, row?.pm2_env?.env]) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const key of Object.keys(container)) {
      if (!isPm2ProcessMetadataKey(key)) keys.add(key);
    }
  }
  const flattened = row?.pm2_env || row;
  if (flattened && typeof flattened === 'object' && !Array.isArray(flattened)) {
    for (const key of Object.keys(flattened)) {
      if (!isPm2ProcessMetadataKey(key)) keys.add(key);
    }
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function environmentDigest(key, value) {
  return createHash('sha256')
    .update(key)
    .update('\0')
    .update(String(value ?? ''))
    .digest();
}

function privateEnvironmentIdentity(row, { ecosystem = false } = {}) {
  const containers = ecosystem
    ? [row?.env]
    : [row?.env, row?.pm2_env?.env, row?.pm2_env];
  const entries = [];
  let unambiguous = true;
  for (const key of CRITICAL_PROCESS_ENVIRONMENT_KEYS) {
    const values = [];
    for (const container of containers) {
      if (!container || typeof container !== 'object' || Array.isArray(container)
          || !Object.hasOwn(container, key)) continue;
      const normalized = String(container[key] ?? '');
      if (!values.includes(normalized)) values.push(normalized);
    }
    if (values.length > 1) {
      unambiguous = false;
      continue;
    }
    if (values.length === 1) {
      entries.push(Object.freeze({ key, digest: environmentDigest(key, values[0]) }));
    }
  }
  return Object.freeze({ unambiguous, entries: Object.freeze(entries) });
}

function bindPrivateEnvironmentIdentity(normalized, row, options) {
  PRIVATE_ENVIRONMENT_IDENTITIES.set(normalized, privateEnvironmentIdentity(row, options));
  return normalized;
}

function equalPrivateEnvironmentIdentity(observed, expected) {
  const observedIdentity = PRIVATE_ENVIRONMENT_IDENTITIES.get(observed);
  const expectedIdentity = PRIVATE_ENVIRONMENT_IDENTITIES.get(expected);
  if (!observedIdentity?.unambiguous || !expectedIdentity?.unambiguous) return false;
  const observedByKey = new Map(
    observedIdentity.entries.map((entry) => [entry.key, entry.digest]),
  );
  for (const entry of expectedIdentity.entries) {
    const actual = observedByKey.get(entry.key);
    if (!actual || actual.length !== entry.digest.length
        || !timingSafeEqual(actual, entry.digest)) return false;
  }
  return true;
}

function samePrivateEnvironmentIdentity(left, right) {
  return equalPrivateEnvironmentIdentity(left, right)
    && equalPrivateEnvironmentIdentity(right, left);
}

export function normalizePm2Row(row) {
  // `pm2 jlist` nests process metadata under `pm2_env`, while dump.pm2 stores
  // that same metadata at the top level. Normalize both shapes through the
  // same view so a safe pre-save comparison does not report false drift.
  const environment = row?.pm2_env || row || {};
  const name = row?.name ?? environment.name;
  if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name)) throw typedError('pm2_row_invalid');
  const rawPid = row?.pid ?? environment.pid ?? environment.pm_pid;
  const pid = rawPid === undefined || rawPid === null || rawPid === '' ? null : Number(rawPid);
  const restartCount = Number(environment.restart_time ?? row?.restartCount ?? 0);
  const rawUptime = environment.pm_uptime ?? row?.uptime ?? null;
  const uptime = rawUptime === undefined || rawUptime === null || rawUptime === ''
    ? null : Number(rawUptime);
  const instances = Number(environment.instances ?? row?.instances ?? 1);
  if ((pid !== null && (!Number.isSafeInteger(pid) || pid < 1))
      || !Number.isSafeInteger(restartCount) || restartCount < 0
      || (uptime !== null && (!Number.isSafeInteger(uptime) || uptime < 0))
      || !Number.isSafeInteger(instances) || instances < 1) {
    throw typedError('pm2_row_invalid', name);
  }
  return bindPrivateEnvironmentIdentity(Object.freeze({
    name,
    status: String(environment.status ?? row?.status ?? 'unknown'),
    pid,
    restartCount,
    uptime,
    script: String(environment.pm_exec_path ?? row?.script ?? ''),
    cwd: String(environment.pm_cwd ?? row?.cwd ?? ''),
    namespace: String(environment.namespace ?? row?.namespace ?? 'default'),
    execMode: normalizeExecMode(environment.exec_mode ?? row?.execMode ?? ''),
    instances,
    args: orderedStrings(environment.args ?? row?.args),
    interpreter: String(environment.exec_interpreter ?? row?.interpreter ?? 'node'),
    nodeArgs: orderedNodeArguments(environment.node_args ?? row?.nodeArgs),
    envKeys: envKeys(row),
  }), row);
}

export function normalizeEcosystemRow(row, baseDir = process.cwd()) {
  const name = row?.name;
  if (typeof name !== 'string' || !APPROVED_ALLOWLIST.has(name)) {
    throw typedError('pm2_ecosystem_row_invalid', String(name || 'unnamed'));
  }
  const cwdValue = row?.cwd ?? baseDir;
  const scriptValue = row?.script;
  if (typeof cwdValue !== 'string' || !cwdValue
      || typeof scriptValue !== 'string' || !scriptValue
      || /[\0\r\n]/.test(cwdValue) || /[\0\r\n]/.test(scriptValue)) {
    throw typedError('pm2_ecosystem_row_invalid', name);
  }
  const cwd = path.resolve(baseDir, cwdValue);
  const script = path.isAbsolute(scriptValue)
    ? path.normalize(scriptValue)
    : path.resolve(cwd, scriptValue);
  const instances = Number(row?.instances ?? 1);
  if (!Number.isSafeInteger(instances) || instances < 1) {
    throw typedError('pm2_ecosystem_row_invalid', name);
  }
  return bindPrivateEnvironmentIdentity(Object.freeze({
    name,
    script,
    cwd,
    namespace: String(row?.namespace ?? 'default'),
    execMode: normalizeExecMode(row?.exec_mode ?? row?.execMode ?? 'fork_mode'),
    instances,
    args: orderedStrings(row?.args),
    interpreter: String(row?.interpreter ?? row?.exec_interpreter ?? 'node'),
    nodeArgs: orderedNodeArguments(row?.node_args ?? row?.nodeArgs),
    envKeys: envKeys({ env: row?.env }),
  }), row, { ecosystem: true });
}

export function normalizeEcosystemTable(rows, baseDir = process.cwd()) {
  if (!Array.isArray(rows)) throw typedError('pm2_ecosystem_invalid');
  const table = new Map();
  for (const row of rows) {
    if (!APPROVED_ALLOWLIST.has(row?.name)) continue;
    const normalized = normalizeEcosystemRow(row, baseDir);
    if (table.has(normalized.name)) {
      throw typedError('pm2_ecosystem_duplicate_process', normalized.name);
    }
    table.set(normalized.name, normalized);
  }
  return table;
}

function isPm2ModuleRow(row) {
  const environment = row?.pm2_env || row || {};
  return environment.pmx_module === true;
}

function normalizePm2Partitions(rows, label = 'PM2 table') {
  if (!Array.isArray(rows)) throw typedError('pm2_table_invalid', label);
  const processes = new Map();
  const modules = new Map();
  const names = new Set();
  for (const row of rows) {
    const normalized = normalizePm2Row(row);
    if (names.has(normalized.name)) throw typedError('pm2_duplicate_process', normalized.name);
    if (normalized.status !== 'online') throw typedError('pm2_process_not_online', normalized.name);
    names.add(normalized.name);
    (isPm2ModuleRow(row) ? modules : processes).set(normalized.name, normalized);
  }
  return { processes, modules };
}

export function normalizePm2Table(rows, label = 'PM2 table') {
  const { processes, modules } = normalizePm2Partitions(rows, label);
  return new Map([...processes, ...modules]);
}

function tableRows(table) {
  return [...table.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function equalRow(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dumpComparableLiveRow(live, dump) {
  // Saved PM2 dumps omit the live PID but may retain the process start time
  // from the last save. That timestamp is historical, not current runtime
  // identity. The guarded transaction freezes current PID and uptime across
  // its own pre/post listings, so ignore both stale runtime fields only for
  // this pid-less dump comparison.
  return dump.pid === null ? { ...live, pid: null, uptime: dump.uptime } : live;
}

function equalLiveAndDumpRow(live, dump) {
  return equalRow(dumpComparableLiveRow(live, dump), dump);
}

function equalExceptRestartCount(live, dump) {
  return equalRow(
    { ...dumpComparableLiveRow(live, dump), restartCount: dump.restartCount },
    dump,
  );
}

function equalAllowlistedIdentity(left, right) {
  const mutable = new Set(['pid', 'restartCount', 'uptime', 'envKeys']);
  const stableLeft = Object.fromEntries(
    Object.entries(left).filter(([key]) => !mutable.has(key)),
  );
  const stableRight = Object.fromEntries(
    Object.entries(right).filter(([key]) => !mutable.has(key)),
  );
  return equalRow(stableLeft, stableRight);
}

function processIdentity(row) {
  return {
    name: row.name,
    script: row.script,
    cwd: row.cwd,
    namespace: row.namespace,
    execMode: row.execMode,
    instances: row.instances,
    args: row.args,
    interpreter: row.interpreter,
    nodeArgs: row.nodeArgs,
  };
}

function restartCountsByName(rows, label) {
  if (!Array.isArray(rows)) throw typedError('pm2_restart_baseline_invalid', label);
  const counts = new Map();
  for (const row of rows) {
    const environment = row?.pm2_env || row || {};
    const name = row?.name ?? environment.name;
    const restartCount = Number(
      environment.restart_time ?? row?.restarts ?? row?.restartCount,
    );
    if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name)
        || !Number.isSafeInteger(restartCount) || restartCount < 0
        || counts.has(name)) {
      throw typedError('pm2_restart_baseline_invalid', String(name || label));
    }
    counts.set(name, restartCount);
  }
  return counts;
}

export function assertRestartBaselineMonotonic(liveRows, baselineRows, allowChanged) {
  const allow = allowChanged instanceof Set ? allowChanged : new Set(allowChanged || []);
  const live = restartCountsByName(liveRows, 'live PM2 restart baseline');
  const baseline = restartCountsByName(baselineRows, 'delayed PM2 restart baseline');
  const receipt = [];
  const unrelatedNames = new Set([
    ...[...live.keys()].filter((name) => !allow.has(name)),
    ...[...baseline.keys()].filter((name) => !allow.has(name)),
  ]);
  for (const name of [...unrelatedNames].sort((left, right) => left.localeCompare(right))) {
    if (!live.has(name) || !baseline.has(name)) {
      throw typedError('pm2_restart_baseline_mismatch', name);
    }
    const baselineRestartCount = baseline.get(name);
    const liveRestartCount = live.get(name);
    if (liveRestartCount < baselineRestartCount) {
      throw typedError('pm2_restart_baseline_regressed', name);
    }
    receipt.push(Object.freeze({ name, baselineRestartCount, liveRestartCount }));
  }
  return Object.freeze(receipt);
}

function equalEcosystemIdentity(live, expected) {
  return equalRow(processIdentity(live), processIdentity(expected))
    && equalPrivateEnvironmentIdentity(live, expected);
}

function assertPlannedAllowlistedDelta(live, dump, name, expected = null) {
  if (expected && !equalEcosystemIdentity(live, expected)) {
    throw typedError('pm2_ecosystem_identity_mismatch', name);
  }
  if (!expected && !equalAllowlistedIdentity(live, dump)) {
    throw typedError('pm2_allowlisted_identity_drift', name);
  }
  if (!expected && live.restartCount < dump.restartCount) {
    throw typedError('pm2_allowlisted_delta_invalid', name);
  }
  const liveKeys = new Set(live.envKeys);
  const dumpKeys = new Set(dump.envKeys);
  if (expected) {
    const configuredKeys = new Set(expected.envKeys || []);
    if ([...configuredKeys].some((key) => !liveKeys.has(key))) {
      throw typedError('pm2_allowlisted_delta_invalid', name);
    }
    const added = [...liveKeys].filter((key) => !dumpKeys.has(key));
    if (added.some((key) => !configuredKeys.has(key))) {
      throw typedError('pm2_allowlisted_delta_invalid', name);
    }
    return;
  }
  if ([...dumpKeys].some((key) => !liveKeys.has(key))) {
    throw typedError('pm2_allowlisted_delta_invalid', name);
  }
  const added = [...liveKeys].filter((key) => !dumpKeys.has(key));
  if (added.some((key) => key !== APPROVED_ENV_ADDITION)) {
    throw typedError('pm2_allowlisted_delta_invalid', name);
  }
}

export function comparePreSaveTables(live, dump, allowChanged, ecosystemIdentities = new Map()) {
  const unrelatedRestartBaselines = [];
  const names = new Set([...live.keys(), ...dump.keys()]);
  for (const name of names) {
    if (!live.has(name)) throw typedError('pm2_table_drift', name);
    if (!dump.has(name)) {
      if (allowChanged.has(name)) {
        const expected = ecosystemIdentities.get(name);
        if (!expected) throw typedError('pm2_ecosystem_identity_missing', name);
        if (!equalEcosystemIdentity(live.get(name), expected)) {
          throw typedError('pm2_ecosystem_identity_mismatch', name);
        }
        continue;
      }
      throw typedError('pm2_table_drift', name);
    }
    const liveRow = live.get(name);
    const dumpRow = dump.get(name);
    if (allowChanged.has(name) && ecosystemIdentities.has(name)
        && !equalEcosystemIdentity(liveRow, ecosystemIdentities.get(name))) {
      throw typedError('pm2_ecosystem_identity_mismatch', name);
    }
    if (!allowChanged.has(name) && !equalLiveAndDumpRow(liveRow, dumpRow)) {
      if (liveRow.restartCount > dumpRow.restartCount
          && equalExceptRestartCount(liveRow, dumpRow)) {
        unrelatedRestartBaselines.push({
          name,
          dumpRestartCount: dumpRow.restartCount,
          liveRestartCount: liveRow.restartCount,
        });
      } else {
        throw typedError('pm2_unrelated_drift', name);
      }
    }
    if (allowChanged.has(name)) {
      assertPlannedAllowlistedDelta(
        liveRow,
        dumpRow,
        name,
        ecosystemIdentities.get(name) || null,
      );
    }
  }
  return unrelatedRestartBaselines.sort((left, right) => left.name.localeCompare(right.name));
}

function assertExpectedConfiguredAuthority(expectedConfigured, ecosystemIdentities) {
  if (!Array.isArray(expectedConfigured) || expectedConfigured.length === 0
      || new Set(expectedConfigured).size !== expectedConfigured.length
      || expectedConfigured.some((name) => !APPROVED_ALLOWLIST.has(name))
      || REQUIRED_CONFIGURED_PROCESS_NAMES.some((name) => !expectedConfigured.includes(name))) {
    throw typedError('pm2_expected_configured_invalid');
  }
  const expected = new Set(expectedConfigured);
  if (expected.size !== ecosystemIdentities.size
      || [...expected].some((name) => !ecosystemIdentities.has(name))) {
    throw typedError('pm2_expected_configured_mismatch');
  }
}

function assertExpectedConfiguredPresent(table, expectedConfigured, label) {
  for (const name of expectedConfigured) {
    if (!table.has(name)) throw typedError('pm2_expected_process_missing', `${label}:${name}`);
  }
}

function assertFrozenEcosystemAuthority(before, after) {
  if (before.size !== after.size) throw typedError('pm2_ecosystem_authority_changed');
  for (const [name, row] of before) {
    if (!after.has(name) || !equalRow(row, after.get(name))
        || !samePrivateEnvironmentIdentity(row, after.get(name))) {
      throw typedError('pm2_ecosystem_authority_changed', name);
    }
  }
}

function assertApprovedAllowlist(values) {
  if (!Array.isArray(values) || values.length !== APPROVED_BRAIN_PROCESS_NAMES.length
      || new Set(values).size !== values.length
      || values.some((name) => !APPROVED_ALLOWLIST.has(name))) {
    throw typedError('pm2_allowlist_invalid');
  }
}

function assertFrozenLive(before, after) {
  if (before.size !== after.size) throw typedError('pm2_live_table_changed');
  for (const [name, row] of before) {
    if (!after.has(name) || !equalRow(row, after.get(name))
        || !samePrivateEnvironmentIdentity(row, after.get(name))) {
      throw typedError('pm2_live_table_changed', name);
    }
  }
}

function assertFrozenModules(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of names) {
    if (!before.has(name) || !after.has(name)
        || !equalRow(before.get(name), after.get(name))) {
      throw typedError('pm2_live_module_changed', name);
    }
  }
}

function assertDumpContainsNoModules(modules) {
  if (modules.size === 0) return;
  const [name] = [...modules.keys()].sort((left, right) => left.localeCompare(right));
  throw typedError('pm2_dump_contains_module', name);
}

function assertDumpEqualsLive(live, dump) {
  if (live.size !== dump.size) throw typedError('pm2_dump_postcondition_failed');
  for (const [name, row] of live) {
    if (!dump.has(name) || !equalLiveAndDumpRow(row, dump.get(name))
        || !samePrivateEnvironmentIdentity(row, dump.get(name))) {
      throw typedError('pm2_dump_postcondition_failed', name);
    }
  }
}

async function defaultListProcesses() {
  const { stdout } = await execFile('pm2', ['jlist'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function defaultSave() {
  await execFile('pm2', ['save'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

async function defaultAcquireSaveLock(dumpPath) {
  try {
    return await lockfile.lock(dumpPath, {
      realpath: true,
      lockfilePath: `${dumpPath}.home23-guarded-save.lock`,
      stale: GUARDED_SAVE_LOCK_STALE_MS,
      update: 30_000,
      retries: {
        retries: Math.ceil(GUARDED_SAVE_LOCK_TIMEOUT_MS / 100),
        factor: 1,
        minTimeout: 25,
        maxTimeout: 100,
        randomize: true,
      },
    });
  } catch (error) {
    throw typedError(
      'pm2_save_lock_unavailable',
      'guarded PM2 save serialization lock is unavailable',
      { cause: error },
    );
  }
}

function loadEcosystemApps(ecosystemPath) {
  let resolved;
  try {
    resolved = require.resolve(ecosystemPath);
    delete require.cache[resolved];
    const document = require(resolved);
    if (!document || !Array.isArray(document.apps)) throw new Error('apps missing');
    return document.apps;
  } catch (error) {
    throw typedError('pm2_ecosystem_invalid', ecosystemPath, { cause: error });
  }
}

function dumpIdentity(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    nlink: stat.nlink.toString(),
    mode: Number(stat.mode & 0o777n),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function equalDumpIdentity(left, right) {
  return left && right && JSON.stringify(left) === JSON.stringify(right);
}

async function readDumpDocument(dumpPath) {
  let handle;
  try {
    const before = await fsp.lstat(dumpPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size > BigInt(PM2_DUMP_MAX_BYTES)) {
      throw typedError('pm2_dump_invalid', 'dump.pm2 bounded identity is invalid');
    }
    handle = await fsp.open(
      dumpPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = await handle.stat({ bigint: true });
    const expectedIdentity = dumpIdentity(before);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n
        || !equalDumpIdentity(dumpIdentity(opened), expectedIdentity)) {
      throw typedError('pm2_dump_invalid', 'dump.pm2 identity changed while opening');
    }
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) {
        throw typedError('pm2_dump_invalid', 'dump.pm2 shortened while reading');
      }
      offset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, size);
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fsp.lstat(dumpPath, { bigint: true });
    if (overflowBytes !== 0
        || !equalDumpIdentity(dumpIdentity(after), expectedIdentity)
        || !equalDumpIdentity(dumpIdentity(namedAfter), expectedIdentity)) {
      throw typedError('pm2_dump_invalid', 'dump.pm2 changed while reading');
    }
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); }
    catch (error) {
      throw typedError('pm2_dump_invalid', 'dump.pm2 is invalid JSON', { cause: error });
    }
    return {
      bytes,
      document,
      mode: expectedIdentity.mode,
      identity: expectedIdentity,
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'pm2_dump_invalid') throw error;
    throw typedError('pm2_dump_invalid', 'dump.pm2 bounded read failed', { cause: error });
  } finally {
    await handle?.close();
  }
}

function assertDumpSnapshotUnchanged(expected, current) {
  if (!equalDumpIdentity(expected?.identity, current?.identity)
      || expected?.mode !== current?.mode
      || !Buffer.isBuffer(expected?.bytes)
      || !Buffer.isBuffer(current?.bytes)
      || !expected.bytes.equals(current.bytes)) {
    throw typedError('pm2_dump_changed_before_save', 'dump.pm2 changed before save');
  }
}

async function restoreDumpAtomic(dumpPath, bytes, mode, { parentIdentity } = {}) {
  if (!parentIdentity || path.dirname(dumpPath) !== parentIdentity.path
      || !Buffer.isBuffer(bytes) || !Number.isSafeInteger(mode)
      || mode < 0 || mode > 0o777) {
    throw typedError('pm2_dump_restore_failed', 'dump restore authority is invalid');
  }
  await assertDirectoryIdentity(parentIdentity, 'pm2_dump_parent_changed');
  const temporary = path.join(
    parentIdentity.path,
    `.${path.basename(dumpPath)}.${process.pid}.${randomUUID()}.restore`,
  );
  const handle = await fsp.open(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1n
        || written.size !== BigInt(bytes.length)
        || Number(written.mode & 0o777n) !== mode) {
      throw typedError('pm2_dump_restore_failed', 'restore temporary file is invalid');
    }
  } finally {
    await handle.close();
  }
  await assertDirectoryIdentity(parentIdentity, 'pm2_dump_parent_changed');
  await fsp.rename(temporary, dumpPath);
  await syncDirectory(parentIdentity, 'pm2_dump_restore_failed');
  await assertDirectoryIdentity(parentIdentity, 'pm2_dump_parent_changed');
}

async function createGuardedBackup({
  context,
  backupPath,
  bytes,
  beforeBackupOpen,
}) {
  if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath)
      || path.normalize(backupPath) !== backupPath
      || !Buffer.isBuffer(bytes)
      || (beforeBackupOpen !== null && beforeBackupOpen !== undefined
        && typeof beforeBackupOpen !== 'function')) {
    throw typedError('pm2_backup_invalid');
  }
  if (context) {
    await assertReceiptContextDirectoryIdentity(context);
    if (!isInsideOrEqual(context.receiptRunDir, backupPath)
        || backupPath === context.receiptRunDir) {
      throw typedError('pm2_backup_parent_invalid', 'backup escapes receipt run authority');
    }
  }
  const parentIdentity = await ensureCanonicalDirectoryTree(path.dirname(backupPath), {
    context,
    errorCode: 'pm2_backup_parent_invalid',
  });
  await beforeBackupOpen?.();
  await assertDirectoryIdentity(parentIdentity, 'pm2_backup_parent_changed');
  if (context) await assertReceiptContextDirectoryIdentity(context);
  const capability = await createOwnedFileCapability(
    backupPath,
    bytes,
    parentIdentity,
    {
      existsCode: 'pm2_backup_exists',
      invalidCode: 'pm2_backup_invalid',
    },
  );
  await assertDirectoryIdentity(parentIdentity, 'pm2_backup_parent_changed');
  if (context) await assertReceiptContextDirectoryIdentity(context);
  const readback = await readOwnedCapabilityExact(capability, 'pm2_backup_invalid');
  const binding = OWNED_FILE_CAPABILITIES.get(capability);
  return Object.freeze({
    capability,
    identity: binding.identity,
    parentIdentity,
    sha256: sha256Bytes(readback),
  });
}

export async function guardedPm2Save({
  dumpPath,
  allowChanged = [],
  expectedConfigured,
  ecosystemApps,
  ecosystemBaseDir = process.cwd(),
  backupPath,
  apply = false,
  restartBaselineRows = null,
  context = null,
  transaction = null,
  beforeBackupOpen = null,
  reloadEcosystemApps = null,
  acquireSaveLock = defaultAcquireSaveLock,
  listProcesses = defaultListProcesses,
  save = defaultSave,
  readDump = readDumpDocument,
  restoreDump = restoreDumpAtomic,
} = {}) {
  if (typeof dumpPath !== 'string' || !path.isAbsolute(dumpPath)
      || path.normalize(dumpPath) !== dumpPath
      || typeof backupPath !== 'string' || !path.isAbsolute(backupPath)
      || path.normalize(backupPath) !== backupPath
      || typeof apply !== 'boolean'
      || (beforeBackupOpen !== null && typeof beforeBackupOpen !== 'function')
      || (reloadEcosystemApps !== null && typeof reloadEcosystemApps !== 'function')
      || typeof acquireSaveLock !== 'function') {
    throw typedError('pm2_paths_invalid');
  }
  const mode = apply ? 'apply' : 'dry-run';
  let transactionBinding = transaction && typeof transaction === 'object'
    ? GUARDED_TRANSACTION_BINDINGS.get(transaction) || null
    : null;
  let transactionLease = null;
  let backup = null;
  let original = null;
  let result = null;
  let dumpParentIdentity = null;
  let saveInvoked = false;
  let saveLockRelease = null;
  try {
    if (apply && !transactionBinding) {
      throw typedError('pm2_receipt_transaction_required');
    }
    if (transaction !== null) {
      const claim = claimGuardedTransaction(transaction, {
        context,
        mode,
        dumpPath,
      });
      transactionBinding = claim.binding;
      transactionLease = claim.lease;
      if (!claim.matches) throw typedError('pm2_receipt_transaction_mismatch');
      await assertActiveGuardedTransaction(transactionBinding, transactionLease);
    } else if (context) {
      await assertReceiptContextDirectoryIdentity(context);
    }
    if (apply && typeof reloadEcosystemApps !== 'function') {
      throw typedError('pm2_ecosystem_reload_required');
    }
    const allow = new Set(allowChanged);
    assertApprovedAllowlist(allowChanged);
    const ecosystemIdentities = normalizeEcosystemTable(ecosystemApps, ecosystemBaseDir);
    assertExpectedConfiguredAuthority(expectedConfigured, ecosystemIdentities);
    dumpParentIdentity = await captureCanonicalDirectory(
      path.dirname(dumpPath),
      'pm2_dump_parent_changed',
    );
    if (apply) saveLockRelease = await acquireSaveLock(dumpPath);
    original = await readDump(dumpPath).catch((error) => {
      if (error.code === 'ENOENT') throw typedError('pm2_dump_missing');
      throw error;
    });
    await assertDirectoryIdentity(dumpParentIdentity, 'pm2_dump_parent_changed');
    backup = await createGuardedBackup({
      context,
      backupPath,
      bytes: original.bytes,
      beforeBackupOpen,
    });
    const liveRowsBefore = await listProcesses();
    const restartBaseline = restartBaselineRows === null
      ? []
      : assertRestartBaselineMonotonic(liveRowsBefore, restartBaselineRows, allow);
    const {
      processes: liveBefore,
      modules: liveModulesBefore,
    } = normalizePm2Partitions(liveRowsBefore, 'live PM2 table');
    const {
      processes: dumpBefore,
      modules: dumpModulesBefore,
    } = normalizePm2Partitions(original.document, 'dump PM2 table');
    assertDumpContainsNoModules(dumpModulesBefore);
    assertExpectedConfiguredPresent(liveBefore, expectedConfigured, 'live');
    const unrelatedRestartBaselines = comparePreSaveTables(
      liveBefore,
      dumpBefore,
      allow,
      ecosystemIdentities,
    );
    result = {
      ok: true,
      applied: false,
      mode,
      pm2SaveInvoked: false,
      dumpPath,
      backupPath,
      backupBasename: path.basename(backupPath),
      backupMode: '0600',
      backupCreatedExclusively: true,
      backupSha256: backup.sha256,
      backupIdentity: backup.identity,
      originalMode: original.mode.toString(8).padStart(4, '0'),
      originalSha256: sha256Bytes(original.bytes),
      originalIdentity: original.identity,
      allowChanged: [...allow].sort(),
      expectedConfigured: [...expectedConfigured].sort(),
      ecosystemIdentity: tableRows(ecosystemIdentities),
      liveTable: tableRows(liveBefore),
      liveModules: tableRows(liveModulesBefore),
      moduleRowsExcluded: true,
      moduleRowsFrozen: false,
      unrelatedRestartBaselineMonotonic: restartBaselineRows !== null,
      unrelatedRowsFrozen: false,
      restartBaseline,
      unrelatedRestartBaselines,
      dumpTableBefore: tableRows(dumpBefore),
      dumpTableAfter: null,
      restored: false,
      restorationVerified: false,
    };
    if (!apply) {
      const unchangedDump = await readDump(dumpPath);
      assertDumpSnapshotUnchanged(original, unchangedDump);
      const {
        processes: liveAfter,
        modules: liveModulesAfter,
      } = normalizePm2Partitions(await listProcesses(), 'post-dry-run live PM2 table');
      assertFrozenLive(liveBefore, liveAfter);
      assertFrozenModules(liveModulesBefore, liveModulesAfter);
      result.moduleRowsFrozen = true;
      result.unrelatedRowsFrozen = true;
      await readOwnedCapabilityExact(backup.capability, 'pm2_backup_invalid');
      if (transactionBinding) {
        const receipt = await publishGuardedTransaction(
          transactionBinding,
          transactionLease,
          result,
        );
        Object.defineProperty(result, 'publishedReceipt', {
          value: receipt,
          enumerable: false,
        });
      }
      return result;
    }
    await assertActiveGuardedTransaction(transactionBinding, transactionLease);
    const reloadedEcosystemIdentities = normalizeEcosystemTable(
      await reloadEcosystemApps(),
      ecosystemBaseDir,
    );
    assertExpectedConfiguredAuthority(expectedConfigured, reloadedEcosystemIdentities);
    assertFrozenEcosystemAuthority(ecosystemIdentities, reloadedEcosystemIdentities);
    const liveRowsImmediatelyBeforeSave = await listProcesses();
    const restartBaselineImmediatelyBeforeSave = restartBaselineRows === null
      ? []
      : assertRestartBaselineMonotonic(
          liveRowsImmediatelyBeforeSave,
          restartBaselineRows,
          allow,
        );
    const {
      processes: liveImmediatelyBeforeSave,
      modules: liveModulesImmediatelyBeforeSave,
    } = normalizePm2Partitions(
      liveRowsImmediatelyBeforeSave,
      'immediately pre-save live PM2 table',
    );
    assertExpectedConfiguredPresent(
      liveImmediatelyBeforeSave,
      expectedConfigured,
      'immediately-pre-save-live',
    );
    assertFrozenModules(liveModulesBefore, liveModulesImmediatelyBeforeSave);
    const unrelatedRestartBaselinesImmediatelyBeforeSave = comparePreSaveTables(
      liveImmediatelyBeforeSave,
      dumpBefore,
      allow,
      reloadedEcosystemIdentities,
    );
    result.ecosystemIdentity = tableRows(reloadedEcosystemIdentities);
    result.liveTable = tableRows(liveImmediatelyBeforeSave);
    result.liveModules = tableRows(liveModulesImmediatelyBeforeSave);
    result.restartBaseline = restartBaselineImmediatelyBeforeSave;
    result.unrelatedRestartBaselines = unrelatedRestartBaselinesImmediatelyBeforeSave;
    result.ecosystemAuthorityReloaded = true;
    result.immediatePreSaveTableRevalidated = true;
    let immediatelyBeforeSave;
    try {
      immediatelyBeforeSave = await readDump(dumpPath);
    } catch (cause) {
      throw typedError('pm2_dump_changed_before_save', 'dump.pm2 changed before save', { cause });
    }
    assertDumpSnapshotUnchanged(original, immediatelyBeforeSave);
    await assertDirectoryIdentity(dumpParentIdentity, 'pm2_dump_parent_changed');
    await readOwnedCapabilityExact(backup.capability, 'pm2_backup_invalid');
    await assertActiveGuardedTransaction(transactionBinding, transactionLease);
    saveInvoked = true;
    result.pm2SaveInvoked = true;
    await save();
    const {
      processes: liveAfter,
      modules: liveModulesAfter,
    } = normalizePm2Partitions(await listProcesses(), 'post-save live PM2 table');
    assertFrozenLive(liveImmediatelyBeforeSave, liveAfter);
    assertFrozenModules(liveModulesImmediatelyBeforeSave, liveModulesAfter);
    result.moduleRowsFrozen = true;
    result.unrelatedRowsFrozen = true;
    const post = await readDump(dumpPath);
    const {
      processes: dumpAfter,
      modules: dumpModulesAfter,
    } = normalizePm2Partitions(post.document, 'post-save dump PM2 table');
    assertDumpContainsNoModules(dumpModulesAfter);
    assertExpectedConfiguredPresent(dumpAfter, expectedConfigured, 'post-save-dump');
    assertDumpEqualsLive(liveImmediatelyBeforeSave, dumpAfter);
    result.applied = true;
    result.dumpTableAfter = tableRows(dumpAfter);
    result.dumpSha256After = sha256Bytes(post.bytes);
    await assertDirectoryIdentity(dumpParentIdentity, 'pm2_dump_parent_changed');
    await readOwnedCapabilityExact(backup.capability, 'pm2_backup_invalid');
    const receipt = await publishGuardedTransaction(transactionBinding, transactionLease, result);
    Object.defineProperty(result, 'publishedReceipt', {
      value: receipt,
      enumerable: false,
    });
    return result;
  } catch (error) {
    if (result && !error.pm2Save) error.pm2Save = result;
    if (saveInvoked && result && original && backup && dumpParentIdentity) {
      try {
        const restoreBytes = await readOwnedCapabilityExact(
          backup.capability,
          'pm2_backup_restore_source_invalid',
          { requireNamed: false, allowNameCtimeChange: true },
        );
        result.backupRestoreSourceVerified = true;
        result.backupRestoreSource = 'retained-exclusive-backup-file';
        await assertDirectoryIdentity(dumpParentIdentity, 'pm2_dump_parent_changed');
        await restoreDump(dumpPath, restoreBytes, original.mode, {
          parentIdentity: dumpParentIdentity,
        });
        result.restored = true;
        await assertDirectoryIdentity(dumpParentIdentity, 'pm2_dump_parent_changed');
        const restored = await readDump(dumpPath).catch((cause) => {
          throw typedError('pm2_dump_restore_failed', 'restored dump could not be read', { cause });
        });
        if (restored.mode !== original.mode
            || !Buffer.from(restored.bytes).equals(original.bytes)) {
          throw typedError('pm2_dump_restore_failed', 'restored dump bytes or mode mismatch', {
            cause: error,
          });
        }
        result.restorationVerified = true;
        result.applied = false;
      } catch (restoreError) {
        const failure = restoreError?.code === 'pm2_dump_restore_failed'
          ? restoreError
          : typedError('pm2_dump_restore_failed', 'dump restore failed', {
            cause: restoreError,
            originalFailure: error,
          });
        failure.pm2Save = result;
        error = failure;
      }
    }
    if (result) error.pm2Save = result;
    if (transactionBinding) {
      try {
        const failureReceipt = await failGuardedTransaction(
          transactionBinding,
          transactionLease,
          error,
        );
        if (failureReceipt) error.failureReceipt = failureReceipt;
      } catch (failureEvidenceError) {
        error.failureEvidenceError = failureEvidenceError;
      }
    }
    throw error;
  } finally {
    if (backup?.capability) await closeOwnedCapability(backup.capability).catch(() => {});
    await closeGuardedTransaction(transactionBinding, transactionLease);
    if (saveLockRelease) await saveLockRelease().catch(() => {});
  }
}

export function parseGuardedPm2Invocation(parsed) {
  const { values, positionals, command } = parsed || {};
  if (!values || typeof values !== 'object' || Array.isArray(values)
      || !Array.isArray(positionals) || (command !== null && !Array.isArray(command))) {
    throw typedError('pm2_cli_invalid');
  }
  if (Object.hasOwn(values, 'dry-run') || Object.hasOwn(values, 'apply')) {
    throw typedError('pm2_legacy_mode_flag_refused', 'use exactly --mode dry-run or --mode apply');
  }
  const unknown = Object.keys(values).filter((key) => !GUARDED_PM2_CLI_KEYS.has(key));
  if (unknown.length > 0 || positionals.length > 0 || command !== null) {
    throw typedError('pm2_cli_invalid', `unsupported guarded PM2 arguments: ${unknown.join(',')}`);
  }
  const mode = String(one(values, 'mode', { required: true }));
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw typedError('pm2_mode_invalid', '--mode must be exactly dry-run or apply');
  }
  const outputPath = one(values, 'output', { required: true });
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)
      || path.normalize(outputPath) !== outputPath) {
    throw typedError('output_path_invalid', '--output must be a normalized absolute path');
  }
  return Object.freeze({ mode, apply: mode === 'apply', outputPath });
}

async function loadRestartBaseline(file, context) {
  const resolved = path.resolve(file);
  if (!isInsideOrEqual(context.receiptRunDir, resolved) || resolved === context.receiptRunDir) {
    throw typedError('pm2_restart_baseline_invalid',
      'restart baseline must be beneath the receipt run directory');
  }
  await assertReceiptContextDirectoryIdentity(context);
  let canonical;
  let rows;
  try {
    canonical = await fsp.realpath(resolved);
    if (canonical !== resolved || !isInsideOrEqual(context.receiptRunDir, canonical)) {
      throw typedError('pm2_restart_baseline_invalid', 'restart baseline must be canonical');
    }
    rows = await readJson(canonical, { maxBytes: PM2_DUMP_MAX_BYTES });
  } catch (error) {
    if (error?.code === 'pm2_restart_baseline_invalid') throw error;
    throw typedError('pm2_restart_baseline_invalid', 'restart baseline is unavailable or malformed', {
      cause: error,
    });
  }
  await assertReceiptContextDirectoryIdentity(context);
  // Full structural/cardinality validation and monotonic comparison happen
  // against the immediately captured live table inside guardedPm2Save().
  restartCountsByName(rows, 'delayed PM2 restart baseline');
  return rows;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseCli(argv);
  const { values } = parsed;
  const invocation = parseGuardedPm2Invocation(parsed);
  const context = await receiptContext(values, env);
  const dumpPath = path.resolve(one(values, 'dump', { required: true }));
  const ecosystemPath = path.resolve(one(values, 'ecosystem', { required: true }));
  const allowChanged = String(one(values, 'allow-changed', { required: true }))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const expectedConfigured = String(one(values, 'expected-configured', { required: true }))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const ecosystemApps = loadEcosystemApps(ecosystemPath);
  const restartBaselineRows = await loadRestartBaseline(
    path.resolve(one(values, 'restart-baseline', { required: true })),
    context,
  );
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: invocation.outputPath,
    mode: invocation.mode,
    dumpPath,
  });
  const backupName = `pm2-dump-backup-${invocation.mode}`
    + `-${sha256Bytes(Buffer.from(`${context.receiptRunId}:${dumpPath}`)).slice(0, 16)}`
    + `-${randomUUID()}.pm2`;
  const backupPath = path.join(context.receiptRunDir, 'backups', backupName);
  const result = await guardedPm2Save({
    context,
    transaction,
    dumpPath,
    allowChanged,
    expectedConfigured,
    ecosystemApps,
    ecosystemBaseDir: path.dirname(ecosystemPath),
    reloadEcosystemApps: async () => loadEcosystemApps(ecosystemPath),
    backupPath,
    apply: invocation.apply,
    restartBaselineRows,
  });
  return result.publishedReceipt;
}

if (isMain(import.meta.url)) main().catch(failCli);
