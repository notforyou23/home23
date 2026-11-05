/**
 * Action: prune_stale_cluster
 * Marks low-activation nodes in a cluster as stale. Does NOT delete. A
 * subsequent memory audit pass can review the stale-flagged nodes and
 * purge them if the user confirms.
 *
 * Target: cluster id (number or string). If omitted, picks the lowest-activation
 * cluster found.
 */

async function run({ action, target, memory, logger }) {
  if (!memory) {
    return { status: 'rejected', detail: 'memory not provided' };
  }
  if (typeof memory.getClusters !== 'function' && typeof memory.listClusters !== 'function') {
    return { status: 'rejected', detail: 'memory does not expose cluster enumeration' };
  }
  const getClusters = memory.getClusters || memory.listClusters;

  let clusters;
  try {
    clusters = await getClusters.call(memory);
  } catch (err) {
    return { status: 'rejected', detail: `cluster fetch failed: ${err.message}` };
  }
  if (!Array.isArray(clusters) || clusters.length === 0) {
    return { status: 'rejected', detail: 'no clusters available' };
  }

  let cluster;
  if (target != null) {
    cluster = clusters.find(c => String(c.id) === String(target));
    if (!cluster) return { status: 'rejected', detail: `cluster ${target} not found` };
  } else {
    // Pick lowest-activation cluster
    cluster = clusters.reduce((lo, c) => {
      const a = typeof c.activation === 'number' ? c.activation : 0;
      const loA = typeof lo?.activation === 'number' ? lo.activation : Infinity;
      return a < loA ? c : lo;
    }, null);
  }

  const nodes = cluster?.nodes || cluster?.nodeIds || [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { status: 'rejected', detail: 'cluster has no nodes' };
  }

  // Mark each node's `stale` flag. If memory doesn't support updateNode, abort.
  if (typeof memory.updateNode !== 'function' && typeof memory.tagNode !== 'function') {
    return { status: 'rejected', detail: 'memory has no updateNode/tagNode method' };
  }
  const update = memory.updateNode || memory.tagNode;

  const flagged = [];
  for (const nid of nodes) {
    try {
      await update.call(memory, nid, { stale: true, stale_flagged_at: new Date().toISOString() });
      flagged.push(nid);
    } catch { /* skip */ }
  }

  return {
    status: 'success',
    detail: `flagged ${flagged.length}/${nodes.length} nodes stale in cluster ${cluster.id}`,
    memoryDelta: { flagged_stale: flagged.length, cluster: cluster.id },
  };
}

module.exports = { run };
