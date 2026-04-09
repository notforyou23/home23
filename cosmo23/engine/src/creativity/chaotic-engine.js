/**
 * Chaotic Creativity Engine
 * RNN at edge of chaos for creative perturbations
 * From: "Thermodynamic and Chaotic Dynamics" section
 */
class ChaoticEngine {
  constructor(config, logger) {
    this.config = config.creativity;
    this.logger = logger;
    
    // Initialize chaotic RNN reservoir
    const size = this.config.chaoticRNN?.size || 100;
    this.reservoirSize = size;
    this.reservoir = new Array(size).fill(0).map(() => Math.random() * 0.1 - 0.05);
    this.weights = this.initializeWeights(size, this.config.chaoticRNN?.spectralRadius || 0.95);
    
    this.lastPerturbation = new Date();
    this.perturbationCount = 0;
    this.stagnationDetector = {
      recentOutputs: [],
      threshold: 3
    };
    
    // Cooldown settings to prevent chaos injection loops
    this.lastChaosInjection = null;
    this.chaosCooldown = 10; // cycles
    this.stagnationThreshold = 0.85; // Raised from 0.7 (more stringent)
    this.requiredConsecutiveStagnant = 3; // Must be stagnant 3 times in a row
    this.stagnationCount = 0;
  }

  /**
   * Initialize reservoir weights for edge-of-chaos dynamics
   */
  initializeWeights(size, spectralRadius) {
    const weights = [];
    
    for (let i = 0; i < size; i++) {
      weights[i] = [];
      for (let j = 0; j < size; j++) {
        // Sparse random connections
        weights[i][j] = Math.random() < 0.1 
          ? (Math.random() * 2 - 1) * spectralRadius / Math.sqrt(size * 0.1)
          : 0;
      }
    }

    return weights;
  }

  /**
   * Update reservoir state (chaotic dynamics)
   */
  updateReservoir(input = null) {
    const steps = this.config.chaoticRNN?.updateSteps || 10;
    const newReservoir = [...this.reservoir];

    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < this.reservoirSize; i++) {
        let activation = 0;
        
        // Recurrent connections
        for (let j = 0; j < this.reservoirSize; j++) {
          activation += this.weights[i][j] * this.reservoir[j];
        }

        // Add input if provided
        if (input !== null && step === 0) {
          activation += input * 0.1;
        }

        // Apply tanh activation (keeps bounded but allows rich dynamics)
        newReservoir[i] = Math.tanh(activation);
      }

      // Copy for next iteration
      for (let i = 0; i < this.reservoirSize; i++) {
        this.reservoir[i] = newReservoir[i];
      }
    }

    return this.reservoir;
  }

  /**
   * Generate creative perturbation
   */
  generatePerturbation(context = {}) {
    // Update reservoir with chaotic dynamics
    const inputSignal = context.stagnation ? 1.0 : 0.0;
    this.updateReservoir(inputSignal);

    // Extract perturbation from reservoir state
    const perturbationStrength = this.getPerturbationStrength();
    
    const perturbation = {
      type: this.selectPerturbationType(),
      strength: perturbationStrength,
      directions: this.extractDirections(),
      timestamp: new Date()
    };

    this.lastPerturbation = new Date();
    this.perturbationCount++;

    this.logger?.info('Perturbation generated', {
      type: perturbation.type,
      strength: perturbation.strength.toFixed(3),
      count: this.perturbationCount
    });

    return perturbation;
  }

  /**
   * Get perturbation strength from reservoir
   */
  getPerturbationStrength() {
    // Use variance of reservoir states as strength indicator
    const mean = this.reservoir.reduce((a, b) => a + b, 0) / this.reservoir.length;
    const variance = this.reservoir.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / this.reservoir.length;
    
    return Math.min(1.0, Math.sqrt(variance) * 2);
  }

  /**
   * Select perturbation type based on chaos
   */
  selectPerturbationType() {
    const types = ['mutation', 'hybridization', 'inversion', 'amplification', 'tangent'];
    
    // Use first few reservoir neurons to select
    const selector = Math.abs(this.reservoir[0] + this.reservoir[1]) % types.length;
    return types[Math.floor(selector)];
  }

  /**
   * Extract creative directions from reservoir
   */
  extractDirections() {
    // Map reservoir activations to semantic directions
    const directions = [];
    
    // Sample every 10th neuron for directions
    for (let i = 0; i < this.reservoirSize; i += 10) {
      const activation = this.reservoir[i];
      
      if (Math.abs(activation) > 0.3) {
        directions.push({
          dimension: i / 10,
          strength: activation,
          suggestion: this.mapToSemanticDirection(i, activation)
        });
      }
    }

    return directions.slice(0, 3); // Top 3
  }

  /**
   * Map reservoir neuron to semantic direction
   */
  mapToSemanticDirection(neuronIndex, activation) {
    const suggestions = [
      'explore opposite perspective',
      'combine with unrelated concept',
      'question core assumption',
      'amplify subtle detail',
      'simplify complexity',
      'add temporal dimension',
      'consider edge case',
      'metaphorical mapping',
      'reverse causality',
      'fractal recursion'
    ];

    const index = neuronIndex % suggestions.length;
    return suggestions[index];
  }

  /**
   * Detect stagnation in outputs
   * Improved: Requires consecutive stagnant cycles and higher threshold
   */
  detectStagnation(output) {
    this.stagnationDetector.recentOutputs.push({
      output,
      timestamp: new Date()
    });

    // Keep last 10
    if (this.stagnationDetector.recentOutputs.length > 10) {
      this.stagnationDetector.recentOutputs.shift();
    }

    // Check for repetitive patterns
    if (this.stagnationDetector.recentOutputs.length < 3) {
      return false;
    }

    const recent = this.stagnationDetector.recentOutputs.slice(-3);
    const similarities = this.computeSimilarities(recent);

    // Check against higher threshold (0.85 instead of 0.7)
    const isCurrentlyStagnant = similarities > this.stagnationThreshold;
    
    if (isCurrentlyStagnant) {
      this.stagnationCount++;
      this.logger?.warn('Stagnation detected', { 
        similarity: similarities.toFixed(3),
        consecutiveCount: this.stagnationCount,
        requiredForChaos: this.requiredConsecutiveStagnant
      });
    } else {
      // Reset counter on non-stagnant cycle
      this.stagnationCount = 0;
    }

    // Only return true if stagnant for multiple consecutive cycles
    return this.stagnationCount >= this.requiredConsecutiveStagnant;
  }

  /**
   * Compute similarity between recent outputs
   */
  computeSimilarities(outputs) {
    if (outputs.length < 2) return 0;

    let totalSimilarity = 0;
    let comparisons = 0;

    for (let i = 0; i < outputs.length - 1; i++) {
      for (let j = i + 1; j < outputs.length; j++) {
        totalSimilarity += this.textSimilarity(outputs[i].output, outputs[j].output);
        comparisons++;
      }
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0;
  }

  /**
   * Simple text similarity (Jaccard)
   */
  textSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Mutate an idea based on perturbation
   */
  mutateIdea(idea, perturbation) {
    const mutations = {
      mutation: `${idea} [Mutated: ${perturbation.directions[0]?.suggestion || 'vary parameters'}]`,
      hybridization: `Hybrid: ${idea} + [cross with distant concept]`,
      inversion: `Inverted: opposite of ${idea}`,
      amplification: `Amplified: ${idea} [taken to extreme]`,
      tangent: `Tangent from: ${idea} [unexpected direction]`
    };

    return mutations[perturbation.type] || idea;
  }

  /**
   * Check if perturbation is due
   */
  isPerturbationDue() {
    if (!this.config.chaosEnabled) return false;

    const interval = this.config.chaoticRNN?.perturbationInterval || 300;
    const timeSince = (Date.now() - this.lastPerturbation.getTime()) / 1000;

    return timeSince >= interval;
  }

  /**
   * Inject random noise into reservoir (reset chaos)
   */
  injectNoise(strength = 0.1) {
    for (let i = 0; i < this.reservoirSize; i++) {
      this.reservoir[i] += (Math.random() * 2 - 1) * strength;
      this.reservoir[i] = Math.max(-1, Math.min(1, this.reservoir[i]));
    }

    this.logger?.debug('Noise injected', { strength });
  }

  /**
   * Get reservoir statistics
   */
  getReservoirStats() {
    const mean = this.reservoir.reduce((a, b) => a + b, 0) / this.reservoir.length;
    const max = Math.max(...this.reservoir);
    const min = Math.min(...this.reservoir);
    
    return {
      mean,
      max,
      min,
      variance: this.reservoir.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / this.reservoir.length
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      enabled: this.config.chaosEnabled,
      perturbationCount: this.perturbationCount,
      timeSinceLastPerturbation: (Date.now() - this.lastPerturbation.getTime()) / 1000,
      reservoir: this.getReservoirStats(),
      stagnationBufferSize: this.stagnationDetector.recentOutputs.length
    };
  }
}

module.exports = { ChaoticEngine };

