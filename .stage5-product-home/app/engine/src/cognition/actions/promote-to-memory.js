/**
 * Action: promote_to_memory
 * Creates a durable memory node from an insight the cycle wants to preserve.
 * Writes via memory.addNode() if available. Tag defaults to 'agent_promoted'
 * unless action.tag is specified.
 */

async function run({ action, memory, cycle, role, logger, artifactRegistry }) {
  const content = action.content || action.body || action.insight;
  if (!content || typeof content !== 'string' || content.trim().length < 10) {
    return { status: 'rejected', detail: 'action.content required (min 10 chars)' };
  }
  if (!memory || typeof memory.addNode !== 'function') {
    return { status: 'rejected', detail: 'memory.addNode not available' };
  }

  const tag = action.tag || 'agent_promoted';
  try {
    const node = await memory.addNode(content.trim(), tag);
    let artifact = null;
    if (artifactRegistry && typeof artifactRegistry.registerMemoryArtifact === 'function') {
      artifact = await artifactRegistry.registerMemoryArtifact({
        content: content.trim(),
        memoryNodeId: node?.id || null,
        tag,
        role,
        cycle,
        producer: 'promote_to_memory',
        kind: 'memory_promotion',
        status: 'committed',
        goalId: action.goalId || null,
        taskId: action.taskId || null,
        derivedFrom: Array.isArray(action.derivedFrom) ? action.derivedFrom : []
      });
      if (artifact?.memoryMirrorNodeId && node?.id && typeof memory.addEdge === 'function') {
        memory.addEdge(artifact.memoryMirrorNodeId, node.id, 0.8, 'artifact_promoted_to_memory');
      }
    }
    return {
      status: 'success',
      detail: `promoted (tag=${tag})`,
      memoryDelta: { added_node: node?.id || true, tag, artifactId: artifact?.id || null },
    };
  } catch (err) {
    return { status: 'rejected', detail: `addNode failed: ${err.message}` };
  }
}

module.exports = { run };
