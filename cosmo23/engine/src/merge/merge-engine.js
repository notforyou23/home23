/**
 * COSMO 2.3 Merge Engine
 * Ported from Cosmo Unified merge_runs.js
 *
 * Merges multiple COSMO runs into a unified brain state with:
 * - Domain-aware embedding alignment (one-hot prefix encoding)
 * - 7 merge upgrades: adaptive thresholds, weighted similarity, merge heuristics,
 *   conflict detection, fragmentation ordering, run ID prefixing, confidence reports
 * - Full deduplication of memory nodes, goals, and journal entries
 * - Work artifact copying across 5 tiers
 * - Pre/post-merge validation
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  defaultThreshold: 0.85,
  defaultJournalLimit: 10000,
  defaultMode: 'autonomous',
  batchSize: 100,
  maxMemoryNodes: 50000, // Safety limit

  // Domain-aware embedding alignment
  // Prevents false positives when merging brains from different semantic spaces
  enableDomainAlignment: true,
  domainPrefixDimensions: 100, // One-hot vector size for domain separation (increased from 32 for large multi-domain merges)

  // UPGRADE 1: Domain-Adaptive Thresholds
  // Different domains have different semantic densities
  domainThresholds: {
    'mathematics': 0.88,      // Strict - formal concepts have precise definitions
    'physics': 0.87,          // Strict - precise technical terms
    'chemistry': 0.87,        // Strict - molecular concepts are specific
    'computer_science': 0.86, // Moderately strict - technical but evolving
    'engineering': 0.86,      // Moderately strict
    'biology': 0.84,          // Moderate - taxonomy + descriptions
    'medicine': 0.84,         // Moderate - clinical + research overlap
    'economics': 0.83,        // Moderate-loose - theories overlap
    'philosophy': 0.82,       // Looser - concepts are fluid
    'psychology': 0.82,       // Looser - theories overlap significantly
    'history': 0.81,          // Looser - interpretive overlap
    'sociology': 0.81,        // Looser - social theories overlap
    'art_music': 0.80,        // Loose - creative concepts blur
    'business': 0.83,         // Moderate - practical concepts
    'unknown': 0.85           // Default fallback
  },

  // UPGRADE 2: Weighted Cosine Similarity Parameters
  // CRITICAL FIX: Set to 1.0 to avoid overwhelming semantic similarity
  // The one-hot prefix already provides perfect separation (0.5 threshold)
  domainPrefixWeight: 1.0,    // Balanced domain separation
  semanticWeight: 1.0,        // Standard weight for semantic dimensions
};

// ============================================================================
// UPGRADE 6: Run ID Prefixing (Smarter ID Remapping)
// ============================================================================

function getRunPrefix(runName) {
  // Generate stable 6-character prefix from run name
  const hash = crypto.createHash('sha256').update(runName).digest('hex');
  return hash.slice(0, 6);
}

// ============================================================================
// State Compression (self-contained, no external dependency)
// ============================================================================

/**
 * Load state from compressed (.gz) or uncompressed JSON file
 */
async function loadCompressedState(statePath) {
  const gzPath = statePath + '.gz';

  // Try compressed first
  try {
    await fs.access(gzPath);
    const compressed = await fs.readFile(gzPath);
    const decompressed = await gunzip(compressed);
    return JSON.parse(decompressed.toString('utf8'));
  } catch (e) {
    // Fall back to uncompressed
  }

  // Try uncompressed
  const raw = await fs.readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Save state as compressed .gz file
 */
async function saveCompressedState(statePath, state) {
  const json = JSON.stringify(state);
  const compressed = await gzip(Buffer.from(json, 'utf8'));
  await fs.writeFile(statePath + '.gz', compressed);
}

// ============================================================================
// Domain-Aware Embedding Alignment
// ============================================================================

/**
 * Domain Registry
 * Maps known domains to one-hot encoding indices
 * Automatically assigns unknown domains to ensure separation
 */
class DomainRegistry {
  constructor(dimensions = 8) {
    this.dimensions = dimensions;
    this.domainToIndex = new Map();
    this.nextIndex = 0;

    // Pre-register known domains
    this.knownDomains = [
      'mathematics', 'math',
      'physics',
      'chemistry', 'chem',
      'biology', 'bio',
      'computer_science', 'cs',
      'engineering',
      'general'
    ];
  }

  /**
   * Get or create domain index for one-hot encoding
   */
  getDomainIndex(domain) {
    if (!domain || domain === 'unknown') {
      return null; // No prefix for unknown domains (backward compatible)
    }

    const normalized = domain.toLowerCase().trim();

    if (this.domainToIndex.has(normalized)) {
      return this.domainToIndex.get(normalized);
    }

    // Auto-assign next available index
    if (this.nextIndex >= this.dimensions) {
      console.warn(`[DomainRegistry] Maximum domains (${this.dimensions}) reached. Domain "${domain}" will not be separated.`);
      return null;
    }

    const index = this.nextIndex++;
    this.domainToIndex.set(normalized, index);
    return index;
  }

  /**
   * Create one-hot domain prefix vector
   */
  createDomainPrefix(domain) {
    const index = this.getDomainIndex(domain);

    if (index === null) {
      return null; // No prefix
    }

    const prefix = new Array(this.dimensions).fill(0);
    prefix[index] = 1;
    return prefix;
  }

  /**
   * Get summary of registered domains
   */
  getSummary() {
    const domains = Array.from(this.domainToIndex.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([domain, index]) => `${domain} (index ${index})`);
    return {
      count: this.domainToIndex.size,
      maxDomains: this.dimensions,
      domains
    };
  }
}

/**
 * Add domain prefix to embedding vector
 * This prevents false positives when comparing embeddings from different semantic spaces
 *
 * @param {Array<number>} embedding - Original embedding vector
 * @param {string} domain - Domain identifier
 * @param {DomainRegistry} registry - Domain registry
 * @returns {Array<number>} - Embedding with domain prefix
 */
function addDomainPrefix(embedding, domain, registry) {
  if (!embedding || !Array.isArray(embedding)) {
    return embedding;
  }

  const prefix = registry.createDomainPrefix(domain);

  if (!prefix) {
    return embedding; // No prefix, return original
  }

  // Concatenate prefix + embedding
  const prefixed = [...prefix, ...embedding];

  // Renormalize to preserve magnitude properties
  // This ensures cosine similarity still works correctly
  const magnitude = Math.sqrt(prefixed.reduce((sum, val) => sum + val * val, 0));

  if (magnitude === 0) {
    return prefixed;
  }

  return prefixed.map(val => val / magnitude);
}

/**
 * Detect domain from run metadata or run name
 *
 * @param {object} loaded - Loaded run state with metadata
 * @returns {string} - Detected domain
 */
function detectDomain(loaded) {
  // First check metadata
  if (loaded.metadata?.domain) {
    return loaded.metadata.domain;
  }

  // Try to infer from run name
  const name = (loaded.name || '').toLowerCase();
  const domainKeywords = {
    'math': 'mathematics',
    'physics': 'physics',
    'chem': 'chemistry',
    'bio': 'biology',
    'cs': 'computer_science',
    'eng': 'engineering',
    'psych': 'psychology',
    'phil': 'philosophy',
    'soc': 'sociology',
    'art': 'art_music',
    'music': 'art_music',
    'econ': 'economics',
    'bus': 'business',
    'med': 'medicine',
    'hist': 'history',
    'leg': 'legal'
  };

  for (const [keyword, domain] of Object.entries(domainKeywords)) {
    if (name.includes(keyword)) {
      return domain;
    }
  }

  // Normalize metadata domain if it exists (e.g. "Art and Music" -> "art_music")
  const metaDomain = loaded.metadata?.domain || loaded.state?.metadata?.domain;
  if (metaDomain) {
    const norm = metaDomain.toLowerCase();
    if (norm.includes('art') || norm.includes('music')) return 'art_music';
    if (norm.includes('math')) return 'mathematics';
    if (norm.includes('psych')) return 'psychology';
    if (norm.includes('physic')) return 'physics';
    if (norm.includes('business')) return 'business';
    return metaDomain.toLowerCase().replace(/\s+/g, '_');
  }

  // Default to unknown (no domain separation)
  return 'unknown';
}

// ============================================================================
// Utility Functions
// ============================================================================

class Logger {
  constructor(verbose = false) {
    this.verbose = verbose;
    this.startTime = Date.now();
  }

  info(message, data = null) {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ${message}`);
    if (data && this.verbose) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  success(message) {
    console.log(`✓ ${message}`);
  }

  error(message, error = null) {
    console.error(`✗ ${message}`);
    if (error && this.verbose) {
      console.error(error);
    }
  }

  warn(message) {
    console.warn(`⚠ ${message}`);
  }

  debug(message, data = null) {
    if (this.verbose) {
      console.log(`  ${message}`);
      if (data) {
        console.log(JSON.stringify(data, null, 2));
      }
    }
  }

  elapsed() {
    const ms = Date.now() - this.startTime;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || !Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// UPGRADE 2: Domain-Weighted Similarity
// ============================================================================

/**
 * Weighted cosine similarity that emphasizes domain prefix dimensions
 * This prevents cross-domain false merges while preserving true duplicates
 *
 * @param {Array<number>} a - First embedding vector
 * @param {Array<number>} b - Second embedding vector
 * @param {number} wDomain - Weight for domain prefix dimensions
 * @param {number} wSemantic - Weight for semantic dimensions
 * @returns {number} Weighted cosine similarity [0, 1]
 */
function weightedCosineSimilarity(a, b, wDomain = null, wSemantic = null) {
  if (!a || !b || !Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  // Use config defaults if not specified
  if (wDomain === null) wDomain = CONFIG.domainPrefixWeight;
  if (wSemantic === null) wSemantic = CONFIG.semanticWeight;

  // Domain prefix = first N dimensions
  const prefixLength = CONFIG.domainPrefixDimensions;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const weight = i < prefixLength ? wDomain : wSemantic;
    const va = a[i] * weight;
    const vb = b[i] * weight;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// UPGRADE 1: Domain-Adaptive Threshold Logic
// ============================================================================

/**
 * Calculate adaptive threshold based on domain and cluster characteristics
 *
 * @param {object} node - Node being evaluated
 * @param {Map<number, object>} clusterStats - Cluster statistics map
 * @returns {number} Adaptive threshold for this node
 */
function getAdaptiveThreshold(node, clusterStats) {
  // Base threshold from domain (normalize to lowercase for config lookup)
  const domain = (node.domain || 'unknown').toLowerCase().replace(/\s+/g, '_');
  const baseThreshold = CONFIG.domainThresholds[domain] || CONFIG.defaultThreshold;

  // Get cluster tightness (if available)
  const clusterStat = clusterStats?.get(node.cluster);
  const clusterTightness = clusterStat?.tightness || 0.5; // Default to neutral

  // Adjust based on cluster cohesion
  // Tight clusters -> raise threshold (be more strict)
  // Loose clusters -> lower threshold (be more lenient)
  // CRITICAL FIX: Increased from 0.06 to 0.20 for meaningful adjustment
  // With tightness range 0.3-0.9, this gives +/-0.10 adjustment
  const adjustment = (clusterTightness - 0.5) * 0.20; // +/-0.10

  // Clamp to safe range [0.70, 0.95]
  const adaptiveThreshold = Math.min(0.95, Math.max(0.70, baseThreshold + adjustment));

  return adaptiveThreshold;
}

// ============================================================================
// UPGRADE 3: Node-level Merge Heuristics
// ============================================================================

/**
 * Score a node for merge representative selection
 * Higher score = better representative
 * IMPROVED: Now includes cluster-level context
 *
 * @param {object} node - Node to score
 * @param {Map<number, object>} clusterStats - Cluster statistics (optional)
 * @returns {number} Representative score
 */
function scoreNodeRepresentative(node, clusterStats = null) {
  const activation = node.activation || 0;
  const accessCount = node.accessCount || 0;
  const weight = node.weight || 1;
  const degree = node.degree || 0;
  const isConsolidated = node.consolidatedAt ? 1 : 0;

  // IMPROVED: Cluster-level context
  let clusterBonus = 0;
  if (clusterStats && node.cluster !== null && node.cluster !== undefined) {
    const clusterStat = clusterStats.get(node.cluster);
    if (clusterStat) {
      // Nodes in larger clusters get a small boost (they're more central to the domain)
      const sizeBonus = Math.log10(clusterStat.size + 1) * 0.05;
      // Nodes in tighter clusters get a boost (they're more prototypical)
      const tightnessBonus = clusterStat.tightness * 0.10;
      clusterBonus = sizeBonus + tightnessBonus;
    }
  }

  // Weighted combination of node qualities
  const score =
    (activation * 0.35) +         // 35% - How much it's been used (Hebbian)
    (accessCount * 0.15) +        // 15% - Access frequency
    (weight * 0.10) +             // 10% - Intrinsic weight
    (degree * 0.10) +             // 10% - Graph centrality
    (isConsolidated * 0.15) +     // 15% - Consolidation status
    clusterBonus;                 // 15% - Cluster context (size + tightness)

  return score;
}

/**
 * Select best representative between two nodes
 *
 * @param {object} a - First node
 * @param {object} b - Second node
 * @param {Map<number, object>} clusterStats - Cluster statistics (optional)
 * @returns {object} Best representative node
 */
function selectBestRepresentative(a, b, clusterStats = null) {
  const scoreA = scoreNodeRepresentative(a, clusterStats);
  const scoreB = scoreNodeRepresentative(b, clusterStats);
  return scoreA >= scoreB ? a : b;
}

// ============================================================================
// UPGRADE 4: Cross-Run Conflict Detection
// ============================================================================

/**
 * Detect semantic conflicts between nodes (contradictory concepts)
 * IMPROVED: Uses both pattern matching AND text similarity analysis
 *
 * @param {object} a - First node
 * @param {object} b - Second node
 * @returns {boolean} True if nodes semantically conflict
 */
function detectSemanticConflict(a, b) {
  if (!a.concept || !b.concept) return false;

  const textA = a.concept.toLowerCase();
  const textB = b.concept.toLowerCase();

  // Calculate text-level similarity (Jaccard on words)
  const wordsA = new Set(textA.match(/\b\w{3,}\b/g) || []);
  const wordsB = new Set(textB.match(/\b\w{3,}\b/g) || []);
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  const textSimilarity = union.size > 0 ? intersection.size / union.size : 0;

  // Calculate embedding similarity
  const embeddingSimilarity = cosineSimilarity(a.embedding, b.embedding);

  // IMPROVED HEURISTIC: High embedding similarity + low text similarity = conflict
  // This catches cases where embeddings are close but concepts are actually contradictory
  if (embeddingSimilarity > 0.85 && textSimilarity < 0.30) {
    return true; // Different concepts with similar embeddings = likely contradictory
  }

  // Negation pattern detector (extended list)
  const negationPatterns = [
    'not ', 'no ', 'non-', 'un-', 'dis-', 'anti-',
    'without ', 'lacks ', 'absence of ', 'contra',
    'never ', 'neither ', 'nor ', 'deny', 'denies'
  ];

  const hasNegA = negationPatterns.some(pattern => textA.includes(pattern));
  const hasNegB = negationPatterns.some(pattern => textB.includes(pattern));

  // If one is negated and the other isn't, but they're similar -> conflict
  if (hasNegA !== hasNegB) {
    if (embeddingSimilarity > 0.78 || textSimilarity > 0.50) {
      return true; // Likely contradictory concepts
    }
  }

  // Antonym detection (expanded list - 44 pairs)
  const antonymPairs = [
    ['increase', 'decrease'], ['positive', 'negative'], ['true', 'false'],
    ['good', 'bad'], ['up', 'down'], ['hot', 'cold'], ['fast', 'slow'],
    ['success', 'failure'], ['growth', 'decline'], ['expand', 'contract'],
    ['accept', 'reject'], ['add', 'subtract'], ['agree', 'disagree'],
    ['alive', 'dead'], ['begin', 'end'], ['best', 'worst'],
    ['big', 'small'], ['buy', 'sell'], ['cheap', 'expensive'],
    ['clean', 'dirty'], ['close', 'open'], ['create', 'destroy'],
    ['dark', 'light'], ['deep', 'shallow'], ['easy', 'difficult'],
    ['empty', 'full'], ['enter', 'exit'], ['forward', 'backward'],
    ['gain', 'loss'], ['give', 'take'], ['happy', 'sad'],
    ['high', 'low'], ['include', 'exclude'], ['inside', 'outside'],
    ['left', 'right'], ['love', 'hate'], ['many', 'few'],
    ['more', 'less'], ['new', 'old'], ['on', 'off'],
    ['pull', 'push'], ['raise', 'lower'], ['right', 'wrong'],
    ['rise', 'fall'], ['same', 'different'], ['start', 'stop'],
    ['strong', 'weak'], ['top', 'bottom'], ['win', 'lose']
  ];

  for (const [word1, word2] of antonymPairs) {
    if ((textA.includes(word1) && textB.includes(word2)) ||
        (textA.includes(word2) && textB.includes(word1))) {
      if (embeddingSimilarity > 0.72 || textSimilarity > 0.40) {
        return true; // Antonyms with high similarity = conflict
      }
    }
  }

  return false;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ============================================================================
// Progress Reporter
// ============================================================================

class ProgressReporter {
  constructor(logger) {
    this.logger = logger;
    this.phases = [
      'Discovering runs',
      'Loading states',
      'Validating compatibility',
      'Merging memory networks',
      'Consolidating goals',
      'Merging journals',
      'Validating merged state',
      'Saving merged run',
      'Generating report'
    ];
    this.currentPhase = 0;
    this.phaseProgress = 0;
    this.startTime = Date.now();
  }

  startPhase(phaseIndex, message = null) {
    this.currentPhase = phaseIndex;
    this.phaseProgress = 0;
    const phaseName = this.phases[phaseIndex] || 'Processing';
    this.logger.info(`\n[${ phaseIndex + 1}/${this.phases.length}] ${message || phaseName}...`);
  }

  updateProgress(current, total, details = '') {
    this.phaseProgress = current / total;
    const percent = Math.floor((current / total) * 100);
    const bar = this.renderProgressBar(current, total);
    process.stdout.write(`\r  ${bar} ${percent}% ${details}`);
    if (current === total) {
      process.stdout.write('\n');
    }
  }

  renderProgressBar(current, total, width = 40) {
    const filled = Math.floor((current / total) * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  complete() {
    const elapsed = this.logger.elapsed();
    this.logger.info(`\n✓ Merge completed successfully in ${elapsed}`);
  }
}

// ============================================================================
// State Loader
// ============================================================================

class StateLoader {
  constructor(logger, runsDir) {
    this.logger = logger;
    this.runsDir = runsDir;
  }

  async discoverRuns() {
    try {
      const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
      const runs = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const runPath = path.join(this.runsDir, entry.name);
        const statePath = path.join(runPath, 'state.json');

        // Check if state file exists (compressed or uncompressed)
        const hasState = await fs.access(statePath + '.gz').then(() => true).catch(() =>
          fs.access(statePath).then(() => true).catch(() => false)
        );

        if (!hasState) continue;

        // Try to load metadata
        let metadata = {};
        try {
          const metadataPath = path.join(runPath, 'run-metadata.json');
          const metadataStr = await fs.readFile(metadataPath, 'utf8');
          metadata = JSON.parse(metadataStr);
        } catch (e) {
          // Metadata optional
        }

        // Get directory size
        let size = 0;
        try {
          const stats = await fs.stat(statePath + '.gz').catch(() => fs.stat(statePath));
          size = stats.size;
        } catch (e) {
          // Ignore size errors
        }

        runs.push({
          name: entry.name,
          path: runPath,
          metadata,
          size
        });
      }

      return runs.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      this.logger.error('Failed to discover runs', error);
      throw error;
    }
  }

  async loadState(runName) {
    const runPath = path.join(this.runsDir, runName);
    const statePath = path.join(runPath, 'state.json');

    try {
      this.logger.debug(`Loading state from ${runName}...`);
      const state = await loadCompressedState(statePath);

      // Load metadata
      let metadata = {};
      try {
        const metadataPath = path.join(runPath, 'run-metadata.json');
        const metadataStr = await fs.readFile(metadataPath, 'utf8');
        metadata = JSON.parse(metadataStr);
      } catch (e) {
        // Metadata optional
      }

      return {
        name: runName,
        path: runPath,
        state,
        metadata,
        valid: true,
        errors: []
      };
    } catch (error) {
      this.logger.error(`Failed to load state from ${runName}`, error);
      return {
        name: runName,
        path: runPath,
        state: null,
        metadata: {},
        valid: false,
        errors: [error.message]
      };
    }
  }

  async loadMultiple(runNames) {
    const loaded = [];

    for (const runName of runNames) {
      const result = await this.loadState(runName);
      loaded.push(result);
    }

    return loaded;
  }
}

// ============================================================================
// Validation Engine
// ============================================================================

class ValidationEngine {
  constructor(logger) {
    this.logger = logger;
  }

  validatePreMerge(loadedStates) {
    const errors = [];
    const warnings = [];

    // Check all states loaded successfully
    const failed = loadedStates.filter(s => !s.valid);
    if (failed.length > 0) {
      errors.push(`Failed to load ${failed.length} run(s): ${failed.map(s => s.name).join(', ')}`);
    }

    const validStates = loadedStates.filter(s => s.valid);
    if (validStates.length < 2) {
      errors.push('Need at least 2 valid runs to merge');
    }

    // Check embedding dimensions match
    const dimensions = new Set();
    for (const loaded of validStates) {
      const nodes = loaded.state?.memory?.nodes || [];
      for (const node of nodes.slice(0, 5)) { // Check first 5
        if (node.embedding && Array.isArray(node.embedding)) {
          dimensions.add(node.embedding.length);
        }
      }
    }

    if (dimensions.size > 1) {
      warnings.push(`Inconsistent embedding dimensions: ${Array.from(dimensions).join(', ')}. Will use first run's dimensions.`);
    }

    // Check for corrupted embeddings
    for (const loaded of validStates) {
      const nodes = loaded.state?.memory?.nodes || [];
      const corrupted = nodes.filter(n => {
        if (!n.embedding || !Array.isArray(n.embedding)) return true;
        return n.embedding.some(v => typeof v !== 'number' || isNaN(v));
      });

      if (corrupted.length > 0) {
        warnings.push(`Run ${loaded.name} has ${corrupted.length} nodes with invalid embeddings (will skip)`);
      }
    }

    // Check total size
    const totalNodes = validStates.reduce((sum, s) =>
      sum + (s.state?.memory?.nodes?.length || 0), 0
    );

    if (totalNodes > CONFIG.maxMemoryNodes) {
      warnings.push(`Total nodes (${formatNumber(totalNodes)}) exceeds recommended limit (${formatNumber(CONFIG.maxMemoryNodes)}). Merge may be slow.`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      stats: {
        totalRuns: loadedStates.length,
        validRuns: validStates.length,
        totalNodes,
        dimensions: Array.from(dimensions)
      }
    };
  }

  validatePostMerge(mergedState) {
    const errors = [];
    const warnings = [];

    // Check required fields exist
    if (!mergedState.memory || !mergedState.memory.nodes) {
      errors.push('Merged state missing memory.nodes');
    }
    if (!mergedState.goals) {
      errors.push('Merged state missing goals');
    }

    // Check node IDs are unique
    const nodeIds = new Set();
    const duplicateIds = [];
    for (const node of mergedState.memory?.nodes || []) {
      if (nodeIds.has(node.id)) {
        duplicateIds.push(node.id);
      }
      nodeIds.add(node.id);
    }
    if (duplicateIds.length > 0) {
      errors.push(`Duplicate node IDs found: ${duplicateIds.slice(0, 5).join(', ')}`);
    }

    // Check edges reference valid nodes
    const invalidEdges = [];
    for (const edge of mergedState.memory?.edges || []) {
      let from, to;
      if (edge.key) {
        [from, to] = edge.key.split('->').map(Number);
      } else if (edge.source !== undefined && edge.target !== undefined) {
        from = edge.source;
        to = edge.target;
      } else {
        invalidEdges.push('unknown_format');
        continue;
      }

      if (!nodeIds.has(from) || !nodeIds.has(to)) {
        invalidEdges.push(`${from}->${to}`);
      }
    }
    if (invalidEdges.length > 0) {
      warnings.push(`${invalidEdges.length} edges reference invalid nodes (will be cleaned)`);
    }

    // Check embeddings valid
    let invalidEmbeddings = 0;
    for (const node of mergedState.memory?.nodes || []) {
      if (!node.embedding || !Array.isArray(node.embedding)) {
        invalidEmbeddings++;
      } else if (node.embedding.some(v => typeof v !== 'number' || isNaN(v))) {
        invalidEmbeddings++;
      }
    }
    if (invalidEmbeddings > 0) {
      errors.push(`${invalidEmbeddings} nodes have invalid embeddings`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}

// ============================================================================
// Memory Merger
// ============================================================================

class MemoryMerger {
  constructor(logger, options = {}, domainRegistry = null) {
    this.logger = logger;
    this.threshold = options.threshold || CONFIG.defaultThreshold;
    this.batchSize = options.batchSize || CONFIG.batchSize;
    this.domainRegistry = domainRegistry;
    this.domainAlignmentEnabled = CONFIG.enableDomainAlignment && domainRegistry;
  }

  async merge(loadedStates, progressReporter) {
    const validStates = loadedStates.filter(s => s.valid);

    // Detect domains for each run and apply embedding alignment
    const domainStats = new Map(); // Track nodes per domain
    let alignedNodeCount = 0;

    if (this.domainAlignmentEnabled) {
      this.logger.info('Domain-aware embedding alignment enabled');

      for (const loaded of validStates) {
        const domain = detectDomain(loaded);
        this.logger.info(`  ${loaded.name}: domain="${domain}"`);

        if (!domainStats.has(domain)) {
          domainStats.set(domain, 0);
        }
      }
    }

    // UPGRADE: Compute degree centrality across all runs first
    this.logger.info('Computing graph topology...');
    const degreeMap = this.computeDegreeCentrality(validStates);

    // UPGRADE: Compute cluster statistics for adaptive thresholds
    this.logger.info('Computing cluster statistics...');
    const clusterStats = this.computeClusterStatistics(validStates);

    // Collect all nodes from all runs
    const allNodes = [];

    for (const loaded of validStates) {
      const domain = this.domainAlignmentEnabled ? detectDomain(loaded) : 'unknown';
      const nodes = loaded.state?.memory?.nodes || [];

      for (const node of nodes) {
        // Skip nodes without valid embeddings
        if (!node.embedding || !Array.isArray(node.embedding)) continue;
        if (node.embedding.some(v => typeof v !== 'number' || isNaN(v))) continue;

        // Apply domain-aware embedding alignment
        let embedding = node.embedding;
        if (this.domainAlignmentEnabled && domain !== 'unknown') {
          embedding = addDomainPrefix(node.embedding, domain, this.domainRegistry);
          alignedNodeCount++;
          domainStats.set(domain, (domainStats.get(domain) || 0) + 1);
        }

        // UPGRADE: Add degree centrality to node
        const degreeKey = `${loaded.name}:${node.id}`;
        const degree = degreeMap.get(degreeKey) || 0;

        allNodes.push({
          ...node,
          embedding, // Use domain-aligned embedding
          originalEmbedding: node.embedding, // Preserve original for debugging
          domain, // Track domain for metadata
          sourceRun: loaded.name,
          originalId: node.id,  // Preserve original ID for edge mapping
          degree  // UPGRADE: Include degree centrality
        });
      }
    }

    this.logger.info(`Collected ${formatNumber(allNodes.length)} nodes from ${validStates.length} runs`);

    if (this.domainAlignmentEnabled && alignedNodeCount > 0) {
      this.logger.info(`Domain alignment applied to ${formatNumber(alignedNodeCount)} nodes across ${domainStats.size} domain(s)`);

      // Log domain distribution
      const domainDistribution = Array.from(domainStats.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([domain, count]) => `  ${domain}: ${formatNumber(count)} nodes`)
        .join('\n');

      this.logger.info('Domain distribution:\n' + domainDistribution);

      // Log domain registry summary
      const registrySummary = this.domainRegistry.getSummary();
      this.logger.debug('Domain registry:', registrySummary);
    }

    // ========================================================================
    // UPGRADE 5: Fragmentation-Aware Merge Ordering
    // ========================================================================
    // Sort nodes for deterministic, robust merging:
    // 1. High degree first (graph hubs)
    // 2. High activation (frequently used)
    // 3. Consolidated nodes first (already processed)
    this.logger.info('Sorting nodes for optimal merge order...');
    allNodes.sort((a, b) =>
      (b.degree - a.degree) ||
      ((b.activation || 0) - (a.activation || 0)) ||
      ((b.consolidatedAt ? 1 : 0) - (a.consolidatedAt ? 1 : 0))
    );

    // Deduplicate nodes
    const mergedNodes = [];
    const duplicates = [];
    // Use compound key: "runName:nodeId" -> new ID to handle ID collisions across runs
    const idMapping = new Map();

    progressReporter.startPhase(3, 'Merging memory networks');

    // Track optimization statistics
    let sameClusterChecks = 0;
    let crossClusterChecks = 0;
    let sameClusterMatches = 0;
    let crossClusterMatches = 0;

    // UPGRADE 7: Confidence heatmap data
    const confidenceData = {
      mergedPairs: [],
      rejectedPairs: [],
      conflictsPrevented: 0,
      adaptiveThresholdUsage: new Map()
    };

    for (let i = 0; i < allNodes.length; i++) {
      const node = allNodes[i];

      // UPGRADE 1: Calculate adaptive threshold for this node
      const adaptiveThreshold = getAdaptiveThreshold(node, clusterStats);
      const thresholdKey = adaptiveThreshold.toFixed(2);
      confidenceData.adaptiveThresholdUsage.set(
        thresholdKey,
        (confidenceData.adaptiveThresholdUsage.get(thresholdKey) || 0) + 1
      );

      // Check against already merged nodes
      let isDuplicate = false;
      let matchedNode = null;
      let matchSimilarity = 0;

      // OPTIMIZATION: Check same-cluster nodes first (most likely to match)
      // Nodes in the same cluster are semantically related, so duplicates are more likely there
      // MICRO-FIX: Only trust cluster metadata if cluster is meaningful (size >= 10)
      const nodeCluster = node.cluster;
      const clusterStat = clusterStats?.get(nodeCluster);
      const clusterIsMeaningful = clusterStat && clusterStat.size >= 10;

      if (nodeCluster !== null && nodeCluster !== undefined && clusterIsMeaningful) {
        for (const merged of mergedNodes) {
          if (merged.cluster !== nodeCluster) continue; // Skip different clusters

          sameClusterChecks++;

          // UPGRADE 4: Check for semantic conflicts
          if (detectSemanticConflict(node, merged)) {
            confidenceData.conflictsPrevented++;
            continue; // Skip this potential merge
          }

          // UPGRADE 2: Use weighted cosine similarity
          const similarity = weightedCosineSimilarity(node.embedding, merged.embedding);

          // UPGRADE 1: Use adaptive threshold
          if (similarity >= adaptiveThreshold) {
            isDuplicate = true;
            matchedNode = merged;
            matchSimilarity = similarity;
            sameClusterMatches++;
            break; // Found match, stop searching
          } else if (similarity >= 0.75) {
            // Track near-misses for confidence analysis
            confidenceData.rejectedPairs.push({
              similarity,
              threshold: adaptiveThreshold,
              reason: 'below_threshold',
              concepts: [node.concept, merged.concept]
            });
          }
        }
      }

      // If no match in same cluster, check cross-cluster nodes
      // This preserves the ability to find duplicates across clusters
      if (!isDuplicate) {
        for (const merged of mergedNodes) {
          // Skip nodes we already checked in same-cluster pass
          // MICRO-FIX: Only skip if cluster was meaningful in first pass
          if (nodeCluster !== null && nodeCluster !== undefined && clusterIsMeaningful && merged.cluster === nodeCluster) {
            continue;
          }

          crossClusterChecks++;

          // UPGRADE 4: Check for semantic conflicts
          if (detectSemanticConflict(node, merged)) {
            confidenceData.conflictsPrevented++;
            continue; // Skip this potential merge
          }

          // UPGRADE 2: Use weighted cosine similarity
          const similarity = weightedCosineSimilarity(node.embedding, merged.embedding);

          // UPGRADE 1: Use adaptive threshold
          if (similarity >= adaptiveThreshold) {
            isDuplicate = true;
            matchedNode = merged;
            matchSimilarity = similarity;
            crossClusterMatches++;
            break; // Found match, stop searching
          } else if (similarity >= 0.75) {
            // Track near-misses for confidence analysis
            confidenceData.rejectedPairs.push({
              similarity,
              threshold: adaptiveThreshold,
              reason: 'below_threshold',
              concepts: [node.concept, merged.concept]
            });
          }
        }
      }

      // If duplicate found, update the merged node
      if (isDuplicate && matchedNode) {
        duplicates.push({
          original: node,
          duplicate: matchedNode,
          similarity: matchSimilarity
        });

        // UPGRADE 7: Track merge confidence data
        confidenceData.mergedPairs.push({
          similarity: matchSimilarity,
          threshold: adaptiveThreshold,
          domain: node.domain,
          cluster: node.cluster,
          concepts: [node.concept, matchedNode.concept]
        });

        // CRITICAL: Map old ID to existing merged ID so edges can be remapped
        // Use compound key to avoid ID collisions across runs
        const compoundKey = `${node.sourceRun}:${node.originalId}`;
        idMapping.set(compoundKey, matchedNode.id);

        // UPGRADE 3: Use intelligent merge selection with cluster context
        const bestRep = selectBestRepresentative(node, matchedNode, clusterStats);

        // Update merged node with best representative's primary attributes
        if (bestRep === node) {
          // New node is better - update concept and embedding
          matchedNode.concept = node.concept;
          matchedNode.embedding = node.embedding;
          matchedNode.originalEmbedding = node.originalEmbedding;
          matchedNode.tag = node.tag;
        }

        // Aggregate numeric values regardless of which is better
        matchedNode.activation = Math.max(matchedNode.activation || 0, node.activation || 0);
        matchedNode.weight = Math.max(matchedNode.weight || 1, node.weight || 1);
        matchedNode.accessCount = (matchedNode.accessCount || 0) + (node.accessCount || 0);
        // CRITICAL FIX: Sum degrees (not max) - both nodes' connections matter
        matchedNode.degree = (matchedNode.degree || 0) + (node.degree || 0);

        // Track source runs
        if (!matchedNode.sourceRuns) {
          matchedNode.sourceRuns = [matchedNode.sourceRun];
        }
        if (!matchedNode.sourceRuns.includes(node.sourceRun)) {
          matchedNode.sourceRuns.push(node.sourceRun);
        }
      }

      if (!isDuplicate) {
        // CRITICAL FIX: Use prefix-coded IDs for provenance
        const runPrefix = getRunPrefix(node.sourceRun);
        const newId = `${runPrefix}_${mergedNodes.length + 1}`;
        const compoundKey = `${node.sourceRun}:${node.originalId}`;
        idMapping.set(compoundKey, newId);

        mergedNodes.push({
          ...node,
          id: newId,
          sourceRuns: [node.sourceRun],
          runPrefix  // Store prefix for debugging
        });
      }

      // Update progress
      if (i % 10 === 0 || i === allNodes.length - 1) {
        progressReporter.updateProgress(i + 1, allNodes.length,
          `(${formatNumber(duplicates.length)} duplicates found)`);
      }
    }

    // Log optimization statistics
    const totalChecks = sameClusterChecks + crossClusterChecks;
    const totalMatches = sameClusterMatches + crossClusterMatches;

    this.logger.info('Merge optimization statistics:', {
      sameClusterChecks: formatNumber(sameClusterChecks),
      crossClusterChecks: formatNumber(crossClusterChecks),
      totalChecks: formatNumber(totalChecks),
      sameClusterMatches: formatNumber(sameClusterMatches),
      crossClusterMatches: formatNumber(crossClusterMatches),
      totalMatches: formatNumber(totalMatches),
      checksAvoided: totalChecks > 0
        ? `${((1 - totalChecks / (allNodes.length * mergedNodes.length / 2)) * 100).toFixed(1)}%`
        : 'N/A'
    });

    this.logger.success(`Merged to ${formatNumber(mergedNodes.length)} unique nodes (removed ${formatNumber(duplicates.length)} duplicates)`);

    // Merge edges
    const mergedEdges = await this.mergeEdges(validStates, idMapping, progressReporter);

    // UPGRADE 7: Generate confidence heatmap statistics
    const confidenceReport = this.generateConfidenceReport(confidenceData, duplicates);

    return {
      nodes: mergedNodes,
      edges: mergedEdges,
      duplicates: duplicates.length,
      idMapping,
      confidenceReport  // UPGRADE 7: Include confidence analysis
    };
  }

  /**
   * UPGRADE: Compute degree centrality for all nodes across all runs
   */
  computeDegreeCentrality(validStates) {
    const degreeMap = new Map();

    for (const loaded of validStates) {
      const nodes = loaded.state?.memory?.nodes || [];
      const edges = loaded.state?.memory?.edges || [];
      const runName = loaded.name;

      // Initialize all nodes
      for (const node of nodes) {
        const key = `${runName}:${node.id}`;
        degreeMap.set(key, 0);
      }

      // Count degree
      for (const edge of edges) {
        let from, to;
        if (edge.key) {
          [from, to] = edge.key.split('->').map(Number);
        } else if (edge.source !== undefined && edge.target !== undefined) {
          from = edge.source;
          to = edge.target;
        } else {
          continue;
        }

        if (from == null || to == null) continue;

        const fromKey = `${runName}:${from}`;
        const toKey = `${runName}:${to}`;

        if (degreeMap.has(fromKey)) {
          degreeMap.set(fromKey, degreeMap.get(fromKey) + 1);
        }
        if (degreeMap.has(toKey)) {
          degreeMap.set(toKey, degreeMap.get(toKey) + 1);
        }
      }
    }

    return degreeMap;
  }

  /**
   * UPGRADE: Compute cluster statistics for adaptive threshold calculation
   */
  computeClusterStatistics(validStates) {
    const clusterStats = new Map();

    for (const loaded of validStates) {
      const nodes = loaded.state?.memory?.nodes || [];

      // Group nodes by cluster
      const clusterGroups = new Map();
      for (const node of nodes) {
        const clusterId = node.cluster;
        if (clusterId === null || clusterId === undefined) continue;

        if (!clusterGroups.has(clusterId)) {
          clusterGroups.set(clusterId, []);
        }
        clusterGroups.get(clusterId).push(node);
      }

      // Compute tightness (average intra-cluster similarity) for each cluster
      for (const [clusterId, clusterNodes] of clusterGroups.entries()) {
        if (clusterNodes.length < 2) {
          // Single-node clusters are perfectly tight
          clusterStats.set(clusterId, { size: 1, tightness: 1.0 });
          continue;
        }

        // Sample-based tightness calculation (for performance)
        const sampleSize = Math.min(20, clusterNodes.length);
        let totalSim = 0;
        let comparisons = 0;

        for (let i = 0; i < sampleSize; i++) {
          const nodeA = clusterNodes[Math.floor(Math.random() * clusterNodes.length)];
          if (!nodeA.embedding || !Array.isArray(nodeA.embedding)) continue;

          for (let j = i + 1; j < sampleSize; j++) {
            const nodeB = clusterNodes[Math.floor(Math.random() * clusterNodes.length)];
            if (!nodeB.embedding || !Array.isArray(nodeB.embedding)) continue;

            const sim = cosineSimilarity(nodeA.embedding, nodeB.embedding);
            totalSim += sim;
            comparisons++;
          }
        }

        const tightness = comparisons > 0 ? totalSim / comparisons : 0.5;
        clusterStats.set(clusterId, {
          size: clusterNodes.length,
          tightness: Math.min(1.0, Math.max(0.0, tightness))
        });
      }
    }

    return clusterStats;
  }

  /**
   * UPGRADE 7: Generate confidence report from merge data
   * IMPROVED: Now includes threshold sensitivity analysis
   */
  generateConfidenceReport(confidenceData, duplicates) {
    // Similarity score histogram
    const similarityBuckets = new Array(21).fill(0); // 0.00-0.05, 0.05-0.10, ..., 0.95-1.00
    for (const pair of confidenceData.mergedPairs) {
      const bucket = Math.min(20, Math.floor(pair.similarity * 20));
      similarityBuckets[bucket]++;
    }

    // Rejected similarity histogram
    const rejectedBuckets = new Array(21).fill(0);
    for (const pair of confidenceData.rejectedPairs.slice(0, 1000)) { // Sample for performance
      const bucket = Math.min(20, Math.floor(pair.similarity * 20));
      rejectedBuckets[bucket]++;
    }

    // Adaptive threshold distribution
    const thresholdDistribution = Array.from(confidenceData.adaptiveThresholdUsage.entries())
      .map(([threshold, count]) => ({ threshold: parseFloat(threshold), count }))
      .sort((a, b) => a.threshold - b.threshold);

    // Domain-wise merge statistics
    const domainMergeStats = new Map();
    for (const pair of confidenceData.mergedPairs) {
      const domain = pair.domain || 'unknown';
      if (!domainMergeStats.has(domain)) {
        domainMergeStats.set(domain, { count: 0, avgSimilarity: 0, totalSim: 0 });
      }
      const stat = domainMergeStats.get(domain);
      stat.count++;
      stat.totalSim += pair.similarity;
      stat.avgSimilarity = stat.totalSim / stat.count;
    }

    // IMPROVED: Threshold sensitivity analysis
    // How many merges would flip if threshold was adjusted +/-0.02?
    const thresholdSensitivity = {
      wouldMergeAtMinus002: 0,  // Currently rejected, would merge at -0.02
      wouldMergeAtMinus005: 0,  // Currently rejected, would merge at -0.05
      wouldRejectAtPlus002: 0,  // Currently merged, would reject at +0.02
      wouldRejectAtPlus005: 0   // Currently merged, would reject at +0.05
    };

    for (const pair of confidenceData.rejectedPairs) {
      const diff = pair.threshold - pair.similarity;
      if (diff <= 0.02) thresholdSensitivity.wouldMergeAtMinus002++;
      if (diff <= 0.05) thresholdSensitivity.wouldMergeAtMinus005++;
    }

    for (const pair of confidenceData.mergedPairs) {
      const diff = pair.similarity - pair.threshold;
      if (diff <= 0.02) thresholdSensitivity.wouldRejectAtPlus002++;
      if (diff <= 0.05) thresholdSensitivity.wouldRejectAtPlus005++;
    }

    // IMPROVED: Merge order stability
    // Track distribution of similarity scores to detect clustering
    const similarityValues = confidenceData.mergedPairs.map(p => p.similarity).sort((a, b) => b - a);
    const medianSimilarity = similarityValues.length > 0
      ? similarityValues[Math.floor(similarityValues.length / 2)]
      : 0;
    const avgSimilarity = similarityValues.length > 0
      ? similarityValues.reduce((sum, s) => sum + s, 0) / similarityValues.length
      : 0;

    return {
      totalMerged: confidenceData.mergedPairs.length,
      totalRejected: confidenceData.rejectedPairs.length,
      conflictsPrevented: confidenceData.conflictsPrevented,
      similarityHistogram: similarityBuckets.map((count, i) => ({
        range: `${(i * 0.05).toFixed(2)}-${((i + 1) * 0.05).toFixed(2)}`,
        count
      })),
      rejectedHistogram: rejectedBuckets.map((count, i) => ({
        range: `${(i * 0.05).toFixed(2)}-${((i + 1) * 0.05).toFixed(2)}`,
        count
      })),
      thresholdDistribution,
      thresholdSensitivity,  // NEW: Sensitivity analysis
      mergeStability: {      // NEW: Merge order stability metrics
        medianSimilarity: Number(medianSimilarity.toFixed(4)),
        avgSimilarity: Number(avgSimilarity.toFixed(4)),
        totalPairs: similarityValues.length
      },
      domainStats: Array.from(domainMergeStats.entries()).map(([domain, stats]) => ({
        domain,
        mergeCount: stats.count,
        avgSimilarity: Number(stats.avgSimilarity.toFixed(4))
      }))
    };
  }

  async mergeEdges(validStates, idMapping, progressReporter) {
    const edgeMap = new Map(); // "fromId->toId" -> edge data
    let skippedEdges = 0;
    let totalEdges = 0;

    for (const loaded of validStates) {
      const edges = loaded.state?.memory?.edges || [];
      const runName = loaded.name;

      for (const edge of edges) {
        totalEdges++;

        // Parse edge - handle both formats
        let fromOld, toOld;
        if (edge.key) {
          // Format: {key: "1->2", ...}
          [fromOld, toOld] = edge.key.split('->').map(Number);
        } else if (edge.source !== undefined && edge.target !== undefined) {
          // Format: {source: 1, target: 2, ...}
          fromOld = edge.source;
          toOld = edge.target;
        } else {
          // Unknown format, skip
          skippedEdges++;
          continue;
        }

        // Skip self-loops with null or undefined
        if (fromOld === null || fromOld === undefined || toOld === null || toOld === undefined) {
          skippedEdges++;
          continue;
        }

        // Map to new IDs using compound key to handle ID collisions
        const fromKey = `${runName}:${fromOld}`;
        const toKey = `${runName}:${toOld}`;
        const fromNew = idMapping.get(fromKey);
        const toNew = idMapping.get(toKey);

        // Skip if either node was filtered out or mapping failed
        if (!fromNew || !toNew) {
          skippedEdges++;
          continue;
        }

        // CRITICAL FIX: Skip self-loops (prevent exponential accumulation)
        if (fromNew === toNew) {
          skippedEdges++;
          continue;
        }

        const newKey = `${fromNew}->${toNew}`;

        if (edgeMap.has(newKey)) {
          // Sum weights for duplicate edges (capped at 1.0)
          const existing = edgeMap.get(newKey);
          existing.weight = Math.min(1.0, (existing.weight || 0) + (edge.weight || 0));
          if (edge.accessed) {
            existing.accessed = new Date(Math.max(
              new Date(existing.accessed || 0).getTime(),
              new Date(edge.accessed || 0).getTime()
            ));
          }
        } else {
          edgeMap.set(newKey, {
            source: fromNew,
            target: toNew,
            weight: Math.min(1.0, edge.weight || 0),  // CRITICAL FIX: Cap at 1.0
            type: edge.type || 'associative',
            created: edge.created || new Date().toISOString(),
            accessed: edge.accessed || new Date().toISOString()
          });
        }
      }
    }

    this.logger.info(`Edge merge: ${totalEdges} source edges → ${edgeMap.size} merged (${skippedEdges} removed/invalid)`);

    return Array.from(edgeMap.values());
  }
}

// ============================================================================
// Goal Merger
// ============================================================================

class GoalMerger {
  constructor(logger) {
    this.logger = logger;
  }

  async merge(loadedStates, progressReporter) {
    progressReporter.startPhase(4, 'Consolidating goals');

    const validStates = loadedStates.filter(s => s.valid);
    const allGoals = [];

    // Collect all goals - handle both array and object formats
    for (const loaded of validStates) {
      const goalsData = loaded.state?.goals;

      if (!goalsData) continue;

      if (Array.isArray(goalsData)) {
        // Array format
        for (const goal of goalsData) {
          allGoals.push({
            ...goal,
            sourceRun: loaded.name
          });
        }
      } else if (typeof goalsData === 'object') {
        // Object format with active/completed/etc arrays
        for (const category of ['active', 'completed', 'archived', 'satisfied']) {
          const categoryGoals = goalsData[category] || [];
          for (const item of categoryGoals) {
            // Handle both tuple format [id, goal] and direct goal format
            const goal = Array.isArray(item) ? item[1] : item;
            if (goal && typeof goal === 'object') {
              allGoals.push({
                ...goal,
                sourceRun: loaded.name
              });
            }
          }
        }
      }
    }

    this.logger.info(`Collected ${allGoals.length} goals from ${validStates.length} runs`);

    // Simple text-based deduplication (similar to intrinsic-goals.js)
    const merged = [];
    const duplicates = [];

    for (let i = 0; i < allGoals.length; i++) {
      const goal = allGoals[i];

      let isDuplicate = false;
      for (const mergedGoal of merged) {
        const similarity = this.goalSimilarity(goal.concept || goal.description || '',
                                                mergedGoal.concept || mergedGoal.description || '');

        if (similarity >= 0.8) {
          isDuplicate = true;
          duplicates.push(goal);

          // Keep best values
          mergedGoal.priority = Math.max(mergedGoal.priority || 0, goal.priority || 0);
          mergedGoal.progress = Math.max(mergedGoal.progress || 0, goal.progress || 0);

          // Track source runs
          if (!mergedGoal.sourceRuns) {
            mergedGoal.sourceRuns = [mergedGoal.sourceRun];
          }
          if (!mergedGoal.sourceRuns.includes(goal.sourceRun)) {
            mergedGoal.sourceRuns.push(goal.sourceRun);
          }

          break;
        }
      }

      if (!isDuplicate) {
        merged.push({
          ...goal,
          id: `goal_${merged.length + 1}`,
          pursuitCount: 0, // Reset for fresh start
          sourceRuns: [goal.sourceRun]
        });
      }

      progressReporter.updateProgress(i + 1, allGoals.length);
    }

    this.logger.success(`Merged to ${merged.length} unique goals (removed ${duplicates.length} duplicates)`);

    return {
      goals: merged,
      duplicates: duplicates.length
    };
  }

  goalSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const words2 = new Set(text2.toLowerCase().match(/\b\w{4,}\b/g) || []);

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }
}

// ============================================================================
// Journal Merger
// ============================================================================

class JournalMerger {
  constructor(logger, options = {}) {
    this.logger = logger;
    this.limit = options.journalLimit || CONFIG.defaultJournalLimit;
  }

  async merge(loadedStates, progressReporter) {
    progressReporter.startPhase(5, 'Merging journals');

    const validStates = loadedStates.filter(s => s.valid);
    const allThoughts = [];

    // Collect all journal entries
    for (const loaded of validStates) {
      const journal = loaded.state?.journal || [];
      const thoughts = loaded.state?.thoughtHistory || [];

      // Merge journal and thoughtHistory
      const combined = [...journal, ...thoughts];

      for (const entry of combined) {
        allThoughts.push({
          ...entry,
          sourceRun: loaded.name,
          originalCycle: entry.cycle || 0,
          cycle: 0 // Reset for merged run
        });
      }
    }

    this.logger.info(`Collected ${formatNumber(allThoughts.length)} journal entries`);

    // Sort chronologically
    allThoughts.sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeA - timeB;
    });

    // Limit size
    let final = allThoughts;
    if (allThoughts.length > this.limit) {
      this.logger.warn(`Journal size (${formatNumber(allThoughts.length)}) exceeds limit (${formatNumber(this.limit)}). Keeping most recent.`);
      final = allThoughts.slice(-this.limit);
    }

    progressReporter.updateProgress(1, 1);
    this.logger.success(`Merged ${formatNumber(final.length)} journal entries`);

    return final;
  }
}

// ============================================================================
// Merge Engine (Orchestrator)
// ============================================================================

class MergeEngine {
  constructor(options = {}) {
    this.logger = new Logger(options.verbose);
    this.options = options;

    // COSMO 2.3 adaptation: accept runsPath as constructor parameter
    this.runsPath = options.runsPath || options.runsDir || null;

    this.stateLoader = new StateLoader(this.logger, this.runsPath);
    this.validator = new ValidationEngine(this.logger);

    // Initialize domain registry for embedding alignment (if enabled)
    const domainAlignmentEnabled = options.domainAlignment !== undefined
      ? options.domainAlignment
      : CONFIG.enableDomainAlignment;

    this.domainRegistry = domainAlignmentEnabled
      ? new DomainRegistry(CONFIG.domainPrefixDimensions)
      : null;

    this.memoryMerger = new MemoryMerger(this.logger, options, this.domainRegistry);
    this.goalMerger = new GoalMerger(this.logger);
    this.journalMerger = new JournalMerger(this.logger, options);
    this.progressReporter = new ProgressReporter(this.logger);
  }

  async execute(runNames, outputName) {
    try {
      // Phase 1: Load states
      this.progressReporter.startPhase(1, 'Loading states');
      const loadedStates = await this.stateLoader.loadMultiple(runNames);
      this.logger.success(`Loaded ${loadedStates.length} run states`);

      // Phase 2: Validate
      this.progressReporter.startPhase(2, 'Validating compatibility');
      const preValidation = this.validator.validatePreMerge(loadedStates);

      if (!preValidation.valid) {
        this.logger.error('Pre-merge validation failed:');
        preValidation.errors.forEach(err => this.logger.error(`  - ${err}`));
        return { success: false, errors: preValidation.errors };
      }

      if (preValidation.warnings.length > 0) {
        preValidation.warnings.forEach(warn => this.logger.warn(warn));
      }

      this.logger.success('Pre-merge validation passed');

      // Phase 3-5: Merge components
      const memoryResult = await this.memoryMerger.merge(loadedStates, this.progressReporter);
      const goalResult = await this.goalMerger.merge(loadedStates, this.progressReporter);
      const journal = await this.journalMerger.merge(loadedStates, this.progressReporter);

      // Build merged state
      const mergedState = this.buildMergedState(loadedStates, memoryResult, goalResult, journal);

      // Phase 6: Post-merge validation
      this.progressReporter.startPhase(6, 'Validating merged state');
      const postValidation = this.validator.validatePostMerge(mergedState);

      if (!postValidation.valid) {
        this.logger.error('Post-merge validation failed:');
        postValidation.errors.forEach(err => this.logger.error(`  - ${err}`));
        return { success: false, errors: postValidation.errors };
      }

      if (postValidation.warnings.length > 0) {
        postValidation.warnings.forEach(warn => this.logger.warn(warn));
      }

      this.logger.success('Post-merge validation passed');

      // Phase 7: Save merged run
      if (!this.options.dryRun) {
        this.progressReporter.startPhase(7, 'Saving merged run');
        await this.saveMergedRun(outputName, mergedState, loadedStates, {
          memory: memoryResult,
          goals: goalResult,
          journal
        });
      } else {
        this.logger.info('\nDry run mode - no files written');
      }

      // Phase 8: Generate report
      this.progressReporter.startPhase(8, 'Generating report');
      const report = this.generateReport(loadedStates, mergedState, {
        memory: memoryResult,
        goals: goalResult
      });

      if (!this.options.dryRun) {
        await this.saveReport(outputName, report);
      }

      this.progressReporter.complete();

      return {
        success: true,
        report,
        outputName
      };

    } catch (error) {
      this.logger.error('Merge failed with exception', error);
      return {
        success: false,
        errors: [error.message]
      };
    }
  }

  /**
   * Merge from pre-loaded states (used by Hub routes which resolve brains themselves).
   * Skips Phase 1 (loading) — accepts already-loaded state objects.
   * Each state should be: { name, path, state, metadata?, valid: true }
   * @param {Object[]} loadedStates - Pre-loaded brain states
   * @param {string} [outputName] - Output name (for saving, null for dry-run)
   * @returns {Object} Merge result
   */
  async merge(loadedStates, outputName) {
    try {
      // Phase 2: Validate
      this.progressReporter.startPhase(2, 'Validating compatibility');
      const preValidation = this.validator.validatePreMerge(loadedStates);

      if (!preValidation.valid) {
        return { success: false, errors: preValidation.errors };
      }

      // Phase 3-5: Merge components
      const memoryResult = await this.memoryMerger.merge(loadedStates, this.progressReporter);
      const goalResult = await this.goalMerger.merge(loadedStates, this.progressReporter);
      const journal = await this.journalMerger.merge(loadedStates, this.progressReporter);

      // Build merged state
      const mergedState = this.buildMergedState(loadedStates, memoryResult, goalResult, journal);

      // Phase 6: Post-merge validation
      this.progressReporter.startPhase(6, 'Validating merged state');
      const postValidation = this.validator.validatePostMerge(mergedState);

      if (!postValidation.valid) {
        return { success: false, errors: postValidation.errors };
      }

      // Phase 7: Save (unless dry run)
      if (!this.options.dryRun && outputName) {
        this.progressReporter.startPhase(7, 'Saving merged run');
        await this.saveMergedRun(outputName, mergedState, loadedStates, {
          memory: memoryResult, goals: goalResult, journal
        });
      }

      // Phase 8: Report
      this.progressReporter.startPhase(8, 'Generating report');
      const report = this.generateReport(loadedStates, mergedState, {
        memory: memoryResult, goals: goalResult
      });

      if (!this.options.dryRun && outputName) {
        await this.saveReport(outputName, report);
      }

      this.progressReporter.complete();

      return {
        success: true,
        report,
        outputName,
        mergedState,
        totalNodes: memoryResult.nodes?.size || Object.keys(memoryResult.nodes || {}).length || 0,
        mergedNodes: memoryResult.mergedCount || 0,
        duplicatesRemoved: memoryResult.duplicatesRemoved || 0,
        deduplicationRate: memoryResult.deduplicationRate || 0,
        totalEdges: memoryResult.edgeCount || 0,
        mergedEdges: memoryResult.mergedEdgeCount || 0,
        conflicts: memoryResult.conflictsPrevented || 0
      };

    } catch (error) {
      return { success: false, errors: [error.message] };
    }
  }

  buildMergedState(loadedStates, memoryResult, goalResult, journal) {
    const validStates = loadedStates.filter(s => s.valid);
    const firstState = validStates[0].state;

    // CRITICAL: Mark all merged nodes as already consolidated
    // This prevents O(n^2) re-processing of inherited memories from the source runs
    const mergeTimestamp = new Date().toISOString();

    // ARTIFACT REFERENCE TAGS: Nodes that contain file paths/artifact metadata
    // These reference files from parent runs that don't exist in the merged run
    const ARTIFACT_REFERENCE_TAGS = [
      'code_creation_output_files',      // Code files from CodeCreationAgent
      'code_execution_output_files',     // Test results from CodeExecutionAgent
      'document_metadata',               // Documents from DocumentCreationAgent
      'document_metadata_summary'        // Document summaries from DocumentAnalysisAgent
    ];

    // CRITICAL: Normalize activations before creating merged state
    // Source runs may have unbounded activation growth from Hebbian learning
    // Reset to 0 for fresh start (COSMO will rebuild activation patterns)
    const maxActivation = Math.max(...memoryResult.nodes.map(n => n.activation || 0));
    const activationScale = maxActivation > 1.0 ? maxActivation : 1.0;

    this.logger.info(`Normalizing activations (max: ${maxActivation.toFixed(2)}, will reset to 0 for fresh start)`);

    // Convert nodes and edges to proper format
    const nodes = memoryResult.nodes.map(node => {
      const isArtifactReference = ARTIFACT_REFERENCE_TAGS.includes(node.tag);

      // Restore original embedding (remove domain prefix)
      // COSMO will rebuild embeddings in its own unified semantic space
      const embedding = node.originalEmbedding || node.embedding;

      return {
        id: node.id,
        concept: node.concept,
        embedding, // Original embedding without domain prefix
        activation: 0, // CRITICAL FIX: Reset to 0 (corrupted source data had millions)
        weight: node.weight || 1,
        cluster: null, // Will be reassigned
        tag: node.tag || 'general',
        domain: node.domain || 'unknown', // Preserve domain metadata
        created: node.created,
        accessed: node.accessed || new Date(),
        accessCount: node.accessCount || 0,
        sourceRuns: node.sourceRuns,
        consolidatedAt: node.consolidatedAt || mergeTimestamp,  // Mark as consolidated if not already
        mergedAt: mergeTimestamp,  // CRITICAL: Explicit merge marker for GC protection

        // CRITICAL: Mark artifact references as inherited from parent runs
        // This signals to discovery systems that these files don't exist in the merged run
        // but preserves the knowledge that they once existed in the source runs
        inheritedArtifact: isArtifactReference ? true : undefined
      };
    });

    const edges = memoryResult.edges.map(edge => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      type: edge.type || 'associative',
      created: edge.created,
      accessed: edge.accessed
    }));

    return {
      cycleCount: 0, // Fresh start
      journal: journal.slice(0, 100), // Keep last 100 for journal
      thoughtHistory: journal, // Full history
      lastSummarization: 0,
      timestamp: new Date().toISOString(),

      memory: {
        nodes,
        edges,
        clusters: [], // Will be rebuilt by system
        nextNodeId: nodes.length + 1,
        nextClusterId: 1
      },

      goals: goalResult.goals,

      // Preserve structure from first run
      roles: firstState.roles || {},
      reflection: firstState.reflection || {},
      oscillator: firstState.oscillator || {},
      coordinator: { reviewHistory: [], lastReview: 0 },
      agentExecutor: { completedAgents: [], activeAgents: [] },
      forkSystem: firstState.forkSystem || {},
      topicQueue: { pending: [], processed: [] },
      goalCurator: { campaigns: [], lastCuration: 0 },
      evaluation: { metrics: {}, timeseries: [] }
    };
  }

  async saveMergedRun(outputName, mergedState, loadedStates, mergeDetails) {
    const outputDir = path.join(this.runsPath, outputName);

    // Create directory
    await fs.mkdir(outputDir, { recursive: true });

    // Save compressed state
    const statePath = path.join(outputDir, 'state.json');
    await saveCompressedState(statePath, mergedState);
    this.logger.success(`Saved merged state to ${outputName}/state.json.gz`);

    // Save metadata
    const metadata = {
      created: new Date().toISOString(),
      runName: outputName,
      domain: 'Merged Knowledge', // Explicitly set for .brain manifest
      mergedFrom: loadedStates.filter(s => s.valid).map(s => s.name),
      sourceStats: {},
      mergeStats: {
        totalSourceNodes: loadedStates.reduce((sum, s) =>
          sum + (s.state?.memory?.nodes?.length || 0), 0),
        mergedNodes: mergedState.memory.nodes.length,
        duplicatesRemoved: mergeDetails.memory.duplicates,
        totalSourceGoals: loadedStates.reduce((sum, s) =>
          sum + (s.state?.goals?.length || 0), 0),
        mergedGoals: mergedState.goals.length,
        goalDuplicatesRemoved: mergeDetails.goals.duplicates,
        journalEntries: mergedState.thoughtHistory.length
      },
      explorationMode: this.options.mode || CONFIG.defaultMode,
      mergeOptions: {
        threshold: this.options.threshold || CONFIG.defaultThreshold,
        journalLimit: this.options.journalLimit || CONFIG.defaultJournalLimit
      }
    };

    // Add individual run stats
    for (const loaded of loadedStates.filter(s => s.valid)) {
      metadata.sourceStats[loaded.name] = {
        cycles: loaded.state.cycleCount || 0,
        nodes: loaded.state?.memory?.nodes?.length || 0,
        goals: loaded.state?.goals?.length || 0,
        domain: loaded.metadata.domain || 'unknown'
      };
    }

    await fs.writeFile(
      path.join(outputDir, 'run-metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    // UPGRADE 7: Save confidence heatmap report
    if (mergeDetails.memory.confidenceReport) {
      await fs.writeFile(
        path.join(outputDir, 'merge-confidence.json'),
        JSON.stringify(mergeDetails.memory.confidenceReport, null, 2)
      );
      this.logger.success(`Saved merge confidence report to ${outputName}/merge-confidence.json`);
    }

    // Create coordinator directory
    await fs.mkdir(path.join(outputDir, 'coordinator'), { recursive: true });
    await fs.mkdir(path.join(outputDir, 'agents'), { recursive: true });

    // Copy work artifacts from source runs (outputs, coordinator files, plans, etc.)
    const workArtifacts = await this.copyWorkArtifacts(loadedStates, outputDir);

    // Add work artifacts manifest to metadata
    metadata.workArtifactsIncluded = workArtifacts.summary;
    metadata.totalWorkArtifacts = workArtifacts.totals;

    // Re-save metadata with work artifacts info
    await fs.writeFile(
      path.join(outputDir, 'run-metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    return outputDir;
  }

  /**
   * Copy work artifacts from all source runs (outputs, coordinator, plans, etc.)
   * Uses graceful degradation - never fails if artifacts are missing
   */
  async copyWorkArtifacts(loadedStates, outputDir) {
    const summary = {};
    const totals = {
      fileCount: 0,
      directoriesCopied: 0,
      filesCopied: 0,
      sourcesProcessed: 0
    };

    this.logger.info('\nCopying work artifacts from source runs...');

    for (const loaded of loadedStates.filter(s => s.valid)) {
      const sourceName = loaded.name;
      // Use actual path from loadedState if available, otherwise use runsPath
      const sourcePath = loaded.path || path.join(this.runsPath, sourceName);

      this.logger.info(`\n  Source: ${sourceName}`);

      summary[sourceName] = await this.copyRunArtifacts(
        sourcePath,
        outputDir,
        sourceName,
        totals
      );

      totals.sourcesProcessed++;
    }

    this.logger.success(`\nWork artifacts copied: ${totals.filesCopied} files from ${totals.sourcesProcessed} sources`);

    return { summary, totals };
  }

  /**
   * Copy work artifacts from a single source run
   */
  async copyRunArtifacts(sourcePath, destPath, sourceName, totals) {
    const stats = {};

    // Check if source run exists
    if (!fsSync.existsSync(sourcePath)) {
      this.logger.warn(`    Source path not found: ${sourcePath}`);
      return stats;
    }

    // Tier 2: Agent Deliverables (CRITICAL - preserve exact paths for memory references!)
    await this.tryCopyDir(
      path.join(sourcePath, 'outputs'),
      path.join(destPath, 'outputs'),
      'outputs',
      stats,
      totals
    );

    // Tier 3: Coordination & Reviews
    await this.tryCopyDirMerge(
      path.join(sourcePath, 'coordinator'),
      path.join(destPath, 'coordinator'),
      'coordinator',
      stats,
      totals
    );

    await this.tryCopyDirMerge(
      path.join(sourcePath, 'agents'),
      path.join(destPath, 'agents'),
      'agents',
      stats,
      totals
    );

    // Tier 1: Strategic Planning & Progress
    await this.tryCopyFile(
      path.join(sourcePath, 'guided-plan.md'),
      path.join(destPath, 'plans-archive', `${sourceName}_guided-plan.md`),
      'guidedPlan',
      stats,
      totals
    );

    await this.tryCopyFile(
      path.join(sourcePath, 'cosmo-progress.md'),
      path.join(destPath, 'progress-archive', `${sourceName}_cosmo-progress.md`),
      'progress',
      stats,
      totals
    );

    // Copy historical plan versions
    await this.tryCopyGlob(
      sourcePath,
      'guided-plan-*.md',
      path.join(destPath, 'plans-archive'),
      sourceName,
      'guidedPlanVersions',
      stats,
      totals
    );

    // Tier 4: Execution State
    await this.tryCopyDirMerge(
      path.join(sourcePath, 'plans'),
      path.join(destPath, 'plans-archive', sourceName),
      'plans',
      stats,
      totals
    );

    await this.tryCopyDirMerge(
      path.join(sourcePath, 'tasks'),
      path.join(destPath, 'tasks-archive', sourceName),
      'tasks',
      stats,
      totals
    );

    await this.tryCopyDirMerge(
      path.join(sourcePath, 'milestones'),
      path.join(destPath, 'milestones-archive', sourceName),
      'milestones',
      stats,
      totals
    );

    await this.tryCopyDirMerge(
      path.join(sourcePath, 'checkpoints'),
      path.join(destPath, 'checkpoints-archive', sourceName),
      'checkpoints',
      stats,
      totals
    );

    await this.tryCopyDirMerge(
      path.join(sourcePath, 'exports'),
      path.join(destPath, 'exports-archive', sourceName),
      'exports',
      stats,
      totals
    );

    // Tier 5: Thought Stream
    await this.tryCopyFile(
      path.join(sourcePath, 'thoughts.jsonl'),
      path.join(destPath, 'thoughts-archive', `${sourceName}_thoughts.jsonl`),
      'thoughts',
      stats,
      totals
    );

    await this.tryCopyFile(
      path.join(sourcePath, 'evaluation-branches.jsonl'),
      path.join(destPath, 'evaluation-archive', `${sourceName}_evaluation-branches.jsonl`),
      'evaluationBranches',
      stats,
      totals
    );

    await this.tryCopyFile(
      path.join(sourcePath, 'evaluation-metrics.json'),
      path.join(destPath, 'evaluation-archive', `${sourceName}_evaluation-metrics.json`),
      'evaluationMetrics',
      stats,
      totals
    );

    return stats;
  }

  /**
   * Try to copy a directory (fails gracefully if missing)
   */
  async tryCopyDir(sourcePath, destPath, label, stats, totals) {
    try {
      if (!fsSync.existsSync(sourcePath)) {
        this.logger.debug(`    - ${label} (not present)`);
        stats[label] = false;
        return;
      }

      await this.copyDirectory(sourcePath, destPath);
      const fileCount = await this.countFiles(destPath);

      this.logger.info(`    + ${label} (${fileCount} files)`);
      stats[label] = true;
      stats[`${label}FileCount`] = fileCount;
      totals.filesCopied += fileCount;
      totals.directoriesCopied++;
    } catch (error) {
      this.logger.warn(`    Failed to copy ${label}: ${error.message}`);
      stats[label] = false;
    }
  }

  /**
   * Try to copy a directory, merging into existing destination
   */
  async tryCopyDirMerge(sourcePath, destPath, label, stats, totals) {
    try {
      if (!fsSync.existsSync(sourcePath)) {
        stats[label] = false;
        return;
      }

      // Ensure dest exists first
      await fs.mkdir(destPath, { recursive: true });
      await this.copyDirectory(sourcePath, destPath);

      const fileCount = await this.countFiles(sourcePath);

      if (fileCount > 0) {
        this.logger.debug(`    + ${label} (${fileCount} files)`);
        stats[label] = true;
        stats[`${label}FileCount`] = fileCount;
        totals.filesCopied += fileCount;
        totals.directoriesCopied++;
      } else {
        stats[label] = false;
      }
    } catch (error) {
      this.logger.warn(`    Failed to copy ${label}: ${error.message}`);
      stats[label] = false;
    }
  }

  /**
   * Try to copy a single file (fails gracefully if missing)
   */
  async tryCopyFile(sourcePath, destPath, label, stats, totals) {
    try {
      if (!fsSync.existsSync(sourcePath)) {
        stats[label] = false;
        return;
      }

      // Ensure destination directory exists
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(sourcePath, destPath);

      this.logger.debug(`    + ${label}`);
      stats[label] = true;
      totals.filesCopied++;
    } catch (error) {
      this.logger.warn(`    Failed to copy ${label}: ${error.message}`);
      stats[label] = false;
    }
  }

  /**
   * Try to copy files matching a glob pattern
   */
  async tryCopyGlob(sourceDir, pattern, destDir, sourceName, label, stats, totals) {
    try {
      if (!fsSync.existsSync(sourceDir)) {
        stats[label] = 0;
        return;
      }

      const files = await fs.readdir(sourceDir);
      const regex = new RegExp(pattern.replace('*', '.*'));
      const matches = files.filter(f => regex.test(f));

      if (matches.length === 0) {
        stats[label] = 0;
        return;
      }

      await fs.mkdir(destDir, { recursive: true });

      for (const file of matches) {
        const srcPath = path.join(sourceDir, file);
        const destPath = path.join(destDir, `${sourceName}_${file}`);
        await fs.copyFile(srcPath, destPath);
      }

      this.logger.debug(`    + ${label} (${matches.length} versions)`);
      stats[label] = matches.length;
      totals.filesCopied += matches.length;
    } catch (error) {
      this.logger.warn(`    Failed to copy ${label}: ${error.message}`);
      stats[label] = 0;
    }
  }

  /**
   * Recursively copy directory
   */
  async copyDirectory(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Count files in a directory recursively
   */
  async countFiles(dir) {
    if (!fsSync.existsSync(dir)) {
      return 0;
    }

    let count = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += await this.countFiles(fullPath);
      } else {
        count++;
      }
    }

    return count;
  }

  generateReport(loadedStates, mergedState, mergeDetails) {
    const validStates = loadedStates.filter(s => s.valid);

    const report = {
      created: new Date().toISOString(),
      mergeTime: this.logger.elapsed(),
      sourceRuns: validStates.map(s => ({
        name: s.name,
        cycles: s.state.cycleCount || 0,
        nodes: s.state?.memory?.nodes?.length || 0,
        edges: s.state?.memory?.edges?.length || 0,
        goals: s.state?.goals?.length || 0,
        domain: s.metadata.domain || 'unknown'
      })),
      mergedState: {
        nodes: mergedState.memory.nodes.length,
        edges: mergedState.memory.edges.length,
        goals: mergedState.goals.length,
        journalEntries: mergedState.thoughtHistory.length
      },
      deduplication: {
        nodes: {
          total: validStates.reduce((sum, s) => sum + (s.state?.memory?.nodes?.length || 0), 0),
          merged: mergedState.memory.nodes.length,
          removed: mergeDetails.memory.duplicates,
          rate: ((mergeDetails.memory.duplicates / validStates.reduce((sum, s) => sum + (s.state?.memory?.nodes?.length || 0), 0)) * 100).toFixed(1) + '%'
        },
        goals: {
          total: validStates.reduce((sum, s) => sum + (s.state?.goals?.length || 0), 0),
          merged: mergedState.goals.length,
          removed: mergeDetails.goals.duplicates
        }
      },
      // UPGRADE 7: Include confidence analysis summary
      confidence: mergeDetails.memory.confidenceReport ? {
        conflictsPrevented: mergeDetails.memory.confidenceReport.conflictsPrevented,
        totalMerged: mergeDetails.memory.confidenceReport.totalMerged,
        totalRejected: mergeDetails.memory.confidenceReport.totalRejected,
        domainStats: mergeDetails.memory.confidenceReport.domainStats
      } : null
    };

    return report;
  }

  async saveReport(outputName, report) {
    const outputDir = path.join(this.runsPath, outputName);

    // Save JSON report
    await fs.writeFile(
      path.join(outputDir, 'merge-report.json'),
      JSON.stringify(report, null, 2)
    );

    // Generate markdown report
    const markdown = this.formatReportMarkdown(report, outputName);
    await fs.writeFile(
      path.join(outputDir, 'MERGE_REPORT.md'),
      markdown
    );

    this.logger.success('Generated merge report');
  }

  formatReportMarkdown(report, outputName) {
    return `# COSMO Run Merge Report

## Summary

- **Output Run:** ${outputName}
- **Created:** ${new Date(report.created).toLocaleString()}
- **Merge Time:** ${report.mergeTime}
- **Source Runs:** ${report.sourceRuns.length}

---

## Source Runs

${report.sourceRuns.map((run, i) => `
### ${i + 1}. ${run.name}
- **Cycles:** ${formatNumber(run.cycles)}
- **Memory Nodes:** ${formatNumber(run.nodes)}
- **Memory Edges:** ${formatNumber(run.edges)}
- **Goals:** ${run.goals}
- **Domain:** ${run.domain}
`).join('\n')}

---

## Merge Results

### Memory Network
- **Source Nodes:** ${formatNumber(report.deduplication.nodes.total)}
- **Merged Nodes:** ${formatNumber(report.mergedState.nodes)}
- **Duplicates Removed:** ${formatNumber(report.deduplication.nodes.removed)} (${report.deduplication.nodes.rate})
- **Merged Edges:** ${formatNumber(report.mergedState.edges)}

### Goals
- **Source Goals:** ${formatNumber(report.deduplication.goals.total)}
- **Merged Goals:** ${formatNumber(report.mergedState.goals)}
- **Duplicates Removed:** ${formatNumber(report.deduplication.goals.removed)}

### Journal
- **Total Entries:** ${formatNumber(report.mergedState.journalEntries)}

${report.confidence ? `
---

## Merge Quality & Confidence Analysis

### Conflict Prevention
- **Semantic Conflicts Prevented:** ${report.confidence.conflictsPrevented}
- **Total Pairs Merged:** ${formatNumber(report.confidence.totalMerged)}
- **Pairs Rejected (below threshold):** ${formatNumber(report.confidence.totalRejected)}

### Domain-Specific Merge Statistics
${report.confidence.domainStats.map(stat => `
- **${stat.domain}**: ${formatNumber(stat.mergeCount)} merges (avg similarity: ${stat.avgSimilarity})
`).join('')}

*Full confidence analysis available in: \`merge-confidence.json\`*
` : ''}

---

## Next Steps

1. The merged run will start at cycle 0 with all accumulated knowledge from source runs.
2. Clusters will be rebuilt automatically on first run.
3. Activation levels have been reset - COSMO will rebuild activation patterns through use.
`;
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  MergeEngine,
  StateLoader,
  ValidationEngine,
  MemoryMerger,
  GoalMerger,
  JournalMerger,
  ProgressReporter,
  DomainRegistry,
  Logger,
  // Helper functions
  addDomainPrefix,
  detectDomain,
  cosineSimilarity,
  weightedCosineSimilarity,
  getAdaptiveThreshold,
  scoreNodeRepresentative,
  selectBestRepresentative,
  detectSemanticConflict,
  getRunPrefix,
  formatBytes,
  formatNumber,
  // State compression utilities
  loadCompressedState,
  saveCompressedState,
  // Configuration (exposed for customization)
  CONFIG
};
