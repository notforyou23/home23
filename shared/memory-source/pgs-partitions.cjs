'use strict';

const crypto = require('node:crypto');
const { throwIfAborted } = require('./contracts.cjs');

const DEFAULT_MAX_PARTITIONS = 10_000;
const DEFAULT_MAX_NODES_PER_WORK_UNIT = 250;

function typed(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function safeScalar(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || Number.isSafeInteger(value);
}

function recordId(record) {
  const value = record?.id ?? record?.nodeId ?? record?.key;
  if (!safeScalar(value)) throw typed('source_invalid', 'PGS node record has invalid identity');
  return String(value);
}

function partitionIdForNode(node, id) {
  const candidate = node.clusterId ?? node.cluster ?? node.partitionId;
  if (safeScalar(candidate) && /^[A-Za-z0-9._-]+$/.test(String(candidate))) {
    return `c-${String(candidate)}`;
  }
  if (safeScalar(candidate)) {
    return `c-x${crypto.createHash('sha256').update(String(candidate)).digest('hex').slice(0, 16)}`;
  }
  const hash = crypto.createHash('sha256').update(String(id)).digest('hex');
  return `h-${Number(BigInt(`0x${hash.slice(0, 16)}`) % 256n)}`;
}

async function listPgsPartitions(source, options = {}) {
  const maxPartitions = options.maxPartitions ?? DEFAULT_MAX_PARTITIONS;
  const maxNodesPerWorkUnit = options.maxNodesPerWorkUnit ?? DEFAULT_MAX_NODES_PER_WORK_UNIT;
  if (!Number.isSafeInteger(maxPartitions) || maxPartitions < 1 || maxPartitions > 10_000
      || !Number.isSafeInteger(maxNodesPerWorkUnit)
      || maxNodesPerWorkUnit < 1 || maxNodesPerWorkUnit > 10_000) {
    throw typed('invalid_request', 'PGS partition inventory limits are invalid');
  }
  const counts = new Map();
  let totalNodes = 0;
  for await (const node of source.iterateNodes({ signal: options.signal })) {
    throwIfAborted(options.signal);
    const id = recordId(node);
    const partitionId = partitionIdForNode(node, id);
    if (!counts.has(partitionId) && counts.size >= maxPartitions) {
      throw typed('result_too_large', 'PGS partition inventory exceeds its bounded limit');
    }
    counts.set(partitionId, (counts.get(partitionId) || 0) + 1);
    totalNodes += 1;
    if (!Number.isSafeInteger(totalNodes)) {
      throw typed('result_too_large', 'PGS node count exceeds the safe integer range');
    }
  }
  const partitions = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([partitionId, nodeCount]) => ({
      partitionId,
      nodeCount,
      estimatedWorkUnits: Math.ceil(nodeCount / maxNodesPerWorkUnit),
    }));
  const estimatedWorkUnits = partitions.reduce((sum, row) => sum + row.estimatedWorkUnits, 0);
  const evidence = source.getEvidence?.({
    completeCoverage: true,
    authoritativeTotals: { nodes: totalNodes },
    returnedTotals: { nodes: totalNodes },
    limits: { maxPartitions, maxNodesPerWorkUnit },
  }) || null;
  return {
    partitions,
    totalNodes,
    totalPartitions: partitions.length,
    estimatedWorkUnits,
    maxNodesPerWorkUnit,
    complete: true,
    evidence,
  };
}

module.exports = {
  DEFAULT_MAX_NODES_PER_WORK_UNIT,
  DEFAULT_MAX_PARTITIONS,
  listPgsPartitions,
  partitionIdForNode,
};
