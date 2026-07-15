'use strict';

function createDescriptor(canonicalRoot, manifest) {
  // The operation descriptor is a portable numeric-v1 source selector, not a
  // copy of private manifest validation state. Keep chain/file identities in
  // the coordinator-owned pinned manifest while exposing only the stable
  // descriptor contract accepted by workers and clients.
  const activeDelta = manifest.activeDelta;
  const projectBaseEntry = (entry) => Object.freeze({
    file: entry.file,
    count: entry.count,
    bytes: entry.bytes,
  });
  return Object.freeze({
    version: 1,
    canonicalRoot,
    generation: manifest.generation,
    baseRevision: manifest.baseRevision,
    cutoffRevision: manifest.currentRevision,
    activeBase: Object.freeze({
      nodes: projectBaseEntry(manifest.activeBase.nodes),
      edges: projectBaseEntry(manifest.activeBase.edges),
    }),
    activeDelta: Object.freeze({
      epoch: activeDelta.epoch,
      file: activeDelta.file,
      fromRevision: activeDelta.fromRevision,
      toRevision: activeDelta.toRevision,
      count: activeDelta.count,
      committedBytes: activeDelta.committedBytes,
    }),
    summary: Object.freeze({
      nodeCount: manifest.summary.nodeCount,
      edgeCount: manifest.summary.edgeCount,
      clusterCount: manifest.summary.clusterCount,
    }),
  });
}

module.exports = { createDescriptor };
