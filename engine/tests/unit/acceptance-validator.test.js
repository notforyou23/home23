/**
 * Unit tests for AcceptanceValidator
 * Tests validation logic for literal patterns, tool execution, and QA checks
 */

const { expect, assert } = require('chai');
const AcceptanceValidator = require('../../src/planning/acceptance-validator');

describe('AcceptanceValidator', () => {
  let validator;
  let mockAgentExecutor;
  let mockLogger;
  
  beforeEach(() => {
    mockLogger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    };
    
    mockAgentExecutor = {
      spawnAgent: async () => ({
        agentId: 'qa-agent-123',
        results: []
      })
    };
    
    validator = new AcceptanceValidator(mockAgentExecutor, mockLogger);
  });

  describe('checkLiteral', () => {
    it('should pass when pattern is found in artifact content', async () => {
      const criterion = {
        type: 'literal',
        pattern: 'test pattern'
      };
      
      const artifacts = [
        { type: 'document', content: 'This contains the test pattern in the middle' }
      ];
      
      const result = await validator.checkLiteral(criterion, artifacts);
      expect(result).to.equal(true);
    });

    it('should fail when pattern is not found', async () => {
      const criterion = {
        type: 'literal',
        pattern: 'missing pattern'
      };
      
      const artifacts = [
        { type: 'document', content: 'This does not contain it' }
      ];
      
      const result = await validator.checkLiteral(criterion, artifacts);
      expect(result).to.equal(false);
    });

    it('should be case insensitive by default', async () => {
      const criterion = {
        type: 'literal',
        pattern: 'TEST PATTERN'
      };
      
      const artifacts = [
        { type: 'document', content: 'This contains test pattern lowercase' }
      ];
      
      const result = await validator.checkLiteral(criterion, artifacts);
      expect(result).to.equal(true);
    });

    it('should search across multiple artifacts', async () => {
      const criterion = {
        type: 'literal',
        pattern: 'target phrase'
      };
      
      const artifacts = [
        { type: 'document', content: 'First document without it' },
        { type: 'document', content: 'Second document with target phrase here' },
        { type: 'document', content: 'Third document' }
      ];
      
      const result = await validator.checkLiteral(criterion, artifacts);
      expect(result).to.equal(true);
    });

    it('should handle empty artifacts', async () => {
      const criterion = {
        type: 'literal',
        pattern: 'anything'
      };
      
      const artifacts = [];
      
      const result = await validator.checkLiteral(criterion, artifacts);
      expect(result).to.equal(false);
    });
  });

  describe('checkTool', () => {
    it('should pass when tool result indicates success', async () => {
      const criterion = {
        type: 'tool',
        command: 'node -e "process.exit(0)"'
      };
      
      const result = await validator.checkTool(criterion, []);
      expect(result).to.equal(true);
    });

    it('should fail when tool result indicates failure', async () => {
      const criterion = {
        type: 'tool',
        command: 'node -e "process.exit(1)"'
      };
      
      const result = await validator.checkTool(criterion, []);
      expect(result).to.equal(false);
    });

    it('should handle missing command definition', async () => {
      const criterion = {
        type: 'tool',
        command: null
      };
      
      const result = await validator.checkTool(criterion, []);
      expect(result).to.equal(false);
    });
  });

  describe('checkQA', () => {
    it('should pass when QA rubric is satisfied above threshold', async () => {
      const criterion = {
        type: 'qa',
        rubric: 'Contains at least 50 sources with proper citations',
        threshold: 0.7
      };
      
      const artifacts = [
        { 
          type: 'bibliography', 
          content: 'Bibliography with 60 properly cited sources...'
        }
      ];
      
      // Mock QA agent to return passing score
      validator.spawnQAAgent = async () => ({ verdict: 'PASS', score: 0.85 });
      
      const result = await validator.checkQA(criterion, artifacts);
      expect(result).to.equal(true);
    });

    it('should fail when QA score is below threshold', async () => {
      const criterion = {
        type: 'qa',
        rubric: 'Contains comprehensive analysis',
        threshold: 0.8
      };
      
      const artifacts = [
        { type: 'report', content: 'Brief summary...' }
      ];
      
      // Mock QA agent to return low score
      validator.spawnQAAgent = async () => ({ verdict: 'FAIL', score: 0.5 });
      
      const result = await validator.checkQA(criterion, artifacts);
      expect(result).to.equal(false);
    });

    it('should use fallback on QA agent error', async () => {
      const criterion = {
        type: 'qa',
        rubric: 'Quality check',
        threshold: 0.7
      };
      
      const artifacts = [
        { type: 'document', content: 'Some content' }
      ];
      
      // Mock QA agent to throw error
      validator.spawnQAAgent = async () => {
        throw new Error('QA agent unavailable');
      };
      
      const result = await validator.checkQA(criterion, artifacts);
      expect(result).to.equal(false);
    });
  });

  describe('checkAll', () => {
    it('should pass when all criteria pass', async () => {
      const criteria = [
        {
          type: 'literal',
          pattern: 'required text'
        },
        {
          type: 'qa',
          rubric: 'Good quality',
          threshold: 0.7
        }
      ];
      
      const artifacts = [
        { type: 'document', content: 'This has required text and is high quality' }
      ];
      
      // Mock QA
      validator.checkQA = async () => true;
      
      const result = await validator.checkAll(criteria, artifacts);
      expect(result.passed).to.equal(true);
      expect(result.failures.length).to.equal(0);
    });

    it('should fail when any criterion fails', async () => {
      const criteria = [
        {
          type: 'literal',
          pattern: 'required text'
        },
        {
          type: 'literal',
          pattern: 'missing text'
        }
      ];
      
      const artifacts = [
        { type: 'document', content: 'This has required text only' }
      ];
      
      const result = await validator.checkAll(criteria, artifacts);
      expect(result.passed).to.equal(false);
      expect(result.failures.length).to.equal(1);
      expect(result.failures[0].reason).to.include('missing text');
    });

    it('should handle empty criteria as automatic pass', async () => {
      const criteria = [];
      const artifacts = [{ type: 'document', content: 'anything' }];
      
      const result = await validator.checkAll(criteria, artifacts);
      expect(result.passed).to.equal(true);
    });

    it('should collect all failures', async () => {
      const criteria = [
        { type: 'literal', pattern: 'missing1' },
        { type: 'literal', pattern: 'missing2' },
        { type: 'literal', pattern: 'present' }
      ];
      
      const artifacts = [
        { type: 'document', content: 'This only has present' }
      ];
      
      const result = await validator.checkAll(criteria, artifacts);
      expect(result.passed).to.equal(false);
      expect(result.failures.length).to.equal(2);
    });
  });
});

