'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_HEALTH_BYTES = 64 * 1024;

function safeAgent(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('safe ANN health agent required');
  }
  return value;
}

function bindDirectory(directory, label) {
  const stat = fs.lstatSync(directory, { bigint: true });
  const canonical = fs.realpathSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directory) {
    throw new Error(`${label} must be a canonical nonsymlink directory`);
  }
  return Object.freeze({ path: directory, dev: stat.dev, ino: stat.ino });
}

function assertDirectoryBinding(binding, label) {
  const stat = fs.lstatSync(binding.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== binding.dev || stat.ino !== binding.ino
      || fs.realpathSync(binding.path) !== binding.path) {
    throw new Error(`${label} identity changed`);
  }
}

function ensureChildDirectory(parent, segment, label) {
  assertDirectoryBinding(parent, `${label} parent`);
  const child = path.join(parent.path, segment);
  try {
    fs.mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  assertDirectoryBinding(parent, `${label} parent`);
  return bindDirectory(child, label);
}

function exactRead(fd, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, bytes, offset, size - offset, offset);
    if (!Number.isSafeInteger(read) || read <= 0) throw new Error('ANN health readback incomplete');
    offset += read;
  }
  return bytes;
}

function exactWrite(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('ANN health write made no progress');
    offset += written;
  }
}

function readPrevious(healthPath, runtimeBinding) {
  assertDirectoryBinding(runtimeBinding, 'ANN health runtime');
  let fd;
  try {
    fd = fs.openSync(healthPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MAX_HEALTH_BYTES)) {
      throw new Error('ANN health file is unsafe or oversized');
    }
    const bytes = exactRead(fd, Number(opened.size));
    const after = fs.fstatSync(fd, { bigint: true });
    const bound = fs.lstatSync(healthPath, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || !bound.isFile() || bound.isSymbolicLink()
        || bound.dev !== opened.dev || bound.ino !== opened.ino) {
      throw new Error('ANN health file identity changed during read');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function publishHealth(healthPath, runtimeBinding, state) {
  assertDirectoryBinding(runtimeBinding, 'ANN health runtime');
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  if (bytes.length > MAX_HEALTH_BYTES) throw new Error('ANN health state exceeds bound');
  const tempPath = path.join(
    runtimeBinding.path,
    `.ann-index-health.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tempPath, flags, 0o600);
  let identity = null;
  let published = false;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    identity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || opened.nlink !== 1n) throw new Error('ANN health temp is unsafe');
    exactWrite(fd, bytes);
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== BigInt(bytes.length) || after.nlink !== 1n) {
      throw new Error('ANN health temp identity or size changed');
    }
    const readback = exactRead(fd, bytes.length);
    if (!crypto.timingSafeEqual(
      crypto.createHash('sha256').update(readback).digest(),
      crypto.createHash('sha256').update(bytes).digest(),
    )) throw new Error('ANN health temp digest mismatch');
    assertDirectoryBinding(runtimeBinding, 'ANN health runtime');
    let existing = null;
    try { existing = fs.lstatSync(healthPath, { bigint: true }); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error('ANN health destination is unsafe');
    }
    fs.renameSync(tempPath, healthPath);
    published = true;
    const directoryFd = fs.openSync(runtimeBinding.path, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    const finalStat = fs.lstatSync(healthPath, { bigint: true });
    if (!finalStat.isFile() || finalStat.isSymbolicLink()
        || finalStat.dev !== opened.dev || finalStat.ino !== opened.ino) {
      throw new Error('ANN health publication identity changed');
    }
    const finalFd = fs.openSync(healthPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const finalBytes = exactRead(finalFd, bytes.length);
      if (!crypto.timingSafeEqual(
        crypto.createHash('sha256').update(finalBytes).digest(),
        crypto.createHash('sha256').update(bytes).digest(),
      )) throw new Error('ANN health publication readback mismatch');
    } finally { fs.closeSync(finalFd); }
  } finally {
    fs.closeSync(fd);
    if (!published && identity) {
      let current = null;
      try { current = fs.lstatSync(tempPath, { bigint: true }); } catch {}
      if (current?.isFile() && !current.isSymbolicLink()
          && current.dev === identity.dev && current.ino === identity.ino) {
        fs.unlinkSync(tempPath);
      }
    }
  }
}

function boundedNonnegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function updateAnnIndexHealth({
  home23Root,
  agent,
  outcome,
  receipt = null,
  threshold = 3,
  maxGap = 50000,
  now = new Date().toISOString(),
} = {}) {
  const safe = safeAgent(agent);
  const thresholdValue = Number(threshold);
  const maxGapValue = Number(maxGap);
  if (!Number.isSafeInteger(thresholdValue) || thresholdValue < 1
      || !Number.isSafeInteger(maxGapValue) || maxGapValue < 0) {
    throw new Error('valid ANN health threshold and max gap required');
  }
  if (!['success', 'manifest_missing', 'builder_failed', 'receipt_invalid'].includes(outcome)) {
    throw new Error('valid ANN health outcome required');
  }
  const root = bindDirectory(fs.realpathSync(home23Root), 'Home23 root');
  const instances = bindDirectory(path.join(root.path, 'instances'), 'instances root');
  const agentRoot = bindDirectory(path.join(instances.path, safe), 'agent root');
  const runtime = ensureChildDirectory(agentRoot, 'runtime', 'agent runtime');
  const healthPath = path.join(runtime.path, 'ann-index-health.json');
  const previous = readPrevious(healthPath, runtime);
  const hardFailure = outcome !== 'success';
  const gap = hardFailure ? null : boundedNonnegativeInteger(receipt?.bridgeableGap, 0);
  const usable = !hardFailure && receipt?.semanticCoverage?.usable === true;
  const coverageFailure = hardFailure || gap > maxGapValue || !usable;
  const previousFailures = boundedNonnegativeInteger(
    previous.consecutiveCoverageFailures ?? previous.consecutiveExcessiveGaps,
    0,
  );
  const consecutiveCoverageFailures = coverageFailure ? previousFailures + 1 : 0;
  const sustainedFailure = coverageFailure && consecutiveCoverageFailures >= thresholdValue;
  const coverageStatus = hardFailure
    ? outcome
    : (coverageFailure ? 'coverage_gap' : 'covered');
  const state = {
    status: hardFailure ? 'failed' : (sustainedFailure ? 'alerting' : (coverageFailure ? 'lagging' : 'healthy')),
    coverageStatus,
    alertStatus: hardFailure
      ? 'failure'
      : (sustainedFailure ? 'sustained_failure' : (coverageFailure ? 'pending' : 'clear')),
    consecutiveCoverageFailures,
    consecutiveExcessiveGaps: consecutiveCoverageFailures,
    builtRevision: hardFailure ? null : receipt.builtRevision,
    currentRevision: hardFailure ? null : receipt.currentRevision,
    bridgeableGap: gap,
    semanticCoverage: hardFailure ? null : receipt.semanticCoverage,
    lastAttemptOutcome: outcome,
    updatedAt: String(now),
  };
  publishHealth(healthPath, runtime, state);
  return Object.freeze({ state: Object.freeze(state), sustainedFailure });
}

function main() {
  const receipt = process.env.ANN_RECEIPT ? JSON.parse(process.env.ANN_RECEIPT) : null;
  const result = updateAnnIndexHealth({
    home23Root: process.env.ANN_HOME23_ROOT,
    agent: process.env.ANN_AGENT,
    outcome: process.env.ANN_OUTCOME,
    receipt,
    threshold: process.env.ANN_GAP_THRESHOLD,
    maxGap: process.env.ANN_MAX_GAP,
  });
  if (process.env.ANN_OUTCOME === 'success' && result.sustainedFailure) process.exitCode = 3;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}

module.exports = { updateAnnIndexHealth };
