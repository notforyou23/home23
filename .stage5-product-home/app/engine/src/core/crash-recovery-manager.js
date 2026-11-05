/**
 * CrashRecoveryManager
 *
 * Phase A: Crash recovery and checkpoint management
 * - Detect unclean shutdowns
 * - Save checkpoints at cycle boundaries
 * - Restore from last clean checkpoint
 * - Recovery journal for debugging
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class CrashRecoveryManager {
  constructor(config, logger, logsDir) {
    this.config = config;
    this.logger = logger;
    this.logsDir = logsDir || path.join(__dirname, '..', '..', 'runtime');
    
    // Recovery settings
    this.checkpointInterval = config.recovery?.checkpointInterval || 5; // Every 5 cycles
    this.maxCheckpoints = config.recovery?.maxCheckpoints || 3; // Keep last 3
    this.recoveryLogPath = path.join(this.logsDir, 'recovery.log');
    this.cleanShutdownPath = path.join(this.logsDir, '.clean_shutdown');
    
    // State
    this.lastCheckpointCycle = 0;
    this.crashDetected = false;
    this.recoveryAttempts = 0;
  }

  /**
   * Initialize recovery manager
   * Check for previous crash on startup
   */
  async initialize() {
    // Check if last shutdown was clean
    this.crashDetected = await this.detectCrash();
    
    if (this.crashDetected) {
      this.logger.warn('[CrashRecovery] Unclean shutdown detected');
      await this.logRecoveryEvent('CRASH_DETECTED', {
        timestamp: new Date().toISOString(),
        message: 'System started after unclean shutdown'
      });
    } else {
      this.logger.info('[CrashRecovery] Clean shutdown detected');
    }
    
    // Remove clean shutdown marker (will be recreated on clean shutdown)
    try {
      await fs.unlink(this.cleanShutdownPath);
    } catch (error) {
      // File might not exist, that's fine
    }
  }

  /**
   * Detect if previous shutdown was unclean
   * Check for .clean_shutdown marker file
   */
  async detectCrash() {
    try {
      await fs.access(this.cleanShutdownPath);
      // File exists = previous shutdown was NOT clean (marker wasn't removed)
      return false;
    } catch (error) {
      // File doesn't exist = previous shutdown was clean OR first run
      // Check if a persisted state artifact exists to differentiate. The
      // engine now saves the real runtime state as state.json.gz, but older
      // code and tests may still use state.json.
      const stateArtifacts = [
        path.join(this.logsDir, 'state.json.gz'),
        path.join(this.logsDir, 'state.json'),
      ];
      for (const statePath of stateArtifacts) {
        try {
          await fs.access(statePath);
          // State exists but no clean marker = crash
          return true;
        } catch (accessError) {
          // Try the next known state artifact
        }
      }
      // No state file = first run
      return false;
    }
  }

  /**
   * Save checkpoint at cycle boundary
   * @param {object} state - state to checkpoint
   * @param {number} cycle - current cycle number
   */
  async saveCheckpoint(state, cycle) {
    // Only checkpoint at intervals
    if (cycle % this.checkpointInterval !== 0) {
      return;
    }

    try {
      const checkpointPath = this.getCheckpointPath(cycle);
      const checkpointData = {
        cycle,
        timestamp: new Date().toISOString(),
        state
      };

      // Ensure checkpoints directory exists
      const checkpointsDir = path.dirname(checkpointPath);
      await fs.mkdir(checkpointsDir, { recursive: true });

      // Write checkpoint atomically (temp + rename)
      // Deep-streaming write: serializes large arrays item-by-item to avoid
      // V8 string-length limits and zlib OOM on 22K+ node graphs (346MB+ checkpoints)
      const tempPath = `${checkpointPath}.tmp`;
      await new Promise((resolve, reject) => {
        const fss = require('fs');
        const stream = fss.createWriteStream(tempPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
        stream.on('error', reject);
        stream.on('finish', resolve);

        const writeValue = (val, indent) => {
          if (Array.isArray(val) && val.length > 100) {
            stream.write('[\n');
            for (let i = 0; i < val.length; i++) {
              const ic = i < val.length - 1 ? ',' : '';
              stream.write(`${indent}  ${JSON.stringify(val[i])}${ic}\n`);
            }
            stream.write(`${indent}]`);
          } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            const keys = Object.keys(val);
            const hasLargeChild = keys.some(k => Array.isArray(val[k]) && val[k].length > 100);
            if (hasLargeChild) {
              stream.write('{\n');
              keys.forEach((k, ki) => {
                const kc = ki < keys.length - 1 ? ',' : '';
                stream.write(`${indent}  ${JSON.stringify(k)}: `);
                writeValue(val[k], indent + '  ');
                stream.write(`${kc}\n`);
              });
              stream.write(`${indent}}`);
            } else {
              stream.write(JSON.stringify(val));
            }
          } else {
            stream.write(JSON.stringify(val));
          }
        };

        stream.write('{\n');
        stream.write(`  "cycle": ${JSON.stringify(checkpointData.cycle)},\n`);
        stream.write(`  "timestamp": ${JSON.stringify(checkpointData.timestamp)},\n`);
        stream.write('  "state": {\n');
        const stateKeys = Object.keys(checkpointData.state);
        stateKeys.forEach((key, i) => {
          const comma = i < stateKeys.length - 1 ? ',' : '';
          stream.write(`    ${JSON.stringify(key)}: `);
          writeValue(checkpointData.state[key], '    ');
          stream.write(`${comma}\n`);
        });
        stream.write('  }\n}\n');
        stream.end();
      });
      await fs.rename(tempPath, checkpointPath);

      this.lastCheckpointCycle = cycle;
      this.logger.info('[CrashRecovery] Checkpoint saved', { cycle });
      
      // Generate audit artifact (tamper-evident snapshot)
      await this.generateAuditArtifact(state, cycle, checkpointPath);

      // Cleanup old checkpoints
      await this.cleanupOldCheckpoints(cycle);
    } catch (error) {
      this.logger.error('[CrashRecovery] Failed to save checkpoint', {
        cycle,
        error: error.message
      });
    }
  }

  /**
   * Recover from last clean checkpoint
   * @returns {object|null} - recovered state or null if no checkpoint
   */
  async recover() {
    this.recoveryAttempts++;
    
    try {
      // Find most recent checkpoint
      const checkpoints = await this.listCheckpoints();
      
      if (checkpoints.length === 0) {
        this.logger.warn('[CrashRecovery] No checkpoints found for recovery');
        await this.logRecoveryEvent('NO_CHECKPOINT', {
          message: 'No checkpoint available for recovery'
        });
        return null;
      }

      // Try checkpoints from newest to oldest
      for (const checkpointFile of checkpoints.reverse()) {
        try {
          const checkpointPath = path.join(this.logsDir, 'checkpoints', checkpointFile);
          const data = await fs.readFile(checkpointPath, 'utf8');
          const checkpoint = JSON.parse(data);

          this.logger.info('[CrashRecovery] Recovered from checkpoint', {
            cycle: checkpoint.cycle,
            timestamp: checkpoint.timestamp
          });

          await this.logRecoveryEvent('RECOVERY_SUCCESS', {
            cycle: checkpoint.cycle,
            timestamp: checkpoint.timestamp,
            attempts: this.recoveryAttempts
          });

          // Recovery has completed. Keep the recovery journal as historical
          // evidence, but do not leave the runtime crash flag latched; Good Life
          // treats this flag as an active recovery condition.
          this.crashDetected = false;

          return checkpoint.state;
        } catch (error) {
          this.logger.warn('[CrashRecovery] Failed to load checkpoint', {
            file: checkpointFile,
            error: error.message
          });
          // Try next checkpoint
          continue;
        }
      }

      // All checkpoints failed
      this.logger.error('[CrashRecovery] All checkpoints failed to load');
      await this.logRecoveryEvent('RECOVERY_FAILED', {
        message: 'All checkpoints corrupted or unreadable',
        attempts: this.recoveryAttempts
      });
      return null;
    } catch (error) {
      this.logger.error('[CrashRecovery] Recovery error', { error: error.message });
      await this.logRecoveryEvent('RECOVERY_ERROR', {
        error: error.message,
        attempts: this.recoveryAttempts
      });
      return null;
    }
  }

  /**
   * Get checkpoint file path for cycle
   */
  getCheckpointPath(cycle) {
    const checkpointsDir = path.join(this.logsDir, 'checkpoints');
    return path.join(checkpointsDir, `checkpoint-${cycle}.json`);
  }

  /**
   * List all checkpoint files
   */
  async listCheckpoints() {
    const checkpointsDir = path.join(this.logsDir, 'checkpoints');
    
    try {
      await fs.mkdir(checkpointsDir, { recursive: true });
      const files = await fs.readdir(checkpointsDir);
      
      // Filter and sort checkpoint files
      return files
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .sort((a, b) => {
          const cycleA = parseInt(a.match(/checkpoint-(\d+)\.json/)?.[1] || '0');
          const cycleB = parseInt(b.match(/checkpoint-(\d+)\.json/)?.[1] || '0');
          return cycleA - cycleB;
        });
    } catch (error) {
      this.logger.error('[CrashRecovery] Failed to list checkpoints', { error: error.message });
      return [];
    }
  }

  /**
   * Cleanup old checkpoints (keep only last N)
   */
  async cleanupOldCheckpoints(currentCycle) {
    try {
      const checkpoints = await this.listCheckpoints();
      const checkpointsDir = path.join(this.logsDir, 'checkpoints');
      
      // Keep only last maxCheckpoints
      if (checkpoints.length > this.maxCheckpoints) {
        const toDelete = checkpoints.slice(0, checkpoints.length - this.maxCheckpoints);
        
        for (const file of toDelete) {
          const filePath = path.join(checkpointsDir, file);
          await fs.unlink(filePath);
          const auditPath = filePath.replace('.json', '_audit.json');
          await fs.unlink(auditPath).catch(() => {});
          this.logger.info('[CrashRecovery] Deleted old checkpoint', { file });
        }
      }

      const auxiliaryFiles = await fs.readdir(checkpointsDir);
      for (const file of auxiliaryFiles) {
        if (file.startsWith('checkpoint-') && file.endsWith('.json.tmp')) {
          await fs.unlink(path.join(checkpointsDir, file)).catch(() => {});
          this.logger.info('[CrashRecovery] Deleted stale checkpoint temp', { file });
          continue;
        }

        if (file.startsWith('checkpoint-') && file.endsWith('_audit.json')) {
          const checkpointFile = file.replace('_audit.json', '.json');
          if (!checkpoints.includes(checkpointFile)) {
            await fs.unlink(path.join(checkpointsDir, file)).catch(() => {});
            this.logger.info('[CrashRecovery] Deleted orphaned checkpoint audit', { file });
          }
        }
      }
    } catch (error) {
      this.logger.error('[CrashRecovery] Failed to cleanup checkpoints', { error: error.message });
    }
  }

  /**
   * Mark shutdown as clean
   * Call this in graceful shutdown handler
   */
  async markCleanShutdown() {
    try {
      await fs.writeFile(this.cleanShutdownPath, new Date().toISOString(), 'utf8');
      this.logger.info('[CrashRecovery] Marked clean shutdown');
    } catch (error) {
      this.logger.error('[CrashRecovery] Failed to mark clean shutdown', { error: error.message });
    }
  }

  /**
   * Log recovery event to recovery journal
   */
  async logRecoveryEvent(eventType, data) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        eventType,
        ...data
      };
      
      const logLine = JSON.stringify(logEntry) + '\n';
      await fs.appendFile(this.recoveryLogPath, logLine, 'utf8');
    } catch (error) {
      this.logger.error('[CrashRecovery] Failed to log recovery event', { error: error.message });
    }
  }

  /**
   * Get recovery journal (last N entries)
   */
  async getRecoveryJournal(limit = 50) {
    try {
      const content = await fs.readFile(this.recoveryLogPath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      
      // Get last N lines
      const entries = lines.slice(-limit).map(line => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return null;
        }
      }).filter(e => e !== null);
      
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []; // No journal yet
      }
      this.logger.error('[CrashRecovery] Failed to read recovery journal', { error: error.message });
      return [];
    }
  }

  /**
   * Get recovery stats
   */
  getStats() {
    return {
      crashDetected: this.crashDetected,
      recoveryAttempts: this.recoveryAttempts,
      lastCheckpointCycle: this.lastCheckpointCycle,
      checkpointInterval: this.checkpointInterval,
      maxCheckpoints: this.maxCheckpoints
    };
  }

  /**
   * Generate audit artifact for forensics and reproducibility
   * @param {object} state - Full state object
   * @param {number} cycle - Cycle number
   * @param {string} checkpointPath - Path to checkpoint file
   */
  async generateAuditArtifact(state, cycle, checkpointPath) {
    try {
      // Stream-hash checkpoint for tamper detection (avoids loading 300MB+ into memory)
      const fss = require('fs');
      const checkpointHash = await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const rs = fss.createReadStream(checkpointPath);
        rs.on('data', chunk => hash.update(chunk));
        rs.on('end', () => resolve(hash.digest('hex')));
        rs.on('error', reject);
      });
      const checkpointStat = await fs.stat(checkpointPath);
      
      // Build audit artifact
      const artifact = {
        schema_version: 'cosmo-audit-v1',
        checkpoint_cycle: cycle,
        timestamp: new Date().toISOString(),
        
        // Reproducibility metadata
        git_commit: process.env.GIT_COMMIT || 'development',
        node_version: process.version,
        
        // State snapshot (high-level metrics only, not full state)
        state_snapshot: {
          cycleCount: state.cycleCount || 0,
          memoryNodes: state.memory?.nodes?.length || 0,
          memoryEdges: state.memory?.edges?.length || 0,
          activeGoals: state.goals?.goals?.size || 0,
          completedGoals: state.goals?.completedGoals?.length || 0,
          agentStats: {
            totalSpawned: state.agentExecutor?.registry?.agents?.size || 0,
            active: state.agentExecutor?.registry?.activeAgents?.size || 0,
            completed: state.agentExecutor?.registry?.completedAgents?.size || 0
          }
        },
        
        // Checkpoint integrity
        checkpoint_file: path.basename(checkpointPath),
        checkpoint_hash: checkpointHash,
        checkpoint_size_bytes: checkpointStat.size
      };
      
      // Save audit artifact alongside checkpoint
      const artifactPath = checkpointPath.replace('.json', '_audit.json');
      await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
      
      this.logger.debug('[CrashRecovery] Audit artifact generated', { 
        cycle, 
        hash: checkpointHash.slice(0, 16) 
      });
      
    } catch (error) {
      // Don't fail checkpoint on audit error (non-fatal)
      this.logger.warn('[CrashRecovery] Audit artifact generation failed', {
        cycle,
        error: error.message
      });
    }
  }
}

module.exports = { CrashRecoveryManager };
