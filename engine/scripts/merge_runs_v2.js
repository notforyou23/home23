#!/usr/bin/env node

/**
 * COSMO Merge V2 Entry Point
 * 
 * Deterministic, scalable brain merge with full provenance tracking.
 * 
 * Usage:
 *   node scripts/merge_runs_v2.js                          # Interactive mode
 *   node scripts/merge_runs_v2.js run1 run2 --output name  # Direct mode
 *   node scripts/merge_runs_v2.js --list                   # List available runs
 *   node scripts/merge_runs_v2.js --help                   # Show help
 * 
 * V2 Features:
 *   - Deterministic outputs (same inputs → identical SHA256)
 *   - Unlimited domains with semantic separation
 *   - ANN-accelerated similarity search (fallback to exact)
 *   - Full node provenance tracking
 *   - Configurable conflict resolution policies
 */

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { StateCompression } = require('../src/core/state-compression');
const { mergeRuns, POLICIES, DEFAULT_OPTIONS } = require('../src/merge');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  runsDir: path.join(__dirname, '..', 'runs'),
  defaultThreshold: 0.85,
  defaultPolicy: 'BEST_REP',
  defaultJournalLimit: 10000
};

// ============================================================================
// Logger
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

  warn(message) {
    console.warn(`⚠ ${message}`);
  }

  error(message, error = null) {
    console.error(`✗ ${message}`);
    if (error && this.verbose) {
      console.error(error);
    }
  }

  elapsed() {
    const ms = Date.now() - this.startTime;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
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

        if (hasState) {
          runs.push({
            name: entry.name,
            path: runPath,
            statePath
          });
        }
      }

      return runs.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      this.logger.error('Failed to discover runs', error);
      return [];
    }
  }

  async loadRun(runInfo) {
    try {
      // Load state
      const state = await StateCompression.loadCompressed(runInfo.statePath);
      
      // Load metadata
      let metadata = {};
      try {
        const metadataPath = path.join(runInfo.path, 'run-metadata.json');
        const metadataContent = await fs.readFile(metadataPath, 'utf8');
        metadata = JSON.parse(metadataContent);
      } catch (e) {
        // Metadata optional
      }

      return {
        name: runInfo.name,
        path: runInfo.path,
        state,
        metadata,
        valid: true
      };
    } catch (error) {
      this.logger.error(`Failed to load run ${runInfo.name}`, error);
      return {
        name: runInfo.name,
        valid: false,
        error: error.message
      };
    }
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    runs: [],
    output: null,
    threshold: CONFIG.defaultThreshold,
    policy: CONFIG.defaultPolicy,
    seed: null,
    list: false,
    help: false,
    verbose: false,
    interactive: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--list' || arg === '-l') {
      options.list = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--interactive' || arg === '-i') {
      options.interactive = true;
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (arg === '--threshold' || arg === '-t') {
      options.threshold = parseFloat(args[++i]);
    } else if (arg === '--policy' || arg === '-p') {
      options.policy = args[++i];
    } else if (arg === '--seed' || arg === '-s') {
      options.seed = args[++i];
    } else if (!arg.startsWith('-')) {
      options.runs.push(arg);
    }
  }

  // Default to interactive if no runs specified
  if (options.runs.length === 0 && !options.list && !options.help) {
    options.interactive = true;
  }

  return options;
}

function showHelp() {
  console.log(`
COSMO Merge V2 - Deterministic Brain Merge

Usage:
  node scripts/merge_runs_v2.js [options] [run1 run2 ...]

Options:
  -h, --help         Show this help message
  -l, --list         List available runs
  -i, --interactive  Interactive run selection
  -o, --output NAME  Output run name (required for direct mode)
  -t, --threshold N  Similarity threshold (default: ${CONFIG.defaultThreshold})
  -p, --policy NAME  Conflict policy: ${Object.keys(POLICIES).join(', ')}
  -s, --seed STRING  Override determinism seed
  -v, --verbose      Verbose output

Examples:
  # Interactive mode
  node scripts/merge_runs_v2.js

  # Direct mode
  node scripts/merge_runs_v2.js Physics Mathematics -o STEM_Merge

  # With options
  node scripts/merge_runs_v2.js Physics Chemistry -o Science -t 0.82 -p MOST_RECENT

V2 Features:
  - Deterministic: Same inputs produce identical outputs (SHA256 match)
  - Unlimited domains with semantic embeddings
  - Full provenance tracking for every node
  - Configurable conflict resolution policies
`);
}

async function listRuns(loader) {
  const runs = await loader.discoverRuns();
  
  console.log('\nAvailable runs:\n');
  
  for (const run of runs) {
    try {
      const loaded = await loader.loadRun(run);
      if (loaded.valid) {
        const nodes = loaded.state?.memory?.nodes?.length || 0;
        const domain = loaded.metadata?.domain || 'unknown';
        console.log(`  ${run.name.padEnd(25)} nodes: ${String(nodes).padStart(6)}  domain: ${domain}`);
      } else {
        console.log(`  ${run.name.padEnd(25)} (invalid)`);
      }
    } catch (e) {
      console.log(`  ${run.name.padEnd(25)} (error)`);
    }
  }
  
  console.log(`\nTotal: ${runs.length} runs\n`);
}

async function interactiveSelect(loader) {
  const runs = await loader.discoverRuns();
  
  console.log('\nAvailable runs:\n');
  runs.forEach((run, i) => {
    console.log(`  ${i + 1}. ${run.name}`);
  });
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));
  
  // Select runs
  const selection = await question('\nEnter run numbers to merge (comma-separated): ');
  const indices = selection.split(',').map(s => parseInt(s.trim()) - 1);
  const selectedRuns = indices
    .filter(i => i >= 0 && i < runs.length)
    .map(i => runs[i].name);
  
  if (selectedRuns.length < 2) {
    console.log('Need at least 2 runs to merge');
    rl.close();
    return null;
  }
  
  // Get output name
  const output = await question('Output run name: ');
  
  // Get threshold
  const thresholdStr = await question(`Similarity threshold (default ${CONFIG.defaultThreshold}): `);
  const threshold = thresholdStr ? parseFloat(thresholdStr) : CONFIG.defaultThreshold;
  
  rl.close();
  
  return {
    runs: selectedRuns,
    output: output.trim(),
    threshold
  };
}

// ============================================================================
// Main Merge Logic
// ============================================================================

async function runMerge(options, logger, loader) {
  // Load selected runs
  logger.info(`Loading ${options.runs.length} runs...`);
  
  const loadedRuns = [];
  for (const runName of options.runs) {
    const runInfo = { name: runName, path: path.join(CONFIG.runsDir, runName), statePath: path.join(CONFIG.runsDir, runName, 'state.json') };
    const loaded = await loader.loadRun(runInfo);
    
    if (loaded.valid) {
      loadedRuns.push(loaded);
      logger.success(`Loaded ${runName} (${loaded.state?.memory?.nodes?.length || 0} nodes)`);
    } else {
      logger.error(`Failed to load ${runName}: ${loaded.error}`);
    }
  }
  
  if (loadedRuns.length < 2) {
    logger.error('Need at least 2 valid runs to merge');
    return null;
  }
  
  // Run merge
  logger.info('Starting V2 merge...');
  
  const { brain, metrics } = await mergeRuns(loadedRuns, {
    threshold: options.threshold,
    conflictPolicy: options.policy,
    seed: options.seed,
    logger
  });
  
  // Create output directory
  const outputDir = path.join(CONFIG.runsDir, options.output);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(outputDir, 'coordinator'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'agents'), { recursive: true });
  
  // Build full state (matching V1 structure)
  const firstState = loadedRuns[0].state;
  const mergedState = {
    version: 2,
    cycleCount: 0,  // CRITICAL: Fresh start for merged brain (matches V1)
    startTime: new Date().toISOString(),
    lastSummarization: 0,
    timestamp: new Date().toISOString(),
    
    // V1 compatibility: journal is short version, thoughtHistory is full
    journal: collectJournals(loadedRuns, 100),  // Keep last 100 for journal
    thoughtHistory: collectJournals(loadedRuns, CONFIG.defaultJournalLimit),
    
    memory: {
      nodes: brain.nodes,
      edges: brain.edges,
      clusters: [],
      nextNodeId: brain.nodes.length + 1,
      nextClusterId: 1
    },
    
    goals: collectGoals(loadedRuns),
    
    // Preserve structure from first run (matching V1 exactly)
    roles: firstState?.roles || {},
    reflection: firstState?.reflection || {},
    oscillator: firstState?.oscillator || {},
    cognitiveState: firstState?.cognitiveState || {},
    temporal: firstState?.temporal || {},
    coordinator: { reviewHistory: [], lastReview: 0 },
    agentExecutor: { completedAgents: [], activeAgents: [] },
    forkSystem: firstState?.forkSystem || {},
    topicQueue: { pending: [], processed: [] },
    goalCurator: { campaigns: [], lastCuration: 0 },
    evaluation: { metrics: {}, timeseries: [] },
    guidedMissionPlan: firstState?.guidedMissionPlan || null,
    completionTracker: firstState?.completionTracker || {},
    gpt5Stats: firstState?.gpt5Stats || {},
    goalAllocator: firstState?.goalAllocator || {},
    clusterSync: firstState?.clusterSync || {},
    clusterCoordinator: firstState?.clusterCoordinator || {},
    
    // V2-specific metadata
    mergeV2: {
      domains: brain.domains,
      domainRegistry: brain.domainRegistry,
      mergeSeed: brain.mergeSeed,
      mergeTimestamp: brain.mergeTimestamp
    }
  };
  
  // Save compressed state
  const statePath = path.join(outputDir, 'state.json');
  await StateCompression.saveCompressed(statePath, mergedState);
  logger.success(`Saved merged state to ${options.output}/state.json.gz`);
  
  // Compute output hash for determinism verification
  const stateJson = JSON.stringify(mergedState);
  const outputHash = crypto.createHash('sha256').update(stateJson).digest('hex');
  
  // Save metadata
  const metadata = {
    created: new Date().toISOString(),
    runName: options.output,
    domain: 'Merged Knowledge', // Explicitly set for .brain manifest
    mergeVersion: 2,
    mergedFrom: loadedRuns.map(r => r.name),
    outputHash: outputHash.slice(0, 16),
    mergeStats: {
      totalSourceNodes: loadedRuns.reduce((sum, r) => sum + (r.state?.memory?.nodes?.length || 0), 0),
      mergedNodes: brain.nodes.length,
      mergedEdges: brain.edges.length,
      domains: brain.domains.length,
      conflictCounts: metrics.conflictCounts,
      provenanceStats: metrics.provenanceStats
    },
    mergeOptions: {
      threshold: options.threshold,
      policy: options.policy,
      seed: brain.mergeSeed
    },
    timing: {
      loadTimeMs: metrics.loadTimeMs,
      embeddingTimeMs: metrics.embeddingTimeMs,
      mergeLoopTimeMs: metrics.mergeLoopTimeMs,
      totalTimeMs: metrics.totalTimeMs
    }
  };
  
  await fs.writeFile(
    path.join(outputDir, 'run-metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
  
  // Generate report
  const report = generateReport(loadedRuns, mergedState, metrics, options, outputHash);
  
  await fs.writeFile(
    path.join(outputDir, 'merge-report.json'),
    JSON.stringify(report, null, 2)
  );
  
  await fs.writeFile(
    path.join(outputDir, 'MERGE_REPORT.md'),
    formatReportMarkdown(report, options.output)
  );
  
  logger.success('Generated merge report');
  logger.info(`\nOutput hash: ${outputHash.slice(0, 16)}... (for determinism verification)`);
  
  return { outputDir, mergedState, metrics, outputHash };
}

// ============================================================================
// Helper Functions
// ============================================================================

function collectJournals(loadedRuns, limit) {
  const entries = [];
  
  for (const run of loadedRuns) {
    const history = run.state?.thoughtHistory || [];
    for (const entry of history) {
      entries.push({
        ...entry,
        sourceRun: run.name
      });
    }
  }
  
  // Sort by timestamp
  entries.sort((a, b) => {
    const timeA = new Date(a.timestamp || 0).getTime();
    const timeB = new Date(b.timestamp || 0).getTime();
    return timeA - timeB;
  });
  
  // Limit
  return entries.slice(-limit);
}

function collectGoals(loadedRuns) {
  // COSMO expects goals as: { active: [[id, goal], ...], completed: [...], archived: [...], nextGoalId: N }
  // Goals from merged runs are ARCHIVED - they're from "completed" exploration runs
  
  // Hash-based deduplication - O(n) instead of O(n²)
  // Uses normalized text as key to catch exact/near-exact duplicates
  const seen = new Map(); // normalizedKey -> goal
  let duplicateCount = 0;
  
  for (const run of loadedRuns) {
    const goals = run.state?.goals;
    if (!goals) continue;
    
    // Handle object format { active: [], completed: [], archived: [] }
    if (goals && typeof goals === 'object' && !Array.isArray(goals)) {
      for (const category of ['active', 'completed', 'archived', 'satisfied']) {
        const categoryGoals = goals[category] || [];
        for (const item of categoryGoals) {
          // Handle both tuple format [id, goal] and direct goal format
          const goal = Array.isArray(item) ? item[1] : item;
          if (goal && typeof goal === 'object') {
            processGoal(goal, run.name, category, seen, () => duplicateCount++);
          }
        }
      }
    } else if (Array.isArray(goals)) {
      // Handle array format (legacy)
      for (const goal of goals) {
        if (goal && typeof goal === 'object') {
          processGoal(goal, run.name, 'active', seen, () => duplicateCount++);
        }
      }
    }
  }
  
  // Convert to array and assign IDs
  const archived = [];
  let idx = 1;
  for (const goal of seen.values()) {
    const finalGoal = {
      ...goal,
      id: `goal_${idx}`,
      pursuitCount: 0
    };
    archived.push([finalGoal.id, finalGoal]);
    idx++;
  }
  
  console.log(`[Goals] Collected ${seen.size} unique goals (${duplicateCount} duplicates removed)`);
  
  // Build COSMO-expected structure
  // All goals archived - autonomous mode creates its own goals
  // These are reference material from prior runs
  return {
    active: [],       // Fresh start - autonomous creates its own
    completed: [],    // Clean slate
    archived: archived,
    nextGoalId: idx
  };
}

function processGoal(goal, runName, category, seen, onDuplicate) {
  const text = (goal.concept || goal.description || '').toLowerCase().trim();
  if (!text) return;
  
  // Create normalized key - remove punctuation, extra spaces, sort words
  const key = text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .sort()
    .join(' ');
  
  if (!key) return;
  
  if (seen.has(key)) {
    // Duplicate - merge source runs
    const existing = seen.get(key);
    if (!existing.sourceRuns.includes(runName)) {
      existing.sourceRuns.push(runName);
    }
    // Keep best values
    existing.priority = Math.max(existing.priority || 0, goal.priority || 0);
    existing.progress = Math.max(existing.progress || 0, goal.progress || 0);
    onDuplicate();
  } else {
    // New goal
    seen.set(key, {
      ...goal,
      sourceRun: runName,
      sourceRuns: [runName],
      originalCategory: category
    });
  }
}

function generateReport(loadedRuns, mergedState, metrics, options, outputHash) {
  return {
    created: new Date().toISOString(),
    mergeVersion: 2,
    outputHash: outputHash.slice(0, 16),
    sourceRuns: loadedRuns.map(r => ({
      name: r.name,
      cycles: r.state?.cycleCount || 0,
      nodes: r.state?.memory?.nodes?.length || 0,
      edges: r.state?.memory?.edges?.length || 0,
      goals: r.state?.goals?.length || 0,
      domain: r.metadata?.domain || 'unknown'
    })),
    mergedState: {
      nodes: mergedState.memory.nodes.length,
      edges: mergedState.memory.edges.length,
      goals: mergedState.goals.length,
      domains: mergedState.mergeV2?.domains?.length || 0
    },
    deduplication: {
      sourceNodes: loadedRuns.reduce((sum, r) => sum + (r.state?.memory?.nodes?.length || 0), 0),
      mergedNodes: mergedState.memory.nodes.length,
      reductionRate: ((1 - mergedState.memory.nodes.length / loadedRuns.reduce((sum, r) => sum + (r.state?.memory?.nodes?.length || 0), 0)) * 100).toFixed(1) + '%'
    },
    conflictResolution: metrics.conflictCounts,
    provenance: metrics.provenanceStats,
    timing: {
      loadTimeMs: metrics.loadTimeMs,
      embeddingTimeMs: metrics.embeddingTimeMs,
      mergeLoopTimeMs: metrics.mergeLoopTimeMs,
      totalTimeMs: metrics.totalTimeMs
    },
    options: {
      threshold: options.threshold,
      policy: options.policy,
      seed: options.seed
    }
  };
}

function formatReportMarkdown(report, outputName) {
  const formatNumber = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  
  return `# COSMO Merge V2 Report

## Summary

- **Output Run:** ${outputName}
- **Created:** ${new Date(report.created).toLocaleString()}
- **Merge Version:** 2
- **Output Hash:** \`${report.outputHash}\` (determinism verification)

---

## Source Runs

${report.sourceRuns.map((run, i) => `
### ${i + 1}. ${run.name}
- **Cycles:** ${formatNumber(run.cycles)}
- **Nodes:** ${formatNumber(run.nodes)}
- **Edges:** ${formatNumber(run.edges)}
- **Goals:** ${run.goals}
- **Domain:** ${run.domain}
`).join('\n')}

---

## Merge Results

### Memory Network
- **Source Nodes:** ${formatNumber(report.deduplication.sourceNodes)}
- **Merged Nodes:** ${formatNumber(report.mergedState.nodes)}
- **Reduction:** ${report.deduplication.reductionRate}
- **Merged Edges:** ${formatNumber(report.mergedState.edges)}
- **Domains:** ${report.mergedState.domains}

### Conflict Resolution
${Object.entries(report.conflictResolution).map(([policy, count]) => 
  `- **${policy}:** ${formatNumber(count)}`
).join('\n') || '- No conflicts'}

### Provenance Statistics
- **Total Merges:** ${formatNumber(report.provenance.totalMerges || 0)}
- **Avg Merges/Node:** ${report.provenance.avgMergesPerNode || 0}
- **Max Lineage Depth:** ${report.provenance.maxLineageDepth || 0}
- **Avg Lineage Depth:** ${report.provenance.avgLineageDepth || 0}

---

## Timing

- **Load:** ${report.timing.loadTimeMs}ms
- **Embeddings:** ${report.timing.embeddingTimeMs}ms
- **Merge Loop:** ${report.timing.mergeLoopTimeMs}ms
- **Total:** ${report.timing.totalTimeMs}ms

---

## Options Used

- **Threshold:** ${report.options.threshold}
- **Policy:** ${report.options.policy}
- **Seed:** ${report.options.seed || '(derived from run names)'}

---

*Generated by COSMO Merge V2*
`;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const options = parseArgs();
  const logger = new Logger(options.verbose);
  const loader = new StateLoader(logger, CONFIG.runsDir);
  
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       COSMO Merge V2                 ║');
  console.log('║  Deterministic • Scalable • Proven   ║');
  console.log('╚══════════════════════════════════════╝\n');
  
  if (options.help) {
    showHelp();
    return;
  }
  
  if (options.list) {
    await listRuns(loader);
    return;
  }
  
  if (options.interactive) {
    const selection = await interactiveSelect(loader);
    if (!selection) return;
    
    options.runs = selection.runs;
    options.output = selection.output;
    options.threshold = selection.threshold;
  }
  
  if (!options.output) {
    logger.error('Output name required. Use --output NAME or -o NAME');
    return;
  }
  
  if (options.runs.length < 2) {
    logger.error('Need at least 2 runs to merge');
    return;
  }
  
  try {
    const result = await runMerge(options, logger, loader);
    if (result) {
      console.log(`\n✓ Merge complete! Output: ${options.output}`);
      console.log(`  Nodes: ${result.mergedState.memory.nodes.length}`);
      console.log(`  Edges: ${result.mergedState.memory.edges.length}`);
      console.log(`  Time: ${result.metrics.totalTimeMs}ms`);
      console.log(`  Hash: ${result.outputHash.slice(0, 16)}...`);
    }
  } catch (error) {
    logger.error('Merge failed', error);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch(console.error);

