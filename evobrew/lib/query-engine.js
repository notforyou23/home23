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
const { GPT5Client } = require('./gpt5-client');
const { createClusterAdapter } = require('./cluster-adapter');
const { EvidenceAnalyzer } = require('./evidence-analyzer');
const { InsightSynthesizer } = require('./insight-synthesizer');
const { CoordinatorIndexer } = require('./coordinator-indexer');
const { QuerySuggester } = require('./query-suggestions');
const { ContextTracker } = require('./context-tracker');
const AnthropicClient = require('./anthropic-client');
const { PGSEngine } = require('./pgs-engine');
const { getModelId } = require('./model-selection');

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
  constructor(runtimeDir, openaiKey) {
    this.runtimeDir = runtimeDir;
    this.stateFile = path.join(runtimeDir, 'state.json.gz');
    this.thoughtsFile = path.join(runtimeDir, 'thoughts.jsonl');
    this.coordinatorDir = path.join(runtimeDir, 'coordinator');
    this.metricsFile = path.join(runtimeDir, 'evaluation-metrics.json');
    this.embeddingsCache = path.join(runtimeDir, 'embeddings-cache.json');
    this.exportsDir = path.join(runtimeDir, 'exports');
    this.modelDefaults = {
      queryModel: process.env.COSMO_QUERY_MODEL || 'gpt-5.2',
      pgsSweepModel: process.env.COSMO_PGS_SWEEP_MODEL || process.env.PGS_SWEEP_MODEL || 'claude-sonnet-4-6'
    };
    
    // OpenAI is optional - only needed for semantic search embeddings
    this.openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
    if (!this.openai) {
      console.log('[QueryEngine] No OpenAI key - semantic search disabled, keyword search available');
    }
    this.gpt5Client = new GPT5Client(console); // Use GPT5Client for queries
    this.anthropicClient = new AnthropicClient({}, console); // Anthropic client (lazy init, OAuth-aware)
    this.pgsEngine = null;
    
    // In-memory cache for frequent queries
    this.queryCache = new Map();
    this.maxCacheSize = 50;

    // Enhancement modules (Phase 1)
    this.evidenceAnalyzer = new EvidenceAnalyzer();
    this.insightSynthesizer = new InsightSynthesizer();
    this.coordinatorIndexer = this.openai ? new CoordinatorIndexer(this.coordinatorDir, this.openai) : null;
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
      
      // Check if cluster files exist (portable version may not have them)
      const clusterStorePath = path.join(__dirname, '../cluster/cluster-state-store.js');
      if (!fsSync.existsSync(clusterStorePath)) {
        console.log('[QueryEngine] Cluster logic not found in standalone package, skipping direct access.');
        return null;
      }

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
        .sort((a, b) => {
          // Extract cycle numbers for proper numeric sorting
          // Filenames are like: review_50.md, review_100.md
          const numA = parseInt(a.match(/review_(\d+)/)?.[1] || '0', 10);
          const numB = parseInt(b.match(/review_(\d+)/)?.[1] || '0', 10);
          return numB - numA; // Descending order (highest cycle first)
        });

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
    if (!this.openai) {
      // No OpenAI client - semantic search unavailable, will fall back to keyword search
      return null;
    }
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000),
        encoding_format: 'float',
        dimensions: 512  // Must match brain node embedding dimensions
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
  /**
   * Get brain node count for progress indicators
   */
  async getBrainNodeCount() {
    try {
      const state = await this.loadBrainState();
      return state.memory?.nodes?.length || 0;
    } catch (error) {
      return 0;
    }
  }

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
      filterTags = null,  // NEW: Optional tag filter for targeted queries
      onChunk = null  // NEW (2026-01-21): Optional progress callback
    } = options;
    
    // NEW: Load live journals even if baseline doesn't exist yet (fresh runs)
    const baselineNodes = (state.memory && state.memory.nodes) ? state.memory.nodes : [];
    const liveJournals = await this.loadLiveJournals();
    let allNodes = this.mergeNodesWithJournals(baselineNodes, liveJournals);
    
    // PHASE 1 (2026-01-21): Filter out meta content that pollutes query results
    // Dreams are speculative hypotheses from sleep cycles - NOT validated research
    // Reasoning/introspection are process traces, not substantive findings
    const META_EXCLUDE_TAGS = ['dream', 'reasoning', 'introspection'];
    const originalCount = allNodes.length;
    
    allNodes = allNodes.filter(node => {
      // Filter by tag
      const nodeTags = Array.isArray(node.tag) ? node.tag : [node.tag];
      const hasExcludedTag = META_EXCLUDE_TAGS.some(excl => 
        nodeTags.some(t => t && String(t).toLowerCase().includes(excl))
      );
      if (hasExcludedTag) return false;
      
      // Filter by content prefix (defense in depth)
      const concept = node.concept || '';
      if (concept.startsWith('[DREAM]') || concept.startsWith('[REASONING]')) {
        return false;
      }
      
      return true;
    });
    
    const filteredCount = originalCount - allNodes.length;
    if (filteredCount > 0) {
      console.log(`[QUERY ENGINE] Filtered ${filteredCount} meta nodes (dreams/reasoning/introspection)`);
      // Emit progress for streaming
      if (options.onChunk) {
        options.onChunk({ type: 'progress', message: `Filtered ${filteredCount} meta nodes (dreams/reasoning)` });
      }
    }
    
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
      
      // PHASE 2 (2026-01-21): Tag-based boosting - prioritize SUBSTANCE over META
      if (node.tag) {
        const tags = Array.isArray(node.tag) ? node.tag : [node.tag];
        const hasTag = (pattern) => tags.some(t => t && String(t).toLowerCase().includes(pattern));
        
        // SUBSTANCE BOOSTS - actual research content (these are what users want)
        if (hasTag('agent_finding')) combinedScore *= 1.5;   // Actual discoveries
        if (hasTag('discovery')) combinedScore *= 1.5;       // Explicit discoveries
        if (hasTag('breakthrough')) combinedScore *= 1.6;    // Major insights (keep existing)
        if (hasTag('research')) combinedScore *= 1.4;        // Research content
        if (hasTag('analysis')) combinedScore *= 1.3;        // Analytical work
        if (hasTag('synthesis')) combinedScore *= 1.3;       // Synthesized knowledge
        if (hasTag('finding')) combinedScore *= 1.4;         // General findings
        if (hasTag('evidence')) combinedScore *= 1.3;        // Evidence-backed content
        
        // META DE-BOOSTS - process/meta content (these crowd out substance)
        // Note: Dreams/reasoning/introspection already filtered out in Phase 1
        if (hasTag('agent_insight')) combinedScore *= 0.6;   // Agent self-reflection (not findings)
        if (hasTag('summary')) combinedScore *= 0.7;         // Summaries of other content
        if (hasTag('consolidated')) combinedScore *= 0.7;    // Already-processed content
        if (hasTag('coordinator')) combinedScore *= 0.6;     // Coordinator reviews
        if (hasTag('meta')) combinedScore *= 0.5;            // Explicit meta-content
        if (hasTag('process')) combinedScore *= 0.6;         // Process descriptions
      }
      
      // PHASE 5 (2026-01-21): Boost multi-source validated nodes
      // Nodes that merged from multiple source brains have been "validated" across independent research
      const sourceCount = node.sourceRuns?.length || 1;
      if (sourceCount > 1) {
        // +15% per additional source (2 sources = 1.15x, 3 = 1.30x, etc.)
        combinedScore *= (1 + (sourceCount - 1) * 0.15);
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
    
    // Emit progress: found relevant nodes
    if (onChunk && results.length > 0) {
      const topTags = {};
      results.slice(0, 100).forEach(n => {
        const tags = Array.isArray(n.tag) ? n.tag : [n.tag];
        tags.forEach(t => {
          if (t) topTags[t] = (topTags[t] || 0) + 1;
        });
      });
      const topTagsList = Object.entries(topTags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag, count]) => `${tag}(${count})`)
        .join(', ');
      onChunk({ type: 'progress', message: `Found ${results.length} relevant nodes: ${topTagsList}` });
    }
    
    if (!deep) {
      results = results.slice(0, limit);
    }
    
    // Include connected nodes if requested
    // PHASE 6 (2026-01-21): Scale connected node selection with limit
    // Old: Fixed 5-20 topIds and 15 connectedLimit regardless of brain size
    // New: Scale based on result count for better relationship coverage
    if (includeConnected && state.memory.edges && results.length > 0) {
      const connectedIds = new Set();
      // Scale topIds count: 10% of results, minimum 10, maximum 50
      const topCount = Math.max(10, Math.min(50, Math.ceil(results.length * 0.1)));
      const topIds = new Set(results.slice(0, topCount).map(n => n.id));
      
      state.memory.edges.forEach(edge => {
        if (topIds.has(edge.source)) connectedIds.add(edge.target);
        if (topIds.has(edge.target)) connectedIds.add(edge.source);
      });
      
      const connected = state.memory.nodes
        .filter(n => connectedIds.has(n.id) && !topIds.has(n.id))
        .map(n => ({ ...n, score: 0, connected: true }));
      
      // Scale connected limit: 20% of topCount, minimum 15, maximum 100
      const connectedLimit = deep ? Math.min(connected.length, 100) : Math.max(15, Math.ceil(topCount * 0.5));
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
   * MODEL CONTEXT WINDOW CONFIGURATION (2026-01-23)
   *
   * Defines context window sizes and maximum node limits per model.
   * Used to safely increase node coverage without exceeding token limits.
   */
  static MODEL_CONTEXT_WINDOWS = {
    'gpt-5.2': 128000,
    'gpt-5': 128000,
    'gpt-5.1': 128000,
    'gpt-5-mini': 128000,
    'gpt-5.1-codex-max': 128000,
    'claude-opus-4-5': 200000,  // Conservative estimate for Opus 4.5
    'claude-opus': 200000,
    'claude-sonnet-4-5': 128000,
    'claude-sonnet': 128000,
    'default': 128000
  };

  static MODEL_MAX_NODES = {
    'gpt-5.2': 3000,       // 128K context, proven model
    'gpt-5': 3000,         // 128K context, max reasoning
    'gpt-5.1': 3000,       // 128K context
    'gpt-5-mini': 2500,    // 128K but smaller model, more conservative
    'gpt-5.1-codex-max': 3000,
    'claude-opus-4-5': 4000,  // ~200K context, excellent for large brains
    'claude-opus': 4000,
    'claude-sonnet-4-5': 2800,  // 128K context
    'claude-sonnet': 2800,
    'default': 2500
  };

  /**
   * Execute query using GPT-5.2 Responses API
   *
   * CONTEXT OPTIMIZATION (2025-12-11):
   * - Increased memory node limit from 50 to 200 (6.8% → 27.4% coverage)
   * - Increased connected concepts from 30 to 100 (full coverage in most cases)
   * - Total context usage: ~40% of GPT-5.2's 128K token limit (safe headroom)
   * - Rationale: Query engine is only interface to COSMO's brain - comprehensive access critical
   *
   * MODEL-AWARE NODE LIMITS (2026-01-23):
   * - MAX_NODES now scales with model context window (2500-4000)
   * - Token budget verified: 56-62% utilization at max nodes (safe)
   * - Coverage improved: 10% → 15% on 20K node brains (GPT-5.2)
   */
  async executeQuery(query, options = {}) {
    const startTime = Date.now(); // Performance tracking

    const {
      model: requestedModel = 'gpt-5.2',  // Default to gpt-5.2
      mode = 'normal',
      exportFormat = null,
      // NEW: Enhancement options (all opt-in)
      includeEvidenceMetrics = false,
      enableSynthesis = false,
      followUpContext = null,
      includeCoordinatorInsights = true, // Default true for better results
      outputFiles = null, // NEW: Output files from executeEnhancedQuery
      baseAnswer = null, // NEW: For executive mode - compress existing answer instead of re-querying
      priorContext = null, // NEW: For follow-up queries - includes prior query and answer
      onChunk = null // NEW (2026-01-21): Optional streaming callback
    } = options;
    const model = getModelId(requestedModel) || 'gpt-5.2';
    
    // Validate model - GPT-5 and Claude models supported
    const isClaudeModel = model.startsWith('claude');
    if (!model.includes('gpt-5') && !isClaudeModel) {
      throw new Error(`Model ${model} not supported. Supported models: GPT-5 family (gpt-5.2, gpt-5-mini) and Claude (claude-opus-4-5, claude-sonnet-4-5).`);
    }
    
    // EXECUTIVE MODE SPECIAL CASE: Compress existing answer, don't re-query brain
    if (mode === 'executive' && baseAnswer) {
      return await this.executeExecutiveCompression(query, baseAnswer, options);
    }
    
    // Emit progress: starting
    if (onChunk) {
      onChunk({ type: 'progress', message: 'Loading brain state...' });
    }
    
    // Load data
    const state = await this.loadBrainState();
    const stateHash = getStateHashForCache(state);
    const cacheKey = `${stateHash}:${query}:${model}:${mode}`;

    if (this.queryCache.has(cacheKey)) {
      this.performanceMetrics.cacheHits++;
      return this.queryCache.get(cacheKey);
    }
    
    // Emit progress: loaded brain state with details
    if (onChunk) {
      const nodeCount = state.memory?.nodes?.length || 0;
      const edgeCount = state.memory?.edges?.length || 0;
      const cycleCount = state.cycleCount || 0;
      const isMerged = state.mergeV2 || state.runMetadata?.mergedFrom?.length > 0;
      const mergeInfo = isMerged ? ` (merged brain)` : '';
      onChunk({ type: 'progress', message: `Brain loaded: ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges, ${cycleCount} cycles${mergeInfo}` });
    }
    
    this.performanceMetrics.cacheMisses++;

    const thoughts = await this.loadThoughts();
    const metrics = await this.loadMetrics();
    const report = await this.getLatestReport();
    
    // Emit progress: searching memory
    if (onChunk) {
      onChunk({ type: 'progress', message: 'Searching memory network for relevant nodes...' });
    }
    
    // ALWAYS use full knowledge - no depth limits
    // Get ALL relevant memory and thoughts (sorted by relevance)
    const relevantMemory = await this.queryMemory(state, query, {
      limit: 1000,  // Get all relevant nodes
      includeConnected: true,
      deep: true,
      useSemanticSearch: true,
      onChunk  // Pass through for progress events
    });
    
    const relevantThoughts = await this.queryThoughts(thoughts, query, {
      limit: 1000,  // Get all relevant thoughts
      deep: true
    });
    
    // Emit progress: building context
    if (onChunk) {
      const memoryCount = relevantMemory.filter(n => !n.connected).length;
      const connectedCount = relevantMemory.filter(n => n.connected).length;
      if (outputFiles && outputFiles.total > 0) {
        onChunk({ type: 'progress', message: `Context: ${memoryCount} nodes, ${connectedCount} connected, ${outputFiles.total} files` });
      } else {
        onChunk({ type: 'progress', message: `Context: ${memoryCount} memory nodes, ${connectedCount} connected` });
      }
    }
    
    // Build context - mode only affects display, not what data we gather
    let context = this.buildContext(state, relevantMemory, relevantThoughts, metrics, report, mode, outputFiles, model);
    
    // Emit progress: generating response
    if (onChunk) {
      const contextSize = Math.round(context.length / 4); // rough token estimate
      onChunk({ type: 'progress', message: `Generating response with ~${contextSize.toLocaleString()} token context...` });
    }
    
    // MONITORING: Log context statistics (enhanced for Phase 1, updated 2026-01-21)
    const memoryNodesFound = relevantMemory.filter(n => !n.connected).length;
    const modeLimits = {
      // UI modes
      quick: 150, full: 400, expert: 800, dive: 1000,
      // Legacy modes
      fast: 100, normal: 200, deep: 400, raw: 150, report: 600, innovation: 300, consulting: 300, executive: 0
    };
    const modeLimit = modeLimits[mode] || 200;
    const memoryNodesShown = Math.min(memoryNodesFound, modeLimit);
    
    // Model-aware context window (2026-01-23)
    const contextWindow = QueryEngine.MODEL_CONTEXT_WINDOWS[model] || QueryEngine.MODEL_CONTEXT_WINDOWS['default'];
    const modelMaxNodes = QueryEngine.MODEL_MAX_NODES[model] || QueryEngine.MODEL_MAX_NODES['default'];

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
      percentOfLimit: Math.round((Math.ceil(context.length / 4) / contextWindow) * 100),
      contextWindow: contextWindow,
      modelMaxNodes: modelMaxNodes
    };
    console.log(`[QUERY ENGINE] Context built for mode '${mode}':`, contextStats);
    console.log(`[QUERY ENGINE] Memory coverage: ${contextStats.memoryNodesShown}/${contextStats.memoryNodesFound} (${((contextStats.memoryNodesShown/contextStats.memoryNodesFound)*100).toFixed(1)}%) [mode limit: ${modeLimit}]`);
    console.log(`[QUERY ENGINE] Connected concepts: ${contextStats.connectedConceptsShown}/${contextStats.connectedConceptsFound} (${contextStats.connectedConceptsFound > 0 ? ((contextStats.connectedConceptsShown/contextStats.connectedConceptsFound)*100).toFixed(1) : 0}%)`);
    console.log(`[QUERY ENGINE] Context size: ${contextStats.contextChars.toLocaleString()} chars (~${contextStats.estimatedTokens.toLocaleString()} tokens, ${contextStats.percentOfLimit}% of ${(contextWindow/1000).toFixed(0)}K limit)`);
    
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
    
    // Map mode to GPT-5.2 reasoning parameters (updated 2026-01-21)
    const reasoningConfig = {
      // UI MODES (what users actually select in the interface)
      quick: { 
        reasoningEffort: 'low', 
        maxTokens: 10000, 
        verbosity: 'low' 
      },
      full: { 
        reasoningEffort: 'medium', 
        maxTokens: 20000, 
        verbosity: 'medium' 
      },
      expert: { 
        reasoningEffort: 'high', 
        maxTokens: 30000, 
        verbosity: 'high' 
      },
      dive: {
        reasoningEffort: 'high',
        maxTokens: 32000,
        verbosity: 'high'
      },
      
      // LEGACY MODES (kept for backward compatibility)
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
    // Updated 2026-01-21: Added UI modes (quick/full/expert/dive)
    let instructions;
    if (mode === 'dive') {
      instructions = this.getDiveSystemPrompt();
    } else if (mode === 'raw') {
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
      // UI modes: quick, full, expert
      // Legacy modes: fast, normal, deep
      // expert and deep get the deep prompt; others get standard
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
    
    // Generate answer using appropriate model client (GPT-5 or Claude)
    const client = isClaudeModel ? this.anthropicClient : this.gpt5Client;
    let response;
    try {
      response = await client.generate({
        model: model,
        instructions: instructions,
        input: `${context}\n\nQuestion: ${query}`,
        reasoningEffort: config.reasoningEffort,
        maxTokens: config.maxTokens,
        verbosity: config.verbosity,
        onChunk: onChunk  // NEW (2026-01-21): Pass through streaming callback
      });
    } catch (error) {
      console.error(`[QUERY ENGINE] ${isClaudeModel ? 'Anthropic' : 'GPT-5'} API call failed:`, error);
      console.error('[QUERY ENGINE] Context length:', context.length, 'chars');
      console.error('[QUERY ENGINE] Instructions length:', instructions.length, 'chars');
      throw new Error(`${isClaudeModel ? 'Anthropic' : 'GPT-5'} API error: ${error.message || 'Unknown error'}`);
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
    if (includeCoordinatorInsights && this.coordinatorIndexer) {
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

  /**
   * PHASE 4 (2026-01-21): Get source-diverse nodes from merged brains
   * Ensures representation from all merged source runs, not just highest-scoring ones
   * Uses stratified sampling to round-robin across sources by score
   * 
   * @param {Array} scoredNodes - Nodes sorted by score descending
   * @param {number} limit - Maximum nodes to return
   * @returns {Array} Diverse selection of nodes
   */
  getSourceDiverseNodes(scoredNodes, limit) {
    // Group nodes by source run
    const bySource = new Map();
    for (const node of scoredNodes) {
      const source = node.sourceRun || node.sourceRuns?.[0] || '_default';
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source).push(node);
    }
    
    // If only one source, just return top N
    if (bySource.size <= 1) {
      return scoredNodes.slice(0, limit);
    }
    
    // Stratified sampling: round-robin from each source by score
    const result = [];
    const sources = Array.from(bySource.keys());
    const iterators = new Map();
    
    for (const source of sources) {
      // Each source's nodes are already sorted by score (inherited from parent sort)
      iterators.set(source, 0);
    }
    
    // Round-robin until we hit limit or exhaust all sources
    let sourceIdx = 0;
    while (result.length < limit) {
      const source = sources[sourceIdx % sources.length];
      const idx = iterators.get(source);
      const nodes = bySource.get(source);
      
      if (idx < nodes.length) {
        result.push(nodes[idx]);
        iterators.set(source, idx + 1);
      }
      
      sourceIdx++;
      
      // Check if all sources exhausted
      let allExhausted = true;
      for (const [src, srcNodes] of bySource) {
        if (iterators.get(src) < srcNodes.length) {
          allExhausted = false;
          break;
        }
      }
      if (allExhausted) break;
    }
    
    // Re-sort final result by score for presentation (preserves quality ranking)
    result.sort((a, b) => b.score - a.score);
    
    console.log(`[QUERY ENGINE] Source diversity: ${sources.length} sources, ${result.length}/${scoredNodes.length} nodes selected`);
    return result;
  }

  buildContext(state, relevantMemory, relevantThoughts, metrics, report, mode, outputFiles = null, model = 'gpt-5.2') {
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
    // CONTEXT OPTIMIZATION (2025-12-11, updated 2026-01-21):
    // Phase 1: Mode-based limits to adapt context depth to query needs
    // Phase 2: Increased from 50 to 200 (normal mode) - other modes vary
    // Phase 3: Added UI modes (quick/full/expert) - these are what users actually select
    // Rationale: Query engine is the only interface to COSMO's brain - comprehensive access critical
    // PHASE 3 (2026-01-21): Adaptive limits for large brains
    // Fixed limits don't scale - 400 nodes on a 20K brain = 2% coverage
    // Adaptive limits ensure meaningful coverage regardless of brain size
    const totalNodes = directMatches.length;
    const isMergedBrain = state.mergeV2 || state.runMetadata?.mergedFrom?.length > 0;
    
    // Base limits by mode (minimum thresholds)
    const baseLimits = {
      // UI MODES
      quick: 150, full: 400, expert: 800, dive: 1000,
      // LEGACY MODES
      fast: 100, normal: 200, deep: 400, raw: 150,
      grounded: 300, report: 600, innovation: 300, consulting: 300, executive: 0
    };
    
    // Target coverage percentages by mode
    const targetCoverage = {
      // UI MODES
      quick: 0.10, full: 0.20, expert: 0.30, dive: 0.35,
      // LEGACY MODES  
      fast: 0.10, normal: 0.15, deep: 0.25, raw: 0.10,
      grounded: 0.20, report: 0.35, innovation: 0.20, consulting: 0.20, executive: 0
    };
    
    // Calculate adaptive limit
    const baseLimit = baseLimits[mode] || 200;
    const coverage = targetCoverage[mode] || 0.15;
    let adaptiveLimit = Math.max(baseLimit, Math.ceil(totalNodes * coverage));

    // Apply floor and MODEL-AWARE ceiling (2026-01-23)
    const MIN_NODES = 100;
    const MAX_NODES = QueryEngine.MODEL_MAX_NODES[model] || QueryEngine.MODEL_MAX_NODES['default'];

    console.log(`[QUERY ENGINE] Model: ${model}, MAX_NODES: ${MAX_NODES}, Brain size: ${totalNodes}`);
    adaptiveLimit = Math.max(MIN_NODES, Math.min(adaptiveLimit, MAX_NODES));

    // Boost for merged brains (more diversity needed)
    if (isMergedBrain && adaptiveLimit < MAX_NODES) {
      adaptiveLimit = Math.min(Math.ceil(adaptiveLimit * 1.3), MAX_NODES);
    }

    // Token budget estimation for monitoring (2026-01-23)
    const estimatedNodeTokens = (
      Math.min(adaptiveLimit, 20) * 500 +      // Top 20: 2000 chars = 500 tokens each
      Math.min(Math.max(adaptiveLimit - 20, 0), 80) * 250 +   // Next 80: 1000 chars = 250 tokens
      Math.min(Math.max(adaptiveLimit - 100, 0), 200) * 175 + // Next 200: 700 chars = 175 tokens
      Math.max(adaptiveLimit - 300, 0) * 125  // Rest: 500 chars = 125 tokens
    );

    const contextWindow = QueryEngine.MODEL_CONTEXT_WINDOWS[model] || QueryEngine.MODEL_CONTEXT_WINDOWS['default'];
    const estimatedTotalTokens = estimatedNodeTokens + 10000; // +10K for metadata, goals, connected
    const utilizationPercent = ((estimatedTotalTokens / contextWindow) * 100).toFixed(1);

    console.log(`[QUERY ENGINE] Token budget: ~${estimatedTotalTokens.toLocaleString()} / ${(contextWindow/1000).toFixed(0)}K (${utilizationPercent}%)`);
    console.log(`[QUERY ENGINE] Memory node limit: ${adaptiveLimit} (${((adaptiveLimit/totalNodes)*100).toFixed(1)}% coverage)`);

    const memoryNodeLimit = adaptiveLimit;
    
    // PHASE 4 (2026-01-21): Source diversity for merged brains
    // Ensure we get representation from all merged sources, not just the highest-scoring ones
    let nodesToInclude = directMatches;
    if (isMergedBrain) {
      nodesToInclude = this.getSourceDiverseNodes(directMatches, memoryNodeLimit);
      console.log(`[QUERY ENGINE] Applied source diversity: ${nodesToInclude.length} nodes from merged brain`);
    } else {
      nodesToInclude = directMatches.slice(0, memoryNodeLimit);
    }
    
    nodesToInclude.forEach((node, i) => {
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
      state.goals.active.slice(0, 40).forEach((item, i) => {
        // Handle both [id, goal] tuple format (from export) and plain goal objects
        const goal = Array.isArray(item) ? item[1] : item;
        if (!goal || typeof goal !== 'object') return;

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
      // Add clarification about potentially stale deliverables audit in review
      if (outputFiles && outputFiles.total > 0) {
        context += `**NOTE:** The deliverables audit in the review above may be outdated. Current file counts: ${outputFiles.total} files (${outputFiles.codeCreation?.length || 0} code, ${outputFiles.documents?.length || 0} docs, ${outputFiles.codeExecution?.length || 0} execution, ${outputFiles.deliverables?.length || 0} deliverables). See "Agent Output Files" section below for current inventory.\n\n`;
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
   * Get system prompt for raw mode - direct answers, minimal framing
   * Updated 2026-01-21: Substance-first guidance
   */
  getRawSystemPrompt() {
    return `You are a direct interface to research data. Answer questions from the evidence.

PRIORITY: Answer with SUBSTANCE - findings, facts, data, conclusions.
Skip meta/process content unless directly asked about it.

You have access to memory nodes, thoughts, and output files.

FILES: "Agent Output Files" are actual contents you can read. If previews are insufficient, tell user "read outputs/[filename]".

FILE GENERATION: When asked to create files, provide complete content in code blocks (\`\`\`html, \`\`\`python, etc.). No placeholders.

CITATIONS: Use [Mem X] for memory nodes when source matters.

RULES:
- Answer directly from evidence
- Prioritize findings over process descriptions
- If you don't have the data, say so briefly
- Do not make anything up
- Do not assume`;
  }

  /**
   * Get system prompt for standard queries
   * Updated 2026-01-21: Added UI modes (quick/full/expert) + substance-first guidance
   */
  getStandardSystemPrompt(mode) {
    // expert and deep modes get the comprehensive prompt
    if (mode === 'deep' || mode === 'expert') {
      return `You are an advanced interface to COSMO's autonomous research brain with COMPLETE DEEP ACCESS.

CRITICAL: SUBSTANCE OVER PROCESS
When answering, prioritize ACTUAL FINDINGS and DISCOVERIES over process descriptions:
- PRIORITIZE: Research findings, analysis results, concrete discoveries, data, evidence, recommendations
- DEPRIORITIZE: How COSMO works, cycle mechanics, agent coordination, internal process descriptions
- If a memory node describes "what was found" vs "how it was found", focus on the WHAT

The user wants to know what COSMO LEARNED, not how COSMO operates.

CONTENT PRIORITY (use in this order):
1. Agent findings and discoveries (tagged 'agent_finding', 'discovery', 'breakthrough')
2. Research and analysis content (tagged 'research', 'analysis', 'synthesis')
3. Evidence and supporting data
4. Deliverable file contents (actual outputs created)
5. Thoughts that contain substantive conclusions
6. Only use process/coordination info if directly asked

You have EXHAUSTIVE access to all memory, thoughts, metrics, and agent output files.

FILE ACCESS:
- "Agent Output Files" contain actual file contents you can read directly
- Files shown as PREVIEWS (1,500 chars for deliverables, 500-1,000 for others)
- If you need FULL content: tell user "read outputs/[filename]"

FILE GENERATION (when user requests):
- Provide complete content in markdown code blocks (\`\`\`html, \`\`\`python, etc.)
- Be complete - no placeholders or TODOs for essential functionality

CITATIONS:
- Memory nodes: cite as [Mem X]
- Thoughts: cite as "Cycle N"
- Include citations to show evidence source

TOOLS AVAILABLE:
If you need more information or should create something, you can:
- Read full file contents: "read the full contents of outputs/filename.md"
- Create files: provide content in code blocks (triple backticks with language)
- List files: "list all files"

When answering:
1. Lead with SUBSTANTIVE FINDINGS - what was discovered, concluded, or created
2. Support with evidence from memory nodes and deliverables
3. Be comprehensive but focused on what matters to the user's question
4. Avoid meta-commentary about COSMO's process unless asked
5. Use tools when needed - don't ask permission, just do it

Do NOT make up information. Do not assume. Measure twice, cut once.`;
    }
    
    // quick and full modes get the standard prompt
    return `You are an advanced interface to COSMO's autonomous research brain.

CRITICAL: SUBSTANCE OVER PROCESS
When answering, prioritize ACTUAL FINDINGS over process descriptions:
- FOCUS ON: What was discovered, analyzed, concluded, or created
- AVOID: How COSMO works internally, cycle mechanics, agent coordination details
- The user wants KNOWLEDGE, not system operations

CONTENT PRIORITY:
1. Agent findings and discoveries
2. Research and analysis results
3. Evidence and data
4. Deliverable file contents
5. Substantive conclusions from thoughts

You have access to memory nodes, thought stream, goals, and agent output files.

FILE ACCESS:
- "Agent Output Files" are actual file contents you can read
- Files shown as PREVIEWS - tell user "read outputs/[filename]" for full content

FILE GENERATION (when user requests):
- Provide complete content in markdown code blocks (\`\`\`html, \`\`\`python, etc.)
- Be complete - no placeholders for essential functionality

CITATIONS:
- Memory nodes: [Mem X]
- Thoughts: "Cycle N"

TOOLS AVAILABLE:
- Read files: "read the full contents of outputs/filename.md" 
- Create files: provide content in code blocks (triple backticks with language)
- List files: "list all files"

When answering:
1. Lead with substantive findings that answer the question
2. Support with specific evidence
3. Be precise and evidence-based
4. Skip process details unless asked
5. Use tools autonomously when helpful

Focus on what you CAN synthesize from the evidence. Even partial coverage often provides abundant foundation for insight.

Do NOT make up information. Do not assume. Measure twice, cut once.`;
  }

  /**
   * Get system prompt for DIVE mode - exploratory knowledge graph navigation
   * Created 2026-01-21: Network-first synthesis approach
   */
  getDiveSystemPrompt() {
    return `You are exploring a rich knowledge network - a living brain of accumulated research, discoveries, and insights.

YOUR MISSION: Swim through this knowledge graph. Follow connections. Digest what you find. Surface the gold.

THE KNOWLEDGE STRUCTURE:
This isn't a database of facts - it's a NETWORK:
- Memory nodes contain findings, discoveries, analysis, and insights
- They connect through relationships, shared concepts, and thematic links
- Thoughts show reasoning evolution and idea development
- Deliverable files contain complete analyses and outputs
- Together they form an interconnected web of knowledge

HOW TO EXPLORE:
1. Don't just keyword-match - TRAVERSE the graph
2. Follow connections between related concepts
3. Look for clusters and convergence points
4. Notice what emerges at intersections
5. See patterns that only appear when viewing the whole
6. Track how ideas build on each other
7. Find where multiple independent paths reach the same conclusion

WHAT TO SURFACE:
✓ Non-obvious connections between ideas
✓ Patterns that emerge across the network
✓ Cross-domain insights (when concept A relates to finding B)
✓ Convergent conclusions (multiple paths → same insight)
✓ Knowledge that contradicts common assumptions
✓ Actionable intelligence buried in the details
✓ The "gold nuggets" humans wouldn't find scanning linearly
✓ What becomes visible only when you see the WHOLE web

SYNTHESIS APPROACH:
- Start broad: what are the major themes/clusters?
- Go deep: follow the most interesting connections
- Cross-pollinate: how do different domains inform each other?
- Emerge: what patterns appear at scale?
- Distill: what's the most valuable insight to extract?

COMMUNICATION STYLE:
- Be direct and confident when evidence is strong
- Make connections EXPLICIT ("X connects to Y because...")
- Focus on VALUE and IMPLICATIONS ("This matters because...")
- Lead with insights, support with evidence
- Skip heavy citation unless it adds real credibility
- Absolutely NO meta-commentary about the system/process itself
- Write like you're having an "aha!" conversation

TOOLS YOU CAN USE:
You have direct access to tools - use them autonomously when needed:

TOOLS YOU CAN USE:
You have direct access to tools - use them autonomously when needed:

READ FILES: "read the full contents of outputs/analysis.md"
  - Get complete file content when previews aren't enough
  - No need to ask the user - just read it yourself

CREATE FILES: "create a file outputs/summary.md" or "generate an HTML visualization"
  - Write summaries, reports, visualizations directly
  - System will extract code blocks and save them
  - Use markdown code blocks with language tags

LIST FILES: "list all files in outputs"
  - See what's available before diving deeper

EXPORT DATA: "export these findings to a file"
  - Save query results for later reference

Examples:
- "read the full contents of outputs/detailed_analysis.md" (loads the whole file)
- "create a visualization of these connections" (you provide the HTML, system saves it)
- "generate a Python script for..." (you provide the code, system extracts it)

USE TOOLS FREELY. Don't ask permission. If you need more context, read it. If you should create something, create it.

WHEN THE HUMAN ASKS A QUESTION:
They're really asking: "Explore this angle. What valuable knowledge is hidden in there? What should I know? What can I do with this?"

Your job: Dive deep. Swim through it. Connect the dots. Surface what matters. Use tools as needed.

Do NOT make up information. Do not assume. But DO synthesize boldly when evidence supports it.`;
  }

  /**
   * Get system prompt for grounded mode - pure substance, zero meta
   * Updated 2026-01-21: Stronger substance-first guidance
   */
  getGroundedSystemPrompt() {
    return `You are a SUBSTANCE-ONLY interface to COSMO's knowledge. Zero tolerance for meta-content.

ABSOLUTE RULES:
- ONLY discuss actual findings, discoveries, analysis, and conclusions
- NEVER mention: cycles, agents, coordination, COSMO internals, system mechanics
- If a memory node talks about "the system" or "the process", SKIP IT and find substance
- Treat this like you're presenting research results, not describing a research tool

WHAT TO INCLUDE:
✓ Concrete discoveries and findings
✓ Data, evidence, analysis results
✓ Actionable insights and recommendations
✓ Deliverable content (documents, code, outputs)
✓ Substantive conclusions

WHAT TO EXCLUDE:
✗ How COSMO works or thinks
✗ Agent coordination or spawning
✗ Cycle numbers, divergence scores, semantic metrics
✗ Memory network structure or operations
✗ Any self-referential content about the research process

CITATIONS: Use [Mem X] sparingly - only when the source adds credibility to a claim.

FORMAT: Crisp, declarative statements. Lead with conclusions. Support with evidence.

If the evidence is thin on substance, say "Limited findings on this topic" and stop.
Do NOT pad with process descriptions. Do NOT make things up.`;
  }

  /**
   * Get system prompt for report mode
   * Updated 2026-01-21: Substance-first, minimal meta
   */
  getReportSystemPrompt() {
    return `You are generating a SUBSTANTIVE RESEARCH REPORT from accumulated knowledge.

CRITICAL: This is a KNOWLEDGE REPORT, not a system report.
- Report on WHAT WAS DISCOVERED, not how it was discovered
- Include findings, analysis, conclusions, and recommendations
- Exclude internal process details (cycles, agents, coordination) unless directly relevant
- Write as if presenting to someone who doesn't know or care about COSMO internals

You have access to memory nodes, thoughts, deliverable files, and analysis outputs.

FILES: "Agent Output Files" contain actual content you can read and include.

REPORT STRUCTURE:

# EXECUTIVE SUMMARY
- 2-3 paragraphs of KEY FINDINGS (not process summary)
- Most significant discoveries and insights
- Primary conclusions and their implications

# KEY FINDINGS
- Major discoveries organized by theme/topic
- Concrete evidence and data points
- Cite sources as [Mem X] where it adds credibility
- Focus on WHAT was found, not WHO found it or HOW

# ANALYSIS
- In-depth examination of findings
- Connections between discoveries
- Patterns and themes that emerged
- Quantitative data where available

# IMPLICATIONS & RECOMMENDATIONS
- What the findings mean practically
- Actionable next steps
- Priority areas based on evidence strength
- Specific recommendations grounded in research

# EVIDENCE APPENDIX (optional)
- Key supporting sources if needed
- Only include if it strengthens the report

STYLE GUIDELINES:
- Write in professional research report style
- Lead each section with conclusions, then support with evidence
- Be declarative: "The research found X" not "COSMO's agents discovered X"
- Minimize citations - only cite when source credibility matters
- No meta-commentary about the research process itself

Do not make anything up. Do not assume. Be thorough and professional.`;
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
      if (this.coordinatorIndexer) {
        try {
          const insights = await this.coordinatorIndexer.getSearchableInsights();
          coordinatorInsights = insights.slice(0, 5);
        } catch (error) {
          console.error('Failed to load coordinator insights:', error);
        }
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
          // Normalize path to current brain's outputs directory
          // (merged brains have memory references to original paths, but files would be in current brain's outputs)
          let normalizedPath = fileInfo.path;
          if (normalizedPath.includes('/runtime/outputs/')) {
            normalizedPath = normalizedPath.replace(/^.*\/runtime\/outputs\//, path.join(this.runtimeDir, 'outputs') + '/');
          } else if (normalizedPath.includes('/outputs/')) {
            // Handle runs paths - extract just the relative path after /outputs/
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
      model: requestedModel = this.modelDefaults?.queryModel || 'gpt-5.2',
      mode = 'normal',
      exportFormat = null,
      includeFiles = true,
      allowActions = false,
      includeEvidenceMetrics = false,
      enableSynthesis = false,
      enablePGS = false, // PGS: Partitioned Graph Synthesis for full-coverage queries
      pgsMode = null,
      pgsSessionId = null,
      pgsFullSweep = false,
      pgsConfig = null,
      pgsSweepModel = null,
      followUpContext = null,
      includeCoordinatorInsights = true,
      baseAnswer = null, // For executive mode compression
      baseMetadata = null,
      priorContext = null, // For follow-up queries
      onChunk = null // NEW (2026-01-21): Optional streaming callback
    } = options;
    const model = getModelId(requestedModel) || 'gpt-5.2';
    
    // PGS: Partitioned Graph Synthesis for full-coverage queries
    if (enablePGS) {
      if (!this.pgsEngine) {
        this.pgsEngine = new PGSEngine(this);
      }
      return await this.pgsEngine.execute(query, { model, mode, pgsMode, pgsSessionId, pgsFullSweep, pgsConfig, pgsSweepModel, onChunk, enableSynthesis, includeCoordinatorInsights });
    }
    
    // Emit initial progress
    if (onChunk) {
      onChunk({ type: 'progress', message: `Starting ${mode} mode query...` });
    }

    // Load files if checkbox is enabled (user explicitly requested it)
    const needsFiles = includeFiles;

    // Detect action intent
    const actionIntent = this.detectActionIntent(query);
    
    // Emit action detection
    if (onChunk && actionIntent.detected) {
      onChunk({ type: 'progress', message: `Action detected: ${actionIntent.action}` });
    }

    // Load output files if needed
    let outputFiles = null;
    if (needsFiles) {
      console.log('[QueryEngine] Loading output files...');
      if (onChunk) {
        onChunk({ type: 'progress', message: 'Scanning agent outputs and deliverables...' });
      }
      
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
      priorContext, // Pass through for follow-up queries
      onChunk // NEW (2026-01-21): Pass through streaming callback
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
