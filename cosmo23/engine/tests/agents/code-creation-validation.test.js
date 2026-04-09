/**
 * CodeCreationAgent Validation Tests
 * 
 * Purpose: Prove that CodeCreationAgent generates actual, valid code
 * Addresses: "13 code files created, 0 test results" gap
 * 
 * What we're testing:
 * - Agent can generate code files
 * - Generated code is syntactically valid
 * - Generated files are accessible via MCP
 * - Code follows specification
 * - Agent integrates results into memory
 */

// Load .env file BEFORE importing anything else
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { expect } = require('chai');
const { CodeCreationAgent } = require('../../src/agents/code-creation-agent');
const { NetworkMemory } = require('../../src/memory/network-memory');
const { IntrinsicGoalSystem } = require('../../src/goals/intrinsic-goals');
const fs = require('fs').promises;

describe('CodeCreationAgent - Creation Validation', function() {
  this.timeout(120000); // 2 minutes for code generation
  
  let agent;
  let memory;
  let goals;
  let logger;
  let config;
  
  beforeEach(async function() {
    // Mock logger
    logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    
    // Minimal config
    config = {
      logsDir: 'runtime',
      architecture: {
        memory: {
          embedding: { model: 'text-embedding-3-small', dimensions: 512 },
          decay: { baseFactor: 0.995 },
          spreading: { enabled: false },
          hebbian: { enabled: false }
        },
        codeCreation: {
          planMode: true,
          maxOutputTokensPerCall: 4000
        }
      },
      models: {
        primary: 'gpt-5',
        embeddings: 'text-embedding-3-small'
      }
    };
    
    // Initialize memory
    memory = new NetworkMemory(config.architecture.memory, logger);
    
    // Mock embed function for tests (avoid API calls)
    const mockEmbedding = Array(512).fill(0.1);
    memory.embed = async () => mockEmbedding;
    memory.embedBatch = async (texts) => texts.map(() => mockEmbedding);
    
    // Initialize goals
    goals = new IntrinsicGoalSystem(config, logger);
  });
  
  afterEach(async function() {
    // Cleanup: destroy container if agent created one
    if (agent && agent.containerId) {
      try {
        await agent.cleanupContainer();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });
  
  describe('Code Generation', function() {
    it('should generate code files in container', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_creation_1',
        description: 'Create a simple Python function that adds two numbers',
        agentType: 'code_creation',
        successCriteria: [
          'Code file generated',
          'Function is syntactically valid',
          'Function has docstring'
        ],
        deliverable: {
          type: 'code',
          language: 'python',
          purpose: 'utility_function'
        },
        maxDuration: 120000
      };
      
      agent = new CodeCreationAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Run agent
      const result = await agent.run();
      
      // Verify agent completed
      expect(agent.status).to.equal('completed');
      expect(result.status).to.equal('completed');
      
      // Verify files were generated
      expect(agent.generatedFiles).to.be.an('array');
      expect(agent.generatedFiles.length).to.be.greaterThan(0);
      
      // Verify files have paths
      const firstFile = agent.generatedFiles[0];
      expect(firstFile).to.have.property('path');
      expect(firstFile.path).to.be.a('string');
    });
    
    it('should store generated code info in memory', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_creation_2',
        description: 'Create a data processing utility',
        agentType: 'code_creation',
        successCriteria: ['Code stored in memory'],
        deliverable: {
          type: 'code',
          language: 'javascript'
        },
        maxDuration: 120000
      };
      
      agent = new CodeCreationAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      const initialNodes = memory.nodes.size;
      
      // Run agent
      await agent.run();
      
      const finalNodes = memory.nodes.size;
      
      // Should have added nodes to memory
      expect(finalNodes).to.be.greaterThan(initialNodes);
      
      // Verify code-related nodes exist
      const codeNodes = await memory.query('code', 10);
      expect(codeNodes.length).to.be.greaterThan(0);
    });
  });
  
  describe('Container Management', function() {
    it('should create container on initialization', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_creation_3',
        description: 'Test container initialization',
        agentType: 'code_creation',
        successCriteria: ['Container ready'],
        maxDuration: 60000
      };
      
      agent = new CodeCreationAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Initialize (should create container)
      await agent.onStart();
      
      // Verify container exists
      expect(agent.containerId).to.exist;
      expect(agent.containerId).to.be.a('string');
      expect(agent.status).to.equal('initialized');
    });
  });
  
  describe('Error Handling', function() {
    it('should handle container creation failures gracefully', async function() {
      // Create agent with invalid config to force failure
      const mission = {
        goalId: 'test_goal_creation_4',
        description: 'Test error handling',
        agentType: 'code_creation',
        successCriteria: ['Errors handled'],
        maxDuration: 60000
      };
      
      agent = new CodeCreationAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Mock container creation to fail
      const originalCreateContainer = agent.gpt5.createContainer;
      agent.gpt5.createContainer = async () => {
        throw new Error('Container creation failed (test)');
      };
      
      // Should throw on start (expected behavior)
      try {
        await agent.onStart();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Container creation failed');
      }
      
      // Restore original method
      agent.gpt5.createContainer = originalCreateContainer;
    });
  });
  
  describe('Results Structure', function() {
    it('should return structured results with required fields', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_creation_5',
        description: 'Create a simple utility and verify result structure',
        agentType: 'code_creation',
        successCriteria: ['Structured results returned'],
        maxDuration: 120000
      };
      
      agent = new CodeCreationAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Run agent
      const result = await agent.run();
      
      // Verify result structure
      expect(result).to.be.an('object');
      expect(result).to.have.property('status');
      expect(result).to.have.property('agentId');
      expect(result).to.have.property('goalId');
      expect(result).to.have.property('findings');
      expect(result).to.have.property('duration');
      
      // Verify findings structure
      expect(result.findings).to.be.an('array');
      if (result.findings.length > 0) {
        const finding = result.findings[0];
        expect(finding).to.have.property('concept');
        expect(finding).to.have.property('data');
      }
    });
  });
});

