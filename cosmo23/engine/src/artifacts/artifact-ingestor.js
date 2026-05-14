const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class ArtifactIngestor {
  constructor(options = {}) {
    this.registry = options.registry || null;
    this.logger = options.logger || console;
  }

  async ingest(record) {
    if (!record?.absolutePath) return null;
    try {
      const structured = await this.extract(record);
      const patch = {
        parseStatus: structured ? 'parsed' : 'unparsed',
        structured: structured || null,
        lifecycleState: structured && record.lifecycleState === 'registered' ? 'parsed' : record.lifecycleState
      };
      if (structured) {
        await this.ensureClaimGraph(record, structured).catch((error) => {
          this.logger?.debug?.('[ArtifactIngestor] claim graph skipped', {
            artifactId: record.artifactId,
            error: error.message
          });
        });
      }
      if (this.registry && record.artifactId) {
        return this.registry.updateArtifact(record.artifactId, patch);
      }
      return { ...record, ...patch };
    } catch (error) {
      const patch = {
        parseStatus: 'failed',
        parseError: error.message
      };
      if (this.registry && record.artifactId) {
        return this.registry.updateArtifact(record.artifactId, patch);
      }
      this.logger?.debug?.('[ArtifactIngestor] parse failed', {
        artifactId: record.artifactId,
        path: record.path,
        error: error.message
      });
      return { ...record, ...patch };
    }
  }

  async extract(record) {
    const fileName = path.basename(record.absolutePath);
    if (fileName === 'findings.jsonl') return this.extractFindingsJsonl(record);
    if (fileName === 'research_findings.json') return this.extractResearchFindings(record);
    if (fileName === 'research_summary.md') return this.extractMarkdownSummary(record);
    if (fileName === 'sources.json') return this.extractSourcesJson(record);
    if (fileName === 'bibliography.bib') return this.extractBibliography(record);
    if (record.mimeType === 'text/markdown' || record.absolutePath.endsWith('.md')) {
      return this.extractMarkdownSummary(record);
    }
    return null;
  }

  async extractFindingsJsonl(record) {
    const raw = await fs.readFile(record.absolutePath, 'utf8');
    const claims = [];
    const evidenceRefs = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const text = item.finding || item.content || item.summary || item.text;
        if (typeof text === 'string' && text.trim()) {
          claims.push(this.claim(text, record, {
            status: 'candidate',
            confidence: item.confidence || 'medium',
            supportedBy: [record.artifactId]
          }));
        }
        if (item.nodeId) evidenceRefs.push({ type: 'memory', id: item.nodeId, role: 'supports' });
        if (item.source || item.url) evidenceRefs.push({ type: 'source', id: item.source || item.url, role: 'supports' });
      } catch (_) {}
    }
    return this.structured(record, { canonicalClaims: claims, evidenceRefs });
  }

  async extractResearchFindings(record) {
    const data = JSON.parse(await fs.readFile(record.absolutePath, 'utf8'));
    const findings = Array.isArray(data) ? data : (data.findings || data.results || []);
    const claims = [];
    const sourceRefs = [];
    for (const finding of findings) {
      if (typeof finding === 'string') {
        claims.push(this.claim(finding, record, { status: 'candidate', supportedBy: [record.artifactId] }));
      } else if (finding && typeof finding === 'object') {
        const text = finding.finding || finding.content || finding.summary || finding.claim || finding.text;
        if (typeof text === 'string' && text.trim()) {
          claims.push(this.claim(text, record, {
            status: 'candidate',
            confidence: finding.confidence || 'medium',
            supportedBy: [record.artifactId]
          }));
        }
        for (const src of [].concat(finding.sources || finding.source || [])) {
          if (src) sourceRefs.push(this.sourceRef(src));
        }
      }
    }
    for (const src of [].concat(data.sources || [])) {
      if (src) sourceRefs.push(this.sourceRef(src));
    }
    return this.structured(record, { canonicalClaims: claims, sourceRefs });
  }

  async extractMarkdownSummary(record) {
    const raw = await fs.readFile(record.absolutePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const titleLine = lines.find(line => /^#\s+/.test(line));
    const headings = lines
      .filter(line => /^#{2,6}\s+/.test(line))
      .map(line => line.replace(/^#{2,6}\s+/, '').trim())
      .filter(Boolean);
    const claims = [];
    const openQuestions = [];
    const recommendations = [];

    for (const line of lines) {
      const text = line.replace(/^[-*]\s+/, '').trim();
      if (!text || text.length < 20) continue;
      if (/\?$/.test(text)) {
        openQuestions.push(text);
      } else if (/^(therefore|so |recommend|should|must|the key|the failure|the loop|this means)/i.test(text)) {
        claims.push(this.claim(text, record, { status: 'candidate', supportedBy: [record.artifactId] }));
      } else if (/^(use|add|implement|replace|modify|verify|run)\b/i.test(text)) {
        recommendations.push(text);
      }
    }

    return this.structured(record, {
      title: titleLine ? titleLine.replace(/^#\s+/, '').trim() : null,
      headings,
      canonicalClaims: claims.slice(0, 20),
      openQuestions: openQuestions.slice(0, 20),
      recommendations: recommendations.slice(0, 20)
    });
  }

  async extractSourcesJson(record) {
    const data = JSON.parse(await fs.readFile(record.absolutePath, 'utf8'));
    const sources = Array.isArray(data) ? data : (data.sources || data.items || []);
    return this.structured(record, {
      sourceRefs: sources.map(src => this.sourceRef(src)).filter(Boolean)
    });
  }

  async extractBibliography(record) {
    const raw = await fs.readFile(record.absolutePath, 'utf8');
    const entries = [];
    const regex = /@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@\w+\s*\{|$)/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      const body = match[2] || '';
      entries.push({
        type: 'source',
        id: match[1],
        role: 'bibliography_entry',
        title: this.extractBibField(body, 'title'),
        year: this.extractBibField(body, 'year'),
        url: this.extractBibField(body, 'url') || this.extractBibField(body, 'doi')
      });
    }
    return this.structured(record, { sourceRefs: entries });
  }

  extractBibField(body, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`${escaped}\\s*=\\s*[{\"]([^}\"]+)`, 'i'));
    return match ? match[1].trim() : null;
  }

  structured(record, patch = {}) {
    return {
      artifactId: record.artifactId,
      kind: record.kind,
      title: patch.title || null,
      headings: patch.headings || [],
      canonicalClaims: patch.canonicalClaims || [],
      evidenceRefs: patch.evidenceRefs || [],
      sourceRefs: patch.sourceRefs || [],
      openQuestions: patch.openQuestions || [],
      recommendations: patch.recommendations || [],
      supersessionCandidates: patch.supersessionCandidates || [],
      reuseContract: {
        recommendedUse: this.recommendedUse(record),
        readBefore: [],
        doNotUseIf: [],
        supersededBy: null
      }
    };
  }

  claim(text, record = {}, options = {}) {
    const normalized = text.trim().replace(/\s+/g, ' ');
    const claimId = `claim_${crypto.createHash('sha1').update(`${record.runId || ''}:${normalized}`).digest('hex').slice(0, 16)}`;
    return {
      claimId,
      text: normalized,
      status: options.status || 'candidate',
      confidence: options.confidence || 'medium',
      supportedBy: options.supportedBy || [],
      contradictedBy: [],
      openQuestions: []
    };
  }

  sourceRef(src) {
    if (typeof src === 'string') return { type: 'source', id: src, role: 'supports' };
    return {
      type: 'source',
      id: src.id || src.url || src.title || null,
      role: src.role || 'supports',
      title: src.title || null,
      year: src.year || null,
      url: src.url || src.link || null
    };
  }

  recommendedUse(record) {
    if (record.kind === 'research_summary') return 'candidate_synthesis';
    if (record.kind === 'research_findings' || record.kind === 'findings_log') return 'evidence_package';
    if (record.kind === 'source_inventory' || record.kind === 'bibliography') return 'source_inventory';
    if (record.kind === 'deliverable') return 'candidate_synthesis';
    return 'raw_notes';
  }

  async ensureClaimGraph(record, structured) {
    const memory = this.registry?.memory;
    if (!memory || typeof memory.addNode !== 'function') return;
    const artifactNode = record.graphNodeId
      ? { id: record.graphNodeId }
      : await this.registry.findNodeByTag?.(`artifact_${record.artifactId}`);
    if (!artifactNode?.id) return;

    let edgeType = 'artifact_supports';
    try {
      edgeType = require('../memory/network-memory').NetworkMemory.EDGE_TYPES.ARTIFACT_SUPPORTS;
    } catch (_) {}

    for (const claim of structured.canonicalClaims || []) {
      if (!claim.claimId || !claim.text) continue;
      let claimNode = await this.registry.findNodeByTag?.(`claim_${claim.claimId}`);
      if (!claimNode) {
        claimNode = await memory.addNode(`[CLAIM:${claim.claimId}] ${claim.text}`, `claim_${claim.claimId}`, null, {
          type: 'claim',
          claimId: claim.claimId,
          status: claim.status,
          confidence: claim.confidence,
          sourceArtifactId: record.artifactId,
          runId: record.runId
        });
      }
      if (claimNode?.id && typeof memory.addEdge === 'function') {
        memory.addEdge(artifactNode.id, claimNode.id, 0.85, edgeType);
      }
    }
  }
}

module.exports = { ArtifactIngestor };
