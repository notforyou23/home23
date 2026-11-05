class ArtifactIngestor {
  constructor(options = {}) {
    this.registry = options.registry;
    this.memory = options.memory || null;
    this.logger = options.logger || null;
  }

  async ingestFile(absPath, context = {}) {
    const record = await this.registry.registerFile({
      absolutePath: absPath,
      status: context.status || 'parsed',
      kind: context.kind,
      ...context
    });
    if (!record) return null;
    await this.extractNodes(record, context);
    return record;
  }

  async extractNodes(record, context = {}) {
    if (!this.memory || typeof this.memory.addNode !== 'function') return [];
    const preview = String(record.preview || '').trim();
    if (!preview) return [];
    const nodes = [];
    const chunks = preview
      .split(/\n{2,}/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, context.maxNodes || 4);
    for (const chunk of chunks) {
      try {
        const node = await this.memory.addNode({
          concept: chunk,
          tag: context.tag || 'artifact_extract',
          type: 'artifact_extract',
          metadata: {
            artifactId: record.id,
            artifactKind: record.kind,
            path: record.relativePath,
            goalId: record.goalId || null,
            taskId: record.taskId || null
          }
        });
        if (node?.id) {
          nodes.push(node.id);
          if (record.memoryMirrorNodeId && typeof this.memory.addEdge === 'function') {
            this.memory.addEdge(record.memoryMirrorNodeId, node.id, 0.4, 'artifact_contains');
          }
        }
      } catch (error) {
        this.logger?.warn?.('[artifact-ingestor] extract node failed', {
          artifactId: record.id,
          error: error.message
        });
      }
    }
    if (nodes.length > 0) {
      record.extractedNodeIds = Array.from(new Set([...(record.extractedNodeIds || []), ...nodes]));
      this.registry.records.set(record.id, record);
      await this.registry.save();
    }
    return nodes;
  }
}

module.exports = { ArtifactIngestor };
