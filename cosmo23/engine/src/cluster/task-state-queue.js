const fs = require('fs').promises;
const path = require('path');

/**
 * TaskStateQueue - Serializes all task state changes
 * 
 * Purpose:
 * - Eliminates race conditions from concurrent task state updates
 * - Provides single point of truth for task lifecycle
 * - Maintains append-only event log (JSONL)
 * - Integrates with cosmo-progress.md spine
 * 
 * Pattern: Same as AgentResultsQueue (proven to work)
 * 
 * Flow:
 * 1. Any component needs to change task state → enqueue() called
 * 2. Orchestrator calls processAll() each cycle
 * 3. Events processed serially (no races)
 * 4. Task files and progress spine updated atomically
 */
class TaskStateQueue {
  constructor(logsDir, logger) {
    this.logsDir = logsDir;
    this.logger = logger;
    this.queue = [];
    this.processed = [];
    this.queuePath = path.join(logsDir, 'coordinator', 'task_state_queue.jsonl');
    this.initialized = false;
  }

  /**
   * Initialize queue - Load existing queue from disk
   */
  async initialize() {
    try {
      // Ensure coordinator directory exists
      const coordinatorDir = path.join(this.logsDir, 'coordinator');
      await fs.mkdir(coordinatorDir, { recursive: true });
      
      await this.loadQueue();
      this.initialized = true;
      
      this.logger.info('✅ Task state queue initialized', {
        pending: this.queue.filter(e => !e.processed).length,
        processed: this.queue.filter(e => e.processed).length
      });
    } catch (error) {
      this.logger.error('Failed to initialize task state queue', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Enqueue a task state change event
   * @param {Object} event - State change event
   */
  async enqueue(event) {
    if (!this.initialized) {
      this.logger.warn('Task state queue not initialized, initializing now');
      await this.initialize();
    }

    const queuedEvent = {
      ...event,
      queuedAt: Date.now(),
      processed: false
    };

    this.queue.push(queuedEvent);
    await this.persistEvent(queuedEvent);
    
    this.logger.debug('📝 Task state event queued', {
      type: event.type,
      taskId: event.taskId,
      cycle: event.cycle
    });
  }

  /**
   * Get all unprocessed events
   * @returns {Array}
   */
  getPending() {
    return this.queue.filter(e => !e.processed);
  }

  /**
   * Process all pending events serially
   * @param {Object} stateStore - ClusterStateStore instance
   * @param {Object} orchestrator - Orchestrator instance (for progress spine)
   */
  async processAll(stateStore, orchestrator) {
    const pending = this.getPending();
    
    if (pending.length === 0) {
      return { processed: 0 };
    }

    this.logger.debug('📋 Processing task state events', { count: pending.length });

    let processed = 0;

    for (const event of pending) {
      try {
        await this.processEvent(event, stateStore, orchestrator);
        event.processed = true;
        event.processedAt = Date.now();
        this.processed.push(event);
        processed++;
      } catch (error) {
        this.logger.error('Failed to process task state event', {
          type: event.type,
          taskId: event.taskId,
          error: error.message
        });
        // Mark as processed anyway to avoid infinite retries
        event.processed = true;
        event.processedAt = Date.now();
        event.error = error.message;
      }
    }

    // Remove processed events from queue (keep for 1 hour for debugging)
    const oneHourAgo = Date.now() - 3600000;
    this.processed = this.processed.filter(e => e.processedAt > oneHourAgo);
    this.queue = this.queue.filter(e => !e.processed || e.processedAt > oneHourAgo);
    await this.persistQueueSnapshot();

    if (processed > 0) {
      this.logger.debug('✅ Task state queue processed', { processed });
    }

    return { processed };
  }

  /**
   * Process a single task state event
   * @param {Object} event - The event to process
   * @param {Object} stateStore - ClusterStateStore
   * @param {Object} orchestrator - Orchestrator (for recordPlanEvent)
   */
  async processEvent(event, stateStore, orchestrator) {
    if (await this.isStalePlanEvent(event, stateStore)) {
      this.logger.warn('Skipping stale task state event from a previous plan generation', {
        type: event.type,
        taskId: event.taskId,
        queuedAt: event.queuedAt
      });
      return false;
    }

    switch (event.type) {
      case 'CLAIM_TASK':
        return await stateStore.claimTask(event.taskId, event.instanceId, event.ttl);
      
      case 'START_TASK':
        return await stateStore.startTask(event.taskId, event.instanceId);
      
      case 'COMPLETE_TASK':
        await stateStore.completeTask(event.taskId, {
          artifacts: event.artifacts || event.producedArtifacts || [],
          consumedArtifacts: event.consumedArtifacts || [],
          producedArtifacts: event.producedArtifacts || event.artifacts || [],
          updatedArtifacts: event.updatedArtifacts || [],
          supersededArtifacts: event.supersededArtifacts || [],
          promotedArtifacts: event.promotedArtifacts || [],
          deprecatedArtifacts: event.deprecatedArtifacts || [],
          failedArtifacts: event.failedArtifacts || [],
          openDependencies: event.openDependencies || [],
          newClaims: event.newClaims || [],
          supportedClaims: event.supportedClaims || [],
          supersededClaims: event.supersededClaims || [],
          nextReuseInstructions: event.nextReuseInstructions || [],
          closureStatus: event.closureStatus || null,
          source: event.source || null
        });
        
        // Update progress spine if orchestrator available
        if (orchestrator?.recordPlanEvent) {
          const phaseNum = event.taskId.match(/phase(\d+)/)?.[1] || '?';
          orchestrator.recordPlanEvent('phase_completed', {
            phaseNumber: phaseNum,
            phaseName: event.phaseName,
            description: `Phase ${phaseNum} complete`,
            artifacts: event.artifactCount || 0
          });
        }
        break;
      
      case 'FAIL_TASK':
        await stateStore.failTask(event.taskId, event.reason);
        
        // Update progress spine if orchestrator available
        if (orchestrator?.recordPlanEvent) {
          const phaseNum = event.taskId.match(/phase(\d+)/)?.[1] || '?';
          orchestrator.recordPlanEvent('phase_failed', {
            phaseNumber: phaseNum,
            phaseName: event.phaseName,
            description: `Phase ${phaseNum} failed: ${event.reason?.substring(0, 100)}`,
            reason: event.reason
          });
        }
        break;
      
      case 'RETRY_TASK':
        return await stateStore.retryTask(event.taskId, event.reason);
      
      case 'UPDATE_TASK':
        return await stateStore.upsertTask(event.task);
      
      default:
        this.logger.warn('Unknown task event type', { type: event.type });
    }
  }

  /**
   * Persist a single event to disk (append to JSONL)
   */
  async persistEvent(event) {
    try {
      const line = JSON.stringify(event) + '\n';
      await fs.appendFile(this.queuePath, line);
    } catch (error) {
      this.logger.error('Failed to persist task state event', {
        type: event.type,
        taskId: event.taskId,
        error: error.message
      });
    }
  }

  /**
   * Rewrite retained queue state so processed flags survive restarts.
   * The queue is append-oriented while running, but replay safety requires a
   * compacted snapshot after processing; otherwise old processed events reload
   * as pending because the original JSONL line still says processed:false.
   */
  async persistQueueSnapshot() {
    try {
      const retained = [...this.processed, ...this.queue]
        .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
      const content = retained.length > 0
        ? retained.map(event => JSON.stringify(event)).join('\n') + '\n'
        : '';
      await fs.writeFile(this.queuePath, content, 'utf8');
    } catch (error) {
      this.logger.error('Failed to persist task state queue snapshot', {
        error: error.message
      });
    }
  }

  async isStalePlanEvent(event, stateStore) {
    if (!event || !stateStore?.getPlan) return false;
    const taskId = event.taskId || event.task?.id || '';
    const planId = event.task?.planId || (taskId.startsWith('task:phase') || taskId === 'task:synthesis_final' ? 'plan:main' : null);
    if (!planId) return false;

    const plan = await stateStore.getPlan(planId).catch(() => null);
    const planCreatedAt = Number(plan?.createdAt || 0);
    const eventQueuedAt = Number(event.queuedAt || 0);
    const taskCreatedAt = Number(event.task?.createdAt || 0);

    if (!planCreatedAt) return false;
    if (eventQueuedAt && eventQueuedAt < planCreatedAt) return true;
    if (taskCreatedAt && taskCreatedAt < planCreatedAt) return true;
    return false;
  }

  /**
   * Load queue from disk
   */
  async loadQueue() {
    try {
      const data = await fs.readFile(this.queuePath, 'utf8');
      const lines = data.trim().split('\n').filter(l => l);
      
      const events = [];
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          
          // Convert timestamps back to numbers
          if (entry.queuedAt) entry.queuedAt = new Date(entry.queuedAt).getTime();
          if (entry.processedAt) entry.processedAt = new Date(entry.processedAt).getTime();
          
          events.push(entry);
        } catch (parseError) {
          this.logger.warn('Failed to parse task state queue line', {
            error: parseError.message
          });
        }
      }
      
      // Only keep unprocessed events in active queue
      this.queue = events.filter(e => !e.processed);
      this.processed = events.filter(e => e.processed);
      
      this.logger.debug('Task state queue loaded from disk', {
        totalLines: lines.length,
        eventsLoaded: events.length,
        pendingEvents: this.queue.length
      });
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet - that's fine
        this.logger.debug('No existing task state queue file found, starting fresh');
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
      pending: this.queue.filter(e => !e.processed).length,
      processed: this.processed.length,
      byType: this.getEventTypeDistribution()
    };
  }

  /**
   * Get distribution of event types
   */
  getEventTypeDistribution() {
    const distribution = {};
    for (const event of this.queue) {
      distribution[event.type] = (distribution[event.type] || 0) + 1;
    }
    return distribution;
  }

  /**
   * Export queue state for monitoring
   */
  exportState() {
    return {
      pending: this.getPending().map(e => ({
        type: e.type,
        taskId: e.taskId,
        cycle: e.cycle,
        queuedAt: e.queuedAt
      })),
      stats: this.getStats()
    };
  }
}

module.exports = { TaskStateQueue };
