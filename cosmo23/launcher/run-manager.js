const fs = require('fs').promises;
const path = require('path');
const { execSync, spawn } = require('child_process');
const zlib = require('zlib');
const { promisify } = require('util');
const { ConfigGenerator } = require('./config-generator');

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

/**
 * RunManager - Handles all run-related operations
 * - List runs
 * - Create new run
 * - Fork run
 * - Delete run
 * - Get run metadata and stats
 */
class RunManager {
  constructor(runsDir, logger = console, cosmoRoot = null) {
    this.runsDir = runsDir;
    this.logger = logger;
    this.cosmoRoot = cosmoRoot || path.join(__dirname, '..', '..');
  }

  /**
   * List all runs with metadata
   */
  async listRuns() {
    try {
      const entries = await fs.readdir(this.runsDir);
      const runs = [];

      for (const entry of entries) {
        const runPath = path.join(this.runsDir, entry);
        const stat = await fs.stat(runPath);

        if (stat.isDirectory()) {
          const runInfo = await this.getRunInfo(entry);
          runs.push(runInfo);
        }
      }

      // Sort by modification time (most recent first)
      runs.sort((a, b) => b.modified - a.modified);

      return runs;
    } catch (error) {
      this.logger.error('Failed to list runs:', error);
      return [];
    }
  }

  /**
   * Get detailed info about a specific run
   */
  async getRunInfo(runName) {
    const runPath = path.join(this.runsDir, runName);

    try {
      const stat = await fs.stat(runPath);
      const info = {
        name: runName,
        path: runPath,
        modified: stat.mtime.getTime(),
        modifiedDate: stat.mtime.toISOString(),
        size: await this.getDirectorySize(runPath),
        cycleCount: 0,
        mode: 'unknown',
        domain: '',
        hasState: false,
        hasMetadata: false
      };

      // Try to get cycle count from state
      const statePath = path.join(runPath, 'state.json.gz');
      try {
        await fs.access(statePath);
        info.hasState = true;
        const compressed = await fs.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());
        info.cycleCount = state.cycleCount || 0;
      } catch (e) {
        // No state file or couldn't read
      }

      // Try to get metadata
      const metadataPath = path.join(runPath, 'run-metadata.json');
      try {
        await fs.access(metadataPath);
        info.hasMetadata = true;
        const metadataContent = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataContent);
        info.mode = metadata.explorationMode || 'unknown';
        info.domain = metadata.domain || '';
        info.metadata = metadata;
      } catch (e) {
        // No metadata file
      }

      return info;
    } catch (error) {
      this.logger.error(`Failed to get info for run ${runName}:`, error);
      return null;
    }
  }

  /**
   * Create a new run
   */
  async createRun(runName) {
    const runPath = path.join(this.runsDir, runName);

    try {
      // Check if already exists
      try {
        await fs.access(runPath);
        throw new Error(`Run "${runName}" already exists`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Create run directory structure
      await fs.mkdir(runPath, { recursive: true });
      await fs.mkdir(path.join(runPath, 'coordinator'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'agents'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'outputs'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'exports'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'policies'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'training'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'ingestion', 'documents'), { recursive: true });

      this.logger.info(`Created run: ${runName}`);
      return { success: true, runName, path: runPath };
    } catch (error) {
      this.logger.error(`Failed to create run ${runName}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fork an existing run
   * @param {string} sourceRunName - Source run name
   * @param {string} newRunName - New run name
   * @param {object} options - Optional parameters
   * @param {string} options.sourcePath - Override source path (for multi-tenant)
   * @param {string} options.destPath - Override destination path (for multi-tenant)
   */
  async forkRun(sourceRunName, newRunName, options = {}) {
    // PRODUCTION: Allow path overrides for multi-tenant support
    const sourcePath = options.sourcePath || path.join(this.runsDir, sourceRunName);
    const destPath = options.destPath || path.join(this.runsDir, newRunName);

    try {
      // Verify source exists
      await fs.access(sourcePath);

      // Check dest doesn't exist
      try {
        await fs.access(destPath);
        throw new Error(`Run "${newRunName}" already exists`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Copy directory
      await this.copyDirectory(sourcePath, destPath);

      // Reset operational state if state.json.gz exists
      const statePath = path.join(destPath, 'state.json.gz');
      try {
        await fs.access(statePath);
        
        const compressed = await fs.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());

        // Capture source state for provenance tracking (BEFORE modifications)
        const sourceState = {
          cycleCount: state.cycleCount || 0,
          memoryNodeCount: state.memory?.nodes?.length || 0,
          activeGoalCount: state.goals?.active?.length || 0,
          completedGoalCount: state.goals?.completed?.length || 0
        };

        // CRITICAL: Reset cycle count to 0 (fresh start for new instance)
        // Fork preserves knowledge but starts its own lifecycle
        // This prevents misalignment with lastSleepCycle, lastReviewCycle, etc.
        state.cycleCount = 0;

        // CRITICAL: Archive ALL active goals → fresh start, don't jump back into mid-execution
        // Fork inherits the knowledge but should define NEW work
        if (state.goals && state.goals.active && state.goals.active.length > 0) {
          if (!state.goals.archived) {
            state.goals.archived = [];
          }
          this.logger.info(`Archiving ${state.goals.active.length} inherited active goals`);
          state.goals.archived.push(...state.goals.active);
          state.goals.active = [];
        }

        // Reset Meta-Coordinator state (fresh coordination, not mid-stream)
        if (state.coordinator) {
          const reviewHistory = state.coordinator.reviewHistory || [];
          state.coordinator = {
            reviewHistory: [],
            lastReview: 0,  // Critical: reset so it doesn't think it's at cycle 245
            strategicDirectives: [],
            prioritizedGoals: [],
            contextMemory: []
          };
          this.logger.info(`Reset Meta-Coordinator state (cleared ${reviewHistory.length} historical reviews)`);
        }

        // Reset Goal Curator state (fresh curation)
        if (state.goalCurator) {
          state.goalCurator = {
            campaigns: [],
            lastCuration: 0
          };
          this.logger.info('Reset Goal Curator state');
        }

        // Reset Evaluation metrics (fresh evaluation, mark inherited data)
        if (state.evaluation) {
          const oldMetrics = { ...state.evaluation.metrics };
          state.evaluation = {
            metrics: {},
            timeseries: [],
            inheritedFrom: sourceRunName,
            inheritedMetrics: oldMetrics
          };
          this.logger.info('Reset Evaluation metrics (previous metrics moved to inheritedMetrics)');
        }

        // Reset temporal/cognitive state for fresh start
        if (state.temporal) {
          state.temporal.state = 'awake';
          state.temporal.fatigue = 0;
          state.temporal.lastSleepCycle = 0;
          state.temporal.sleepCycles = 0;
        }
        if (state.cognitiveState) {
          state.cognitiveState.mode = 'active';
          state.cognitiveState.energy = 1.0;
        }

        // CRITICAL: Mark all inherited memory nodes as already consolidated
        // This prevents O(n²) re-processing of inherited memories from the source run
        const forkTimestamp = new Date().toISOString();
        if (state.memory && state.memory.nodes) {
          let markedCount = 0;
          for (const node of state.memory.nodes) {
            if (!node.consolidatedAt) {
              node.consolidatedAt = forkTimestamp;
              markedCount++;
            }
          }
          this.logger.info(`Marked ${markedCount} inherited nodes as consolidated`);
        }

        // CRITICAL: Clear existing plans for fresh planning phase
        // Fork should start with new goals, not resume parent's plan
        if (state.guidedMissionPlan) {
          state.guidedMissionPlan = null;
          this.logger.info('Cleared inherited plan - will regenerate fresh plan');
        }

        // Also clear the completionTracker to avoid stale progress tracking
        if (state.completionTracker) {
          state.completionTracker = null;
          this.logger.info('Cleared completion tracker - will start fresh');
        }

        // Save reset state
        const newStateJson = JSON.stringify(state);
        const newCompressed = await gzip(Buffer.from(newStateJson));
        
        // Backup original
        await fs.copyFile(statePath, path.join(destPath, 'state.json.gz.prefork'));
        
        // Write reset state
        await fs.writeFile(statePath, newCompressed);

        // Delete plans directory to force fresh plan generation on startup
        const plansDir = path.join(destPath, 'plans');
        try {
          await fs.rm(plansDir, { recursive: true, force: true });
          this.logger.info('Deleted inherited plans directory');
        } catch (e) {
          // Ignore if plans directory doesn't exist
        }

        // CRITICAL: Nuclear option - Delete and recreate operational directories
        // This is simpler and more reliable than trying to selectively clear files
        // We keep the directory structure but ensure NO operational state leaks through
        const dirsToRecreate = [
          path.join(destPath, 'coordinator'),  // Meta-Coordinator state, results queue, reports
          path.join(destPath, 'agents'),       // Agent execution state and results
          path.join(destPath, 'evaluation'),   // Evaluation metrics
          path.join(destPath, 'policies')      // Branch policies, task lists
        ];

        for (const dir of dirsToRecreate) {
          try {
            await fs.rm(dir, { recursive: true, force: true });
            await fs.mkdir(dir, { recursive: true });
            this.logger.debug(`Recreated directory: ${path.basename(dir)}`);
          } catch (e) {
            // Directory might not exist, that's fine
            await fs.mkdir(dir, { recursive: true }).catch(() => {});
          }
        }
        this.logger.info('Cleared persistent operational state (nuclear option - full directory reset)');

        // Create fork metadata for provenance tracking
        const forkMetadata = {
          runName: newRunName,
          sourceRun: sourceRunName,
          forkType: 'standard',
          forkTimestamp,
          sourceState,
          forkedState: {
            cycleCount: 0,
            memoryNodeCount: state.memory?.nodes?.length || 0,
            activeGoalCount: state.goals?.active?.length || 0,
            completedGoalCount: state.goals?.completed?.length || 0
          }
        };

        const metadataPath = path.join(destPath, 'run-metadata.json');
        await fs.writeFile(metadataPath, JSON.stringify(forkMetadata, null, 2));

        // CRITICAL: Clear inherited domain/context from run-metadata.json
        // Fork inherits knowledge but user should define fresh task/focus
        // This forces user to explicitly set what the fork should do
        const oldMetadataPath = path.join(destPath, 'run-metadata.json');
        try {
          const oldMetadata = JSON.parse(await fs.readFile(oldMetadataPath, 'utf8'));
          oldMetadata.domain = '';
          oldMetadata.context = '';
          oldMetadata.explorationMode = 'guided';  // Default to guided (user can change)
          oldMetadata.forkSource = sourceRunName;  // Track where it came from
          oldMetadata.forkedAt = forkTimestamp;
          await fs.writeFile(oldMetadataPath, JSON.stringify(oldMetadata, null, 2));
          this.logger.info('Cleared inherited domain/context - fork requires fresh configuration');
        } catch (e) {
          // If old metadata doesn't exist or fails to update, that's okay
          // The new fork metadata was already written above
        }

        this.logger.info(`Forked run ${sourceRunName} → ${newRunName} (state reset, cycle count: ${sourceState.cycleCount} → 0)`);
      } catch (e) {
        this.logger.info(`Forked run ${sourceRunName} → ${newRunName} (no state reset)`);
      }

      return { success: true, sourceRunName, newRunName, path: destPath };
    } catch (error) {
      this.logger.error(`Failed to fork run:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a dream fork - continuous sleep and dreaming mode
   * @param {string} sourceRunName - Source run name
   * @param {string} newRunName - New run name
   * @param {object} settings - Dream mode settings
   * @param {object} options - Optional parameters
   * @param {string} options.sourcePath - Override source path (for multi-tenant)
   * @param {string} options.destPath - Override destination path (for multi-tenant)
   */
  async createDreamFork(sourceRunName, newRunName, settings = {}, options = {}) {
    // PRODUCTION: Allow path overrides for multi-tenant support
    const sourcePath = options.sourcePath || path.join(this.runsDir, sourceRunName);
    const destPath = options.destPath || path.join(this.runsDir, newRunName);

    try {
      // Verify source exists
      await fs.access(sourcePath);

      // Check dest doesn't exist
      try {
        await fs.access(destPath);
        throw new Error(`Run "${newRunName}" already exists`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Copy directory
      await this.copyDirectory(sourcePath, destPath);

      // Clear coordinator and agents directories (no pending work in dream mode)
      const coordinatorPath = path.join(destPath, 'coordinator');
      const agentsPath = path.join(destPath, 'agents');
      try {
        await fs.rm(coordinatorPath, { recursive: true, force: true });
        await fs.mkdir(coordinatorPath, { recursive: true });
      } catch (e) {
        // Directory might not exist, that's fine
      }
      try {
        await fs.rm(agentsPath, { recursive: true, force: true });
        await fs.mkdir(agentsPath, { recursive: true });
      } catch (e) {
        // Directory might not exist, that's fine
      }

      // Modify state for dream mode if state.json.gz exists
      const statePath = path.join(destPath, 'state.json.gz');
      try {
        await fs.access(statePath);
        
        const compressed = await fs.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());

        // RESET for dream mode - fresh start that only sleeps
        // Keep: memory, journal (for consolidation context)
        // Reset: cycle count, goals (archive all), temporal state, cognitive state
        
        // Reset cycle count to 0 (fresh start)
        state.cycleCount = 0;
        
        // Archive ALL active goals (keep in state but don't pursue)
        if (state.goals && state.goals.active) {
          if (!state.goals.archived) {
            state.goals.archived = [];
          }
          // Move all active goals to archived
          state.goals.archived.push(...state.goals.active);
          state.goals.active = [];
        }
        
        // Set to sleeping state
        if (state.temporal) {
          state.temporal.state = 'sleeping';
          state.temporal.fatigue = 1.0;
          state.temporal.lastSleepCycle = 0;
          state.temporal.sleepCycles = 0;
        }
        
        if (state.cognitiveState) {
          state.cognitiveState.mode = 'sleeping';
          state.cognitiveState.energy = 0.1;
          state.cognitiveState.mood = 0.5;
          state.cognitiveState.curiosity = 0.5;
        } else {
          // Create cognitiveState if it doesn't exist
          state.cognitiveState = {
            mode: 'sleeping',
            energy: 0.1,
            mood: 0.5,
            curiosity: 0.5,
            surpriseAccumulator: 0,
            recentSuccesses: 0,
            recentFailures: 0
          };
        }

        // Clear any active agents/missions
        if (state.agents) {
          state.agents = { active: [], completed: state.agents.completed || [] };
        }

        // CRITICAL: Mark all inherited memory nodes as already consolidated
        // This prevents O(n²) re-processing of inherited memories from the source run
        const forkTimestamp = new Date().toISOString();
        if (state.memory && state.memory.nodes) {
          let markedCount = 0;
          for (const node of state.memory.nodes) {
            if (!node.consolidatedAt) {
              node.consolidatedAt = forkTimestamp;
              markedCount++;
            }
          }
          this.logger.info(`Marked ${markedCount} inherited nodes as consolidated`);
        }

        // CRITICAL: Clear existing plans for fresh planning phase
        // Dream fork should start with clean slate, focusing only on consolidation
        if (state.guidedMissionPlan) {
          state.guidedMissionPlan = null;
          this.logger.info('Cleared inherited plan - dream mode focuses on consolidation');
        }

        // Also clear the completionTracker to avoid stale progress tracking
        if (state.completionTracker) {
          state.completionTracker = null;
          this.logger.info('Cleared completion tracker - dream fork starts fresh');
        }

        // Save modified state
        const newStateJson = JSON.stringify(state);
        const newCompressed = await gzip(Buffer.from(newStateJson));
        
        // Backup original
        await fs.copyFile(statePath, path.join(destPath, 'state.json.gz.prefork'));
        
        // Write modified state
        await fs.writeFile(statePath, newCompressed);

        // Delete plans directory to force fresh plan generation if run resumes
        const plansDir = path.join(destPath, 'plans');
        try {
          await fs.rm(plansDir, { recursive: true, force: true });
          this.logger.info('Deleted inherited plans directory');
        } catch (e) {
          // Ignore if plans directory doesn't exist
        }

        this.logger.info(`Created dream fork ${sourceRunName} → ${newRunName}`, {
          cycle: state.cycleCount,
          mode: state.cognitiveState.mode,
          energy: state.cognitiveState.energy,
          activeGoals: state.goals?.active?.length || 0,
          temporalState: state.temporal?.state
        });
      } catch (e) {
        this.logger.info(`Created dream fork ${sourceRunName} → ${newRunName} (no state modification)`);
      }

      // Create dream fork metadata
      const metadata = {
        forkType: 'dream',
        sourceRun: sourceRunName,
        forkedAt: new Date().toISOString(),
        dreamMode: true,
        settings: {
          dreamCycles: settings.dreamCycles || 100,
          dreamsPerCycle: settings.dreamsPerCycle || 10
        }
      };

      await fs.writeFile(
        path.join(destPath, 'dream-fork-metadata.json'),
        JSON.stringify(metadata, null, 2)
      );

      return { 
        success: true, 
        sourceRunName, 
        newRunName, 
        path: destPath,
        dreamMode: true,
        settings: metadata.settings
      };
    } catch (error) {
      this.logger.error(`Failed to create dream fork:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a run
   * @param {string} runName - Run name
   * @param {object} options - Optional parameters
   * @param {string} options.runPath - Override run path (for multi-tenant)
   */
  async deleteRun(runName, options = {}) {
    // PRODUCTION: Allow path override for multi-tenant support
    const runPath = options.runPath || path.join(this.runsDir, runName);

    try {
      await fs.rm(runPath, { recursive: true, force: true });
      this.logger.info(`Deleted run: ${runName}`);
      return { success: true, runName };
    } catch (error) {
      this.logger.error(`Failed to delete run ${runName}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get metadata for a run
   */
  async getMetadata(runName) {
    const metadataPath = path.join(this.runsDir, runName, 'run-metadata.json');

    try {
      const content = await fs.readFile(metadataPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get dream fork metadata for a run
   */
  async getDreamMetadata(runName) {
    const dreamMetadataPath = path.join(this.runsDir, runName, 'dream-fork-metadata.json');

    try {
      const content = await fs.readFile(dreamMetadataPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Save metadata for a run
   */
  async saveMetadata(runName, metadata) {
    const metadataPath = path.join(this.runsDir, runName, 'run-metadata.json');

    try {
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to save metadata for ${runName}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Helper: Get directory size
   */
  async getDirectorySize(dirPath) {
    try {
      const output = execSync(`du -sh "${dirPath}" 2>/dev/null | cut -f1`, { encoding: 'utf8' });
      return output.trim();
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Helper: Copy directory recursively
   */
  async copyDirectory(source, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Link runtime to a specific run
   */
  async linkRuntime(runName, runtimePath) {
    const runPath = path.join(this.runsDir, runName);

    try {
      // Verify run exists
      await fs.access(runPath);

      // Remove existing runtime link/directory
      try {
        await fs.rm(runtimePath, { recursive: true, force: true });
      } catch (e) {
        // Doesn't exist, that's fine
      }

      // Create symlink
      await fs.symlink(runPath, runtimePath);

      this.logger.info(`Linked runtime → ${runName}`);
      return { success: true, runName, runPath };
    } catch (error) {
      this.logger.error(`Failed to link runtime:`, error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = { RunManager };

