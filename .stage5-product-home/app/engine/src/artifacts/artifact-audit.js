const path = require('path');

class ArtifactAudit {
  constructor(options = {}) {
    this.registry = options.registry;
    this.logger = options.logger || null;
  }

  async run(options = {}) {
    const records = Array.from(this.registry.records.values());
    const files = await this.registry.scanDurableFiles(options);
    const registeredPaths = new Set(
      records
        .filter(r => r.type === 'file' && r.absolutePath)
        .map(r => path.resolve(r.absolutePath))
    );
    const unregistered = files
      .map(f => path.resolve(f))
      .filter(f => !registeredPaths.has(f) && !f.endsWith('artifact-registry.json'));
    const missing = records
      .filter(r => r.type === 'file' && r.absolutePath && r.exists === false)
      .map(r => r.id);
    return {
      status: unregistered.length === 0 && missing.length === 0 ? 'pass' : 'watch',
      registered: records.length,
      files: records.filter(r => r.type === 'file').length,
      memoryArtifacts: records.filter(r => r.type === 'memory').length,
      committed: records.filter(r => r.status === 'committed').length,
      reused: records.filter(r => Array.isArray(r.reusedBy) && r.reusedBy.length > 0).length,
      unregistered: unregistered.slice(0, options.maxUnregistered || 50),
      missing
    };
  }
}

module.exports = { ArtifactAudit };
