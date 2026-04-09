const { BaseAgent } = require('./base-agent');
const { parseWithFallback } = require('../core/json-repair');

/**
 * ExplorationAgent - Creative and speculative exploration specialist
 * 
 * Purpose:
 * - Explores speculative ideas and "what if" scenarios
 * - Generates creative connections between disparate concepts
 * - Pursues dream-like associative thinking
 * - Discovers non-obvious possibilities and alternatives
 * 
 * Use Cases:
 * - Exploring dream sequences and surreal connections
 * - Creative problem-solving through lateral thinking
 * - Generating novel hypotheses worth testing
 * - Discovering unexpected applications of ideas
 */
class ExplorationAgent extends BaseAgent {
  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## ExplorationAgent Behavioral Specification

You explore lateral connections and speculative hypotheses. Be creative but ground speculation
in evidence. Output: hypotheses with supporting evidence and falsification criteria.

### Operating Principles
- Pursue the unexpected: if an exploration direction feels obvious, push further
- Each hypothesis must include falsification criteria — what would disprove it
- Use spreading activation and peripheral memory nodes to find non-obvious connections
- Cross-vector connections are your highest-value output — find what links disparate ideas
- Speculation is encouraged but must be flagged as such and anchored to at least one evidence node
- Exploration in explore-mode is your sweet spot — lean into creative risk
- Generate vectors that span different conceptual distances from the mission
- When conventional assumptions are challenged, articulate what replaces them
- Novel connections feed IntegrationAgent — make them specific and verifiable
- Quality over quantity: three grounded hypotheses beat ten vague ones`;
  }

  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.explorationPaths = [];
    this.novelConnections = [];
  }

  /**
   * Main execution logic
   */
  async execute() {
    this.logger.info('🌀 ExplorationAgent: Starting exploration mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    }, 3);

    const preFlightData = await this.gatherPreFlightContext();

    await this.reportProgress(10, 'Establishing exploration vectors');

    // NEW: Use spreading activation to find unexplored connections
    const activatedConcepts = await this.exploreMemoryConnections(this.mission.description, 3);
    this.logger.info('🔗 Spreading activation for exploration', {
      activated: activatedConcepts.length,
      novel: activatedConcepts.filter(n => n.accessCount === 0).length
    });

    // NEW: Find peripheral nodes for lateral thinking
    if (this.memory && this.memory.queryPeripheral) {
      const peripheral = await this.memory.queryPeripheral(this.mission.description, 5);
      this.logger.info('🌙 Peripheral concepts discovered', {
        peripheralNodes: peripheral.length,
        avgActivation: peripheral.length > 0 
          ? (peripheral.reduce((sum, n) => sum + (n.activation || 0), 0) / peripheral.length).toFixed(3)
          : 0
      });
    }

    // NEW: Check system mode - exploration is more valuable in explore mode
    const systemMode = await this.getCurrentSystemMode();
    if (systemMode) {
      this.logger.info('🔄 System oscillator mode', {
        mode: systemMode.mode,
        isExploreMode: systemMode.isExploreMode,
        productivity: systemMode.productivity
      });
      
      // Note: Explore mode logged but not saved to memory (platitude without substance)
    }

    // NEW: Check for unexplored areas in memory
    const memoryStats = await this.mcp?.get_memory_statistics();
    if (memoryStats) {
      this.logger.info('🧠 Memory landscape', {
        clusters: memoryStats.clusters,
        avgActivation: memoryStats.averageActivation
      });
    }

    // Step 1: Generate exploration vectors
    const vectors = await this.generateExplorationVectors();
    this.explorationPaths = vectors;
    
    if (vectors.length === 0) {
      throw new Error('Failed to generate exploration vectors');
    }

    await this.reportProgress(25, `Generated ${vectors.length} exploration vectors`);

    // Step 2: Explore each vector
    const explorations = [];
    
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      
      this.logger.info('🚀 Exploring vector', {
        agentId: this.agentId,
        vector: vector.direction,
        vectorNum: i + 1,
        total: vectors.length
      }, 3);

      try {
        const exploration = await this.exploreVector(vector);
        explorations.push({
          vector: vector.direction,
          exploration
        });
        
        await this.reportProgress(
          25 + (i + 1) * (40 / vectors.length),
          `Explored: ${vector.direction}`
        );
      } catch (error) {
        this.logger.warn('Vector exploration failed, continuing', {
          vector: vector.direction,
          error: error.message
        }, 3);
      }
    }

    if (explorations.length === 0) {
      throw new Error('All vector explorations failed');
    }

    // Step 3: Discover cross-vector connections
    await this.reportProgress(70, 'Discovering cross-vector connections');
    const connections = await this.discoverConnections(explorations);
    this.novelConnections = connections;

    // Step 4: Generate speculative hypotheses
    await this.reportProgress(80, 'Generating speculative hypotheses');
    const hypotheses = await this.generateHypotheses(explorations, connections);

    // Step 5: Identify most promising directions
    await this.reportProgress(90, 'Identifying promising directions');
    const promisingDirections = await this.identifyPromisingDirections(
      explorations,
      connections,
      hypotheses
    );

    // Step 6: Add findings and insights to memory
    await this.reportProgress(95, 'Adding exploration findings to memory');
    
    // Add exploration findings (raw exploration data)
    for (const exploration of explorations) {
      const finding = `Exploration: ${exploration.vector}\n\n${exploration.exploration.substring(0, 500)}`;
      await this.addFinding(finding, 'exploration');
    }
    
    // Add novel connections as insights (interpretive connections)
    for (const connection of connections) {
      await this.addInsight(connection, 'novel_connection');
    }
    
    // Add speculative hypotheses as insights (high-level interpretations)
    for (const hypothesis of hypotheses) {
      await this.addInsight(hypothesis, 'speculative_hypothesis');
    }

    // Store final results
    this.results.push({
      type: 'exploration_report',
      vectorsExplored: explorations.length,
      connectionsDiscovered: connections.length,
      hypothesesGenerated: hypotheses.length,
      promisingDirections,
      timestamp: new Date()
    }, 3);

    await this.reportProgress(100, 'Exploration complete');

    this.logger.info('✅ ExplorationAgent: Mission complete', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      vectorsExplored: explorations.length,
      connectionsDiscovered: connections.length,
      hypothesesGenerated: hypotheses.length,
      promisingDirections: promisingDirections.length
    }, 3);

    return {
      success: true,
      vectorsExplored: explorations.length,
      connectionsDiscovered: connections.length,
      hypothesesGenerated: hypotheses.length
    };
  }

  /**
   * Generate exploration vectors (directions to explore)
   */
  async generateExplorationVectors() {
    const prompt = `You are generating creative exploration vectors.

MISSION: ${this.mission.description}

Generate 3 distinct exploration vectors - creative directions to explore.

Each vector should:
- Take the concept in an unexpected direction
- Explore "what if" scenarios
- Make surprising connections
- Be specific enough to pursue

Think laterally and creatively. Don't just analyze - explore possibilities.

Respond in JSON format:
{
  "vectors": [
    {
      "direction": "First exploration direction...",
      "rationale": "Why this is worth exploring..."
    },
    {
      "direction": "Second exploration direction...",
      "rationale": "Why this is worth exploring..."
    },
    {
      "direction": "Third exploration direction...",
      "rationale": "Why this is worth exploring..."
    }
  ]
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        component: 'explorationAgent',
        purpose: 'vectorGeneration',
        instructions: this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()) + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Generate exploration vectors.' }],
        maxTokens: 10000, // Creative ideation needs space
        reasoningEffort: 'medium' // Creative exploration needs thinking
      }, 3);

      // Check if response is incomplete - provide fallback vectors
      if (response.hadError || response.errorType === 'response.incomplete') {
        this.logger.warn('Response incomplete, using fallback vectors', {
          errorType: response.errorType
        }, 3);
        
        // Create fallback vectors from mission description
        return [
          {
            direction: `Explore unconventional approaches to: ${this.mission.description.substring(0, 100)}`,
            rationale: 'Creative reframing of the core question'
          },
          {
            direction: `Consider alternative perspectives on: ${this.mission.description.substring(0, 100)}`,
            rationale: 'Lateral thinking approach'
          },
          {
            direction: `Imagine surprising implications of: ${this.mission.description.substring(0, 100)}`,
            rationale: 'Speculative exploration'
          }
        ];
      }

      // Try parsing with repair fallback
      const parsed = parseWithFallback(response.content, 'object');
      if (parsed && parsed.vectors && Array.isArray(parsed.vectors)) {
        return parsed.vectors;
      }

      // If no structured JSON, create vectors from response content
      if (response.content && response.content.length > 50) {
        this.logger.warn('No structured vectors, creating from content');
        
        // Split content into sections and create vectors
        const sections = response.content.split('\n\n').filter(s => s.length > 30);
        const vectors = sections.slice(0, 3).map((section, i) => ({
          direction: section.substring(0, 200),
          rationale: `Exploration vector ${i + 1} from creative analysis`
        }));
        
        if (vectors.length > 0) {
          return vectors;
        }
      }

      this.logger.warn('Failed to extract vectors, using fallback', {
        contentLength: response.content?.length,
        hadError: response.hadError
      }, 3);
      
      // Final fallback
      return [
        {
          direction: `Speculative exploration: ${this.mission.description}`,
          rationale: 'Fallback exploration direction'
        }
      ];
    } catch (error) {
      this.logger.error('Vector generation failed, using fallback', { 
        error: error.message
      }, 3);
      
      // Always return at least one vector so agent doesn't fail completely
      return [
        {
          direction: `Creative exploration of: ${this.mission.description}`,
          rationale: 'Fallback due to generation error'
        }
      ];
    }
  }

  /**
   * Explore a specific vector
   */
  async exploreVector(vector) {
    const prompt = `You are conducting creative, speculative exploration.

EXPLORATION DIRECTION: ${vector.direction}
RATIONALE: ${vector.rationale}

ORIGINAL MISSION: ${this.mission.description}

Explore this direction freely and creatively (3-4 paragraphs).

Think:
- What surprising possibilities emerge?
- What unexpected connections appear?
- What if conventional assumptions were wrong?
- What novel applications could exist?

Be imaginative and speculative while maintaining coherence.`;

    try {
      const response = await this.gpt5.generateWithRetry({
        component: 'explorationAgent',
        purpose: 'vectorExploration',
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: `Explore: ${vector.direction}` }],
        maxTokens: 20000, // Creative exploration is core reasoning task
        reasoningEffort: 'high' // Deep creative exploration - exactly what reasoning excels at
      }, 3);

      return response.content;
    } catch (error) {
      this.logger.error('Vector exploration failed', {
        vector: vector.direction,
        error: error.message
      }, 3);
      throw error;
    }
  }

  /**
   * Discover connections across exploration vectors
   */
  async discoverConnections(explorations) {
    const explorationsSummary = explorations
      .map(e => `${e.vector}:\n${e.exploration.substring(0, 300)}...`)
      .join('\n\n');

    const prompt = `You are discovering surprising connections across multiple explorations.

EXPLORATIONS CONDUCTED:
${explorationsSummary}

What unexpected connections, patterns, or themes emerge across these different exploration vectors?

Identify 2-3 novel connections that weren't obvious from any single exploration.

Respond with JSON array:
["Connection 1: Specific connection...", "Connection 2: Another connection...", "Connection 3: Third connection..."]`;

    try {
      const response = await this.gpt5.generateWithRetry({
        component: 'explorationAgent',
        purpose: 'connectionDiscovery',
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Discover cross-vector connections.' }],
        maxTokens: 12000, // Pattern finding needs space
        reasoningEffort: 'medium' // Finding non-obvious connections is analytical synthesis
      }, 3);

      const match = response.content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]).slice(0, 3);
      }
      return [];
    } catch (error) {
      this.logger.error('Connection discovery failed', { error: error.message }, 3);
      return [];
    }
  }

  /**
   * Generate speculative hypotheses
   */
  async generateHypotheses(explorations, connections) {
    const explorationsSummary = explorations
      .map(e => e.vector)
      .join(', ');

    const connectionsSummary = connections.join('\n');

    const prompt = `Based on these explorations, generate 3-4 speculative but testable hypotheses.

EXPLORATION VECTORS: ${explorationsSummary}

DISCOVERED CONNECTIONS:
${connectionsSummary}

Generate hypotheses that:
- Emerge from the explorations
- Are specific and potentially testable
- Represent novel ideas worth investigating
- Could lead to interesting insights if true

Respond with JSON array:
["Hypothesis 1: Specific hypothesis...", "Hypothesis 2: Another hypothesis...", "Hypothesis 3: Third hypothesis..."]`;

    try {
      const response = await this.gpt5.generateWithRetry({
        component: 'explorationAgent',
        purpose: 'hypothesisGeneration',
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Generate speculative hypotheses.' }],
        maxTokens: 2500, // Above gpt-5 minimum of 2048
        reasoningEffort: 'low' // JSON output generation efficient with low reasoning, tokens increased to 4000
      }, 3);

      const match = response.content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]).slice(0, 4);
      }
      return [];
    } catch (error) {
      this.logger.error('Hypothesis generation failed', { error: error.message }, 3);
      return [];
    }
  }

  /**
   * Identify most promising directions for future work
   */
  async identifyPromisingDirections(explorations, connections, hypotheses) {
    const prompt = `Based on this exploration work, identify 2-3 most promising directions for future investigation.

EXPLORATION VECTORS PURSUED: ${explorations.length}
CONNECTIONS DISCOVERED: ${connections.length}
HYPOTHESES GENERATED: ${hypotheses.length}

SAMPLE HYPOTHESES:
${hypotheses.slice(0, 2).join('\n')}

Which specific directions seem most promising and why?

Respond with JSON array:
["Direction 1: Specific direction with rationale...", "Direction 2: Another direction..."]`;

    try {
      const response = await this.gpt5.generateFast({
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Identify promising directions.' }],
        maxTokens: 4000 // Increased from 1000 - exploration questions need creative space
      }, 3);

      const match = response.content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]).slice(0, 3);
      }
      return [];
    } catch (error) {
      this.logger.error('Promising directions identification failed', { error: error.message }, 3);
      return [];
    }
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('🎉 ExplorationAgent completed successfully', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      pathsExplored: this.explorationPaths.length,
      connectionsFound: this.novelConnections.length,
      findingsAdded: this.results.filter(r => r.type === 'finding').length
    }, 3);
  }
}

module.exports = { ExplorationAgent };

