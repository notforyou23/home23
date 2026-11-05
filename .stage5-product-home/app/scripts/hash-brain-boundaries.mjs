#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalReceiptRow,
  failCli,
  hashFile,
  isInsideOrEqual,
  isMain,
  one,
  parseCli,
  readJson,
  receiptContext,
  sha256Bytes,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';

export const REQUIRED_BOUNDARIES = Object.freeze([
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function inventoryDigest(value) {
  return sha256Bytes(Buffer.from(stableJson(value)));
}

function selectedTarget(catalog, { targetAgent, targetBrain }) {
  const brains = Array.isArray(catalog?.brains)
    ? catalog.brains
    : Array.isArray(catalog?.entries) ? catalog.entries : [];
  if ((targetAgent ? 1 : 0) + (targetBrain ? 1 : 0) !== 1) {
    throw typedError('invalid_target_selector', 'exactly one target selector is required');
  }
  const matches = targetAgent
    ? brains.filter((brain) => brain?.kind === 'resident' && brain?.ownerAgent === targetAgent)
    : brains.filter((brain) => brain?.id === targetBrain || brain?.brainId === targetBrain);
  if (matches.length === 0) throw typedError('target_not_found');
  if (matches.length > 1) throw typedError('target_ambiguous');
  const target = matches[0];
  const eligible = (target.kind === 'resident' && target.lifecycle === 'resident')
    || (target.kind === 'research' && target.lifecycle === 'completed');
  if (!eligible) throw typedError('target_not_available');
  return target;
}

async function canonicalTarget(target) {
  if (typeof target.canonicalRoot !== 'string' || !path.isAbsolute(target.canonicalRoot)
      || path.normalize(target.canonicalRoot) !== target.canonicalRoot) {
    throw typedError('target_invalid', 'target canonical root is invalid');
  }
  const rootStat = await fsp.lstat(target.canonicalRoot, { bigint: true }).catch((error) => {
    throw typedError('target_not_available', 'target root is unavailable', { cause: error });
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || await fsp.realpath(target.canonicalRoot) !== target.canonicalRoot) {
    throw typedError('target_invalid', 'target root must be a canonical nonsymlink directory');
  }
  const boundaries = target.mutationBoundaries;
  if (!Array.isArray(boundaries) || boundaries.length !== REQUIRED_BOUNDARIES.length) {
    throw typedError('boundary_contract_invalid');
  }
  const byKind = new Map();
  for (const boundary of boundaries) {
    if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)
        || !REQUIRED_BOUNDARIES.includes(boundary.kind) || byKind.has(boundary.kind)
        || typeof boundary.path !== 'string' || !path.isAbsolute(boundary.path)
        || path.normalize(boundary.path) !== boundary.path
        || !isInsideOrEqual(target.canonicalRoot, boundary.path)) {
      throw typedError('boundary_contract_invalid');
    }
    byKind.set(boundary.kind, boundary.path);
  }
  if (REQUIRED_BOUNDARIES.some((kind) => !byKind.has(kind))) {
    throw typedError('boundary_contract_invalid');
  }
  if (byKind.get('brain') !== target.canonicalRoot || byKind.get('run') !== target.canonicalRoot) {
    throw typedError(
      target.kind === 'resident' ? 'resident_boundary_invalid' : 'research_boundary_invalid',
    );
  }
  return { target, byKind, rootStat };
}

async function scanPhysicalRoot(root) {
  let rootStat;
  try {
    rootStat = await fsp.lstat(root, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [{
      path: '.', type: 'absent', size: null, mtimeNs: null, ctimeNs: null,
      dev: null, ino: null, nlink: null, sha256: null,
    }];
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    const linkTarget = await fsp.readlink(root);
    return [{
      path: '.', type: 'symlink', size: Number(rootStat.size),
      mtimeNs: rootStat.mtimeNs.toString(), ctimeNs: rootStat.ctimeNs.toString(),
      dev: rootStat.dev.toString(), ino: rootStat.ino.toString(), nlink: Number(rootStat.nlink),
      sha256: sha256Bytes(Buffer.from(linkTarget)), linkTarget,
    }];
  }
  if (!rootStat.isDirectory()) throw typedError('boundary_root_invalid');
  const records = [{
    path: '.', type: 'directory', size: Number(rootStat.size),
    mtimeNs: rootStat.mtimeNs.toString(), ctimeNs: rootStat.ctimeNs.toString(),
    dev: rootStat.dev.toString(), ino: rootStat.ino.toString(), nlink: Number(rootStat.nlink),
    sha256: null,
  }];
  async function walk(directory, relativeDirectory) {
    const directoryBefore = await fsp.lstat(directory, { bigint: true });
    const names = (await fsp.readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? path.join(relativeDirectory, name) : name;
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        const linkTarget = await fsp.readlink(absolute);
        records.push({
          path: relative, type: 'symlink', size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
          dev: stat.dev.toString(), ino: stat.ino.toString(), nlink: Number(stat.nlink),
          sha256: sha256Bytes(Buffer.from(linkTarget)), linkTarget,
        });
      } else if (stat.isDirectory()) {
        records.push({
          path: relative, type: 'directory', size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
          dev: stat.dev.toString(), ino: stat.ino.toString(), nlink: Number(stat.nlink),
          sha256: null,
        });
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        const hashed = await hashFile(absolute);
        records.push({
          path: relative, type: 'file', size: hashed.physicalSize,
          mtimeNs: hashed.mtimeNs, ctimeNs: hashed.ctimeNs,
          dev: hashed.dev, ino: hashed.ino, nlink: Number(stat.nlink), sha256: hashed.sha256,
        });
      } else {
        records.push({
          path: relative, type: 'other', size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
          dev: stat.dev.toString(), ino: stat.ino.toString(), nlink: Number(stat.nlink),
          sha256: null,
        });
      }
    }
    const directoryAfter = await fsp.lstat(directory, { bigint: true });
    if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
        || directoryBefore.mtimeNs !== directoryAfter.mtimeNs
        || directoryBefore.ctimeNs !== directoryAfter.ctimeNs) {
      throw typedError('target_changed_concurrently');
    }
  }
  await walk(root, '');
  return records.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
}

async function readSourceRevision(canonicalRoot) {
  const manifestPath = path.join(canonicalRoot, 'memory-manifest.json');
  try {
    const manifest = await readJson(manifestPath, { maxBytes: 1024 * 1024 });
    return {
      authority: 'manifest-v1',
      generation: manifest.generation ?? null,
      revision: manifest.currentRevision ?? null,
      deltaEpoch: manifest.activeDeltaEpoch ?? null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT' && error?.cause?.code !== 'ENOENT') {
      const exists = await fsp.lstat(manifestPath).then(() => true, (failure) => {
        if (failure.code === 'ENOENT') return false;
        throw failure;
      });
      if (exists) throw typedError('source_manifest_invalid', error.message, { cause: error });
    }
    const snapshotPath = path.join(canonicalRoot, 'brain-snapshot.json');
    const snapshot = await readJson(snapshotPath, { maxBytes: 16 * 1024 * 1024 }).catch((failure) => {
      if (failure.code === 'ENOENT' || failure?.cause?.code === 'ENOENT') return null;
      throw failure;
    });
    return {
      authority: snapshot ? 'legacy-snapshot-advisory' : 'legacy-unversioned',
      generation: snapshot?.generation ?? null,
      revision: snapshot?.currentRevision ?? snapshot?.revision ?? null,
      deltaEpoch: null,
    };
  }
}

export async function buildBoundaryInventory({ catalog, targetAgent, targetBrain, required } = {}) {
  const target = selectedTarget(catalog, { targetAgent, targetBrain });
  const normalized = await canonicalTarget(target);
  const requiredKinds = required || REQUIRED_BOUNDARIES;
  if (!Array.isArray(requiredKinds)
      || requiredKinds.length !== REQUIRED_BOUNDARIES.length
      || new Set(requiredKinds).size !== REQUIRED_BOUNDARIES.length
      || REQUIRED_BOUNDARIES.some((kind) => !requiredKinds.includes(kind))) {
    throw typedError('boundary_contract_invalid');
  }
  const cache = new Map();
  const records = [];
  for (const kind of REQUIRED_BOUNDARIES) {
    const root = normalized.byKind.get(kind);
    let physical = cache.get(root);
    if (!physical) {
      physical = await scanPhysicalRoot(root);
      cache.set(root, physical);
    }
    for (const record of physical) records.push({ boundary: kind, root, ...record });
  }
  const revision = await readSourceRevision(target.canonicalRoot);
  const stableCheck = [];
  for (const [root] of cache) stableCheck.push([root, await scanPhysicalRoot(root)]);
  for (const [root, second] of stableCheck) {
    if (stableJson(second) !== stableJson(cache.get(root))) throw typedError('target_changed_concurrently');
  }
  const targetIdentity = {
    id: target.id || target.brainId,
    ownerAgent: target.ownerAgent ?? null,
    kind: target.kind,
    lifecycle: target.lifecycle,
    canonicalRoot: target.canonicalRoot,
    catalogRevision: catalog.catalogRevision || catalog.revision || target.catalogRevision || null,
  };
  return Object.freeze({
    schemaVersion: 1,
    target: targetIdentity,
    sourceRevision: revision,
    boundaries: REQUIRED_BOUNDARIES.map((kind) => ({ kind, root: normalized.byKind.get(kind) })),
    records,
    inventoryDigest: inventoryDigest({ target: targetIdentity, sourceRevision: revision, records }),
  });
}

function comparable(receipt) {
  return {
    receiptRunId: receipt.receiptRunId,
    authority: receipt.authority,
    schemaVersion: receipt.schemaVersion,
    target: receipt.target,
    sourceRevision: receipt.sourceRevision,
    boundaries: receipt.boundaries,
    records: receipt.records,
    inventoryDigest: receipt.inventoryDigest,
  };
}

export function compareBoundaryInventories(before, after) {
  if (!before || !after || before.phase !== 'before' || after.phase !== 'after') {
    throw typedError('boundary_compare_invalid');
  }
  if (typeof before.receiptRunId !== 'string' || !before.receiptRunId
      || typeof before.authority !== 'string' || !before.authority
      || before.receiptRunId !== after.receiptRunId
      || before.authority !== after.authority) {
    throw typedError('boundary_authority_mismatch');
  }
  const left = comparable(before);
  const right = comparable(after);
  if (stableJson(left) !== stableJson(right)) {
    throw typedError('target_changed_concurrently', 'target mutation boundaries changed');
  }
  return Object.freeze({
    ok: true,
    unchanged: true,
    target: left.target,
    sourceRevision: left.sourceRevision,
    inventoryDigest: left.inventoryDigest,
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseCli(argv);
  const phase = one(values, 'phase', { required: true });
  const context = await receiptContext(values, env);
  if (phase === 'compare') {
    const before = await readJson(path.resolve(one(values, 'before', { required: true })));
    const after = await readJson(path.resolve(one(values, 'after', { required: true })));
    const compared = compareBoundaryInventories(before, after);
    const row = canonicalReceiptRow(context, { helper: 'hash-brain-boundaries', phase, ...compared });
    const output = one(values, 'output');
    if (output) await writeJsonReceipt(context, path.resolve(output), { helper: 'hash-brain-boundaries', phase, ...compared });
    else process.stdout.write(`${JSON.stringify(row)}\n`);
    return row;
  }
  if (!['before', 'after'].includes(phase)) throw typedError('invalid_phase');
  const catalogPath = path.resolve(one(values, 'catalog', { required: true }));
  const catalog = await readJson(catalogPath);
  const requireKinds = String(one(values, 'require', { defaultValue: REQUIRED_BOUNDARIES.join(',') }))
    .split(',').filter(Boolean);
  const inventory = await buildBoundaryInventory({
    catalog,
    targetAgent: one(values, 'target-agent'),
    targetBrain: one(values, 'target-brain'),
    required: requireKinds,
  });
  const output = path.resolve(one(values, 'output', { required: true }));
  return writeJsonReceipt(context, output, {
    helper: 'hash-brain-boundaries',
    phase,
    catalogPath,
    ...inventory,
  });
}

if (isMain(import.meta.url)) main().catch(failCli);
