#!/usr/bin/env node

/**
 * COSMO Run Ultra-Scanner (Preflight for Big Brain Merge)
 *
 * Read-only analysis of all runs in ./runs:
 *  - Domain inference
 *  - Node / edge / cluster stats
 *  - Embedding dimension & corruption detection
 *  - Connected components / isolated subgraphs
 *  - Cluster representatives (3 views):
 *      * Top activation (Hebbian usage patterns)
 *      * Top degree (graph hub / structural importance)
 *      * Closest to cluster centroid (semantic core)
 *  - Per-run centroids
 *  - Cross-run centroid similarity matrix
 *  - Artifact reference detection
 *  - Consolidation status
 *  - Merge detection
 *  - Risk assessment
 *
 * Outputs:
 *  - runs/SCAN_REPORT.json
 *  - runs/SCAN_REPORT.md
 *
 * Usage:
 *   node scripts/scan_runs.js
 *   node scripts/scan_runs.js --verbose
 */

const fs = require('fs').promises;
const path = require('path');
const { StateLoader } = require('./merge_runs.js');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  runsDir: path.join(__dirname, '..', 'runs'),
  maxNodesForFullGraphAnalysis: 50000, // Safety limit (matches merge_runs.js)
};

// ARTIFACT REFERENCE TAGS: Nodes that contain file paths/artifact metadata
// These reference files from parent runs (from merge_runs.js lines 1165-1170)
const ARTIFACT_REFERENCE_TAGS = [
  'code_creation_output_files',      // Code files from CodeCreationAgent
  'code_execution_output_files',     // Test results from CodeExecutionAgent
  'document_metadata',               // Documents from DocumentCreationAgent
  'document_metadata_summary'        // Document summaries from DocumentAnalysisAgent
];

// ============================================================================
// Logger (matches merge_runs.js pattern)
// ============================================================================

class Logger {
  constructor(verbose = true) {
    this.verbose = verbose;
    this.startTime = Date.now();
  }

  info(msg, data = null) {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${msg}`);
    if (data && this.verbose) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  warn(msg) {
    const ts = new Date().toISOString().substring(11, 19);
    console.warn(`[${ts}] ⚠ ${msg}`);
  }

  error(msg, err = null) {
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`[${ts}] ✗ ${msg}`);
    if (err && this.verbose) {
      console.error(err);
    }
  }

  debug(msg, data = null) {
    if (this.verbose) {
      console.log(`  ${msg}`);
      if (data) {
        console.log(JSON.stringify(data, null, 2));
      }
    }
  }

  elapsed() {
    const ms = Date.now() - this.startTime;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }
}

// ============================================================================
// Utility Functions (replicated from merge_runs.js as they're not exported)
// ============================================================================

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

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Domain detection logic (replicated from merge_runs.js lines 160-185)
 * Detects domain from run metadata or run name
 */
function detectDomainFromLoaded(loaded) {
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
    'art': 'art_music',
    'music': 'art_music',
    'hist': 'history',
    'phil': 'philosophy',
    'psych': 'psychology',
    'soc': 'sociology',
    'econ': 'economics',
    'biz': 'business',
    'med': 'medicine'
  };
  
  for (const [keyword, domain] of Object.entries(domainKeywords)) {
    if (name.includes(keyword)) {
      return domain;
    }
  }
  
  // Default to unknown (no domain separation)
  return 'unknown';
}

// ============================================================================
// Core Analysis Per Run
// ============================================================================

async function analyzeRun(logger, stateLoader, discoveredRun) {
  const loaded = await stateLoader.loadState(discoveredRun.name);

  if (!loaded.valid || !loaded.state || !loaded.state.memory) {
    logger.warn(`Run ${discoveredRun.name} is invalid or missing memory; skipping.`);
    return {
      name: discoveredRun.name,
      valid: false,
      reason: loaded.errors && loaded.errors.length > 0 ? loaded.errors[0] : 'invalid_state'
    };
  }

  const state = loaded.state;
  const memory = state.memory;
  const nodes = memory.nodes || [];
  const edges = memory.edges || [];
  const domain = detectDomainFromLoaded(loaded);

  // Basic stats
  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  // Embedding stats
  let embeddingDim = 0;
  let corruptEmbeddings = 0;
  let unnormalizedEmbeddings = 0;
  let embeddingSum = null;
  let embeddingCount = 0;

  for (const node of nodes) {
    const emb = node.embedding;
    if (!emb || !Array.isArray(emb)) {
      corruptEmbeddings++;
      continue;
    }
    if (emb.some(v => typeof v !== 'number' || Number.isNaN(v))) {
      corruptEmbeddings++;
      continue;
    }

    // Check normalization (embeddings should have magnitude ~1.0)
    const magnitude = Math.sqrt(emb.reduce((sum, val) => sum + val * val, 0));
    if (Math.abs(magnitude - 1.0) > 0.01) {
      unnormalizedEmbeddings++;
    }

    if (!embeddingDim) embeddingDim = emb.length;
    if (!embeddingSum) embeddingSum = new Array(emb.length).fill(0);
    for (let i = 0; i < emb.length; i++) {
      embeddingSum[i] += emb[i];
    }
    embeddingCount++;
  }

  const centroid = embeddingSum && embeddingCount > 0
    ? embeddingSum.map(v => v / embeddingCount)
    : null;

  // Consolidation status (from merge_runs.js line 1193)
  const consolidatedNodes = nodes.filter(n => n.consolidatedAt).length;
  const unconsolidatedNodes = nodeCount - consolidatedNodes;

  // Merge detection (from merge_runs.js lines 741-745)
  const nodesWithMultipleSourceRuns = nodes.filter(n => 
    n.sourceRuns && Array.isArray(n.sourceRuns) && n.sourceRuns.length > 1
  ).length;
  const isPreviouslyMerged = nodesWithMultipleSourceRuns > 0;

  // Artifact reference detection
  const artifactReferenceNodes = nodes.filter(n => 
    ARTIFACT_REFERENCE_TAGS.includes(n.tag)
  ).length;

  // Degree + adjacency (for components and hub detection)
  const degree = new Map();     // nodeId -> degree
  const adjacency = new Map();  // nodeId -> Set(neighbors)

  function ensureNode(id) {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    if (!degree.has(id)) degree.set(id, 0);
  }

  for (const node of nodes) {
    ensureNode(node.id);
  }

  let invalidEdges = 0;
  for (const edge of edges) {
    let from, to;
    if (edge.key) {
      const parts = edge.key.split('->');
      if (parts.length === 2) {
        from = Number(parts[0]);
        to = Number(parts[1]);
      } else {
        invalidEdges++;
        continue;
      }
    } else if (edge.source !== undefined && edge.target !== undefined) {
      from = edge.source;
      to = edge.target;
    } else {
      invalidEdges++;
      continue;
    }

    if (from == null || to == null) {
      invalidEdges++;
      continue;
    }

    if (!adjacency.has(from) || !adjacency.has(to)) {
      invalidEdges++;
      continue;
    }

    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
    degree.set(from, (degree.get(from) || 0) + 1);
    degree.set(to, (degree.get(to) || 0) + 1);
  }

  // Connected components (isolated subgraphs)
  let components = [];
  if (nodeCount <= CONFIG.maxNodesForFullGraphAnalysis) {
    const visited = new Set();
    for (const node of nodes) {
      const id = node.id;
      if (visited.has(id)) continue;
      const queue = [id];
      visited.add(id);
      let size = 0;
      while (queue.length) {
        const cur = queue.shift();
        size++;
        const neighbors = adjacency.get(cur) || new Set();
        for (const nb of neighbors) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      components.push(size);
    }
  } else {
    // Too big; approximate by skipping full CC computation
    components = [nodeCount]; // treat as single component for now
  }

  components.sort((a, b) => b - a);
  const componentCount = components.length;
  const largestComponentSize = components[0] || 0;
  const isolatedNodes = components.filter(c => c === 1).length;

  // Cluster stats (using node.cluster when present)
  const clusters = new Map(); // clusterId|string -> { nodes: [], centroid, reps }
  for (const node of nodes) {
    const clusterId = node.cluster != null ? node.cluster : 'unassigned';
    if (!clusters.has(clusterId)) {
      clusters.set(clusterId, {
        id: clusterId,
        nodes: [],
        embeddingSum: null,
        embeddingCount: 0
      });
    }
    const c = clusters.get(clusterId);
    c.nodes.push(node);

    const emb = node.embedding;
    if (emb && Array.isArray(emb) && !emb.some(v => typeof v !== 'number' || Number.isNaN(v))) {
      if (!c.embeddingSum) c.embeddingSum = new Array(emb.length).fill(0);
      for (let i = 0; i < emb.length; i++) {
        c.embeddingSum[i] += emb[i];
      }
      c.embeddingCount++;
    }
  }

  // Compute cluster centroids
  for (const c of clusters.values()) {
    if (c.embeddingSum && c.embeddingCount > 0) {
      c.centroid = c.embeddingSum.map(v => v / c.embeddingCount);
    } else {
      c.centroid = null;
    }
  }

  // Representative nodes per cluster (3 views):
  //  - Top activation (Hebbian usage patterns)
  //  - Top degree (graph hub / structural importance)
  //  - Closest to centroid (semantic core)
  const clusterSummaries = [];
  for (const c of clusters.values()) {
    const clusterNodes = c.nodes;
    let topActivation = null;
    let topDegree = null;
    let centroidClosest = null;
    let centroidClosestSim = -Infinity;

    for (const node of clusterNodes) {
      const id = node.id;
      const act = node.activation || 0;
      const deg = degree.get(id) || 0;

      // Hebbian top activation
      if (!topActivation || act > (topActivation.activation || 0)) {
        topActivation = {
          id,
          concept: node.concept,
          activation: act,
          degree: deg,
          tag: node.tag || 'general'
        };
      }

      // Graph hub: max degree
      if (!topDegree || deg > (topDegree.degree || 0)) {
        topDegree = {
          id,
          concept: node.concept,
          activation: act,
          degree: deg,
          tag: node.tag || 'general'
        };
      }

      // Semantic core: closest to cluster centroid
      if (c.centroid && node.embedding && Array.isArray(node.embedding)) {
        const sim = cosineSimilarity(node.embedding, c.centroid);
        if (sim > centroidClosestSim) {
          centroidClosestSim = sim;
          centroidClosest = {
            id,
            concept: node.concept,
            activation: act,
            degree: deg,
            tag: node.tag || 'general',
            similarityToClusterCentroid: sim
          };
        }
      }
    }

    clusterSummaries.push({
      id: c.id,
      size: clusterNodes.length,
      hasCentroid: !!c.centroid,
      topActivation,
      topDegree,
      centroidClosest
    });
  }

  // Sort clusters by size (largest first)
  clusterSummaries.sort((a, b) => b.size - a.size);

  // Tag distribution (quick sense of semantic spread)
  const tagCounts = new Map();
  for (const node of nodes) {
    const tag = node.tag || 'general';
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
  const tagSummary = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));

  // Simple per-run risk assessment (will be refined globally)
  const notes = [];
  let riskLevel = 'SAFE';
  let riskScore = 0;

  if (corruptEmbeddings > 0) {
    riskScore += 2;
    notes.push(`Has ${formatNumber(corruptEmbeddings)} nodes with invalid embeddings`);
  }
  if (unnormalizedEmbeddings > nodeCount * 0.1) {
    riskScore += 1;
    notes.push(`Has ${formatNumber(unnormalizedEmbeddings)} unnormalized embeddings (>10%)`);
  }
  if (nodeCount < 100) {
    riskScore += 1;
    notes.push('Very small run (<100 nodes)');
  }
  if (nodeCount > 40000) {
    riskScore += 2;
    notes.push('Very large run (>40k nodes)');
  }
  if (embeddingDim === 0) {
    riskScore += 2;
    notes.push('No valid embeddings detected');
  }
  if (componentCount > 10) {
    riskScore += 1;
    notes.push(`Highly fragmented graph (${componentCount} components)`);
  }
  if (isolatedNodes > nodeCount * 0.1) {
    riskScore += 1;
    notes.push(`Many isolated nodes (${isolatedNodes}, ${((isolatedNodes/nodeCount)*100).toFixed(1)}%)`);
  }
  if (invalidEdges > edgeCount * 0.1) {
    riskScore += 1;
    notes.push(`High invalid edge ratio (${invalidEdges}/${edgeCount})`);
  }
  if (unconsolidatedNodes > nodeCount * 0.5) {
    notes.push(`${formatNumber(unconsolidatedNodes)} unconsolidated nodes (may need consolidation before merge)`);
  }
  if (isPreviouslyMerged) {
    notes.push(`Previously merged run (${formatNumber(nodesWithMultipleSourceRuns)} nodes from multiple sources)`);
  }
  if (artifactReferenceNodes > 0) {
    notes.push(`Contains ${formatNumber(artifactReferenceNodes)} artifact reference nodes (CodeCreation/Document outputs)`);
  }

  if (riskScore >= 4) riskLevel = 'HIGH';
  else if (riskScore >= 2) riskLevel = 'MODERATE';

  return {
    name: discoveredRun.name,
    valid: true,
    domain,
    sizeBytes: discoveredRun.size || 0,
    nodeCount,
    edgeCount,
    invalidEdges,
    embeddingDim,
    corruptEmbeddings,
    unnormalizedEmbeddings,
    centroid,
    componentCount,
    largestComponentSize,
    isolatedNodes,
    consolidatedNodes,
    unconsolidatedNodes,
    isPreviouslyMerged,
    nodesWithMultipleSourceRuns,
    artifactReferenceNodes,
    clusters: {
      count: clusters.size,
      summaries: clusterSummaries
    },
    tags: tagSummary,
    riskLevel,
    riskScore,
    notes
  };
}

// ============================================================================
// Global Analysis Across Runs
// ============================================================================

function computeGlobalAnalysis(runs) {
  const validRuns = runs.filter(r => r.valid && r.centroid);

  // Embedding dimension consistency
  const dimCounts = new Map();
  for (const r of validRuns) {
    const d = r.embeddingDim || 0;
    dimCounts.set(d, (dimCounts.get(d) || 0) + 1);
  }
  let majorityDim = null;
  let majorityCount = 0;
  for (const [dim, count] of dimCounts.entries()) {
    if (count > majorityCount) {
      majorityCount = count;
      majorityDim = dim;
    }
  }

  // Cross-run centroid similarity matrix
  const centroidSimilarity = [];
  for (let i = 0; i < validRuns.length; i++) {
    for (let j = i + 1; j < validRuns.length; j++) {
      const a = validRuns[i];
      const b = validRuns[j];
      const sim = cosineSimilarity(a.centroid, b.centroid);
      centroidSimilarity.push({
        runA: a.name,
        domainA: a.domain,
        runB: b.name,
        domainB: b.domain,
        similarity: Number(sim.toFixed(4))
      });
    }
  }

  // Sort by similarity (highest first) for easy review
  centroidSimilarity.sort((a, b) => b.similarity - a.similarity);

  // Adjust risk based on dimension mismatch and cross-domain high similarity
  const runByName = new Map(runs.map(r => [r.name, r]));
  const globalNotes = [];
  const mergeRecommendations = {
    safeSameDomain: [],
    requiresDomainAlignment: [],
    doNotMerge: []
  };

  // Dimension mismatch
  for (const r of validRuns) {
    if (majorityDim && r.embeddingDim && r.embeddingDim !== majorityDim) {
      r.riskScore += 2;
      r.notes.push(`Embedding dimension ${r.embeddingDim} differs from majority ${majorityDim}`);
      if (r.riskScore >= 4) r.riskLevel = 'HIGH';
      else if (r.riskScore >= 2) r.riskLevel = 'MODERATE';
    }
  }

  // Analyze centroid similarity for merge recommendations
  for (const entry of centroidSimilarity) {
    const rA = runByName.get(entry.runA);
    const rB = runByName.get(entry.runB);
    
    if (!rA || !rB || !rA.valid || !rB.valid) continue;

    const sameDomain = entry.domainA === entry.domainB;
    const highSim = entry.similarity >= 0.6;
    const verySimilar = entry.similarity >= 0.8;

    // Same domain, high similarity = good merge candidates
    if (sameDomain && verySimilar && rA.riskLevel !== 'HIGH' && rB.riskLevel !== 'HIGH') {
      mergeRecommendations.safeSameDomain.push({
        runs: [entry.runA, entry.runB],
        domain: entry.domainA,
        similarity: entry.similarity,
        reason: 'High similarity, same domain, low risk'
      });
    }

    // Different domains but high similarity = needs domain alignment
    if (!sameDomain && highSim) {
      const note = `High centroid similarity between ${entry.runA} (${entry.domainA}) and ${entry.runB} (${entry.domainB}): ${entry.similarity}`;
      globalNotes.push(note);
      
      if (rA.riskLevel !== 'HIGH' && rB.riskLevel !== 'HIGH') {
        mergeRecommendations.requiresDomainAlignment.push({
          runs: [entry.runA, entry.runB],
          domainA: entry.domainA,
          domainB: entry.domainB,
          similarity: entry.similarity,
          reason: 'Different domains with high similarity - use --domain-alignment'
        });
      }

      rA.riskScore += 1;
      rA.notes.push(`High similarity to ${entry.runB} (${entry.domainB})`);
      rB.riskScore += 1;
      rB.notes.push(`High similarity to ${entry.runA} (${entry.domainA})`);
    }
  }

  // Flag high-risk runs that should not be merged
  for (const r of runs) {
    if (!r.valid) continue;
    if (r.riskScore >= 4) {
      mergeRecommendations.doNotMerge.push({
        run: r.name,
        domain: r.domain,
        riskLevel: r.riskLevel,
        riskScore: r.riskScore,
        reason: r.notes.join('; ')
      });
    }
  }

  // Recompute textual risk labels after adjustments
  for (const r of runs) {
    if (!r.valid) continue;
    if (r.riskScore >= 4) r.riskLevel = 'HIGH';
    else if (r.riskScore >= 2) r.riskLevel = 'MODERATE';
    else r.riskLevel = 'SAFE';
  }

  return {
    majorityEmbeddingDim: majorityDim,
    centroidSimilarity,
    globalNotes,
    mergeRecommendations
  };
}

// ============================================================================
// Report Formatting
// ============================================================================

async function writeReports(rootDir, runs, global) {
  const outJsonPath = path.join(rootDir, 'SCAN_REPORT.json');
  const outMdPath = path.join(rootDir, 'SCAN_REPORT.md');

  const report = {
    generatedAt: new Date().toISOString(),
    runs,
    global
  };

  await fs.writeFile(outJsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Markdown summary
  const lines = [];
  lines.push('# COSMO Run Scan Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toLocaleString()}`);
  lines.push('');

  // Global overview
  lines.push('## Global Overview');
  lines.push('');
  lines.push(`- **Runs analyzed:** ${runs.length}`);
  const validCount = runs.filter(r => r.valid).length;
  lines.push(`- **Valid runs:** ${validCount}`);
  const invalidCount = runs.length - validCount;
  if (invalidCount > 0) {
    lines.push(`- **Invalid runs:** ${invalidCount}`);
  }
  if (global.majorityEmbeddingDim) {
    lines.push(`- **Majority embedding dimension:** ${global.majorityEmbeddingDim}`);
  }
  lines.push('');

  if (global.globalNotes.length > 0) {
    lines.push('### Global Notes');
    lines.push('');
    for (const n of global.globalNotes) {
      lines.push(`- ${n}`);
    }
    lines.push('');
  }

  // Merge recommendations
  lines.push('## Recommended Merge Groups');
  lines.push('');

  if (global.mergeRecommendations.safeSameDomain.length > 0) {
    lines.push('### ✅ Safe to Merge (Same Domain, High Similarity)');
    lines.push('');
    for (const rec of global.mergeRecommendations.safeSameDomain) {
      lines.push(`- **${rec.runs.join(' + ')}**`);
      lines.push(`  - Domain: ${rec.domain}`);
      lines.push(`  - Similarity: ${rec.similarity}`);
      lines.push(`  - ${rec.reason}`);
      lines.push('');
    }
  }

  if (global.mergeRecommendations.requiresDomainAlignment.length > 0) {
    lines.push('### ⚠️ Requires Domain Alignment (Different Domains)');
    lines.push('');
    for (const rec of global.mergeRecommendations.requiresDomainAlignment) {
      lines.push(`- **${rec.runs.join(' + ')}**`);
      lines.push(`  - Domains: ${rec.domainA} + ${rec.domainB}`);
      lines.push(`  - Similarity: ${rec.similarity}`);
      lines.push(`  - ${rec.reason}`);
      lines.push('');
    }
  }

  if (global.mergeRecommendations.doNotMerge.length > 0) {
    lines.push('### ❌ DO NOT MERGE (High Risk)');
    lines.push('');
    for (const rec of global.mergeRecommendations.doNotMerge) {
      lines.push(`- **${rec.run}**`);
      lines.push(`  - Risk: ${rec.riskLevel} (score ${rec.riskScore})`);
      lines.push(`  - Reason: ${rec.reason}`);
      lines.push('');
    }
  }

  if (global.mergeRecommendations.safeSameDomain.length === 0 && 
      global.mergeRecommendations.requiresDomainAlignment.length === 0) {
    lines.push('*No merge recommendations generated. Review individual run details below.*');
    lines.push('');
  }

  // Risk summary
  lines.push('## Run Risk Summary');
  lines.push('');
  const sorted = [...runs].sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  for (const r of sorted) {
    lines.push(`### ${r.name}`);
    lines.push('');
    if (!r.valid) {
      lines.push('- **Status:** INVALID');
      lines.push('- **Reason:** ' + (r.reason || 'unknown'));
      lines.push('');
      continue;
    }
    lines.push(`- **Domain:** ${r.domain}`);
    lines.push(`- **Risk:** ${r.riskLevel} (score ${r.riskScore})`);
    lines.push(`- **Size:** ${formatBytes(r.sizeBytes)}`);
    lines.push(`- **Nodes:** ${formatNumber(r.nodeCount)}`);
    lines.push(`- **Edges:** ${formatNumber(r.edgeCount)}${r.invalidEdges > 0 ? ` (${r.invalidEdges} invalid)` : ''}`);
    lines.push(`- **Embedding dimension:** ${r.embeddingDim}${r.corruptEmbeddings > 0 ? ` (${r.corruptEmbeddings} corrupt)` : ''}`);
    if (r.unnormalizedEmbeddings > 0) {
      lines.push(`- **Unnormalized embeddings:** ${formatNumber(r.unnormalizedEmbeddings)}`);
    }
    lines.push(`- **Clusters:** ${r.clusters.count}`);
    lines.push(`- **Connected components:** ${r.componentCount} (largest: ${formatNumber(r.largestComponentSize)})`);
    if (r.isolatedNodes > 0) {
      lines.push(`- **Isolated nodes:** ${formatNumber(r.isolatedNodes)}`);
    }
    if (r.unconsolidatedNodes > 0) {
      lines.push(`- **Consolidation:** ${formatNumber(r.consolidatedNodes)} consolidated, ${formatNumber(r.unconsolidatedNodes)} unconsolidated`);
    }
    if (r.isPreviouslyMerged) {
      lines.push(`- **Previously merged:** Yes (${formatNumber(r.nodesWithMultipleSourceRuns)} nodes from multiple sources)`);
    }
    if (r.artifactReferenceNodes > 0) {
      lines.push(`- **Artifact references:** ${formatNumber(r.artifactReferenceNodes)} nodes`);
    }
    
    if (r.notes && r.notes.length > 0) {
      lines.push('- **Notes:**');
      for (const n of r.notes) {
        lines.push(`  - ${n}`);
      }
    }
    
    // Top 3 clusters with representatives
    if (r.clusters.summaries.length > 0) {
      lines.push('- **Top 3 clusters:**');
      const topClusters = r.clusters.summaries.slice(0, 3);
      for (const cluster of topClusters) {
        lines.push(`  - Cluster ${cluster.id} (${cluster.size} nodes):`);
        if (cluster.topActivation) {
          lines.push(`    - Top activation: "${cluster.topActivation.concept}" (${cluster.topActivation.activation.toFixed(4)})`);
        }
        if (cluster.topDegree) {
          lines.push(`    - Hub node: "${cluster.topDegree.concept}" (degree ${cluster.topDegree.degree})`);
        }
        if (cluster.centroidClosest) {
          lines.push(`    - Semantic core: "${cluster.centroidClosest.concept}" (sim ${cluster.centroidClosest.similarityToClusterCentroid.toFixed(4)})`);
        }
      }
    }
    
    // Tag distribution
    if (r.tags && r.tags.length > 0) {
      const topTags = r.tags.slice(0, 5).map(t => `${t.tag} (${formatNumber(t.count)})`).join(', ');
      lines.push(`- **Top tags:** ${topTags}`);
    }
    
    lines.push('');
  }

  // Centroid similarity matrix (top 20)
  if (global.centroidSimilarity.length > 0) {
    lines.push('## Cross-Run Centroid Similarity (Top 20)');
    lines.push('');
    lines.push('| Run A | Domain A | Run B | Domain B | Similarity |');
    lines.push('|-------|----------|-------|----------|------------|');
    for (const entry of global.centroidSimilarity.slice(0, 20)) {
      lines.push(`| ${entry.runA} | ${entry.domainA} | ${entry.runB} | ${entry.domainB} | ${entry.similarity} |`);
    }
    lines.push('');
  }

  await fs.writeFile(outMdPath, lines.join('\n'), 'utf8');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  
  const logger = new Logger(verbose);
  logger.info('Starting COSMO ultra-scan over runs/');

  const stateLoader = new StateLoader(logger, CONFIG.runsDir);
  
  let discovered;
  try {
    discovered = await stateLoader.discoverRuns();
  } catch (error) {
    logger.error('Failed to discover runs', error);
    process.exit(1);
  }

  if (!discovered.length) {
    logger.error('No runs found in runs/ directory');
    process.exit(1);
  }

  logger.info(`Found ${discovered.length} run(s). Analyzing...`);

  const analyses = [];
  for (const run of discovered) {
    logger.info(`Analyzing: ${run.name}`);
    try {
      const analysis = await analyzeRun(logger, stateLoader, run);
      analyses.push(analysis);
    } catch (err) {
      logger.error(`Failed to analyze run ${run.name}`, err);
      analyses.push({
        name: run.name,
        valid: false,
        reason: 'exception',
        error: err.message
      });
    }
  }

  logger.info('Computing global analysis...');
  const global = computeGlobalAnalysis(analyses);

  logger.info('Writing reports...');
  await writeReports(CONFIG.runsDir, analyses, global);

  logger.info(`\n✓ Scan complete in ${logger.elapsed()}`);
  logger.info('Reports written to:');
  logger.info(`  - ${path.join(CONFIG.runsDir, 'SCAN_REPORT.json')}`);
  logger.info(`  - ${path.join(CONFIG.runsDir, 'SCAN_REPORT.md')}`);
  
  // Summary stats
  const validRuns = analyses.filter(r => r.valid);
  const highRisk = validRuns.filter(r => r.riskLevel === 'HIGH');
  const moderateRisk = validRuns.filter(r => r.riskLevel === 'MODERATE');
  const safeRuns = validRuns.filter(r => r.riskLevel === 'SAFE');
  
  logger.info('');
  logger.info('Summary:');
  logger.info(`  Valid runs: ${validRuns.length}`);
  logger.info(`  Safe: ${safeRuns.length}, Moderate risk: ${moderateRisk.length}, High risk: ${highRisk.length}`);
  logger.info(`  Merge recommendations: ${global.mergeRecommendations.safeSameDomain.length} safe, ${global.mergeRecommendations.requiresDomainAlignment.length} need domain alignment, ${global.mergeRecommendations.doNotMerge.length} do not merge`);
}

// Run
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error in scan_runs.js:', err);
    process.exit(1);
  });
}

module.exports = { analyzeRun, computeGlobalAnalysis };

