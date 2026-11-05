class ArtifactLifecycle {
  constructor(options = {}) {
    this.registry = options.registry;
    this.memory = options.memory || null;
    this.logger = options.logger || null;
  }

  /**
   * Record that an artifact was attached to a downstream mission as
   * predecessor context (see agent-executor.js#enrichMissionWithArtifacts,
   * which calls this for every artifact-aware mission spawn -- i.e. every
   * time, not conditionally on anything happening). Durable bookkeeping
   * ("who has reused this artifact and why") belongs on the artifact
   * registry record itself (registry.markReused() -- reusedBy is asserted
   * on directly by tests/engine/artifacts/artifact-loop.test.js) and stays.
   *
   * This used to also write a permanent `artifact_reuse` memory node on
   * every call. That is the goal machinery equivalent for artifacts: "a
   * loop ticked" (a mission was spawned with predecessor context
   * available) rather than "something happened" (a file was actually
   * produced -- see artifact-registry.js#maybeMirrorToMemory, which is the
   * writer for that). There is no follow-up read of the created node or its
   * edge anywhere in the codebase, so removing the write is a pure
   * reduction in sediment with no downstream loss.
   */
  async markConsumed(artifactId, consumer = {}) {
    return this.registry.markReused(artifactId, consumer);
  }

  async commit(artifactId, metadata = {}) {
    return this.registry.promote(artifactId, 'committed', metadata);
  }

  async linkSupports(sourceArtifactId, targetArtifactId, metadata = {}) {
    const source = this.registry.get(sourceArtifactId);
    const target = this.registry.get(targetArtifactId);
    if (!source || !target) return null;
    source.supports = this.registry.unique([...(source.supports || []), targetArtifactId]);
    source.metadata = { ...(source.metadata || {}), supportMetadata: metadata };
    source.updatedAt = new Date().toISOString();
    this.registry.records.set(source.id, source);
    await this.registry.save();
    if (this.memory && source.memoryMirrorNodeId && target.memoryMirrorNodeId && typeof this.memory.addEdge === 'function') {
      this.memory.addEdge(source.memoryMirrorNodeId, target.memoryMirrorNodeId, 0.65, 'artifact_supports');
    }
    return source;
  }
}

module.exports = { ArtifactLifecycle };
