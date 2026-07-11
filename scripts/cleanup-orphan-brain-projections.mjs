#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const CANDIDATE_RE = new RegExp(`^dashboard-source-${UUID_PATTERN}$`);
const ATTEMPT_RE = new RegExp(`^\\.attempt-(\\d+)-${UUID_PATTERN}$`);
const OVERLAY_RE = new RegExp(`^\\.memory-overlay-(\\d+)-${UUID_PATTERN}$`);
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CAPTURE_ENTRIES = 1_000_000;
const MAX_CAPTURED_MANIFEST_BYTES = 64 * 1024 * 1024;
export const CLEANUP_RECEIPT_MAX_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 1024 * 1024;
const PM2_PORT_KEYS = Object.freeze(['REALTIME_PORT', 'DASHBOARD_PORT', 'MCP_HTTP_PORT']);

function cleanupError(code, message = code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function manifestDigest(manifest) {
  return sha256Bytes(Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8'));
}

function identityOf(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: Number(stat.mode & 0o777n),
  });
}

function entryIdentity(stat) {
  return Object.freeze({
    ...identityOf(stat),
    nlink: String(stat.nlink),
    size: String(stat.size),
    blocks: String(stat.blocks ?? 0n),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameAuthority(stat, identity) {
  return Boolean(stat && identity
    && String(stat.dev) === identity.dev
    && String(stat.ino) === identity.ino
    && String(stat.uid) === identity.uid
    && Number(stat.mode & 0o777n) === identity.mode);
}

function sameEntryIdentity(stat, identity) {
  return sameAuthority(stat, identity)
    && String(stat.nlink) === identity.nlink
    && String(stat.size) === identity.size
    && String(stat.blocks ?? 0n) === identity.blocks
    && String(stat.mtimeNs) === identity.mtimeNs
    && String(stat.ctimeNs) === identity.ctimeNs;
}

function sameRenamedRegularIdentity(stat, identity) {
  return sameAuthority(stat, identity)
    && String(stat.nlink) === identity.nlink
    && String(stat.size) === identity.size
    && String(stat.blocks ?? 0n) === identity.blocks
    && String(stat.mtimeNs) === identity.mtimeNs;
}

function entryType(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'regular';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isBlockDevice()) return 'block-device';
  return 'special';
}

async function lstatBig(filePath) {
  return fsp.lstat(filePath, { bigint: true });
}

async function lstatOptional(filePath) {
  return lstatBig(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertCanonicalDirectory(directory, {
  label,
  requiredUid = process.geteuid?.() ?? process.getuid(),
  requiredMode,
  expected,
} = {}) {
  const normalized = path.resolve(directory);
  const before = await lstatBig(normalized).catch((error) => {
    throw cleanupError('cleanup_authority_unavailable', `${label || normalized} is unavailable`, {
      cause: error,
    });
  });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw cleanupError('cleanup_authority_invalid', `${label || normalized} is not an exact directory`);
  }
  const real = await fsp.realpath(normalized);
  if (real !== normalized) {
    throw cleanupError('cleanup_authority_invalid', `${label || normalized} is not canonical`);
  }
  if (String(before.uid) !== String(requiredUid)) {
    throw cleanupError('cleanup_uid_mismatch', `${label || normalized} has the wrong owner`);
  }
  const mode = Number(before.mode & 0o777n);
  if (requiredMode !== undefined && mode !== requiredMode) {
    throw cleanupError('cleanup_mode_mismatch', `${label || normalized} has mode ${mode.toString(8)}`);
  }
  if ((mode & 0o022) !== 0) {
    throw cleanupError('cleanup_mode_mismatch', `${label || normalized} is group/world writable`);
  }
  if (expected && !sameAuthority(before, expected)) {
    throw cleanupError('cleanup_authority_changed', `${label || normalized} identity changed`);
  }
  return Object.freeze({ path: normalized, identity: identityOf(before) });
}

async function hashOpenedRegular(filePath, before, { captureBytes = false } = {}) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(filePath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameEntryIdentity(opened, entryIdentity(before))) {
      throw cleanupError('cleanup_entry_changed', `${filePath} changed while opening`);
    }
    const hash = crypto.createHash('sha256');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let capturedBytes = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (captureBytes) {
        capturedBytes += bytesRead;
        if (capturedBytes > MAX_METADATA_BYTES) {
          throw cleanupError('malformed_metadata', `${filePath} metadata is too large`);
        }
        chunks.push(Buffer.from(chunk));
      }
      position += bytesRead;
    }
    const finalOpened = await handle.stat({ bigint: true });
    const namedAfter = await lstatBig(filePath);
    if (!sameEntryIdentity(finalOpened, entryIdentity(before))
        || !sameEntryIdentity(namedAfter, entryIdentity(before))
        || !finalOpened.isFile() || !namedAfter.isFile() || namedAfter.isSymbolicLink()) {
      throw cleanupError('cleanup_entry_changed', `${filePath} changed while hashing`);
    }
    return {
      sha256: hash.digest('hex'),
      bytes: captureBytes ? Buffer.concat(chunks) : null,
    };
  } finally {
    await handle.close();
  }
}

function metadataName(name, relativePath) {
  return relativePath === '.scratch-quota.json'
    || (path.dirname(relativePath) === '.'
      && (name === '.scratch-quota.lock' || name.startsWith('.scratch-quota.lock.candidate-')));
}

async function captureTree(root, {
  strict = false,
  expectedRootIdentity,
  requiredUid = process.geteuid?.() ?? process.getuid(),
  label = root,
} = {}) {
  const normalizedRoot = path.resolve(root);
  const rootStat = await lstatBig(normalizedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw cleanupError(strict ? 'symlink_rejected' : 'cleanup_boundary_invalid',
      `${label} root is not an exact directory`);
  }
  if (expectedRootIdentity && !sameAuthority(rootStat, expectedRootIdentity)) {
    throw cleanupError('cleanup_authority_changed', `${label} root identity changed`);
  }
  if (String(rootStat.uid) !== String(requiredUid)) {
    throw cleanupError('uid_mismatch', `${label} root owner changed`);
  }
  if (strict && Number(rootStat.mode & 0o777n) !== 0o700) {
    throw cleanupError('mode_mismatch', `${label} root mode is not 0700`);
  }
  const rootReal = await fsp.realpath(normalizedRoot);
  if (rootReal !== normalizedRoot) {
    throw cleanupError(strict ? 'symlink_rejected' : 'cleanup_boundary_invalid',
      `${label} root is not canonical`);
  }
  const rootDevice = String(rootStat.dev);
  const entries = [];
  const metadata = new Map();
  let count = 0;
  let logicalBytes = 0n;
  let allocatedBytes = 0n;

  async function walk(absolute, relative) {
    count += 1;
    if (count > MAX_CAPTURE_ENTRIES) {
      throw cleanupError('cleanup_manifest_too_large', `${label} has too many entries`);
    }
    const stat = await lstatBig(absolute);
    allocatedBytes += (stat.blocks ?? 0n) * 512n;
    const type = entryType(stat);
    if (String(stat.uid) !== String(requiredUid)) {
      throw cleanupError('uid_mismatch', `${absolute} has the wrong owner`);
    }
    if (String(stat.dev) !== rootDevice) {
      throw cleanupError(strict ? 'device_crossing_rejected' : 'cleanup_boundary_device_crossing',
        `${absolute} crosses a filesystem device`);
    }
    if (strict && type !== 'directory' && type !== 'regular') {
      throw cleanupError(type === 'symlink' ? 'symlink_rejected' : 'special_file_rejected',
        `${absolute} is ${type}`);
    }
    if (strict && type === 'regular' && stat.nlink !== 1n) {
      throw cleanupError('hardlink_rejected', `${absolute} has multiple links`);
    }
    if (strict && (Number(stat.mode & 0o777n) & 0o022) !== 0) {
      throw cleanupError('mode_mismatch', `${absolute} is group/world writable`);
    }
    const record = {
      relativePath: relative,
      type,
      identity: entryIdentity(stat),
    };
    if (type === 'regular') {
      logicalBytes += stat.size;
      const captureBytes = metadataName(path.basename(absolute), relative);
      const hashed = await hashOpenedRegular(absolute, stat, { captureBytes });
      record.sha256 = hashed.sha256;
      if (captureBytes) metadata.set(relative, hashed.bytes);
    } else if (type === 'symlink') {
      const target = await fsp.readlink(absolute);
      record.linkTargetSha256 = sha256Bytes(Buffer.from(target, 'utf8'));
      const after = await lstatBig(absolute);
      if (!sameEntryIdentity(after, record.identity)) {
        throw cleanupError('cleanup_entry_changed', `${absolute} changed while reading link`);
      }
    } else if (type === 'directory') {
      const names = (await fsp.readdir(absolute)).sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        await walk(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
      const after = await lstatBig(absolute);
      if (!sameEntryIdentity(after, entryIdentity(stat))
          || !after.isDirectory() || after.isSymbolicLink()) {
        throw cleanupError('cleanup_entry_changed', `${absolute} changed while walking`);
      }
    }
    entries.push(record);
  }

  await walk(normalizedRoot, '');
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const digestEntries = entries.map((entry) => {
    if (entry.relativePath !== '') return entry;
    // A same-parent quarantine rename can update the root directory's ctime
    // without changing its inode, ownership, mode, children, or file bytes.
    // Keep the times in the manifest for preflight drift detection, but omit
    // only those two rename-volatile root fields from the removal digest.
    const { mtimeNs: _mtimeNs, ctimeNs: _ctimeNs, ...stableIdentity } = entry.identity;
    return { ...entry, identity: stableIdentity };
  });
  const snapshot = Object.freeze({
    identity: identityOf(rootStat),
    entryCount: entries.length,
    logicalBytes: String(logicalBytes),
    allocatedBytes: String(allocatedBytes),
    entries,
    treeSha256: sha256Bytes(Buffer.from(`${canonicalJson(digestEntries)}\n`, 'utf8')),
  });
  return { snapshot, metadata };
}

function sumCandidateBytes(candidates) {
  let logicalBytes = 0n;
  let allocatedBytes = 0n;
  for (const candidate of candidates) {
    logicalBytes += BigInt(candidate.logicalBytes);
    allocatedBytes += BigInt(candidate.allocatedBytes);
  }
  return Object.freeze({
    count: candidates.length,
    logicalBytes: String(logicalBytes),
    allocatedBytes: String(allocatedBytes),
  });
}

function normalizeFilesystemStats(value) {
  const fields = ['blockSize', 'blocks', 'freeBlocks', 'availableBlocks', 'availableBytes'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || fields.some((field) => typeof value[field] !== 'string' || !/^\d+$/.test(value[field]))) {
    throw cleanupError('cleanup_statfs_invalid', 'filesystem statistics are unavailable or malformed');
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, value[field]])));
}

async function defaultFilesystemStats(root) {
  const stats = await fsp.statfs(root, { bigint: true });
  const blockSize = stats.bsize;
  const availableBlocks = stats.bavail;
  return normalizeFilesystemStats({
    blockSize: String(blockSize),
    blocks: String(stats.blocks),
    freeBlocks: String(stats.bfree),
    availableBlocks: String(availableBlocks),
    availableBytes: String(blockSize * availableBlocks),
  });
}

function parseJsonMetadata(bytes, filePath) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_METADATA_BYTES) {
    throw cleanupError('malformed_metadata', `${filePath} metadata is empty or oversized`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw cleanupError('malformed_metadata', `${filePath} metadata is malformed`, { cause: error });
  }
}

function validateOwner(owner, { handleId } = {}) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isSafeInteger(owner.processStartedAt) || owner.processStartedAt < 0
      || typeof owner.bootToken !== 'string' || !owner.bootToken
      || typeof owner.processStartToken !== 'string' || !owner.processStartToken
      || typeof owner.handleId !== 'string'
      || !/^[a-f0-9-]{36}$/.test(owner.handleId)
      || (handleId !== undefined && owner.handleId !== handleId)) {
    throw cleanupError('malformed_metadata', 'scratch owner metadata is invalid');
  }
  return Object.freeze({
    pid: owner.pid,
    processStartedAt: owner.processStartedAt,
    handleId: owner.handleId,
    bootToken: owner.bootToken,
    processStartToken: owner.processStartToken,
  });
}

function ownersFromMetadata(candidatePath, tree) {
  const owners = [];
  const ledgerBytes = tree.metadata.get('.scratch-quota.json');
  if (!ledgerBytes) throw cleanupError('malformed_metadata', 'scratch quota ledger is missing');
  const ledger = parseJsonMetadata(ledgerBytes, path.join(candidatePath, '.scratch-quota.json'));
  if (ledger?.version !== 1 || ledger.operationRoot !== candidatePath
      || !Number.isSafeInteger(ledger.maxBytes) || ledger.maxBytes <= 0
      || !Number.isSafeInteger(ledger.actualPrivateBytes) || ledger.actualPrivateBytes < 0
      || !Number.isSafeInteger(ledger.claimedSinceReconcile ?? 0)
      || (ledger.claimedSinceReconcile ?? 0) < 0
      || !Number.isSafeInteger(ledger.usedBytes) || ledger.usedBytes < 0
      || !Number.isSafeInteger(ledger.updatedAt) || ledger.updatedAt < 0
      || !ledger.reservations || typeof ledger.reservations !== 'object'
      || Array.isArray(ledger.reservations)) {
    if (ledger?.operationRoot !== candidatePath) {
      throw cleanupError('external_operation_root', 'scratch ledger points outside the candidate');
    }
    throw cleanupError('malformed_metadata', 'scratch quota ledger identity is invalid');
  }
  for (const [handleId, reservation] of Object.entries(ledger.reservations)) {
    if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)
        || !reservation.kinds || typeof reservation.kinds !== 'object'
        || Array.isArray(reservation.kinds)
        || Object.keys(reservation.kinds).some((kind) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(kind))
        || Object.values(reservation.kinds).some((bytes) => !Number.isSafeInteger(bytes) || bytes <= 0)) {
      throw cleanupError('malformed_metadata', 'scratch reservation metadata is invalid');
    }
    owners.push({ kind: 'exact', source: `.scratch-quota.json:${handleId}`,
      owner: validateOwner(reservation.owner, { handleId }) });
  }
  for (const [relative, bytes] of tree.metadata) {
    if (relative === '.scratch-quota.json') continue;
    const record = parseJsonMetadata(bytes, path.join(candidatePath, relative));
    if (record?.version !== 1 || record.operationRoot !== candidatePath || !record.owner
        || !Number.isSafeInteger(record.maxBytes) || record.maxBytes <= 0
        || !Number.isSafeInteger(record.acquiredAt) || record.acquiredAt < 0) {
      if (record?.operationRoot !== candidatePath) {
        throw cleanupError('external_operation_root', `${relative} points outside the candidate`);
      }
      throw cleanupError('malformed_metadata', `${relative} lock metadata is invalid`);
    }
    owners.push({ kind: 'exact', source: relative, owner: validateOwner(record.owner) });
  }
  for (const entry of tree.snapshot.entries) {
    const name = path.posix.basename(entry.relativePath);
    for (const [prefix, pattern] of [['.attempt-', ATTEMPT_RE], ['.memory-overlay-', OVERLAY_RE]]) {
      if (!name.startsWith(prefix)) continue;
      const match = pattern.exec(name);
      if (!match) throw cleanupError('malformed_metadata', `${name} has no trustworthy owner PID`);
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw cleanupError('malformed_metadata', `${name} has an invalid owner PID`);
      }
      owners.push({ kind: 'pid', source: entry.relativePath, pid });
    }
  }
  if (owners.length === 0) {
    throw cleanupError('unknown_owner', 'candidate contains no verifiable owner metadata');
  }
  const deduped = new Map();
  for (const entry of owners) {
    const key = entry.kind === 'exact'
      ? `exact:${canonicalJson(entry.owner)}`
      : `pid:${entry.pid}`;
    const prior = deduped.get(key);
    if (prior) prior.sources.push(entry.source);
    else deduped.set(key, entry.kind === 'exact'
      ? { kind: entry.kind, owner: entry.owner, sources: [entry.source] }
      : { kind: entry.kind, pid: entry.pid, sources: [entry.source] });
  }
  return [...deduped.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizeOwnerInspection(result) {
  if (result === false || result === 'absent' || result === 'reused') return 'absent';
  if (result === true || result === 'alive') return 'alive';
  return 'unknown';
}

async function inspectOwners(owners, { inspectProcessOwner, inspectPid }) {
  const results = [];
  for (const entry of owners) {
    const raw = entry.kind === 'exact'
      ? await inspectProcessOwner(entry.owner)
      : await inspectPid(entry.pid);
    results.push(Object.freeze({
      ...entry,
      status: normalizeOwnerInspection(raw),
    }));
  }
  return results;
}

function normalizeOpenFdInspection(result) {
  if (result === true || result === 'clear') return { status: 'clear', open: [] };
  if (result === false || result === 'open') return { status: 'open', open: [] };
  if (!result || typeof result !== 'object' || !['clear', 'open', 'unknown'].includes(result.status)
      || !Array.isArray(result.open)) {
    return { status: 'unknown', open: [] };
  }
  return { status: result.status, open: result.open };
}

function normalizePorts(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
      || value.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535)) {
    throw cleanupError('cleanup_ports_invalid', `${label} must contain explicit TCP ports`);
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

async function assertListenerGate({ ports, protectedPorts, inspectListeners, inspectListenerProcess }) {
  const inspectedPorts = [...new Set([...ports, ...protectedPorts])]
    .sort((left, right) => left - right);
  const inspected = await inspectListeners({ ports: inspectedPorts, monitoredPorts: ports, protectedPorts });
  if (!Array.isArray(inspected)) {
    throw cleanupError('cleanup_listener_status_unknown', 'listener checker returned no inventory');
  }
  const monitored = new Set(ports);
  const protectedSet = new Set(protectedPorts);
  const listeners = [];
  for (const entry of inspected) {
    const port = Number(entry?.port);
    const pid = Number(entry?.pid);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535
        || !Number.isSafeInteger(pid) || pid < 1 || typeof entry?.command !== 'string') {
      throw cleanupError('cleanup_listener_status_unknown', 'listener inventory is malformed');
    }
    if (!monitored.has(port) && !protectedSet.has(port)) {
      throw cleanupError('cleanup_listener_status_unknown', `unexpected listener inventory port ${port}`);
    }
    let processIdentity;
    if (protectedSet.has(port)) {
      const inspectedIdentity = await inspectListenerProcess(pid);
      if (!inspectedIdentity || typeof inspectedIdentity !== 'object'
          || typeof inspectedIdentity.bootToken !== 'string' || !inspectedIdentity.bootToken
          || Buffer.byteLength(inspectedIdentity.bootToken, 'utf8') > 512
          || typeof inspectedIdentity.processStartToken !== 'string'
          || !inspectedIdentity.processStartToken
          || Buffer.byteLength(inspectedIdentity.processStartToken, 'utf8') > 512) {
        throw cleanupError('cleanup_listener_status_unknown',
          `protected listener ${port}/${pid} has no exact process identity`);
      }
      processIdentity = Object.freeze({
        bootToken: inspectedIdentity.bootToken,
        processStartToken: inspectedIdentity.processStartToken,
      });
    }
    listeners.push(Object.freeze({
      port, pid, command: entry.command, ...(processIdentity ? { processIdentity } : {}),
    }));
  }
  listeners.sort((left, right) => left.port - right.port || left.pid - right.pid
    || left.command.localeCompare(right.command));
  const unaccounted = listeners.filter((entry) => monitored.has(entry.port)
    && !protectedSet.has(entry.port));
  if (unaccounted.length > 0) {
    throw cleanupError('cleanup_unaccounted_listener',
      `unaccounted listeners remain on ports ${[...new Set(unaccounted.map((entry) => entry.port))].join(',')}`,
      { listeners: unaccounted });
  }
  return listeners;
}

function exactPm2Table(rows, agents) {
  if (!Array.isArray(rows)) throw cleanupError('cleanup_pm2_invalid', 'PM2 checker returned no table');
  const table = new Map();
  for (const row of rows) {
    if (!row || typeof row.name !== 'string') continue;
    if (table.has(row.name)) throw cleanupError('cleanup_pm2_invalid', `duplicate PM2 row ${row.name}`);
    table.set(row.name, row);
  }
  const receipt = [];
  const portBindings = [];
  const requiredNames = agents.flatMap((agent) => [
    `home23-${agent}`,
    `home23-${agent}-dash`,
  ]).sort((left, right) => left.localeCompare(right));
  for (const name of requiredNames) {
    const row = table.get(name);
    const declaredPids = [row?.pid, row?.pm2_env?.pm_pid, row?.pm2_env?.pid]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map(Number);
    const pid = declaredPids.length === 0 ? 0 : Math.max(...declaredPids);
    const status = row?.status ?? row?.pm2_env?.status;
    if (!row || status !== 'stopped'
        || declaredPids.some((value) => !Number.isSafeInteger(value) || value !== 0)) {
      throw cleanupError('cleanup_pm2_not_stopped', `${name} must exist with status stopped and no PID`);
    }
    const ports = {};
    for (const key of PM2_PORT_KEYS) {
      const rawValues = [row?.env?.[key], row?.pm2_env?.env?.[key], row?.pm2_env?.[key]]
        .filter((value) => value !== undefined && value !== null && value !== '')
        .map((value) => String(value));
      if (rawValues.length === 0 || new Set(rawValues).size !== 1 || !/^\d{1,5}$/.test(rawValues[0])) {
        throw cleanupError('cleanup_pm2_port_authority_invalid', `${name} has no exact ${key}`);
      }
      const port = Number(rawValues[0]);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw cleanupError('cleanup_pm2_port_authority_invalid', `${name} has invalid ${key}`);
      }
      ports[key] = port;
    }
    receipt.push(Object.freeze({ name, status, pid, ports: Object.freeze(ports) }));
  }
  for (const agent of agents) {
    const engine = receipt.find((entry) => entry.name === `home23-${agent}`);
    const dashboard = receipt.find((entry) => entry.name === `home23-${agent}-dash`);
    if (canonicalJson(engine.ports) !== canonicalJson(dashboard.ports)) {
      throw cleanupError('cleanup_pm2_port_authority_invalid', `${agent} PM2 port authority disagrees`);
    }
    portBindings.push(Object.freeze({ agent, ports: engine.ports }));
  }
  const monitoredPorts = [...new Set(portBindings.flatMap((entry) => Object.values(entry.ports)))]
    .sort((left, right) => left - right);
  return Object.freeze({ rows: receipt, portBindings, monitoredPorts });
}

function assertPortAuthority(pm2, ports, protectedPorts) {
  if (canonicalJson(pm2.monitoredPorts) !== canonicalJson(ports)) {
    throw cleanupError('cleanup_ports_authority_mismatch',
      'explicit monitored ports do not equal the stopped PM2 environment union');
  }
  if (protectedPorts.some((port) => ports.includes(port))) {
    throw cleanupError('cleanup_protected_port_overlap',
      'protected listener ports must be disjoint from monitored Home23 ports');
  }
}

function requestedAgents(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw cleanupError('cleanup_agent_required', 'one or more explicit agents are required');
  }
  if (value.some((agent) => typeof agent !== 'string'
      || Buffer.byteLength(agent, 'utf8') > 128
      || !/^[A-Za-z0-9_.-]+$/.test(agent) || agent === '.' || agent === '..')) {
    throw cleanupError('cleanup_agent_not_authorized', 'agents must be safe path segments');
  }
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

function validateApprovalRecord({ approvalActor, approvalText, approvalAt }) {
  if (typeof approvalActor !== 'string' || approvalActor.length === 0
      || Buffer.byteLength(approvalActor, 'utf8') > 256 || /[\0\r\n]/.test(approvalActor)
      || typeof approvalText !== 'string' || approvalText.trim().length === 0
      || Buffer.byteLength(approvalText, 'utf8') > 4096 || approvalText.includes('\0')
      || typeof approvalAt !== 'string' || Number.isNaN(Date.parse(approvalAt))) {
    throw cleanupError('cleanup_approval_record_invalid',
      'explicit bounded approval actor, text, and timestamp are required');
  }
  return Object.freeze({ actor: approvalActor, text: approvalText, approvedAt: approvalAt });
}

async function establishHomeAuthority(homeRoot) {
  if (typeof homeRoot !== 'string' || !path.isAbsolute(homeRoot)) {
    throw cleanupError('cleanup_home_root_not_authorized', 'an absolute home root is required');
  }
  const normalized = path.resolve(homeRoot);
  const real = await fsp.realpath(normalized).catch((error) => {
    throw cleanupError('cleanup_home_root_not_authorized', 'home root is unavailable', { cause: error });
  });
  if (real !== normalized) {
    throw cleanupError('cleanup_home_root_not_canonical', 'home root must be its exact canonical path');
  }
  return assertCanonicalDirectory(normalized, { label: 'Home23 root' });
}

function exclusionReason(error) {
  const accepted = new Set([
    'device_crossing_rejected', 'external_operation_root', 'hardlink_rejected',
    'malformed_metadata', 'mode_mismatch', 'special_file_rejected', 'symlink_rejected',
    'uid_mismatch', 'unknown_owner',
  ]);
  return accepted.has(error?.code) ? error.code : 'unsafe_candidate';
}

async function captureBoundary(pathname, label) {
  const tree = await captureTree(pathname, { strict: false, label });
  return Object.freeze({
    path: pathname,
    identity: tree.snapshot.identity,
    treeSha256: tree.snapshot.treeSha256,
    entryCount: tree.snapshot.entryCount,
    tree: tree.snapshot,
  });
}

async function captureAgentManifest({
  homeRoot,
  agent,
  inspectProcessOwner,
  inspectPid,
  checkOpenFileDescriptors,
}) {
  const brainPath = path.join(homeRoot, 'instances', agent, 'brain');
  const operationsRoot = path.join(homeRoot, 'instances', agent, 'runtime', 'brain-operations');
  const brainAuthority = await assertCanonicalDirectory(brainPath, { label: `${agent} brain` });
  const operationsAuthority = await assertCanonicalDirectory(operationsRoot, {
    label: `${agent} brain operations`,
  });
  const brain = await captureBoundary(brainPath, `${agent} brain`);
  const beforeNames = (await fsp.readdir(operationsRoot)).sort((left, right) => left.localeCompare(right));
  const eligible = [];
  const excluded = [];
  const nonselectedNames = new Set(beforeNames.filter((name) => !CANDIDATE_RE.test(name)));

  for (const name of beforeNames.filter((entry) => CANDIDATE_RE.test(entry))) {
    const candidatePath = path.join(operationsRoot, name);
    let tree;
    try {
      tree = await captureTree(candidatePath, { strict: true, label: `${agent}/${name}` });
      const owners = ownersFromMetadata(candidatePath, tree);
      const ownerChecks = await inspectOwners(owners, { inspectProcessOwner, inspectPid });
      const reasons = [];
      if (ownerChecks.some((entry) => entry.status === 'alive')) reasons.push('owner_alive');
      if (ownerChecks.some((entry) => entry.status === 'unknown')) reasons.push('owner_unknown');
      const openFds = normalizeOpenFdInspection(await checkOpenFileDescriptors({
        agent,
        path: candidatePath,
        identity: tree.snapshot.identity,
      }));
      if (openFds.status === 'open') reasons.push('open_file_descriptors');
      if (openFds.status === 'unknown') reasons.push('open_fd_status_unknown');
      const candidate = Object.freeze({
        agent,
        name,
        path: candidatePath,
        identity: tree.snapshot.identity,
        treeSha256: tree.snapshot.treeSha256,
        entryCount: tree.snapshot.entryCount,
        logicalBytes: tree.snapshot.logicalBytes,
        allocatedBytes: tree.snapshot.allocatedBytes,
        tree: tree.snapshot,
        owners,
        ownerChecks,
        openFileDescriptors: openFds,
      });
      if (reasons.length === 0) eligible.push(candidate);
      else {
        excluded.push(Object.freeze({ ...candidate, reasons: [...new Set(reasons)].sort() }));
        nonselectedNames.add(name);
      }
    } catch (error) {
      const reason = exclusionReason(error);
      excluded.push(Object.freeze({
        agent,
        name,
        path: candidatePath,
        reasons: [reason],
        error: { code: error?.code || 'unsafe_candidate', message: error?.message || String(error) },
      }));
      nonselectedNames.add(name);
    }
  }

  const nonselected = [];
  for (const name of [...nonselectedNames].sort((left, right) => left.localeCompare(right))) {
    const siblingPath = path.join(operationsRoot, name);
    const boundary = await captureBoundary(siblingPath, `${agent} nonselected ${name}`);
    nonselected.push(Object.freeze({ name, ...boundary }));
  }
  const afterNames = (await fsp.readdir(operationsRoot)).sort((left, right) => left.localeCompare(right));
  if (canonicalJson(afterNames) !== canonicalJson(beforeNames)) {
    throw cleanupError('cleanup_operations_changed', `${agent} operations changed during preflight`);
  }
  await assertCanonicalDirectory(brainPath, {
    label: `${agent} brain`, expected: brainAuthority.identity,
  });
  await assertCanonicalDirectory(operationsRoot, {
    label: `${agent} brain operations`, expected: operationsAuthority.identity,
  });
  return Object.freeze({
    agent,
    brain,
    operationsRoot: operationsAuthority,
    eligible: eligible.sort((left, right) => left.name.localeCompare(right.name)),
    excluded: excluded.sort((left, right) => left.name.localeCompare(right.name)),
    nonselected,
  });
}

function validateCheckers(options) {
  for (const name of [
    'getPm2States', 'inspectProcessOwner', 'inspectPid', 'checkOpenFileDescriptors',
    'inspectListeners', 'inspectListenerProcess', 'getFilesystemStats',
  ]) {
    if (typeof options[name] !== 'function') {
      throw cleanupError('cleanup_checker_required', `${name} checker is required`);
    }
  }
}

export async function preflightOrphanBrainProjections(options = {}) {
  validateCheckers(options);
  const agents = requestedAgents(options.agents);
  const ports = normalizePorts(options.ports, 'ports');
  const protectedPorts = normalizePorts(options.protectedPorts || [], 'protected ports', {
    allowEmpty: true,
  });
  const home = await establishHomeAuthority(options.homeRoot);
  const pm2 = exactPm2Table(await options.getPm2States(), agents);
  assertPortAuthority(pm2, ports, protectedPorts);
  const listeners = await assertListenerGate({
    ports,
    protectedPorts,
    inspectListeners: options.inspectListeners,
    inspectListenerProcess: options.inspectListenerProcess,
  });
  const agentManifests = [];
  for (const agent of agents) {
    agentManifests.push(await captureAgentManifest({
      homeRoot: home.path,
      agent,
      inspectProcessOwner: options.inspectProcessOwner,
      inspectPid: options.inspectPid,
      checkOpenFileDescriptors: options.checkOpenFileDescriptors,
    }));
  }
  await assertCanonicalDirectory(home.path, { label: 'Home23 root', expected: home.identity });
  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: 'home23-orphan-brain-projection-preflight',
    homeRoot: home.path,
    homeRootIdentity: home.identity,
    selectedAgents: agents,
    ports,
    protectedPorts,
    agents: agentManifests,
    pm2: pm2.rows,
    pm2PortBindings: pm2.portBindings,
    listeners,
    candidateBytes: sumCandidateBytes(agentManifests.flatMap((entry) => entry.eligible)),
  });
  const manifestSha256 = manifestDigest(manifest);
  const filesystem = normalizeFilesystemStats(await options.getFilesystemStats(home.path));
  return Object.freeze({
    status: 'dry_run',
    manifest,
    manifestSha256,
    approvalToken: `APPLY-ORPHAN-BRAIN-PROJECTIONS:${manifestSha256}`,
    filesystem,
  });
}

async function assertCandidateSafety(candidate, options) {
  const pm2 = exactPm2Table(await options.getPm2States(), options.agents);
  assertPortAuthority(pm2, options.ports, options.protectedPorts);
  const listeners = await assertListenerGate({
    ports: options.ports,
    protectedPorts: options.protectedPorts,
    inspectListeners: options.inspectListeners,
    inspectListenerProcess: options.inspectListenerProcess,
  });
  if (canonicalJson(listeners) !== canonicalJson(options.expectedListeners)) {
    throw cleanupError('cleanup_listener_inventory_changed',
      'protected listener inventory changed after preflight');
  }
  const ownerChecks = await inspectOwners(candidate.owners, options);
  if (ownerChecks.some((entry) => entry.status !== 'absent')) {
    throw cleanupError('cleanup_owner_no_longer_absent', `${candidate.path} owner is alive or unknown`);
  }
  const openFds = normalizeOpenFdInspection(await options.checkOpenFileDescriptors({
    agent: candidate.agent,
    path: candidate.path,
    identity: candidate.identity,
  }));
  if (openFds.status !== 'clear') {
    throw cleanupError('cleanup_open_fds_no_longer_clear', `${candidate.path} has open or unknown FDs`);
  }
}

function validateCapturedManifest(capturedManifest, capturedManifestSha256, homeRoot) {
  if (!capturedManifest || typeof capturedManifest !== 'object' || Array.isArray(capturedManifest)
      || capturedManifest.schemaVersion !== 1
      || capturedManifest.kind !== 'home23-orphan-brain-projection-preflight'
      || capturedManifest.homeRoot !== homeRoot) {
    throw cleanupError('cleanup_manifest_required', 'a captured preflight manifest is required');
  }
  const agents = requestedAgents(capturedManifest.selectedAgents);
  const ports = normalizePorts(capturedManifest.ports, 'captured ports');
  const protectedPorts = normalizePorts(capturedManifest.protectedPorts || [],
    'captured protected ports', { allowEmpty: true });
  if (!Array.isArray(capturedManifest.agents)
      || canonicalJson(capturedManifest.agents.map((entry) => entry?.agent)) !== canonicalJson(agents)
      || protectedPorts.some((port) => ports.includes(port))) {
    throw cleanupError('cleanup_manifest_required', 'captured manifest authority is invalid');
  }
  const digest = manifestDigest(capturedManifest);
  if (typeof capturedManifestSha256 !== 'string' || digest !== capturedManifestSha256) {
    throw cleanupError('cleanup_manifest_digest_invalid', 'captured manifest digest does not match');
  }
  return digest;
}

function receiptBody(value) {
  const { receiptSha256: _ignored, ...body } = value;
  return body;
}

export async function createCleanupReceiptWriter(receiptPath, homeRoot, {
  maxBytes = CLEANUP_RECEIPT_MAX_BYTES,
  afterPublishBeforeReadback,
} = {}) {
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    throw cleanupError('cleanup_receipt_path_invalid', 'absolute receipt path required');
  }
  const normalized = path.resolve(receiptPath);
  const relativeInstances = path.relative(path.join(homeRoot, 'instances'), normalized);
  if (relativeInstances === '' || (!relativeInstances.startsWith('..') && !path.isAbsolute(relativeInstances))) {
    throw cleanupError('cleanup_receipt_path_invalid', 'receipt must not be inside installation state');
  }
  const existing = await lstatOptional(normalized);
  if (existing !== null) throw cleanupError('cleanup_receipt_exists', 'receipt path already exists');
  const parent = path.dirname(normalized);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentAuthority = await assertCanonicalDirectory(parent, { label: 'cleanup receipt parent' });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CLEANUP_RECEIPT_MAX_BYTES
      || (afterPublishBeforeReadback !== undefined
        && typeof afterPublishBeforeReadback !== 'function')) {
    throw cleanupError('cleanup_receipt_writer_invalid', 'cleanup receipt writer options are invalid');
  }
  let writes = 0;
  let publishedIdentity = null;
  return async function writeReceipt(value) {
    const body = receiptBody(value);
    const bodyBytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
    const receipt = Object.freeze({ ...body, receiptSha256: sha256Bytes(bodyBytes) });
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
    if (bytes.length > maxBytes) {
      throw cleanupError('cleanup_receipt_too_large', 'cleanup receipt exceeds the bounded write limit');
    }
    const temporary = path.join(parent,
      `.${path.basename(normalized)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    let temporaryIdentity = null;
    try {
      await assertCanonicalDirectory(parent, {
        label: 'cleanup receipt parent', expected: parentAuthority.identity,
      });
      handle = await fsp.open(temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0), 0o600);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || Number(opened.mode & 0o777n) !== 0o600) {
        throw cleanupError('cleanup_receipt_write_invalid', 'receipt candidate is unsafe');
      }
      await handle.writeFile(bytes);
      await handle.sync();
      const completed = await handle.stat({ bigint: true });
      if (!completed.isFile() || completed.nlink !== 1n
          || String(completed.dev) !== String(opened.dev)
          || String(completed.ino) !== String(opened.ino)
          || Number(completed.mode & 0o777n) !== 0o600) {
        throw cleanupError('cleanup_receipt_write_invalid', 'receipt candidate changed while writing');
      }
      temporaryIdentity = entryIdentity(completed);
      await handle.close();
      handle = null;
      const named = await lstatBig(temporary);
      if (!sameEntryIdentity(named, temporaryIdentity)) {
        throw cleanupError('cleanup_receipt_write_invalid', 'receipt candidate changed');
      }
      if (writes > 0) {
        const current = await lstatBig(normalized);
        if (!current.isFile() || current.isSymbolicLink()
            || String(current.uid) !== String(process.geteuid?.() ?? process.getuid())
            || Number(current.mode & 0o777n) !== 0o600
            || !sameEntryIdentity(current, publishedIdentity)) {
          throw cleanupError('cleanup_receipt_write_invalid', 'published receipt changed type');
        }
      }
      await assertCanonicalDirectory(parent, {
        label: 'cleanup receipt parent', expected: parentAuthority.identity,
      });
      await fsp.rename(temporary, normalized);
      await fsyncDirectory(parent);
      await afterPublishBeforeReadback?.({ receiptPath: normalized });
      const published = await lstatBig(normalized);
      if (!published.isFile() || published.isSymbolicLink()
          || Number(published.mode & 0o777n) !== 0o600
          || String(published.uid) !== String(process.geteuid?.() ?? process.getuid())
          || !sameRenamedRegularIdentity(published, temporaryIdentity)) {
        throw cleanupError('cleanup_receipt_write_invalid', 'published receipt is unsafe');
      }
      const readback = await hashOpenedRegular(normalized, published);
      if (readback.sha256 !== sha256Bytes(bytes)) {
        throw cleanupError('cleanup_receipt_write_invalid', 'published receipt readback differs');
      }
      publishedIdentity = entryIdentity(published);
      temporaryIdentity = null;
      writes += 1;
      return receipt;
    } finally {
      await handle?.close().catch(() => {});
      if (temporaryIdentity) {
        const current = await lstatOptional(temporary).catch(() => null);
        if (current && sameEntryIdentity(current, temporaryIdentity)) {
          await fsp.unlink(temporary).catch(() => {});
        }
      }
    }
  };
}

function matchingTree(candidate, captured) {
  return candidate.identity.dev === captured.identity.dev
    && candidate.identity.ino === captured.identity.ino
    && candidate.treeSha256 === captured.treeSha256
    && candidate.entryCount === captured.entryCount;
}

function boundaryReceipt(value) {
  return Object.freeze({
    path: value.path,
    identity: value.identity,
    treeSha256: value.treeSha256,
    entryCount: value.entryCount,
    logicalBytes: value.tree?.logicalBytes ?? value.logicalBytes,
    allocatedBytes: value.tree?.allocatedBytes ?? value.allocatedBytes,
  });
}

async function verifyPreservedBoundaries(capturedManifest) {
  const drift = [];
  const boundaries = [];
  for (const agent of capturedManifest.agents) {
    const brainBefore = boundaryReceipt(agent.brain);
    try {
      const brain = await captureBoundary(agent.brain.path, `${agent.agent} brain after cleanup`);
      const brainAfter = boundaryReceipt(brain);
      const unchanged = brain.treeSha256 === agent.brain.treeSha256
        && canonicalJson(brain.identity) === canonicalJson(agent.brain.identity);
      boundaries.push(Object.freeze({
        agent: agent.agent, kind: 'brain', name: 'brain', before: brainBefore, after: brainAfter, unchanged,
      }));
      if (!unchanged) {
        drift.push(`${agent.agent}:brain`);
      }
    } catch (error) {
      boundaries.push(Object.freeze({
        agent: agent.agent,
        kind: 'brain',
        name: 'brain',
        before: brainBefore,
        after: null,
        unchanged: false,
        error: { code: error?.code || 'boundary_read_failed', message: error?.message || String(error) },
      }));
      drift.push(`${agent.agent}:brain`);
    }
    for (const sibling of agent.nonselected) {
      const siblingBefore = boundaryReceipt(sibling);
      try {
        const after = await captureBoundary(sibling.path,
          `${agent.agent} nonselected ${sibling.name} after cleanup`);
        const siblingAfter = boundaryReceipt(after);
        const unchanged = after.treeSha256 === sibling.treeSha256
          && canonicalJson(after.identity) === canonicalJson(sibling.identity);
        boundaries.push(Object.freeze({
          agent: agent.agent,
          kind: 'nonselected',
          name: sibling.name,
          before: siblingBefore,
          after: siblingAfter,
          unchanged,
        }));
        if (!unchanged) {
          drift.push(`${agent.agent}:${sibling.name}`);
        }
      } catch (error) {
        boundaries.push(Object.freeze({
          agent: agent.agent,
          kind: 'nonselected',
          name: sibling.name,
          before: siblingBefore,
          after: null,
          unchanged: false,
          error: { code: error?.code || 'boundary_read_failed', message: error?.message || String(error) },
        }));
        drift.push(`${agent.agent}:${sibling.name}`);
      }
    }
  }
  return Object.freeze({ drift, boundaries });
}

function errorReceipt(error) {
  return Object.freeze({
    code: error?.code || 'cleanup_failed',
    message: error?.message || String(error),
  });
}

async function captureFinalRuntimeGates(capturedManifest, results, options) {
  let pm2;
  try {
    const authority = exactPm2Table(await options.getPm2States(), capturedManifest.selectedAgents);
    assertPortAuthority(authority, capturedManifest.ports, capturedManifest.protectedPorts);
    pm2 = Object.freeze({
      status: 'passed', rows: authority.rows, portBindings: authority.portBindings,
    });
  } catch (error) {
    pm2 = Object.freeze({ status: 'failed', error: errorReceipt(error) });
  }

  let listeners;
  try {
    const entries = await assertListenerGate({
      ports: capturedManifest.ports,
      protectedPorts: capturedManifest.protectedPorts,
      inspectListeners: options.inspectListeners,
      inspectListenerProcess: options.inspectListenerProcess,
    });
    if (canonicalJson(entries) !== canonicalJson(capturedManifest.listeners)) {
      throw cleanupError('cleanup_listener_inventory_changed',
        'protected listener inventory changed after cleanup');
    }
    listeners = Object.freeze({ status: 'passed', entries });
  } catch (error) {
    listeners = Object.freeze({ status: 'failed', error: errorReceipt(error) });
  }

  const fdEntries = [];
  for (const agent of capturedManifest.agents) {
    for (const candidate of [...agent.eligible, ...agent.excluded]) {
      const result = results.find((entry) => entry.agent === agent.agent && entry.name === candidate.name);
      const paths = [...new Set([candidate.path, result?.quarantinePath].filter(Boolean))];
      const existing = [];
      let pathInspectionFailed = false;
      for (const candidatePath of paths) {
        try {
          const stat = await lstatOptional(candidatePath);
          if (stat) existing.push(candidatePath);
        } catch (error) {
          pathInspectionFailed = true;
          fdEntries.push(Object.freeze({
            agent: agent.agent,
            name: candidate.name,
            path: candidatePath,
            status: 'unknown',
            open: [],
            error: errorReceipt(error),
          }));
        }
      }
      if (existing.length === 0 && !pathInspectionFailed) {
        fdEntries.push(Object.freeze({
          agent: agent.agent, name: candidate.name, path: candidate.path, status: 'absent', open: [],
        }));
        continue;
      }
      for (const candidatePath of existing) {
        try {
          const inspected = normalizeOpenFdInspection(await options.checkOpenFileDescriptors({
            agent: agent.agent,
            path: candidatePath,
            identity: candidate.identity || null,
          }));
          fdEntries.push(Object.freeze({
            agent: agent.agent,
            name: candidate.name,
            path: candidatePath,
            status: inspected.status,
            open: inspected.open,
          }));
        } catch (error) {
          fdEntries.push(Object.freeze({
            agent: agent.agent,
            name: candidate.name,
            path: candidatePath,
            status: 'unknown',
            open: [],
            error: errorReceipt(error),
          }));
        }
      }
    }
  }
  const openFileDescriptors = Object.freeze({
    status: fdEntries.every((entry) => entry.status === 'clear' || entry.status === 'absent')
      ? 'passed' : 'failed',
    entries: fdEntries,
  });
  return Object.freeze({ pm2, listeners, openFileDescriptors });
}

export async function applyOrphanBrainProjectionCleanup(options = {}) {
  validateCheckers(options);
  const home = await establishHomeAuthority(options.homeRoot);
  const capturedDigest = validateCapturedManifest(
    options.capturedManifest,
    options.capturedManifestSha256,
    home.path,
  );
  const invocationAgents = requestedAgents(options.agents);
  const invocationPorts = normalizePorts(options.ports, 'ports');
  const invocationProtectedPorts = normalizePorts(options.protectedPorts || [], 'protected ports', {
    allowEmpty: true,
  });
  if (canonicalJson(invocationAgents) !== canonicalJson(options.capturedManifest.selectedAgents)
      || canonicalJson(invocationPorts) !== canonicalJson(options.capturedManifest.ports)
      || canonicalJson(invocationProtectedPorts)
        !== canonicalJson(options.capturedManifest.protectedPorts)) {
    throw cleanupError('cleanup_manifest_arguments_mismatch',
      'explicit agents and ports do not match the captured manifest');
  }
  const expectedToken = `APPLY-ORPHAN-BRAIN-PROJECTIONS:${capturedDigest}`;
  if (options.approvalToken !== expectedToken) {
    throw cleanupError('cleanup_approval_token_invalid', 'approval token does not match captured manifest');
  }
  const approval = validateApprovalRecord(options);
  const fresh = await preflightOrphanBrainProjections({
    ...options,
    agents: options.capturedManifest.selectedAgents,
    ports: options.capturedManifest.ports,
    protectedPorts: options.capturedManifest.protectedPorts,
  });
  if (fresh.manifestSha256 !== capturedDigest) {
    throw cleanupError('cleanup_manifest_drift', 'filesystem or safety state changed after preflight', {
      capturedManifestSha256: capturedDigest,
      currentManifestSha256: fresh.manifestSha256,
    });
  }
  const writeReceipt = await createCleanupReceiptWriter(options.receiptPath, home.path);
  const hooks = options._testHooks || {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || Object.values(hooks).some((hook) => typeof hook !== 'function')) {
    throw cleanupError('cleanup_test_hooks_invalid', 'cleanup test hooks are invalid');
  }
  const results = [];
  const eligibleCandidates = options.capturedManifest.agents.flatMap((agent) => agent.eligible);
  const selectedCandidateBytes = options.capturedManifest.candidateBytes
    || sumCandidateBytes(eligibleCandidates);
  const receipt = {
    schemaVersion: 1,
    kind: 'home23-orphan-brain-projection-cleanup',
    status: 'in_progress',
    homeRoot: home.path,
    manifestSha256: capturedDigest,
    approvalToken: expectedToken,
    approval,
    filesystemBefore: fresh.filesystem,
    candidateBytes: {
      selected: selectedCandidateBytes,
      removed: { count: 0, logicalBytes: '0', allocatedBytes: '0' },
    },
    startedAt: new Date().toISOString(),
    completedAt: null,
    exclusions: options.capturedManifest.agents.flatMap((agent) => agent.excluded.map((entry) => ({
      agent: agent.agent,
      name: entry.name,
      path: entry.path,
      reasons: entry.reasons,
    }))),
    results,
    boundaryDrift: [],
  };
  await writeReceipt(receipt);
  await hooks.beforeFirstMutation?.({ receiptPath: options.receiptPath });

  let partial = false;
  for (const agent of options.capturedManifest.agents) {
    for (const candidate of agent.eligible) {
      let quarantineContainer = null;
      let quarantineContainerIdentity = null;
      let quarantinePath = null;
      let removalConfirmed = false;
      const resultRecord = {
        agent: candidate.agent,
        name: candidate.name,
        originalPath: candidate.path,
        quarantineContainer: null,
        quarantinePath: null,
        identity: candidate.identity,
        treeSha256: candidate.treeSha256,
        logicalBytes: candidate.logicalBytes,
        allocatedBytes: candidate.allocatedBytes,
        status: 'pending',
      };
      results.push(resultRecord);
      await writeReceipt({ ...receipt, results, status: 'in_progress' });
      try {
        const current = await captureTree(candidate.path, {
          strict: true,
          expectedRootIdentity: candidate.identity,
          label: `${candidate.agent}/${candidate.name} before rename`,
        });
        if (!matchingTree(current.snapshot, candidate)) {
          throw cleanupError('cleanup_candidate_changed', `${candidate.path} changed before rename`);
        }
        await hooks.beforeQuarantineSafetyRecheck?.({
          agent: candidate.agent,
          originalPath: candidate.path,
        });
        // These live-state gates intentionally run after the potentially long
        // recursive hash and immediately before the identity check + rename.
        await assertCandidateSafety(candidate, {
          ...options,
          agents: options.capturedManifest.selectedAgents,
          ports: options.capturedManifest.ports,
          protectedPorts: options.capturedManifest.protectedPorts,
          expectedListeners: options.capturedManifest.listeners,
        });
        await assertCanonicalDirectory(agent.operationsRoot.path, {
          label: `${agent.agent} brain operations`, expected: agent.operationsRoot.identity,
        });
        quarantineContainer = path.join(agent.operationsRoot.path,
          `.orphan-projection-quarantine-${capturedDigest.slice(0, 16)}-${crypto.randomUUID()}`);
        await fsp.mkdir(quarantineContainer, { mode: 0o700 });
        const containerStat = await lstatBig(quarantineContainer);
        if (!containerStat.isDirectory() || containerStat.isSymbolicLink()
            || Number(containerStat.mode & 0o777n) !== 0o700
            || String(containerStat.uid) !== String(process.geteuid?.() ?? process.getuid())) {
          throw cleanupError('cleanup_quarantine_container_invalid',
            `${quarantineContainer} is not an exact private directory`);
        }
        quarantineContainerIdentity = identityOf(containerStat);
        quarantinePath = path.join(quarantineContainer, candidate.name);
        await fsyncDirectory(agent.operationsRoot.path);
        await hooks.afterQuarantineContainerCreated?.({
          agent: candidate.agent,
          originalPath: candidate.path,
          quarantineContainer,
          destinationPath: quarantinePath,
        });
        await assertCanonicalDirectory(quarantineContainer, {
          label: `${candidate.agent} quarantine container`,
          requiredMode: 0o700,
          expected: quarantineContainerIdentity,
        });
        if (await lstatOptional(quarantinePath) !== null
            || (await fsp.readdir(quarantineContainer)).length !== 0) {
          throw cleanupError('cleanup_quarantine_destination_exists',
            `${quarantinePath} was occupied before quarantine`);
        }
        const immediatelyBefore = await lstatBig(candidate.path);
        if (!sameAuthority(immediatelyBefore, candidate.identity)
            || !immediatelyBefore.isDirectory() || immediatelyBefore.isSymbolicLink()) {
          throw cleanupError('cleanup_candidate_changed', `${candidate.path} changed before quarantine`);
        }
        await fsp.rename(candidate.path, quarantinePath);
        await fsyncDirectory(agent.operationsRoot.path);
        await fsyncDirectory(quarantineContainer);
        const quarantined = await lstatBig(quarantinePath);
        if (!sameAuthority(quarantined, candidate.identity)
            || !quarantined.isDirectory() || quarantined.isSymbolicLink()) {
          throw cleanupError('cleanup_quarantine_identity_changed', `${quarantinePath} identity is wrong`);
        }
        await hooks.afterQuarantineRename?.({
          agent: candidate.agent,
          originalPath: candidate.path,
          quarantinePath,
        });
        const quarantineTree = await captureTree(quarantinePath, {
          strict: true,
          expectedRootIdentity: candidate.identity,
          label: `${candidate.agent}/${candidate.name} quarantine`,
        });
        if (!matchingTree(quarantineTree.snapshot, candidate)) {
          throw cleanupError('cleanup_quarantine_content_changed', `${quarantinePath} content changed`);
        }
        await assertCandidateSafety({ ...candidate, path: quarantinePath }, {
          ...options,
          agents: options.capturedManifest.selectedAgents,
          ports: options.capturedManifest.ports,
          protectedPorts: options.capturedManifest.protectedPorts,
          expectedListeners: options.capturedManifest.listeners,
        });
        const exactBeforeRemove = await lstatBig(quarantinePath);
        if (!sameAuthority(exactBeforeRemove, candidate.identity)
            || !exactBeforeRemove.isDirectory() || exactBeforeRemove.isSymbolicLink()) {
          throw cleanupError('cleanup_quarantine_identity_changed', `${quarantinePath} changed before remove`);
        }
        await fsp.rm(quarantinePath, { recursive: true, force: false });
        removalConfirmed = await lstatOptional(quarantinePath) === null;
        if (!removalConfirmed) {
          throw cleanupError('cleanup_remove_incomplete', `${quarantinePath} still exists`);
        }
        await hooks.afterQuarantineRemoval?.({
          agent: candidate.agent,
          originalPath: candidate.path,
          quarantineContainer,
          quarantinePath,
        });
        await fsyncDirectory(quarantineContainer);
        await assertCanonicalDirectory(quarantineContainer, {
          label: `${candidate.agent} quarantine container after removal`,
          requiredMode: 0o700,
          expected: quarantineContainerIdentity,
        });
        if ((await fsp.readdir(quarantineContainer)).length !== 0) {
          throw cleanupError('cleanup_quarantine_container_not_empty',
            `${quarantineContainer} retained unexpected entries`);
        }
        await fsp.rmdir(quarantineContainer);
        await fsyncDirectory(agent.operationsRoot.path);
        Object.assign(resultRecord, {
          quarantineContainer,
          quarantinePath,
          status: 'removed',
        });
      } catch (error) {
        partial = true;
        let quarantined = null;
        let original = null;
        let removalStateUnknown = false;
        try {
          quarantined = quarantinePath ? await lstatOptional(quarantinePath) : null;
        } catch {
          removalStateUnknown = true;
        }
        try {
          original = await lstatOptional(candidate.path);
        } catch {
          removalStateUnknown = true;
        }
        removalConfirmed ||= !removalStateUnknown && original === null
          && quarantined === null && quarantinePath !== null;
        Object.assign(resultRecord, {
          quarantineContainer,
          quarantinePath,
          status: removalConfirmed
            ? 'removed_postcondition_failed'
            : (removalStateUnknown
              ? 'removal_state_unknown'
              : (original ? 'not_removed' : (quarantined ? 'quarantined_not_removed' : 'not_removed'))),
          error: { code: error?.code || 'cleanup_failed', message: error?.message || String(error) },
        });
      }
      await hooks.beforeProgressReceipt?.({
        phase: 'after_candidate',
        agent: candidate.agent,
        result: resultRecord,
      });
      await writeReceipt({ ...receipt, results, status: 'in_progress' });
    }
  }
  const preserved = await verifyPreservedBoundaries(options.capturedManifest);
  if (preserved.drift.length > 0) partial = true;
  await hooks.beforeFinalRuntimeGates?.();
  const finalRuntime = await captureFinalRuntimeGates(options.capturedManifest, results, options);
  if (Object.values(finalRuntime).some((entry) => entry.status !== 'passed')) partial = true;
  let filesystemAfter = null;
  let filesystemError = null;
  try {
    filesystemAfter = normalizeFilesystemStats(await options.getFilesystemStats(home.path));
  } catch (error) {
    filesystemError = errorReceipt(error);
    partial = true;
  }
  const filesystemAvailableDeltaBytes = filesystemAfter
    ? String(BigInt(filesystemAfter.availableBytes) - BigInt(fresh.filesystem.availableBytes))
    : null;
  const removedCandidates = eligibleCandidates.filter((candidate) => results.some((result) =>
    result.agent === candidate.agent && result.name === candidate.name
      && result.status.startsWith('removed')));
  const candidateBytes = {
    selected: selectedCandidateBytes,
    removed: sumCandidateBytes(removedCandidates),
  };
  const finalBody = {
    ...receipt,
    status: partial ? 'partial' : 'completed',
    completedAt: new Date().toISOString(),
    results,
    candidateBytes,
    filesystemAfter,
    filesystemError,
    filesystemAvailableDeltaBytes,
    preservedBoundaries: preserved.boundaries,
    boundaryDrift: preserved.drift,
    finalRuntime,
  };
  const finalReceipt = await writeReceipt(finalBody);
  return finalReceipt;
}

async function readDarwinProcessIdentity(pid) {
  let bootToken;
  try {
    ({ stdout: bootToken } = await execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8', maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }));
  } catch {
    return null;
  }
  let processOutput;
  try {
    ({ stdout: processOutput } = await execFile('/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart='], {
      encoding: 'utf8', maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }));
  } catch (error) {
    if (error.code === 1) return false;
    return null;
  }
  const normalized = processOutput.trim().replace(/\s+/g, ' ');
  if (!normalized.startsWith(`${pid} `)) return null;
  return { bootToken: bootToken.trim(), processStartToken: normalized.slice(String(pid).length + 1) };
}

async function readLinuxProcessIdentity(pid) {
  let statText;
  let bootToken;
  try {
    statText = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    return null;
  }
  try {
    bootToken = await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
  } catch {
    return null;
  }
  const closeParen = statText.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/);
  if (!fields[19]) return null;
  return { bootToken: bootToken.trim(), processStartToken: fields[19] };
}

async function defaultProcessIdentity(pid) {
  if (process.platform === 'darwin') return readDarwinProcessIdentity(pid);
  if (process.platform === 'linux') return readLinuxProcessIdentity(pid);
  return null;
}

async function defaultInspectPid(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error.code === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

async function defaultInspectProcessOwner(owner) {
  const pidStatus = await defaultInspectPid(owner.pid);
  if (pidStatus !== 'alive') return pidStatus;
  if (owner.bootToken.startsWith('unverifiable-')
      || owner.processStartToken.startsWith('unverifiable-')) return 'unknown';
  const exact = await defaultProcessIdentity(owner.pid);
  if (exact === false) return 'absent';
  if (exact === null) return 'unknown';
  return exact.bootToken === owner.bootToken && exact.processStartToken === owner.processStartToken
    ? 'alive'
    : 'reused';
}

async function defaultPm2States() {
  const { stdout } = await execFile('pm2', ['jlist'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw cleanupError('cleanup_pm2_invalid', 'PM2 returned malformed JSON', { cause: error });
  }
}

async function defaultOpenFdCheck({ path: candidatePath }) {
  const binaries = process.platform === 'darwin'
    ? ['/usr/sbin/lsof', '/usr/bin/lsof']
    : ['/usr/bin/lsof', '/usr/sbin/lsof'];
  for (const binary of binaries) {
    try {
      const { stdout } = await execFile(binary, ['-nP', '-F', 'pfn', '+D', candidatePath], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      const open = stdout.trim().split('\n').filter(Boolean);
      return { status: open.length > 0 ? 'open' : 'clear', open };
    } catch (error) {
      if (error.code === 1 && !(error.stdout || '').trim() && !(error.stderr || '').trim()) {
        return { status: 'clear', open: [] };
      }
      if (error.code === 'ENOENT') continue;
      return { status: 'unknown', open: [] };
    }
  }
  return { status: 'unknown', open: [] };
}

async function defaultInspectListeners({ ports }) {
  const binaries = process.platform === 'darwin'
    ? ['/usr/sbin/lsof', '/usr/bin/lsof']
    : ['/usr/bin/lsof', '/usr/sbin/lsof'];
  let binary = null;
  for (const candidate of binaries) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      binary = candidate;
      break;
    } catch {}
  }
  if (!binary) throw cleanupError('cleanup_listener_status_unknown', 'lsof is unavailable');
  const listeners = [];
  for (const port of ports) {
    let stdout;
    try {
      ({ stdout } = await execFile(binary,
        ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-Fpc'], {
          encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        }));
    } catch (error) {
      if (error.code === 1 && !(error.stdout || '').trim() && !(error.stderr || '').trim()) continue;
      throw cleanupError('cleanup_listener_status_unknown', `could not inspect port ${port}`, {
        cause: error,
      });
    }
    let currentPid = null;
    let currentCommand = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        if (currentPid && currentCommand) listeners.push({
          port, pid: currentPid, command: currentCommand,
        });
        currentPid = Number(line.slice(1));
        currentCommand = null;
      } else if (line.startsWith('c')) {
        currentCommand = line.slice(1);
      }
    }
    if (currentPid && currentCommand) listeners.push({ port, pid: currentPid, command: currentCommand });
  }
  return listeners;
}

function parseArgs(argv) {
  const values = { agent: [], port: [], 'protected-port': [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply' || token === '--help') values[token.slice(2)] = true;
    else if (['--home-root', '--receipt', '--manifest', '--approval-token', '--approval-actor',
      '--approval-text', '--approval-at', '--agent', '--port', '--protected-port'].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw cleanupError('cleanup_cli_invalid', `${token} requires a value`);
      const key = token.slice(2);
      if (['agent', 'port', 'protected-port'].includes(key)) values[key].push(value);
      else values[key] = value;
      index += 1;
    } else throw cleanupError('cleanup_cli_invalid', `unknown argument ${token}`);
  }
  return values;
}

export async function loadCapturedCleanupManifestReceipt(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw cleanupError('cleanup_manifest_required', 'absolute --manifest receipt path required');
  }
  const before = await lstatBig(filePath).catch((error) => {
    throw cleanupError('cleanup_manifest_required', 'captured manifest receipt is unavailable', {
      cause: error,
    });
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(MAX_CAPTURED_MANIFEST_BYTES)
      || Number(before.mode & 0o777n) !== 0o600
      || String(before.uid) !== String(process.geteuid?.() ?? process.getuid())) {
    throw cleanupError('cleanup_manifest_required', 'captured manifest receipt is unsafe');
  }
  const beforeIdentity = entryIdentity(before);
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameEntryIdentity(opened, beforeIdentity)) {
      throw cleanupError('cleanup_manifest_required', 'captured manifest receipt changed while opening');
    }
    bytes = await handle.readFile();
    const finalOpened = await handle.stat({ bigint: true });
    const namedAfter = await lstatBig(filePath);
    if (!sameEntryIdentity(finalOpened, beforeIdentity)
        || !sameEntryIdentity(namedAfter, beforeIdentity)
        || !namedAfter.isFile() || namedAfter.isSymbolicLink()) {
      throw cleanupError('cleanup_manifest_required', 'captured manifest receipt changed while reading');
    }
  } finally {
    await handle.close();
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw cleanupError('cleanup_manifest_required', 'captured manifest receipt is malformed', { cause: error });
  }
  if (!parsed?.manifest || typeof parsed.manifestSha256 !== 'string'
      || parsed.kind !== 'home23-orphan-brain-projection-cleanup'
      || parsed.status !== 'dry_run' || typeof parsed.receiptSha256 !== 'string') {
    throw cleanupError('cleanup_manifest_required', 'captured receipt has no manifest');
  }
  const { receiptSha256, ...body } = parsed;
  const expectedChecksum = sha256Bytes(Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
  if (receiptSha256 !== expectedChecksum) {
    throw cleanupError('cleanup_manifest_checksum_invalid', 'captured receipt checksum does not match');
  }
  return parsed;
}

async function writeDryRunReceipt(receiptPath, homeRoot, result) {
  const writeReceipt = await createCleanupReceiptWriter(receiptPath, homeRoot);
  return writeReceipt({
    schemaVersion: 1,
    kind: 'home23-orphan-brain-projection-cleanup',
    status: 'dry_run',
    createdAt: new Date().toISOString(),
    ...result,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: cleanup-orphan-brain-projections.mjs --home-root <canonical-root> --agent <name>... --port <tcp-port>... [--protected-port <tcp-port>...] --receipt <path> [--apply --manifest <dry-run-receipt> --approval-token <token> --approval-actor <actor> --approval-text <text> --approval-at <ISO-time>]\n');
    return;
  }
  const agents = requestedAgents(args.agent);
  const ports = normalizePorts(args.port.map(Number), 'ports');
  const protectedPorts = normalizePorts(args['protected-port'].map(Number), 'protected ports', {
    allowEmpty: true,
  });
  const checks = {
    getPm2States: defaultPm2States,
    inspectProcessOwner: defaultInspectProcessOwner,
    inspectPid: defaultInspectPid,
    checkOpenFileDescriptors: defaultOpenFdCheck,
    inspectListeners: defaultInspectListeners,
    inspectListenerProcess: defaultProcessIdentity,
    getFilesystemStats: defaultFilesystemStats,
  };
  if (!args.apply) {
    const result = await preflightOrphanBrainProjections({
      homeRoot: args['home-root'],
      agents,
      ports,
      protectedPorts,
      ...checks,
    });
    const receipt = await writeDryRunReceipt(args.receipt, result.manifest.homeRoot, result);
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      receiptPath: args.receipt,
      manifestSha256: receipt.manifestSha256,
      approvalToken: receipt.approvalToken,
    })}\n`);
    return;
  }
  const captured = await loadCapturedCleanupManifestReceipt(args.manifest);
  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: args['home-root'],
    agents,
    ports,
    protectedPorts,
    receiptPath: args.receipt,
    capturedManifest: captured.manifest,
    capturedManifestSha256: captured.manifestSha256,
    approvalToken: args['approval-token'],
    approvalActor: args['approval-actor'],
    approvalText: args['approval-text'],
    approvalAt: args['approval-at'],
    ...checks,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    receiptPath: args.receipt,
    manifestSha256: result.manifestSha256,
    results: result.results,
  })}\n`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: error?.code || 'cleanup_failed',
      message: error?.message || String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
