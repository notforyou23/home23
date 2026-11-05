function nodeText(node) {
  return String(node?.concept || node?.content || node?.text || '').trim();
}

function nodeTag(node) {
  return String(node?.tag || 'untagged');
}

function isConsolidatedSummary(node) {
  return nodeTag(node) === 'consolidated';
}

function nodeList(memory) {
  if (memory?.nodes instanceof Map) return Array.from(memory.nodes.values());
  if (Array.isArray(memory?.nodes)) return memory.nodes;
  return [];
}

function countByTag(nodes) {
  return nodes.reduce((acc, node) => {
    const tag = nodeTag(node);
    acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {});
}

function previewNodes(nodes, limit) {
  return nodes.slice(0, limit).map(node => ({
    id: String(node.id),
    tag: node.tag || null,
    preview: nodeText(node).slice(0, 180),
  }));
}

function describeGroup(consolidatedAt, summaries, sources, options = {}) {
  const sourcePreviewLimit = Number.isFinite(options.sourcePreviewLimit)
    ? Math.max(0, options.sourcePreviewLimit)
    : 5;
  return {
    consolidatedAt,
    summaryIds: summaries.map(node => String(node.id)),
    sourceCount: sources.length,
    sourceIds: sources.map(node => String(node.id)),
    sourceTagCounts: countByTag(sources),
    sourceSamples: previewNodes(sources, sourcePreviewLimit),
    summaryPreview: nodeText(summaries[0] || {}).slice(0, 240),
  };
}

function describeBlockedGroup(consolidatedAt, summaries, sources, options = {}) {
  const sourcePreviewLimit = Number.isFinite(options.sourcePreviewLimit)
    ? Math.max(0, options.sourcePreviewLimit)
    : 5;
  const includeSourceIds = Boolean(options.includeBlockedSourceIds);
  return {
    consolidatedAt,
    summaryIds: summaries.map(node => String(node.id)),
    summaryCount: summaries.length,
    sourceCount: sources.length,
    ...(includeSourceIds
      ? { sourceIds: sources.map(node => String(node.id)) }
      : { sourceIdsSample: sources.slice(0, sourcePreviewLimit).map(node => String(node.id)) }),
    sourceTagCounts: countByTag(sources),
  };
}

function describeOrphanGroup(consolidatedAt, sources, options = {}) {
  return describeBlockedGroup(consolidatedAt, [], sources, options);
}

function planConsolidationBacklogCompost(memory, options = {}) {
  const groups = new Map();
  for (const node of nodeList(memory)) {
    const consolidatedAt = node?.consolidatedAt;
    if (!consolidatedAt) continue;
    const key = String(consolidatedAt);
    if (!groups.has(key)) groups.set(key, { summaries: [], sources: [] });
    if (isConsolidatedSummary(node)) {
      groups.get(key).summaries.push(node);
    } else {
      groups.get(key).sources.push(node);
    }
  }

  const groupLimit = Number.isFinite(options.groupLimit)
    ? Math.max(0, options.groupLimit)
    : Infinity;
  const removable = [];
  const ambiguous = [];
  const orphan = [];
  let summaryNodes = 0;
  let sourceNodes = 0;

  for (const [consolidatedAt, group] of Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const { summaries, sources } = group;
    summaryNodes += summaries.length;
    sourceNodes += sources.length;
    if (sources.length === 0) continue;
    if (summaries.length === 1) {
      removable.push(describeGroup(consolidatedAt, summaries, sources, options));
    } else if (summaries.length > 1) {
      ambiguous.push(describeBlockedGroup(consolidatedAt, summaries, sources, options));
    } else {
      orphan.push(describeOrphanGroup(consolidatedAt, sources, options));
    }
  }

  const limitedGroups = removable.slice(0, groupLimit);
  return {
    ok: true,
    mode: 'dry-run',
    totalGroups: groups.size,
    summaryNodes,
    sourceNodes,
    removableGroups: removable.length,
    removableSourceNodes: removable.reduce((sum, group) => sum + group.sourceCount, 0),
    ambiguousGroups: ambiguous.length,
    ambiguousSourceNodes: ambiguous.reduce((sum, group) => sum + group.sourceCount, 0),
    orphanSourceGroups: orphan.length,
    orphanSourceNodes: orphan.reduce((sum, group) => sum + group.sourceCount, 0),
    outputLimited: limitedGroups.length < removable.length,
    groups: limitedGroups,
    ambiguousSamples: ambiguous.slice(0, Number.isFinite(options.ambiguousLimit) ? Math.max(0, options.ambiguousLimit) : 20),
    orphanSamples: orphan.slice(0, Number.isFinite(options.orphanLimit) ? Math.max(0, options.orphanLimit) : 20),
    safety: {
      deletionEnabled: false,
      removableRule: 'Only groups with exactly one consolidated summary and one or more source nodes sharing the same consolidatedAt timestamp are reported as removable.',
      blockedRule: 'Groups with multiple summaries or no summaries are reported but not deletion candidates because exact summary-to-source lineage is not present.',
    },
  };
}

function removeNodeById(memory, rawId) {
  const candidates = [rawId];
  if (/^\d+$/.test(String(rawId))) candidates.push(Number(rawId));
  for (const id of candidates) {
    if (memory.removeNode(id)) return true;
  }
  return false;
}

function applyConsolidationBacklogCompost(memory, plan) {
  if (!memory?.nodes || typeof memory.removeNode !== 'function') {
    return { removed: 0, failed: [{ reason: 'memory graph not available' }] };
  }

  const failed = [];
  const removedIds = [];
  for (const group of plan?.groups || []) {
    if (!Array.isArray(group.summaryIds) || group.summaryIds.length !== 1) {
      failed.push({
        consolidatedAt: group.consolidatedAt || null,
        reason: 'group is not exact single-summary removable',
      });
      continue;
    }
    for (const id of group.sourceIds || []) {
      try {
        if (removeNodeById(memory, id)) {
          removedIds.push(String(id));
        } else {
          failed.push({ id: String(id), reason: 'removeNode returned false' });
        }
      } catch (error) {
        failed.push({ id: String(id), reason: error.message });
      }
    }
  }

  return {
    removed: removedIds.length,
    removedIds,
    failed,
    blocked: {
      ambiguousGroups: plan?.ambiguousGroups || 0,
      ambiguousSourceNodes: plan?.ambiguousSourceNodes || 0,
      orphanSourceGroups: plan?.orphanSourceGroups || 0,
      orphanSourceNodes: plan?.orphanSourceNodes || 0,
    },
  };
}

module.exports = {
  applyConsolidationBacklogCompost,
  planConsolidationBacklogCompost,
};
