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

const DEFAULT_MIN_PARTITION_NODES = 40;
const DEFAULT_SMALL_PARTITION_BUCKETS = 16;

// Community detection can produce thousands of tiny communities (jerry:
// 1,834 partitions, 1,661 of them <=5 nodes, 2026-07-17). PGS builds at least
// one full LLM sweep PER partition, so a single query ballooned to 2,694
// sweeps. This folds every sub-threshold partition into a bounded set of
// shared "c-small-<bucket>" partitions — large communities (real threads)
// keep their own partition; only fringe islands are grouped. The projection
// and the inventory both apply this remap so they never disagree.
//
// Returns Map<oldPartitionId, newPartitionId> containing ONLY partitions that
// move. Deterministic (bucket = hash(partitionId) mod bucketCount).
function planPartitionCoarsening(partitionCounts, options = {}) {
  const minNodes = Number(options.minPartitionNodes) || DEFAULT_MIN_PARTITION_NODES;
  const rawBuckets = Number(options.smallPartitionBuckets) || DEFAULT_SMALL_PARTITION_BUCKETS;
  const buckets = Math.max(1, Math.min(256, rawBuckets));
  const remap = new Map();
  const rows = partitionCounts instanceof Map
    ? Array.from(partitionCounts, ([partitionId, nodeCount]) => ({ partitionId, nodeCount }))
    : Array.from(partitionCounts || []);
  const small = rows.filter(({ partitionId, nodeCount }) =>
    safeScalar(partitionId) && Number.isSafeInteger(nodeCount) && nodeCount < minNodes);
  // Only coarsen a genuine explosion: folding N small partitions into B buckets
  // reduces the count by (N - min(N,B)), so it is worthless unless N > B. This
  // guard leaves normal brains (a handful of small clusters) exactly as-is and
  // only reshapes the community-detection blowup (jerry: 1,661 islands).
  if (small.length <= buckets) return remap;
  for (const { partitionId } of small) {
    const bucket = Number(
      BigInt(`0x${crypto.createHash('sha256').update(String(partitionId)).digest('hex').slice(0, 16)}`)
      % BigInt(buckets),
    );
    remap.set(partitionId, `c-small-${bucket}`);
  }
  return remap;
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
  // Coarsen sub-threshold partitions so the inventory matches what the
  // projection will actually build (fewer, bigger partitions → far fewer
  // sweeps). Uses the completed per-partition counts (global view).
  const coarsenMap = options.coarsen === false
    ? new Map()
    : planPartitionCoarsening(counts, {
      minPartitionNodes: options.minPartitionNodes,
      smallPartitionBuckets: options.smallPartitionBuckets,
    });
  const coarsened = new Map();
  for (const [partitionId, nodeCount] of counts) {
    const target = coarsenMap.get(partitionId) || partitionId;
    coarsened.set(target, (coarsened.get(target) || 0) + nodeCount);
  }
  const partitions = [...coarsened.entries()]
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
  DEFAULT_MIN_PARTITION_NODES,
  DEFAULT_SMALL_PARTITION_BUCKETS,
  listPgsPartitions,
  planPartitionCoarsening,
  partitionIdForNode,
};
