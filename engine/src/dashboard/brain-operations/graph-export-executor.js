'use strict';

const crypto = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { promises: fsp } = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
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

function createGraphExportExecutor() {
  return async function graphExportExecutor(context) {
    throwIfAborted(context.signal);
    assertNoForbiddenParameters(context.parameters || {});
    if (!context.sourcePin || context.sourcePin.descriptor?.canonicalRoot !== context.target?.canonicalRoot) {
      throw memorySourceError('source_changed', 'source pin does not match target', { retryable: true });
    }
    const scratchDir = await fsp.realpath(context.scratchDir);
    const resultsDir = path.join(scratchDir, 'results');
    await fsp.mkdir(resultsDir, { recursive: true, mode: 0o700 });
    const base = path.join(resultsDir, `graph-${context.operationId}.jsonl`);
    const tmp = `${base}.tmp`;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let nodeCount = 0;
    let edgeCount = 0;
    const stream = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    let completed = false;
    try {
      for await (const record of context.sourcePin.iterateNodes({ signal: context.signal })) {
        const line = `${JSON.stringify({ type: 'node', record })}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        await context.scratchQuota?.claim?.(size);
        await writeLine(stream, line, context.signal);
        hash.update(line);
        bytes += size;
        nodeCount += 1;
      }
      for await (const record of context.sourcePin.iterateEdges({ signal: context.signal })) {
        const line = `${JSON.stringify({ type: 'edge', record })}\n`;
        const size = Buffer.byteLength(line, 'utf8');
        await context.scratchQuota?.claim?.(size);
        await writeLine(stream, line, context.signal);
        hash.update(line);
        bytes += size;
        edgeCount += 1;
      }
      stream.end();
      await once(stream, 'finish');
      await fsp.rename(tmp, base);
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
        stream.destroy();
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    }
  };
}

module.exports = { createGraphExportExecutor };
