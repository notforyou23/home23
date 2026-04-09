/**
 * Context-Aware Event System for Multi-Tenant COSMO
 *
 * Replaces the singleton event emitter with a context-aware version that:
 * 1. Routes events to the correct context's listeners
 * 2. Prevents cross-tenant event leakage
 * 3. Maintains backward compatibility with existing code
 *
 * @example
 * // Creating context-specific emitter
 * const events = contextEventRegistry.getEmitter('user123_run456');
 * events.emitThought({ ... });  // Only sent to this context's listeners
 *
 * // Subscribing to a context
 * contextEventRegistry.subscribe('user123_run456', (event) => {
 *   // Handle events for this context only
 * });
 */

const EventEmitter = require('events');

/**
 * Context-specific event emitter
 * Each COSMO context gets its own emitter instance
 */
class ContextEventEmitter extends EventEmitter {
  constructor(contextId) {
    super();
    this.contextId = contextId;
    this.setMaxListeners(50);
    this.enabled = true;
    this.eventCount = 0;
    this.startTime = Date.now();
  }

  /**
   * Enable/disable event emission
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  /**
   * Internal emit wrapper that adds context and metadata
   */
  _emit(type, data) {
    if (!this.enabled) return;

    this.eventCount++;
    const event = {
      type,
      contextId: this.contextId,
      timestamp: Date.now(),
      eventId: this.eventCount,
      ...data
    };

    this.emit(type, event);
    this.emit('*', event); // Wildcard for WebSocket broadcast
  }

  // ============================================
  // CYCLE EVENTS
  // ============================================

  emitCycleStart(data) {
    this._emit('cycle_start', {
      cycle: data.cycle,
      mode: data.mode || 'focus',
      cognitiveState: data.cognitiveState || null
    });
  }

  emitCycleComplete(data) {
    this._emit('cycle_complete', {
      cycle: data.cycle,
      duration: data.duration,
      nodesCreated: data.nodesCreated || 0,
      edgesCreated: data.edgesCreated || 0,
      summary: data.summary || null
    });
  }

  // ============================================
  // THOUGHT EVENTS
  // ============================================

  emitThought(data) {
    this._emit('thought_generated', {
      cycle: data.cycle,
      thought: data.thought,
      role: data.role,
      surprise: data.surprise || 0,
      model: data.model || 'unknown',
      reasoning: data.reasoning || null,
      usedWebSearch: data.usedWebSearch || false
    });
  }

  // ============================================
  // AGENT EVENTS
  // ============================================

  emitAgentSpawned(data) {
    this._emit('agent_spawned', {
      agentId: data.agentId,
      agentType: data.agentType,
      goalId: data.goalId || null,
      description: data.description || null,
      cycle: data.cycle || null,
      triggerSource: data.triggerSource || 'orchestrator'
    });
  }

  emitAgentCompleted(data) {
    this._emit('agent_completed', {
      agentId: data.agentId,
      agentType: data.agentType,
      status: data.status || 'completed',
      duration: data.duration || 0,
      artifacts: data.artifacts || [],
      nodesCreated: data.nodesCreated || 0,
      edgesCreated: data.edgesCreated || 0,
      goalId: data.goalId || null
    });
  }

  emitAgentFailed(data) {
    this._emit('agent_failed', {
      agentId: data.agentId,
      agentType: data.agentType,
      error: data.error,
      cycle: data.cycle || null
    });
  }

  // ============================================
  // MEMORY EVENTS
  // ============================================

  emitNodeCreated(data) {
    this._emit('node_created', {
      nodeId: data.nodeId,
      concept: typeof data.concept === 'string'
        ? data.concept.substring(0, 200)
        : String(data.concept).substring(0, 200),
      tag: data.tag || 'general',
      cluster: data.cluster || null
    });
  }

  emitEdgeCreated(data) {
    this._emit('edge_created', {
      source: data.source,
      target: data.target,
      weight: data.weight || 1.0
    });
  }

  emitMemoryConsolidated(data) {
    this._emit('memory_consolidated', {
      nodesProcessed: data.nodesProcessed || 0,
      edgesProcessed: data.edgesProcessed || 0,
      duration: data.duration || 0
    });
  }

  // ============================================
  // SLEEP/WAKE EVENTS
  // ============================================

  emitSleepTriggered(data) {
    this._emit('sleep_triggered', {
      reason: data.reason || 'unknown',
      energy: data.energy || 0,
      fatigue: data.fatigue || 0,
      cycle: data.cycle || null
    });
  }

  emitWakeTriggered(data) {
    this._emit('wake_triggered', {
      sleepDuration: data.sleepDuration || 0,
      cyclesSlept: data.cyclesSlept || 0,
      energyRestored: data.energyRestored || 0
    });
  }

  emitDreamRewiring(data) {
    this._emit('dream_rewiring', {
      bridgesCreated: data.bridgesCreated || 0,
      cycle: data.cycle || null
    });
  }

  // ============================================
  // COGNITIVE STATE EVENTS
  // ============================================

  emitCognitiveStateChanged(data) {
    this._emit('cognitive_state_changed', {
      metric: data.metric,
      oldValue: data.oldValue,
      newValue: data.newValue,
      trigger: data.trigger || null,
      energy: data.energy,
      curiosity: data.curiosity,
      mood: data.mood
    });
  }

  emitOscillatorModeChanged(data) {
    this._emit('oscillator_mode_changed', {
      oldMode: data.oldMode,
      newMode: data.newMode,
      reason: data.reason || null
    });
  }

  // ============================================
  // COORDINATION EVENTS
  // ============================================

  emitCoordinatorReview(data) {
    this._emit('coordinator_review', {
      cycle: data.cycle,
      summary: data.summary || null,
      directivesCount: data.directivesCount || 0,
      agentsSpawned: data.agentsSpawned || 0
    });
  }

  emitExecutiveDecision(data) {
    this._emit('executive_decision', {
      cycle: data.cycle,
      action: data.action,
      reason: data.reason || null,
      coherence: data.coherence || null
    });
  }

  // ============================================
  // INSIGHT/GOAL EVENTS
  // ============================================

  emitInsightDetected(data) {
    this._emit('insight_detected', {
      insight: data.insight,
      noveltyScore: data.noveltyScore || 0,
      source: data.source || 'synthesis'
    });
  }

  emitGoalCreated(data) {
    this._emit('goal_created', {
      goalId: data.goalId,
      description: data.description,
      source: data.source || 'auto_capture',
      priority: data.priority || 0.5
    });
  }

  emitGoalCompleted(data) {
    this._emit('goal_completed', {
      goalId: data.goalId,
      description: data.description || null,
      outcome: data.outcome || 'completed'
    });
  }

  // ============================================
  // DIRECT ACTION EVENTS (COSMO Hands)
  // ============================================

  /**
   * Emit when a direct action is executed (no agent spawn)
   * NEW EVENT TYPE for COSMO Hands - multi-tenant context-aware
   */
  emitDirectAction(data) {
    this._emit('direct_action', {
      actionType: data.actionType,
      goalId: data.goalId || null,
      taskId: data.taskId || null,
      path: data.path || null,
      success: data.success,
      duration: data.duration || null,
      cycle: data.cycle || null,
      error: data.error || null
    });
  }

  // ============================================
  // WEB SEARCH EVENTS
  // ============================================

  emitWebSearch(data) {
    this._emit('web_search', {
      query: data.query,
      resultCount: data.resultCount || 0,
      sources: data.sources || []
    });
  }

  // ============================================
  // RUN STATUS EVENTS
  // ============================================

  emitRunStatus(data) {
    this._emit('run_status', {
      status: data.status,
      message: data.message,
      cycle: data.cycle || null,
      details: data.details || {}
    });
  }

  emitResearchComplete(data) {
    this._emit('research_complete', {
      reason: data.reason || 'unknown',
      totalCycles: data.totalCycles || 0,
      runtime: data.runtime || 0,
      summary: data.summary || null
    });
  }

  // ============================================
  // GENERIC EVENT
  // ============================================

  emitEvent(type, data) {
    this._emit(type, data);
  }

  // ============================================
  // STATS
  // ============================================

  getStats() {
    return {
      contextId: this.contextId,
      eventCount: this.eventCount,
      uptime: Date.now() - this.startTime,
      enabled: this.enabled,
      listenerCount: this.listenerCount('*')
    };
  }
}

/**
 * Registry for context-specific event emitters
 * Central point for managing all context emitters
 */
class ContextEventRegistry {
  constructor() {
    this.emitters = new Map(); // contextId -> ContextEventEmitter
    this.globalListeners = new Set(); // Listeners that receive ALL events (for logging/monitoring)
  }

  /**
   * Get or create an emitter for a context
   * @param {string} contextId
   * @returns {ContextEventEmitter}
   */
  getEmitter(contextId) {
    if (!this.emitters.has(contextId)) {
      const emitter = new ContextEventEmitter(contextId);

      // Wire up global listeners
      emitter.on('*', (event) => {
        for (const listener of this.globalListeners) {
          try {
            listener(event);
          } catch (e) {
            console.error('[ContextEventRegistry] Global listener error:', e);
          }
        }
      });

      this.emitters.set(contextId, emitter);
    }
    return this.emitters.get(contextId);
  }

  /**
   * Check if context has an emitter
   * @param {string} contextId
   * @returns {boolean}
   */
  hasEmitter(contextId) {
    return this.emitters.has(contextId);
  }

  /**
   * Remove emitter for a context (cleanup)
   * @param {string} contextId
   */
  removeEmitter(contextId) {
    const emitter = this.emitters.get(contextId);
    if (emitter) {
      emitter.removeAllListeners();
      this.emitters.delete(contextId);
    }
  }

  /**
   * Subscribe to events for a specific context
   * @param {string} contextId
   * @param {Function} listener - Called with (event)
   * @returns {Function} Unsubscribe function
   */
  subscribe(contextId, listener) {
    const emitter = this.getEmitter(contextId);
    emitter.on('*', listener);
    return () => emitter.off('*', listener);
  }

  /**
   * Subscribe to ALL events from ALL contexts (for monitoring/logging)
   * @param {Function} listener - Called with (event)
   * @returns {Function} Unsubscribe function
   */
  subscribeGlobal(listener) {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  /**
   * List all active contexts
   * @returns {string[]}
   */
  listContexts() {
    return Array.from(this.emitters.keys());
  }

  /**
   * Get stats for all emitters
   * @returns {Object}
   */
  getStats() {
    const stats = {
      contextCount: this.emitters.size,
      globalListenerCount: this.globalListeners.size,
      contexts: {}
    };

    for (const [id, emitter] of this.emitters.entries()) {
      stats.contexts[id] = emitter.getStats();
    }

    return stats;
  }

  /**
   * Clean up all emitters
   */
  destroy() {
    for (const contextId of this.emitters.keys()) {
      this.removeEmitter(contextId);
    }
    this.globalListeners.clear();
  }
}

// Global registry instance
const contextEventRegistry = new ContextEventRegistry();

/**
 * Backward compatibility wrapper
 *
 * For code that still imports `cosmoEvents` from the old event-emitter,
 * this creates a proxy that routes to the correct context.
 *
 * Usage in transition period:
 *   const { createLegacyEmitter } = require('./context-events');
 *   const cosmoEvents = createLegacyEmitter(() => getCurrentContextId());
 */
function createLegacyEmitter(getContextId) {
  // Return a proxy that forwards calls to the right context emitter
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'on' || prop === 'off' || prop === 'once' || prop === 'emit') {
        // Event subscription methods
        return (...args) => {
          const contextId = getContextId();
          if (!contextId) {
            console.warn('[LegacyEmitter] No context ID available');
            return;
          }
          const emitter = contextEventRegistry.getEmitter(contextId);
          return emitter[prop](...args);
        };
      }

      if (typeof prop === 'string' && prop.startsWith('emit')) {
        // Emit methods (emitThought, emitCycleStart, etc.)
        return (...args) => {
          const contextId = getContextId();
          if (!contextId) {
            console.warn(`[LegacyEmitter] No context for ${prop}`);
            return;
          }
          const emitter = contextEventRegistry.getEmitter(contextId);
          if (typeof emitter[prop] === 'function') {
            return emitter[prop](...args);
          }
        };
      }

      if (prop === 'isEnabled' || prop === 'setEnabled' || prop === 'getStats') {
        return (...args) => {
          const contextId = getContextId();
          if (!contextId) return prop === 'isEnabled' ? false : {};
          const emitter = contextEventRegistry.getEmitter(contextId);
          return emitter[prop](...args);
        };
      }

      return undefined;
    }
  });
}

module.exports = {
  ContextEventEmitter,
  ContextEventRegistry,
  contextEventRegistry,
  createLegacyEmitter
};
