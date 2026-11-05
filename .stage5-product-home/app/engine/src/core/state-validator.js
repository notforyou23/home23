/**
 * StateValidator
 *
 * Phase A: State validation at boot and cycle boundaries
 * - Validates core state structure
 * - Checks for corruption
 * - Verifies integrity
 * - Prevents invalid state from propagating
 */

class StateValidator {
  constructor(logger) {
    this.logger = logger;
    this.validationErrors = [];
    this.lastValidation = null;
  }

  /**
   * Validate state structure at boot
   * @param {object} state - state object to validate
   * @returns {object} - { valid: boolean, errors: array, corrected: object }
   */
  validateBoot(state) {
    this.validationErrors = [];
    const startTime = Date.now();

    try {
      // Check required top-level fields
      if (typeof state !== 'object' || state === null) {
        this.validationErrors.push('State is not an object');
        return { valid: false, errors: this.validationErrors, corrected: this.createEmptyState() };
      }

      const corrected = { ...state };

      // Validate cycle count
      if (typeof state.cycleCount !== 'number' || state.cycleCount < 0 || !Number.isInteger(state.cycleCount)) {
        this.validationErrors.push(`Invalid cycleCount: ${state.cycleCount}`);
        corrected.cycleCount = 0;
      }

      // Validate journal
      if (!Array.isArray(state.journal)) {
        this.validationErrors.push('Journal is not an array');
        corrected.journal = [];
      }

      // Validate memory structure
      if (state.memory) {
        if (!state.memory.nodes || !Array.isArray(state.memory.nodes)) {
          this.validationErrors.push('Memory nodes is not an array');
          if (!corrected.memory) corrected.memory = {};
          corrected.memory.nodes = [];
        }

        if (!state.memory.edges || !Array.isArray(state.memory.edges)) {
          this.validationErrors.push('Memory edges is not an array');
          if (!corrected.memory) corrected.memory = {};
          corrected.memory.edges = [];
        }

        // Validate each memory node
        if (corrected.memory.nodes) {
          corrected.memory.nodes = corrected.memory.nodes.filter((node, idx) => {
            if (!node.id || typeof node.id !== 'string') {
              this.validationErrors.push(`Memory node ${idx} missing valid id`);
              return false;
            }
            if (!node.concept || typeof node.concept !== 'string') {
              this.validationErrors.push(`Memory node ${node.id} missing valid concept`);
              return false;
            }
            return true;
          });
        }

        // Validate edges reference valid nodes
        if (corrected.memory.edges && corrected.memory.nodes) {
          const nodeIds = new Set(corrected.memory.nodes.map(n => n.id));
          corrected.memory.edges = corrected.memory.edges.filter((edge, idx) => {
            if (!edge.from || !edge.to) {
              this.validationErrors.push(`Edge ${idx} missing from/to`);
              return false;
            }
            if (!nodeIds.has(edge.from)) {
              this.validationErrors.push(`Edge ${idx} references non-existent 'from' node: ${edge.from}`);
              return false;
            }
            if (!nodeIds.has(edge.to)) {
              this.validationErrors.push(`Edge ${idx} references non-existent 'to' node: ${edge.to}`);
              return false;
            }
            return true;
          });
        }
      }

      // Validate goals
      if (state.goals) {
        if (!Array.isArray(state.goals.active)) {
          this.validationErrors.push('Goals.active is not an array');
          if (!corrected.goals) corrected.goals = {};
          corrected.goals.active = [];
        }
      }

      const validationTime = Date.now() - startTime;
      this.lastValidation = {
        timestamp: new Date().toISOString(),
        valid: this.validationErrors.length === 0,
        errorCount: this.validationErrors.length,
        validationTimeMs: validationTime
      };

      this.logger.info('[StateValidator] Boot validation complete', {
        valid: this.validationErrors.length === 0,
        errorCount: this.validationErrors.length,
        validationTimeMs: validationTime
      });

      return {
        valid: this.validationErrors.length === 0,
        errors: this.validationErrors,
        corrected
      };
    } catch (error) {
      this.logger.error('[StateValidator] Boot validation error', { error: error.message });
      return {
        valid: false,
        errors: [error.message],
        corrected: this.createEmptyState()
      };
    }
  }

  /**
   * Validate state at cycle boundary
   * @param {object} state - state to validate
   * @param {number} expectedCycle - expected cycle number
   * @returns {object} - { valid: boolean, errors: array }
   */
  validateCycle(state, expectedCycle) {
    this.validationErrors = [];
    const startTime = Date.now();

    try {
      // Quick structural validation
      if (typeof state !== 'object' || state === null) {
        this.validationErrors.push('State is not an object');
        return { valid: false, errors: this.validationErrors };
      }

      // Cycle count should match expected
      if (state.cycleCount !== expectedCycle) {
        this.validationErrors.push(`Cycle mismatch: expected ${expectedCycle}, got ${state.cycleCount}`);
      }

      // Journal size check
      if (!Array.isArray(state.journal)) {
        this.validationErrors.push('Journal is not an array');
      }

      // Memory consistency
      if (state.memory) {
        if (!Array.isArray(state.memory.nodes) || !Array.isArray(state.memory.edges)) {
          this.validationErrors.push('Memory structure corrupted');
        }
      }

      const validationTime = Date.now() - startTime;
      this.lastValidation = {
        timestamp: new Date().toISOString(),
        cycle: expectedCycle,
        valid: this.validationErrors.length === 0,
        errorCount: this.validationErrors.length,
        validationTimeMs: validationTime
      };

      if (this.validationErrors.length > 0) {
        this.logger.warn('[StateValidator] Cycle validation failed', {
          cycle: expectedCycle,
          errorCount: this.validationErrors.length,
          errors: this.validationErrors
        });
      }

      return {
        valid: this.validationErrors.length === 0,
        errors: this.validationErrors
      };
    } catch (error) {
      this.logger.error('[StateValidator] Cycle validation error', { 
        cycle: expectedCycle,
        error: error.message 
      });
      return {
        valid: false,
        errors: [error.message]
      };
    }
  }

  /**
   * Create empty valid state
   */
  createEmptyState() {
    return {
      cycleCount: 0,
      journal: [],
      memory: {
        nodes: [],
        edges: [],
        clusters: []
      },
      goals: {
        active: [],
        completed: []
      },
      roles: {},
      reflection: {},
      lastSummarization: 0
    };
  }

  /**
   * Get last validation result
   */
  getLastValidation() {
    return this.lastValidation;
  }

  /**
   * Get validation stats
   */
  getStats() {
    return {
      lastValidation: this.lastValidation,
      totalErrors: this.validationErrors.length
    };
  }
}

module.exports = { StateValidator };

