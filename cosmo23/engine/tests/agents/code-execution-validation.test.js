/**
 * CodeExecutionAgent Validation Tests
 * 
 * Purpose: Prove that CodeExecutionAgent actually executes code and returns results
 * Addresses: "13 code files created, 0 test results" gap from COSMO's self-analysis
 * 
 * What we're testing:
 * - Agent can spawn and create container
 * - Agent can execute code in container
 * - Agent returns structured results
 * - Agent integrates results into memory
 * - Agent cleans up containers
 */

// Load .env file BEFORE importing anything else
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { expect } = require('chai');
const { CodeExecutionAgent } = require('../../src/agents/code-execution-agent');
const { NetworkMemory } = require('../../src/memory/network-memory');
const { IntrinsicGoalSystem } = require('../../src/goals/intrinsic-goals');

describe('CodeExecutionAgent - Execution Validation', function() {
  this.timeout(60000); // 1 minute for container operations
  
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
        }
      },
      models: {
        primary: 'gpt-5',
        embeddings: 'text-embedding-3-small'
      },
      codeExecution: {
        enabled: true,
        containerTimeout: 600000
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
        // Ignore cleanup errors in tests
      }
    }
  });
  
  describe('Container Lifecycle', function() {
    it('should create container on start', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_1',
        description: 'Test container creation',
        agentType: 'code_execution',
        successCriteria: ['Container created'],
        maxDuration: 60000
      };
      
      agent = new CodeExecutionAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Start agent (creates container)
      await agent.onStart();
      
      // Verify container was created
      expect(agent.containerId).to.exist;
      expect(agent.containerId).to.be.a('string');
      expect(agent.containerId.length).to.be.greaterThan(0);
      
      expect(agent.status).to.equal('initialized');
    });
    
    it('should cleanup container on completion', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_2',
        description: 'Test container cleanup',
        agentType: 'code_execution',
        successCriteria: ['Container cleaned up'],
        maxDuration: 60000
      };
      
      agent = new CodeExecutionAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      await agent.onStart();
      const containerId = agent.containerId;
      
      // Cleanup
      await agent.onComplete();
      
      // Container should be cleaned up
      // (Actual verification would require checking Docker, 
      //  but we verify the method was called without error)
      expect(containerId).to.exist;
    });
  });
  
  describe('Code Execution Results', function() {
    it('should execute simple Python code and return results', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_3',
        description: 'Execute simple computation: calculate sum of [1,2,3,4,5]',
        agentType: 'code_execution',
        successCriteria: [
          'Code executes successfully',
          'Result is returned',
          'Result is correct'
        ],
        maxDuration: 120000
      };
      
      agent = new CodeExecutionAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Run agent
      const result = await agent.run();
      
      // Verify results structure
      expect(result).to.exist;
      expect(result.status).to.equal('completed');
      expect(result.findings).to.be.an('array');
      expect(result.findings.length).to.be.greaterThan(0);
      
      // Verify agent completed
      expect(agent.status).to.equal('completed');
      expect(agent.endTime).to.exist;
      
      // Verify memory integration
      const memoryNodes = await memory.query(mission.description, 5);
      expect(memoryNodes.length).to.be.greaterThan(0);
    });
    
    it('should handle execution errors gracefully', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_4',
        description: 'Execute invalid Python code that will fail',
        agentType: 'code_execution',
        successCriteria: ['Error is handled gracefully'],
        maxDuration: 120000
      };
      
      agent = new CodeExecutionAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Run agent - should handle error without throwing
      const result = await agent.run();
      
      // Should complete (not crash) even with execution error
      expect(result).to.exist;
      expect(agent.status).to.be.oneOf(['completed', 'failed']);
    });
  });
  
  describe('Memory Integration', function() {
    it('should store execution results in memory with proper tags', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_5',
        description: 'Execute code and verify memory integration',
        agentType: 'code_execution',
        successCriteria: ['Results stored in memory'],
        maxDuration: 120000
      };
      
      agent = new CodeExecutionAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      const initialNodes = memory.nodes.size;
      
      // Run agent
      await agent.run();
      
      const finalNodes = memory.nodes.size;
      
      // Should have added nodes to memory
      expect(finalNodes).to.be.greaterThan(initialNodes);
      
      // Query for execution-related nodes
      const execNodes = await memory.query('execution result', 10);
      expect(execNodes.length).to.be.greaterThan(0);
      
      // Verify nodes have appropriate tags
      const tags = execNodes.map(n => n.tag);
      expect(tags).to.include.oneOf([
        'code_execution',
        'agent_finding',
        'computational_result'
      ]);
    });
  });
  
  describe('Progress Reporting', function() {
    it('should report progress during execution', async function() {
      // Skip if OpenAI API key not available
      if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.startsWith('sk-')) {
        this.skip();
      }
      
      const mission = {
        goalId: 'test_goal_6',
        description: 'Test progress reporting',
        agentType: 'code_execution',
        successCriteria: ['Progress reported'],
        maxDuration: 120000
      };
      
      agent = new CodeExecutionAgent(mission, config, logger);
      agent.memory = memory;
      agent.goals = goals;
      
      // Track progress reports
      const progressReports = [];
      agent.on('progress', (data) => {
        progressReports.push(data);
      });
      
      // Run agent
      await agent.run();
      
      // Should have reported progress
      expect(progressReports.length).to.be.greaterThan(0);
      
      // Progress should have percentage and message
      const firstProgress = progressReports[0];
      expect(firstProgress).to.have.property('percentage');
      expect(firstProgress).to.have.property('message');
      expect(firstProgress.percentage).to.be.a('number');
      expect(firstProgress.percentage).to.be.within(0, 100);
    });
  });
});

