class ArtifactLifecycleManager {
  constructor(options = {}) {
    this.registry = options.registry;
    this.logger = options.logger || console;
  }

  async transition(artifactId, toState, options = {}) {
    if (!this.registry) throw new Error('ArtifactLifecycleManager requires a registry');
    const record = this.registry.getArtifact(artifactId);
    if (!record) throw new Error(`Artifact not found: ${artifactId}`);

    const fromState = record.lifecycleState || 'registered';
    const event = {
      artifactId,
      fromState,
      toState,
      changedAt: new Date().toISOString(),
      changedBy: options.changedBy || 'system',
      reason: options.reason || null,
      evidence: options.evidence || {
        supportingArtifacts: [],
        supportingClaims: [],
        validationResults: []
      }
    };

    const history = Array.isArray(record.lifecycleTransitions)
      ? [...record.lifecycleTransitions, event]
      : [event];

    return this.registry.updateArtifact(artifactId, {
      lifecycleState: toState,
      lifecycleTransitions: history
    });
  }

  async supersede(oldArtifactId, newArtifactId, options = {}) {
    if (!this.registry) throw new Error('ArtifactLifecycleManager requires a registry');
    const oldRecord = this.registry.getArtifact(oldArtifactId);
    const newRecord = this.registry.getArtifact(newArtifactId);
    if (!oldRecord) throw new Error(`Artifact not found: ${oldArtifactId}`);
    if (!newRecord) throw new Error(`Artifact not found: ${newArtifactId}`);

    const updatedNew = await this.registry.updateArtifact(newArtifactId, {
      supersedes: mergeLinkSet(newRecord.supersedes, { artifactIds: [oldArtifactId] })
    });

    const updatedOld = await this.transition(oldArtifactId, 'superseded', {
      changedBy: options.changedBy || 'system',
      reason: options.reason || `Superseded by ${newArtifactId}`,
      evidence: options.evidence || {
        supportingArtifacts: [newArtifactId],
        supportingClaims: [],
        validationResults: []
      }
    });

    await this.registry.updateArtifact(oldArtifactId, {
      ...updatedOld,
      supersededBy: newArtifactId
    });

    await this.writeSupersessionEdge(oldArtifactId, newArtifactId);

    return {
      oldArtifact: this.registry.getArtifact(oldArtifactId),
      newArtifact: updatedNew
    };
  }

  async markReused(artifactId, options = {}) {
    const updated = await this.transition(artifactId, 'reused', {
      changedBy: options.changedBy || 'system',
      reason: options.reason || 'Artifact was consumed by a later task',
      evidence: {
        supportingArtifacts: options.supportingArtifacts || [],
        supportingClaims: options.supportingClaims || [],
        validationResults: options.validationResults || []
      }
    });
    if (options.taskId) {
      await this.writeConsumptionEdge(options.taskId, artifactId).catch((error) => {
        this.logger?.debug?.('[ArtifactLifecycle] TASK_CONSUMED edge skipped', {
          taskId: options.taskId,
          artifactId,
          error: error.message
        });
      });
    }
    return updated;
  }

  async promoteCommitted(artifactId, options = {}) {
    const record = this.registry.getArtifact(artifactId);
    if (!record) throw new Error(`Artifact not found: ${artifactId}`);

    const validationResults = options.validationResults || [];
    const hasValidation = Array.isArray(validationResults) && validationResults.length > 0;
    const hasReuse = record.lifecycleState === 'reused' ||
      (Array.isArray(record.lifecycleTransitions) && record.lifecycleTransitions.some(t => t.toState === 'reused'));

    if (!hasReuse && !hasValidation && !options.force) {
      throw new Error(`Cannot promote ${artifactId} to committed without causal reuse or validation evidence`);
    }

    return this.transition(artifactId, 'committed', {
      changedBy: options.changedBy || 'system',
      reason: options.reason || (hasReuse ? 'Promoted after causal reuse' : 'Promoted with validation evidence'),
      evidence: {
        supportingArtifacts: options.supportingArtifacts || [],
        supportingClaims: options.supportingClaims || [],
        validationResults
      }
    });
  }

  async writeSupersessionEdge(oldArtifactId, newArtifactId) {
    const memory = this.registry?.memory;
    if (!memory || typeof memory.addEdge !== 'function') return;
    const oldNode = await this.registry.findNodeByTag?.(`artifact_${oldArtifactId}`);
    const newNode = await this.registry.findNodeByTag?.(`artifact_${newArtifactId}`);
    if (!oldNode?.id || !newNode?.id) return;
    let edgeType = 'artifact_supersedes';
    try {
      edgeType = require('../memory/network-memory').NetworkMemory.EDGE_TYPES.ARTIFACT_SUPERSEDES;
    } catch (_) {}
    memory.addEdge(newNode.id, oldNode.id, 0.95, edgeType);
  }

  async writeConsumptionEdge(taskId, artifactId) {
    const memory = this.registry?.memory;
    if (!memory || typeof memory.addEdge !== 'function') return;

    const artifactNode = await this.registry.findNodeByTag?.(`artifact_${artifactId}`);
    if (!artifactNode?.id) return;

    let taskNode = await this.registry.findNodeByTag?.(`task_${taskId}`);
    if (!taskNode && typeof memory.addNode === 'function') {
      taskNode = await memory.addNode(`[TASK:${taskId}] Artifact-consuming task`, `task_${taskId}`, null, {
        type: 'task',
        taskId
      });
    }
    if (!taskNode?.id) return;

    let edgeType = 'task_consumed';
    try {
      edgeType = require('../memory/network-memory').NetworkMemory.EDGE_TYPES.TASK_CONSUMED;
    } catch (_) {}
    memory.addEdge(taskNode.id, artifactNode.id, 0.9, edgeType);
  }
}

function mergeLinkSet(existing = {}, additions = {}) {
  const fields = ['artifactIds', 'memoryNodeIds', 'taskIds', 'claimIds'];
  const merged = {};
  for (const field of fields) {
    merged[field] = Array.from(new Set([
      ...(Array.isArray(existing[field]) ? existing[field] : []),
      ...(Array.isArray(additions[field]) ? additions[field] : [])
    ]));
  }
  return merged;
}

module.exports = { ArtifactLifecycleManager };
