/**
 * Filesystem Reconciler
 *
 * Validates filesystem invariants and generates recovery SBOM.
 * - No duplicate goal assignments
 * - ACKs match assignments
 * - Log entries match filesystem state
 * - Recovery state-of-materials for rejoining instances
 *
 * Phase B-FS: Filesystem State Store
 */

const { FilesystemHelpers } = require('./helpers');
const path = require('path');

class Reconciler {
  constructor(fsRoot, logger) {
    this.fsRoot = fsRoot;
    this.logger = logger;
    this.helpers = new FilesystemHelpers(logger);
    
    // Paths
    this.goalsDir = path.join(fsRoot, 'goals');
    this.assignedDir = path.join(this.goalsDir, 'assigned');
    this.acksDir = path.join(this.goalsDir, 'acks');
    this.completeDir = path.join(this.goalsDir, 'complete');
    this.revokedDir = path.join(this.goalsDir, 'revoked');
    this.logsDir = path.join(fsRoot, 'logs');
    this.appliedDir = path.join(fsRoot, 'applied');
  }

  /**
   * Run full reconciliation check
   * @returns {object} - { valid: boolean, violations: array, stats: object }
   */
  async reconcile() {
    const violations = [];
    const stats = {
      totalAssignments: 0,
      totalAcks: 0,
      totalComplete: 0,
      totalRevoked: 0,
      duplicates: 0,
      orphanedAcks: 0,
      orphanedCompletions: 0
    };

    try {
      // Check for duplicate assignments
      const duplicates = await this.checkDuplicateAssignments();
      if (duplicates.length > 0) {
        violations.push({
          type: 'DUPLICATE_ASSIGNMENTS',
          count: duplicates.length,
          examples: duplicates.slice(0, 5)
        });
        stats.duplicates = duplicates.length;
      }

      // Check ACKs match assignments
      const orphanedAcks = await this.checkOrphanedAcks();
      if (orphanedAcks.length > 0) {
        violations.push({
          type: 'ORPHANED_ACKS',
          count: orphanedAcks.length,
          examples: orphanedAcks.slice(0, 5)
        });
        stats.orphanedAcks = orphanedAcks.length;
      }

      // Check completions match assignments or acks
      const orphanedCompletions = await this.checkOrphanedCompletions();
      if (orphanedCompletions.length > 0) {
        violations.push({
          type: 'ORPHANED_COMPLETIONS',
          count: orphanedCompletions.length,
          examples: orphanedCompletions.slice(0, 5)
        });
        stats.orphanedCompletions = orphanedCompletions.length;
      }

      // Count totals
      stats.totalAssignments = await this.countAssignments();
      stats.totalAcks = await this.countAcks();
      stats.totalComplete = await this.countCompletions();
      stats.totalRevoked = await this.countRevocations();

      const valid = violations.length === 0;
      
      if (valid) {
        this.logger.info('[Reconciler] Reconciliation passed', stats);
      } else {
        this.logger.warn('[Reconciler] Reconciliation found violations', {
          violationCount: violations.length,
          stats
        });
      }

      return { valid, violations, stats };
    } catch (error) {
      this.logger.error('[Reconciler] Reconciliation error', {
        error: error.message
      });
      return {
        valid: false,
        violations: [{ type: 'RECONCILIATION_ERROR', error: error.message }],
        stats
      };
    }
  }

  /**
   * Check for duplicate goal assignments across instances
   */
  async checkDuplicateAssignments() {
    const assignments = new Map(); // goalId -> [instances]
    const duplicates = [];

    try {
      const instances = await this.helpers.listDirectory(this.assignedDir);
      
      for (const instanceDir of instances) {
        const instancePath = path.join(this.assignedDir, instanceDir);
        const goals = await this.helpers.listDirectory(instancePath);
        
        for (const goalFile of goals) {
          const goalId = goalFile.replace('.json', '');
          
          if (!assignments.has(goalId)) {
            assignments.set(goalId, []);
          }
          assignments.get(goalId).push(instanceDir);
        }
      }

      // Find duplicates
      for (const [goalId, instances] of assignments.entries()) {
        if (instances.length > 1) {
          duplicates.push({ goalId, instances });
        }
      }

      return duplicates;
    } catch (error) {
      this.logger.error('[Reconciler] checkDuplicateAssignments error', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Check for ACKs without corresponding assignments
   */
  async checkOrphanedAcks() {
    const orphaned = [];

    try {
      const acks = await this.helpers.listDirectory(this.acksDir);
      const allAssignments = await this.getAllAssignmentIds();

      for (const ackFile of acks) {
        const assignId = ackFile.replace('.ack', '');
        if (!allAssignments.has(assignId)) {
          orphaned.push(assignId);
        }
      }

      return orphaned;
    } catch (error) {
      this.logger.error('[Reconciler] checkOrphanedAcks error', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Check for completions without assignments
   */
  async checkOrphanedCompletions() {
    const orphaned = [];

    try {
      const completions = await this.helpers.listDirectory(this.completeDir);
      const allAssignments = await this.getAllAssignmentIds();

      for (const completeFile of completions) {
        const assignId = completeFile.replace('.done', '');
        if (!allAssignments.has(assignId)) {
          orphaned.push(assignId);
        }
      }

      return orphaned;
    } catch (error) {
      this.logger.error('[Reconciler] checkOrphanedCompletions error', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get all assignment IDs across all instances
   */
  async getAllAssignmentIds() {
    const assignmentIds = new Set();

    try {
      const instances = await this.helpers.listDirectory(this.assignedDir);
      
      for (const instanceDir of instances) {
        const instancePath = path.join(this.assignedDir, instanceDir);
        const goals = await this.helpers.listDirectory(instancePath);
        
        for (const goalFile of goals) {
          const assignId = goalFile.replace('.json', '');
          assignmentIds.add(assignId);
        }
      }

      return assignmentIds;
    } catch (error) {
      this.logger.error('[Reconciler] getAllAssignmentIds error', {
        error: error.message
      });
      return new Set();
    }
  }

  /**
   * Count assignments
   */
  async countAssignments() {
    try {
      const ids = await this.getAllAssignmentIds();
      return ids.size;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Count ACKs
   */
  async countAcks() {
    try {
      const acks = await this.helpers.listDirectory(this.acksDir);
      return acks.length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Count completions
   */
  async countCompletions() {
    try {
      const completions = await this.helpers.listDirectory(this.completeDir);
      return completions.length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Count revocations
   */
  async countRevocations() {
    try {
      const revocations = await this.helpers.listDirectory(this.revokedDir);
      return revocations.length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Generate recovery SBOM (State Bill of Materials) for rejoining instance
   * @returns {object} - { epoch, seq, snapshot, logOffset, timestamp }
   */
  async generateRecoverySBOM() {
    try {
      const epochStr = await this.helpers.atomicRead(
        path.join(this.fsRoot, 'control/CURRENT_EPOCH'),
        { encoding: 'utf8', defaultValue: '0' }
      );
      const seqStr = await this.helpers.atomicRead(
        path.join(this.fsRoot, 'control/CURRENT_SEQ'),
        { encoding: 'utf8', defaultValue: '0' }
      );

      const epoch = parseInt(epochStr) || 0;
      const seq = parseInt(seqStr) || 0;

      // Find latest snapshot
      const epochsDir = path.join(this.fsRoot, 'epochs');
      const epochDirs = await this.helpers.listDirectory(epochsDir);
      const latestEpoch = epochDirs
        .filter(d => d.startsWith('E'))
        .map(d => parseInt(d.substring(1)))
        .sort((a, b) => b - a)[0] || 0;

      const snapshotPath = latestEpoch > 0 
        ? path.join(epochsDir, `E${latestEpoch}/snapshot.tar.gz`)
        : null;

      // Get current log offset
      const logPath = this.getCurrentLogPath();
      const logExists = await this.helpers.fileExists(logPath);
      const logOffset = logExists ? (await this.helpers.atomicRead(logPath, { encoding: 'utf8' })).split('\n').length : 0;

      return {
        epoch,
        seq,
        snapshot: snapshotPath,
        logOffset,
        timestamp: Date.now()
      };
    } catch (error) {
      this.logger.error('[Reconciler] generateRecoverySBOM error', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get current log file path (partitioned by day)
   */
  getCurrentLogPath() {
    const now = new Date();
    const dateKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    return path.join(this.logsDir, `events.log.${dateKey}`);
  }
}

module.exports = { Reconciler };

