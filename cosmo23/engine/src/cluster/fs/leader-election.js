/**
 * Filesystem Leader Election
 *
 * Lease-based leader election using O_EXCL file locks with term-based fencing.
 * - Single leader at a time
 * - Lease with grace period
 * - Term monotonicity prevents split-brain
 * - temp+rename+fsync atomics for durability
 *
 * Phase B-FS / D-FS: Filesystem Leader Election
 */

const path = require('path');
const { FilesystemHelpers } = require('./helpers');

class LeaderElection {
  constructor(config, fsRoot, instanceId, logger) {
    this.config = config;
    this.fsRoot = fsRoot;
    this.instanceId = instanceId;
    this.logger = logger;
    this.helpers = new FilesystemHelpers(logger);

    // Lease settings
    this.leaseMs = config.leaseMs || 3000;
    this.renewMs = config.renewMs || 1000;
    this.graceMs = config.graceMs || 2000;

    // Paths
    this.controlDir = path.join(fsRoot, 'control');
    this.leaderLockPath = path.join(this.controlDir, 'leader.lock');
    this.epochPath = path.join(this.controlDir, 'CURRENT_EPOCH');
    this.seqPath = path.join(this.controlDir, 'CURRENT_SEQ');
    this.electionDir = path.join(this.controlDir, 'election');

    // State
    this.isLeader = false;
    this.currentTerm = 0;
    this.renewalTimer = null;
  }

  /**
   * Initialize leader election
   */
  async initialize() {
    const fs = require('fs').promises;
    
    // Create control directories
    await fs.mkdir(this.controlDir, { recursive: true });
    await fs.mkdir(this.electionDir, { recursive: true });

    // Load current epoch
    const epochStr = await this.helpers.atomicRead(this.epochPath, { 
      encoding: 'utf8', 
      defaultValue: '0' 
    });
    this.currentTerm = parseInt(epochStr) || 0;

    this.logger.info('[LeaderElection] Initialized', {
      instanceId: this.instanceId,
      currentTerm: this.currentTerm
    });
  }

  /**
   * Attempt to acquire leadership
   * @returns {boolean} - true if acquired
   */
  async tryAcquireLeadership() {
    try {
      // Check if current lock is expired
      const existingLock = await this.helpers.readLock(this.leaderLockPath);
      
      if (existingLock) {
        const now = Date.now();
        const leaseExpiry = existingLock.leaseExpiry || 0;
        
        // If lease not expired, cannot acquire
        if (leaseExpiry > now) {
          this.logger.debug('[LeaderElection] Leadership unavailable (lease active)', {
            currentLeader: existingLock.leaderId,
            expiresIn: leaseExpiry - now
          });
          return false;
        }
        
        // Lease expired: proceed with acquisition
        this.logger.info('[LeaderElection] Previous lease expired, acquiring', {
          previousLeader: existingLock.leaderId,
          term: existingLock.term
        });

        // Clean up stale lock so we can re-acquire
        try {
          await this.helpers.releaseLock(this.leaderLockPath);
        } catch (error) {
          this.logger.warn('[LeaderElection] Failed to release expired lock (continuing)', {
            error: error.message
          });
        }
      }

      // Increment term (fencing)
      this.currentTerm = await this.helpers.atomicIncrement(this.epochPath, 1);

      // Create lock data
      const lockData = {
        leaderId: this.instanceId,
        leaseExpiry: Date.now() + this.leaseMs,
        term: this.currentTerm,
        seqHi: 0,
        acquiredAt: Date.now()
      };

      // Try to acquire lock (O_EXCL)
      const acquired = await this.helpers.tryAcquireLock(this.leaderLockPath, lockData);

      if (acquired) {
        this.isLeader = true;
        this.logger.info('[LeaderElection] Leadership acquired', {
          instanceId: this.instanceId,
          term: this.currentTerm,
          leaseMs: this.leaseMs
        });

        // Start renewal timer
        this.startRenewalTimer();
        
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('[LeaderElection] tryAcquireLeadership error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Renew leadership lease (temp+rename+fsync)
   * @returns {boolean} - true if renewed
   */
  async renewLease() {
    if (!this.isLeader) {
      return false;
    }

    try {
      // Read current lock
      const lockData = await this.helpers.readLock(this.leaderLockPath);
      
      if (!lockData) {
        this.logger.warn('[LeaderElection] Lock disappeared during renewal');
        this.isLeader = false;
        this.stopRenewalTimer();
        return false;
      }

      // Verify we're still the leader
      if (lockData.leaderId !== this.instanceId) {
        this.logger.warn('[LeaderElection] Lock stolen during renewal', {
          expectedLeader: this.instanceId,
          actualLeader: lockData.leaderId
        });
        this.isLeader = false;
        this.stopRenewalTimer();
        return false;
      }

      // Verify term hasn't changed
      if (lockData.term !== this.currentTerm) {
        this.logger.warn('[LeaderElection] Term changed during renewal', {
          expectedTerm: this.currentTerm,
          actualTerm: lockData.term
        });
        this.isLeader = false;
        this.stopRenewalTimer();
        return false;
      }

      // Extend lease
      lockData.leaseExpiry = Date.now() + this.leaseMs;
      lockData.renewedAt = Date.now();

      // Atomic write (temp+rename+fsync)
      await this.helpers.atomicWriteJSON(this.leaderLockPath, lockData);

      this.logger.debug('[LeaderElection] Lease renewed', {
        term: this.currentTerm,
        expiresAt: new Date(lockData.leaseExpiry).toISOString()
      });

      return true;
    } catch (error) {
      this.logger.error('[LeaderElection] renewLease error', {
        error: error.message
      });
      this.isLeader = false;
      this.stopRenewalTimer();
      return false;
    }
  }

  /**
   * Release leadership
   */
  async releaseLeadership() {
    if (!this.isLeader) {
      return true;
    }

    try {
      this.stopRenewalTimer();
      await this.helpers.releaseLock(this.leaderLockPath);
      this.isLeader = false;

      this.logger.info('[LeaderElection] Leadership released', {
        instanceId: this.instanceId,
        term: this.currentTerm
      });

      return true;
    } catch (error) {
      this.logger.error('[LeaderElection] releaseLeadership error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get current leader
   * @returns {object|null} - { leaderId, leaseExpiry, term, seqHi }
   */
  async getCurrentLeader() {
    const lockData = await this.helpers.readLock(this.leaderLockPath);
    
    if (!lockData) {
      return null;
    }

    // Check if lease expired
    if (lockData.leaseExpiry < Date.now()) {
      return null; // Expired
    }

    return lockData;
  }

  /**
   * Start automatic lease renewal timer
   */
  startRenewalTimer() {
    this.stopRenewalTimer(); // Clear any existing timer

    this.renewalTimer = setInterval(() => {
      this.renewLease().catch((error) => {
        this.logger.error('[LeaderElection] Renewal timer error', {
          error: error.message
        });
      });
    }, this.renewMs);

    this.logger.debug('[LeaderElection] Renewal timer started', {
      renewMs: this.renewMs
    });
  }

  /**
   * Stop lease renewal timer
   */
  stopRenewalTimer() {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  /**
   * Check if this instance is currently leader
   * @returns {boolean}
   */
  isCurrentLeader() {
    return this.isLeader;
  }

  /**
   * Get current term
   * @returns {number}
   */
  getCurrentTerm() {
    return this.currentTerm;
  }

  /**
   * Cleanup (stop timers, release lock if held)
   */
  async cleanup() {
    this.stopRenewalTimer();
    if (this.isLeader) {
      await this.releaseLeadership();
    }
  }
}

module.exports = { LeaderElection };
