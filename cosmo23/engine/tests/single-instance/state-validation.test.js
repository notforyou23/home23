/**
 * Single-Instance Integration Test: State Validation
 * 
 * Tests state validation in actual COSMO orchestrator
 */

const { expect } = require('chai');
const { StateValidator } = require('../../src/core/state-validator');

describe('Single-Instance: State Validation', () => {
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

  describe('Boot Validation', () => {
    it('should validate orchestrator initial state structure', () => {
      const state = {
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
        reflection: {}
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should auto-correct corrupted state', () => {
      const corruptedState = {
        cycleCount: -10, // Invalid
        journal: 'not an array', // Invalid
        memory: {
          nodes: [
            { id: 'valid', concept: 'test' },
            { id: '', concept: 'invalid' }, // Should be filtered
            { concept: 'missing-id' } // Should be filtered
          ],
          edges: []
        }
      };

      const result = validator.validateBoot(corruptedState);
      expect(result.valid).to.be.false;
      expect(result.corrected.cycleCount).to.equal(0);
      expect(result.corrected.journal).to.be.an('array');
      expect(result.corrected.memory.nodes).to.have.lengthOf(1);
    });
  });

  describe('Cycle Boundary Validation', () => {
    it('should validate state consistency at cycle boundaries', () => {
      const state = {
        cycleCount: 5,
        journal: [],
        memory: {
          nodes: [
            { id: 'n1', concept: 'node1' },
            { id: 'n2', concept: 'node2' }
          ],
          edges: [
            { from: 'n1', to: 'n2', type: 'relates' }
          ]
        }
      };

      const result = validator.validateCycle(state, 5);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should detect cycle number mismatch', () => {
      const state = {
        cycleCount: 10,
        journal: []
      };

      const result = validator.validateCycle(state, 5);
      expect(result.valid).to.be.false;
      expect(result.errors).to.include('Cycle mismatch: expected 5, got 10');
    });
  });

  describe('Dangling Reference Detection', () => {
    it('should detect edges referencing non-existent nodes', () => {
      const state = {
        cycleCount: 0,
        journal: [],
        memory: {
          nodes: [{ id: 'n1', concept: 'exists' }],
          edges: [
            { from: 'n1', to: 'n999', type: 'invalid' } // n999 doesn't exist
          ]
        }
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.false;
      expect(result.corrected.memory.edges).to.be.empty;
    });
  });
});

