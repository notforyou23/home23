/**
 * COSMO Merge V2 - Hub Adapter
 *
 * Provides backward-compatible MergeEngine API while using V2 internals.
 * This adapter allows the Hub to use V2 merge without code changes.
 *
 * Key differences from old merge_runs.js:
 * - Uses V2's semantic domain embeddings + ANN indexing for memory
 * - Ports goals/journal merging from old implementation
 * - Maintains exact same API surface for Hub compatibility
 * - Provides full provenance tracking
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { StateCompression } = require('../core/state-compression');
const { mergeRuns, POLICIES, DEFAULT_OPTIONS } = require('./index');

// ============================================================================
// Configuration Constants
// ============================================================================

const CONFIG = {
  defaultThreshold: 0.85,
  defaultJournalLimit: 10000,
  maxMemoryNodes: 50000, // Safety validation limit
  batchSize: 100
};

// ============================================================================
// Helper Functions
// ============================================================================

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

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
      const from = edge.source || edge.from;
      const to = edge.target || edge.to;
      if (!nodeIds.has(from) || !nodeIds.has(to)) {
        invalidEdges.push(`${from}->${to}`);
      }
    }
    if (invalidEdges.length > 0) {
      warnings.push(`${invalidEdges.length} edges reference missing nodes (will be orphaned)`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
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
    progressReporter.startPhase(4, 'Archiving goals (clean slate)');

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

    // Simple text-based deduplication for archival reference
    const archived = [];
    const duplicates = [];

    for (let i = 0; i < allGoals.length; i++) {
      const goal = allGoals[i];

      let isDuplicate = false;
      for (const archivedGoal of archived) {
        const similarity = this.goalSimilarity(goal.concept || goal.description || '',
                                                archivedGoal.concept || archivedGoal.description || '');

        if (similarity >= 0.8) {
          isDuplicate = true;
          duplicates.push(goal);

          // Track all source runs for duplicates
          if (!archivedGoal.sourceRuns) {
            archivedGoal.sourceRuns = [archivedGoal.sourceRun];
          }
          if (!archivedGoal.sourceRuns.includes(goal.sourceRun)) {
            archivedGoal.sourceRuns.push(goal.sourceRun);
          }

          break;
        }
      }

      if (!isDuplicate) {
        archived.push({
          ...goal,
          id: `archived_goal_${archived.length + 1}`,
          archivedAt: new Date().toISOString(),
          sourceRuns: [goal.sourceRun]
        });
      }

      progressReporter.updateProgress(i + 1, allGoals.length);
    }

    this.logger.success(`Archived ${archived.length} goals from source runs (removed ${duplicates.length} duplicates)`);
    this.logger.info('✨ Clean slate: merged brain starts with NO active goals');

    return {
      goals: [], // CLEAN SLATE: No goals in merged state
      archived: archived, // Preserved for reference
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
// Merge Engine V2 Adapter (Main Class)
// ============================================================================

/**
 * Adapter that provides old MergeEngine API while using V2 internals
 */
class MergeEngineV2Adapter {
  constructor(options = {}) {
    this.logger = new Logger(options.verbose);
    this.options = {
      threshold: options.threshold || CONFIG.defaultThreshold,
      dryRun: options.dryRun || false,
      verbose: options.verbose || false,
      conflictPolicy: options.conflictPolicy || 'BEST_REP',
      domainAlpha: options.domainAlpha || 0.15,
      annK: options.annK || 10,
      journalLimit: options.journalLimit || CONFIG.defaultJournalLimit
    };

    // Pluggable components (Hub will override these)
    this.stateLoader = null;  // Will be replaced by HubStateLoader
    this.saveMergedRun = null;  // Will be replaced by Hub's custom save
    this.saveReport = null;  // Will be replaced by Hub's custom save

    // Validation engine
    this.validator = new ValidationEngine(this.logger);

    // Component mergers
    this.goalMerger = new GoalMerger(this.logger);
    this.journalMerger = new JournalMerger(this.logger, this.options);

    // Progress reporter (Hub hooks into this for SSE)
    this.progressReporter = {
      phases: [
        'Discovering runs',
        'Loading states',
        'Validating compatibility',
        'Merging memory networks',
        'Consolidating goals',
        'Merging journals',
        'Validating merged state',
        'Saving merged run',
        'Generating report'
      ],
      startPhase: (index, message) => {
        if (this.options.verbose) {
          const phaseMsg = message || this.progressReporter.phases[index];
          console.log(`\n=== Phase ${index + 1}/${this.progressReporter.phases.length}: ${phaseMsg} ===`);
        }
      },
      updateProgress: (current, total, details) => {
        if (this.options.verbose && current % 100 === 0) {
          const percent = Math.round((current / total) * 100);
          console.log(`  Progress: ${current}/${total} (${percent}%) ${details || ''}`);
        }
      },
      complete: () => {
        if (this.options.verbose) {
          console.log(`\n✅ Merge complete in ${this.logger.elapsed()}`);
        }
      }
    };
  }

  /**
   * Execute merge (main entry point, compatible with old API)
   * @param {string[]} runNames - Brain names to merge
   * @param {string} outputName - Output brain name
   * @returns {Promise<{success: boolean, errors: string[], report: object}>}
   */
  async execute(runNames, outputName) {
    try {
      // Phase 1: Load states
      this.progressReporter.startPhase(1, 'Loading states');

      if (!this.stateLoader) {
        return {
          success: false,
          errors: ['No state loader configured. Hub should set engine.stateLoader.']
        };
      }

      const loadedStates = await this.stateLoader.loadMultiple(runNames);
      this.logger.success(`Loaded ${loadedStates.length} run states`);

      // Phase 2: Validate pre-merge
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

      // Phase 3: Merge memory using V2
      this.progressReporter.startPhase(3, 'Merging memory networks');

      const { brain, metrics } = await mergeRuns(loadedStates, {
        threshold: this.options.threshold,
        conflictPolicy: this.options.conflictPolicy,
        domainAlpha: this.options.domainAlpha,
        annK: this.options.annK,
        logger: {
          info: (msg) => this.logger.info(msg),
          warn: (msg) => this.logger.warn(msg),
          error: (msg) => this.logger.error(msg)
        }
      });

      this.logger.success(`V2 merge complete: ${brain.nodes.length} nodes, ${brain.edges.length} edges`);

      // Phase 4: Merge goals
      const goalResult = await this.goalMerger.merge(loadedStates, this.progressReporter);

      // Phase 5: Merge journal
      const journal = await this.journalMerger.merge(loadedStates, this.progressReporter);

      // Build complete merged state
      const mergedState = this.buildMergedState(loadedStates, brain, goalResult, journal, metrics);

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

      // Prepare merge details for save hooks
      const validStates = loadedStates.filter(s => s.valid);
      const totalNodes = validStates.reduce((sum, s) =>
        sum + (s.state?.memory?.nodes?.length || 0), 0
      );

      const mergeDetails = {
        memory: {
          duplicates: totalNodes - brain.nodes.length,
          deduplicationStats: {
            nodes: {
              total: totalNodes,
              merged: brain.nodes.length,
              removed: totalNodes - brain.nodes.length
            }
          },
          confidenceReport: metrics.provenanceStats
        },
        goals: {
          duplicates: goalResult.duplicates,
          archived: goalResult.archived,
          archivedCount: goalResult.archived.length,
          activeCount: 0 // Clean slate
        },
        journal
      };

      // Phase 7: Save merged run (if not dry run)
      if (!this.options.dryRun) {
        this.progressReporter.startPhase(7, 'Saving merged run');

        if (this.saveMergedRun) {
          await this.saveMergedRun(outputName, mergedState, loadedStates, mergeDetails);
        } else {
          this.logger.warn('No saveMergedRun function provided - skipping save');
        }

        // Save archived goals to reference file
        if (goalResult.archived.length > 0) {
          this.logger.info(`Saving ${goalResult.archived.length} archived goals for reference...`);
          // This will be saved by Hub's saveMergedRun override
        }
      } else {
        this.logger.info('\nDry run mode - no files written');
      }

      // Phase 8: Generate report
      this.progressReporter.startPhase(8, 'Generating report');
      const report = this.generateReport(loadedStates, mergedState, mergeDetails);

      if (!this.options.dryRun && this.saveReport) {
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
   * Build complete COSMO merged state from V2 brain and merged components
   * This transforms V2's minimal brain structure into full COSMO format
   */
  buildMergedState(loadedStates, brain, goalResult, journal, metrics) {
    const validStates = loadedStates.filter(s => s.valid);
    const firstState = validStates[0].state;
    const mergeTimestamp = new Date().toISOString();

    // Build domain lookup from loaded states
    const domainLookup = new Map();
    for (const loaded of validStates) {
      const domain = loaded.metadata?.domain || 'unknown';
      domainLookup.set(loaded.name, domain);
    }

    // Artifact reference tags (nodes that point to files from parent runs)
    const ARTIFACT_REFERENCE_TAGS = [
      'code_creation_output_files',
      'code_execution_output_files',
      'document_metadata',
      'document_metadata_summary'
    ];

    // Transform V2 nodes to full COSMO format
    const nodes = brain.nodes.map(node => {
      const isArtifactReference = ARTIFACT_REFERENCE_TAGS.includes(node.tag);

      // Infer domain from sourceRun
      const domain = node.sourceRun ? domainLookup.get(node.sourceRun) || 'unknown' : 'unknown';

      return {
        id: node.id,
        concept: node.concept,
        embedding: node.embedding,
        activation: 0, // Reset for fresh start
        weight: node.weight || 1,
        cluster: null, // Will be reassigned by COSMO
        tag: node.tag || 'general',
        domain,
        created: node.created,
        accessed: node.accessed || new Date(),
        accessCount: node.accessCount || 0,
        sourceRuns: node.sourceRuns || [node.sourceRun],
        consolidatedAt: node.consolidatedAt || mergeTimestamp,
        mergedAt: mergeTimestamp,
        inheritedArtifact: isArtifactReference ? true : undefined,

        // V2-specific: preserve provenance
        provenance: node.provenance,
        originalId: node.originalId,
        sourceRun: node.sourceRun,
        runPrefix: node.runPrefix
      };
    });

    // Transform V2 edges to COSMO format
    const edges = brain.edges.map(edge => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight || 1,
      type: edge.type || 'associative',
      created: edge.created || mergeTimestamp,
      accessed: edge.accessed
    }));

    // Build full COSMO state structure
    return {
      cycleCount: 0, // Fresh start
      journal: journal.slice(0, 100), // Keep last 100 for journal
      thoughtHistory: journal, // Full history
      lastSummarization: 0,
      timestamp: mergeTimestamp,

      memory: {
        nodes,
        edges,
        clusters: [], // Will be rebuilt by COSMO
        nextNodeId: nodes.length + 1,
        nextClusterId: 1
      },

      goals: goalResult.goals,

      // Preserve structure from first run (or use defaults)
      roles: firstState.roles || {},
      reflection: firstState.reflection || {},
      oscillator: firstState.oscillator || {},
      coordinator: { reviewHistory: [], lastReview: 0 },
      agentExecutor: { completedAgents: [], activeAgents: [] },
      forkSystem: firstState.forkSystem || {},
      topicQueue: { pending: [], processed: [] },
      goalCurator: { campaigns: [], lastCuration: 0 },
      evaluation: { metrics: {}, timeseries: [] },

      // V2-specific metadata
      mergeVersion: 2,
      mergeSeed: brain.mergeSeed,
      domains: brain.domains,
      domainRegistry: brain.domainRegistry
    };
  }

  /**
   * Generate merge report in old format
   */
  generateReport(loadedStates, mergedState, mergeDetails) {
    const validStates = loadedStates.filter(s => s.valid);

    const totalNodes = validStates.reduce((sum, s) =>
      sum + (s.state?.memory?.nodes?.length || 0), 0
    );
    const totalEdges = validStates.reduce((sum, s) =>
      sum + (s.state?.memory?.edges?.length || 0), 0
    );
    const totalGoals = validStates.reduce((sum, s) => {
      const goals = s.state?.goals;
      if (!goals) return sum;
      if (Array.isArray(goals)) return sum + goals.length;
      // Object format
      return sum + (goals.active?.length || 0) + (goals.completed?.length || 0);
    }, 0);

    const report = {
      timestamp: new Date().toISOString(),
      mergeTime: this.logger.elapsed(),
      sourceRuns: validStates.map(s => ({
        name: s.name,
        cycles: s.state?.cycleCount || 0,
        nodes: s.state?.memory?.nodes?.length || 0,
        edges: s.state?.memory?.edges?.length || 0,
        goals: Array.isArray(s.state?.goals)
          ? s.state.goals.length
          : (s.state?.goals?.active?.length || 0) + (s.state?.goals?.completed?.length || 0),
        domain: s.metadata?.domain || 'unknown'
      })),
      mergedState: {
        nodes: mergedState.memory.nodes.length,
        edges: mergedState.memory.edges.length,
        goals: 0, // Clean slate: no active goals
        journalEntries: mergedState.thoughtHistory.length,
        cleanSlate: true // Indicates fresh start for goals
      },
      deduplication: {
        nodes: {
          total: totalNodes,
          merged: mergedState.memory.nodes.length,
          removed: mergeDetails.memory.duplicates,
          rate: totalNodes > 0
            ? `${((mergeDetails.memory.duplicates / totalNodes) * 100).toFixed(1)}%`
            : '0%'
        },
        edges: {
          total: totalEdges,
          merged: mergedState.memory.edges.length,
          removed: totalEdges - mergedState.memory.edges.length
        },
        goals: {
          total: totalGoals,
          merged: 0, // Clean slate
          archived: mergeDetails.goals.archivedCount,
          removed: mergeDetails.goals.duplicates,
          note: 'Goals archived for reference - merged brain starts with clean slate'
        }
      },
      statistics: {
        nodes: {
          total: totalNodes,
          merged: mergedState.memory.nodes.length,
          removed: mergeDetails.memory.duplicates,
          rate: totalNodes > 0
            ? `${((mergeDetails.memory.duplicates / totalNodes) * 100).toFixed(1)}%`
            : '0%'
        },
        edges: {
          total: totalEdges,
          merged: mergedState.memory.edges.length
        },
        goals: {
          total: totalGoals,
          activeInMerge: 0, // Clean slate
          archived: mergeDetails.goals.archivedCount,
          removed: mergeDetails.goals.duplicates,
          cleanSlate: true
        }
      },
      confidenceAnalysis: mergeDetails.memory.confidenceReport,
      sources: validStates.map(s => ({ name: s.name }))
    };

    return report;
  }

  /**
   * Copy work artifacts from source runs to output
   * This method is called from Hub's saveMergedRun override
   */
  async copyWorkArtifacts(loadedStates, outputDir) {
    const summary = {};
    const totals = {
      fileCount: 0,
      directoriesCopied: 0,
      filesCopied: 0,
      sourcesProcessed: 0
    };

    this.logger.info('\n📁 Copying work artifacts from source runs...');

    for (const loaded of loadedStates.filter(s => s.valid)) {
      const sourceName = loaded.name;
      const sourcePath = loaded.path;

      if (!sourcePath) {
        this.logger.warn(`  ⚠️  No path for ${sourceName}, skipping artifacts`);
        continue;
      }

      this.logger.info(`\n  Source: ${sourceName}`);

      summary[sourceName] = await this.copyRunArtifacts(
        sourcePath,
        outputDir,
        sourceName,
        totals
      );

      totals.sourcesProcessed++;
    }

    this.logger.success(`\n✅ Work artifacts copied: ${totals.filesCopied} files from ${totals.sourcesProcessed} sources`);

    return { summary, totals };
  }

  /**
   * Copy artifacts from a single source run
   */
  async copyRunArtifacts(sourcePath, destPath, sourceName, totals) {
    const stats = {};

    // Check if source exists
    const fsSync = require('fs');
    if (!fsSync.existsSync(sourcePath)) {
      this.logger.warn(`    ⚠️  Source path not found: ${sourcePath}`);
      return stats;
    }

    // Copy outputs directory (agent deliverables)
    await this.tryCopyDir(
      path.join(sourcePath, 'outputs'),
      path.join(destPath, 'outputs'),
      'outputs',
      stats,
      totals
    );

    // Copy coordinator files
    await this.tryCopyDirMerge(
      path.join(sourcePath, 'coordinator'),
      path.join(destPath, 'coordinator'),
      'coordinator',
      stats,
      totals
    );

    // Copy agent files
    await this.tryCopyDirMerge(
      path.join(sourcePath, 'agents'),
      path.join(destPath, 'agents'),
      'agents',
      stats,
      totals
    );

    // Copy plans
    await this.tryCopyFile(
      path.join(sourcePath, 'guided-plan.md'),
      path.join(destPath, 'plans-archive', `${sourceName}_guided-plan.md`),
      'guidedPlan',
      stats,
      totals
    );

    // Copy progress files
    await this.tryCopyFile(
      path.join(sourcePath, 'cosmo-progress.md'),
      path.join(destPath, 'progress-archive', `${sourceName}_cosmo-progress.md`),
      'progress',
      stats,
      totals
    );

    return stats;
  }

  async tryCopyDir(srcDir, destDir, label, stats, totals) {
    try {
      const fsSync = require('fs');
      if (!fsSync.existsSync(srcDir)) {
        return;
      }

      const count = await this.countFiles(srcDir);
      if (count === 0) {
        return;
      }

      await this.copyDirectory(srcDir, destDir);

      this.logger.debug(`    ✓ ${label} (${count} files)`);
      stats[label] = count;
      totals.filesCopied += count;
      totals.directoriesCopied++;
    } catch (error) {
      this.logger.warn(`    ⚠️  Failed to copy ${label}: ${error.message}`);
      stats[label] = 0;
    }
  }

  async tryCopyDirMerge(srcDir, destDir, label, stats, totals) {
    // Same as tryCopyDir for now (could merge conflicting files)
    await this.tryCopyDir(srcDir, destDir, label, stats, totals);
  }

  async tryCopyFile(srcFile, destFile, label, stats, totals) {
    try {
      const fsSync = require('fs');
      if (!fsSync.existsSync(srcFile)) {
        return;
      }

      await fs.mkdir(path.dirname(destFile), { recursive: true });
      await fs.copyFile(srcFile, destFile);

      this.logger.debug(`    ✓ ${label}`);
      stats[label] = 1;
      totals.filesCopied++;
    } catch (error) {
      this.logger.warn(`    ⚠️  Failed to copy ${label}: ${error.message}`);
      stats[label] = 0;
    }
  }

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

  async countFiles(dir) {
    const fsSync = require('fs');

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
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  MergeEngineV2Adapter,
  // Export for compatibility if needed
  MergeEngine: MergeEngineV2Adapter
};
