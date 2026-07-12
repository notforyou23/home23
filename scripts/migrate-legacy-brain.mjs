#!/usr/bin/env node

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrainOperationsCommand } from '../cli/lib/brain-operations-command.js';
import { booleanFlag, integer, one, parseCli } from './lib/brain-acceptance-common.mjs';

const require = createRequire(import.meta.url);
const {
  DEFAULT_MIN_FREE_BYTES,
  assertLegacyMigrationPreflightCapacity,
  migrateLegacyResidentToManifest,
  resolveMemorySourceSelection,
} = require('../shared/memory-source');

function validAgent(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
    throw Object.assign(new Error('agent_invalid'), { code: 'agent_invalid' });
  }
  return value;
}

async function sourceBytes(selection) {
  let bytes = 0n;
  for (const entry of selection.targetFiles || []) {
    if (!entry.role?.startsWith('legacy-')) continue;
    const stat = await fsp.lstat(entry.path).catch((error) => {
      if (entry.optional && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) bytes += BigInt(stat.size);
  }
  return bytes;
}

export async function runLegacyBrainMigration({
  home23Root,
  agent,
  dryRun = false,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  operationId = `legacy-migration-${crypto.randomUUID()}`,
  commandRunner = runBrainOperationsCommand,
  statfsImpl = fsp.statfs,
  deviceImpl = async (directory) => (await fsp.stat(directory, { bigint: true })).dev,
} = {}) {
  const canonicalHome = await fsp.realpath(home23Root);
  const targetAgent = validAgent(agent);
  const brainDir = await fsp.realpath(path.join(canonicalHome, 'instances', targetAgent, 'brain'));
  const active = await commandRunner(canonicalHome, [
    'list', '--state', 'nonterminal', '--all-requesters',
  ]);
  if (!active || !Array.isArray(active.operations) || active.count !== active.operations.length) {
    throw Object.assign(new Error('brain_operations_store_invalid'), {
      code: 'brain_operations_store_invalid',
    });
  }
  if (active.count !== 0) {
    throw Object.assign(new Error('brain_operations_active'), {
      code: 'brain_operations_active',
      activeOperations: active.count,
    });
  }
  const selection = await resolveMemorySourceSelection(brainDir);
  if (dryRun) {
    if (!['legacy-resident-sidecars', 'manifest-v1'].includes(selection.authority)) {
      throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    }
    const inputBytes = selection.authority === 'legacy-resident-sidecars'
      ? await sourceBytes(selection)
      : 0n;
    const capacity = await assertLegacyMigrationPreflightCapacity({
      brainDir,
      scratchDir: canonicalHome,
      sourceBytes: inputBytes,
      minFreeBytes,
      statfsImpl,
      deviceImpl,
    });
    return {
      ok: true,
      dryRun: true,
      agent: targetAgent,
      brainDir,
      authority: selection.authority,
      activeOperations: active.count,
      inputBytes: inputBytes.toString(),
      sharedFilesystem: capacity.sharedFilesystem,
      targetAvailableBytes: capacity.targetAvailable.toString(),
      scratchAvailableBytes: capacity.scratchAvailable.toString(),
      targetRequiredBytes: capacity.targetRequired.toString(),
      scratchRequiredBytes: capacity.scratchRequired.toString(),
      ready: true,
    };
  }

  const result = await migrateLegacyResidentToManifest({
    brainDir,
    home23Root: canonicalHome,
    requesterAgent: targetAgent,
    operationId,
    minFreeBytes,
    statfsImpl,
    deviceImpl,
  });
  return {
    ok: true,
    dryRun: false,
    agent: targetAgent,
    brainDir,
    activeOperations: active.count,
    ...result,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseCli(argv);
  const receipt = await runLegacyBrainMigration({
    home23Root: path.resolve(one(values, 'home23-root', { required: true })),
    agent: one(values, 'agent', { required: true }),
    dryRun: booleanFlag(values, 'dry-run'),
    minFreeBytes: integer(values, 'min-free-bytes', {
      defaultValue: DEFAULT_MIN_FREE_BYTES,
      min: 0,
    }),
    operationId: one(values, 'operation-id', {
      defaultValue: `legacy-migration-${crypto.randomUUID()}`,
    }),
  });
  const encoded = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(encoded) > 64 * 1024) {
    throw Object.assign(new Error('receipt_too_large'), { code: 'receipt_too_large' });
  }
  process.stdout.write(encoded);
  return receipt;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error.code || 'migration_failed',
    message: error.message,
  })}\n`);
  process.exitCode = 1;
});
