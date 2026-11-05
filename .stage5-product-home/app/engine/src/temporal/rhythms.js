const { cosmoEvents } = require('../realtime/event-emitter');

/**
 * Temporal Rhythms
 * Sleep/wake cycles and memory consolidation
 * From: "Sleep and Dream-Inspired Processing" section
 */
class TemporalRhythms {
  constructor(config, logger) {
    this.config = config.temporal;
    this.logger = logger;
    
    this.state = 'awake'; // awake, sleeping, dreaming
    this.lastSleepStart = null;
    this.lastWakeTime = new Date();
    this.sleepCycles = 0;
    this.fatigue = 0;
    this.lastSleepCycle = 0; // Track cycles for cycle-based consolidation
    
    this.oscillationPhase = 'fast'; // fast, slow
    this.oscillationStartTime = new Date();
    
    // Debounce settings to prevent thrashing
    this.minAwakeDuration = 10 * 60 * 1000; // 10 minutes minimum awake time
    this.lastConsolidationTime = null;
    this.minConsolidationInterval = 20 * 60 * 1000; // 20 minutes between LLM consolidations (Home23: shorter cycles)
  }

  /**
   * Update temporal state
   */
  update(energyLevel, activityCount) {
    // Update fatigue
    if (this.config.fatigue?.enabled) {
      this.updateFatigue(activityCount);
    }

    // Check for sleep trigger (pass activityCount for cycle-based sleep)
    if (this.config.sleepEnabled) {
      this.checkSleepTrigger(energyLevel, activityCount);
    }

    // Update oscillations if awake
    if (this.state === 'awake' && this.config.oscillations?.enabled) {
      this.updateOscillation();
    }
  }

  /**
   * Update fatigue level
   */
  updateFatigue(activityCount) {
    const rate = this.config.fatigue.fatigueRate || 0.001;
    
    // Fatigue increases with activity
    this.fatigue = Math.min(1.0, this.fatigue + (rate * activityCount));

    // Fatigue also increases with time awake
    const hoursAwake = (Date.now() - this.lastWakeTime.getTime()) / (1000 * 60 * 60);
    this.fatigue = Math.min(1.0, this.fatigue + (hoursAwake * 0.01));
  }

  /**
   * Check if sleep should be triggered
   * Multi-tier sleep system:
   * 1. Cycle-based consolidation (every 100 cycles) - guaranteed processing
   * 2. Emergency triggers (backup if cognitive system misses fatigue)
   * Note: Removed 2-7 AM check - system has no real-time awareness
   */
  checkSleepTrigger(energyLevel, activityCount = 0) {
    if (this.state === 'sleeping') return;

    // Debounce: Must be awake for at least minAwakeDuration
    const timeSinceWake = Date.now() - this.lastWakeTime.getTime();
    if (timeSinceWake < this.minAwakeDuration) {
      // Too soon after waking, prevent thrashing
      return;
    }

    // 1. Cycle-based consolidation (every 200 cycles)
    // Ensures regular deep sleep even if energy/fatigue don't trigger
    // Home23: increased from 100 to 200 — always-on AI needs longer awake windows
    const cyclesSinceLastSleep = activityCount - this.lastSleepCycle;
    if (cyclesSinceLastSleep >= 200 && activityCount > 0) {
      this.logger?.info('🌙 Scheduled consolidation (cycle-based)', {
        cyclesSinceLastSleep,
        currentCycle: activityCount
      });
      this.enterSleep();
      this.lastSleepCycle = activityCount;
      return;
    }

    // 2. Emergency sleep triggers (backup coordination with cognitive system)
    // Cognitive system triggers at energy < 0.15 (configurable sleepThreshold)
    // Temporal provides backup at 0.10 if cognitive missed it
    const emergencyEnergyThreshold = 0.10;  // Below cognitive threshold as safety net
    const emergencyFatigueThreshold = 0.7;  // Restore to reasonable level (was 0.9)
    
    if (energyLevel < emergencyEnergyThreshold || this.fatigue > emergencyFatigueThreshold) {
      this.logger?.info('⚠️  Emergency sleep triggered (temporal backup)', {
        energy: energyLevel,
        fatigue: this.fatigue.toFixed(3),
        reason: energyLevel < emergencyEnergyThreshold ? 'low_energy_backup' : 'high_fatigue',
        timeSinceWake: Math.round(timeSinceWake / 1000 / 60) + 'min'
      });
      this.enterSleep();
      if (activityCount > 0) {
        this.lastSleepCycle = activityCount;
      }
    }
  }

  /**
   * Enter sleep mode
   */
  enterSleep() {
    this.state = 'sleeping';
    this.lastSleepStart = new Date();
    this.sleepCycles++;

    this.logger?.info('🌙 Entering sleep mode', {
      cycle: this.sleepCycles,
      fatigue: this.fatigue.toFixed(3)
    });
  }

  /**
   * Wake from sleep
   */
  wake() {
    const sleepDuration = this.getSleepDuration();
    
    this.state = 'awake';
    this.lastWakeTime = new Date();
    
    // Restore energy and reduce fatigue
    this.fatigue = Math.max(0, this.fatigue - 0.5);

    this.logger?.info('☀️ Waking from sleep', {
      sleepDuration: Math.round(sleepDuration / 1000),
      fatigue: this.fatigue.toFixed(3)
    });
  }

  /**
   * Check if sleep cycle is complete
   */
  shouldWake() {
    if (this.state !== 'sleeping') return false;

    const duration = this.getSleepDuration();
    const configuredDuration = (this.config.sleepDuration || 3600) * 1000;

    return duration >= configuredDuration;
  }

  /**
   * Get current sleep duration in milliseconds
   */
  getSleepDuration() {
    if (!this.lastSleepStart) return 0;
    return Date.now() - this.lastSleepStart.getTime();
  }

  /**
   * Enter dream mode (for memory consolidation)
   */
  enterDreamMode() {
    if (this.state !== 'sleeping') return false;

    this.state = 'dreaming';

    this.logger?.info('💭 Entering dream mode');

    // Emit dream state event
    cosmoEvents.emitEvent('dream_started', {
      timestamp: Date.now(),
      sleepCycles: this.sleepCycles
    });

    return true;
  }

  /**
   * Exit dream mode back to sleep
   */
  exitDreamMode() {
    if (this.state === 'dreaming') {
      this.state = 'sleeping';
    }
  }

  /**
   * Update oscillation phase
   */
  updateOscillation() {
    const elapsed = (Date.now() - this.oscillationStartTime.getTime()) / 1000;
    
    if (this.oscillationPhase === 'fast') {
      const fastDuration = this.config.oscillations.fastPhaseDuration || 300;
      if (elapsed >= fastDuration) {
        this.oscillationPhase = 'slow';
        this.oscillationStartTime = new Date();
        
        this.logger?.debug('Oscillation: fast → slow');
      }
    } else {
      const slowDuration = this.config.oscillations.slowPhaseDuration || 120;
      if (elapsed >= slowDuration) {
        this.oscillationPhase = 'fast';
        this.oscillationStartTime = new Date();
        
        this.logger?.debug('Oscillation: slow → fast');
      }
    }
  }

  /**
   * Get thinking parameters based on rhythm state
   */
  getThinkingParameters() {
    const params = {
      canThink: true,
      mode: 'normal',
      temperature: 0.8,
      interval: 120
    };

    switch (this.state) {
      case 'awake':
        // Adjust based on oscillation
        if (this.oscillationPhase === 'fast') {
          params.mode = 'active';
          params.temperature = 0.9;
          params.interval = 60; // Faster thinking
        } else {
          params.mode = 'contemplative';
          params.temperature = 0.7;
          params.interval = 180; // Slower, deeper thinking
        }
        break;

      case 'sleeping':
        params.canThink = false;
        params.mode = 'resting';
        break;

      case 'dreaming':
        params.canThink = true;
        params.mode = 'dreaming';
        params.temperature = 1.3; // High creativity
        params.interval = 30; // Rapid dream thoughts
        break;
    }

    return params;
  }

  /**
   * Consolidate memories during sleep
   * Returns list of memory operations to perform
   */
  consolidateMemories(memoryNetwork) {
    if (this.state !== 'sleeping' && this.state !== 'dreaming') {
      return [];
    }

    const operations = [];

    // Strengthen important connections
    operations.push({
      type: 'strengthen',
      description: 'Reinforce frequently accessed memories',
      parameters: { threshold: 0.7, boost: 0.2 }
    });

    // Prune weak connections
    operations.push({
      type: 'prune',
      description: 'Remove weak, unused connections',
      parameters: { threshold: 0.1 }
    });

    // Create new associations (dream-like)
    if (this.state === 'dreaming') {
      operations.push({
        type: 'associate',
        description: 'Form novel associations between distant concepts',
        parameters: { randomBridges: 3 }
      });
    }

    return operations;
  }

  /**
   * Get current state
   */
  getState() {
    return {
      state: this.state,
      fatigue: this.fatigue,
      oscillationPhase: this.oscillationPhase,
      sleepCycles: this.sleepCycles,
      timeAwake: this.state === 'awake' 
        ? (Date.now() - this.lastWakeTime.getTime()) / 1000 
        : 0,
      timeSleeping: this.state === 'sleeping' || this.state === 'dreaming'
        ? this.getSleepDuration() / 1000
        : 0
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.getState(),
      totalSleepCycles: this.sleepCycles,
      lastSleepStart: this.lastSleepStart,
      lastWakeTime: this.lastWakeTime,
      lastSleepCycle: this.lastSleepCycle  // For cycle-based sleep tracking
    };
  }

  /**
   * Force wake (for testing or emergency)
   */
  forceWake() {
    if (this.state === 'sleeping' || this.state === 'dreaming') {
      this.wake();
    }
  }

  /**
   * Force sleep (for testing or emergency)
   */
  forceSleep() {
    if (this.state === 'awake') {
      this.enterSleep();
    }
  }

  /**
   * Get time until next natural sleep (estimate)
   */
  getTimeUntilSleep() {
    if (this.state !== 'awake') return 0;

    // Estimate based on fatigue rate
    const remainingEnergy = 1.0 - this.fatigue;
    const rate = this.config.fatigue?.fatigueRate || 0.001;
    
    // Rough estimate (doesn't account for activity)
    return remainingEnergy / rate;
  }
}

module.exports = { TemporalRhythms };

