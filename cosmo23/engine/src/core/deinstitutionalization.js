/**
 * deinstitutionalization.js - Institutional Memory Decay Tracking
 * 
 * Tracks institutional memory decay with locked thresholds:
 * - Activation threshold: 0.7
 * - Reset threshold: 0.6
 * 
 * State machine:
 * strength >= 0.7 → ACTIVATED (institutional memory strong)
 * 0.6 < strength < 0.7 → DECAYING (institutional memory weakening)
 * strength <= 0.6 → RESET (institutional memory reset)
 * 
 * @module core/deinstitutionalization
 */

// Locked thresholds per spec
const THRESHOLDS = {
  activation: 0.7,
  reset: 0.6,
};

/**
 * Deinstitutionalization - Tracks institutional memory decay
 * 
 * @class Deinstitutionalization
 */
class Deinstitutionalization {
  /**
   * Create deinstitutionalization tracker
   */
  constructor() {
    this.thresholds = THRESHOLDS;
    // Track state per node: { nodeId: { state, lastStrength } }
    this.nodeStates = new Map();
    Object.freeze(this);
  }

  /**
   * Check if node is in activated state.
   * Activated: strength >= 0.7
   * 
   * @param {string} nodeId - Node identifier
   * @param {number} currentStrength - Current strength value [0.0, 1.0]
   * @returns {boolean} True if strength >= 0.7
   * @throws {TypeError} If parameters invalid
   */
  isActivated(nodeId, currentStrength) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
      throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
    }

    return currentStrength >= this.thresholds.activation;
  }

  /**
   * Check if node should reset decay counter.
   * Reset: strength <= 0.6
   * 
   * @param {string} nodeId - Node identifier
   * @param {number} currentStrength - Current strength value [0.0, 1.0]
   * @returns {boolean} True if strength <= 0.6
   * @throws {TypeError} If parameters invalid
   */
  shouldReset(nodeId, currentStrength) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
      throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
    }

    return currentStrength <= this.thresholds.reset;
  }

  /**
   * Compute decay phase for a node.
   * 
   * @param {string} nodeId - Node identifier
   * @param {number} currentStrength - Current strength value
   * @param {number} [elapsedMs=0] - Time elapsed since last state change
   * @returns {Object} Phase info { phase, decayValue, activated, reset }
   * @throws {TypeError} If parameters invalid
   */
  computeDecayPhase(nodeId, currentStrength, elapsedMs = 0) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
      throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
    }

    if (typeof elapsedMs !== 'number' || elapsedMs < 0) {
      throw new TypeError('elapsedMs must be a non-negative number');
    }

    const activated = this.isActivated(nodeId, currentStrength);
    const reset = this.shouldReset(nodeId, currentStrength);

    let phase;
    if (activated) {
      phase = 'activated';
    } else if (reset) {
      phase = 'reset';
    } else {
      phase = 'decaying';
    }

    // Compute decay value: how much strength has decayed from max
    const decayValue = 1.0 - currentStrength;

    return {
      nodeId,
      phase,
      decayValue,
      activated,
      reset,
      currentStrength,
      elapsedMs,
    };
  }

  /**
   * Get activation threshold.
   * 
   * @returns {number} Activation threshold (0.7)
   */
  getActivationThreshold() {
    return this.thresholds.activation;
  }

  /**
   * Get reset threshold.
   * 
   * @returns {number} Reset threshold (0.6)
   */
  getResetThreshold() {
    return this.thresholds.reset;
  }

  /**
   * Get all thresholds.
   * 
   * @returns {Object} Thresholds { activation, reset }
   */
  getThresholds() {
    return { ...this.thresholds };
  }

  /**
   * Check if strength is in decay zone.
   * Decay zone: 0.6 < strength < 0.7
   * 
   * @param {number} currentStrength - Current strength
   * @returns {boolean} True if in decay zone
   */
  isDecaying(currentStrength) {
    if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
      throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
    }

    return (
      currentStrength > this.thresholds.reset &&
      currentStrength < this.thresholds.activation
    );
  }

  /**
   * Get state for a node.
   * 
   * @param {string} nodeId - Node identifier
   * @returns {Object|null} State or null if not tracked
   */
  getState(nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    const state = this.nodeStates.get(nodeId);
    return state ? { ...state } : null;
  }

  /**
   * Update node state based on strength.
   * Internal method for tracking state transitions.
   * 
   * @param {string} nodeId - Node identifier
   * @param {number} currentStrength - Current strength
   * @returns {Object} Updated state
   */
  updateState(nodeId, currentStrength) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
      throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
    }

    const phase = this.computeDecayPhase(nodeId, currentStrength);
    const newState = {
      nodeId,
      phase: phase.phase,
      currentStrength,
      lastUpdated: Date.now(),
    };

    this.nodeStates.set(nodeId, newState);
    return newState;
  }
}

/**
 * Factory function to create deinstitutionalization tracker.
 * 
 * @returns {Deinstitutionalization} New tracker instance
 */
function createDeinstitutionalization() {
  return new Deinstitutionalization();
}

/**
 * Compute decay phase for arbitrary parameters.
 * 
 * @param {number} currentStrength - Current strength [0.0, 1.0]
 * @returns {string} Phase: 'activated' | 'decaying' | 'reset'
 */
function computeDecayPhase(currentStrength) {
  if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
    throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
  }

  if (currentStrength >= THRESHOLDS.activation) {
    return 'activated';
  } else if (currentStrength <= THRESHOLDS.reset) {
    return 'reset';
  } else {
    return 'decaying';
  }
}

/**
 * Check if strength indicates activation.
 * 
 * @param {number} currentStrength - Current strength
 * @returns {boolean} True if strength >= 0.7
 */
function isActivated(currentStrength) {
  if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
    throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
  }

  return currentStrength >= THRESHOLDS.activation;
}

/**
 * Check if strength indicates reset.
 * 
 * @param {number} currentStrength - Current strength
 * @returns {boolean} True if strength <= 0.6
 */
function shouldReset(currentStrength) {
  if (typeof currentStrength !== 'number' || currentStrength < 0 || currentStrength > 1) {
    throw new TypeError('currentStrength must be a number between 0.0 and 1.0');
  }

  return currentStrength <= THRESHOLDS.reset;
}

/**
 * Get activation threshold.
 * 
 * @returns {number} Activation threshold (0.7)
 */
function getActivationThreshold() {
  return THRESHOLDS.activation;
}

/**
 * Get reset threshold.
 * 
 * @returns {number} Reset threshold (0.6)
 */
function getResetThreshold() {
  return THRESHOLDS.reset;
}

// Export public API
module.exports = {
  Deinstitutionalization,
  createDeinstitutionalization,
  THRESHOLDS,
  computeDecayPhase,
  isActivated,
  shouldReset,
  getActivationThreshold,
  getResetThreshold,
};
