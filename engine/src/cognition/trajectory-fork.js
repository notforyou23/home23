const { UnifiedClient } = require('../core/unified-client');
const { validateAndClean } = require('../core/validation');

/**
 * Trajectory Fork System
 * Allows thoughts to spawn sub-trajectories for deep exploration
 * 
 * Architecture:
 * - Main cognitive loop can fork on high-surprise/high-uncertainty thoughts
 * - Forks run as semi-independent exploration threads
 * - Results integrate back into main memory
 * - Forking criteria: surprise > threshold, uncertainty > threshold, or explicit trigger
 * 
 * Fork Lifecycle:
 * 1. Trigger detected (surprise/uncertainty/user)
 * 2. Fork spawned with initial context
 * 3. Fork explores for N cycles or until completion
 * 4. Results consolidated back to main trajectory
 */
class TrajectoryForkSystem {
  constructor(config, subsystems, logger) {
    this.config = config;
    this.logger = logger;
    
    // Subsystems from main orchestrator
    this.memory = subsystems.memory;
    this.quantum = subsystems.quantum;
    this.goals = subsystems.goals;
    
    // Fork management
    this.activeForks = new Map(); // forkId -> Fork
    this.completedForks = [];
    this.nextForkId = 1;
    
    // Configuration
    this.maxConcurrentForks = config.forking?.maxConcurrent || 3;
    this.maxForkDepth = config.forking?.maxDepth || 2; // Prevent infinite recursion
    this.forkCycleLimit = config.forking?.cycleLimit || 5; // Max cycles per fork
    
    // Forking criteria
    this.surpriseThreshold = config.forking?.surpriseThreshold || 0.7;
    this.uncertaintyThreshold = config.forking?.uncertaintyThreshold || 0.8;
    
    this.gpt5 = new UnifiedClient(config, logger);
  }

  /**
   * Check if a thought should trigger a fork
   */
  shouldFork(thought, context) {
    // Don't fork if at max concurrent
    if (this.activeForks.size >= this.maxConcurrentForks) {
      return false;
    }

    // Don't fork if we're already in a deep fork
    const currentDepth = context.forkDepth || 0;
    if (currentDepth >= this.maxForkDepth) {
      return false;
    }

    // Check surprise threshold
    if (context.surprise >= this.surpriseThreshold) {
      this.logger?.info('Fork trigger: high surprise', { 
        surprise: context.surprise.toFixed(2) 
      });
      return true;
    }

    // Check uncertainty in current goal
    if (context.currentGoal?.uncertainty >= this.uncertaintyThreshold) {
      this.logger?.info('Fork trigger: high uncertainty goal', {
        uncertainty: context.currentGoal.uncertainty.toFixed(2)
      });
      return true;
    }

    // Check for explicit forking markers in thought
    if (this.detectForkIntent(thought.hypothesis)) {
      this.logger?.info('Fork trigger: explicit intent detected');
      return true;
    }

    return false;
  }

  /**
   * Detect if thought content suggests forking intent
   */
  detectForkIntent(thoughtText) {
    const forkMarkers = [
      /worth exploring in depth/i,
      /requires deeper investigation/i,
      /multiple avenues to explore/i,
      /branching possibilities/i,
      /parallel investigation/i,
      /deserves its own exploration/i
    ];

    return forkMarkers.some(pattern => pattern.test(thoughtText));
  }

  /**
   * Spawn a new trajectory fork
   */
  async spawnFork(triggerThought, context) {
    const forkId = `fork_${this.nextForkId++}`;
    const forkDepth = (context.forkDepth || 0) + 1;

    // Create fork exploration prompt
    const forkPrompt = await this.generateForkPrompt(triggerThought, context);

    const fork = {
      id: forkId,
      parentThought: triggerThought.hypothesis,
      parentCycle: context.cycleCount,
      depth: forkDepth,
      explorationPrompt: forkPrompt,
      startTime: new Date(),
      status: 'active',
      cyclesCompleted: 0,
      thoughts: [],
      insights: [],
      memoryNodes: []
    };

    this.activeForks.set(forkId, fork);

    this.logger?.info('🔱 Fork spawned', {
      forkId,
      depth: forkDepth,
      trigger: triggerThought.hypothesis.substring(0, 60),
      activeForks: this.activeForks.size
    });

    // Start fork exploration (non-blocking)
    this.exploreFork(fork, context).catch(error => {
      this.logger?.error('Fork exploration failed', { 
        forkId, 
        error: error.message 
      });
      this.completeFork(forkId, 'error');
    });

    return fork;
  }

  /**
   * Generate exploration prompt for fork
   */
  async generateForkPrompt(triggerThought, context) {
    // Skip AI generation - just create a simple, direct prompt
    // This prevents verbose cascades that cause 10k+ char responses
    
    const thoughtSnippet = triggerThought.hypothesis.substring(0, 80);
    
    // Extract key concept (first meaningful phrase)
    const keyPhrase = thoughtSnippet.split(/[,\.\?]/)[0].trim();
    
    // Simple, direct exploration prompt
    return `Explore: ${keyPhrase}`;
  }

  /**
   * Explore a fork trajectory (runs in background)
   */
  async exploreFork(fork, parentContext) {
    this.logger?.info(`🔱 Exploring fork ${fork.id}...`);

    for (let cycle = 0; cycle < this.forkCycleLimit; cycle++) {
      fork.cyclesCompleted = cycle + 1;

      try {
        // Query memory with fork's context
        const memoryContext = await this.memory.query(fork.explorationPrompt, 3);

        // Generate thought for this fork cycle
        const context = {
          memory: memoryContext,
          goals: [],
          cognitiveState: parentContext.cognitiveState,
          forkDepth: fork.depth,
          forkId: fork.id,
          allowWebSearch: cycle === 0 // Web search on first cycle only
        };

        const superposition = await this.quantum.generateSuperposition(
          fork.explorationPrompt,
          context
        );

        const thought = await this.quantum.collapseSuperposition(superposition);

        // Store thought in fork
        fork.thoughts.push({
          cycle,
          hypothesis: thought.hypothesis,
          reasoning: thought.reasoning,
          usedWebSearch: thought.usedWebSearch,
          timestamp: new Date()
        });

        // Add to memory with fork tag (with validation)
        const forkValidation = validateAndClean(`[FORK:${fork.id}] ${thought.hypothesis}`);
        if (forkValidation.valid) {
          const memoryNode = await this.memory.addNode(
            forkValidation.content,
            `fork_${fork.depth}`
          );
          fork.memoryNodes.push(memoryNode.id);
        }

        // Extract insights
        const insight = await this.extractInsight(thought, fork);
        if (insight) {
          fork.insights.push(insight);
        }

        // Check if fork has reached conclusion
        if (this.isForkComplete(fork)) {
          this.logger?.info(`🔱 Fork ${fork.id} reached natural conclusion`);
          break;
        }

        // Update prompt for next cycle
        fork.explorationPrompt = this.evolvePrompt(fork.explorationPrompt, thought);

        // Small delay between fork cycles
        await this.sleep(2000);

      } catch (error) {
        this.logger?.error(`Fork ${fork.id} cycle ${cycle} failed`, { 
          error: error.message 
        });
        break;
      }
    }

    // Complete the fork
    this.completeFork(fork.id, 'completed');
  }

  /**
   * Extract insight from fork thought
   */
  async extractInsight(thought, fork) {
    // Look for conclusive or insightful statements
    const insightMarkers = [
      /therefore/i,
      /this suggests/i,
      /conclusion/i,
      /insight/i,
      /discovered/i,
      /reveals/i
    ];

    const hasInsightMarker = insightMarkers.some(pattern => 
      pattern.test(thought.hypothesis)
    );

    if (hasInsightMarker || thought.reasoning) {
      return {
        content: thought.hypothesis,
        reasoning: thought.reasoning,
        cycle: fork.cyclesCompleted,
        timestamp: new Date()
      };
    }

    return null;
  }

  /**
   * Check if fork exploration is complete
   */
  isForkComplete(fork) {
    // Fork complete if we have conclusive insights
    if (fork.insights.length >= 2) {
      return true;
    }

    // Or if recent thoughts are converging (simple heuristic)
    if (fork.thoughts.length >= 3) {
      const recentThoughts = fork.thoughts.slice(-3).map(t => t.hypothesis);
      const overlap = this.calculateThoughtOverlap(recentThoughts);
      if (overlap > 0.6) {
        return true; // Thoughts converging, likely explored fully
      }
    }

    return false;
  }

  /**
   * Calculate overlap between thoughts (convergence detection)
   */
  calculateThoughtOverlap(thoughts) {
    if (thoughts.length < 2) return 0;

    const wordSets = thoughts.map(t => 
      new Set(t.toLowerCase().match(/\b\w{5,}\b/g) || [])
    );

    let totalOverlap = 0;
    let comparisons = 0;

    for (let i = 0; i < wordSets.length - 1; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const intersection = new Set([...wordSets[i]].filter(w => wordSets[j].has(w)));
        const union = new Set([...wordSets[i], ...wordSets[j]]);
        totalOverlap += intersection.size / union.size;
        comparisons++;
      }
    }

    return comparisons > 0 ? totalOverlap / comparisons : 0;
  }

  /**
   * Evolve exploration prompt based on latest thought
   */
  evolvePrompt(currentPrompt, latestThought) {
    // Extract key concepts from latest thought
    const keyWords = (latestThought.hypothesis.match(/\b\w{6,}\b/g) || [])
      .slice(0, 5)
      .join(', ');

    return `Continue exploring: ${currentPrompt}\n\nBuild on: ${keyWords}`;
  }

  /**
   * Complete a fork and consolidate results
   */
  async completeFork(forkId, status) {
    const fork = this.activeForks.get(forkId);
    if (!fork) return;

    fork.status = status;
    fork.endTime = new Date();
    fork.duration = fork.endTime - fork.startTime;

    // Generate consolidation summary
    if (status === 'completed' && fork.thoughts.length > 0) {
      fork.consolidation = await this.consolidateFork(fork);
      
      // Add consolidated insight to memory (with validation)
      if (fork.consolidation) {
        const consolidationValidation = validateAndClean(`[FORK_RESULT:${fork.id}] ${fork.consolidation}`);
        if (consolidationValidation.valid) {
          await this.memory.addNode(
            consolidationValidation.content,
            'fork_consolidation'
          );
        }
      }
    }

    // Move to completed
    this.completedForks.push(fork);
    this.activeForks.delete(forkId);

    this.logger?.info('🔱 Fork completed', {
      forkId,
      status,
      cycles: fork.cyclesCompleted,
      insights: fork.insights.length,
      thoughts: fork.thoughts.length,
      duration: Math.round(fork.duration / 1000) + 's'
    });
  }

  /**
   * Consolidate fork results into summary insight
   */
  async consolidateFork(fork) {
    try {
      const thoughtsSummary = fork.thoughts
        .map((t, i) => `Cycle ${i + 1}: ${t.hypothesis}`)
        .join('\n\n');

      const response = await this.gpt5.generate({
        model: 'gpt-5-mini',
        instructions: 'Consolidate these exploration thoughts into a single coherent insight or conclusion.',
        messages: [{
          role: 'user',
          content: `Fork exploration "${fork.explorationPrompt}" produced these thoughts:

${thoughtsSummary}

Synthesize into a single consolidated insight (2-3 sentences).`
        }],
        max_completion_tokens: 400,
        reasoningEffort: 'low'
      });

      return response.content;
    } catch (error) {
      this.logger?.error('Fork consolidation failed', { 
        forkId: fork.id, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Get all active forks
   */
  getActiveForks() {
    return Array.from(this.activeForks.values());
  }

  /**
   * Get completed forks
   */
  getCompletedForks(limit = 20) {
    return this.completedForks.slice(-limit);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      activeForks: this.activeForks.size,
      completedForks: this.completedForks.length,
      maxConcurrent: this.maxConcurrentForks,
      totalSpawned: this.nextForkId - 1,
      byDepth: this.getForksByDepth(),
      averageCycles: this.getAverageCycles(),
      averageInsights: this.getAverageInsights()
    };
  }

  getForksByDepth() {
    const depths = {};
    for (const fork of this.completedForks) {
      depths[fork.depth] = (depths[fork.depth] || 0) + 1;
    }
    return depths;
  }

  getAverageCycles() {
    if (this.completedForks.length === 0) return 0;
    const total = this.completedForks.reduce((sum, f) => sum + f.cyclesCompleted, 0);
    return (total / this.completedForks.length).toFixed(1);
  }

  getAverageInsights() {
    if (this.completedForks.length === 0) return 0;
    const total = this.completedForks.reduce((sum, f) => sum + f.insights.length, 0);
    return (total / this.completedForks.length).toFixed(1);
  }

  /**
   * Export for persistence
   */
  export() {
    return {
      activeForks: Array.from(this.activeForks.entries()),
      completedForks: this.completedForks.slice(-50), // Keep last 50
      nextForkId: this.nextForkId,
      stats: this.getStats()
    };
  }

  /**
   * Import from persistence
   */
  import(data) {
    if (data.activeForks) {
      this.activeForks = new Map(data.activeForks);
    }
    if (data.completedForks) {
      this.completedForks = data.completedForks;
    }
    if (data.nextForkId) {
      this.nextForkId = data.nextForkId;
    }

    this.logger?.info('Forks imported', {
      active: this.activeForks.size,
      completed: this.completedForks.length
    });
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TrajectoryForkSystem };
