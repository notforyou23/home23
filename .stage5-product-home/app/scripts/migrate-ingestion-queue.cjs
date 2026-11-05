#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  DurableIngestionQueue,
  sha256File,
} = require('../shared/ingestion-durable-queue.cjs');

const args = process.argv.slice(2);
const runPath = valueFor('--run-path');
const apply = args.includes('--apply');
const maxRecords = Number(valueFor('--max-records') || 1000);

if (!runPath || !path.isAbsolute(runPath)) fail('--run-path must be an absolute path');
if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) fail('--max-records must be a positive integer');

const sourcePath = path.join(runPath, 'ingestion-pending.jsonl');
const before = stat(sourcePath, { sha256: true });
if (!apply) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'read-only',
    runPath,
    source: before,
    next: `rerun with --apply --max-records ${maxRecords}`,
  }, null, 2)}\n`);
  process.exit(0);
}

const queue = new DurableIngestionQueue({
  runPath,
  logger: {
    error(message, details) { process.stderr.write(`${message} ${JSON.stringify(details || {})}\n`); },
  },
});

const result = queue.migrateLegacy({ maxRecords });
const after = stat(sourcePath, { sha256: true });
if (before && after && (before.dev !== after.dev || before.ino !== after.ino
  || before.size !== after.size || before.sha256 !== after.sha256)) {
  fail('source queue changed during migration; stop and restore from the external backup');
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'apply',
  runPath,
  sourceUnchanged: true,
  pendingCount: queue.pendingCount,
  ...result,
}, null, 2)}\n`);

function valueFor(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function stat(filePath, { sha256 = false } = {}) {
  try {
    const value = fs.statSync(filePath);
    return {
      dev: String(value.dev),
      ino: String(value.ino),
      size: value.size,
      mtimeMs: value.mtimeMs,
      ...(sha256 ? { sha256: sha256File(filePath) } : {}),
    };
  } catch {
    return null;
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
