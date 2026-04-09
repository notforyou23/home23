/**
 * OrchestratorManager - Multi-Context COSMO Management
 *
 * Enables multiple COSMO orchestrator contexts to run simultaneously,
 * each isolated with its own:
 * - Orchestrator instance
 * - Runtime path (file I/O)
 * - Configuration
 * - Event routing
 *
 * Used by COSMO Unified server to support multi-tenant operation.
 *
 * @example
 * const manager = new OrchestratorManager(logger);
 * await manager.startContext('user123_run456', {
 *   runtimePath: '/data/users/user123/runs/run456',
 *   config: { ... }
 * });
 * manager.getContext('user123_run456').orchestrator.startResearch();
 */

const EventEmitter = require('events');

/**
 * Context status enum
 */
const ContextStatus = {
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error'
};

/**
 * Single orchestrator context with all associated resources
 */
class OrchestratorContext {
  constructor(contextId, config, logger) {
    this.contextId = contextId;
    this.config = config;
    this.logger = logger;
    this.status = ContextStatus.INITIALIZING;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.stoppedAt = null;

    // Core components (set during initialization)
    this.orchestrator = null;
    this.realtimeServer = null;
    this.subsystems = null;

    // Resource tracking
    this.memoryUsage = 0;
    this.cycleCount = 0;
    this.lastActivity = Date.now();

    // User/run metadata
    this.userId = config.userId || null;
    this.runId = config.runId || null;
    this.runName = config.runName || null;
    this.runtimePath = config.runtimePath || null;
  }

  /**
   * Update status with timestamp
   */
  setStatus(status) {
    this.status = status;
    this.lastActivity = Date.now();

    if (status === ContextStatus.RUNNING) {
      this.startedAt = Date.now();
    } else if (status === ContextStatus.STOPPED) {
      this.stoppedAt = Date.now();
    }
  }

  /**
   * Get context info for API responses
   */
  toJSON() {
    return {
      contextId: this.contextId,
      status: this.status,
      userId: this.userId,
      runId: this.runId,
      runName: this.runName,
      runtimePath: this.runtimePath,
      cycleCount: this.cycleCount,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastActivity: this.lastActivity,
      memoryUsage: this.memoryUsage
    };
  }
}

/**
 * OrchestratorManager - Manages multiple COSMO orchestrator contexts
 */
class OrchestratorManager extends EventEmitter {
  /**
   * @param {Object} logger - Logger instance
   * @param {Object} options - Manager options
   * @param {number} options.maxContexts - Maximum concurrent contexts (default: 5)
   * @param {number} options.contextTimeout - Context idle timeout in ms (default: 4 hours)
   */
  constructor(logger, options = {}) {
    super();
    this.logger = logger || console;
    this.contexts = new Map(); // contextId -> OrchestratorContext
    this.maxContexts = options.maxContexts || 5;
    this.contextTimeout = options.contextTimeout || 4 * 60 * 60 * 1000; // 4 hours

    // Track port allocations per context
    this.portAllocations = new Map(); // contextId -> { realtime, dashboard, ... }

    // Base port for dynamic allocation
    this.basePort = options.basePort || 3500;
    this.portsPerContext = 4; // realtime, dashboard, mcp, mcpDashboard

    // Start cleanup interval
    this._cleanupInterval = setInterval(() => this._cleanupStaleContexts(), 60000);
  }

  /**
   * Get number of active contexts
   */
  get activeCount() {
    let count = 0;
    for (const ctx of this.contexts.values()) {
      if (ctx.status === ContextStatus.RUNNING || ctx.status === ContextStatus.INITIALIZING) {
        count++;
      }
    }
    return count;
  }

  /**
   * Check if capacity available for new context
   */
  hasCapacity() {
    return this.activeCount < this.maxContexts;
  }

  /**
   * Allocate ports for a new context
   * @private
   */
  _allocatePorts(contextId) {
    // Find next available port block
    const usedPorts = new Set();
    for (const alloc of this.portAllocations.values()) {
      usedPorts.add(alloc.realtime);
      usedPorts.add(alloc.dashboard);
      usedPorts.add(alloc.mcp);
      usedPorts.add(alloc.mcpDashboard);
    }

    let basePort = this.basePort;
    while (usedPorts.has(basePort) || usedPorts.has(basePort + 1) ||
           usedPorts.has(basePort + 2) || usedPorts.has(basePort + 3)) {
      basePort += this.portsPerContext;
      if (basePort > 3700) {
        throw new Error('Port allocation exhausted (3500-3700 range full)');
      }
    }

    const ports = {
      realtime: basePort,
      dashboard: basePort + 1,
      mcp: basePort + 2,
      mcpDashboard: basePort + 3
    };

    this.portAllocations.set(contextId, ports);
    return ports;
  }

  /**
   * Release ports for a context
   * @private
   */
  _releasePorts(contextId) {
    this.portAllocations.delete(contextId);
  }

  /**
   * Start a new orchestrator context
   *
   * @param {string} contextId - Unique context identifier (e.g., 'userId_runId')
   * @param {Object} contextConfig - Context configuration
   * @param {string} contextConfig.runtimePath - Path for this context's files
   * @param {Object} contextConfig.config - COSMO config overrides
   * @param {string} contextConfig.userId - User ID for this context
   * @param {string} contextConfig.runId - Run ID for this context
   * @param {string} contextConfig.runName - Human-readable run name
   * @param {Function} contextConfig.createOrchestrator - Factory function to create orchestrator
   * @returns {Promise<OrchestratorContext>}
   */
  async startContext(contextId, contextConfig) {
    // Check if context already exists
    if (this.contexts.has(contextId)) {
      const existing = this.contexts.get(contextId);
      if (existing.status === ContextStatus.RUNNING) {
        throw new Error(`Context ${contextId} is already running`);
      }
      // Clean up stopped context
      await this.removeContext(contextId);
    }

    // Check capacity
    if (!this.hasCapacity()) {
      throw new Error(`Maximum contexts reached (${this.maxContexts}). Queue or wait.`);
    }

    this.logger.info(`[OrchestratorManager] Starting context: ${contextId}`);

    // Create context
    const context = new OrchestratorContext(contextId, contextConfig, this.logger);
    this.contexts.set(contextId, context);

    try {
      // Allocate ports for this context
      const ports = this._allocatePorts(contextId);
      context.ports = ports;

      this.logger.info(`[OrchestratorManager] Allocated ports for ${contextId}:`, ports);

      // Create orchestrator using factory function
      if (contextConfig.createOrchestrator) {
        const { orchestrator, subsystems, realtimeServer } = await contextConfig.createOrchestrator({
          contextId,
          runtimePath: contextConfig.runtimePath,
          ports,
          config: contextConfig.config
        });

        context.orchestrator = orchestrator;
        context.subsystems = subsystems;
        context.realtimeServer = realtimeServer;
      }

      context.setStatus(ContextStatus.RUNNING);

      // Emit event
      this.emit('contextStarted', {
        contextId,
        userId: context.userId,
        runId: context.runId,
        ports: context.ports
      });

      this.logger.info(`[OrchestratorManager] Context ${contextId} started successfully`);
      return context;

    } catch (error) {
      context.setStatus(ContextStatus.ERROR);
      context.error = error.message;
      this._releasePorts(contextId);

      this.emit('contextError', {
        contextId,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Stop an orchestrator context gracefully
   *
   * @param {string} contextId - Context to stop
   * @param {Object} options - Stop options
   * @param {boolean} options.force - Force immediate stop (default: false)
   * @param {number} options.timeout - Graceful shutdown timeout in ms (default: 180000)
   * @returns {Promise<void>}
   */
  async stopContext(contextId, options = {}) {
    const context = this.contexts.get(contextId);
    if (!context) {
      this.logger.warn(`[OrchestratorManager] Context ${contextId} not found`);
      return;
    }

    if (context.status === ContextStatus.STOPPED) {
      this.logger.info(`[OrchestratorManager] Context ${contextId} already stopped`);
      return;
    }

    this.logger.info(`[OrchestratorManager] Stopping context: ${contextId}`);
    context.setStatus(ContextStatus.STOPPING);

    const timeout = options.timeout || 180000; // 3 minutes default

    try {
      // Stop orchestrator
      if (context.orchestrator) {
        if (options.force) {
          // Force stop
          context.orchestrator.running = false;
        } else {
          // Graceful stop - wait for current cycle
          await this._gracefulStop(context.orchestrator, timeout);
        }
      }

      // Stop realtime server
      if (context.realtimeServer) {
        await context.realtimeServer.stop();
      }

      // Clean up subsystems
      if (context.subsystems) {
        // Any subsystem cleanup needed
      }

      // Release ports
      this._releasePorts(contextId);

      context.setStatus(ContextStatus.STOPPED);

      // Emit event
      this.emit('contextStopped', {
        contextId,
        userId: context.userId,
        runId: context.runId,
        cycleCount: context.cycleCount
      });

      this.logger.info(`[OrchestratorManager] Context ${contextId} stopped`);

    } catch (error) {
      this.logger.error(`[OrchestratorManager] Error stopping context ${contextId}:`, error);
      context.setStatus(ContextStatus.ERROR);
      context.error = error.message;
      throw error;
    }
  }

  /**
   * Gracefully stop an orchestrator
   * @private
   */
  async _gracefulStop(orchestrator, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        orchestrator.running = false;
        resolve();
      }, timeout);

      // Try graceful shutdown
      orchestrator.running = false;

      // Wait for current operation to complete
      const checkInterval = setInterval(() => {
        // Check if orchestrator has stopped
        if (!orchestrator.running) {
          clearInterval(checkInterval);
          clearTimeout(timer);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Get a context by ID
   *
   * @param {string} contextId
   * @returns {OrchestratorContext|null}
   */
  getContext(contextId) {
    return this.contexts.get(contextId) || null;
  }

  /**
   * Get context for a specific user (most recent running)
   *
   * @param {string} userId
   * @returns {OrchestratorContext|null}
   */
  getContextForUser(userId) {
    let latest = null;
    for (const ctx of this.contexts.values()) {
      if (ctx.userId === userId && ctx.status === ContextStatus.RUNNING) {
        if (!latest || ctx.createdAt > latest.createdAt) {
          latest = ctx;
        }
      }
    }
    return latest;
  }

  /**
   * List all active contexts
   *
   * @returns {OrchestratorContext[]}
   */
  listActiveContexts() {
    const active = [];
    for (const ctx of this.contexts.values()) {
      if (ctx.status === ContextStatus.RUNNING || ctx.status === ContextStatus.INITIALIZING) {
        active.push(ctx);
      }
    }
    return active;
  }

  /**
   * List all contexts (including stopped)
   *
   * @returns {OrchestratorContext[]}
   */
  listAllContexts() {
    return Array.from(this.contexts.values());
  }

  /**
   * Remove a stopped context from tracking
   *
   * @param {string} contextId
   */
  async removeContext(contextId) {
    const context = this.contexts.get(contextId);
    if (!context) return;

    // Stop if still running
    if (context.status === ContextStatus.RUNNING) {
      await this.stopContext(contextId, { force: true });
    }

    this._releasePorts(contextId);
    this.contexts.delete(contextId);

    this.logger.info(`[OrchestratorManager] Context ${contextId} removed`);
  }

  /**
   * Stop all contexts (for shutdown)
   *
   * @param {Object} options - Stop options
   * @returns {Promise<void>}
   */
  async stopAll(options = {}) {
    this.logger.info('[OrchestratorManager] Stopping all contexts...');

    const stopPromises = [];
    for (const contextId of this.contexts.keys()) {
      stopPromises.push(this.stopContext(contextId, options));
    }

    await Promise.allSettled(stopPromises);

    this.logger.info('[OrchestratorManager] All contexts stopped');
  }

  /**
   * Clean up stale contexts
   * @private
   */
  _cleanupStaleContexts() {
    const now = Date.now();
    for (const [contextId, ctx] of this.contexts.entries()) {
      // Remove stopped contexts older than 1 hour
      if (ctx.status === ContextStatus.STOPPED &&
          (now - ctx.stoppedAt) > 60 * 60 * 1000) {
        this.removeContext(contextId);
        continue;
      }

      // Check for idle timeout on running contexts
      if (ctx.status === ContextStatus.RUNNING &&
          (now - ctx.lastActivity) > this.contextTimeout) {
        this.logger.warn(`[OrchestratorManager] Context ${contextId} timed out (idle)`);
        this.stopContext(contextId);
      }
    }
  }

  /**
   * Get manager statistics
   */
  getStats() {
    const stats = {
      totalContexts: this.contexts.size,
      activeContexts: this.activeCount,
      maxContexts: this.maxContexts,
      hasCapacity: this.hasCapacity(),
      contexts: {}
    };

    for (const [id, ctx] of this.contexts.entries()) {
      stats.contexts[id] = ctx.toJSON();
    }

    return stats;
  }

  /**
   * Update cycle count for a context (called from orchestrator)
   */
  updateCycleCount(contextId, cycleCount) {
    const context = this.contexts.get(contextId);
    if (context) {
      context.cycleCount = cycleCount;
      context.lastActivity = Date.now();
    }
  }

  /**
   * Clean up on shutdown
   */
  async destroy() {
    clearInterval(this._cleanupInterval);
    await this.stopAll({ force: true });
    this.contexts.clear();
    this.portAllocations.clear();
  }
}

module.exports = {
  OrchestratorManager,
  OrchestratorContext,
  ContextStatus
};
