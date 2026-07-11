import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const AUTHORITY = new Set(['live', 'isolated-controlled']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

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

export async function canonicalDirectory(input, label, { create = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.normalize(input) !== input) {
    throw typedError('path_invalid', `${label} must be a normalized absolute path`);
  }
  if (create) await fsp.mkdir(input, { recursive: true, mode: 0o700 });
  const before = await fsp.lstat(input, { bigint: true }).catch((error) => {
    throw typedError('path_unavailable', `${label} is unavailable`, { cause: error });
  });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw typedError('path_invalid', `${label} must be a nonsymlink directory`);
  }
  const canonical = await fsp.realpath(input);
  if (canonical !== input) throw typedError('path_invalid', `${label} must already be canonical`);
  const after = await fsp.lstat(input, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory()) {
    throw typedError('path_changed', `${label} changed during validation`);
  }
  return Object.freeze({ path: canonical, dev: before.dev.toString(), ino: before.ino.toString() });
}

function matchingAuthorityValue(cliValue, envValue, label) {
  if (Array.isArray(cliValue)) throw typedError('duplicate_argument', `duplicate --${label}`);
  if (cliValue !== undefined && envValue !== undefined && String(cliValue) !== String(envValue)) {
    throw typedError('receipt_authority_conflict', `${label} conflicts with environment`);
  }
  return cliValue !== undefined ? String(cliValue) : envValue;
}

export async function implementationCommit(cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return /^[a-f0-9]{40,64}$/.test(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
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
  const runDirectory = await canonicalDirectory(path.resolve(runDirInput), 'receipt run directory');
  const startedAt = options.startedAt || new Date().toISOString();
  return Object.freeze({
    receiptRunDir: runDirectory.path,
    receiptRunId: runId,
    authority,
    implementationCommit: options.implementationCommit || await implementationCommit(options.cwd),
    hostname: os.hostname(),
    startedAt,
  });
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalReceiptRow(context, payload, completedAt = new Date().toISOString()) {
  const { artifactSha256: _discardedArtifactHash, ...safePayload } = payload;
  const core = {
    ...safePayload,
    receiptRunId: context.receiptRunId,
    authority: context.authority,
    implementationCommit: context.implementationCommit,
    hostname: context.hostname,
    startedAt: payload.startedAt || context.startedAt,
    completedAt: payload.completedAt || completedAt,
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

async function assertOutputParent(context, output) {
  const parent = path.dirname(output);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await fsp.realpath(parent);
  if (!isInsideOrEqual(context.receiptRunDir, canonicalParent)) {
    throw typedError('output_path_invalid', 'output parent escapes receipt run directory');
  }
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

export async function writeJsonReceipt(context, output, payload) {
  const target = assertOutputPath(context, output);
  await assertOutputParent(context, target);
  const row = canonicalReceiptRow(context, payload);
  const encoded = `${JSON.stringify(row, null, 2)}\n`;
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await publishCreateNew(temporary, target);
  return row;
}

export async function appendJsonlReceipt(context, output, payload) {
  const target = assertOutputPath(context, output);
  await assertOutputParent(context, target);
  const row = canonicalReceiptRow(context, payload);
  let handle;
  try {
    const ownershipKey = `${context.receiptRunId}\0${context.authority}\0${target}`;
    const owned = ownedJsonlOutputs.get(ownershipKey);
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW
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
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw typedError('output_path_invalid', 'receipt output must be one regular nonsymlink file');
    }
    const canonicalTarget = await fsp.realpath(target);
    if (!isInsideOrEqual(context.receiptRunDir, canonicalTarget)) {
      throw typedError('output_path_invalid', 'receipt output escapes the run directory');
    }
    if (owned && (owned.dev !== stat.dev.toString() || owned.ino !== stat.ino.toString())) {
      throw typedError('receipt_output_changed', 'receipt output identity changed');
    }
    if (!owned) {
      ownedJsonlOutputs.set(ownershipKey, {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
      });
    }
    await handle.writeFile(`${JSON.stringify(row)}\n`);
    await handle.sync();
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      throw typedError('output_path_invalid', 'receipt output must not be a symlink', { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
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
  const handle = await fsp.open(file, 'r');
  const hash = createHash('sha256');
  let offset = 0;
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  try {
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

export async function readJson(file, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw typedError('json_file_invalid', `invalid JSON file: ${file}`);
  }
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export function isMain(importMetaUrl, argv = process.argv) {
  return argv[1] && path.resolve(argv[1]) === path.resolve(fileURLToPath(importMetaUrl));
}

export function failCli(error) {
  const code = error?.code || 'acceptance_helper_failed';
  const message = error?.message || String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exitCode = 1;
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

export { fs, fsp, path, execFile };
