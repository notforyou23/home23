function normalizeNodeId(memory, rawId) {
  if (memory.nodes.has(rawId)) return rawId;
  const text = String(rawId);
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (memory.nodes.has(numeric)) return numeric;
  }
  if (memory.nodes.has(text)) return text;
  return rawId;
}

function edgeEndpoints(key, edge, memory) {
  let source = edge?.source;
  let target = edge?.target;
  if ((source === undefined || target === undefined) && typeof key === 'string') {
    const parts = key.split('->');
    source = parts[0];
    target = parts[1];
  }
  if (source === undefined || target === undefined) return null;
  return [normalizeNodeId(memory, source), normalizeNodeId(memory, target)];
}

class DisjointSet {
  constructor(ids) {
    this.parent = new Map(ids.map(id => [id, id]));
    this.size = new Map(ids.map(id => [id, 1]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const sizeA = this.size.get(rootA) || 1;
    const sizeB = this.size.get(rootB) || 1;
    const [keep, move] = sizeA >= sizeB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(move, keep);
    this.size.set(keep, sizeA + sizeB);
    this.size.delete(move);
  }

  groups() {
    const out = new Map();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      if (!out.has(root)) out.set(root, []);
      out.get(root).push(id);
    }
    return Array.from(out.values());
  }
}

function planMemoryRecluster(memory, options = {}) {
  const nodes = memory?.nodes instanceof Map ? memory.nodes : new Map();
  const edges = memory?.edges instanceof Map ? memory.edges : new Map();
  const bridgeVote = Number(options.bridgeVote ?? memory?.config?.spreading?.bridgeTraversalFactor ?? 0.2);
  const minComponentSize = Math.max(2, Number(options.minComponentSize) || 3);
  const minComponentEdgeWeight = Number(options.minComponentEdgeWeight ?? 0.2);
  const unclustered = new Set();
  const existingClusters = new Map();

  for (const [id, node] of nodes) {
    if (node?.cluster === null || node?.cluster === undefined) {
      unclustered.add(id);
    } else {
      if (!existingClusters.has(node.cluster)) existingClusters.set(node.cluster, new Set());
      existingClusters.get(node.cluster).add(id);
    }
  }

  const votes = new Map();
  const dsu = new DisjointSet(Array.from(unclustered));

  for (const [key, edge] of edges) {
    const endpoints = edgeEndpoints(key, edge, memory);
    if (!endpoints) continue;
    const [source, target] = endpoints;
    const sourceNode = nodes.get(source);
    const targetNode = nodes.get(target);
    if (!sourceNode || !targetNode) continue;

    const vote = edge?.type === 'bridge' ? bridgeVote : 1;
    const noteVote = (nodeId, clusterId) => {
      if (!votes.has(nodeId)) votes.set(nodeId, new Map());
      const nodeVotes = votes.get(nodeId);
      nodeVotes.set(clusterId, (nodeVotes.get(clusterId) || 0) + vote);
    };

    if (unclustered.has(source) && targetNode.cluster !== null && targetNode.cluster !== undefined) {
      noteVote(source, targetNode.cluster);
    }
    if (unclustered.has(target) && sourceNode.cluster !== null && sourceNode.cluster !== undefined) {
      noteVote(target, sourceNode.cluster);
    }

    const weight = Number(edge?.weight ?? 0);
    if (
      unclustered.has(source) &&
      unclustered.has(target) &&
      edge?.type !== 'bridge' &&
      weight >= minComponentEdgeWeight
    ) {
      dsu.union(source, target);
    }
  }

  const existingAssignments = [];
  for (const [nodeId, nodeVotes] of votes) {
    const [cluster, score] = Array.from(nodeVotes.entries()).sort((a, b) => b[1] - a[1])[0];
    existingAssignments.push({ nodeId, cluster, score });
  }

  const assignedToExisting = new Set(existingAssignments.map(a => a.nodeId));
  const newClusterGroups = dsu.groups()
    .map(group => group.filter(id => !assignedToExisting.has(id)))
    .filter(group => group.length >= minComponentSize);
  const assignToNewCount = newClusterGroups.reduce((sum, group) => sum + group.length, 0);

  return {
    unclusteredBefore: unclustered.size,
    wouldAssignToExistingClusters: existingAssignments.length,
    wouldCreateClusters: newClusterGroups.length,
    wouldAssignToNewClusters: assignToNewCount,
    unclusteredAfter: Math.max(0, unclustered.size - existingAssignments.length - assignToNewCount),
    existingAssignments,
    newClusterGroups,
    sampleExisting: existingAssignments.slice(0, 20).map(a => ({
      id: String(a.nodeId),
      cluster: a.cluster,
      score: Math.round(a.score * 100) / 100,
      preview: String(nodes.get(a.nodeId)?.concept || '').slice(0, 160),
    })),
    sampleNewClusters: newClusterGroups.slice(0, 10).map(group => ({
      size: group.length,
      sampleIds: group.slice(0, 8).map(String),
    })),
  };
}

function applyMemoryRecluster(memory, plan) {
  if (!memory?.nodes || !plan) return { assignedToExisting: 0, createdClusters: 0, assignedToNewClusters: 0 };
  if (!(memory.clusters instanceof Map)) memory.clusters = new Map();

  let assignedToExisting = 0;
  for (const assignment of plan.existingAssignments || []) {
    const node = memory.nodes.get(assignment.nodeId);
    if (!node) continue;
    node.cluster = assignment.cluster;
    if (!memory.clusters.has(assignment.cluster)) memory.clusters.set(assignment.cluster, new Set());
    memory.clusters.get(assignment.cluster).add(assignment.nodeId);
    if (typeof memory.markNodeDirty === 'function') memory.markNodeDirty(assignment.nodeId);
    assignedToExisting++;
  }

  let createdClusters = 0;
  let assignedToNewClusters = 0;
  for (const group of plan.newClusterGroups || []) {
    const clusterId = memory.nextClusterId++;
    memory.clusters.set(clusterId, new Set());
    createdClusters++;
    for (const nodeId of group) {
      const node = memory.nodes.get(nodeId);
      if (!node || node.cluster !== null && node.cluster !== undefined) continue;
      node.cluster = clusterId;
      memory.clusters.get(clusterId).add(nodeId);
      if (typeof memory.markNodeDirty === 'function') memory.markNodeDirty(nodeId);
      assignedToNewClusters++;
    }
  }

  return { assignedToExisting, createdClusters, assignedToNewClusters };
}

module.exports = {
  applyMemoryRecluster,
  planMemoryRecluster,
};
