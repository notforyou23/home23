const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function stableHash(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function safeSlug(input) {
  return String(input || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'artifact';
}

class ArtifactRegistry {
  constructor(options = {}) {
    this.logsDir = options.logsDir || options.runtimeRoot || path.join(process.cwd(), 'runtime');
    this.registryDir = options.registryDir || path.join(this.logsDir, 'artifacts');
    this.registryPath = options.registryPath || path.join(this.registryDir, 'artifact-registry.json');
    this.memory = options.memory || null;
    this.agencyKernel = options.agencyKernel || null;
    this.logger = options.logger || null;
    this.records = new Map();
    this.initialized = false;
  }

  setAgencyKernel(agencyKernel) {
    this.agencyKernel = agencyKernel || null;
    return this;
  }

  async initialize() {
    await fsp.mkdir(this.registryDir, { recursive: true });
    await this.load();
    try {
      await fsp.access(this.registryPath);
    } catch (_) {
      await this.save();
    }
    this.initialized = true;
    return this;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      this.records = new Map(records.filter(r => r?.id).map(r => [r.id, r]));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.('[artifact-registry] load failed, starting empty', { error: error.message });
      }
      this.records = new Map();
    }
  }

  async save() {
    await fsp.mkdir(this.registryDir, { recursive: true });
    const payload = {
      schema: 'home23.artifacts.v1',
      updatedAt: new Date().toISOString(),
      records: Array.from(this.records.values())
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    };
    const tmp = `${this.registryPath}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, this.registryPath);
  }

  relativeToRoot(absPath) {
    const resolved = path.resolve(absPath);
    const roots = [
      ['logs', this.logsDir],
      ['repo', process.cwd()]
    ];
    for (const [label, root] of roots) {
      if (!root) continue;
      const rel = path.relative(path.resolve(root), resolved);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return `${label}:${rel}`;
      }
    }
    return resolved;
  }

  isDurablePath(absPath) {
    const resolved = path.resolve(absPath);
    const durableRoots = [
      path.join(this.logsDir, 'outputs'),
      path.join(this.logsDir, 'agents'),
      path.join(this.logsDir, 'artifacts'),
      path.join(process.cwd(), 'runtime', 'outputs'),
      path.join(process.cwd(), 'instances')
    ];
    return durableRoots.some(root => {
      const rel = path.relative(path.resolve(root), resolved);
      return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  async fileFacts(absPath, fallbackContent = null) {
    const resolved = path.resolve(absPath);
    let stat = null;
    let hash = null;
    let preview = null;
    try {
      stat = await fsp.stat(resolved);
      if (stat.isFile() && stat.size <= 20 * 1024 * 1024) {
        const buf = await fsp.readFile(resolved);
        hash = stableHash(buf);
        preview = buf.toString('utf8').slice(0, 1200);
      }
    } catch (_) {
      if (fallbackContent !== null && fallbackContent !== undefined) {
        hash = stableHash(String(fallbackContent));
        preview = String(fallbackContent).slice(0, 1200);
      }
    }

    return {
      absolutePath: resolved,
      relativePath: this.relativeToRoot(resolved),
      exists: Boolean(stat),
      size: stat?.size ?? (fallbackContent ? Buffer.byteLength(String(fallbackContent)) : null),
      modifiedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
      hash,
      preview
    };
  }

  buildFileId(facts, context = {}) {
    const key = [
      'file',
      facts.hash || facts.relativePath,
      context.goalId || '',
      context.taskId || '',
      context.agentId || '',
      context.kind || ''
    ].join('|');
    return `art_${stableHash(key).slice(0, 16)}`;
  }

  buildMemoryId(content, context = {}) {
    const key = [
      'memory',
      stableHash(content),
      context.memoryNodeId || '',
      context.goalId || '',
      context.taskId || '',
      context.role || ''
    ].join('|');
    return `art_${stableHash(key).slice(0, 16)}`;
  }

  async registerFile(input = {}) {
    const absPath = input.absolutePath || input.path;
    if (!absPath) return null;
    const facts = await this.fileFacts(absPath, input.content);
    if (input.requireDurable !== false && !this.isDurablePath(facts.absolutePath)) {
      return null;
    }
    const now = new Date().toISOString();
    const id = input.id || this.buildFileId(facts, input);
    const existing = this.records.get(id) || {};
    const record = {
      id,
      type: 'file',
      kind: input.kind || existing.kind || this.inferKind(facts.absolutePath),
      status: input.status || existing.status || 'created',
      absolutePath: facts.absolutePath,
      relativePath: input.relativePath || facts.relativePath,
      size: facts.size,
      hash: facts.hash || existing.hash || null,
      preview: facts.preview || existing.preview || null,
      exists: facts.exists,
      createdAt: existing.createdAt || input.createdAt || now,
      updatedAt: now,
      modifiedAt: facts.modifiedAt,
      producer: input.producer || existing.producer || null,
      agentId: input.agentId || existing.agentId || null,
      agentType: input.agentType || existing.agentType || null,
      goalId: input.goalId || input.missionGoal || existing.goalId || null,
      taskId: input.taskId || existing.taskId || null,
      cycle: input.cycle ?? existing.cycle ?? null,
      derivedFrom: this.unique([...(existing.derivedFrom || []), ...(input.derivedFrom || [])]),
      supports: this.unique([...(existing.supports || []), ...(input.supports || [])]),
      reusedBy: this.unique([...(existing.reusedBy || []), ...(input.reusedBy || [])]),
      metadata: { ...(existing.metadata || {}), ...(input.metadata || {}) }
    };
    this.records.set(id, record);
    await this.save();
    if (record.metadata?.mirrorToMemory !== false) {
      await this.maybeMirrorToMemory(record);
    }
    return record;
  }

  async registerMemoryArtifact(input = {}) {
    const content = String(input.content || '').trim();
    if (!content) return null;
    const now = new Date().toISOString();
    const id = input.id || this.buildMemoryId(content, input);
    const existing = this.records.get(id) || {};
    const record = {
      id,
      type: 'memory',
      kind: input.kind || existing.kind || 'memory_promotion',
      status: input.status || existing.status || 'created',
      contentHash: stableHash(content),
      preview: content.slice(0, 1200),
      memoryNodeId: input.memoryNodeId || existing.memoryNodeId || null,
      tag: input.tag || existing.tag || null,
      createdAt: existing.createdAt || input.createdAt || now,
      updatedAt: now,
      producer: input.producer || existing.producer || null,
      agentId: input.agentId || existing.agentId || null,
      agentType: input.agentType || existing.agentType || null,
      role: input.role || existing.role || null,
      goalId: input.goalId || existing.goalId || null,
      taskId: input.taskId || existing.taskId || null,
      cycle: input.cycle ?? existing.cycle ?? null,
      derivedFrom: this.unique([...(existing.derivedFrom || []), ...(input.derivedFrom || [])]),
      supports: this.unique([...(existing.supports || []), ...(input.supports || [])]),
      reusedBy: this.unique([...(existing.reusedBy || []), ...(input.reusedBy || [])]),
      metadata: { ...(existing.metadata || {}), ...(input.metadata || {}) }
    };
    this.records.set(id, record);
    await this.save();
    await this.maybeMirrorToMemory(record);
    return record;
  }

  async markReused(artifactId, consumer = {}) {
    const record = this.records.get(artifactId);
    if (!record) return null;
    const reuse = {
      at: new Date().toISOString(),
      agentId: consumer.agentId || null,
      agentType: consumer.agentType || null,
      goalId: consumer.goalId || consumer.missionGoal || null,
      taskId: consumer.taskId || null,
      reason: consumer.reason || null
    };
    record.status = record.status === 'created' ? 'reused' : record.status;
    record.reusedBy = [...(record.reusedBy || []), reuse];
    record.updatedAt = reuse.at;
    this.records.set(record.id, record);
    await this.save();
    return record;
  }

  async promote(artifactId, status = 'committed', metadata = {}) {
    const record = this.records.get(artifactId);
    if (!record) return null;
    record.status = status;
    record.metadata = { ...(record.metadata || {}), ...metadata };
    record.updatedAt = new Date().toISOString();
    this.records.set(record.id, record);
    await this.save();
    await this.maybeMirrorToMemory(record);
    await this.maybeEmitAgencyArtifactReceipt(record, 'artifact_promoted', metadata);
    return record;
  }

  async maybeEmitAgencyArtifactReceipt(record, event, metadata = {}) {
    if (!this.agencyKernel || typeof this.agencyKernel.intakeWorldStream !== 'function') return null;
    const agency = metadata.agency || record.metadata?.agency || {};
    const pursuitId = metadata.pursuitId || agency.pursuitId || record.metadata?.pursuitId;
    if (!pursuitId) return null;

    const verifierStatus = String(
      metadata.verifierStatus
      || agency.verifierStatus
      || metadata.verifier?.status
      || record.metadata?.verifierStatus
      || ''
    ).toLowerCase();
    const verified = metadata.verified === true
      || agency.verified === true
      || ['pass', 'passed', 'success', 'satisfied'].includes(verifierStatus);
    const consequenceStatus = record.status === 'committed' && verified ? 'closed' : 'advanced';
    const changedFuture = consequenceStatus === 'closed'
      ? (metadata.changedFuture
        || agency.changedFuture
        || `Artifact ${record.id} passed verifier and committed reusable output for resident pursuit ${pursuitId}.`)
      : undefined;
    const packet = {
      source: 'artifacts.registry',
      kind: 'artifact_verifier_receipt',
      summary: `${event}: ${record.id} ${record.status}${verifierStatus ? ` verifier=${verifierStatus}` : ''}`,
      pursuitId,
      consequenceStatus,
      changedFuture,
      desiredChangedFuture: metadata.desiredChangedFuture || agency.desiredChangedFuture || record.metadata?.desiredChangedFuture || null,
      nextMove: consequenceStatus === 'closed'
        ? 'close resident pursuit unless newer evidence reopens it'
        : 'attach artifact evidence and keep pursuit open until verifier passes',
      seen: [
        record.relativePath || record.absolutePath || record.id,
        record.preview ? record.preview.slice(0, 500) : null,
      ].filter(Boolean),
      evidence: [
        {
          type: 'artifact',
          ref: record.id,
          status: record.status,
          path: record.relativePath || record.absolutePath || null,
          hash: record.hash || record.contentHash || null,
        },
        verifierStatus ? {
          type: 'verifier_receipt',
          ref: metadata.verifierRef || agency.verifierRef || record.id,
          status: verifierStatus,
        } : null,
      ].filter(Boolean),
      artifacts: [record.id],
      tags: ['artifact', 'verifier', record.kind || record.type].filter(Boolean),
    };
    try {
      return await this.agencyKernel.intakeWorldStream(packet);
    } catch (error) {
      this.logger?.warn?.('[artifact-registry] agency receipt emission failed', {
        artifactId: record.id,
        error: error.message,
      });
      return null;
    }
  }

  find(filter = {}) {
    return Array.from(this.records.values()).filter(record => {
      if (filter.type && record.type !== filter.type) return false;
      if (filter.kind && record.kind !== filter.kind) return false;
      if (filter.goalId && record.goalId !== filter.goalId) return false;
      if (filter.taskId && record.taskId !== filter.taskId) return false;
      if (filter.agentId && record.agentId !== filter.agentId) return false;
      if (filter.status && record.status !== filter.status) return false;
      return true;
    });
  }

  get(id) {
    return this.records.get(id) || null;
  }

  unique(values) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
      if (!value) continue;
      const key = typeof value === 'string' ? value : JSON.stringify(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  inferKind(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    if (['.md', '.txt'].includes(ext)) return 'document';
    if (['.json', '.jsonl'].includes(ext)) return 'structured_data';
    if (['.js', '.ts', '.tsx', '.jsx', '.py', '.sh'].includes(ext)) return 'code';
    return 'file';
  }

  async maybeMirrorToMemory(record) {
    if (!this.memory || typeof this.memory.addNode !== 'function') return null;
    if (record.memoryMirrorNodeId) return record.memoryMirrorNodeId;
    try {
      const concept = [
        `Artifact ${record.id}: ${record.kind || record.type}`,
        record.relativePath ? `path=${record.relativePath}` : null,
        record.preview ? `preview=${record.preview.slice(0, 500)}` : null
      ].filter(Boolean).join('\n');
      const node = await this.memory.addNode({
        concept,
        tag: `artifact_${safeSlug(record.kind || record.type)}`,
        type: 'artifact',
        metadata: {
          artifactId: record.id,
          artifactType: record.type,
          kind: record.kind,
          status: record.status,
          path: record.relativePath || null,
          goalId: record.goalId || null,
          taskId: record.taskId || null,
          agentId: record.agentId || null,
          hash: record.hash || record.contentHash || null,
          asserted_at: record.updatedAt
        },
        asserted_at: record.updatedAt,
        status: record.status
      });
      if (node?.id) {
        record.memoryMirrorNodeId = node.id;
        this.records.set(record.id, record);
        await this.save();
      }
      return node?.id || null;
    } catch (error) {
      this.logger?.warn?.('[artifact-registry] memory mirror failed', {
        artifactId: record.id,
        error: error.message
      });
      return null;
    }
  }

  async scanDurableFiles(options = {}) {
    const roots = options.roots || [
      path.join(this.logsDir, 'outputs'),
      path.join(this.logsDir, 'agents'),
      path.join(process.cwd(), 'runtime', 'outputs')
    ];
    const files = [];
    const maxFiles = options.maxFiles || 1000;
    const walk = async (dir, depth = 0) => {
      if (files.length >= maxFiles || depth > (options.maxDepth || 5)) return;
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (entry.name.startsWith('.lock')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, depth + 1);
        } else if (entry.isFile()) {
          files.push(abs);
        }
      }
    };
    for (const root of roots) await walk(root, 0);
    return files;
  }
}

module.exports = { ArtifactRegistry, stableHash, safeSlug };
