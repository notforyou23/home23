const fs = require('node:fs');
const path = require('node:path');
const { readSnapshot } = require('./brain-snapshot');
const { readMemorySidecars, sidecarsExist } = require('./memory-sidecar');
const { StateCompression } = require('./state-compression');

async function countSidecarNodes(brainDir) {
  const nodeIds = new Set();
  let anonymousCount = 0;
  await readMemorySidecars(brainDir, {
    onNode: (node) => {
    if (node?.id !== undefined) nodeIds.add(node.id);
    else anonymousCount += 1;
    },
  });
  return nodeIds.size + anonymousCount;
}

async function resolveKnownGoodNodeCount(brainDir, statePath, options = {}) {
  const snapshotReader = options.readSnapshot || readSnapshot;
  const stateLoader = options.loadCompressed || StateCompression.loadCompressed;
  const sidecarCounter = options.countSidecarNodes || countSidecarNodes;
  const sidecarExists = options.sidecarsExist || sidecarsExist;
  const hasManifest = fs.existsSync(path.join(brainDir, 'memory-manifest.json'));

  if (hasManifest && sidecarExists(brainDir)) {
    const sidecarCount = await sidecarCounter(brainDir);
    if (Number.isFinite(sidecarCount) && sidecarCount > 0) {
      return { count: sidecarCount, source: 'memory-manifest' };
    }
  }

  const sidecar = snapshotReader(brainDir);
  if (Number.isFinite(sidecar?.nodeCount)) {
    return { count: sidecar.nodeCount, source: 'snapshot' };
  }

  if (sidecarExists(brainDir)) {
    const sidecarCount = await sidecarCounter(brainDir);
    if (Number.isFinite(sidecarCount) && sidecarCount > 0) {
      return { count: sidecarCount, source: 'memory-sidecar' };
    }
  }

  const existingState = await stateLoader(statePath);
  const inlineCount = existingState?.memory?.nodes?.length || 0;
  return { count: inlineCount, source: 'state-file', state: existingState };
}

function evaluateSaveSafety({ currentNodes, existingNodes, source, cycle, dropFloor = 0.5 }) {
  if (existingNodes > 100 && currentNodes < existingNodes * dropFloor) {
    return {
      ok: false,
      reason: 'catastrophic_node_loss',
      currentNodes,
      existingNodes,
      source,
      cycle,
      dropPercent: Number(((1 - currentNodes / existingNodes) * 100).toFixed(1)),
    };
  }

  return {
    ok: true,
    currentNodes,
    existingNodes,
    source,
    cycle,
  };
}

module.exports = {
  countSidecarNodes,
  resolveKnownGoodNodeCount,
  evaluateSaveSafety,
};
