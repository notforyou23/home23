/**
 * reinforcement.js - Activation and Decay Tracking for COSMO 2.0 Phase 1
 * 
 * Tracks node activation counts, decay rates, and contextual strength.
 * Implements exponential decay with configurable half-life.
 * All computations are immutable - returns new state objects.
 * 
 * @module core/reinforcement
 */

/**
 * Reinforcement class - Tracks activation and decay state
 * 
 * @class Reinforcement
 * @property {string} nodeId - Associated node ID
 * @property {number} activationCount - Total number of activations
 * @property {number} lastActivation - Unix timestamp (ms) of last activation
 * @property {number} strength - Current strength [0.0, 1.0]
 * @property {number} decayRate - Exponential decay rate (lambda)
 * @property {number} halfLife - Half-life in milliseconds
 */
class Reinforcement {
  /**
   * Create reinforcement tracker for a node.
   * 
   * @param {string} nodeId - Associated node identifier
   * @param {number} [initialStrength=1.0] - Initial strength value
   * @param {number} [halfLife=86400000] - Half-life in ms (default: 1 day)
   * @throws {TypeError} If nodeId is not a string or strength invalid
   */
  constructor(nodeId, initialStrength = 1.0, halfLife = 86400000, activationCount = 0, lastActivation = null) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (typeof initialStrength !== 'number' || initialStrength < 0 || initialStrength > 1) {
      throw new TypeError('initialStrength must be a number between 0.0 and 1.0');
    }

    if (typeof halfLife !== 'number' || halfLife <= 0) {
      throw new TypeError('halfLife must be a positive number (milliseconds)');
    }

    // Set properties as writable initially
    this.nodeId = nodeId;
    this.activationCount = activationCount;
    this.lastActivation = lastActivation !== null ? lastActivation : Date.now();
    this.strength = initialStrength;
    this.decayRate = Math.LN2 / halfLife; // lambda = ln(2) / half_life
    this.halfLife = halfLife;

    // Freeze to prevent accidental mutation
    Object.freeze(this);
  }

  /**
   * Get current state as plain object.
   * 
   * @returns {Object} Current state snapshot
   */
  getState() {
    return {
      nodeId: this.nodeId,
      activationCount: this.activationCount,
      lastActivation: this.lastActivation,
      strength: this.strength,
      decayRate: this.decayRate,
      halfLife: this.halfLife,
    };
  }

  /**
   * Compute decay strength at given elapsed time.
   * Formula: strength(t) = S0 * e^(-λt)
   * 
   * @param {number} elapsedMs - Milliseconds elapsed since last activation
   * @returns {number} Decayed strength value [0.0, 1.0]
   * @throws {TypeError} If elapsedMs is not a non-negative number
   */
  computeDecay(elapsedMs) {
    if (typeof elapsedMs !== 'number' || elapsedMs < 0) {
      throw new TypeError('elapsedMs must be a non-negative number');
    }

    // S(t) = S0 * e^(-λt)
    const decayedStrength = this.strength * Math.exp(-this.decayRate * elapsedMs);
    
    // Clamp to [0.0, 1.0]
    return Math.max(0, Math.min(1, decayedStrength));
  }

  /**
   * Compute strength decay since last activation.
   * Uses current time automatically.
   * 
   * @returns {number} Current decayed strength
   */
  getCurrentStrength() {
    const now = Date.now();
    const elapsedMs = now - this.lastActivation;
    return this.computeDecay(elapsedMs);
  }

  /**
   * Record a node activation.
   * Returns new Reinforcement object with updated state.
   * Original object is unchanged.
   * 
   * @param {Object} [context={}] - Activation context (metadata)
   * @returns {Reinforcement} New Reinforcement with updated state
   */
  activate(context = {}) {
    if (typeof context !== 'object' || context === null) {
      throw new TypeError('context must be an object');
    }

    // Increase activation count
    const newActivationCount = this.activationCount + 1;
    
    // Reset strength to 1.0 on activation
    const newReinforcement = new Reinforcement(
      this.nodeId,
      1.0,
      this.halfLife,
      newActivationCount,
      Date.now()
    );

    return newReinforcement;
  }

  /**
   * Compute delta (change) between two states.
   * Returns object with strength delta and direction.
   * 
   * @param {Object} priorState - Prior state to compare against
   * @returns {Object} Delta object with strength, direction, percentage
   * @throws {TypeError} If priorState invalid
   */
  computeDelta(priorState) {
    if (!priorState || typeof priorState !== 'object') {
      throw new TypeError('priorState must be an object');
    }

    const priorStrength = priorState.strength || 0;
    const currentStrength = this.strength;
    
    const delta = currentStrength - priorStrength;
    const direction = delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'stable';
    const percentChange = priorStrength > 0 ? (delta / priorStrength) * 100 : 0;

    return {
      delta,
      direction,
      percentChange,
      from: priorStrength,
      to: currentStrength,
    };
  }

  /**
   * Create new Reinforcement with decayed strength.
   * Returns new object reflecting time-based decay.
   * 
   * @param {number} [elapsedMs] - Override elapsed time (for testing)
   * @returns {Reinforcement} New Reinforcement with decayed strength
   */
  withDecay(elapsedMs) {
    const actualElapsed = elapsedMs !== undefined ? elapsedMs : (Date.now() - this.lastActivation);
    const decayedStrength = this.computeDecay(actualElapsed);

    const newReinforcement = new Reinforcement(
      this.nodeId,
      decayedStrength,
      this.halfLife,
      this.activationCount,
      this.lastActivation
    );

    return newReinforcement;
  }

  /**
   * Serialize to plain object.
   * 
   * @returns {Object} Plain object representation
   */
  toJSON() {
    return {
      nodeId: this.nodeId,
      activationCount: this.activationCount,
      lastActivation: this.lastActivation,
      strength: this.strength,
      decayRate: this.decayRate,
      halfLife: this.halfLife,
    };
  }

  /**
   * Get readable string representation.
   * 
   * @returns {string} String representation
   */
  toString() {
    return `Reinforcement(nodeId=${this.nodeId}, strength=${this.strength.toFixed(2)}, activations=${this.activationCount})`;
  }
}

/**
 * Factory function to create reinforcement tracker.
 * 
 * @param {string} nodeId - Associated node ID
 * @param {number} [initialStrength=1.0] - Initial strength
 * @param {number} [halfLife=86400000] - Half-life in ms
 * @returns {Reinforcement} New tracker instance
 */
function createReinforcement(nodeId, initialStrength = 1.0, halfLife = 86400000) {
  return new Reinforcement(nodeId, initialStrength, halfLife);
}

/**
 * Compute exponential decay for a strength value.
 * Standalone function for custom computations.
 * 
 * @param {number} strength - Initial strength value
 * @param {number} elapsedMs - Elapsed milliseconds
 * @param {number} [halfLife=86400000] - Half-life in ms
 * @returns {number} Decayed strength [0.0, 1.0]
 */
function computeDecay(strength, elapsedMs, halfLife = 86400000) {
  if (typeof strength !== 'number' || strength < 0 || strength > 1) {
    throw new TypeError('strength must be a number between 0.0 and 1.0');
  }

  if (typeof elapsedMs !== 'number' || elapsedMs < 0) {
    throw new TypeError('elapsedMs must be a non-negative number');
  }

  if (typeof halfLife !== 'number' || halfLife <= 0) {
    throw new TypeError('halfLife must be a positive number');
  }

  const decayRate = Math.LN2 / halfLife;
  const decayedStrength = strength * Math.exp(-decayRate * elapsedMs);
  
  return Math.max(0, Math.min(1, decayedStrength));
}

/**
 * Compute delta between two strength values.
 * 
 * @param {number} currentStrength - Current strength
 * @param {number} priorStrength - Prior strength
 * @returns {Object} Delta details
 */
function computeDelta(currentStrength, priorStrength) {
  if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
    throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
  }

  if (typeof priorStrength !== 'number' || priorStrength < 0 || priorStrength > 1) {
    throw new TypeError('priorStrength must be a number between 0.0 and 1.0');
  }

  const delta = currentStrength - priorStrength;
  const direction = delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'stable';
  const percentChange = priorStrength > 0 ? (delta / priorStrength) * 100 : 0;

  return {
    delta,
    direction,
    percentChange,
    from: priorStrength,
    to: currentStrength,
  };
}

/**
 * Get exponential decay rate (lambda) for a given half-life.
 * 
 * @param {number} halfLife - Half-life in milliseconds
 * @returns {number} Decay rate (lambda)
 */
function getDecayRate(halfLife) {
  if (typeof halfLife !== 'number' || halfLife <= 0) {
    throw new TypeError('halfLife must be a positive number');
  }

  return Math.LN2 / halfLife;
}

// Export public API
module.exports = {
  Reinforcement,
  createReinforcement,
  computeDecay,
  computeDelta,
  getDecayRate,
};
