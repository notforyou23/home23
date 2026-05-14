const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class ArtifactRegistry {
  constructor(options = {}) {
    this.runDir = options.runDir || options.logsDir || process.cwd();
    this.memory = options.memory || null;
    this.logger = options.logger || console;
    this.registryPath = options.registryPath || path.join(this.runDir, 'coordinator', 'artifact_registry.json');
    this.records = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await this.load();
    this.initialized = true;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
      this.records = new Map(records.filter(r => r?.artifactId).map(r => [r.artifactId, r]));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.('[ArtifactRegistry] Failed to load registry', {
          path: this.registryPath,
          error: error.message
        });
      }
      this.records = new Map();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    const payload = {
      schema: 'cosmo23.graph_native_artifacts.v1',
      updatedAt: new Date().toISOString(),
      artifacts: Array.from(this.records.values()).sort((a, b) => {
        return String(a.artifactId).localeCompare(String(b.artifactId));
      })
    };
    const temp = `${this.registryPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temp, this.registryPath);
  }

  async registerArtifact(input = {}) {
    await this.initialize();

    const absolutePath = this.resolveAbsolutePath(input);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Artifact path is not a file: ${absolutePath}`);
    }

    const hash = await this.hashFile(absolutePath);
    const runId = input.runId || this.inferRunId();
    const producer = this.normalizeProducer(input.producer, input);
    const relativePath = this.normalizeRelativePath(input.path || input.workspacePath || absolutePath);
    const missingBindings = [];
    if (!runId) missingBindings.push('runId');
    if (!input.taskId) missingBindings.push('taskId');
    if (!producer.id) missingBindings.push('producer');

    const artifactId = input.artifactId || this.createArtifactId({
      runId,
      taskId: input.taskId || null,
      producerId: producer.id || 'unknown',
      path: relativePath,
      hash
    });

    const existing = this.records.get(artifactId) || {};
    const now = new Date().toISOString();
    const record = {
      artifactId,
      runId: runId || null,
      taskId: input.taskId || null,
      goalId: input.goalId || null,
      producer,
      path: relativePath,
      workspacePath: input.workspacePath || this.toWorkspacePath(relativePath),
      absolutePath,
      hash,
      sizeBytes: stat.size,
      kind: input.kind || this.inferKind(absolutePath),
      mimeType: input.mimeType || this.inferMimeType(absolutePath),
      createdAt: existing.createdAt || input.createdAt || now,
      updatedAt: now,
      recordedAt: input.recordedAt || now,
      derivedFrom: this.normalizeLinkSet(input.derivedFrom),
      supersedes: this.normalizeLinkSet(input.supersedes),
      supports: this.normalizeLinkSet(input.supports),
      lifecycleState: input.lifecycleState || (missingBindings.length > 0 ? 'orphan_registered' : 'registered'),
      missingBindings,
      reuseContract: input.reuseContract || null,
      graphNodeId: existing.graphNodeId || null,
      parseStatus: existing.parseStatus || 'unparsed',
      registrationWarnings: [
        ...(Array.isArray(existing.registrationWarnings) ? existing.registrationWarnings : []),
        ...(Array.isArray(input.registrationWarnings) ? input.registrationWarnings : [])
      ]
    };

    if (existing.hash && existing.hash !== hash) {
      record.registrationWarnings.push({
        type: 'hash_changed',
        previousHash: existing.hash,
        newHash: hash,
        detectedAt: now
      });
    }

    const graphNodeId = await this.ensureGraphNode(record).catch((error) => {
      this.logger?.debug?.('[ArtifactRegistry] Graph node creation skipped', {
        artifactId,
        error: error.message
      });
      return null;
    });
    if (graphNodeId) record.graphNodeId = graphNodeId;

    this.records.set(artifactId, record);
    await this.save();
    return record;
  }

  getArtifact(artifactId) {
    return this.records.get(artifactId) || null;
  }

  getArtifactByPath(filePath) {
    if (!filePath) return null;
    const normalized = this.normalizeRelativePath(filePath);
    const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : null;
    for (const record of this.records.values()) {
      if (record.path === normalized || record.workspacePath === normalized) return record;
      if (absolute && path.resolve(record.absolutePath || '') === absolute) return record;
    }
    return null;
  }

  getArtifactsByHash(hash) {
    if (!hash) return [];
    return Array.from(this.records.values()).filter(record => record.hash === hash);
  }

  getArtifactsByTask(taskId) {
    if (!taskId) return [];
    return this.listArtifacts({ taskId });
  }

  getArtifactsByProducer(producerId) {
    if (!producerId) return [];
    return this.listArtifacts({ producerId });
  }

  getArtifactsByLifecycle(lifecycleState) {
    if (!lifecycleState) return [];
    return this.listArtifacts({ lifecycleState });
  }

  async updateArtifact(artifactId, patch = {}) {
    await this.initialize();
    const existing = this.records.get(artifactId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      artifactId,
      updatedAt: new Date().toISOString()
    };
    this.records.set(artifactId, updated);
    await this.save();
    return updated;
  }

  listArtifacts(filter = {}) {
    let records = Array.from(this.records.values());
    if (filter.taskId) records = records.filter(r => r.taskId === filter.taskId);
    if (filter.producerId) records = records.filter(r => r.producer?.id === filter.producerId);
    if (filter.lifecycleState) records = records.filter(r => r.lifecycleState === filter.lifecycleState);
    return records;
  }

  listCurrentArtifacts(filter = {}) {
    const excludedStates = new Set(['superseded', 'deprecated', 'archived', 'failed_reuse']);
    return this.listArtifacts(filter).filter(record => !excludedStates.has(record.lifecycleState));
  }

  findReusableArtifacts(query = '', options = {}) {
    const limit = options.limit || 12;
    const includeCandidates = options.includeCandidates !== false;
    const excludeTaskId = options.excludeTaskId || null;
    const goalId = options.goalId || null;
    const tokens = this.tokenize(query);
    const preferredStates = new Set(['committed', 'reused', 'parsed']);
    const candidateStates = new Set(['candidate', 'registered', 'orphan_registered']);

    return this.listCurrentArtifacts()
      .filter(record => {
        if (excludeTaskId && record.taskId === excludeTaskId) return false;
        if (goalId && record.goalId && record.goalId !== goalId) return false;
        if (preferredStates.has(record.lifecycleState)) return true;
        return includeCandidates && candidateStates.has(record.lifecycleState);
      })
      .map(record => ({
        record,
        score: this.scoreArtifactForQuery(record, tokens, { goalId })
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || String(b.record.updatedAt || '').localeCompare(String(a.record.updatedAt || '')))
      .slice(0, limit)
      .map(item => ({
        ...item.record,
        reuseScore: item.score,
        tag: item.record.lifecycleState === 'committed' || item.record.lifecycleState === 'reused'
          ? 'current_committed_artifact'
          : 'current_candidate_artifact'
      }));
  }

  scoreArtifactForQuery(record, tokens = [], options = {}) {
    let score = 0;
    const lifecycleWeights = {
      committed: 10,
      reused: 8,
      parsed: 5,
      candidate: 3,
      registered: 1,
      orphan_registered: 1
    };
    score += lifecycleWeights[record.lifecycleState] || 0;
    if (options.goalId && record.goalId === options.goalId) score += 6;
    if (record.taskId) score += 1;
    if (record.producer?.id && record.producer.id !== 'migration') score += 1;

    const haystack = [
      record.path,
      record.kind,
      record.structured?.title,
      ...(record.structured?.headings || []),
      ...(record.structured?.recommendations || []),
      ...(record.structured?.openQuestions || []),
      ...(record.structured?.canonicalClaims || []).map(claim => claim.text)
    ].filter(Boolean).join(' ').toLowerCase();

    for (const token of tokens) {
      if (haystack.includes(token)) score += 2;
    }

    return score;
  }

  tokenize(value = '') {
    return [...new Set(String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_ -]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 4)
      .slice(0, 40))];
  }

  async hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const data = await fs.readFile(filePath);
    hash.update(data);
    return `sha256:${hash.digest('hex')}`;
  }

  createArtifactId(parts) {
    const stable = JSON.stringify(parts);
    return `artifact_${crypto.createHash('sha1').update(stable).digest('hex').slice(0, 16)}`;
  }

  resolveAbsolutePath(input) {
    const raw = input.absolutePath || input.path || input.workspacePath;
    if (!raw) throw new Error('Artifact registration requires a path');
    if (path.isAbsolute(raw)) return raw;
    if (raw.startsWith('outputs/')) return path.join(this.runDir, raw);
    return path.join(this.runDir, raw);
  }

  normalizeRelativePath(filePath) {
    if (!filePath) return null;
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(this.runDir, filePath);
    const relative = path.relative(this.runDir, absolute);
    return (relative && !relative.startsWith('..'))
      ? relative.split(path.sep).join('/')
      : String(filePath).split(path.sep).join('/');
  }

  toWorkspacePath(relativePath) {
    if (!relativePath) return null;
    return relativePath.startsWith('outputs/') ? relativePath : relativePath;
  }

  inferRunId() {
    const base = path.basename(this.runDir);
    return base || null;
  }

  normalizeProducer(producer = {}, input = {}) {
    return {
      type: producer.type || input.producerType || (input.agentId ? 'agent' : 'system'),
      id: producer.id || input.producerId || input.agentId || null
    };
  }

  normalizeLinkSet(value = {}) {
    if (Array.isArray(value)) {
      return { artifactIds: value, memoryNodeIds: [], taskIds: [], claimIds: [] };
    }
    return {
      artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds : [],
      memoryNodeIds: Array.isArray(value.memoryNodeIds) ? value.memoryNodeIds : [],
      taskIds: Array.isArray(value.taskIds) ? value.taskIds : [],
      claimIds: Array.isArray(value.claimIds) ? value.claimIds : []
    };
  }

  inferMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.md') return 'text/markdown';
    if (ext === '.json') return 'application/json';
    if (ext === '.jsonl') return 'application/x-ndjson';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.txt') return 'text/plain';
    if (ext === '.bib') return 'text/x-bibtex';
    if (ext === '.html') return 'text/html';
    return 'application/octet-stream';
  }

  inferKind(filePath) {
    const name = path.basename(filePath).toLowerCase();
    if (name === 'research_summary.md') return 'research_summary';
    if (name === 'research_findings.json') return 'research_findings';
    if (name === 'findings.jsonl') return 'findings_log';
    if (name === 'sources.json') return 'source_inventory';
    if (name === 'bibliography.bib') return 'bibliography';
    if (name.includes('summary')) return 'summary';
    if (name.includes('manifest')) return 'manifest';
    if (name.includes('audit') || name.includes('operations')) return 'log';
    return 'file';
  }

  async ensureGraphNode(record) {
    if (!this.memory || typeof this.memory.addNode !== 'function') return null;
    if (record.graphNodeId) return record.graphNodeId;

    const concept = `[ARTIFACT:${record.artifactId}] ${record.kind} ${record.path}\n` +
      JSON.stringify({
        artifactId: record.artifactId,
        runId: record.runId,
        taskId: record.taskId,
        goalId: record.goalId,
        producer: record.producer,
        path: record.path,
        hash: record.hash,
        lifecycleState: record.lifecycleState
      });

    const node = await this.memory.addNode(concept, `artifact_${record.artifactId}`, null, {
      type: 'artifact',
      artifactId: record.artifactId,
      runId: record.runId,
      taskId: record.taskId,
      producer: record.producer,
      path: record.path,
      hash: record.hash,
      kind: record.kind,
      lifecycleState: record.lifecycleState
    });
    const artifactNodeId = node?.id || null;
    if (!artifactNodeId || typeof this.memory.addEdge !== 'function') return artifactNodeId;

    const edgeTypes = this.getEdgeTypes();

    if (record.taskId) {
      const taskNode = await this.ensureNodeByTag(`task_${record.taskId}`, `[TASK:${record.taskId}] Artifact-producing task`, {
        type: 'task',
        taskId: record.taskId,
        runId: record.runId
      });
      if (taskNode?.id) {
        this.memory.addEdge(taskNode.id, artifactNodeId, 0.9, edgeTypes.TASK_PRODUCED);
      }
    }

    if (record.producer?.id) {
      const producerNode = await this.ensureNodeByTag(`agent_${record.producer.id}`, `[AGENT:${record.producer.id}] Artifact producer`, {
        type: 'agent',
        agentId: record.producer.id,
        agentType: record.producer.type,
        runId: record.runId
      });
      if (producerNode?.id) {
        this.memory.addEdge(producerNode.id, artifactNodeId, 0.9, edgeTypes.AGENT_PRODUCED);
      }
    }

    for (const priorArtifactId of record.derivedFrom.artifactIds || []) {
      const priorNode = await this.findNodeByTag(`artifact_${priorArtifactId}`);
      if (priorNode?.id) {
        this.memory.addEdge(artifactNodeId, priorNode.id, 0.75, edgeTypes.ARTIFACT_DERIVED_FROM);
      }
    }

    return artifactNodeId;
  }

  getEdgeTypes() {
    try {
      return require('../memory/network-memory').NetworkMemory.EDGE_TYPES;
    } catch (_) {
      return {
        TASK_PRODUCED: 'task_produced',
        AGENT_PRODUCED: 'agent_produced',
        ARTIFACT_DERIVED_FROM: 'artifact_derived_from'
      };
    }
  }

  async ensureNodeByTag(tag, concept, metadata) {
    const existing = await this.findNodeByTag(tag);
    if (existing) return existing;
    if (!this.memory || typeof this.memory.addNode !== 'function') return null;
    return this.memory.addNode(concept, tag, null, metadata);
  }

  async findNodeByTag(tag) {
    if (!this.memory?.nodes) return null;
    const values = typeof this.memory.nodes.values === 'function'
      ? this.memory.nodes.values()
      : Object.values(this.memory.nodes);
    for (const node of values) {
      if (node?.tag === tag) return node;
    }
    return null;
  }
}

module.exports = { ArtifactRegistry };
