const fs = require('fs').promises;
const path = require('path');

/**
 * AgentResultsQueue - Asynchronous results collection and integration
 * 
 * Purpose:
 * - Collects results from completed agents
 * - Persists to disk for durability
 * - Provides queue for orchestrator to process
 * - Tracks integration status
 * 
 * Flow:
 * 1. Agent completes → enqueue() called
 * 2. Orchestrator periodically calls getPending()
 * 3. Orchestrator integrates results
 * 4. Orchestrator calls markIntegrated()
 */
class AgentResultsQueue {
  constructor(logsDir, logger) {
    this.logsDir = logsDir;
    this.logger = logger;
    this.queue = [];
    this.processed = [];
    this.history = []; // NEW: Store integrated results for task validation
    this.queuePath = path.join(logsDir, 'coordinator', 'results_queue.jsonl');
    this.initialized = false;
  }

  /**
   * Initialize queue - Load existing queue from disk
   */
  async initialize() {
    try {
      // Ensure coordinator directory exists
      const coordinatorDir = path.join(this.logsDir, 'coordinator');
      await fs.mkdir(coordinatorDir, { recursive: true }, 3);
      
      await this.loadQueue();
      this.initialized = true;
      
      this.logger.info('✅ Results queue initialized', {
        pending: this.queue.filter(r => !r.processed).length,
        processed: this.queue.filter(r => r.processed && !r.integrated).length,
        integrated: this.queue.filter(r => r.integrated).length
      }, 3);
    } catch (error) {
      this.logger.error('Failed to initialize results queue', {
        error: error.message
      }, 3);
      throw error;
    }
  }

  /**
   * Add agent results to queue
   * @param {Object} agentResults - Results object from agent.run()
   */
  async enqueue(agentResults) {
    if (!this.initialized) {
      this.logger.warn('Results queue not initialized, initializing now');
      await this.initialize();
    }

    const queuedResult = {
      ...agentResults,
      queuedAt: new Date(),
      processed: false,
      integrated: false
    };

    this.queue.push(queuedResult);
    await this.persistResult(queuedResult);
    
    this.logger.info('📥 Agent results queued', {
      agentId: agentResults.agentId,
      agentType: agentResults.agentType,
      goal: agentResults.mission.goalId,
      status: agentResults.status,
      resultsCount: agentResults.results.length
    }, 3);
  }

  /**
   * Get next unprocessed result (FIFO)
   * @returns {Object|null}
   */
  dequeue() {
    const next = this.queue.find(r => !r.processed);
    if (next) {
      next.processed = true;
      next.processedAt = new Date();
      this.processed.push(next);
      
      this.logger.debug('Dequeued result for processing', {
        agentId: next.agentId
      }, 3);
    }
    return next || null;
  }

  /**
   * Get all unprocessed results
   * @returns {Array}
   */
  getPending() {
    return this.queue.filter(r => !r.processed);
  }

  /**
   * Get all processed but not yet integrated results
   * @returns {Array}
   */
  getProcessed() {
    return this.queue.filter(r => r.processed && !r.integrated);
  }

  /**
   * Mark result as fully integrated
   * @param {string} agentId - The agent ID to mark as integrated
   */
  async markIntegrated(agentId) {
    const result = this.queue.find(r => r.agentId === agentId);
    if (result) {
      // FIX: Set both flags to prevent re-processing
      result.processed = true;
      result.integrated = true;
      result.integratedAt = new Date();
      
      // Append integration marker to log (ONLY ONCE now!)
      await this.persistIntegrationMarker(agentId);
      
      // Move from queue to history
      this.history.push(result);
      this.queue = this.queue.filter(r => r.agentId !== agentId);
      
      this.logger.info('✅ Agent results integrated', {
        agentId,
        goal: result.mission.goalId,
        totalTime: result.integratedAt - result.queuedAt
      }, 3);
    } else {
      this.logger.warn('Attempted to mark unknown agent as integrated', {
        agentId
      }, 3);
    }
  }

  /**
   * Persist a single result to disk (append to JSONL)
   */
  async persistResult(result) {
    try {
      const line = JSON.stringify(result) + '\n';
      await fs.appendFile(this.queuePath, line);
    } catch (error) {
      this.logger.error('Failed to persist result', {
        agentId: result.agentId,
        error: error.message
      }, 3);
    }
  }

  /**
   * Persist integration marker
   */
  async persistIntegrationMarker(agentId) {
    try {
      const marker = {
        type: 'integration_marker',
        agentId,
        timestamp: new Date()
      };
      const line = JSON.stringify(marker) + '\n';
      await fs.appendFile(this.queuePath, line);
    } catch (error) {
      this.logger.error('Failed to persist integration marker', {
        agentId,
        error: error.message
      }, 3);
    }
  }

  /**
   * Load queue from disk
   */
  async loadQueue() {
    try {
      const data = await fs.readFile(this.queuePath, 'utf8');
      const lines = data.trim().split('\n').filter(l => l);
      
      // Process JSONL file
      const integrationMarkers = new Set();
      const results = [];
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          
          if (entry.type === 'integration_marker') {
            integrationMarkers.add(entry.agentId);
          } else {
            // It's a result entry
            // Convert date strings back to Date objects
            if (entry.queuedAt) entry.queuedAt = new Date(entry.queuedAt);
            if (entry.processedAt) entry.processedAt = new Date(entry.processedAt);
            if (entry.integratedAt) entry.integratedAt = new Date(entry.integratedAt);
            if (entry.startTime) entry.startTime = new Date(entry.startTime);
            if (entry.endTime) entry.endTime = new Date(entry.endTime);
            
            results.push(entry);
          }
        } catch (parseError) {
          this.logger.warn('Failed to parse queue line', {
            error: parseError.message
          }, 3);
        }
      }
      
      // Mark results as integrated if we have integration markers
      for (const result of results) {
        if (integrationMarkers.has(result.agentId)) {
          // FIX: Set BOTH flags when loading from disk
          result.processed = true;
          result.integrated = true;
        }
      }
      
      // Only keep non-integrated results in active queue
      this.queue = results.filter(r => !r.integrated);
      
      // Store integrated results in history for task validation
      this.history = results.filter(r => r.integrated);
      
      this.logger.debug('Queue loaded from disk', {
        totalLines: lines.length,
        resultsLoaded: results.length,
        pendingResults: this.queue.filter(r => !r.processed).length
      }, 3);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet - that's fine
        this.logger.debug('No existing queue file found, starting fresh');
        this.queue = [];
      } else {
        throw error;
      }
    }
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    return {
      total: this.queue.length,
      pending: this.queue.filter(r => !r.processed).length,
      processed: this.queue.filter(r => r.processed && !r.integrated).length,
      integrated: this.queue.filter(r => r.integrated).length,
      byStatus: {
        completed: this.queue.filter(r => r.status === 'completed').length,
        failed: this.queue.filter(r => r.status === 'failed').length,
        timeout: this.queue.filter(r => r.status === 'timeout').length
      }
    };
  }

  /**
   * Get results for a specific goal
   * @param {string} goalId
   * @returns {Array}
   */
  getResultsForGoal(goalId) {
    const fromQueue = this.queue.filter(r => r.mission.goalId === goalId);
    const fromHistory = this.history?.filter(r => r.mission.goalId === goalId) || [];
    
    // Combine and deduplicate by agentId
    const combined = [...fromQueue];
    for (const hr of fromHistory) {
      if (!combined.some(r => r.agentId === hr.agentId)) {
        combined.push(hr);
      }
    }
    
    return combined;
  }

  /**
   * Clean up old integrated results
   * @param {number} maxAge - Max age in milliseconds (default: 24 hours)
   */
  async cleanupOldResults(maxAge = 86400000) {
    const cutoff = Date.now() - maxAge;
    const initialLength = this.queue.length;
    
    this.queue = this.queue.filter(r => {
      if (r.integrated && r.integratedAt) {
        return r.integratedAt.getTime() > cutoff;
      }
      return true; // Keep non-integrated results
    }, 3);
    
    const removed = initialLength - this.queue.length;
    
    if (removed > 0) {
      this.logger.info('Cleaned up old integrated results', {
        removed,
        remaining: this.queue.length
      }, 3);
    }
  }

  /**
   * Get recently integrated results (integrated in last N cycles)
   * 
   * @param {number} cycleCount - Cycles back to look (default 1)
   * @returns {Array} - Array of integrated results
   */
  getRecent(cycleCount = 1) {
    // Return all integrated results - the orchestrator will filter if needed
    // or we can track integration cycle if we want to be more precise
    return this.queue.filter(r => r.integrated);
  }

  /**
   * Export queue state
   */
  exportState() {
    return {
      pending: this.getPending().map(r => ({
        agentId: r.agentId,
        agentType: r.agentType,
        goal: r.mission.goalId,
        status: r.status,
        queuedAt: r.queuedAt
      })),
      processed: this.getProcessed().map(r => ({
        agentId: r.agentId,
        agentType: r.agentType,
        goal: r.mission.goalId,
        status: r.status,
        processedAt: r.processedAt
      })),
      stats: this.getStats()
    };
  }
}

module.exports = { AgentResultsQueue };

