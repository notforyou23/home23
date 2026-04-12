/**
 * COSMO Query Engine
 * Backend processor for web-based queries with caching and streaming support
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const OpenAI = require('openai');
const { UnifiedClient } = require('../core/unified-client');
const { createClusterAdapter } = require('../../lib/ask/cluster-adapter');
const { EvidenceAnalyzer } = require('./evidence-analyzer');
const { InsightSynthesizer } = require('./insight-synthesizer');
const { CoordinatorIndexer } = require('./coordinator-indexer');
const { QuerySuggester } = require('./query-suggestions');
const { ContextTracker } = require('../../lib/ask/context-tracker');

const CLUSTER_SNAPSHOT_DEFAULT_TTL = Number.parseInt(
  process.env.COSMO_CLUSTER_SNAPSHOT_TTL || '4000',
  10
);

function isTruthyFlag(value) {
  if (!value) return false;
  const normalized = value.toString().trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseProfileString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .split('|')
    .map(entry => entry.trim())
    .filter(Boolean)
    .reduce((acc, segment) => {
      const [left, right] = segment.split('=');
      if (!left || !right) return acc;
      const key = left.trim().toLowerCase();
      const value = right.trim().replace(/^['"]|['"]$/g, '');
      acc[key] = value;
      return acc;
    }, {});
}

function getNodeCacheKey(node) {
  if (!node) return null;
  const instanceId = node.instanceId || null;
  const baseId = node.originalId ?? node.id;
  return instanceId ? `${instanceId}:${baseId}` : baseId;
}

function getThoughtCacheKey(thought) {
  if (!thought) return null;
  const instanceId = thought.instanceId || 'solo';
  if (thought.cycle !== undefined && thought.cycle !== null) {
    return `${instanceId}:${thought.cycle}`;
  }
  if (thought.timestamp) {
    return `${instanceId}:${new Date(thought.timestamp).getTime()}`;
  }
  if (thought.id) {
    return `${instanceId}:${thought.id}`;
  }
  return `${instanceId}:${Math.random().toString(36).slice(2)}`;
}

function getStateHashForCache(state) {
  if (!state) return 'unknown';
  if (state.isCluster && state.cluster) {
    const cluster = state.cluster;
    const timestamp = cluster.timestamp || 0;
    const nodeCount = state.memory?.nodes?.length || 0;
    const goalCount = state.goals?.active?.length || 0;
    return `cluster:${timestamp}:${nodeCount}:${goalCount}`;
  }
  return `solo:${state.cycleCount || 0}:${state.memory?.nodes?.length || 0}`;
}

class QueryEngine {
  constructor(runtimeDir, openaiKey, config = null) {
    this.runtimeDir = runtimeDir;
    this.config = config;
    this.stateFile = path.join(runtimeDir, 'state.json.gz');
    this.thoughtsFile = path.join(runtimeDir, 'thoughts.jsonl');
    this.coordinatorDir = path.join(runtimeDir, 'coordinator');
    this.metricsFile = path.join(runtimeDir, 'evaluation-metrics.json');
    this.embeddingsCache = path.join(runtimeDir, 'embeddings-cache.json');
    this.exportsDir = path.join(runtimeDir, 'exports');
    
    this.openai = new OpenAI({ apiKey: openaiKey });
    this.gpt5Client = new UnifiedClient(this.config, console); // Use UnifiedClient for queries (supports local LLM)
    
    // In-memory cache for frequent queries
    this.queryCache = new Map();
    this.maxCacheSize = 50;

    // Enhancement modules (Phase 1)
    this.evidenceAnalyzer = new EvidenceAnalyzer();
    this.insightSynthesizer = new InsightSynthesizer();
    this.coordinatorIndexer = new CoordinatorIndexer(this.coordinatorDir, this.openai);
    this.querySuggester = new QuerySuggester();
    this.contextTracker = new ContextTracker();

    // Performance tracking (Phase 8)
    this.performanceMetrics = {
      queriesProcessed: 0,
      avgQueryTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      enhancementUsage: {
        evidence: 0,
        synthesis: 0,
        coordinator: 0,
        followUps: 0
      }
    };

    this.runMetadata = this.loadRunMetadataSync();
    this.clusterSnapshotTtl = CLUSTER_SNAPSHOT_DEFAULT_TTL;
    this.clusterContext = {
      enabled: false,
      adapter: null,
      host: process.env.COSMO_CLUSTER_HOST || 'localhost',
      port: Number.parseInt(process.env.COSMO_CLUSTER_PORT || '3360', 10),
      protocol: (process.env.COSMO_CLUSTER_PROTOCOL || 'http').toLowerCase(),
      backend: null,
      instanceCount: null,
      specializationProfiles: null,
      lastSnapshot: null,
      lastFetchTs: 0,
      lastError: null,
      warningShown: false
    };

    this.updateClusterContext();
  }

  loadRunMetadataSync() {
    try {
      const metadataPath = path.join(this.runtimeDir, 'run-metadata.json');
      if (fsSync.existsSync(metadataPath)) {
        const content = fsSync.readFileSync(metadataPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn('[QueryEngine] Failed to load run metadata:', error.message);
    }
    return null;
  }

  resetClusterContext() {
    this.clusterContext.enabled = false;
    this.clusterContext.adapter = null;
    this.clusterContext.backend = null;
    this.clusterContext.instanceCount = null;
    this.clusterContext.specializationProfiles = null;
    this.clusterContext.lastSnapshot = null;
    this.clusterContext.lastFetchTs = 0;
    this.clusterContext.lastError = null;
    this.clusterContext.warningShown = false;
  }

  updateClusterContext() {
    const disabled = isTruthyFlag(process.env.COSMO_CLUSTER_DISABLE);
    const forced = isTruthyFlag(process.env.COSMO_CLUSTER_FORCE || process.env.COSMO_HIVE_FORCE);
    const metadataEnabled = Boolean(this.runMetadata?.clusterEnabled);
    const shouldEnable = !disabled && (forced || metadataEnabled);

    if (!shouldEnable) {
      this.resetClusterContext();
      return;
    }

    const host =
      process.env.COSMO_CLUSTER_HOST ||
      this.runMetadata?.clusterHost ||
      this.clusterContext.host ||
      'localhost';
    const portCandidate =
      process.env.COSMO_CLUSTER_PORT ||
      this.runMetadata?.clusterDashboardPort ||
      this.runMetadata?.clusterPort ||
      this.runMetadata?.cluster?.dashboardPort ||
      this.clusterContext.port ||
      '3360';
    const port = Number.parseInt(portCandidate, 10);
    const protocol = (process.env.COSMO_CLUSTER_PROTOCOL || this.clusterContext.protocol || 'http').toLowerCase();

    try {
      this.clusterContext.adapter = createClusterAdapter({ host, port, protocol });
      this.clusterContext.enabled = true;
      this.clusterContext.host = host;
      this.clusterContext.port = port;
      this.clusterContext.protocol = protocol;
      this.clusterContext.backend = this.runMetadata?.clusterBackend || this.clusterContext.backend || null;
      this.clusterContext.instanceCount = this.runMetadata?.clusterSize || this.clusterContext.instanceCount || null;
      this.clusterContext.specializationProfiles =
        parseProfileString(this.runMetadata?.clusterSpecializationProfiles) ||
        this.clusterContext.specializationProfiles;
      this.clusterContext.lastSnapshot = null;
      this.clusterContext.lastFetchTs = 0;
      this.clusterContext.lastError = null;
      this.clusterContext.warningShown = false;
    } catch (error) {
      console.warn('[QueryEngine] Failed to initialize cluster adapter:', error.message);
      this.resetClusterContext();
      this.clusterContext.lastError = error;
    }
  }

  isClusterModeActive() {
    return Boolean(this.clusterContext.enabled && this.clusterContext.adapter);
  }

  /**
   * Try to load cluster state directly from filesystem store (read-only mode)
   * This allows querying historical cluster runs without the hive dashboard running
   */
  async tryDirectClusterAccess() {
    // Only try for filesystem backend
    if (this.runMetadata?.clusterBackend !== 'filesystem') {
      return null;
    }

    // Get cluster filesystem root from metadata
    const clusterRoot = this.runMetadata?.clusterFilesystemRoot || 
                       path.join(this.runtimeDir, 'cluster');

    // Check if cluster data exists
    const fsSync = require('fs');
    if (!fsSync.existsSync(clusterRoot)) {
      return null;
    }

    try {
      console.log('[QueryEngine] Attempting direct cluster filesystem access:', clusterRoot);
      
      const FilesystemStateStore = require('../cluster/backends/filesystem-state-store');
      const ClusterStateStore = require('../cluster/cluster-state-store');
      
      const fsBackend = new FilesystemStateStore({
        fsRoot: clusterRoot,
        instanceId: 'query-engine-observer',
        readOnly: true // PASSIVE MODE - no leader election or writes
      }, console);
      
      const store = new ClusterStateStore({ readOnly: true }, fsBackend);
      await store.connect();
      
      // Get all health beacons to find instances
      const healthBeacons = await store.getAllHealthBeacons();
      const instanceIds = Object.keys(healthBeacons || {});
      
      console.log('[QueryEngine] Found cluster instances:', instanceIds.length);
      
      // Build aggregated state similar to how cluster-server does it
      // For now, we'll return a marker that direct access worked
      // and let the HTTP fallback handle the actual aggregation
      // This is a foundation for future full direct aggregation
      
      await store.disconnect();
      
      return {
        directAccess: true,
        instanceCount: instanceIds.length,
        clusterRoot
      };
    } catch (error) {
      console.warn('[QueryEngine] Direct cluster access failed:', error.message);
      return null;
    }
  }

  /**
   * Generate an executive-ready presentation of an existing COSMO answer.
   * IMPORTANT:
   * - This NEVER re-queries COSMO's brain state
   * - It ONLY rephrases/compresses the already-produced answer + metadata
   * - It MUST NOT introduce new factual claims beyond the original answer/metadata
   */
  async generateExecutiveView(query, baseAnswer, baseMetadata = {}) {
    if (!baseAnswer || typeof baseAnswer !== 'string') {
      throw new Error('Base answer is required to generate executive view');
    }

    const safeMetadata = baseMetadata || {};

    // Build a compact, structured input for GPT-5.1
    const summaryInputParts = [];
    summaryInputParts.push('# COSMO QUERY\n');
    summaryInputParts.push(`Question:\n${query || '(unknown question)'}\n\n`);

    summaryInputParts.push('# ORIGINAL COSMO ANSWER (AUTHORITATIVE)\n');
    summaryInputParts.push(
      'This is the FULL, DENSE answer produced by COSMO. You must treat this as the only ground truth content.\n\n'
    );
    summaryInputParts.push(baseAnswer.trim());
    summaryInputParts.push('\n\n');

    // Evidence quality (if available)
    if (safeMetadata.evidenceQuality) {
      const eq = safeMetadata.evidenceQuality;
      summaryInputParts.push('# EVIDENCE QUALITY (COSMO INTERNAL METADATA)\n');
      summaryInputParts.push(
        `Summary: ${eq.summary || 'N/A'}\n` +
          `Coverage: ${eq.coverage?.rating || 'N/A'} (${Math.round(
            (eq.coverage?.percentage || 0) * 100
          )}%, ${eq.coverage?.used || 0}/${eq.coverage?.total || 0} nodes)\n` +
          `Confidence: ${eq.confidence?.rating || 'N/A'} (${Math.round(
            (eq.confidence?.score || 0) * 100
          )}%)\n\n`
      );
    }

    // Synthesis summary (if available)
    if (safeMetadata.synthesis) {
      const syn = safeMetadata.synthesis;
      summaryInputParts.push('# INSIGHT SYNTHESIS (COSMO INTERNAL METADATA)\n');
      if (syn.summary) {
        summaryInputParts.push(`Summary: ${syn.summary}\n\n`);
      }
    }

    // Coordinator insights (short form)
    if (safeMetadata.coordinatorInsights && safeMetadata.coordinatorInsights.insights) {
      const insights = safeMetadata.coordinatorInsights.insights;
      if (insights.length > 0) {
        summaryInputParts.push('# COORDINATOR INSIGHTS (TITLES ONLY)\n');
        insights.slice(0, 5).forEach((ins, idx) => {
          summaryInputParts.push(
            `${idx + 1}. ${ins.title || 'Untitled insight'} (relevance: ${
              ins.relevance != null ? ins.relevance : 'N/A'
            }%)\n`
          );
        });
        summaryInputParts.push('\n');
      }
    }

    // Minimal technical metadata
    summaryInputParts.push('# TECHNICAL METADATA\n');
    summaryInputParts.push(`Model: ${safeMetadata.model || 'gpt-5.2'}\n`);
    summaryInputParts.push(`Mode: ${safeMetadata.mode || 'unknown'}\n`);
    if (safeMetadata.sources) {
      summaryInputParts.push(
        `Sources: ${safeMetadata.sources.memoryNodes || 0} memory nodes, ` +
          `${safeMetadata.sources.thoughts || 0} thoughts, ` +
          `${safeMetadata.sources.edges || 0} edges\n`
      );
    }
    summaryInputParts.push('\n');

    const input = summaryInputParts.join('');

    const instructions = `
You are COSMO's EXECUTIVE TRANSLATOR.

You are given:
- A QUESTION asked to COSMO.
- COSMO's ORIGINAL ANSWER (dense, technical, authoritative).
- COSMO's INTERNAL METADATA (evidence quality, synthesis, coordinator insights).

CRITICAL RULES (MUST OBEY EXACTLY):
- The ORIGINAL ANSWER is the SINGLE SOURCE OF TRUTH.
- You MAY ONLY rephrase, compress, and reorganize what is already present in the original answer + metadata.
- You MUST NOT introduce any new factual claims, examples, numbers, entities, or speculations that are not clearly implied by the original answer.
- If something is unclear or not specified in the original answer, explicitly say "Unclear from COSMO's answer" rather than guessing.
- Do NOT soften or override COSMO's epistemic humility; if COSMO says "unknown", you must respect that.

OUTPUT FORMAT (PLAIN TEXT, CLEARLY LABELED SECTIONS):

1) TL;DR FOR DECISION-MAKERS
   - 3–7 bullet points.
   - Each bullet ≤ 2 sentences.
   - Focus on what matters for a senior decision-maker who will NOT read the full answer.

2) WHY COSMO THINKS THIS IS TRUE
   - Short narrative in layman's terms explaining, at a high level, what evidence COSMO relied on.
   - Refer to the kinds of signals COSMO used (memory nodes, thought stream, coordinator reviews, evidence quality), but DO NOT invent specific citations that are not in the original answer.

3) NOVELTY & WHAT'S ACTUALLY NEW
   - Explain, based ONLY on COSMO's answer, what appears genuinely novel or distinctive versus what sounds like standard/known practice.
   - If COSMO's answer does not clearly establish novelty, say so explicitly and explain why.

4) IMPLICATIONS / NEXT MOVES
   - 3–6 bullets on "So what?" for an executive:
     - What decisions or follow-ups does this suggest?
     - Where might COSMO's findings actually change behavior?
   - Again: DO NOT introduce new facts; you may propose implications only to the extent they are natural, conservative extrapolations of the original answer.

STYLE:
- Speak to a smart but non-technical executive.
- Avoid jargon or explain it in plain language.
- Be direct, concrete, and as concise as possible while preserving meaning.
- Do NOT include any raw markdown headings beyond the numbered section titles above.
`.trim();

    const response = await this.gpt5Client.generate({
      model: 'gpt-5.2',
      instructions,
      input,
      reasoningEffort: 'medium',
      maxTokens: 6000,
      verbosity: 'medium'
    });

    const executiveText = response.content || response.message?.content || '';

    return {
      style: 'executive',
      text: executiveText,
      model: response.model || 'gpt-5.2',
      base: {
        model: safeMetadata.model || 'gpt-5.2',
        mode: safeMetadata.mode || null,
        timestamp: safeMetadata.timestamp || null
      }
    };
  }

  getInstanceProfile(instanceId, overview) {
    if (!instanceId) return null;
    const normalized = instanceId.toLowerCase();

    const routingSignals = overview?.specialization?.routingSignals;
    if (routingSignals) {
      const signalsArray = Array.isArray(routingSignals) ? routingSignals : Object.values(routingSignals);
      const match = signalsArray.find(entry => (entry.instanceId || '').toLowerCase() === normalized);
      if (match?.profileName) {
        return match.profileName;
      }
    }

    if (
      overview?.specialization?.expectedDistribution &&
      overview.specialization.expectedDistribution[normalized] !== undefined
    ) {
      return normalized;
    }

    if (this.clusterContext.specializationProfiles) {
      return (
        this.clusterContext.specializationProfiles[normalized] ||
        this.clusterContext.specializationProfiles[instanceId] ||
        null
      );
    }

    return null;
  }

  normalizeClusterSnapshot(snapshot) {
    if (!snapshot) return null;

    const { overview, memory, goals, thoughts, stats, agents } = snapshot;
    const byInstance = memory?.byInstance || {};

    const nodes = [];
    const edges = [];
    const clusters = [];

    Object.entries(byInstance).forEach(([instanceId, payload]) => {
      const profile = this.getInstanceProfile(instanceId, overview);

      (payload.nodes || []).forEach(node => {
        const compositeId = `${instanceId}:${node.id}`;
        nodes.push({
          ...node,
          id: compositeId,
          originalId: node.id,
          instanceId,
          specializationProfile: profile
        });
      });

      (payload.edges || []).forEach(edge => {
        edges.push({
          ...edge,
          instanceId,
          source: `${instanceId}:${edge.source}`,
          target: `${instanceId}:${edge.target}`
        });
      });

      (payload.clusters || []).forEach(cluster => {
        const clusterId = cluster.id ?? cluster.clusterId ?? cluster.name ?? `${instanceId}:${clusters.length + 1}`;
        clusters.push({
          ...cluster,
          id: `${instanceId}:${clusterId}`,
          instanceId,
          specializationProfile: profile
        });
      });
    });

    const normalizedThoughts = Array.isArray(thoughts)
      ? thoughts
          .map(thought => {
            const instanceId = thought.instanceId || thought.sourceInstance || null;
            const specializationProfile = this.getInstanceProfile(instanceId, overview);
            return {
              ...thought,
              instanceId,
              specializationProfile
            };
          })
          .sort((a, b) => {
            const timeA = new Date(a.timestamp || 0).getTime();
            const timeB = new Date(b.timestamp || 0).getTime();
            return timeB - timeA;
          })
      : [];

    const normalizeGoalList = list =>
      Array.isArray(list)
        ? list.map(goal => {
            const instanceId = goal.instanceId || goal.claimedBy || goal.claimed_by || null;
            return {
              ...goal,
              instanceId,
              specializationProfile: this.getInstanceProfile(instanceId, overview)
            };
          })
        : [];

    const normalizedGoals = {
      active: normalizeGoalList(goals?.active),
      completed: normalizeGoalList(goals?.completed),
      archived: normalizeGoalList(goals?.archived),
      claimSummary: goals?.claimSummary || null,
      specialization: goals?.specialization || null
    };

    const clusterMeta = {
      enabled: true,
      host: this.clusterContext.host,
      port: this.clusterContext.port,
      protocol: this.clusterContext.protocol,
      backend: this.clusterContext.backend || stats?.backend || null,
      instanceCount:
        this.clusterContext.instanceCount ||
        (Array.isArray(stats?.instances) ? stats.instances.length : Object.keys(byInstance).length) ||
        null,
      overview,
      stats,
      agents,
      timestamp: overview?.timestamp || Date.now(),
      health: overview?.health || stats?.clusterHealth || null,
      leader: overview?.leader || stats?.leaderInstance || null
    };

    const cycleCount =
      overview?.cognitive?.totalCycles ||
      stats?.totalCycles ||
      (Array.isArray(stats?.instances)
        ? stats.instances.reduce((sum, inst) => sum + (inst.cycles || 0), 0)
        : 0);

    return {
      state: {
        isCluster: true,
        cycleCount,
        memory: {
          nodes,
          edges,
          clusters,
          byInstance
        },
        goals: normalizedGoals,
        agents,
        stats,
        cluster: clusterMeta,
        runMetadata: this.runMetadata || null
      },
      thoughts: normalizedThoughts,
      overview,
      goals: normalizedGoals,
      memory,
      stats,
      agents
    };
  }

  async loadClusterSnapshot(force = false) {
    if (!this.isClusterModeActive()) {
      return null;
    }

    const now = Date.now();
    if (
      !force &&
      this.clusterContext.lastSnapshot &&
      now - this.clusterContext.lastFetchTs < this.clusterSnapshotTtl
    ) {
      return this.clusterContext.lastSnapshot;
    }

    try {
      const rawSnapshot = await this.clusterContext.adapter.getSnapshot({
        thoughtLimit: 600,
        includeAgents: false
      });
      const normalized = this.normalizeClusterSnapshot(rawSnapshot);
      this.clusterContext.lastSnapshot = normalized;
      this.clusterContext.lastFetchTs = Date.now();
      this.clusterContext.lastError = null;
      this.clusterContext.warningShown = false;
      return normalized;
    } catch (error) {
      this.clusterContext.lastError = error;
      return null;
    }
  }

  findNodeEmbedding(embeddingsCache, node) {
    if (!embeddingsCache || !node) return null;
    const nodes = Array.isArray(embeddingsCache.nodes) ? embeddingsCache.nodes : [];
    const cacheKey = getNodeCacheKey(node);
    let entry = cacheKey ? nodes.find(n => n.id === cacheKey) : null;

    if (!entry && node.originalId !== undefined) {
      entry = nodes.find(
        n =>
          n.id === node.originalId ||
          n.id === `${node.instanceId}:${node.originalId}` ||
          n.id === Number(node.originalId)
      );
    }

    if (!entry && node.id && node.id !== cacheKey) {
      entry = nodes.find(n => n.id === node.id);
    }

    return entry || null;
  }

  findThoughtEmbedding(embeddingsCache, thought) {
    if (!embeddingsCache || !thought) return null;
    const thoughts = Array.isArray(embeddingsCache.thoughts) ? embeddingsCache.thoughts : [];
    const cacheKey = getThoughtCacheKey(thought);
    let entry = cacheKey ? thoughts.find(t => t.key === cacheKey) : null;

    if (!entry && thought.cycle !== undefined) {
      entry = thoughts.find(
        t =>
          t.key === `${thought.instanceId || 'solo'}:${thought.cycle}` ||
          t.cycle === thought.cycle
      );
    }

    return entry || null;
  }

  /**
   * Load COSMO's brain state
   */
  async loadBrainState() {
    if (this.isClusterModeActive()) {
      // PRIORITY 1: Try direct filesystem access (works offline)
      const directAccess = await this.tryDirectClusterAccess();
      if (directAccess) {
        console.log('[QueryEngine] Using direct cluster filesystem access');
        // Note: For now we still fall through to HTTP to get aggregated state
        // Future enhancement: build aggregated state directly from store
      }
      
      // PRIORITY 2: Try HTTP snapshot from hive dashboard
      const snapshot = await this.loadClusterSnapshot();
      if (snapshot?.state) {
        return snapshot.state;
      }

      // PRIORITY 3: Warn and fall back to local state
      if (!this.clusterContext.warningShown) {
        const reason = this.clusterContext.lastError ? ` (${this.clusterContext.lastError.message})` : '';
        console.warn(`⚠️  Hive dashboard unreachable, falling back to local brain state${reason}`);
        if (directAccess) {
          console.warn(`   (Cluster data found at ${directAccess.clusterRoot} with ${directAccess.instanceCount} instances)`);
          console.warn(`   Future: Direct aggregation from cluster store will be implemented)`);
        }
        this.clusterContext.warningShown = true;
      }
    }

    try {
      const compressed = await fs.readFile(this.stateFile);
      const decompressed = await gunzip(compressed);
      return JSON.parse(decompressed.toString());
    } catch (error) {
      console.error('Failed to load brain state:', error.message);
      console.error('Attempted to load from:', this.stateFile);
      throw new Error(`Cannot load COSMO brain state: ${error.message}`);
    }
  }

  /**
   * Load thought stream
   */
  async loadThoughts() {
    if (this.isClusterModeActive()) {
      const snapshot = await this.loadClusterSnapshot();
      if (snapshot?.thoughts?.length) {
        return snapshot.thoughts;
      }

      if (!this.clusterContext.warningShown && this.clusterContext.lastError) {
        console.warn(
          `⚠️  Hive thought stream unavailable${
            this.clusterContext.lastError ? ` (${this.clusterContext.lastError.message})` : ''
          }`
        );
        this.clusterContext.warningShown = true;
      }
    }

    try {
      const content = await fs.readFile(this.thoughtsFile, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch (error) {
      return [];
    }
  }

  /**
   * Load evaluation metrics
   */
  async loadMetrics() {
    try {
      const content = await fs.readFile(this.metricsFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get latest coordinator report
   */
  async getLatestReport() {
    try {
      const files = await fs.readdir(this.coordinatorDir);
      const reviewFiles = files
        .filter(f => f.startsWith('review_') && f.endsWith('.md'))
        .sort()
        .reverse();
      
      if (reviewFiles.length === 0) return null;
      
      const content = await fs.readFile(
        path.join(this.coordinatorDir, reviewFiles[0]),
        'utf-8'
      );
      
      return {
        filename: reviewFiles[0],
        content: content
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Load embeddings cache
   */
  async loadEmbeddingsCache() {
    try {
      const content = await fs.readFile(this.embeddingsCache, 'utf-8');
      const cache = JSON.parse(content);
      cache.version = cache.version || 1;
      cache.nodes = Array.isArray(cache.nodes) ? cache.nodes : [];
      cache.thoughts = Array.isArray(cache.thoughts) ? cache.thoughts : [];
      if (cache.cluster === undefined) {
        cache.cluster = null;
      }
      return cache;
    } catch (error) {
      return {
        version: 3,
        created: new Date().toISOString(),
        stateHash: null,
        cluster: null,
        nodes: [],
        thoughts: []
      };
    }
  }

  /**
   * Get embedding for text
   */
  async getEmbedding(text) {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000),
        encoding_format: 'float'
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('Embedding error:', error.message);
      return null;
    }
  }

  /**
   * Calculate cosine similarity
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Load live findings from agent journals (for real-time dashboard updates)
   * Supplements baseline state.json.gz with findings added since last save
   */
  async loadLiveJournals() {
    const agentsDir = path.join(this.runtimeDir, 'agents');
    const findings = [];
    
    try {
      const agentDirs = await fs.readdir(agentsDir);
      
      for (const agentId of agentDirs) {
        if (!agentId.startsWith('agent_')) continue;
        
        // Load findings.jsonl
        const findingsPath = path.join(agentsDir, agentId, 'findings.jsonl');
        try {
          const content = await fs.readFile(findingsPath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              findings.push({ ...entry, agentId });
            } catch (parseError) {
              // Skip corrupted line (crash-safe)
              console.debug('Skipping corrupted journal line', { agentId, line: line.substring(0, 50) });
            }
          }
        } catch (readError) {
          // No findings journal for this agent yet (normal)
        }
        
        // Load insights.jsonl
        const insightsPath = path.join(agentsDir, agentId, 'insights.jsonl');
        try {
          const content = await fs.readFile(insightsPath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              findings.push({ ...entry, agentId });
            } catch (parseError) {
              console.debug('Skipping corrupted journal line', { agentId, line: line.substring(0, 50) });
            }
          }
        } catch (readError) {
          // No insights journal for this agent yet (normal)
        }
      }
    } catch (dirError) {
      // Agents directory doesn't exist yet (normal on fresh runs)
      return [];
    }
    
    return findings;
  }

  /**
   * Merge baseline nodes with live journal findings
   * Deduplicates by nodeId, preferring baseline (already has embeddings)
   */
  mergeNodesWithJournals(baselineNodes, liveJournals) {
    const nodeMap = new Map();
    
    // Add baseline nodes first (authoritative)
    for (const node of baselineNodes) {
      if (node && node.id) {
        nodeMap.set(node.id, node);
      }
    }
    
    // Add live journal entries (only if not already in baseline)
    for (const finding of liveJournals) {
      if (!finding || !finding.nodeId) continue;
      
      if (!nodeMap.has(finding.nodeId)) {
        // Convert journal entry to node format
        const prefix = finding.type === 'insight' ? '[AGENT INSIGHT: ' : '[AGENT: ';
        const concept = finding.content.startsWith(prefix) 
          ? finding.content 
          : `${prefix}${finding.agentId}] ${finding.content}`;
        
        nodeMap.set(finding.nodeId, {
          id: finding.nodeId,
          concept,
          tag: finding.tag,
          created: finding.timestamp,
          accessed: finding.timestamp,
          activation: 0.9, // Recent finding = high activation
          weight: 1.0,
          embedding: null, // No embedding yet (acceptable - keyword search still works)
          _liveJournal: true, // Flag for debugging
          _agentId: finding.agentId
        });
      }
    }
    
    return Array.from(nodeMap.values());
  }

  /**
   * Query memory network with semantic search
   * NOW INCLUDES: Live findings from agent journals for real-time updates
   */
  async queryMemory(state, query, options = {}) {
    const {
      limit = 30,
      includeConnected = false,
      deep = false,
      useSemanticSearch = true,
      filterTags = null  // NEW: Optional tag filter for targeted queries
    } = options;
    
    // NEW: Load live journals even if baseline doesn't exist yet (fresh runs)
    const baselineNodes = (state.memory && state.memory.nodes) ? state.memory.nodes : [];
    const liveJournals = await this.loadLiveJournals();
    const allNodes = this.mergeNodesWithJournals(baselineNodes, liveJournals);
    
    // If no nodes at all (fresh run, no agents yet), return empty
    if (allNodes.length === 0) {
      return [];
    }
    
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    
    // Get query embedding
    let queryEmbedding = null;
    let embeddingsCache = null;
    
    if (useSemanticSearch) {
      try {
        embeddingsCache = await this.loadEmbeddingsCache();
        queryEmbedding = await this.getEmbedding(query);
      } catch (error) {
        console.log('Semantic search unavailable, using keyword-only');
      }
    }
    
    // Score each memory node (now includes live journals)
    const scored = allNodes.map(node => {
      const conceptLower = (node.concept || '').toLowerCase();
      
      // Semantic score
      let semanticScore = 0;
      if (queryEmbedding && embeddingsCache) {
        const nodeCache = this.findNodeEmbedding(embeddingsCache, node);
        const embeddingVector = nodeCache?.embedding || node.embedding;
        if (Array.isArray(embeddingVector) && embeddingVector.length === queryEmbedding.length) {
          const similarity = this.cosineSimilarity(queryEmbedding, embeddingVector);
          semanticScore = similarity * 100;
        }
      }
      
      // Keyword score
      let keywordScore = 0;
      if (conceptLower.includes(queryLower)) {
        keywordScore += 50;
      }
      queryWords.forEach((word, idx) => {
        if (conceptLower.includes(word)) {
          keywordScore += (queryWords.length - idx) * 3;
        }
      });
      keywordScore = Math.min(keywordScore, 100);
      
      // Combined score
      let combinedScore = queryEmbedding 
        ? (semanticScore * 0.7) + (keywordScore * 0.3)
        : keywordScore;
      
      // Boost by memory importance
      const memoryMultiplier = (node.activation || 0.5) * (node.weight || 0.5);
      combinedScore *= (0.5 + memoryMultiplier);
      
      // Boost agent insights
      if (node.tag) {
        const tags = Array.isArray(node.tag) ? node.tag : [node.tag];
        if (tags.some(t => t && String(t).includes('agent_insight'))) combinedScore *= 1.4;
        if (tags.some(t => t && String(t).includes('breakthrough'))) combinedScore *= 1.6;
      }
      
      return { ...node, score: combinedScore, semanticScore, keywordScore };
    });
    
    // Apply tag filter if specified
    let filteredScored = scored;
    if (filterTags) {
      const tags = Array.isArray(filterTags) ? filterTags : [filterTags];
      filteredScored = scored.filter(node => {
        const nodeTags = Array.isArray(node.tag) ? node.tag : [node.tag];
        return tags.some(filterTag => 
          nodeTags.some(nodeTag => String(nodeTag).includes(filterTag))
        );
      });
    }
    
    // Sort and limit
    let results = filteredScored
      .filter(n => n.score > 0)
      .sort((a, b) => b.score - a.score);
    
    if (!deep) {
      results = results.slice(0, limit);
    }
    
    // Include connected nodes if requested
    if (includeConnected && state.memory.edges && results.length > 0) {
      const connectedIds = new Set();
      const topIds = new Set(results.slice(0, deep ? 20 : 5).map(n => n.id));
      
      state.memory.edges.forEach(edge => {
        if (topIds.has(edge.source)) connectedIds.add(edge.target);
        if (topIds.has(edge.target)) connectedIds.add(edge.source);
      });
      
      const connected = state.memory.nodes
        .filter(n => connectedIds.has(n.id) && !topIds.has(n.id))
        .map(n => ({ ...n, score: 0, connected: true }));
      
      const connectedLimit = deep ? connected.length : 15;
      results = [...results, ...connected.slice(0, connectedLimit)];
    }
    
    return results;
  }

  /**
   * Query thoughts with semantic search
   */
  async queryThoughts(thoughts, query, options = {}) {
    const { limit = 20, deep = false } = options;
    
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    
    // Get query embedding
    let queryEmbedding = null;
    let embeddingsCache = null;
    
    try {
      embeddingsCache = await this.loadEmbeddingsCache();
      queryEmbedding = await this.getEmbedding(query);
    } catch (error) {
      console.log('Semantic search unavailable for thoughts');
    }
    
    const scored = thoughts.map(thought => {
      const thoughtText = (thought.thought || '').toLowerCase();
      const goalText = (thought.goal || '').toLowerCase();
      
      // Semantic score
      let semanticScore = 0;
      if (queryEmbedding && embeddingsCache) {
        const thoughtCache = this.findThoughtEmbedding(embeddingsCache, thought);
        const embeddingVector = thoughtCache?.embedding;
        if (Array.isArray(embeddingVector) && embeddingVector.length === queryEmbedding.length) {
          const similarity = this.cosineSimilarity(queryEmbedding, embeddingVector);
          semanticScore = similarity * 100;
        }
      }
      
      // Keyword score
      let keywordScore = 0;
      queryWords.forEach(word => {
        if (thoughtText.includes(word)) keywordScore += 15;
        if (goalText.includes(word)) keywordScore += 10;
      });
      if (thoughtText.includes(queryLower)) keywordScore += 30;
      keywordScore = Math.min(keywordScore, 100);
      
      // Combined score
      let combinedScore = queryEmbedding
        ? (semanticScore * 0.7) + (keywordScore * 0.3)
        : keywordScore;
      
      // Boost by surprise
      combinedScore *= (1 + (thought.surprise || 0));
      
      return { ...thought, score: combinedScore, semanticScore, keywordScore };
    });
    
    let results = scored
      .filter(t => t.score > 0)
      .sort((a, b) => b.score - a.score);
    
    if (!deep) {
      results = results.slice(0, limit);
    }
    
    return results;
  }

  /**
   * Execute query using GPT-5.2 Responses API
   * 
   * CONTEXT OPTIMIZATION (2025-12-11):
   * - Increased memory node limit from 50 to 200 (6.8% → 27.4% coverage)
   * - Increased connected concepts from 30 to 100 (full coverage in most cases)
   * - Total context usage: ~40% of GPT-5.2's 128K token limit (safe headroom)
   * - Rationale: Query engine is only interface to COSMO's brain - comprehensive access critical
   */
  async executeQuery(query, options = {}) {
    const startTime = Date.now(); // Performance tracking

    const {
      model = 'gpt-5.2',  // Default to gpt-5.2
      mode = 'normal',
      exportFormat = null,
      // NEW: Enhancement options (all opt-in)
      includeEvidenceMetrics = false,
      enableSynthesis = false,
      followUpContext = null,
      includeCoordinatorInsights = true, // Default true for better results
      outputFiles = null, // NEW: Output files from executeEnhancedQuery
      baseAnswer = null, // NEW: For executive mode - compress existing answer instead of re-querying
      priorContext = null // NEW: For follow-up queries - includes prior query and answer
    } = options;
    
    // Model validation removed — any model routable by UnifiedClient is valid
    
    // EXECUTIVE MODE SPECIAL CASE: Compress existing answer, don't re-query brain
    if (mode === 'executive' && baseAnswer) {
      return await this.executeExecutiveCompression(query, baseAnswer, options);
    }
    
    // Load data
    const state = await this.loadBrainState();
    const stateHash = getStateHashForCache(state);
    const cacheKey = `${stateHash}:${query}:${model}:${mode}`;

    if (this.queryCache.has(cacheKey)) {
      this.performanceMetrics.cacheHits++;
      return this.queryCache.get(cacheKey);
    }
    
    this.performanceMetrics.cacheMisses++;

    const thoughts = await this.loadThoughts();
    const metrics = await this.loadMetrics();
    const report = await this.getLatestReport();
    
    // ALWAYS use full knowledge - no depth limits
    // Get ALL relevant memory and thoughts (sorted by relevance)
    const relevantMemory = await this.queryMemory(state, query, {
      limit: 1000,  // Get all relevant nodes
      includeConnected: true,
      deep: true,
      useSemanticSearch: true
    });
    
    const relevantThoughts = await this.queryThoughts(thoughts, query, {
      limit: 1000,  // Get all relevant thoughts
      deep: true
    });
    
    // Build context - mode only affects display, not what data we gather
    let context = this.buildContext(state, relevantMemory, relevantThoughts, metrics, report, mode, outputFiles);
    
    // MONITORING: Log context statistics (enhanced for Phase 1)
    const memoryNodesFound = relevantMemory.filter(n => !n.connected).length;
    const modeLimits = {
      fast: 100, normal: 200, deep: 400, raw: 150, report: 600, innovation: 300, consulting: 300, executive: 0
    };
    const modeLimit = modeLimits[mode] || 200;
    const memoryNodesShown = Math.min(memoryNodesFound, modeLimit);
    
    const contextStats = {
      mode: mode,
      modeLimit: modeLimit,
      memoryNodesFound: memoryNodesFound,
      memoryNodesShown: memoryNodesShown,
      connectedConceptsFound: relevantMemory.filter(n => n.connected).length,
      connectedConceptsShown: Math.min(relevantMemory.filter(n => n.connected).length, 100),
      thoughtsShown: Math.min(relevantThoughts.length, 40),
      contextChars: context.length,
      estimatedTokens: Math.ceil(context.length / 4),
      percentOfLimit: Math.round((Math.ceil(context.length / 4) / 128000) * 100)
    };
    console.log(`[QUERY ENGINE] Context built for mode '${mode}':`, contextStats);
    console.log(`[QUERY ENGINE] Memory coverage: ${contextStats.memoryNodesShown}/${contextStats.memoryNodesFound} (${((contextStats.memoryNodesShown/contextStats.memoryNodesFound)*100).toFixed(1)}%) [mode limit: ${modeLimit}]`);
    console.log(`[QUERY ENGINE] Connected concepts: ${contextStats.connectedConceptsShown}/${contextStats.connectedConceptsFound} (${contextStats.connectedConceptsFound > 0 ? ((contextStats.connectedConceptsShown/contextStats.connectedConceptsFound)*100).toFixed(1) : 0}%)`);
    console.log(`[QUERY ENGINE] Context size: ${contextStats.contextChars.toLocaleString()} chars (~${contextStats.estimatedTokens.toLocaleString()} tokens, ${contextStats.percentOfLimit}% of 128K limit)`);
    
    // FOLLOW-UP SUPPORT: Prepend prior conversation if provided
    // This allows the model to build on previous answers
    if (priorContext && priorContext.query && priorContext.answer) {
      console.log(`[QUERY ENGINE] Including prior context for follow-up query`);
      
      // Sanitize the prior answer to prevent formatting issues
      let sanitizedAnswer = priorContext.answer
        .replace(/\r\n/g, '\n')  // Normalize line endings
        .trim();
      
      const sanitizedQuery = priorContext.query
        .replace(/\r\n/g, '\n')
        .trim();
      
      // Truncate prior answer if too large (keep first 50K chars ~12K tokens)
      const maxPriorAnswerLength = 50000;
      if (sanitizedAnswer.length > maxPriorAnswerLength) {
        console.warn(`[QUERY ENGINE] Prior answer is large (${sanitizedAnswer.length} chars), truncating to ${maxPriorAnswerLength}`);
        sanitizedAnswer = sanitizedAnswer.substring(0, maxPriorAnswerLength) + '\n\n[...answer truncated for context size...]';
      }
      
      const priorContextSection = `# Prior Conversation\n\n` +
        `The user previously asked:\n` +
        `"${sanitizedQuery}"\n\n` +
        `And received this answer:\n` +
        `${sanitizedAnswer}\n\n` +
        `---\n\n` +
        `The following question is a follow-up to the above conversation.\n\n`;
      
      context = priorContextSection + context;
      
      // Log context size for debugging
      const contextLength = context.length;
      console.log(`[QUERY ENGINE] Total context length with prior: ${contextLength} chars (~${Math.round(contextLength / 4)} tokens)`);
      if (contextLength > 400000) { // ~100K tokens
        console.warn(`[QUERY ENGINE] Context is very large (${contextLength} chars) - may hit API limits`);
      }
    }
    
    // Map mode to GPT-5.2 reasoning parameters
    const reasoningConfig = {
      fast: { 
        reasoningEffort: 'low', 
        maxTokens: 8000, 
        verbosity: 'low' 
      },
      normal: { 
        reasoningEffort: 'medium', 
        maxTokens: 15000, 
        verbosity: 'medium' 
      },
      deep: { 
        reasoningEffort: 'high', 
        maxTokens: 25000, 
        verbosity: 'high' 
      },
      raw: {
        reasoningEffort: 'medium',
        maxTokens: 20000,
        verbosity: 'medium'
      },
      report: { 
        reasoningEffort: 'high', 
        maxTokens: 16000, // API maximum output limit
        verbosity: 'high' 
      },
      innovation: { 
        reasoningEffort: 'high', 
        maxTokens: 16000, // API maximum output limit
        verbosity: 'high' 
      },
      grounded: {
        reasoningEffort: 'medium',
        maxTokens: 18000,
        verbosity: 'medium'
      },
      consulting: { 
        reasoningEffort: 'high', 
        maxTokens: 16000, // API maximum output limit
        verbosity: 'high' 
      },
      executive: {
        reasoningEffort: 'medium',
        maxTokens: 8000,
        verbosity: 'high'
      }
    };
    
    const config = reasoningConfig[mode] || reasoningConfig.normal;
    
    // Get instructions (system prompt) - route to appropriate prompt based on mode
    let instructions;
    if (mode === 'raw') {
      instructions = this.getRawSystemPrompt();
    } else if (mode === 'report') {
      instructions = this.getReportSystemPrompt();
    } else if (mode === 'innovation') {
      instructions = this.getInnovationSystemPrompt();
    } else if (mode === 'consulting') {
      instructions = this.getConsultingSystemPrompt();
    } else if (mode === 'grounded') {
      instructions = this.getGroundedSystemPrompt();
    } else if (mode === 'executive') {
      instructions = this.getExecutiveSystemPrompt();
    } else {
      instructions = this.getStandardSystemPrompt(mode);
    }
    
    // FOLLOW-UP MODIFIER: Add context awareness to instructions
    if (priorContext && priorContext.query && priorContext.answer) {
      const followUpPrefix = `IMPORTANT: This is a FOLLOW-UP QUERY.\n\n` +
        `The user has previously asked a question and received an answer. ` +
        `That prior conversation is included at the start of the context below.\n\n` +
        `Your response should:\n` +
        `- Be aware of and build upon the prior exchange\n` +
        `- Reference the previous answer naturally when relevant\n` +
        `- Maintain continuity with the previous response\n` +
        `- Answer the new question in light of what was already discussed\n\n` +
        `---\n\n`;
      
      instructions = followUpPrefix + instructions;
    }
    
    // Generate answer using GPT-5.2 Responses API
    let response;
    try {
      response = await this.gpt5Client.generate({
        model: model,
        instructions: instructions,
        input: `${context}\n\nQuestion: ${query}`,
        reasoningEffort: config.reasoningEffort,
        maxTokens: config.maxTokens,
        verbosity: config.verbosity
      });
    } catch (error) {
      console.error('[QUERY ENGINE] GPT-5.2 API call failed:', error);
      console.error('[QUERY ENGINE] Context length:', context.length, 'chars');
      console.error('[QUERY ENGINE] Instructions length:', instructions.length, 'chars');
      throw new Error(`GPT-5.2 API error: ${error.message || 'Unknown error'}`);
    }
    
    const answer = response.content || response.message?.content || '';
    
    if (!answer) {
      console.error('[QUERY ENGINE] No content received from GPT-5.2');
      console.error('[QUERY ENGINE] Response:', JSON.stringify(response, null, 2));
      throw new Error('No content received from GPT-5.2 (response was empty)');
    }
    
    // Build result
    const liveNodeCount = relevantMemory.filter(n => n._liveJournal).length;
    
    const result = {
      answer,
      metadata: {
        model,
        mode,
        reasoningEffort: config.reasoningEffort,
        sources: {
          memoryNodes: relevantMemory.length,
          thoughts: relevantThoughts.length,
          edges: state.memory?.edges?.length || 0,
          liveJournalNodes: liveNodeCount // NEW: Shows how many findings are from active agents
        },
        timestamp: new Date().toISOString()
      }
    };

    // NEW: Add evidence quality metrics (opt-in)
    if (includeEvidenceMetrics) {
      try {
        const allMemory = state.memory?.nodes || [];
        result.metadata.evidenceQuality = await this.evidenceAnalyzer.analyzeEvidenceQuality(
          state,
          relevantMemory,
          relevantThoughts,
          allMemory,
          query
        );
      } catch (error) {
        console.error('Evidence analysis failed:', error);
        result.metadata.evidenceQuality = { error: 'Analysis failed' };
      }
    }

    // NEW: Add insight synthesis (opt-in)
    if (enableSynthesis) {
      try {
        result.metadata.synthesis = await this.insightSynthesizer.synthesize(
          state,
          relevantMemory,
          relevantThoughts,
          query
        );
      } catch (error) {
        console.error('Insight synthesis failed:', error);
        result.metadata.synthesis = { error: 'Synthesis failed' };
      }
    }

    // NEW: Add coordinator insights (default enabled)
    if (includeCoordinatorInsights) {
      try {
        const coordinatorResults = await this.coordinatorIndexer.getInsightsForContext(query, 5);
        if (coordinatorResults) {
          result.metadata.coordinatorInsights = coordinatorResults;
        }
      } catch (error) {
        console.error('Coordinator insight search failed:', error);
      }
    }

    // NEW: Include follow-up context if provided
    if (followUpContext) {
      result.metadata.followUpContext = {
        previousQuery: followUpContext.previousQuery,
        contextPreserved: true
      };
    }

    // NEW: Create or update session for follow-ups
    if (followUpContext && followUpContext.sessionId) {
      // Add to existing session
      const sessionInfo = this.contextTracker.addToSession(
        followUpContext.sessionId,
        query,
        answer,
        result.metadata
      );
      result.metadata.sessionId = sessionInfo.sessionId;
      result.metadata.sessionContext = sessionInfo.context;
    } else {
      // Create new session
      const sessionInfo = this.contextTracker.createSession(
        query,
        answer,
        result.metadata
      );
      result.metadata.sessionId = sessionInfo.sessionId;
      result.metadata.sessionContext = sessionInfo.context;
    }
    
    // Cache result
    if (this.queryCache.size >= this.maxCacheSize) {
      const firstKey = this.queryCache.keys().next().value;
      this.queryCache.delete(firstKey);
    }
    this.queryCache.set(cacheKey, result);

    // Performance tracking
    const queryTime = Date.now() - startTime;
    this.performanceMetrics.queriesProcessed++;
    this.performanceMetrics.avgQueryTime = 
      (this.performanceMetrics.avgQueryTime * (this.performanceMetrics.queriesProcessed - 1) + queryTime) / 
      this.performanceMetrics.queriesProcessed;
    
    // Track enhancement usage
    if (includeEvidenceMetrics) this.performanceMetrics.enhancementUsage.evidence++;
    if (enableSynthesis) this.performanceMetrics.enhancementUsage.synthesis++;
    if (includeCoordinatorInsights) this.performanceMetrics.enhancementUsage.coordinator++;
    if (followUpContext) this.performanceMetrics.enhancementUsage.followUps++;

    // Add performance metadata
    result.metadata.performance = {
      queryTime,
      cached: false
    };
    
    return result;
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      cacheHitRate: this.performanceMetrics.queriesProcessed > 0
        ? this.performanceMetrics.cacheHits / (this.performanceMetrics.cacheHits + this.performanceMetrics.cacheMisses)
        : 0,
      cacheSize: this.queryCache.size,
      maxCacheSize: this.maxCacheSize
    };
  }

  /**
   * Build context for query
   * Always includes full relevant knowledge - mode doesn't limit what's included
   */
  /**
   * Smart truncation that preserves sentence/paragraph boundaries
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string} Truncated text
   */
  smartTruncate(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    
    const truncated = text.substring(0, maxLength);
    
    // Try to cut at sentence boundary (period)
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);
    
    // Use sentence boundary if it's not too early (within 70% of target)
    if (cutPoint > maxLength * 0.7) {
      return text.substring(0, cutPoint + 1) + '...';
    }
    
    // Otherwise cut at last space to avoid mid-word
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.8) {
      return text.substring(0, lastSpace) + '...';
    }
    
    // Fallback: hard cut with ellipsis
    return truncated + '...';
  }

  buildContext(state, relevantMemory, relevantThoughts, metrics, report, mode, outputFiles = null) {
    let context = `# COSMO Research State\n\n`;
    const isGrounded = mode === 'grounded';
    
    // Run metadata
    if (state.runMetadata) {
      context += `## Configuration\n`;
      context += `- Domain: ${state.runMetadata.domain || 'Unknown'}\n`;
      context += `- Mode: ${state.runMetadata.explorationMode || 'Unknown'}\n`;
      context += `- Cycles: ${state.cycleCount}\n\n`;
    }

    // Skip ops/meta-heavy sections when using grounded mode
    const allowOpsContext = mode !== 'grounded';

    if (allowOpsContext && state.isCluster && state.cluster) {
      const cluster = state.cluster;
      const byInstance = state.memory?.byInstance || {};
      const inferredCount = Object.keys(byInstance).length;
      const instanceCount = cluster.instanceCount ?? (inferredCount > 0 ? inferredCount : null);
      const leader = cluster.leader || 'unknown';
      const backend = cluster.backend || 'filesystem';
      const goalClaims = cluster.overview?.goalClaims || {};
      const goalAllocator =
        cluster.overview?.goalAllocator ||
        cluster.overview?.goalAllocatorSummary ||
        cluster.stats?.goalAllocatorSummary ||
        {};
      const governance = cluster.overview?.governance || {};
      const specialization = cluster.overview?.specialization || {};

      context += `## Hive Summary\n`;
      context += `- Instances: ${instanceCount ?? 'unknown'} (leader ${leader})\n`;
      context += `- Backend: ${backend} • Health: ${cluster.health || 'unknown'}\n`;

      if (goalClaims.claimed !== undefined || goalClaims.unclaimed !== undefined) {
        const claimed = goalClaims.claimed ?? 0;
        const unclaimed = goalClaims.unclaimed ?? 0;
        context += `- Goal Claims: ${claimed} claimed / ${unclaimed} unclaimed\n`;
      }

      const successRate = Number(goalAllocator.successRate);
      if (Number.isFinite(successRate)) {
        context += `- Goal Claim Success: ${(successRate * 100).toFixed(1)}%\n`;
      }

      const alignmentScore = Number(specialization.alignmentScore);
      if (Number.isFinite(alignmentScore)) {
        context += `- Specialization Alignment: ${(alignmentScore * 100).toFixed(1)}%\n`;
      }

      const routingSignals = specialization.routingSignals;
      const specializationEntries = routingSignals
        ? (Array.isArray(routingSignals) ? routingSignals : Object.values(routingSignals))
            .filter(Boolean)
            .map(entry => `${entry.instanceId || 'instance'} → ${entry.profileName || entry.instanceId || 'profile'}`)
        : [];
      if (specializationEntries.length > 0) {
        context += `- Specialization: ${specializationEntries.join('; ')}\n`;
      }

      if (governance.override) {
        const modeLabel = governance.override.mode ? governance.override.mode.toUpperCase() : 'ACTIVE';
        context += `- Governance Override: ${modeLabel}${governance.override.reason ? ` — ${governance.override.reason}` : ''}\n`;
      } else if (governance.summary?.state) {
        context += `- Governance State: ${governance.summary.state}\n`;
      }

      const instanceRows = cluster.stats?.instances || [];
      if (instanceRows.length > 0) {
        context += `\n### Instance Snapshot\n`;
        instanceRows.slice(0, 12).forEach(inst => {
          const status = inst.status || (inst.clusterSync?.status ?? 'unknown');
          context += `- ${inst.instanceId}: cycles ${inst.cycles || 0}, goals ${inst.goals || 0}, memory ${inst.memory || 0}, status ${status}\n`;
        });
        context += `\n`;
      } else {
        context += `\n`;
      }
    }
    
    // Metrics
    if (allowOpsContext && metrics) {
      const m = metrics.metrics;
      context += `## Metrics\n`;
      context += `- Goals: ${m.goals.created} created, ${m.goals.pursued} pursued\n`;
      context += `- Agents: ${m.agents.totalSpawned} spawned\n`;
      context += `- Memory: ${m.memory.totalNodes} nodes, ${m.memory.totalEdges} edges\n\n`;
    }
    
    // Memory nodes - include all relevant matches (no artificial limits)
    const directMatches = relevantMemory.filter(n => !n.connected);
    const connectedMatches = relevantMemory.filter(n => n.connected);
    
    context += `## Relevant Memory (${directMatches.length} direct matches)\n\n`;
    // CONTEXT OPTIMIZATION (2025-12-11):
    // Phase 1: Mode-based limits to adapt context depth to query needs
    // Phase 2: Increased from 50 to 200 (normal mode) - other modes vary
    // Rationale: Query engine is the only interface to COSMO's brain - comprehensive access critical
    const modeLimits = {
      fast: 100,       // Quick factual answers
      normal: 200,     // Standard analytical depth
      deep: 400,       // Comprehensive analysis (54.8% coverage)
      raw: 150,        // Direct data access
      grounded: 300,   // Truth extraction with more substance, less ops
      report: 600,     // Full academic report (82.2% coverage)
      innovation: 300, // Creative synthesis
      consulting: 300, // Strategic advice
      executive: 0     // Compression only (no context)
    };
    const memoryNodeLimit = modeLimits[mode] || 200;
    
    directMatches.slice(0, memoryNodeLimit).forEach((node, i) => {
      // TIERED TRUNCATION (2025-12-11):
      // Top 20 nodes: 2000 chars (nearly full)
      // Next 80 nodes: 1000 chars (substantial detail)
      // Next 100 nodes: 700 chars (moderate detail)
      // Rest: 500 chars (summary)
      let maxTruncation;
      if (i < 20) maxTruncation = isGrounded ? 1600 : 2000;
      else if (i < 100) maxTruncation = isGrounded ? 1000 : 1000;
      else if (i < 200) maxTruncation = isGrounded ? 750 : 700;
      else maxTruncation = isGrounded ? 500 : 500;
      
      // Smart truncation preserves sentence boundaries
      const conceptText = this.smartTruncate(node.concept, maxTruncation);
      const instanceLabel = node.instanceId ? ` [${node.instanceId}]` : '';
      // CRITICAL: Show actual node ID for accurate citations
      context += `[Mem ${node.id}] ${conceptText}${instanceLabel}\n`;
      if (node.semanticScore) {
        context += `   Score: ${node.score.toFixed(1)} (semantic: ${node.semanticScore.toFixed(1)}, keyword: ${node.keywordScore.toFixed(1)})\n`;
      }
      if (node.specializationProfile) {
        context += `   Specialization: ${node.specializationProfile}\n`;
      }
      context += `\n`;
    });
    
    // Include connected concepts
    if (connectedMatches.length > 0) {
      context += `\n### Connected Concepts (${connectedMatches.length}):\n`;
      // CONTEXT OPTIMIZATION (2025-12-11):
      // Increased from 30 to ALL connected concepts (typically 50-100)
      // Connected concepts are crucial for understanding relationships and context
      // Since count is usually modest, showing all is safe and important
      const connectedLimit = Math.min(connectedMatches.length, isGrounded ? 90 : 100); // Keep breadth in grounded while avoiding bloat
      connectedMatches.slice(0, connectedLimit).forEach((node, i) => {
        const conceptText = node.concept.length > 300 ? node.concept.substring(0, 300) + '...' : node.concept;
        const instanceLabel = node.instanceId ? ` [${node.instanceId}]` : '';
        // CRITICAL: Show actual node ID for accurate citations
        context += `[Mem ${node.id}] ${conceptText}${instanceLabel}\n`;
      });
      context += `\n`;
    }

    if (state.goals?.active && state.goals.active.length > 0) {
      context += `## Active Goals (${state.goals.active.length})\n\n`;
      state.goals.active.slice(0, 40).forEach((goal, i) => {
        const instanceLabel = goal.instanceId ? ` [${goal.instanceId}]` : '';
        const goalDescription =
          goal.description || goal.summary || goal.title || goal.goal || '(No description provided)';
        const claimedBy = goal.claimedBy || goal.claimed_by || null;
        context += `${i + 1}. ${goalDescription}${instanceLabel}\n`;
        if (claimedBy) {
          context += `   Claimed by: ${claimedBy}\n`;
        }
        if (goal.specializationProfile) {
          context += `   Specialization: ${goal.specializationProfile}\n`;
        }
        if (goal.campaign) {
          context += `   Campaign: ${goal.campaign}\n`;
        }
        context += `\n`;
      });
    }
    
    // Thoughts - include all relevant (top 40 for reasonable context)
    const thoughtLimit = isGrounded ? 25 : 40;
    if (relevantThoughts.length > 0) {
      context += `## Relevant Thought Stream (${relevantThoughts.length} thoughts)\n\n`;
      relevantThoughts.slice(0, thoughtLimit).forEach((t, i) => {
        // Truncate long thoughts
        const thoughtText = t.thought.length > 400 ? t.thought.substring(0, 400) + '...' : t.thought;
        const instanceLabel = t.instanceId ? ` • ${t.instanceId}` : '';
        context += `${i + 1}. Cycle ${t.cycle} [${t.role}${instanceLabel}]: ${thoughtText}\n`;
        if (t.goal) {
          const goalText = t.goal.length > 200 ? t.goal.substring(0, 200) + '...' : t.goal;
          context += `   Goal: ${goalText}\n`;
        }
        if (t.specializationProfile) {
          context += `   Specialization: ${t.specializationProfile}\n`;
        }
        if (t.surprise && t.surprise > 0.2) {
          context += `   Surprise: ${(t.surprise * 100).toFixed(1)}%\n`;
        }
        context += `\n`;
      });
    }
    
    // Coordinator review - include for comprehensive analysis
    if (!isGrounded && report) {
      const reviewLimit = 15000; // Consistent limit
      context += `## Meta-Coordinator Review\n\n${report.content.substring(0, reviewLimit)}\n\n`;
      if (report.content.length > reviewLimit) {
        context += `[Review truncated - full review is ${report.content.length} chars]\n\n`;
      }
    }
    
    // Agent output files - include if provided (LEVEL 1 & 2 enhancement)
    if (!isGrounded && outputFiles && outputFiles.total > 0) {
      context += `## Agent Output Files (${outputFiles.total} files)\n\n`;
      
      if (outputFiles.codeCreation.length > 0) {
        context += `### Generated Code Files (${outputFiles.codeCreation.length})\n`;
        // Show 5 code files (often debug/intermediate, so keep modest)
        outputFiles.codeCreation.slice(0, 5).forEach((file, i) => {
          const preview = file.content.substring(0, 500) + (file.content.length > 500 ? '...' : '');
          context += `\n**${i + 1}. ${file.filename}** (${file.agentId})\n`;
          context += `Path: \`${file.path}\` • Size: ${file.size} bytes\n`;
          context += `\`\`\`${file.extension.slice(1) || 'text'}\n${preview}\n\`\`\`\n`;
        });
        context += `\n`;
      }
      
      if (outputFiles.documents.length > 0) {
        context += `### Generated Documents (${outputFiles.documents.length})\n`;
        // ENHANCEMENT: Show more documents (8 instead of 3) - documents are key outputs
        // Give longer previews (1000 chars) for richer context about what was created
        outputFiles.documents.slice(0, 8).forEach((file, i) => {
          const preview = file.content.substring(0, 1000) + (file.content.length > 1000 ? '...' : '');
          context += `\n**${i + 1}. ${file.title || file.filename}**`;
          if (file.memoryGuided && file.relevanceScore) {
            context += ` (Relevance: ${file.relevanceScore.toFixed(1)})`;
          }
          if (file.agentId) {
            context += ` (${file.agentId})`;
          }
          context += `\n`;
          context += `Path: \`${file.path}\` • Size: ${file.size} bytes • Words: ${Math.round(file.size / 6)}\n`;
          context += `${preview}\n\n`;
        });
      }
      
      if (outputFiles.codeExecution.length > 0) {
        context += `### Code Execution Outputs (${outputFiles.codeExecution.length})\n`;
        outputFiles.codeExecution.slice(0, 3).forEach((file, i) => {
          context += `${i + 1}. ${file.filename} (${file.path}) - ${file.size} bytes\n`;
        });
        context += `\n`;
      }
      
      // Top-level deliverables (CRITICAL FIX: These were loaded but never shown to LLM)
      if (outputFiles.deliverables.length > 0) {
        context += `### Top-Level Deliverables (${outputFiles.deliverables.length})\n`;
        outputFiles.deliverables.slice(0, 5).forEach((file, i) => {
          const preview = file.content.substring(0, 1500) + (file.content.length > 1500 ? '...' : '');
          context += `\n**${i + 1}. ${file.title || file.filename}**`;
          if (file.memoryGuided && file.relevanceScore) {
            context += ` (Relevance: ${file.relevanceScore.toFixed(1)})`;
          }
          context += `\n`;
          context += `Path: \`${file.path}\` • Size: ${file.size} bytes • Words: ${Math.round(file.size / 6)}\n`;
          context += `${preview}\n\n`;
        });
      }
    }
    
    return context;
  }

  /**
   * Get system prompt for raw mode - no choreography, just direct answers
   */
  getRawSystemPrompt() {
    return `You are a direct interface to COSMO's research data. Answer questions using the available evidence.

You have access to: memory nodes, thought stream, goals, metrics, coordinator reviews, AND agent output files.

IMPORTANT: When "Agent Output Files" are shown in the context, you CAN and SHOULD read their contents directly.
These are actual file contents loaded from the outputs/ directory - not just metadata references.

FILE ACCESS DETAILS:
- Files are shown as PREVIEWS (first 1,500 chars for deliverables, 500-1,000 for others)
- The preview includes the file path, size, and content beginning
- If you need the FULL content: tell user "read the full contents of outputs/[filename]"
- For questions answerable from previews, use what's shown

FILE GENERATION (when user requests):
- When user asks "create a file", "generate HTML", etc., provide complete content in code blocks
- Use proper markdown: \`\`\`html\\n[complete content]\\n\`\`\` or \`\`\`python\\n[complete content]\\n\`\`\`
- The system will automatically extract and save your code blocks as files
- Say "Here is the [type] content:" NOT "I created a file at [path]"
- Be complete - include all necessary code, no placeholders or TODOs for essential functionality

CITATION FORMAT:
- Memory nodes are shown as "[Mem X] concept text" - cite them as [Mem X]
- Cycles are shown as "Cycle N [role]: thought" - cite them as "Cycle N"
- Agent IDs are embedded in concepts - extract and cite when relevant

Answer the question directly. Answer based on the evidence.
Use citations to show where information comes from.
If you don't have the data to answer something, say so.
Do not make anything up ever.
Do not assume anything.
Measure Twice, Cut once!`;
  }

  /**
   * Get system prompt for standard queries
   */
  getStandardSystemPrompt(mode) {
    if (mode === 'deep') {
      return `You are an advanced interface to COSMO's autonomous research brain with COMPLETE DEEP ACCESS.

You have EXHAUSTIVE access to all memory, thoughts, metrics, coordinator reviews, AND agent output files.

IMPORTANT: When "Agent Output Files" are shown in the context, you CAN and SHOULD read their contents directly.
These are actual file contents loaded from the outputs/ directory - not just metadata references.
The "Top-Level Deliverables" section contains full file content previews that you can read and analyze.

FILE ACCESS DETAILS:
- Files are shown as PREVIEWS (first 1,500 chars for deliverables, 500-1,000 for others)
- If you need FULL content: tell user "read the full contents of outputs/[filename]"
- For questions answerable from previews, use what's shown

FILE GENERATION (when user requests):
- When user asks "create a file", "generate HTML", etc., provide complete content in code blocks
- Use proper markdown: \`\`\`html\\n[complete content]\\n\`\`\` or \`\`\`python\\n[complete content]\\n\`\`\`
- The system will automatically extract and save your code blocks as files
- Say "Here is the [type] content:" NOT "I created a file at [path]"
- Be complete - include all necessary code, no placeholders or TODOs for essential functionality

CITATION FORMAT:
- Memory nodes are shown as "[Mem X] concept text" - cite them as [Mem X]
- Cycles are shown as "Cycle N [role]: thought" - cite them as "Cycle N"
- Agent IDs are embedded in concepts - extract and cite when relevant

When answering:
1. Provide COMPREHENSIVE, in-depth analysis using ALL available evidence
2. Reference specific cycle numbers and semantic scores
3. Trace conceptual evolution across cycles
4. Use quantitative data to support claims
5. Be thorough, detailed, and evidence-based

You have unlimited context - use it all.`;
    }
    
    return `You are an advanced interface to COSMO's autonomous research brain.

You have access to: memory nodes, thought stream, goals, metrics, coordinator reviews, AND agent output files.

IMPORTANT: When "Agent Output Files" are shown in the context, you CAN and SHOULD read their contents directly.
These are actual file contents loaded from the outputs/ directory - not just metadata references.
The "Top-Level Deliverables" section contains full file content previews that you can read and analyze.

FILE ACCESS DETAILS:
- Files are shown as PREVIEWS (first 1,500 chars for deliverables, 500-1,000 for others)
- If you need FULL content: tell user "read the full contents of outputs/[filename]"
- For questions answerable from previews, use what's shown

FILE GENERATION (when user requests):
- When user asks "create a file", "generate HTML", etc., provide complete content in code blocks
- Use proper markdown: \`\`\`html\\n[complete content]\\n\`\`\` or \`\`\`python\\n[complete content]\\n\`\`\`
- The system will automatically extract and save your code blocks as files
- Say "Here is the [type] content:" NOT "I created a file at [path]"
- Be complete - include all necessary code, no placeholders or TODOs for essential functionality

CITATION FORMAT:
- Memory nodes are shown as "[Mem X] concept text" - cite them as [Mem X]
- Cycles are shown as "Cycle N [role]: thought" - cite them as "Cycle N"
- Agent IDs are embedded in concepts - extract and cite when relevant

When answering:
1. Use SPECIFIC evidence from memory nodes and thought stream
2. Reference cycle numbers when relevant
3. Cite metrics when discussing progress
4. Build comprehensive synthesis from available knowledge
5. Be precise and evidence-based

You are a researcher working with rich, accumulated knowledge. Focus on what you CAN synthesize and create from the evidence you have, not on what's missing. Even partial coverage often provides abundant foundation for insight.

Do NOT make up information ever.
Do not assume anything.
Measure Twice, Cut once!`;
  }

  /**
   * Get system prompt for grounded mode - deep truth extraction without ops/meta
   * Mirrors the deep truth extraction framing but explicitly avoids cluster/ops chatter.
   */
  getGroundedSystemPrompt() {
    return `You are a focused truth-extraction interface over COSMO's knowledge.

You have access to memory nodes, thought stream, goals, and deliverable previews.
Ignore infrastructure/state/ops unless the user asks (no cluster health, metrics, governance).

Answer with the same depth as DEEP mode, but keep the narrative non-meta.

When answering:
1) Use concrete evidence from memory nodes and thought stream
2) Keep focus on substantive findings, not system operations
3) Cite memory nodes as [Mem X] and cycles as "Cycle N" when they strengthen the point
4) Prefer crisp, declarative answers over meta commentary
5) If evidence is thin, say what's missing and move on without speculation

Do NOT make up information. Do NOT add ops/internal status.`;
  }

  /**
   * Get system prompt for report mode
   */
  getReportSystemPrompt() {
    return `You are generating a COMPREHENSIVE RESEARCH REPORT on COSMO's accumulated knowledge.

You have access to: memory nodes, thought stream, goals, metrics, coordinator reviews, AND agent output files.

IMPORTANT: When "Agent Output Files" are shown in the context, you CAN and SHOULD read their contents directly.
These are actual file contents loaded from the outputs/ directory - not just metadata references.
The "Top-Level Deliverables" section contains full file content previews that you can read and analyze.

FILE ACCESS DETAILS:
- Files are shown as PREVIEWS (first 1,500 chars for deliverables, 500-1,000 for others)
- If you need more content from a specific file, note it in your report

CITATION FORMAT:
- Memory nodes are shown as "[Mem X] concept text" - cite them as [Mem X]
- Cycles are shown as "Cycle N [role]: thought" - cite them as "Cycle N (divergence 0.XX)" when divergence is available
- Agent IDs are embedded in concepts like "[AGENT: agent_ID]" or "[AGENT INSIGHT: agent_ID]" - extract and cite

Generate a detailed, multi-section report with:

# EXECUTIVE SUMMARY
- 2-3 paragraph overview
- Most significant insights
- Primary conclusions

# DETAILED ANALYSIS
- In-depth examination
- Cite specific cycles and data points
- Multiple subsections as needed

# SUPPORTING EVIDENCE
- Key memory nodes and relationships
- Relevant thought chains
- Quantitative metrics

# SYNTHESIS FOUNDATION
- What knowledge is available and how it connects
- Confidence levels and evidence quality
- Opportunities for deeper exploration (if relevant)

# RECOMMENDATIONS
- Actionable next steps based on available evidence
- Priority areas for development
- Suggested approaches grounded in research

You are generating a research report from COSMO's accumulated knowledge. Focus on synthesizing and building from what's available. Frame any limitations as research opportunities, not deficits.

Do not make anything up ever.
Do not assume anything.
Measure Twice, Cut once.

Be thorough and professional.`;
  }

  /**
   * Get system prompt for innovation mode
   */
  getInnovationSystemPrompt() {
    return `You are a CREATIVE INNOVATION SYNTHESIZER using COSMO's research as inspiration for commercial opportunities.

You have access to: memory nodes, thought stream, goals, metrics, coordinator reviews, AND agent output files.

IMPORTANT: When "Agent Output Files" are shown in the context, you CAN and SHOULD read their contents directly.
These are actual file contents loaded from the outputs/ directory - not just metadata references.
The "Top-Level Deliverables" section contains full file content previews that you can read and analyze.
Files are shown as previews; if you need more, tell the user.

MODE: Creative Brainstorming (Not Auditable Truth Extraction)

Your purpose is to PROPOSE products, patents, and commercial strategies that GO BEYOND what research explicitly stated. You are allowed to be creative and forward-looking.

# RESEARCH FOUNDATION

First, ground your synthesis in what COSMO discovered:
- **Key Insights**: Quote relevant discoveries from memory nodes [Mem X]
- **Evidence**: Cite cycles, agents, convergence patterns for context
- **Patterns**: What themes emerged across cycles?

Use citations here to show what research inspired your thinking.

# CREATIVE SYNTHESIS: NOVEL PRODUCT CONCEPTS

Propose specific products/solutions inspired by the research:

For each concept:
- **Proposed Product/Concept**: [Your creative synthesis]
- **Inspired By**: Which research insights [Mem X] sparked this idea?
- **Novel Combination**: How does this combine insights in new ways?
- **Why Non-Obvious**: What makes this surprising or creative?
- **Rating**: BREAKTHROUGH / INCREMENTAL / DERIVATIVE (your assessment)

You may:
✓ Propose specific implementations beyond what research stated
✓ Combine insights in creative ways
✓ Name products and features
✓ Suggest technical approaches

# CREATIVE SYNTHESIS: COMMERCIALIZATION PATHWAYS

Brainstorm how to commercialize these ideas:
- **Potential Market Applications**: [Your ideas]
- **Value Proposition**: What problem would this solve?
- **Inspired By Research**: [Cite Mem X] that sparked this direction
- **What's Unknown**: Market validation, customer needs, competition

You may propose markets and use cases even if research doesn't contain market data.

# CREATIVE SYNTHESIS: STRATEGIC OPTIONS

Brainstorm strategic approaches:
- **Build / License / Partner / Spin-Out**: Evaluate options
- **Inspired By Research**: [Cite relevant insights]
- **Creative Additions**: What you're adding beyond research (timelines, team ideas, approaches)

# CREATIVE SYNTHESIS: NEXT STEPS TO VALIDATE

Propose what would be needed to turn research into commercial reality:
- **Technical Validation**: Prototypes, pilots, benchmarks
- **Market Validation**: Customer interviews, sizing, competition
- **Regulatory/Legal**: Patents, compliance, IP strategy
- **Inspired By**: Which research insights [from context] suggest these next steps?

# CLEARLY DISTINGUISH

In your output, clearly mark:
- **"Research shows:"** [Cited from Mem X] ← Grounded facts
- **"This suggests we could:"** [Your synthesis] ← Creative proposals
- **"Next steps:"** [Your brainstorming] ← Forward-looking ideas

Do not make anything up ever.
Do not assume anything.
Measure Twice, Cut once. 

This is BRAINSTORMING informed by research, not extraction of research findings. Be creative and actionable.`;
  }

  /**
   * Detect query type to apply contextual emphasis in executive summaries
   * Returns: 'market_opportunity', 'novel_concepts', 'meta_analysis', 'actionable', or 'general'
   */
  detectQueryType(query, baseAnswer) {
    const queryLower = query.toLowerCase();
    
    // PRIORITY 1: Exact matches from preset buttons (highest confidence)
    if (/what.*synthesis.*discover/i.test(query)) return 'meta_analysis';
    if (/within reach.*not too novel/i.test(query)) return 'market_opportunity';
    if (/looking for novelty.*mainstream.*test.*build/i.test(query)) return 'novel_concepts';
    if (/actionable.*test.*build/i.test(query)) return 'actionable';
    if (/strategic recommendations.*coordinator/i.test(query)) return 'meta_analysis';
    
    // PRIORITY 2: Strong keyword indicators (high confidence)
    if (queryLower.includes('tam') || queryLower.includes('sam') || 
        /market.*size|addressable.*market|buyers|budget.*per.*buyer/i.test(query)) {
      return 'market_opportunity';
    }
    
    if (/synthesis|consensus|divergence.*score|research.*findings/i.test(query)) {
      return 'meta_analysis';
    }
    
    if (/novel.*concepts|novelty|mainstream|testable|experimental/i.test(query)) {
      return 'novel_concepts';
    }
    
    // PRIORITY 3: Answer content analysis (medium confidence fallback)
    if (baseAnswer) {
      const answerLower = baseAnswer.toLowerCase();
      
      // Meta-analysis indicators
      if ((answerLower.match(/synthesis agent/gi) || []).length > 2 ||
          (answerLower.match(/divergence score/gi) || []).length > 2 ||
          answerLower.includes('coordinator review')) {
        return 'meta_analysis';
      }
      
      // Market opportunity indicators
      if (/TAM.*\$\d+[MB]|market size.*\$\d+[MB]/i.test(baseAnswer) ||
          (answerLower.includes('pricing') && answerLower.includes('customer'))) {
        return 'market_opportunity';
      }
      
      // Novel concepts indicators (research metrics without market data)
      if ((/\d+%.*accuracy|TPR|FPR|performance.*metric/i.test(baseAnswer)) &&
          !(/\$\d+[KMB]|pricing|TAM|SAM/i.test(baseAnswer))) {
        return 'novel_concepts';
      }
    }
    
    // PRIORITY 4: Default to general
    return 'general';
  }

  /**
   * Get query type-specific emphasis to prepend to executive prompt
   */
  getQueryTypeEmphasis(queryType) {
    const emphasisMap = {
      market_opportunity: `CONTEXT: This is a MARKET OPPORTUNITY analysis.
SECTION B PRIORITY: Extract specific TAM/SAM/buyer counts/pricing/unit economics.
SECTION C PRIORITY: Regulatory pressure, competitive gaps, buyer validation, procurement paths.
If market data is incomplete, be explicit: "Market sizing: [what exists]" or "Detailed market sizing not provided."`,

      novel_concepts: `CONTEXT: This is a NOVEL CONCEPTS/TECHNICAL analysis.
SECTION B PRIORITY: Pilot timelines, test metrics, performance targets, validation milestones.
If no market sizing exists, DO NOT force it. Write "Market sizing not provided" and focus on technical validation metrics.
SECTION C PRIORITY: Research consensus, technical validation evidence, divergence scores, competitive technical gaps.`,

      meta_analysis: `CONTEXT: This is a META-ANALYSIS of COSMO's research findings.
SECTION B SHOULD BE TITLED: "The Research Scope" (NOT "The Numbers")
SECTION B PRIORITY: List research scope metrics like: cycles analyzed, agents involved, divergence scores, branches explored, evolution timeline.
SECTION C PRIORITY: Core principles that emerged, strength of consensus (divergence scores), multi-branch validation.
SECTION D: Explain why these findings are trustworthy (convergence from independent agents, cross-validation).`,

      actionable: `CONTEXT: This is an ACTIONABLE RECOMMENDATIONS query.
SECTION B PRIORITY: Implementation timelines, resource requirements, success metrics, pilot scope.
SECTION C PRIORITY: Evidence of demand, precedent examples, risk mitigation strategies.
SECTION E: Prioritize immediate next actions (design partners, pilots, validation tests).`,

      general: '' // No emphasis, use base prompt as-is
    };

    return emphasisMap[queryType] || '';
  }

  /**
   * Execute executive compression - takes ONLY existing answer, no brain state access
   * This ensures executives get compressed views that are 100% faithful to the original answer
   */
  async executeExecutiveCompression(query, baseAnswer, options = {}) {
    const { model = 'gpt-5.2', baseMetadata = {} } = options;
    
    // SMART DETECTION: Determine query type to add contextual emphasis
    const queryType = this.detectQueryType(query, baseAnswer);
    console.log(`[Executive] Detected query type: ${queryType}`);
    console.log(`[Executive] Original query: ${query.substring(0, 100)}...`);
    
    // Get base prompt and add type-specific emphasis
    let instructions = this.getExecutiveSystemPrompt();
    const emphasis = this.getQueryTypeEmphasis(queryType);
    if (emphasis) {
      instructions = emphasis + '\n\n' + instructions;
      console.log(`[Executive] Applied ${queryType} emphasis modifier`);
    }
    
    // Build input - STRIPPED of all COSMO branding to prevent leakage
    let input = `# TEXT TO SUMMARIZE\n\n`;
    input += `Below is the full answer. Use ONLY THIS TEXT to produce your summary:\n\n`;
    input += `${baseAnswer}`;
    
    // Call GPT-5.1 with compression-only prompt
    const response = await this.gpt5Client.generate({
      model: model,
      instructions: instructions,
      input: input,
      reasoningEffort: 'low',
      maxTokens: 8000,
      verbosity: 'low'
    });
    
    let answer = response.content || response.message?.content || '';
    
    // Post-processing cleanup: Remove empty bullets and extra blank lines
    if (answer) {
      answer = answer
        .replace(/^\d+\.\s*$/gm, '')           // Remove empty numbered bullets (e.g., "7.")
        .replace(/^[•\-\*]\s*$/gm, '')          // Remove empty bullet points
        .replace(/\n{3,}/g, '\n\n');            // Collapse multiple blank lines to max 2
    }
    
    return {
      answer,
      metadata: {
        model,
        mode: 'executive',
        reasoningEffort: 'medium',
        queryType: queryType, // Include detected type in metadata
        sources: {
          memoryNodes: 0,
          thoughts: 0,
          edges: 0,
          compressedFrom: baseMetadata.mode || 'unknown'
        },
        baseQuery: {
          model: baseMetadata.model,
          mode: baseMetadata.mode,
          timestamp: baseMetadata.timestamp
        },
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Get system prompt for executive mode - compress to exec-ready view
   */
  getExecutiveSystemPrompt() {
    return `You are COSMO Executive Mode.

You receive a dense, technical COSMO answer.

Your job is to compress ONLY that answer into an executive-ready summary.

CRITICAL RULES:
- Use ONLY the text of the original answer
- NEVER add new information or speculation
- Remove ALL COSMO internals: [Mem 1234], [Cycle 7], agents, divergence scores
- Remove ALL implementation details: code, APIs, schemas, timelines, experiments
- Remove ALL technical jargon unless absolutely necessary
- Maximum length: 300 words total

YOUR GOAL:
Transform technical research into a decision-ready summary that answers:
1. What did we find?
2. How big is it?
3. Why is it real?
4. What could go wrong?
5. What should we do next?

DELIVER EXACTLY THESE SECTIONS:

NOTE: The labels like "(50 words max)" and "(4-6 bullets max)" below are instructions for YOU.
DO NOT include them in your actual output. They guide your compression, not part of the final summary.

**SECTION A: The Opportunity (50 words max)**
In 2-3 sentences, explain:
- What problem this solves
- What the solution is
- Why it matters NOW

Use plain English. No jargon. No technical terms.

Example:
"Healthcare providers face 62-minute breach breakout times and insurer-mandated recovery proof. We identified a $9M/year opportunity: instantly kill attacker sessions across all systems (not just password resets) and automate ransomware recovery drills with audit evidence."

**SECTION B: The Numbers (4-6 bullets max)**
Extract ONLY if present in the original answer:
- Revenue/ARR targets or market size (TAM/SAM)
- Customer/buyer counts
- Pricing or budget ranges
- Unit economics (payback, margins, CAC)
- Timeframes (12-month targets, etc.)

Format as scannable bullets. Use "~" or ranges for estimates.

SECTION B RULES:
IF answer has specific TAM/SAM/pricing per product:
  • List each product with numbers

IF answer only has vague totals:
  • Write "Detailed market sizing not provided"
  • List opportunity names only

NEVER write "$1-12B across categories" - either be specific or say "not provided"

Example:
- 12-month target: $9M new ARR, 50-70 customers
- Unit economics: 4-6 month payback, 85% gross margin
- Market: 6,100+ hospitals, 13,000+ school districts
- Pricing: $90K/year (healthcare), $40K/year (K-12)

**SECTION C: Why This Is Real (3-5 bullets max)**
Extract specific evidence from the original answer:
- Validated gaps or pain points (with data/examples)
- External pressures (regulatory, competitive, threat landscape)
- Buying authority or procurement paths
- Competitive gaps (what others don't do)
- Research consensus indicators (if divergence scores >0.85, say "strong research consensus")

Each bullet must be specific, not generic.

BAD: "Reduces risk and improves security"
GOOD: "75% of intrusions now 'malware-free' (token abuse); password resets don't revoke active sessions"

**SECTION D: The Risk (1-2 sentences max)**
Extract the MAIN concern or limitation from the original answer.
Be honest. What could prevent this from working?

If no risks mentioned, write: "Primary risk: [most obvious concern based on the opportunity type]"

Example:
"Integration complexity across providers and backup platforms could extend sales cycles beyond projected 60-120 days."

**SECTION E: Next Step (1-2 sentences max)**
What validation or action should happen next?

Prioritize:
- Design partner validation
- Pilot with specific account types
- Market research or customer interviews
- Competitive analysis

Example:
"Design partner validation with 5-10 target accounts (3 hospitals, 3 school districts) in Q1 to prove cross-provider integration and conversion rates."

FORMATTING RULES:
- Use bullets for scannable lists
- Use bold for section headers
- Keep sentences short (15-20 words max)
- Use specific numbers whenever available
- Avoid phrases like "comprehensive," "holistic," "strategic," "leverage" (exec-speak clichés)
- NEVER include empty bullets like "3." or "6." with no text - stop numbering at your last actual point

QUALITY CHECKS:
Before finalizing, verify:
✓ Total length ≤300 words
✓ No COSMO internals ([Mem], [Cycle], agents, divergence)
✓ No implementation details (APIs, schemas, code)
✓ Section B has actual numbers (not just descriptions)
✓ Section C has specific evidence (not generic benefits)
✓ All claims trace to original answer (no hallucinations)

IF THE ORIGINAL ANSWER IS:
- A product/market opportunity → emphasize numbers and buyers
- A technical concept → emphasize the gap it fills and validation approach
- A strategic analysis → emphasize competitive positioning and timing
- A career/individual advice → emphasize leverage points and next actions

OUTPUT FORMAT:
Present all 5 sections clearly labeled.
Use markdown formatting.
Be direct and confident in tone.`;
  }

  /**
   * Get system prompt for consulting mode
   */
  getConsultingSystemPrompt() {
    return `You are a STRATEGIC SYNTHESIS ENGINE generating executive-ready recommendations inspired by COSMO's research.

You have access to: memory nodes, thought stream, goals, metrics, coordinator reviews, AND agent output files.

IMPORTANT: When "Agent Output Files" are shown in the context, you CAN and SHOULD read their contents directly.
These are actual file contents loaded from the outputs/ directory - not just metadata references.
The "Top-Level Deliverables" section contains full file content previews that you can read and analyze.
Files are shown as previews; if you need more, tell the user.

MODE: Creative Strategic Planning (Not Auditable Truth Extraction)

Your purpose is to PROPOSE strategic initiatives, operational plans, and business recommendations that GO BEYOND what research explicitly stated. You are allowed to be forward-looking and prescriptive.

# RESEARCH FOUNDATION

First, ground your synthesis in what COSMO discovered:
- **Core Research Findings**: Quote key discoveries from memory nodes [Mem X]
- **Convergence Evidence**: Cite cycles with divergence scores showing agreement
- **Patterns & Themes**: What did multiple cycles reveal?

Use citations here to show what research inspired your strategic thinking.

# CREATIVE SYNTHESIS: STRATEGIC RECOMMENDATIONS

Propose specific strategic initiatives inspired by the research:

For each recommendation:
- **Strategic Initiative**: [Your proposed action]
- **Inspired By Research**: Which insights [Mem X], cycles, patterns sparked this?
- **Business Rationale**: Why this matters (you may extrapolate)
- **Impact Assessment**: Transformative / High / Medium / Low (your judgment)

You may:
✓ Propose specific operational changes
✓ Suggest organizational structures
✓ Recommend timelines and phases
✓ Brainstorm resource needs
✓ Create implementation roadmaps

# CREATIVE SYNTHESIS: OPERATIONAL IMPLICATIONS

Propose what implementation might look like:
- **Process Changes**: [Your proposals inspired by research]
- **Technology Needs**: [Your synthesis]
- **Team & Organization**: [Your ideas on structure, roles]
- **Metrics & KPIs**: [Your proposed measurement approach]
- **Inspired By**: [Cite Mem X] that informed these proposals

# CREATIVE SYNTHESIS: BUSINESS CASE ELEMENTS

Brainstorm business case components:
- **Investment Considerations**: [Your assessment of what might be needed]
- **Value Creation Opportunities**: [Your ideas]
- **Risk Factors**: [Your analysis]
- **Inspired By Research**: [Cite insights] that inform this thinking

Note: You may propose financial frameworks, timelines, and resource estimates even though research doesn't contain this data.

# CREATIVE SYNTHESIS: IMPLEMENTATION ROADMAP

Propose a phased approach:
- **Phase 1 (Near-term)**: [Your proposed quick wins]
- **Phase 2 (Medium-term)**: [Your proposed scaling]
- **Phase 3 (Long-term)**: [Your proposed maturity state]

For each: Milestones, considerations, decision points (your creative synthesis)

# CLEARLY DISTINGUISH

In your output, clearly mark:
- **"Research discovered:"** [Cited from Mem X] ← What COSMO found
- **"This suggests:"** [Your interpretation] ← Your analysis
- **"Strategic recommendation:"** [Your proposal] ← Your synthesis
- **"Implementation could involve:"** [Your ideas] ← Your brainstorming

# WHAT YOU'RE NOT CLAIMING

Make clear that:
- Market sizes, budgets, timelines are PROPOSALS for validation, not research findings
- Organizational structures are SUGGESTIONS, not research-backed requirements
- Financial projections are ILLUSTRATIVE, not research-derived data

Do not make anything up ever.
Do not assume anything.
Measure Twice, Cut once!

This is STRATEGIC BRAINSTORMING informed by research insights. Be bold, creative, and actionable while clearly showing what came from research vs your synthesis.`;
  }

  /**
   * Get query suggestions based on current state
   */
  async getQuerySuggestions() {
    try {
      const state = await this.loadBrainState();
      const thoughts = await this.loadThoughts();
      const memory = state.memory?.nodes || [];
      
      // Get coordinator insights for context
      let coordinatorInsights = null;
      try {
        const insights = await this.coordinatorIndexer.getSearchableInsights();
        coordinatorInsights = insights.slice(0, 5);
      } catch (error) {
        console.error('Failed to load coordinator insights:', error);
      }

      const suggestions = await this.querySuggester.generateSuggestions(
        state,
        memory,
        thoughts,
        coordinatorInsights
      );

      return {
        suggestions,
        timestamp: new Date().toISOString(),
        stateInfo: {
          cycleCount: state.cycleCount || 0,
          memoryNodes: memory.length,
          thoughtsCount: thoughts.length
        }
      };
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
      return {
        suggestions: [],
        error: error.message
      };
    }
  }

  /**
   * Export result to file with rich metadata
   */
  async exportResult(query, answer, format, metadata = {}) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const sanitized = query.substring(0, 50).replace(/[^a-z0-9]/gi, '_');
    const filename = `query_${timestamp}_${sanitized}`;
    
    await fs.mkdir(path.join(this.exportsDir, format), { recursive: true });
    
    let content, filepath;
    
    switch (format) {
      case 'markdown':
        content = this.buildRichMarkdown(query, answer, metadata);
        filepath = path.join(this.exportsDir, 'markdown', `${filename}.md`);
        break;
      
      case 'json':
        content = JSON.stringify({ 
          query, 
          answer, 
          timestamp: new Date().toISOString(), 
          metadata,
          exportFormat: 'annotated'
        }, null, 2);
        filepath = path.join(this.exportsDir, 'json', `${filename}.json`);
        break;
      
      case 'html':
        content = this.buildInteractiveHTML(query, answer, metadata);
        filepath = path.join(this.exportsDir, 'html', `${filename}.html`);
        break;
      
      default:
        throw new Error(`Unknown format: ${format}`);
    }
    
    await fs.writeFile(filepath, content, 'utf-8');
    return filepath;
  }

  /**
   * Build rich markdown with graphs and metadata
   */
  buildRichMarkdown(query, answer, metadata) {
    let md = `# 🧠 COSMO Query Result\n\n`;
    md += `**Query:** ${query}\n\n`;
    md += `**Timestamp:** ${metadata.timestamp || new Date().toISOString()}\n\n`;
    md += `**Model:** ${metadata.model || 'gpt-5.2'} (${metadata.mode || 'normal'} mode)\n\n`;
    md += `---\n\n`;

    // Evidence Quality Section
    if (metadata.evidenceQuality) {
      const eq = metadata.evidenceQuality;
      md += `## 📊 Evidence Quality\n\n`;
      md += `${eq.summary}\n\n`;
      md += `**Coverage:** ${eq.coverage.rating} (${Math.round(eq.coverage.percentage * 100)}% of knowledge base)\n\n`;
      md += `**Confidence:** ${eq.confidence.rating} (${Math.round(eq.confidence.score * 100)}%)\n\n`;

      if (eq.gaps && eq.gaps.length > 0) {
        md += `**⚠️ Identified Gaps:**\n\n`;
        eq.gaps.forEach(gap => {
          md += `- ${gap.description} (severity: ${gap.severity})\n`;
        });
        md += `\n`;
      }

      md += `---\n\n`;
    }

    // Synthesis Section
    if (metadata.synthesis) {
      const syn = metadata.synthesis;
      md += `## 🔍 Insight Synthesis\n\n`;
      md += `${syn.summary}\n\n`;
      
      if (syn.patterns && syn.patterns.length > 0) {
        md += `### Temporal Patterns\n\n`;
        syn.patterns.forEach(p => {
          md += `- **${p.type}**: ${p.theme || p.description}\n`;
          md += `  - Occurrences: ${p.occurrences || 'N/A'}\n`;
          md += `  - Trend: ${p.trend || 'stable'}\n`;
          md += `  - Significance: ${Math.round((p.significance || 0) * 100)}%\n`;
        });
        md += `\n`;
      }

      if (syn.clusters && syn.clusters.length > 0) {
        md += `### Concept Clusters\n\n`;
        syn.clusters.forEach(c => {
          md += `- **${c.centralConcept}** (${c.size} nodes, avg activation: ${Math.round(c.avgActivation * 100)}%)\n`;
        });
        md += `\n`;
      }

      if (syn.breakthroughs && syn.breakthroughs.length > 0) {
        md += `### 💡 Breakthroughs\n\n`;
        syn.breakthroughs.forEach(b => {
          md += `- **Cycle ${b.cycle}**: ${b.content.substring(0, 200)}...\n`;
        });
        md += `\n`;
      }
      
      md += `---\n\n`;
    }

    // Coordinator Insights Section
    if (metadata.coordinatorInsights && metadata.coordinatorInsights.insights) {
      const insights = metadata.coordinatorInsights.insights;
      md += `## 🎯 Coordinator Insights\n\n`;
      insights.forEach(ins => {
        md += `### ${ins.title}\n\n`;
        md += `${ins.content}\n\n`;
        md += `_Cycle ${ins.cycle || 'N/A'} • Relevance: ${ins.relevance}%_\n\n`;
      });
      md += `---\n\n`;
    }

    // Main Answer
    md += `## 💬 Answer\n\n`;
    md += `${answer}\n\n`;

    // Sources
    md += `---\n\n`;
    md += `## 📚 Sources\n\n`;
    md += `- **Memory Nodes:** ${metadata.sources?.memoryNodes || 0}\n`;
    md += `- **Thoughts:** ${metadata.sources?.thoughts || 0}\n`;
    md += `- **Connections:** ${metadata.sources?.edges || 0}\n`;
    md += `- **Reasoning Effort:** ${metadata.reasoningEffort || 'medium'}\n\n`;

    // Session Context (if follow-up)
    if (metadata.sessionContext) {
      md += `---\n\n`;
      md += `## 🔗 Session Context\n\n`;
      if (metadata.sessionContext.concepts && metadata.sessionContext.concepts.length > 0) {
        md += `**Key Concepts:** ${metadata.sessionContext.concepts.slice(0, 10).join(', ')}\n\n`;
      }
      if (metadata.sessionContext.cycles && metadata.sessionContext.cycles.length > 0) {
        md += `**Cycles:** ${metadata.sessionContext.cycles.join(', ')}\n\n`;
      }
    }

    md += `\n---\n\n_Generated by COSMO Query Engine_\n`;

    return md;
  }

  /**
   * Build interactive HTML with visualizations
   */
  buildInteractiveHTML(query, answer, metadata) {
    const eq = metadata.evidenceQuality;
    const syn = metadata.synthesis;
    const coordInsights = metadata.coordinatorInsights;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>COSMO Query: ${this.escapeHtml(query.substring(0, 60))}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background: #0a0e27;
      color: #e0e0e0;
      padding: 40px;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 30px;
      border-radius: 12px;
      margin-bottom: 30px;
    }
    h1 { font-size: 2em; margin-bottom: 10px; }
    .meta { opacity: 0.9; font-size: 0.9em; }
    .section {
      background: #1a1f3a;
      padding: 25px;
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .section h2 {
      color: #667eea;
      margin-bottom: 15px;
      font-size: 1.5em;
    }
    .answer {
      background: #0d1127;
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid #667eea;
      white-space: pre-wrap;
      font-size: 1.05em;
      line-height: 1.8;
    }
    .quality-bar {
      background: #0d1127;
      border-radius: 8px;
      height: 12px;
      overflow: hidden;
      margin: 10px 0;
    }
    .quality-bar-fill {
      background: linear-gradient(90deg, #667eea, #764ba2);
      height: 100%;
      transition: width 0.5s;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .insight-item {
      background: #0d1127;
      padding: 15px;
      border-radius: 8px;
      border-left: 3px solid #667eea;
      margin: 10px 0;
    }
    .tag {
      display: inline-block;
      background: #667eea;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85em;
      margin: 5px 5px 5px 0;
    }
    .warning {
      background: #3a1f1f;
      border-left-color: #e74c3c;
      padding: 15px;
      border-radius: 8px;
      border-left: 3px solid #e74c3c;
      margin-top: 15px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🧠 COSMO Query Result</h1>
      <div class="meta">
        <strong>Query:</strong> ${this.escapeHtml(query)}<br>
        <strong>Timestamp:</strong> ${metadata.timestamp || new Date().toISOString()}<br>
        <strong>Model:</strong> ${metadata.model || 'gpt-5.2'} (${metadata.mode || 'normal'} mode)
      </div>
    </header>`;

    // Evidence Quality Section
    if (eq) {
      const coveragePercent = Math.round(eq.coverage.percentage * 100);
      const confidencePercent = Math.round(eq.confidence.score * 100);

      html += `
    <div class="section">
      <h2>📊 Evidence Quality</h2>
      <p style="margin-bottom: 15px;">${this.escapeHtml(eq.summary)}</p>
      <div class="grid">
        <div>
          <div style="font-size: 0.9em; margin-bottom: 5px;">Coverage: ${eq.coverage.rating}</div>
          <div class="quality-bar">
            <div class="quality-bar-fill" style="width: ${coveragePercent}%"></div>
          </div>
          <div style="font-size: 0.85em; color: #667eea;">${coveragePercent}% (${eq.coverage.used}/${eq.coverage.total} nodes)</div>
        </div>
        <div>
          <div style="font-size: 0.9em; margin-bottom: 5px;">Confidence: ${eq.confidence.rating}</div>
          <div class="quality-bar">
            <div class="quality-bar-fill" style="width: ${confidencePercent}%"></div>
          </div>
          <div style="font-size: 0.85em; color: #667eea;">${confidencePercent}%</div>
        </div>
      </div>`;
      
      if (eq.gaps && eq.gaps.length > 0) {
        html += `<div class="warning">
          <strong>⚠️ Identified Gaps:</strong><br>`;
        eq.gaps.forEach(gap => {
          html += `• ${this.escapeHtml(gap.description)}<br>`;
        });
        html += `</div>`;
      }
      
      html += `</div>`;
    }

    // Synthesis Section
    if (syn) {
      html += `<div class="section">
        <h2>🔍 Insight Synthesis</h2>
        <p>${this.escapeHtml(syn.summary)}</p>`;
      
      if (syn.patterns && syn.patterns.length > 0) {
        html += `<h3 style="margin-top: 20px; color: #888;">Temporal Patterns</h3>`;
        syn.patterns.forEach(p => {
          html += `<div class="insight-item">
            <strong>${p.type}</strong>: ${this.escapeHtml(p.theme || p.description)}<br>
            <span style="font-size: 0.85em; color: #888;">
              ${p.occurrences || 'N/A'} occurrences • ${p.trend || 'stable'} trend
            </span>
          </div>`;
        });
      }

      if (syn.breakthroughs && syn.breakthroughs.length > 0) {
        html += `<h3 style="margin-top: 20px; color: #888;">💡 Breakthroughs</h3>`;
        syn.breakthroughs.forEach(b => {
          html += `<div class="insight-item">
            <span class="tag">Cycle ${b.cycle}</span><br>
            ${this.escapeHtml(b.content.substring(0, 200))}...
          </div>`;
        });
      }
      
      html += `</div>`;
    }

    // Coordinator Insights
    if (coordInsights && coordInsights.insights) {
      html += `<div class="section">
        <h2>🎯 Coordinator Insights</h2>`;
      coordInsights.insights.forEach(ins => {
        html += `<div class="insight-item">
          <strong style="color: #667eea;">${this.escapeHtml(ins.title)}</strong><br>
          <p style="margin: 10px 0;">${this.escapeHtml(ins.content)}</p>
          <span style="font-size: 0.8em; color: #888;">
            Cycle ${ins.cycle || 'N/A'} • Relevance: ${ins.relevance}%
          </span>
        </div>`;
      });
      html += `</div>`;
    }

    // Main Answer
    html += `<div class="section">
      <h2>💬 Answer</h2>
      <div class="answer">${this.escapeHtml(answer)}</div>
    </div>`;

    // Sources
    html += `<div class="section">
      <h2>📚 Sources</h2>
      <div class="grid">
        <div>
          <strong>Memory Nodes:</strong> ${metadata.sources?.memoryNodes || 0}<br>
          <strong>Thoughts:</strong> ${metadata.sources?.thoughts || 0}
        </div>
        <div>
          <strong>Connections:</strong> ${metadata.sources?.edges || 0}<br>
          <strong>Reasoning:</strong> ${metadata.reasoningEffort || 'medium'}
        </div>
      </div>
    </div>`;

    html += `
    <footer style="text-align: center; margin-top: 40px; opacity: 0.5; font-size: 0.85em;">
      Generated by COSMO Query Engine
    </footer>
  </div>
</body>
</html>`;

    return html;
  }

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * ═══════════════════════════════════════════════════════════
   * LEVEL 1 & 2: FILE ACCESS
   * ═══════════════════════════════════════════════════════════
   */

  /**
   * Load specific output files identified by memory search (ENHANCEMENT)
   * This integrates memory tracking with file loading for query-aware results
   */
  async loadMemoryGuidedOutputFiles(query, options = {}) {
    const { limit = 8 } = options;
    
    try {
      // Query memory for document metadata nodes
      const state = await this.loadBrainState();
      const documentNodes = await this.queryMemory(state, query, {
        filterTags: 'document_metadata',
        limit: limit * 2,  // Get more candidates since we'll filter
        useSemanticSearch: true
      });
      
      console.log(`[QueryEngine] Memory-guided search found ${documentNodes.length} document metadata nodes`);
      
      // Extract file paths from metadata nodes
      const filePaths = [];
      for (const node of documentNodes) {
        try {
          // Find JSON in concept (format: "[AGENT: xxx] {...}")
          const conceptStr = node.concept || '';
          const jsonMatch = conceptStr.match(/\{[^{}]*"filePath"[^{}]*\}/);
          if (jsonMatch) {
            const metadata = JSON.parse(jsonMatch[0]);
            if (metadata.filePath) {
              filePaths.push({
                path: metadata.filePath,
                title: metadata.title || 'Untitled',
                type: metadata.type || 'unknown',
                wordCount: metadata.wordCount || 0,
                relevanceScore: node.score || 0
              });
            }
          }
        } catch (error) {
          // Skip malformed nodes
          console.log(`[QueryEngine] Skipping malformed metadata node ${node.id}`);
          continue;
        }
      }
      
      console.log(`[QueryEngine] Extracted ${filePaths.length} valid file paths from memory`);
      
      // Load the actual files
      const loadedFiles = {
        documents: [],
        deliverables: [],
        codeCreation: [],
        codeExecution: [],
        total: 0
      };
      
      for (const fileInfo of filePaths.slice(0, limit)) {
        try {
          // Normalize path (handles both runtime/ and runs/xxx/ paths)
          let normalizedPath = fileInfo.path;
          if (normalizedPath.includes('/runtime/outputs/')) {
            normalizedPath = normalizedPath.replace(/^.*\/runtime\/outputs\//, path.join(this.runtimeDir, 'outputs') + '/');
          } else if (normalizedPath.includes('/outputs/')) {
            // Handle runs paths
            normalizedPath = normalizedPath.replace(/^.*\/outputs\//, path.join(this.runtimeDir, 'outputs') + '/');
          }
          
          // Check if file exists
          const content = await fs.readFile(normalizedPath, 'utf-8');
          
          const fileObj = {
            filename: path.basename(normalizedPath),
            path: normalizedPath.replace(this.runtimeDir + '/', ''),
            fullPath: normalizedPath,
            content: content,  // FULL CONTENT (not truncated)
            size: content.length,
            title: fileInfo.title,
            type: fileInfo.type,
            wordCount: fileInfo.wordCount,
            relevanceScore: fileInfo.relevanceScore,
            memoryGuided: true  // Flag to indicate this came from memory
          };
          
          // Categorize by path
          if (normalizedPath.includes('/document-creation/')) {
            loadedFiles.documents.push(fileObj);
          } else if (normalizedPath.includes('/code-creation/')) {
            loadedFiles.codeCreation.push(fileObj);
          } else if (normalizedPath.includes('/code-execution/')) {
            loadedFiles.codeExecution.push(fileObj);
          } else {
            loadedFiles.deliverables.push(fileObj);
          }
          loadedFiles.total++;
          
        } catch (error) {
          console.log(`[QueryEngine] Failed to load memory-guided file: ${fileInfo.path}`, error.message);
          continue;
        }
      }
      
      console.log(`[QueryEngine] Memory-guided loading: ${loadedFiles.total} files loaded (${loadedFiles.documents.length} docs, ${loadedFiles.deliverables.length} deliverables, ${loadedFiles.codeCreation.length} code, ${loadedFiles.codeExecution.length} execution)`);
      return loadedFiles;
      
    } catch (error) {
      console.error('[QueryEngine] Memory-guided loading failed:', error.message);
      return { documents: [], deliverables: [], codeCreation: [], codeExecution: [], total: 0 };
    }
  }

  /**
   * Load all agent output files from runtime/outputs/
   */
  async loadAgentOutputFiles(options = {}) {
    const {
      includeCode = true,
      includeDocuments = true,
      includeExecutionOutputs = true,
      limit = 100
    } = options;

    const outputs = {
      codeCreation: [],
      codeExecution: [],
      documents: [],
      deliverables: [],
      total: 0
    };

    const outputsDir = path.join(this.runtimeDir, 'outputs');

    try {
      // Check if outputs directory exists
      const outputsDirExists = await fs.stat(outputsDir).then(() => true).catch(() => false);
      if (!outputsDirExists) {
        console.log('[QueryEngine] No outputs directory found');
        return outputs;
      }

      // Scan code-creation outputs
      if (includeCode) {
        const codeCreationDir = path.join(outputsDir, 'code-creation');
        if (await fs.stat(codeCreationDir).then(() => true).catch(() => false)) {
          const agents = await fs.readdir(codeCreationDir);
          for (const agentId of agents) {
            const agentDir = path.join(codeCreationDir, agentId);
            const stat = await fs.stat(agentDir);
            if (!stat.isDirectory()) continue;

            const files = await fs.readdir(agentDir);
            for (const file of files) {
              if (file === 'manifest.json' || file === '_debug' || file.endsWith('_metadata.json')) continue;
              const filePath = path.join(agentDir, file);
              const fileStat = await fs.stat(filePath);
              if (fileStat.isDirectory()) continue;

              try {
                const content = await fs.readFile(filePath, 'utf-8');
                outputs.codeCreation.push({
                  agentId,
                  filename: file,
                  path: `outputs/code-creation/${agentId}/${file}`,
                  fullPath: filePath,
                  content: content.substring(0, 10000), // Limit to 10KB per file
                  size: content.length,
                  extension: path.extname(file),
                  created: fileStat.mtime
                });
                outputs.total++;
              } catch (readError) {
                // Skip binary files or read errors
                console.warn(`[QueryEngine] Could not read file: ${filePath}`);
              }
            }
          }
        }
      }

      // Scan code-execution outputs
      if (includeExecutionOutputs) {
        const codeExecDir = path.join(outputsDir, 'code-execution');
        if (await fs.stat(codeExecDir).then(() => true).catch(() => false)) {
          const agents = await fs.readdir(codeExecDir);
          for (const agentId of agents) {
            const agentDir = path.join(codeExecDir, agentId);
            const stat = await fs.stat(agentDir);
            if (!stat.isDirectory()) continue;

            const files = await fs.readdir(agentDir);
            for (const file of files) {
              const filePath = path.join(agentDir, file);
              const fileStat = await fs.stat(filePath);
              if (fileStat.isDirectory()) continue;

              try {
                const content = await fs.readFile(filePath, 'utf-8');
                outputs.codeExecution.push({
                  agentId,
                  filename: file,
                  path: `outputs/code-execution/${agentId}/${file}`,
                  fullPath: filePath,
                  content: content.substring(0, 10000),
                  size: content.length,
                  extension: path.extname(file),
                  created: fileStat.mtime
                });
                outputs.total++;
              } catch (readError) {
                console.warn(`[QueryEngine] Could not read file: ${filePath}`);
              }
            }
          }
        }
      }

      // Scan document-creation outputs
      if (includeDocuments) {
        const docCreationDir = path.join(outputsDir, 'document-creation');
        if (await fs.stat(docCreationDir).then(() => true).catch(() => false)) {
          const agents = await fs.readdir(docCreationDir);
          for (const agentId of agents) {
            const agentDir = path.join(docCreationDir, agentId);
            const stat = await fs.stat(agentDir);
            if (!stat.isDirectory()) continue;

            const files = await fs.readdir(agentDir);
            for (const file of files) {
              if (file.endsWith('_metadata.json')) continue;
              const filePath = path.join(agentDir, file);
              const fileStat = await fs.stat(filePath);
              if (fileStat.isDirectory()) continue;

              try {
                const content = await fs.readFile(filePath, 'utf-8');
                outputs.documents.push({
                  agentId,
                  filename: file,
                  path: `outputs/document-creation/${agentId}/${file}`,
                  fullPath: filePath,
                  content: content.substring(0, 10000),
                  size: content.length,
                  extension: path.extname(file),
                  created: fileStat.mtime
                });
                outputs.total++;
              } catch (readError) {
                console.warn(`[QueryEngine] Could not read file: ${filePath}`);
              }
            }
          }
        }
      }

      // Scan manifests directory (V3 validation system)
      const manifestsDir = path.join(outputsDir, 'manifests');
      if (await fs.stat(manifestsDir).then(() => true).catch(() => false)) {
        const files = await fs.readdir(manifestsDir);
        for (const file of files) {
          const filePath = path.join(manifestsDir, file);
          const fileStat = await fs.stat(filePath);
          if (fileStat.isDirectory()) continue;

          try {
            const content = await fs.readFile(filePath, 'utf-8');
            outputs.deliverables.push({
              filename: file,
              path: `outputs/manifests/${file}`,
              fullPath: filePath,
              content: content.substring(0, 10000),
              size: content.length,
              extension: path.extname(file),
              created: fileStat.mtime
            });
            outputs.total++;
          } catch (readError) {
            console.warn(`[QueryEngine] Could not read manifest file: ${filePath}`);
          }
        }
      }

      // Scan reports directory (V3 validation system)
      const reportsDir = path.join(outputsDir, 'reports');
      if (await fs.stat(reportsDir).then(() => true).catch(() => false)) {
        const files = await fs.readdir(reportsDir);
        for (const file of files) {
          const filePath = path.join(reportsDir, file);
          const fileStat = await fs.stat(filePath);
          if (fileStat.isDirectory()) continue;

          try {
            const content = await fs.readFile(filePath, 'utf-8');
            outputs.deliverables.push({
              filename: file,
              path: `outputs/reports/${file}`,
              fullPath: filePath,
              content: content,
              size: content.length,
              extension: path.extname(file),
              created: fileStat.mtime
            });
            outputs.total++;
          } catch (readError) {
            console.warn(`[QueryEngine] Could not read report file: ${filePath}`);
          }
        }
      }

      // Scan introspection findings (V3 substrate)
      const agentsDir = path.join(this.runtimeDir, 'agents');
      if (await fs.stat(agentsDir).then(() => true).catch(() => false)) {
        const agentFolders = await fs.readdir(agentsDir);
        for (const agentId of agentFolders) {
          const agentDir = path.join(agentsDir, agentId);
          const stat = await fs.stat(agentDir);
          if (!stat.isDirectory()) continue;

          // Read findings.jsonl
          const findingsPath = path.join(agentDir, 'findings.jsonl');
          if (await fs.stat(findingsPath).then(() => true).catch(() => false)) {
            try {
              const content = await fs.readFile(findingsPath, 'utf-8');
              outputs.deliverables.push({
                agentId,
                filename: 'findings.jsonl',
                path: `agents/${agentId}/findings.jsonl`,
                fullPath: findingsPath,
                content: content.substring(0, 5000),
                size: content.length,
                extension: '.jsonl',
                created: stat.mtime
              });
              outputs.total++;
            } catch (readError) {
              console.warn(`[QueryEngine] Could not read findings: ${findingsPath}`);
            }
          }

          // Read insights.jsonl
          const insightsPath = path.join(agentDir, 'insights.jsonl');
          if (await fs.stat(insightsPath).then(() => true).catch(() => false)) {
            try {
              const content = await fs.readFile(insightsPath, 'utf-8');
              outputs.deliverables.push({
                agentId,
                filename: 'insights.jsonl',
                path: `agents/${agentId}/insights.jsonl`,
                fullPath: insightsPath,
                content: content.substring(0, 5000),
                size: content.length,
                extension: '.jsonl',
                created: stat.mtime
              });
              outputs.total++;
            } catch (readError) {
              console.warn(`[QueryEngine] Could not read insights: ${insightsPath}`);
            }
          }
        }
      }

      // Scan top-level deliverables
      const topLevelFiles = await fs.readdir(outputsDir);
      for (const file of topLevelFiles) {
        const filePath = path.join(outputsDir, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) continue;

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          outputs.deliverables.push({
            filename: file,
            path: `outputs/${file}`,
            fullPath: filePath,
            content: content.substring(0, 10000),
            size: content.length,
            extension: path.extname(file),
            created: stat.mtime
          });
          outputs.total++;
        } catch (readError) {
          console.warn(`[QueryEngine] Could not read file: ${filePath}`);
        }
      }

      console.log(`[QueryEngine] Loaded ${outputs.total} output files: ${outputs.documents.length} docs, ${outputs.deliverables.length} deliverables, ${outputs.codeCreation.length} code, ${outputs.codeExecution.length} execution`);
      return outputs;

    } catch (error) {
      console.error('[QueryEngine] Failed to load output files:', error);
      return outputs;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════
   * LEVEL 3 & 4: ACTION DETECTION & EXECUTION
   * ═══════════════════════════════════════════════════════════
   */

  /**
   * Detect action intent in query
   */
  detectActionIntent(query) {
    const queryLower = query.toLowerCase();

    const actionPatterns = {
      // NEW: Broader file creation pattern (checked first for priority)
      createFile: /\b(create|make|generate|write|build|produce) (?:a |an |the |some )?(?:\w+\s+)?(file|html|document|code|script|diagram|visualization|webpage|page|stylesheet|schema)\b/i,
      // EXISTING: Specific write to outputs pattern
      writeFile: /\b(write|save|create|update) (a |an |the )?(file|document) (to |at |in )?outputs\//i,
      readFullFile: /\b(read|show|display|get) (the )?(full|complete|entire|whole) (content|contents|file|text) (of|from|for) (.+)/i,
      spawnAgent: /\b(run|execute|spawn|create|start|launch) (a|an)? ?(research|analysis|synthesis|exploration|code|document|quality) ?(agent|mission)\b/i,
      createGoal: /\b(create|add|set|inject) (a|an|new)? ?goal\b/i,
      exportData: /\b(export|download|save) (this|the|all|these)? ?(data|results|findings|answer|response)\b/i,
      generateCode: /\b(generate|create|write|build) (a|an|some)? ?(code|script|program|tool)\b/i,
      analyzeFiles: /\b(analyze|review|examine|inspect|read) (the|these|all)? ?(files?|code|documents?|outputs?)\b/i,
      listFiles: /\b(list|show|display) (all|the)? ?(files?|outputs?|generated)\b/i
    };

    for (const [action, pattern] of Object.entries(actionPatterns)) {
      if (pattern.test(query)) {
        // For createFile, extract expected file type
        if (action === 'createFile') {
          const fileType = this.extractFileType(query);
          return { action, detected: true, query, fileType };
        }
        return { action, detected: true, query };
      }
    }

    return { action: null, detected: false, query };
  }
  
  /**
   * Extract file type from query text
   */
  extractFileType(query) {
    const typePatterns = {
      html: /\b(html|webpage|web page)\b/i,
      python: /\b(python|py)\b/i,
      javascript: /\b(javascript|js)\b/i,
      json: /\b(json)\b/i,
      css: /\b(css|stylesheet)\b/i,
      markdown: /\b(markdown|md)\b/i,
      svg: /\b(svg|vector)\b/i,
      yaml: /\b(yaml|yml)\b/i
    };
    
    for (const [type, pattern] of Object.entries(typePatterns)) {
      if (pattern.test(query)) return type;
    }
    
    return 'text';
  }

  /**
   * Execute query with file access and action support
   */
  async executeEnhancedQuery(query, options = {}) {
    const {
      model = 'gpt-5.2',
      mode = 'normal',
      exportFormat = null,
      includeFiles = true,
      allowActions = false,
      includeEvidenceMetrics = false,
      enableSynthesis = false,
      followUpContext = null,
      includeCoordinatorInsights = true,
      baseAnswer = null, // For executive mode compression
      baseMetadata = null,
      priorContext = null // For follow-up queries
    } = options;

    // Load files if checkbox is enabled (user explicitly requested it)
    const needsFiles = includeFiles;

    // Detect action intent
    const actionIntent = this.detectActionIntent(query);

    // Load output files if needed
    let outputFiles = null;
    if (needsFiles) {
      console.log('[QueryEngine] Loading output files...');
      
      // ENHANCEMENT: Try memory-guided loading first for DOCUMENTS
      const memoryGuidedFiles = await this.loadMemoryGuidedOutputFiles(query, { limit: 8 });
      
      // ALWAYS load filesystem scan for complete picture (includes deliverables, code, execution)
      const filesystemFiles = await this.loadAgentOutputFiles({
        includeCode: true,
        includeDocuments: true,
        includeExecutionOutputs: true
      });
      
      // Merge results: prefer memory-guided documents (they're query-relevant), 
      // but always include deliverables, code, execution from filesystem
      if (memoryGuidedFiles && memoryGuidedFiles.total > 0) {
        console.log(`[QueryEngine] Using memory-guided documents: ${memoryGuidedFiles.documents.length} docs`);
        outputFiles = {
          documents: memoryGuidedFiles.documents.length > 0 ? memoryGuidedFiles.documents : filesystemFiles.documents,
          deliverables: filesystemFiles.deliverables,  // ALWAYS from filesystem
          codeCreation: filesystemFiles.codeCreation,  // ALWAYS from filesystem
          codeExecution: filesystemFiles.codeExecution, // ALWAYS from filesystem
          total: 0
        };
        outputFiles.total = outputFiles.documents.length + outputFiles.deliverables.length + 
                           outputFiles.codeCreation.length + outputFiles.codeExecution.length;
      } else {
        console.log('[QueryEngine] Using filesystem scan results');
        outputFiles = filesystemFiles;
      }
      
      console.log(`[QueryEngine] Final output files: ${outputFiles.total} total (${outputFiles.documents.length} docs, ${outputFiles.deliverables.length} deliverables, ${outputFiles.codeCreation.length} code, ${outputFiles.codeExecution.length} execution)`);
    }

    // Execute standard query with file context
    const result = await this.executeQuery(query, {
      model,
      mode,
      exportFormat,
      includeEvidenceMetrics,
      enableSynthesis,
      followUpContext,
      includeCoordinatorInsights,
      outputFiles,
      baseAnswer, // Pass through for executive mode
      baseMetadata,
      priorContext // Pass through for follow-up queries
    });

    // Add file access metadata
    if (outputFiles && outputFiles.total > 0) {
      result.metadata.filesAccessed = {
        total: outputFiles.total,
        codeFiles: outputFiles.codeCreation.length,
        executionOutputs: outputFiles.codeExecution.length,
        documents: outputFiles.documents.length,
        deliverables: outputFiles.deliverables.length
      };
    }

    // Handle action execution if allowed
    if (actionIntent.detected && allowActions) {
      console.log(`[QueryEngine] Action detected: ${actionIntent.action}`);
      result.actionIntent = actionIntent;
      result.actionExecuted = false;
      result.actionResult = null;

      try {
        // STANDALONE EXECUTION: File creation (no orchestrator needed - direct fs write)
        if (actionIntent.action === 'createFile') {
          const extractedArtifacts = this.extractArtifactsFromAnswer(
            query, 
            result.answer, 
            actionIntent.fileType
          );
          
          if (extractedArtifacts.length > 0) {
            console.log(`[QueryEngine] Extracted ${extractedArtifacts.length} artifacts, writing directly (standalone mode - no orchestrator required)`);
            const actionResult = await this.handleCreateFileFromAnswer(query, extractedArtifacts);
            result.actionExecuted = true;
            result.actionResult = actionResult;
            await this.logAction(actionIntent, actionResult, query);
          } else {
            console.log('[QueryEngine] No artifacts extracted from answer');
            result.actionNote = 'No code blocks found in answer. Generate complete code in ```language blocks for extraction.';
          }
        }
        // ORCHESTRATOR-DEPENDENT ACTIONS: Require orchestrator for agent spawning
        else if (this.orchestrator) {
          const actionResult = await this.executeAction(actionIntent, query, result);
          result.actionExecuted = true;
          result.actionResult = actionResult;
          await this.logAction(actionIntent, actionResult, query);
        } else {
          result.actionNote = `Action "${actionIntent.action}" requires active orchestrator. Available for runtime queries only, not historical runs.`;
        }
        } catch (error) {
          console.error('[QueryEngine] Action execution failed:', error);
          result.actionError = error.message;
      }
    } else if (actionIntent.detected && !allowActions) {
      result.actionSuggestion = {
        action: actionIntent.action,
        message: `This query appears to request an action (${actionIntent.action}). Enable "Allow Actions" checkbox to execute.`
      };
    }

    return result;
  }

  /**
   * Execute detected action
   */
  async executeAction(actionIntent, query, queryResult) {
    const { action } = actionIntent;

    switch (action) {
      case 'writeFile':
        return await this.handleWriteFile(query);

      case 'readFullFile':
        return await this.handleReadFullFile(query);

      case 'exportData':
        return await this.handleExport(query, queryResult);

      case 'listFiles':
        return await this.handleListFiles();

      case 'spawnAgent':
        return await this.handleSpawnAgent(query);

      case 'createGoal':
        return await this.handleCreateGoal(query);

      case 'generateCode':
        return await this.handleGenerateCode(query);

      case 'analyzeFiles':
        return await this.handleAnalyzeFiles(query);

      default:
        return { success: false, message: `Action '${action}' not yet implemented` };
    }
  }

  /**
   * Handle export action
   */
  async handleExport(query, queryResult) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `query_export_${timestamp}.json`;
    const filepath = await this.exportResult(
      query,
      queryResult.answer,
      'json',
      queryResult.metadata
    );

    return {
      success: true,
      action: 'export',
      filepath,
      filename,
      message: `Exported query results to ${filepath}`
    };
  }

  /**
   * Handle write file action
   * Allows LLM to write content to outputs/ directory
   */
  async handleWriteFile(query) {
    // This is a complex action that requires extracting filename and content from the query
    // The LLM should structure its request clearly, e.g.:
    // "write a file to outputs/my_analysis.md with the following content: [content]"
    
    // Extract filename
    const filenameMatch = query.match(/outputs\/([^\s]+\.\w+)/i);
    if (!filenameMatch) {
      return {
        success: false,
        action: 'write_file',
        message: 'Could not identify the file path. Please specify as: outputs/filename.ext'
      };
    }

    const filename = filenameMatch[1];
    
    // Validate filename - only allow certain extensions and no path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return {
        success: false,
        action: 'write_file',
        message: 'Invalid filename. Only simple filenames are allowed (no subdirectories or path traversal)'
      };
    }

    const allowedExtensions = ['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.xml', '.html'];
    const ext = path.extname(filename).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return {
        success: false,
        action: 'write_file',
        message: `File extension ${ext} not allowed. Allowed: ${allowedExtensions.join(', ')}`
      };
    }

    // Extract content - look for common patterns
    let content = null;
    
    // Pattern 1: "with the following content: [content]"
    const contentMatch1 = query.match(/with (?:the )?following content:?\s*(.+)/is);
    if (contentMatch1) {
      content = contentMatch1[1].trim();
    }
    
    // Pattern 2: "containing: [content]"
    const contentMatch2 = query.match(/containing:?\s*(.+)/is);
    if (!content && contentMatch2) {
      content = contentMatch2[1].trim();
    }

    // Pattern 3: Content in code blocks
    const codeBlockMatch = query.match(/```(?:\w+)?\s*\n([\s\S]+?)\n```/);
    if (!content && codeBlockMatch) {
      content = codeBlockMatch[1].trim();
    }

    if (!content) {
      return {
        success: false,
        action: 'write_file',
        message: 'Could not extract file content from query. Please structure as: "write a file to outputs/name.ext with the following content: [your content]"'
      };
    }

    // Write the file
    const filePath = path.join(this.runtimeDir, 'outputs', filename);
    
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      const stats = await fs.stat(filePath);

      // Log the write action
      console.log(`[QueryEngine] Wrote file: ${filePath} (${stats.size} bytes)`);

      return {
        success: true,
        action: 'write_file',
        file: {
          path: `outputs/${filename}`,
          fullPath: filePath,
          size: stats.size,
          created: stats.mtime
        },
        message: `Successfully wrote ${stats.size} bytes to outputs/${filename}`
      };
    } catch (error) {
      return {
        success: false,
        action: 'write_file',
        message: `Failed to write file: ${error.message}`
      };
    }
  }

  /**
   * Handle read full file action
   */
  async handleReadFullFile(query) {
    // Extract filename from query
    const match = query.match(/outputs\/([^\s]+)/i);
    if (!match) {
      return {
        success: false,
        action: 'read_full_file',
        message: 'Could not identify the file path. Please specify the file as: outputs/filename.ext'
      };
    }

    const filename = match[1];
    const filePath = path.join(this.runtimeDir, 'outputs', filename);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);

      return {
        success: true,
        action: 'read_full_file',
        file: {
          path: `outputs/${filename}`,
          fullPath: filePath,
          size: content.length,
          content: content,
          modified: stats.mtime
        },
        message: `Read ${content.length} bytes from outputs/${filename}`
      };
    } catch (error) {
      return {
        success: false,
        action: 'read_full_file',
        message: `Could not read file: ${error.message}`
      };
    }
  }

  /**
   * Handle list files action
   */
  async handleListFiles() {
    const files = await this.loadAgentOutputFiles();
    return {
      success: true,
      action: 'list_files',
      files,
      message: `Found ${files.total} files: ${files.codeCreation.length} code files, ${files.codeExecution.length} execution outputs, ${files.documents.length} documents, ${files.deliverables.length} deliverables`
    };
  }

  /**
   * Handle spawn agent action (requires orchestrator)
   */
  async handleSpawnAgent(query) {
    if (!this.orchestrator) {
      return {
        success: false,
        action: 'spawn_agent',
        message: 'Orchestrator not available - cannot spawn agents from query interface'
      };
    }

    // Parse agent type and mission from query
    const agentType = this.extractAgentType(query);
    const mission = this.extractMission(query);

    if (!agentType || !mission) {
      return {
        success: false,
        action: 'spawn_agent',
        message: 'Could not parse agent type or mission from query. Try: "Run a research agent to investigate X"'
      };
    }

    // Create mission spec
    const missionSpec = {
      missionId: `mission_query_${Date.now()}`,
      agentType,
      goalId: `goal_query_${Date.now()}`,
      description: mission,
      successCriteria: ['Complete the requested task', 'Store outputs appropriately'],
      maxDuration: 900000, // 15 minutes
      createdBy: 'query_interface',
      spawnCycle: this.orchestrator.cycleCount || 0,
      triggerSource: 'query_command',
      spawningReason: 'user_query_request',
      priority: 0.8,
      provenanceChain: []
    };

    // Spawn agent
    const agentId = await this.orchestrator.agentExecutor.spawnAgent(missionSpec);

    if (agentId) {
      return {
        success: true,
        action: 'spawn_agent',
        agentId,
        agentType,
        mission,
        message: `✅ Spawned ${agentType} agent (ID: ${agentId}) with mission: "${mission}"`
      };
    } else {
      return {
        success: false,
        action: 'spawn_agent',
        message: 'Failed to spawn agent - check orchestrator logs'
      };
    }
  }

  /**
   * Handle create goal action (requires orchestrator)
   */
  async handleCreateGoal(query) {
    if (!this.orchestrator) {
      return {
        success: false,
        action: 'create_goal',
        message: 'Orchestrator not available - cannot create goals from query interface'
      };
    }

    // Extract goal description from query
    const goalDescription = this.extractGoalDescription(query);

    if (!goalDescription) {
      return {
        success: false,
        action: 'create_goal',
        message: 'Could not extract goal description from query. Try: "Create a goal to optimize X"'
      };
    }

    // Create urgent goal
    const goalSpec = {
      description: goalDescription,
      priority: 0.8,
      source: 'query_interface',
      reason: 'User-requested via query command center'
    };

    // Inject goal
    await this.orchestrator.coordinator.injectUrgentGoals([goalSpec], this.orchestrator.goals);

    return {
      success: true,
      action: 'create_goal',
      goalDescription,
      message: `✅ Created goal: "${goalDescription}"`
    };
  }

  /**
   * Handle generate code action (spawns code creation agent)
   */
  async handleGenerateCode(query) {
    if (!this.orchestrator) {
      return {
        success: false,
        action: 'generate_code',
        message: 'Orchestrator not available'
      };
    }

    const mission = this.extractMission(query) || query;
    
    const missionSpec = {
      missionId: `mission_codegen_${Date.now()}`,
      agentType: 'code_creation',
      goalId: `goal_codegen_${Date.now()}`,
      description: mission,
      successCriteria: ['Generate functional code files', 'Store in outputs directory'],
      maxDuration: 900000,
      createdBy: 'query_interface',
      spawnCycle: this.orchestrator.cycleCount || 0,
      triggerSource: 'query_command',
      spawningReason: 'code_generation_request',
      priority: 0.8,
      provenanceChain: []
    };

    const agentId = await this.orchestrator.agentExecutor.spawnAgent(missionSpec);

    if (agentId) {
      return {
        success: true,
        action: 'generate_code',
        agentId,
        message: `✅ Spawned code creation agent (ID: ${agentId}) for: "${mission}"`
      };
    } else {
      return {
        success: false,
        action: 'generate_code',
        message: 'Failed to spawn code creation agent'
      };
    }
  }

  /**
   * Handle analyze files action (spawns document analysis agent)
   */
  async handleAnalyzeFiles(query) {
    if (!this.orchestrator) {
      return {
        success: false,
        action: 'analyze_files',
        message: 'Orchestrator not available'
      };
    }

    const mission = this.extractMission(query) || query;
    
    const missionSpec = {
      missionId: `mission_fileanalysis_${Date.now()}`,
      agentType: 'document_analysis',
      goalId: `goal_fileanalysis_${Date.now()}`,
      description: mission,
      successCriteria: ['Analyze requested files', 'Provide comprehensive report'],
      maxDuration: 900000,
      createdBy: 'query_interface',
      spawnCycle: this.orchestrator.cycleCount || 0,
      triggerSource: 'query_command',
      spawningReason: 'file_analysis_request',
      priority: 0.8,
      provenanceChain: []
    };

    const agentId = await this.orchestrator.agentExecutor.spawnAgent(missionSpec);

    if (agentId) {
      return {
        success: true,
        action: 'analyze_files',
        agentId,
        message: `✅ Spawned document analysis agent (ID: ${agentId}) for: "${mission}"`
      };
    } else {
      return {
        success: false,
        action: 'analyze_files',
        message: 'Failed to spawn analysis agent'
      };
    }
  }

  /**
   * Extract agent type from natural language query
   */
  extractAgentType(query) {
    const queryLower = query.toLowerCase();

    if (/\b(research|web|search|find|investigate)\b/i.test(queryLower)) return 'research';
    if (/\b(analyz|examine|deep|understand)\b/i.test(queryLower)) return 'analysis';
    if (/\b(synthesis|report|summarize|consolidate)\b/i.test(queryLower)) return 'synthesis';
    if (/\b(explore|creative|speculative|what if)\b/i.test(queryLower)) return 'exploration';
    if (/\b(code execution|run code|execute|test|validate)\b/i.test(queryLower)) return 'code_execution';
    if (/\b(code creation|generate code|write code|create script)\b/i.test(queryLower)) return 'code_creation';
    if (/\b(document creation|create document|write document)\b/i.test(queryLower)) return 'document_creation';
    if (/\b(document analysis|analyze documents|read documents)\b/i.test(queryLower)) return 'document_analysis';

    return null;
  }

  /**
   * Extract mission description from query
   */
  extractMission(query) {
    // Remove action verbs to get core mission
    let mission = query.replace(/^(run|execute|spawn|create|start|launch|generate|write|build|analyze|examine|list|show|export) (a|an|the|all|these|some)? ?(research|analysis|synthesis|exploration|code|document|quality|files?)? ?(agent|mission|script|program|tool)? (to|for|that|about)? ?/i, '');
    mission = mission.trim();
    return mission || null;
  }

  /**
   * Extract goal description from query
   */
  extractGoalDescription(query) {
    let goal = query.replace(/^(create|add|set|inject) (a|an|new)? ?goal (to|for|that|about)? ?/i, '');
    goal = goal.trim();
    return goal || null;
  }
  
  /**
   * Extract artifacts (code blocks) from query answer
   */
  extractArtifactsFromAnswer(query, answer, expectedType = null) {
    const artifacts = [];
    const codeBlockRegex = /```(\w+)?\s*\n([\s\S]*?)\n```/g;
    let match;
    
    while ((match = codeBlockRegex.exec(answer)) !== null) {
      const language = match[1] || expectedType || 'text';
      const code = match[2].trim();
      
      // Skip tiny blocks (likely examples, not full files)
      if (code.length < 50) continue;
      
      // Verify it's a complete file for the type
      if (this.isCompleteFile(code, language)) {
        artifacts.push({
          language: language,
          content: code,
          size: code.length
        });
      }
    }
    
    // Sort by size (largest first - likely the main file)
    artifacts.sort((a, b) => b.size - a.size);
    
    console.log(`[QueryEngine] Extracted ${artifacts.length} code blocks from answer`);
    
    return artifacts;
  }
  
  /**
   * Check if code is a complete file (not a snippet)
   */
  isCompleteFile(code, language) {
    if (language === 'html') {
      return code.includes('<!DOCTYPE') || code.includes('<html');
    }
    if (language === 'python') {
      return code.includes('def ') || code.includes('class ') || code.length > 200;
    }
    if (language === 'javascript' || language === 'js') {
      return code.includes('function ') || code.includes('const ') || code.length > 200;
    }
    if (language === 'json') {
      try {
        JSON.parse(code);
        return true;
      } catch {
        return false;
      }
    }
    
    // For other types, use size heuristic
    return code.length > 100;
  }
  
  /**
   * Infer filename from query and artifact
   */
  inferArtifactFilename(query, artifact, index = 0) {
    // Try to extract subject/topic from query
    const subjectPatterns = [
      /\b(?:of|for|about|showing|describing)\s+(?:the\s+)?([a-z0-9 _-]+?)(?:\s|$)/i,
      /\b([a-z0-9 _-]{3,})\s+(?:diagram|visualization|file|system|design|prototype)/i
    ];
    
    let subject = 'generated';
    for (const pattern of subjectPatterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        subject = match[1].trim().toLowerCase().replace(/\s+/g, '_').substring(0, 30);
        break;
      }
    }
    
    // Get extension from language
    const extensions = {
      html: 'html',
      python: 'py',
      javascript: 'js',
      js: 'js',
      json: 'json',
      css: 'css',
      yaml: 'yaml',
      yml: 'yaml',
      markdown: 'md',
      md: 'md',
      svg: 'svg',
      xml: 'xml'
    };
    
    const ext = extensions[artifact.language] || 'txt';
    const timestamp = Date.now();
    const suffix = index > 0 ? `_${index}` : '';
    
    return `${subject}${suffix}_${timestamp}.${ext}`;
  }
  
  /**
   * Handle create file from answer content (direct write - no agent spawning)
   */
  async handleCreateFileFromAnswer(query, artifacts) {
    const createdFiles = [];
    const errors = [];
    
    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i];
      const filename = this.inferArtifactFilename(query, artifact, i);
      
      // Determine output subdirectory based on file type
      let subdir = 'document-creation'; // default
      if (['html', 'css', 'svg'].includes(artifact.language)) {
        subdir = 'web-assets';
      } else if (['python', 'javascript', 'js'].includes(artifact.language)) {
        subdir = 'code-snippets';
      }
      
      // Create directory with query timestamp
      const timestamp = Date.now();
      const outputDir = path.join(this.runtimeDir, 'outputs', subdir, `query_${timestamp}`);
      await fs.mkdir(outputDir, { recursive: true });
      
      const filepath = path.join(outputDir, filename);
      
      try {
        // Write file
        await fs.writeFile(filepath, artifact.content, 'utf-8');
        const stats = await fs.stat(filepath);
        
        const relPath = path.relative(this.runtimeDir, filepath);
        
        createdFiles.push({
          filename,
          path: relPath,
          fullPath: filepath,
          size: stats.size,
          language: artifact.language
        });
        
        console.log(`[QueryEngine] ✅ Created file: ${relPath} (${stats.size} bytes)`);
        
      } catch (error) {
        errors.push({
          filename,
          error: error.message
        });
        console.error(`[QueryEngine] ❌ Failed to create ${filename}:`, error);
      }
    }
    
    return {
      success: createdFiles.length > 0,
      action: 'create_file_from_answer',
      filesCreated: createdFiles,
      errors: errors,
      message: createdFiles.length > 0 
        ? `✅ Created ${createdFiles.length} file${createdFiles.length > 1 ? 's' : ''}: ${createdFiles.map(f => f.filename).join(', ')}`
        : `❌ Failed to create files`
    };
  }

  /**
   * Set orchestrator reference (for actions)
   */
  setOrchestrator(orchestrator) {
    this.orchestrator = orchestrator;
    console.log('[QueryEngine] Orchestrator reference set - actions now available');
  }

  /**
   * Log action execution
   */
  async logAction(actionIntent, result, query) {
    try {
      const actionsLog = path.join(this.runtimeDir, 'query-actions.jsonl');
      const logEntry = {
        timestamp: new Date().toISOString(),
        action: actionIntent.action,
        query,
        success: result.success,
        result,
        user: 'query_interface'
      };
      await fs.appendFile(actionsLog, JSON.stringify(logEntry) + '\n');
    } catch (error) {
      console.error('[QueryEngine] Failed to log action:', error);
    }
  }
}

module.exports = { QueryEngine };
