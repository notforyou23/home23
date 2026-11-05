const { cosmoEvents } = require('../realtime/event-emitter');

/**
 * Focus-Exploration Oscillator
 * Implements Pomodoro-style cycles between focused work and exploratory thinking
 * From Phase2B: "Oscillating Focus vs. Exploration"
 */
class FocusExplorationOscillator {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Configurable durations (in seconds)
    this.focusDuration = config?.focusDuration || 300; // 5 minutes default
    this.explorationDuration = config?.explorationDuration || 60; // 1 minute default
    
    this.mode = 'focus'; // 'focus', 'explore', or 'execute'
    this.modeStartTime = new Date();
    this.cycleCount = 0;
    this.explorationHistory = [];
    this.executionHistory = [];
    this.executionCyclesRemaining = 0;
  }

  /**
   * Update oscillator and check if mode should switch
   */
  update() {
    const elapsed = (Date.now() - this.modeStartTime.getTime()) / 1000;
    
    if (this.mode === 'focus' && elapsed >= this.focusDuration) {
      this.switchToExploration();
    } else if (this.mode === 'explore' && elapsed >= this.explorationDuration) {
      this.switchToFocus();
    }
  }

  /**
   * Switch to exploration mode
   */
  switchToExploration() {
    const oldMode = this.mode;
    this.mode = 'explore';
    this.modeStartTime = new Date();
    this.cycleCount++;

    this.logger?.info('🔍 Switching to EXPLORATION mode', {
      cycle: this.cycleCount,
      duration: this.explorationDuration + 's'
    });

    // Emit oscillator mode change event
    cosmoEvents.emitEvent('oscillator_mode_changed', {
      oldMode: oldMode,
      newMode: 'explore',
      cycle: this.cycleCount
    });
  }

  /**
   * Switch to focus mode
   */
  switchToFocus() {
    const oldMode = this.mode;
    this.mode = 'focus';
    this.modeStartTime = new Date();

    this.logger?.info('🎯 Switching to FOCUS mode', {
      cycle: this.cycleCount,
      duration: this.focusDuration + 's'
    });

    // Emit oscillator mode change event
    cosmoEvents.emitEvent('oscillator_mode_changed', {
      oldMode: oldMode,
      newMode: 'focus',
      cycle: this.cycleCount
    });
  }

  /**
   * Enter execution mode - deploy agents to work through backlog
   */
  enterExecutionMode(cycleCount = 20, reason = 'manual') {
    const oldMode = this.mode;
    this.mode = 'execute';
    this.modeStartTime = new Date();
    this.executionCyclesRemaining = cycleCount;

    this.logger?.info('⚙️  Entering EXECUTION mode', {
      reason,
      cyclesRemaining: cycleCount,
      timestamp: new Date().toISOString()
    });

    // Emit oscillator mode change event
    cosmoEvents.emitEvent('oscillator_mode_changed', {
      oldMode: oldMode,
      newMode: 'execute',
      reason: reason,
      cyclesPlanned: cycleCount
    });
  }

  /**
   * Exit execution mode back to focus
   */
  exitExecutionMode(summary = {}) {
    const executionDuration = Date.now() - this.modeStartTime.getTime();
    
    this.executionHistory.push({
      startTime: this.modeStartTime,
      duration: executionDuration,
      cyclesSpent: 20 - this.executionCyclesRemaining,
      ...summary
    });
    
    this.mode = 'focus';
    this.modeStartTime = new Date();
    
    this.logger?.info('');
    this.logger?.info('╔═══════════════════════════════════════════════════╗');
    this.logger?.info('║   EXECUTION MODE COMPLETE                       ║');
    this.logger?.info('╚═══════════════════════════════════════════════════╝');
    this.logger?.info('✅ Execution Summary', {
      duration: Math.round(executionDuration / 1000) + 's',
      cyclesSpent: 20 - this.executionCyclesRemaining,
      ...summary
    });
    this.logger?.info('🎯 Returning to FOCUS mode');
    this.logger?.info('');
  }

  /**
   * Check if currently in exploration mode
   */
  isExploring() {
    return this.mode === 'explore';
  }

  /**
   * Check if currently in focus mode
   */
  isFocused() {
    return this.mode === 'focus';
  }

  /**
   * Check if currently in execution mode
   */
  isExecuting() {
    return this.mode === 'execute';
  }

  /**
   * Get current mode
   */
  getCurrentMode() {
    return this.mode;
  }

  /**
   * Get time remaining in current mode (seconds)
   */
  getTimeRemaining() {
    const elapsed = (Date.now() - this.modeStartTime.getTime()) / 1000;
    const duration = this.mode === 'focus' ? this.focusDuration : this.explorationDuration;
    
    return Math.max(0, duration - elapsed);
  }

  /**
   * Record exploration result
   */
  recordExploration(result) {
    this.explorationHistory.push({
      cycle: this.cycleCount,
      timestamp: new Date(),
      result,
      productive: result.insightGained || false
    });

    // Keep last 50
    if (this.explorationHistory.length > 50) {
      this.explorationHistory.shift();
    }
  }

  /**
   * Force a mode switch (for adaptive behavior)
   */
  forceExploration(reason = 'forced') {
    if (this.mode !== 'explore') {
      this.logger?.info('Forcing exploration mode', { reason });
      this.switchToExploration();
    }
  }

  /**
   * Extend current mode duration (adaptive)
   */
  extendCurrentMode(additionalSeconds) {
    // Subtract time to effectively extend
    this.modeStartTime = new Date(this.modeStartTime.getTime() - (additionalSeconds * 1000));
    
    this.logger?.debug('Mode duration extended', {
      mode: this.mode,
      additional: additionalSeconds + 's'
    });
  }

  /**
   * Get thinking parameters based on current mode
   */
  getThinkingParameters() {
    if (this.mode === 'explore') {
      return {
        mode: 'exploration',
        temperature: 1.1, // Higher creativity
        explorationBias: 0.9,
        allowTangents: true,
        memoryScope: 'broad', // Pull from diverse areas
        goalSelection: 'random' // Pick random backlog items
      };
    } else {
      return {
        mode: 'focused',
        temperature: 0.7, // More deterministic
        explorationBias: 0.2,
        allowTangents: false,
        memoryScope: 'narrow', // Stay on topic
        goalSelection: 'priority' // Stick to high priority
      };
    }
  }

  /**
   * Adaptive adjustment based on fatigue or stagnation
   */
  adaptCycleTiming(metrics) {
    const { fatigueLevel, stagnationDetected, recentProgress } = metrics;

    // If fatigued, shorten focus periods and lengthen exploration
    if (fatigueLevel > 0.7) {
      this.focusDuration = Math.max(180, this.focusDuration * 0.9);
      this.explorationDuration = Math.min(120, this.explorationDuration * 1.1);
      
      this.logger?.info('Adapted cycle timing (fatigue)', {
        focus: this.focusDuration,
        explore: this.explorationDuration
      });
    }

    // If stagnant, force more exploration
    if (stagnationDetected) {
      this.forceExploration('stagnation_detected');
      this.explorationDuration = Math.min(180, this.explorationDuration * 1.5);
    }

    // If making good progress, allow longer focus
    if (recentProgress > 0.8 && !stagnationDetected) {
      this.focusDuration = Math.min(600, this.focusDuration * 1.1);
    }
  }

  /**
   * Get productivity stats
   */
  getStats() {
    const recentExplorations = this.explorationHistory.slice(-10);
    const productiveExplorations = recentExplorations.filter(e => e.productive).length;

    return {
      currentMode: this.mode,
      timeRemaining: Math.round(this.getTimeRemaining()),
      cycleCount: this.cycleCount,
      focusDuration: this.focusDuration,
      explorationDuration: this.explorationDuration,
      explorationProductivity: recentExplorations.length > 0
        ? (productiveExplorations / recentExplorations.length * 100).toFixed(1) + '%'
        : 'N/A',
      totalExplorations: this.explorationHistory.length
    };
  }

  /**
   * Reset to default timings
   */
  reset() {
    this.focusDuration = this.config?.focusDuration || 300;
    this.explorationDuration = this.config?.explorationDuration || 60;
    this.mode = 'focus';
    this.modeStartTime = new Date();
    
    this.logger?.info('Oscillator reset to defaults');
  }
}

module.exports = { FocusExplorationOscillator };

