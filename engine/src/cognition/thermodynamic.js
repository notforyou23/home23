/**
 * Thermodynamic Controller
 * Implements free-energy principle and surprise detection
 * From: "Thermodynamic and Chaotic Dynamics as Cognitive Catalysts" section
 */
class ThermodynamicController {
  constructor(config, logger) {
    this.config = config.thermodynamic;
    this.logger = logger;
    
    this.freeEnergy = this.config.freeEnergyTarget || 0.5;
    this.surpriseHistory = [];
    this.predictionErrors = [];
    this.annealingPhase = 'hot';
    this.annealingStep = 0;
  }

  /**
   * Calculate surprise (prediction error)
   */
  calculateSurprise(expected, observed) {
    // Simple surprise metric: how different is observed from expected
    if (typeof expected === 'string' && typeof observed === 'string') {
      // Text-based surprise: novelty of words
      const expectedWords = new Set(expected.toLowerCase().split(/\s+/));
      const observedWords = observed.toLowerCase().split(/\s+/);
      
      const novelWords = observedWords.filter(w => !expectedWords.has(w));
      const surprise = novelWords.length / observedWords.length;
      
      this.recordSurprise(surprise);
      return surprise;
    }

    if (typeof expected === 'number' && typeof observed === 'number') {
      const surprise = Math.abs(expected - observed) / Math.max(Math.abs(expected), 1);
      this.recordSurprise(surprise);
      return surprise;
    }

    return 0;
  }

  /**
   * Record surprise event
   */
  recordSurprise(surprise) {
    this.surpriseHistory.push({
      surprise,
      timestamp: new Date()
    });

    // Keep last 100
    if (this.surpriseHistory.length > 100) {
      this.surpriseHistory.shift();
    }

    // Update free energy
    this.updateFreeEnergy(surprise);
  }

  /**
   * Update free energy level
   */
  updateFreeEnergy(surprise) {
    // Free energy increases with surprise
    const delta = (surprise - this.config.freeEnergyTarget) * 0.1;
    this.freeEnergy = Math.max(0, Math.min(1, this.freeEnergy + delta));

    this.logger?.debug('Free energy updated', {
      surprise: surprise.toFixed(3),
      freeEnergy: this.freeEnergy.toFixed(3)
    });
  }

  /**
   * Check if system should seek novelty
   */
  shouldSeekNovelty() {
    // If free energy is too low (too predictable), seek novelty
    return this.freeEnergy < (this.config.freeEnergyTarget * 0.7);
  }

  /**
   * Check if system should reduce uncertainty
   */
  shouldReduceUncertainty() {
    // If free energy is too high (too surprising), reduce uncertainty
    return this.freeEnergy > (this.config.freeEnergyTarget * 1.3);
  }

  /**
   * Get current temperature (for annealing)
   */
  getCurrentTemperature() {
    if (!this.config.annealingCycles) {
      return 0.9; // Default
    }

    const { hotTemperature, coldTemperature, annealingSteps } = this.config;

    // Linear annealing
    const progress = this.annealingStep / annealingSteps;
    const temp = hotTemperature - (progress * (hotTemperature - coldTemperature));

    return Math.max(coldTemperature, Math.min(hotTemperature, temp));
  }

  /**
   * Advance annealing cycle
   */
  advanceAnnealing() {
    if (!this.config.annealingCycles) return;

    this.annealingStep++;

    if (this.annealingStep >= this.config.annealingSteps) {
      // Reset cycle
      this.annealingStep = 0;
      this.annealingPhase = this.annealingPhase === 'hot' ? 'cold' : 'hot';
      
      this.logger?.info('Annealing cycle reset', {
        phase: this.annealingPhase
      });
    }
  }

  /**
   * Get entropy estimate of recent activity
   */
  getEntropy() {
    if (this.surpriseHistory.length === 0) return 0;

    // Higher variance in surprise = higher entropy
    const surprises = this.surpriseHistory.map(s => s.surprise);
    const mean = surprises.reduce((a, b) => a + b, 0) / surprises.length;
    const variance = surprises.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / surprises.length;
    
    return Math.sqrt(variance);
  }

  /**
   * Suggest cognitive adjustment based on thermodynamics
   */
  suggestAdjustment() {
    const entropy = this.getEntropy();
    const recentSurprise = this.surpriseHistory.slice(-5).reduce((sum, s) => sum + s.surprise, 0) / 5;

    const adjustment = {
      action: 'maintain',
      reason: '',
      parameters: {}
    };

    if (this.shouldSeekNovelty()) {
      adjustment.action = 'explore';
      adjustment.reason = 'Free energy too low - system too predictable';
      adjustment.parameters = {
        temperature: Math.min(1.5, this.getCurrentTemperature() + 0.3),
        explorationBias: 0.8
      };
    } else if (this.shouldReduceUncertainty()) {
      adjustment.action = 'exploit';
      adjustment.reason = 'Free energy too high - reduce uncertainty';
      adjustment.parameters = {
        temperature: Math.max(0.5, this.getCurrentTemperature() - 0.2),
        explorationBias: 0.2
      };
    } else if (entropy < 0.1) {
      adjustment.action = 'inject_chaos';
      adjustment.reason = 'Low entropy detected - inject perturbation';
      adjustment.parameters = {
        perturbationStrength: 0.3
      };
    }

    return adjustment;
  }

  /**
   * Calculate homeostasis pressure
   * Returns value indicating how far from ideal state
   */
  getHomeostasisPressure() {
    const target = this.config.freeEnergyTarget;
    const deviation = Math.abs(this.freeEnergy - target);
    
    return {
      pressure: deviation / target,
      direction: this.freeEnergy > target ? 'reduce' : 'increase',
      urgency: deviation > (target * 0.5) ? 'high' : 'low'
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    const recentSurprises = this.surpriseHistory.slice(-20);
    
    return {
      freeEnergy: this.freeEnergy,
      entropy: this.getEntropy(),
      averageSurprise: recentSurprises.length > 0
        ? recentSurprises.reduce((sum, s) => sum + s.surprise, 0) / recentSurprises.length
        : 0,
      annealingPhase: this.annealingPhase,
      annealingStep: this.annealingStep,
      temperature: this.getCurrentTemperature(),
      homeostasis: this.getHomeostasisPressure()
    };
  }

  /**
   * Export for visualization
   */
  export() {
    return {
      history: this.surpriseHistory.slice(-100),
      currentState: this.getStats()
    };
  }
}

module.exports = { ThermodynamicController };

