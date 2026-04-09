/**
 * WorkerOrchestratorManager
 *
 * Manages a pool of worker threads, each running an isolated COSMO orchestrator.
 * This provides true multi-tenant support with:
 * - Process-level isolation (separate V8 heaps)
 * - True parallel execution (multiple CPU cores)
 * - Fault isolation (one crash doesn't affect others)
 * - Resource isolation (memory limits per worker)
 *
 * Usage:
 *   const manager = new WorkerOrchestratorManager({ maxWorkers: 5 });
 *   await manager.startWorker('user123_run456', { runtimePath, config });
 *   await manager.stopWorker('user123_run456');
 */

const { Worker } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');

const WORKER_SCRIPT = path.join(__dirname, 'orchestrator-worker.js');

/**
 * Represents a single worker and its state
 */
class WorkerContext {
  constructor(contextId, worker) {
    this.contextId = contextId;
    this.worker = worker;
    this.status = 'initializing'; // initializing, ready, running, stopping, stopped, error
    this.createdAt = Date.now();
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastActivity = Date.now();
    this.error = null;

    // Run metadata
    this.userId = null;
    this.runId = null;
    this.runName = null;
    this.runtimePath = null;
    this.topic = null;

    // Stats
    this.cycleCount = 0;
    this.nodeCount = 0;
    this.edgeCount = 0;

    // Pending promise resolvers (for request/response pattern)
    this.pendingRequests = new Map();
    this.requestId = 0;
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  toJSON() {
    return {
      contextId: this.contextId,
      status: this.status,
      userId: this.userId,
      runId: this.runId,
      runName: this.runName,
      runtimePath: this.runtimePath,
      topic: this.topic,
      cycleCount: this.cycleCount,
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastActivity: this.lastActivity,
      error: this.error
    };
  }
}

/**
 * WorkerOrchestratorManager - Manages pool of worker threads
 */
class WorkerOrchestratorManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {number} options.maxWorkers - Maximum concurrent workers (default: 5)
   * @param {number} options.workerTimeout - Idle timeout in ms (default: 4 hours)
   * @param {Object} options.logger - Logger instance
   */
  constructor(options = {}) {
    super();
    this.maxWorkers = options.maxWorkers || 5;
    this.workerTimeout = options.workerTimeout || 4 * 60 * 60 * 1000;
    this.logger = options.logger || console;

    // Active workers: contextId -> WorkerContext
    this.workers = new Map();

    // Event handlers for broadcasting to WebSocket
    this.eventHandlers = new Map();

    // Start cleanup interval
    this._cleanupInterval = setInterval(() => this._cleanupStaleWorkers(), 60000);
  }

  /**
   * Get number of active workers
   */
  get activeCount() {
    let count = 0;
    for (const ctx of this.workers.values()) {
      if (ctx.status === 'running' || ctx.status === 'initializing') {
        count++;
      }
    }
    return count;
  }

  /**
   * Check if capacity available
   */
  hasCapacity() {
    return this.activeCount < this.maxWorkers;
  }

  /**
   * Get worker for a user
   */
  getWorkerForUser(userId) {
    for (const [contextId, ctx] of this.workers) {
      if (ctx.userId === userId && (ctx.status === 'running' || ctx.status === 'initializing')) {
        return ctx;
      }
    }
    return null;
  }

  /**
   * Get worker by context ID
   */
  getWorker(contextId) {
    return this.workers.get(contextId);
  }

  /**
   * Start a new worker for a context
   *
   * @param {string} contextId - Unique context ID (e.g., 'userId_runId')
   * @param {Object} config - Worker configuration
   * @param {string} config.runtimePath - Path for this context's files
   * @param {Object} config.engineConfig - COSMO engine configuration
   * @param {string} config.userId - User ID
   * @param {string} config.runId - Run ID
   * @param {string} config.runName - Human-readable run name
   * @param {string} config.topic - Research topic
   * @returns {Promise<WorkerContext>}
   */
  async startWorker(contextId, config) {
    // Check if context already exists
    if (this.workers.has(contextId)) {
      const existing = this.workers.get(contextId);
      if (existing.status === 'running') {
        throw new Error(`Context ${contextId} is already running`);
      }
      // Clean up stopped worker
      await this.removeWorker(contextId);
    }

    // Check capacity
    if (!this.hasCapacity()) {
      throw new Error(`Maximum workers reached (${this.maxWorkers}). Please wait or queue.`);
    }

    this.logger.info(`[WorkerManager] Starting worker for context: ${contextId}`);

    return new Promise((resolve, reject) => {
      try {
        // Create worker thread
        const worker = new Worker(WORKER_SCRIPT, {
          workerData: { workerId: contextId }
        });

        // Create context
        const ctx = new WorkerContext(contextId, worker);
        ctx.userId = config.userId;
        ctx.runId = config.runId;
        ctx.runName = config.runName;
        ctx.runtimePath = config.runtimePath;
        ctx.topic = config.topic;

        this.workers.set(contextId, ctx);

        // Handle worker messages
        worker.on('message', (message) => {
          this._handleWorkerMessage(contextId, message);
        });

        // Handle worker errors
        worker.on('error', (error) => {
          this.logger.error(`[WorkerManager] Worker ${contextId} error:`, error.message);
          ctx.status = 'error';
          ctx.error = error.message;
          this.emit('workerError', { contextId, error: error.message });
        });

        // Handle worker exit
        worker.on('exit', (code) => {
          this.logger.info(`[WorkerManager] Worker ${contextId} exited with code ${code}`);
          ctx.status = code === 0 ? 'stopped' : 'error';
          ctx.stoppedAt = Date.now();
          if (code !== 0) {
            ctx.error = `Worker exited with code ${code}`;
          }
          this.emit('workerExit', { contextId, code });
        });

        // Wait for worker to be ready, then send start command
        const readyHandler = (message) => {
          if (message.type === 'ready') {
            ctx.status = 'ready';

            // Send start command
            worker.postMessage({
              type: 'start',
              config: {
                contextId,
                runtimePath: config.runtimePath,
                runName: config.runName,
                engineConfig: config.engineConfig
              }
            });
          } else if (message.type === 'started') {
            ctx.status = 'running';
            ctx.startedAt = Date.now();
            this.logger.info(`[WorkerManager] Worker ${contextId} started successfully`);
            this.emit('workerStarted', { contextId, runName: config.runName });
            resolve(ctx);
          } else if (message.type === 'error') {
            ctx.status = 'error';
            ctx.error = message.error;
            reject(new Error(message.error));
          }
        };

        // Temporary handler for startup sequence
        const originalHandler = worker.listeners('message')[0];
        worker.removeAllListeners('message');
        worker.on('message', (message) => {
          readyHandler(message);
          if (message.type === 'started' || message.type === 'error') {
            // Restore normal handler
            worker.removeAllListeners('message');
            worker.on('message', (msg) => this._handleWorkerMessage(contextId, msg));
          }
        });

        // Timeout for startup (180s - orchestrator init is heavy: crash recovery,
        // state loading, telemetry, evaluation framework, cluster state store, etc.
        // Merged runs with thousands of memory nodes need extra time)
        setTimeout(() => {
          if (ctx.status === 'initializing' || ctx.status === 'ready') {
            ctx.status = 'error';
            ctx.error = 'Worker startup timeout';
            reject(new Error('Worker startup timeout'));
          }
        }, 180000);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop a worker gracefully
   *
   * @param {string} contextId - Context ID to stop
   * @param {Object} options - Stop options
   * @param {boolean} options.force - Force immediate termination
   * @param {number} options.timeout - Graceful shutdown timeout in ms
   * @returns {Promise<Object>} Stop result
   */
  async stopWorker(contextId, options = {}) {
    const ctx = this.workers.get(contextId);
    if (!ctx) {
      this.logger.warn(`[WorkerManager] Worker ${contextId} not found`);
      return { success: false, error: 'Worker not found' };
    }

    if (ctx.status === 'stopped') {
      return { success: true, wasRunning: false };
    }

    this.logger.info(`[WorkerManager] Stopping worker ${contextId}`);
    ctx.status = 'stopping';

    return new Promise((resolve) => {
      const timeout = options.timeout || 30000;

      // Send stop command
      ctx.worker.postMessage({ type: 'stop' });

      // Handler for stop response
      const stopHandler = (message) => {
        if (message.type === 'stopped') {
          ctx.worker.removeListener('message', stopHandler);
          ctx.status = 'stopped';
          ctx.stoppedAt = Date.now();
          ctx.cycleCount = message.cycleCount || ctx.cycleCount;

          this.logger.info(`[WorkerManager] Worker ${contextId} stopped`, {
            cycleCount: ctx.cycleCount,
            durationMs: message.durationMs
          });

          this.emit('workerStopped', {
            contextId,
            runName: ctx.runName,
            cycleCount: ctx.cycleCount
          });

          resolve({
            success: true,
            wasRunning: true,
            runName: ctx.runName,
            cycleCount: ctx.cycleCount
          });
        }
      };

      ctx.worker.on('message', stopHandler);

      // Timeout - force terminate if needed
      setTimeout(() => {
        if (ctx.status === 'stopping') {
          this.logger.warn(`[WorkerManager] Worker ${contextId} stop timeout, terminating`);
          ctx.worker.terminate();
          ctx.status = 'stopped';
          ctx.stoppedAt = Date.now();
          resolve({
            success: true,
            wasRunning: true,
            forced: true,
            runName: ctx.runName
          });
        }
      }, timeout);
    });
  }

  /**
   * Remove a worker from tracking
   */
  async removeWorker(contextId) {
    const ctx = this.workers.get(contextId);
    if (!ctx) return;

    if (ctx.status === 'running' || ctx.status === 'stopping') {
      await this.stopWorker(contextId);
    }

    // Terminate if still alive
    try {
      ctx.worker.terminate();
    } catch (e) {
      // Ignore termination errors
    }

    this.workers.delete(contextId);
    this.logger.info(`[WorkerManager] Removed worker ${contextId}`);
  }

  /**
   * Stop all workers
   */
  async stopAll() {
    this.logger.info(`[WorkerManager] Stopping all workers (${this.workers.size} active)`);

    const stopPromises = [];
    for (const contextId of this.workers.keys()) {
      stopPromises.push(this.stopWorker(contextId));
    }

    await Promise.all(stopPromises);
    this.logger.info('[WorkerManager] All workers stopped');
  }

  /**
   * Get status of a worker
   */
  async getWorkerStatus(contextId) {
    const ctx = this.workers.get(contextId);
    if (!ctx) return null;

    return new Promise((resolve) => {
      ctx.worker.postMessage({ type: 'getStatus' });

      const handler = (message) => {
        if (message.type === 'status' && message.contextId === contextId) {
          ctx.worker.removeListener('message', handler);
          ctx.cycleCount = message.cycleCount || ctx.cycleCount;
          ctx.nodeCount = message.nodeCount || ctx.nodeCount;
          ctx.edgeCount = message.edgeCount || ctx.edgeCount;
          resolve(ctx.toJSON());
        }
      };

      ctx.worker.on('message', handler);

      // Timeout
      setTimeout(() => {
        ctx.worker.removeListener('message', handler);
        resolve(ctx.toJSON());
      }, 5000);
    });
  }

  /**
   * Handle messages from workers
   */
  _handleWorkerMessage(contextId, message) {
    const ctx = this.workers.get(contextId);
    if (!ctx) return;

    ctx.updateActivity();

    switch (message.type) {
      case 'event':
        // Forward event to registered handlers (for WebSocket broadcast)
        // Debug: Log important events
        if (['cycle_start', 'cycle_complete', 'thought_generated', 'run_status'].includes(message.eventType)) {
          this.logger.info(`[WorkerManager] Forwarding event`, {
            eventType: message.eventType,
            contextId: contextId?.slice(-8)
          });
        }
        this.emit('workerEvent', {
          contextId,
          eventType: message.eventType,
          eventData: message.eventData
        });
        break;

      case 'status':
        ctx.cycleCount = message.cycleCount || ctx.cycleCount;
        ctx.nodeCount = message.nodeCount || ctx.nodeCount;
        ctx.edgeCount = message.edgeCount || ctx.edgeCount;
        break;

      case 'error':
        this.logger.error(`[WorkerManager] Worker ${contextId} reported error:`, message.error);
        if (message.fatal) {
          ctx.status = 'error';
          ctx.error = message.error;
        }
        this.emit('workerError', { contextId, error: message.error, fatal: message.fatal });
        break;

      case 'completed':
        this.logger.info(`[WorkerManager] Worker ${contextId} completed research`);
        this.emit('workerCompleted', { contextId, runName: message.runName });
        break;

      default:
        // Ignore other message types
        break;
    }
  }

  /**
   * Clean up stale/idle workers
   */
  _cleanupStaleWorkers() {
    const now = Date.now();
    for (const [contextId, ctx] of this.workers) {
      // Remove stopped workers older than 5 minutes
      if (ctx.status === 'stopped' && now - ctx.stoppedAt > 5 * 60 * 1000) {
        this.removeWorker(contextId);
        continue;
      }

      // Check for idle timeout (only if running)
      if (ctx.status === 'running' && now - ctx.lastActivity > this.workerTimeout) {
        this.logger.warn(`[WorkerManager] Worker ${contextId} idle timeout, stopping`);
        this.stopWorker(contextId);
      }
    }
  }

  /**
   * Get manager statistics
   */
  getStats() {
    const workers = [];
    for (const ctx of this.workers.values()) {
      workers.push(ctx.toJSON());
    }

    return {
      maxWorkers: this.maxWorkers,
      activeCount: this.activeCount,
      totalWorkers: this.workers.size,
      hasCapacity: this.hasCapacity(),
      workers
    };
  }

  /**
   * Shutdown the manager
   */
  async shutdown() {
    clearInterval(this._cleanupInterval);
    await this.stopAll();
  }
}

module.exports = { WorkerOrchestratorManager, WorkerContext };
