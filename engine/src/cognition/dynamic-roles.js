const { UnifiedClient } = require('../core/unified-client');

/**
 * Dynamic Role System - GPT-5.2 Version
 * Self-spawning roles with GPT-5.2 extended reasoning and tool access
 */
class DynamicRoleSystem {
  constructor(config, logger, fullConfig = null) {
    this.config = config.roleSystem;
    this.logger = logger;
    // Use fullConfig if provided, otherwise assume config IS the full config
    this.fullConfig = fullConfig || config;
    this.gpt5 = new UnifiedClient(this.fullConfig, logger);
    this.roles = new Map();
    this.performanceHistory = new Map();
    this.nextRoleId = 1;
    
    this.initializeRoles();
  }

  /**
   * Initialize roles from config
   */
  initializeRoles() {
    if (this.config.initialRoles) {
      const explorationMode = this.config.explorationMode || 'autonomous';
      const guidedFocus = this.config.guidedFocus || {};
      
      for (const roleConfig of this.config.initialRoles) {
        // Select appropriate prompt based on exploration mode
        let selectedPrompt = roleConfig.prompt; // default autonomous
        let systemPrompt = null;
        
        if (explorationMode === 'pure' && roleConfig.promptPure !== undefined) {
          // PURE MODE: Use minimal prompting
          selectedPrompt = roleConfig.promptPure;
          systemPrompt = roleConfig.systemPromptPure || 'You are thinking.';
        } else if (explorationMode === 'guided' && roleConfig.promptGuided) {
          // Use guided prompt with domain/context substitution
          selectedPrompt = roleConfig.promptGuided
            .replace('{domain}', guidedFocus.domain || 'the specified domain')
            .replace('{context}', guidedFocus.context || '');
        }
        
        this.roles.set(roleConfig.id, {
          id: roleConfig.id,
          prompt: selectedPrompt,
          systemPrompt: systemPrompt,
          pureMode: explorationMode === 'pure',
          temperature: roleConfig.temperature,
          maxTokens: roleConfig.maxTokens,
          successThreshold: roleConfig.successThreshold,
          created: new Date(),
          successRate: 0.5,
          useCount: 0,
          lastEvolved: new Date(),
          parent: null,
          allowWebSearch: roleConfig.allowWebSearch !== undefined ? roleConfig.allowWebSearch : (roleConfig.id === 'curiosity'),
          reasoningEffort: roleConfig.id === 'analyst' ? 'high' : 'medium',
          enableMCPTools: roleConfig.enableMCPTools || false,
          
          // Context isolation: store base prompt for independent goals
          basePrompt: roleConfig.prompt, // Original, uncontaminated prompt
          guidedPrompt: explorationMode === 'guided' ? selectedPrompt : null
        });
        
        this.performanceHistory.set(roleConfig.id, []);
      }
    }
    
    this.logger?.info('Dynamic roles initialized (GPT-5.2)', {
      count: this.roles.size,
      evolutionEnabled: this.config.evolutionEnabled
    });
  }

  /**
   * Get a role with appropriate context
   * For independent goals, returns role with clean base prompt
   * 
   * @param {string} roleId - Role to get
   * @param {string} executionContext - 'autonomous', 'guided', or 'independent'
   * @returns {Object|null} - Role object or null if not found
   */
  getRole(roleId, executionContext = 'autonomous') {
    const role = this.roles.get(roleId);
    if (!role) return null;
    
    // Independent context: return role with BASE prompt (pre-guided contamination)
    if (executionContext === 'independent') {
      return {
        ...role,
        prompt: role.basePrompt || role.prompt, // Use stored base prompt
        executionContext: 'independent',
        contextNote: 'Using clean cognitive context for independent goal'
      };
    }
    
    // Guided context: return role as-is (may be guided-modified)
    if (executionContext === 'guided') {
      return {
        ...role,
        executionContext: 'guided'
      };
    }
    
    // Autonomous context: return role as-is
    return {
      ...role,
      executionContext: 'autonomous'
    };
  }

  /**
   * Execute a role's thought generation using GPT-5
   */
  async executeRole(roleId, context = {}) {
    const role = this.roles.get(roleId);
    if (!role) {
      throw new Error(`Role not found: ${roleId}`);
    }

    // Build instructions with context
    let instructions = role.prompt;
    
    // In pure mode, minimize instruction text - just add context as continuation
    if (role.pureMode) {
      // Pure mode: Just provide context, minimal instructions
      let contextText = '';
      if (context.memory && context.memory.length > 0) {
        const useMemorySummaries = this.fullConfig?.coordinator?.useMemorySummaries;
        const memoryText = context.memory.map(m => {
          if (useMemorySummaries && m.summary) {
            return m.summary;
          }
          return m.concept;
        }).join('\n');
        contextText += memoryText;
      }
      if (context.goals && context.goals.length > 0) {
        if (contextText) contextText += '\n\n';
        contextText += context.goals.map(g => g.description).join('\n');
      }
      // In pure mode, context goes in system message or as simple continuation
      instructions = contextText ? contextText + '\n\n' + instructions : instructions;
    } else {
      // Normal mode: Build full instructional context
      if (context.memory && context.memory.length > 0) {
        const useMemorySummaries = this.fullConfig?.coordinator?.useMemorySummaries;
        const memoryText = context.memory.map(m => {
          if (useMemorySummaries && m.summary) {
            return m.summary;  // ~50 tokens vs ~400
          }
          return m.concept;  // Fallback to full text
        }).join('\n');
        instructions += `\n\nRelevant context:\n${memoryText}`;
      }
      if (context.goals && context.goals.length > 0) {
        instructions += `\n\nCurrent goals:\n${context.goals.map(g => g.description).join('\n')}`;
      }
      if (context.cognitiveState) {
        const cs = context.cognitiveState;
        instructions += `\n\nCognitive state: curiosity=${(cs.curiosity * 100).toFixed(0)}%, mood=${(cs.mood * 100).toFixed(0)}%, energy=${(cs.energy * 100).toFixed(0)}%`;
      }
      if (context.oscillatorMode) {
        instructions += `\n\nCurrent mode: ${context.oscillatorMode.toUpperCase()}`;
      }
      
      // Inject reality snapshot (recent agent outputs)
      if (context.reality && context.reality.recentOutputs && context.reality.recentOutputs.length > 0) {
        const path = require('path');
        instructions += `\n\nRecent agent outputs:\n`;
        for (const output of context.reality.recentOutputs.slice(0, 3)) {
          instructions += `- [${output.agentType}] ${path.basename(output.filePath)}\n`;
        }
      }
      
      // Inject routing hints (critical issues, reuse opportunities)
      if (context.routing) {
        if (context.routing.critic && context.routing.critic.length > 0) {
          instructions += `\nCritic attention: ${context.routing.critic.map(c => c.file).join(', ')}\n`;
        }
        if (context.routing.reuse && context.routing.reuse.length > 0) {
          instructions += `\nReusable code: ${context.routing.reuse.map(r => r.file).join(', ')}\n`;
        }
      }
    }

    // Build tools array (optional MCP tools + web search)
    const tools = [];
    
    // Add MCP tools if enabled for this role (file reading capability)
    if (role.enableMCPTools) {
      try {
        const mcpTools = this.gpt5.getMCPServersAsTools();
        if (mcpTools && mcpTools.length > 0) {
          tools.push(...mcpTools);
          this.logger?.debug(`Role ${roleId} has MCP tool access`, {
            mcpServers: mcpTools.length
          });
        }
      } catch (error) {
        this.logger?.warn(`Failed to load MCP tools for role ${roleId}`, {
          error: error.message,
          roleId: role.id
        });
        // Continue without MCP tools rather than failing
      }
    }
    
    // Add web search tool if enabled for this role AND globally enabled
    const globalWebSearchEnabled = this.fullConfig?.models?.enableWebSearch === true;
    if (role.allowWebSearch && globalWebSearchEnabled) {
      tools.push({ type: 'web_search' });
    }

    // Use GPT-5.2 with tools (if any)
    const generateOptions = {
      model: 'gpt-5.2',
      instructions,
      messages: [{ role: 'user', content: role.pureMode ? '' : 'Generate your next thought.' }],
      max_completion_tokens: role.maxTokens,
      reasoningEffort: role.reasoningEffort,
      tools: tools.length > 0 ? tools : undefined,
      // Pure mode: Add system prompt for minimal framing
      systemPrompt: role.systemPrompt || undefined
      // NOTE: GPT-5.2 doesn't support temperature parameter
    };
    
    let response;
    try {
      response = await this.gpt5.generate(generateOptions);
    } catch (error) {
      this.logger?.error(`Role execution failed for ${roleId}`, {
        error: error.message,
        roleId: role.id,
        hadTools: tools.length > 0
      });
      
      // Retry without tools if tool usage caused the error
      if (tools.length > 0 && error.message?.includes('tool')) {
        this.logger?.warn(`Retrying role ${roleId} without tools`);
        try {
          response = await this.gpt5.generate({
            ...generateOptions,
            tools: undefined
          });
        } catch (retryError) {
          // If retry also fails, throw the original error
          throw error;
        }
      } else {
        throw error;
      }
    }

    role.useCount++;

    this.logger?.debug('Role executed (GPT-5.2)', {
      roleId: role.id,
      outputLength: response.content.length,
      hasReasoning: Boolean(response.reasoning),
      usedWebSearch: role.allowWebSearch,
      useCount: role.useCount
    });

    return {
      roleId: role.id,
      output: response.content,
      reasoning: response.reasoning,
      model: response.model,
      timestamp: new Date()
    };
  }

  /**
   * Record performance
   */
  recordPerformance(roleId, success, metrics = {}) {
    const history = this.performanceHistory.get(roleId);
    if (!history) return;

    history.push({
      success,
      metrics,
      timestamp: new Date()
    });

    if (history.length > 20) {
      history.shift();
    }

    const role = this.roles.get(roleId);
    if (role) {
      const recentSuccesses = history.filter(h => h.success).length;
      role.successRate = recentSuccesses / history.length;
    }
  }

  /**
   * Spawn a new role
   */
  spawnRole(purpose, baseRoleId = null) {
    if (this.roles.size >= this.config.maxRoles) {
      this.logger?.warn('Cannot spawn role: max roles reached');
      return null;
    }

    const baseRole = baseRoleId ? this.roles.get(baseRoleId) : null;
    
    const newRole = {
      id: `role_${this.nextRoleId++}`,
      prompt: baseRole 
        ? `${baseRole.prompt}\n\nAdditional focus: ${purpose}` 
        : `Specialized role for: ${purpose}`,
      temperature: baseRole ? baseRole.temperature : 0.9,
      max_completion_tokens: baseRole ? baseRole.maxTokens : 400,
      successThreshold: 0.6,
      created: new Date(),
      successRate: 0.5,
      useCount: 0,
      lastEvolved: new Date(),
      parent: baseRoleId,
      purpose,
      allowWebSearch: false,
      reasoningEffort: 'medium'
    };

    this.roles.set(newRole.id, newRole);
    this.performanceHistory.set(newRole.id, []);

    this.logger?.info('New role spawned (GPT-5.2)', {
      id: newRole.id,
      purpose,
      totalRoles: this.roles.size
    });

    return newRole.id;
  }

  /**
   * Evolve a role using GPT-5.2 meta-reasoning
   */
  async evolveRole(roleId) {
    if (!this.config.evolutionEnabled) return;

    const role = this.roles.get(roleId);
    if (!role) return;

    const history = this.performanceHistory.get(roleId);
    if (!history || history.length < 5) return;

    const timeSinceEvolution = Date.now() - role.lastEvolved.getTime();
    if (timeSinceEvolution < 3600000) return;

    if (role.successRate < role.successThreshold) {
      // Use GPT-5.2 with extended reasoning to improve the prompt
      const response = await this.gpt5.generateWithReasoning({
        model: 'gpt-5.2',
        instructions: `The following AI role has been underperforming (success rate: ${(role.successRate * 100).toFixed(1)}%).

Current prompt: "${role.prompt}"

Suggest an improved version that makes the role more effective while maintaining its core function.

Provide only the improved prompt text, no explanation.`,
        messages: [{ role: 'user', content: 'Improve this prompt.' }],
        max_completion_tokens: 15000, // Meta-cognition deserves deep thought about prompt effectiveness
        reasoningEffort: 'high' // Improving system's own prompts is complex meta-cognitive work
      });

      role.prompt = response.content.trim();
      role.lastEvolved = new Date();

      this.logger?.info('Role evolved (GPT-5.2)', {
        roleId: role.id,
        oldSuccessRate: role.successRate,
        hasReasoning: Boolean(response.reasoning)
      });
    }
  }

  /**
   * Prune underperforming roles
   */
  pruneRoles() {
    const rolesToPrune = [];

    for (const [roleId, role] of this.roles) {
      if (this.config.initialRoles?.some(r => r.id === roleId)) continue;
      if (role.useCount < 10) continue;

      if (role.successRate < this.config.pruneThreshold) {
        rolesToPrune.push(roleId);
      }
    }

    for (const roleId of rolesToPrune) {
      this.roles.delete(roleId);
      this.performanceHistory.delete(roleId);
      
      this.logger?.info('Role pruned', { roleId, totalRoles: this.roles.size });
    }

    return rolesToPrune.length;
  }

  getRoles() {
    return Array.from(this.roles.values());
  }

  getStats() {
    const roles = Array.from(this.roles.values());
    
    return {
      totalRoles: roles.length,
      averageSuccessRate: roles.reduce((sum, r) => sum + r.successRate, 0) / roles.length || 0,
      totalExecutions: roles.reduce((sum, r) => sum + r.useCount, 0),
      spawnedRoles: roles.filter(r => r.parent !== null).length,
      initialRoles: roles.filter(r => r.parent === null).length,
      withWebSearch: roles.filter(r => r.allowWebSearch).length,
      usingGPT5: true
    };
  }
}

module.exports = { DynamicRoleSystem };
