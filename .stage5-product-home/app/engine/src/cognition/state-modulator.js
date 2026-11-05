const { cosmoEvents } = require('../realtime/event-emitter');

/**
 * Cognitive State Modulator
 * Manages mood, curiosity, energy, and mode transitions
 * From: "Emotional and Neuromodulatory Influences" section
 */
class CognitiveStateModulator {
  constructor(config, logger) {
    this.config = config.cognitiveState;
    this.logger = logger;
    
    // Initialize state
    this.state = {
      curiosity: this.config.initialCuriosity || 0.5,
      mood: this.config.initialMood || 0.5,
      energy: this.config.initialEnergy || 1.0,
      mode: 'active', // active, wandering, sleeping, reflecting
      lastModeChange: new Date(),
      surpriseAccumulator: 0,
      recentSuccesses: 0,
      recentFailures: 0
    };

    this.stateHistory = [];
  }

  /**
   * Update state based on experience
   */
  updateState(experience, options = {}) {
    const { type, valence, surprise, success } = experience;
    const { skipModeCheck = false } = options;  // Allow skipping mode check during sleep cycles

    // Update curiosity based on surprise
    if (this.config.curiosityEnabled && surprise !== undefined) {
      const adaptationRate = this.config.adaptationRate || 1.0; // Default to 1.0 if not configured
      const curiosityDelta = surprise * adaptationRate;
      
      // Initialize curiosity if null (shouldn't happen but safety net)
      if (this.state.curiosity === null || this.state.curiosity === undefined) {
        this.state.curiosity = this.config.initialCuriosity || 0.5;
      }
      
      this.state.curiosity = this.clamp(this.state.curiosity + curiosityDelta, 0, 1);
      this.state.surpriseAccumulator += surprise;
    }

    // Update mood based on success/failure
    if (this.config.moodEnabled && success !== undefined) {
      const adaptationRate = this.config.adaptationRate || 1.0; // Default to 1.0 if not configured
      
      // Initialize mood if null (shouldn't happen but safety net)
      if (this.state.mood === null || this.state.mood === undefined) {
        this.state.mood = this.config.initialMood || 0.5;
      }
      
      if (success) {
        this.state.recentSuccesses++;
        const moodBoost = 0.1 * adaptationRate;
        this.state.mood = this.clamp(this.state.mood + moodBoost, 0, 1);
      } else {
        this.state.recentFailures++;
        const moodDrop = 0.15 * adaptationRate;
        this.state.mood = this.clamp(this.state.mood - moodDrop, 0, 1);
      }
    }

    // Update energy (decreases with activity, recovers during sleep)
    if (this.config.energyEnabled) {
      if (this.state.mode === 'sleeping') {
        // Gradual recovery during sleep — configurable from base-engine.yaml
        const energyRecovery = this.config.energyRecoveryRate || 0.10;
        this.state.energy = Math.min(1.0, this.state.energy + energyRecovery);
      } else {
        // Energy drain during activity — configurable from base-engine.yaml
        const energyDrain = this.config.energyDrainRate || 0.01;
        this.state.energy = Math.max(0, this.state.energy - energyDrain);
      }
    }

    // Check for mode transitions (skip during sleep cycles to prevent immediate wake)
    if (!skipModeCheck) {
      this.checkModeTransition();
    }

    // Record state
    this.recordState();

    // FIX: Guard against null values when logging
    this.logger?.debug('State updated', {
      curiosity: this.state.curiosity?.toFixed?.(3) ?? 'null',
      mood: this.state.mood?.toFixed?.(3) ?? 'null',
      energy: this.state.energy?.toFixed?.(3) ?? 'null',
      mode: this.state.mode
    });

    // Emit cognitive state for Watch Panel gauges (every update, not just mode changes)
    cosmoEvents.emitEvent('cognitive_state_update', {
      energy: this.state.energy,
      curiosity: this.state.curiosity,
      mood: this.state.mood,
      mode: this.state.mode
    });
  }

  /**
   * Check if mode should transition
   */
  checkModeTransition() {
    const timeSinceChange = Date.now() - this.state.lastModeChange.getTime();

    // Low energy -> sleep mode (configurable threshold)
    const sleepThreshold = this.config.sleepThreshold || 0.15;
    if (this.state.energy < sleepThreshold && this.state.mode !== 'sleeping') {
      this.transitionToMode('sleeping');
      return;
    }

    // Energy recovered after sleep -> active mode (configurable threshold)
    const wakeThreshold = this.config.wakeThreshold || 0.35;
    if (this.state.energy > wakeThreshold && this.state.mode === 'sleeping') {
      this.transitionToMode('active');
      return;
    }

    // High surprise accumulation -> reflecting mode
    if (this.state.surpriseAccumulator > 5.0 && this.state.mode !== 'reflecting') {
      this.transitionToMode('reflecting');
      return;
    }

    // Low curiosity + medium energy -> wandering mode
    if (this.state.curiosity < 0.3 && this.state.energy > 0.5 && this.state.mode === 'active') {
      if (timeSinceChange > 300000) { // 5 minutes
        this.transitionToMode('wandering');
      }
      return;
    }

    // High curiosity -> back to active
    if (this.state.curiosity > 0.6 && this.state.mode === 'wandering') {
      this.transitionToMode('active');
      return;
    }
  }

  /**
   * Transition to new mode
   */
  transitionToMode(newMode) {
    const oldMode = this.state.mode;
    this.state.mode = newMode;
    this.state.lastModeChange = new Date();

    // Mode-specific adjustments
    if (newMode === 'sleeping') {
      this.state.surpriseAccumulator = 0;
    }

    if (newMode === 'reflecting') {
      this.state.surpriseAccumulator *= 0.5;
    }

    if (newMode === 'active') {
      this.state.recentSuccesses = 0;
      this.state.recentFailures = 0;
    }

    this.logger?.info('Mode transition', {
      from: oldMode,
      to: newMode,
      curiosity: this.state.curiosity.toFixed(3),
      energy: this.state.energy.toFixed(3)
    });

    // Emit real-time cognitive state event
    cosmoEvents.emitCognitiveStateChanged({
      metric: 'mode',
      oldValue: oldMode,
      newValue: newMode,
      energy: this.state.energy,
      curiosity: this.state.curiosity,
      mood: this.state.mood
    });
  }

  /**
   * Restore energy (during sleep/rest)
   */
  restoreEnergy(amount = 0.1) {
    this.state.energy = Math.min(1.0, this.state.energy + amount);
  }

  /**
   * Boost curiosity (external stimulus)
   */
  boostCuriosity(amount = 0.1) {
    this.state.curiosity = this.clamp(this.state.curiosity + amount, 0, 1);
  }

  /**
   * Get current state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Get mode-adjusted parameters for thinking
   */
  getThinkingParameters() {
    const params = {
      temperature: 0.8,
      explorationBias: 0.5,
      memoryDepth: 3,
      shouldThink: true
    };

    switch (this.state.mode) {
      case 'active':
        params.temperature = 0.7 + (this.state.curiosity * 0.4);
        params.explorationBias = this.state.curiosity;
        params.memoryDepth = 5;
        break;

      case 'wandering':
        params.temperature = 1.0 + (this.state.curiosity * 0.3);
        params.explorationBias = 0.8;
        params.memoryDepth = 3;
        break;

      case 'reflecting':
        params.temperature = 0.6;
        params.explorationBias = 0.3;
        params.memoryDepth = 10; // Deep memory access
        break;

      case 'sleeping':
        params.shouldThink = false;
        params.temperature = 1.2; // High randomness for dreams
        params.explorationBias = 1.0;
        params.memoryDepth = 8;
        break;
    }

    return params;
  }

  /**
   * Bias memory recall based on mood
   */
  biasMemoryRecall(memories) {
    if (!this.config.moodEnabled) {
      return memories;
    }

    // Positive mood: prefer positive memories
    // Negative mood: prefer problem-focused memories
    return memories.map(m => ({
      ...m,
      weight: m.weight * (1 + (this.state.mood - 0.5) * 0.5)
    })).sort((a, b) => b.weight - a.weight);
  }

  /**
   * Record state for history
   */
  recordState() {
    this.stateHistory.push({
      ...this.state,
      timestamp: new Date()
    });

    // Keep last 1000 records
    if (this.stateHistory.length > 1000) {
      this.stateHistory.shift();
    }
  }

  /**
   * Get state statistics
   */
  getStats() {
    const recentStates = this.stateHistory.slice(-100);
    
    return {
      current: this.state,
      averages: {
        curiosity: this.average(recentStates.map(s => s.curiosity)),
        mood: this.average(recentStates.map(s => s.mood)),
        energy: this.average(recentStates.map(s => s.energy))
      },
      modeDistribution: this.getModeDistribution(recentStates)
    };
  }

  /**
   * Get mode distribution
   */
  getModeDistribution(states) {
    const counts = { active: 0, wandering: 0, reflecting: 0, sleeping: 0 };
    
    for (const state of states) {
      counts[state.mode]++;
    }

    return counts;
  }

  /**
   * Helper: clamp value
   */
  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Helper: average
   */
  average(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
}

module.exports = { CognitiveStateModulator };

