'use strict';

const crypto = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { promises: fsp } = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { fsyncDirectory } = require('../../utils/durable-write.js');
const {
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
} = require('./operation-contract.js');
const {
  enrichEvidenceIdentity,
  memorySourceError,
  throwIfAborted,
} = require('../../../../shared/memory-source');

const FORBIDDEN_PARAMETERS = new Set([
  'outputPath', 'resultPath', 'scratchDir', 'requester', 'requesterAgent',
  'operation', 'operationId', 'root', 'canonicalRoot', 'identity', 'target',
  'resultArtifact', 'sourceEvidence', 'evidence',
]);

function assertNoForbiddenParameters(parameters = {}) {
  for (const key of Object.keys(parameters)) {
    if (FORBIDDEN_PARAMETERS.has(key)) {
      throw memorySourceError('invalid_request', 'caller-controlled export path/evidence is forbidden');
    }
  }
  if (parameters.format !== undefined && parameters.format !== 'jsonl') {
    throw memorySourceError('invalid_request', 'graph export supports only jsonl');
  }
}

async function writeLine(stream, line, signal) {
  throwIfAborted(signal);
  if (stream.write(line)) return;
  await once(stream, 'drain');
  throwIfAborted(signal);
}

async function waitForOpen(stream) {
  if (stream.fd !== null) return;
  await Promise.race([
    once(stream, 'open'),
    once(stream, 'error').then(([error]) => { throw error; }),
  ]);
}

async function destroyAndWait(stream) {
  if (stream.destroyed) return;
  const closed = once(stream, 'close').catch(() => {});
  stream.destroy();
  await closed;
}

async function syncFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function trustedScratchDir(context, home23Root) {
  const scratchDir = await fsp.realpath(context.scratchDir);
  if (home23Root) {
    const root = await fsp.realpath(home23Root);
    const expected = path.join(
      root,
      'instances',
      context.requesterAgent,
      'runtime',
      'brain-operations',
      context.operationId,
      'scratch',
    );
    const expectedReal = await fsp.realpath(expected);
    if (scratchDir !== expectedReal) {
      throw memorySourceError('invalid_request', 'graph export scratch directory is not operation-owned');
    }
  }
  return scratchDir;
}

async function claimScratch(context, bytes, usedBytes) {
  if (usedBytes + bytes > OPERATION_RESULT_ARTIFACT_MAX_BYTES) {
    throw memorySourceError('result_too_large', 'graph export artifact exceeds result budget', {
      status: 413,
      retryable: false,
    });
  }
  await context.scratchQuota?.claim?.(bytes, 'graph_export');
  return usedBytes + bytes;
}

function createGraphExportExecutor({ home23Root } = {}) {
  return async function graphExportExecutor(context) {
    throwIfAborted(context.signal);
    assertNoForbiddenParameters(context.parameters || {});
    if (!context.sourcePin || context.sourcePin.descriptor?.canonicalRoot !== context.target?.canonicalRoot) {
      throw memorySourceError('source_changed', 'source pin does not match target', { retryable: true });
    }
    const scratchDir = await trustedScratchDir(context, home23Root);
    const resultsDir = path.join(scratchDir, 'results');
    await fsp.mkdir(resultsDir, { recursive: true, mode: 0o700 });
    const base = path.join(resultsDir, `graph-${context.operationId}.jsonl`);
    const tmp = `${base}.tmp`;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let nodeCount = 0;
    let edgeCount = 0;
    let claimedBytes = 0;
    const stream = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    let completed = false;
    try {
      await waitForOpen(stream);
      for await (const record of context.sourcePin.iterateNodes({ signal: context.signal })) {
        const line = `${JSON.stringify({ type: 'node', record })}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        claimedBytes = await claimScratch(context, size, claimedBytes);
        await writeLine(stream, line, context.signal);
        hash.update(line);
        bytes += size;
        nodeCount += 1;
      }
      for await (const record of context.sourcePin.iterateEdges({ signal: context.signal })) {
        const line = `${JSON.stringify({ type: 'edge', record })}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        claimedBytes = await claimScratch(context, size, claimedBytes);
        await writeLine(stream, line, context.signal);
        hash.update(line);
        bytes += size;
        edgeCount += 1;
      }
      stream.end();
      await once(stream, 'finish');
      await syncFile(tmp);
      throwIfAborted(context.signal);
      await fsp.rename(tmp, base);
      await fsyncDirectory(resultsDir, { strict: true });
      completed = true;
      const evidence = {
        ...enrichEvidenceIdentity(context.sourcePin.getEvidence({
        completeCoverage: true,
        authoritativeTotals: { nodes: nodeCount, edges: edgeCount },
        returnedTotals: { nodes: nodeCount, edges: edgeCount },
      }), context.identity),
        graphExport: {
          nodeCount,
          edgeCount,
          sourceRevision: context.sourcePin.revision,
        },
      };
      return {
        result: null,
        evidence,
        resultArtifact: {
          scratchPath: base,
          mediaType: 'application/x-ndjson',
          contentEncoding: 'identity',
          bytes,
          sha256: hash.digest('hex'),
        },
      };
    } finally {
      if (!completed) {
        await destroyAndWait(stream);
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (claimedBytes > 0) await context.scratchQuota?.release?.(claimedBytes).catch(() => {});
      }
    }
  };
}

module.exports = { createGraphExportExecutor };
