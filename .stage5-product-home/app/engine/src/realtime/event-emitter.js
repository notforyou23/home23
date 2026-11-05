/**
 * COSMO Real-time Event Emitter
 *
 * Singleton event emitter for streaming COSMO's cognitive activity.
 * Import this anywhere in COSMO to emit events that will be broadcast
 * to connected WebSocket clients via the RealtimeServer.
 *
 * Usage:
 *   const { cosmoEvents } = require('./realtime/event-emitter');
 *   cosmoEvents.emitThought({ cycle: 47, thought: '...', role: 'curiosity' });
 */

const EventEmitter = require('events');

class COSMOEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Support many WebSocket connections
    this.enabled = true;
    this.eventCount = 0;
    this.startTime = Date.now();
  }

  /**
   * Check if emitter is enabled (can be disabled for testing)
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Enable/disable event emission
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Internal emit wrapper that adds metadata
   */
  _emit(type, data) {
    if (!this.enabled) return;

    this.eventCount++;
    const event = {
      type,
      timestamp: Date.now(),
      eventId: this.eventCount,
      ...data
    };

    this.emit(type, event);
    this.emit('*', event); // Wildcard for catching all events
  }

  // ============================================
  // CYCLE EVENTS
  // ============================================

  /**
   * Emit when a new cognitive cycle starts
   * @param {Object} data - { cycle, mode, cognitiveState }
   */
  emitCycleStart(data) {
    this._emit('cycle_start', {
      cycle: data.cycle,
      mode: data.mode || 'focus',
      cognitiveState: data.cognitiveState || null
    });
  }

  /**
   * Emit when a cognitive cycle completes
   * @param {Object} data - { cycle, duration, nodesCreated, edgesCreated }
   */
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

  /**
   * Emit when a thought is generated
   * @param {Object} data - { cycle, thought, role, surprise, model, reasoning }
   */
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

  /**
   * Emit when an agent is spawned
   * @param {Object} data - { agentId, agentType, goalId, description, cycle }
   */
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

  /**
   * Emit when an agent completes its work
   * @param {Object} data - { agentId, agentType, status, duration, artifacts, nodesCreated, edgesCreated }
   */
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

  /**
   * Emit when an agent fails
   * @param {Object} data - { agentId, agentType, error, cycle }
   */
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

  /**
   * Emit when a memory node is created
   * @param {Object} data - { nodeId, concept, tag, cluster }
   */
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

  /**
   * Emit when a memory edge is created
   * @param {Object} data - { source, target, weight }
   */
  emitEdgeCreated(data) {
    this._emit('edge_created', {
      source: data.source,
      target: data.target,
      weight: data.weight || 1.0
    });
  }

  /**
   * Emit when memory is consolidated
   * @param {Object} data - { nodesProcessed, edgesProcessed, duration }
   */
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

  /**
   * Emit when system enters sleep
   * @param {Object} data - { reason, energy, fatigue, cycle }
   */
  emitSleepTriggered(data) {
    this._emit('sleep_triggered', {
      reason: data.reason || 'unknown',
      energy: data.energy || 0,
      fatigue: data.fatigue || 0,
      cycle: data.cycle || null
    });
  }

  /**
   * Emit when system wakes from sleep
   * @param {Object} data - { sleepDuration, cyclesSlept, energyRestored }
   */
  emitWakeTriggered(data) {
    this._emit('wake_triggered', {
      sleepDuration: data.sleepDuration || 0,
      cyclesSlept: data.cyclesSlept || 0,
      energyRestored: data.energyRestored || 0
    });
  }

  /**
   * Emit during dream state rewiring
   * @param {Object} data - { bridgesCreated, cycle }
   */
  emitDreamRewiring(data) {
    this._emit('dream_rewiring', {
      bridgesCreated: data.bridgesCreated || 0,
      cycle: data.cycle || null
    });
  }

  // ============================================
  // COGNITIVE STATE EVENTS
  // ============================================

  /**
   * Emit when cognitive state changes
   * @param {Object} data - { metric, oldValue, newValue, trigger, energy?, curiosity?, mood? }
   */
  emitCognitiveStateChanged(data) {
    this._emit('cognitive_state_changed', {
      metric: data.metric, // 'curiosity' | 'mood' | 'energy' | 'mode'
      oldValue: data.oldValue,
      newValue: data.newValue,
      trigger: data.trigger || null,
      // Include current state values for gauge updates
      energy: data.energy,
      curiosity: data.curiosity,
      mood: data.mood
    });
  }

  /**
   * Emit when oscillator mode changes
   * @param {Object} data - { oldMode, newMode, reason }
   */
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

  /**
   * Emit when meta-coordinator runs a review
   * @param {Object} data - { cycle, summary, directivesCount, agentsSpawned }
   */
  emitCoordinatorReview(data) {
    this._emit('coordinator_review', {
      cycle: data.cycle,
      summary: data.summary || null,
      directivesCount: data.directivesCount || 0,
      agentsSpawned: data.agentsSpawned || 0
    });
  }

  /**
   * Emit when executive ring makes a decision
   * @param {Object} data - { cycle, action, reason, coherence }
   */
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

  /**
   * Emit when a novel insight is detected
   * @param {Object} data - { insight, noveltyScore, source }
   */
  emitInsightDetected(data) {
    this._emit('insight_detected', {
      insight: data.insight,
      noveltyScore: data.noveltyScore || 0,
      source: data.source || 'synthesis'
    });
  }

  /**
   * Emit when a goal is created
   * @param {Object} data - { goalId, description, source, priority }
   */
  emitGoalCreated(data) {
    this._emit('goal_created', {
      goalId: data.goalId,
      description: data.description,
      source: data.source || 'auto_capture',
      priority: data.priority || 0.5
    });
  }

  /**
   * Emit when a goal is completed
   * @param {Object} data - { goalId, description, outcome }
   */
  emitGoalCompleted(data) {
    this._emit('goal_completed', {
      goalId: data.goalId,
      description: data.description || null,
      outcome: data.outcome || 'completed'
    });
  }

  // ============================================
  // WEB SEARCH EVENTS
  // ============================================

  /**
   * Emit when web search is performed
   * @param {Object} data - { query, resultCount, sources }
   */
  emitWebSearch(data) {
    this._emit('web_search', {
      query: data.query,
      resultCount: data.resultCount || 0,
      sources: data.sources || []
    });
  }

  // ============================================
  // GENERIC EVENT
  // ============================================

  /**
   * Emit a custom event
   * @param {string} type - Event type
   * @param {Object} data - Event data
   */
  emitEvent(type, data) {
    this._emit(type, data);
  }

  // ============================================
  // STATS
  // ============================================

  /**
   * Get event statistics
   */
  getStats() {
    return {
      eventCount: this.eventCount,
      uptime: Date.now() - this.startTime,
      enabled: this.enabled,
      listenerCount: this.listenerCount('*')
    };
  }
}

// Singleton instance
const cosmoEvents = new COSMOEventEmitter();

module.exports = {
  cosmoEvents,
  COSMOEventEmitter
};
