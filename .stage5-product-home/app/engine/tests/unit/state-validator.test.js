/**
 * Unit tests for StateValidator
 */

const { expect } = require('chai');
const { StateValidator } = require('../../src/core/state-validator');

describe('StateValidator', () => {
  let validator;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    validator = new StateValidator(mockLogger);
  });

  describe('validateBoot', () => {
    it('should accept valid state', () => {
      const state = {
        cycleCount: 10,
        journal: [],
        memory: {
          nodes: [{ id: 'n1', concept: 'test' }],
          edges: [],
          clusters: []
        },
        goals: {
          active: [],
          completed: []
        }
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should reject null state', () => {
      const result = validator.validateBoot(null);
      expect(result.valid).to.be.false;
      expect(result.errors).to.not.be.empty;
      expect(result.corrected).to.have.property('cycleCount', 0);
    });

    it('should correct invalid cycleCount', () => {
      const state = {
        cycleCount: -5, // Invalid
        journal: []
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.false;
      expect(result.corrected.cycleCount).to.equal(0);
    });

    it('should correct missing journal', () => {
      const state = {
        cycleCount: 0
        // journal missing
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.false;
      expect(result.corrected.journal).to.be.an('array');
    });

    it('should filter invalid memory nodes', () => {
      const state = {
        cycleCount: 0,
        journal: [],
        memory: {
          nodes: [
            { id: 'n1', concept: 'valid' },
            { id: '', concept: 'invalid-id' }, // Invalid: empty id
            { id: 'n3' } // Invalid: missing concept
          ],
          edges: []
        }
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.false;
      expect(result.corrected.memory.nodes).to.have.lengthOf(1);
      expect(result.corrected.memory.nodes[0].id).to.equal('n1');
    });

    it('should filter edges with non-existent nodes', () => {
      const state = {
        cycleCount: 0,
        journal: [],
        memory: {
          nodes: [
            { id: 'n1', concept: 'node1' },
            { id: 'n2', concept: 'node2' }
          ],
          edges: [
            { from: 'n1', to: 'n2', type: 'valid' },
            { from: 'n1', to: 'n999', type: 'invalid' }, // n999 doesn't exist
            { from: 'n888', to: 'n2', type: 'invalid' }  // n888 doesn't exist
          ]
        }
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.false;
      expect(result.corrected.memory.edges).to.have.lengthOf(1);
      expect(result.corrected.memory.edges[0].from).to.equal('n1');
      expect(result.corrected.memory.edges[0].to).to.equal('n2');
    });

    it('should create empty state when completely invalid', () => {
      const result = validator.validateBoot('not an object');
      expect(result.valid).to.be.false;
      expect(result.corrected).to.have.property('cycleCount', 0);
      expect(result.corrected).to.have.property('journal').that.is.an('array');
    });
  });

  describe('validateCycle', () => {
    it('should accept valid cycle state', () => {
      const state = {
        cycleCount: 5,
        journal: [],
        memory: {
          nodes: [],
          edges: []
        }
      };

      const result = validator.validateCycle(state, 5);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should detect cycle mismatch', () => {
      const state = {
        cycleCount: 10,
        journal: []
      };

      const result = validator.validateCycle(state, 5);
      expect(result.valid).to.be.false;
      expect(result.errors).to.include('Cycle mismatch: expected 5, got 10');
    });

    it('should detect corrupted memory structure', () => {
      const state = {
        cycleCount: 5,
        journal: [],
        memory: 'not an object' // Invalid
      };

      const result = validator.validateCycle(state, 5);
      expect(result.valid).to.be.false;
    });
  });

  describe('createEmptyState', () => {
    it('should create valid empty state', () => {
      const emptyState = validator.createEmptyState();
      
      expect(emptyState).to.have.property('cycleCount', 0);
      expect(emptyState.journal).to.be.an('array').that.is.empty;
      expect(emptyState.memory).to.have.property('nodes').that.is.an('array');
      expect(emptyState.memory).to.have.property('edges').that.is.an('array');
      expect(emptyState.goals).to.have.property('active').that.is.an('array');
    });
  });

  describe('getStats', () => {
    it('should return validation stats', () => {
      const state = { cycleCount: 0, journal: [] };
      validator.validateBoot(state);
      
      const stats = validator.getStats();
      expect(stats).to.have.property('lastValidation');
      expect(stats.lastValidation).to.have.property('valid');
    });
  });
});

