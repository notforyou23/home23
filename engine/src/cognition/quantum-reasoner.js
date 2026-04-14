const { UnifiedClient } = require('../core/unified-client');
const { BranchPolicyController } = require('./branch-policy');
const { LatentProjector } = require('./latent-projector');
const crypto = require('crypto');

/**
 * Quantum Reasoner - GPT-5.2 Version
 * Parallel hypothesis generation with GPT-5.2's extended reasoning
 * Uses Responses API with web_search and reasoning capabilities
 */
class QuantumReasoner {
  constructor(config, logger, fullConfig = null) {
    this.config = config.reasoning;
    this.logger = logger;
    // Use fullConfig if provided, otherwise assume config IS the full config
    this.fullConfig = fullConfig || config;
    this.gpt5 = new UnifiedClient(this.fullConfig, logger);
    this.entanglements = new Map();
    this.branchSequence = 0;
    this.policyEnabled = Boolean(this.config?.features?.branchPolicy?.enabled);
    this.branchPolicyReady = false;
    this.lastPolicyDecision = null;
    this.branchPolicy = null;

    if (this.policyEnabled) {
      this.branchPolicy = new BranchPolicyController(
        { parallelBranches: this.config.parallelBranches },
        this.logger
      );
    }

    this.latentEnabled = Boolean(this.config?.features?.latentProjector?.enabled);
    this.latentProjector = this.latentEnabled
      ? new LatentProjector(this.config.latentProjector || {}, this.logger)
      : null;
    this.lastLatentContext = null;
  }

  /**
   * Generate parallel hypotheses using GPT-5
   * Each branch can use extended reasoning and web search
   */
  async generateSuperposition(prompt, context = {}) {
    if (this.config.mode !== 'quantum') {
      return await this.singleReasoning(prompt, context);
    }

    const latentContext = await this.buildLatentContext(context);
    this.lastLatentContext = latentContext;
    const augmentedContext = { ...context, latentHint: latentContext?.hint || null };

    // Auto-reduce branches for local LLM mode (single GPU can't parallelize effectively)
    const isLocalLLMMode = this.fullConfig?.providers?.local?.enabled === true &&
                           this.fullConfig?.providers?.openai?.enabled !== true;
    const configuredBranches = this.config.parallelBranches || 5;
    const defaultBranchCount = isLocalLLMMode ? Math.min(configuredBranches, 2) : configuredBranches;

    if (isLocalLLMMode && configuredBranches > 2 && context.cycle === 1) {
      this.logger.info('🏠 Local LLM mode: Auto-reduced parallel branches', {
        configured: configuredBranches,
        actual: defaultBranchCount,
        reason: 'Single GPU cannot parallelize effectively'
      });
    }

    const branchPlan = await this.computeBranchPlan({
      cycle: context.cycle ?? null,
      defaultBranchCount,
      allowWebSearch: Boolean(context.allowWebSearch)
    });

    const branches = Math.max(1, branchPlan.branchCount || defaultBranchCount);
    
    // Track actual efforts and web search usage per branch
    const resolvedEfforts = [];
    const resolvedWebSearch = [];

    // Generate multiple parallel hypotheses
    const hypotheses = await Promise.all(
      Array.from({ length: branches }, async (_, i) => {
        const branchPrompt = this.buildBranchPrompt(prompt, augmentedContext, i, branches);
        const branchId = this.buildBranchId(context.cycle, i);
        const promptDigest = this.buildPromptDigest(branchPrompt);
        const promptPreview = branchPrompt.substring(0, 200);
        const branchStart = Date.now();

        try {
          // Use GPT-5.2 with reasoning and optional web search
          const policyEffort = branchPlan.effortAssignments[i];
          const reasoningEffort = policyEffort || this.getBranchReasoningEffort(i, branches);
          const wantsWebSearch = branchPlan.webSearchAssignments[i] === 1;
          const enableWebSearch = context.allowWebSearch && (wantsWebSearch || (branchPlan.source !== 'policy' && i < 2));
          
          // Record actual decisions made for this branch
          resolvedEfforts[i] = reasoningEffort;
          resolvedWebSearch[i] = enableWebSearch ? 1 : 0;
          
          // If the orchestrator passed a cycle tool set, run the branch through
          // a tool-use continuation loop: LLM may emit tool_use blocks, we execute
          // and feed results back, until the LLM produces a final text answer.
          // When tools aren't wired, behaves like the original single-shot call.
          const hasCycleTools = Array.isArray(context.cycleTools) && context.cycleTools.length > 0 && typeof context.cycleToolExecutor === 'function';

          const response = enableWebSearch
            ? await this.gpt5.generateWithWebSearch({
                component: 'quantumReasoner',
                purpose: 'branches',
                model: 'gpt-5-mini',
                instructions: branchPrompt,
                messages: [{ role: 'user', content: 'Produce your output per the system instructions above, including the required action tag (INVESTIGATE/NOTIFY/TRIGGER/NO_ACTION) on its own line if the role specifies one.' }],
                max_completion_tokens: 8000,
                reasoningEffort
              })
            : await this._runBranchWithTools({
                branchPrompt,
                reasoningEffort,
                cycleTools: hasCycleTools ? context.cycleTools : null,
                cycleToolExecutor: hasCycleTools ? context.cycleToolExecutor : null,
                branchIndex: i,
              });

          // Check if we got valid content
          if (!response.content || response.content.length === 0) {
            this.logger?.warn('Branch returned empty content', {
              branchId: i,
              hadError: response.hadError,
              errorType: response.errorType,
              model: response.model
            });
            // Skip this branch if it's truly empty
            if (response.hadError) {
              return null;
            }
          }

          this.logger?.info('Branch generated', {
            branchId: i,
            contentLength: response.content?.length || 0,
            hasReasoning: Boolean(response.reasoning),
            hadError: response.hadError,
            model: response.model
          });

          const completedAt = Date.now();

          resolvedEfforts[i] = reasoningEffort;
          resolvedWebSearch[i] = enableWebSearch ? 1 : 0;

          return {
            branchId,
            branchIndex: i,
            cycle: context.cycle ?? null,
            hypothesis: response.content, // This is the main content
            content: response.content, // Also store as content for compatibility
            reasoning: response.reasoning, // Extended reasoning from GPT-5
            temperature: 0.8 + (i * 0.1),
            weight: 1.0 / branches,
            reasoningEffort,
            usedWebSearch: enableWebSearch,
            model: response.model,
            hadError: response.hadError || false,
            startedAt: new Date(branchStart).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - branchStart,
            promptDigest,
            promptPreview,
            decisionSource: branchPlan.source || 'default',
            latentHint: latentContext?.hint || null,
            latentVectorSize: Array.isArray(latentContext?.vector) ? latentContext.vector.length : null
          };
        } catch (error) {
          this.logger?.error('Branch generation failed', { branchId: i, error: error.message, stack: error.stack });
          return null;
        }
      })
    );

    const validHypotheses = hypotheses.filter(h => h !== null);

    if (validHypotheses.length === 0) {
      this.logger?.error('All branches failed, falling back to single reasoning');
      // Emergency fallback - use single reasoning instead
      const fallback = await this.singleReasoning(prompt, augmentedContext);
      return {
        superposition: [fallback],
        entangled: []
      };
    }

    this.logger?.info('Superposition generated (GPT-5.2)', {
      branches: validHypotheses.length,
      withWebSearch: validHypotheses.filter(h => h.usedWebSearch).length,
      withExtendedReasoning: validHypotheses.filter(h => h.reasoning).length,
      withErrors: validHypotheses.filter(h => h.hadError).length,
      prompt: prompt.substring(0, 100)
    });

    this.lastPolicyDecision = {
      cycle: context.cycle ?? null,
      branchCount: branches,
      effortAssignments: resolvedEfforts,
      webSearchAssignments: resolvedWebSearch,
      source: branchPlan.source || 'default'
    };

    return {
      superposition: validHypotheses,
      entangled: this.checkEntanglements(validHypotheses)
    };
  }

  /**
   * Get reasoning effort for branch
   */
  getBranchReasoningEffort(branchIndex, totalBranches) {
    // Each branch explores novel connections and implications
    // This IS creative problem-solving - reasoning beneficial
    // Medium allows thoughtful exploration without over-reasoning
    return 'medium';
  }

  /**
   * Build branch-specific prompt
   */
  buildBranchPrompt(basePrompt, context, branchIndex, totalBranches) {
    // Check if in pure mode
    const explorationMode = this.fullConfig?.architecture?.roleSystem?.explorationMode || 'autonomous';
    const isPureMode = explorationMode === 'pure';
    
    let perspectives;
    if (isPureMode) {
      // PURE MODE: Minimal or no perspective framing
      perspectives = ['→', '→', '→', '→', '→'];  // Just arrows, or could be ['', '', '', '', '']
    } else {
      // NORMAL MODE: Full perspective instructions
      perspectives = [
        'Be analytical. One clear insight.',
        'Be creative. One novel connection.',
        'Be practical. One actionable idea.',
        'Be critical. One key limitation.',
        'Be synthetic. One unified view.'
      ];
    }

    const perspective = perspectives[branchIndex % perspectives.length];

    // Keep prompt minimal to avoid verbose responses
    // Ground in real cluster data FIRST so the model reasons from actual memory,
    // not from confabulated plausible-sounding text about the owner.
    const clusterPrefix = (context.activeClusterSummary && typeof context.activeClusterSummary === 'string')
      ? `${context.activeClusterSummary.trim().slice(0, 600)}\n\n`
      : '';

    let prompt = isPureMode
      ? `${clusterPrefix}${basePrompt.substring(0, 900)}`
      : `${clusterPrefix}${perspective}\n\n${basePrompt.substring(0, 900)}`;

    // Only add memory if in fork context (forkDepth > 0)
    if (context.forkDepth && context.forkDepth > 0 && context.memory && context.memory.length > 0) {
      const memSnippet = context.memory[0].concept.substring(0, 60);
      prompt += isPureMode ? `\n${memSnippet}` : `\n\nContext: ${memSnippet}`;
    }

    // Add explicit brevity instruction (skip in pure mode)
    if (!isPureMode) {
      prompt += `\n\nBe concise (2-3 sentences max).`;
    }

    if (context.latentHint) {
      prompt += isPureMode ? `\n${context.latentHint}` : `\n\nContext hint: ${context.latentHint}`;
    }

    // NOTE: activeClusterSummary is now injected at the TOP of the prompt (above the role
    // instruction) for maximum grounding effect. No duplicate append here.

    return prompt;
  }

  /**
   * Collapse superposition using GPT-5.2 meta-reasoning
   */
  async collapseSuperposition(superposition, collapseContext = {}) {
    const hypotheses = superposition.superposition;
    
    if (hypotheses.length === 0) {
      throw new Error('Cannot collapse empty superposition');
    }

    if (hypotheses.length === 1) {
      return hypotheses[0];
    }

    const strategy = this.config.collapseStrategy || 'weighted';

    switch (strategy) {
      case 'best':
        return await this.collapseToBestGPT5(hypotheses, collapseContext);
      
      case 'weighted':
        return await this.collapseWeightedGPT5(hypotheses, collapseContext);
      
      case 'voting':
        return await this.collapseByVoting(hypotheses, collapseContext);
      
      default:
        return hypotheses[0];
    }
  }

  /**
   * Collapse by selecting best using GPT-5.2 reasoning
   */
  async collapseToBestGPT5(hypotheses, context) {
    const evaluationPrompt = `Evaluate these ${hypotheses.length} hypotheses and select the SINGLE BEST one based on depth, coherence, and insight.

${hypotheses.map((h, i) => `
Hypothesis ${i + 1}${h.usedWebSearch ? ' [used web search]' : ''}${h.reasoning ? ' [with reasoning]' : ''}:
${h.hypothesis}
${h.reasoning ? `\nReasoning: ${h.reasoning.substring(0, 200)}` : ''}
`).join('\n')}

Respond with ONLY the number (1-${hypotheses.length}) of the best hypothesis.`;

    try {
      const response = await this.gpt5.generateFast({
        model: 'gpt-5-mini',
        instructions: 'You are an expert at evaluating reasoning quality and selecting the best hypothesis.',
        messages: [{ role: 'user', content: evaluationPrompt }],
        max_completion_tokens: 1024, // API minimum for gpt-5-mini (was 50 - too low!)
        reasoningEffort: 'low'
      });

      const selection = parseInt(response.content.trim());
      
      if (selection >= 1 && selection <= hypotheses.length) {
        this.logger?.info('Collapsed to best (GPT-5.2)', { selected: selection });
        return hypotheses[selection - 1];
      }
    } catch (error) {
      this.logger?.error('Collapse to best failed', { error: error.message });
    }

    return hypotheses[0];
  }

  /**
   * Collapse by weighted combination with GPT-5.2 scoring
   */
  async collapseWeightedGPT5(hypotheses, context) {
    // Score each hypothesis using GPT-5
    const scored = await Promise.all(
      hypotheses.map(async (h, i) => {
        const score = await this.scoreHypothesis(h);
        return { ...h, score };
      })
    );

    // Normalize scores to weights
    const totalScore = scored.reduce((sum, h) => sum + h.score, 0);
    const weighted = scored.map(h => ({
      ...h,
      weight: h.score / totalScore
    }));

    // Probabilistic selection based on weights
    const rand = Math.random();
    let cumulative = 0;
    
    for (const h of weighted) {
      cumulative += h.weight;
      if (rand <= cumulative) {
        this.logger?.info('Collapsed weighted (GPT-5.2)', { 
          selected: h.branchId, 
          weight: h.weight.toFixed(3),
          score: h.score.toFixed(2)
        });
        return h;
      }
    }

    return weighted[0];
  }

  /**
   * Score a hypothesis using GPT-5
   */
  async scoreHypothesis(hypothesis) {
    try {
      const response = await this.gpt5.generateFast({
        model: 'gpt-5-mini',
        instructions: 'Rate this hypothesis from 1-10 based on quality, depth, and coherence. Respond with ONLY a number.',
        messages: [{ role: 'user', content: hypothesis.hypothesis.substring(0, 500) }],
        max_completion_tokens: 1024, // API minimum for gpt-5-mini (was 50 - too low!)
        reasoningEffort: 'low'
      });

      const score = parseFloat(response.content.trim());
      return isNaN(score) ? 5 : Math.max(1, Math.min(10, score));
    } catch (error) {
      this.logger?.warn('Scoring failed, using default', { error: error.message });
      return 5; // Default
    }
  }

  /**
   * Collapse by voting (simple fallback)
   */
  async collapseByVoting(hypotheses, context) {
    // Prefer hypotheses with reasoning or web search
    const sorted = [...hypotheses].sort((a, b) => {
      const scoreA = (a.reasoning ? 2 : 0) + (a.usedWebSearch ? 1 : 0);
      const scoreB = (b.reasoning ? 2 : 0) + (b.usedWebSearch ? 1 : 0);
      return scoreB - scoreA;
    });
    
    this.logger?.info('Collapsed by voting', { 
      selected: sorted[0].branchId,
      hasReasoning: Boolean(sorted[0].reasoning),
      usedWebSearch: sorted[0].usedWebSearch
    });
    
    return sorted[0];
  }

  /**
   * Check for entanglements between concepts
   */
  checkEntanglements(hypotheses) {
    const entangled = [];

    for (let i = 0; i < hypotheses.length; i++) {
      for (let j = i + 1; j < hypotheses.length; j++) {
        const overlap = this.findConceptOverlap(
          hypotheses[i].hypothesis,
          hypotheses[j].hypothesis
        );

        if (overlap.length > 0) {
          entangled.push({
            branches: [i, j],
            sharedConcepts: overlap
          });
        }
      }
    }

    return entangled;
  }

  /**
   * Find overlapping concepts
   */
  findConceptOverlap(text1, text2) {
    const words1 = new Set(text1.toLowerCase().match(/\b\w{4,}\b/g) || []);
    const words2 = new Set(text2.toLowerCase().match(/\b\w{4,}\b/g) || []);
    
    const overlap = [];
    for (const word of words1) {
      if (words2.has(word)) {
        overlap.push(word);
      }
    }

    return overlap;
  }

  /**
   * Quantum tunneling with web search
   */
  async quantumTunnel(currentContext, memoryNetwork) {
    const tunnelingProb = this.config.tunnelingProbability || 0.02;
    
    if (Math.random() > tunnelingProb) {
      return null;
    }

    // Use GPT-5.2 with web search to make a creative leap
    try {
      const response = await this.gpt5.generateWithWebSearch({
        instructions: 'Make an unexpected conceptual leap. Find a distant but potentially insightful connection.',
        messages: [{ role: 'user', content: 'Generate a surprising association or metaphor.' }],
        max_completion_tokens: 1500, // Increased from 300 - attention calculation needs space
        reasoningEffort: 'low'
      });

      this.logger?.info('Quantum tunnel occurred (GPT-5.2 + web)', {
        target: response.content.substring(0, 50)
      });

      return {
        type: 'tunnel',
        content: response.content,
        reasoning: response.reasoning,
        timestamp: new Date()
      };
    } catch (error) {
      this.logger?.error('Quantum tunnel failed', { error: error.message });
      return null;
    }
  }

  /**
   * Run a single branch's LLM call, with optional multi-turn tool-use loop.
   *
   * If `cycleTools` and `cycleToolExecutor` are provided, the branch can emit
   * Anthropic-format tool_use blocks. We execute each tool, append a tool_result
   * user message, and re-invoke the LLM until it stops emitting tool calls.
   *
   * When tools aren't wired, this is a single generate() call identical to
   * the prior one-shot behavior.
   *
   * Returns the final response object (same shape as generate()) — with the
   * final text/reasoning that the branch produced after any tool interactions.
   */
  async _runBranchWithTools({ branchPrompt, reasoningEffort, cycleTools, cycleToolExecutor, branchIndex }) {
    const baseOpts = {
      component: 'quantumReasoner',
      purpose: 'branches',
      model: 'gpt-5-mini',
      instructions: branchPrompt,
      max_completion_tokens: 8000,
      reasoningEffort,
    };

    // Conversation state accumulated across tool-use turns
    const messages = [{
      role: 'user',
      content: 'Produce your output per the system instructions above, including the required action tag (INVESTIGATE/NOTIFY/TRIGGER/NO_ACTION) on its own line if the role specifies one. You have tools available — use read_surface / query_brain / get_active_goals / etc. to ground your thought in jtr\'s actual world before producing your final answer.',
    }];

    let response = null;
    let iteration = 0;
    const aggregatedReasoning = [];
    const toolCallLog = [];

    // No hard loop cap per user direction — but guard against runaway with a
    // sanity ceiling. If a branch hits 20 iterations something is broken.
    const SAFETY_CEILING = 20;

    while (iteration < SAFETY_CEILING) {
      iteration++;

      const callOpts = { ...baseOpts, messages };
      if (cycleTools && cycleTools.length > 0) {
        callOpts.tools = cycleTools;
      }

      response = await this.gpt5.generate(callOpts);

      // Accumulate reasoning across turns for the final return
      if (response.reasoning) aggregatedReasoning.push(response.reasoning);

      // No tool calls → we have our final answer
      if (!response.toolCalls || response.toolCalls.length === 0) break;

      // Record tool call log for observability
      for (const tc of response.toolCalls) {
        toolCallLog.push({ iteration, name: tc.name, input: tc.arguments });
      }

      // Preserve the assistant's full content (text + tool_use blocks + thinking)
      // so the conversation history accurately reflects the tool-use turn.
      messages.push({
        role: 'assistant',
        content: response.rawContent && response.rawContent.length > 0
          ? response.rawContent
          : [{ type: 'text', text: response.content || '' }],
      });

      // Execute each tool and build a tool_result user message
      const toolResults = [];
      for (const tc of response.toolCalls) {
        let result;
        try {
          result = await cycleToolExecutor(tc.name, tc.arguments);
        } catch (err) {
          result = { error: err.message };
        }
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        // Cap each tool result to avoid blowing context on huge reads
        const capped = content.length > 4000 ? content.substring(0, 4000) + '\n...[truncated]' : content;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: capped,
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (iteration >= SAFETY_CEILING) {
      this.logger?.warn?.('Branch hit SAFETY_CEILING in tool-use loop', {
        branchIndex, iterations: iteration, toolCalls: toolCallLog.length,
      });
    }

    if (toolCallLog.length > 0) {
      this.logger?.info?.('Branch completed tool-use loop', {
        branchIndex,
        iterations: iteration,
        toolCallsTotal: toolCallLog.length,
        toolsUsed: [...new Set(toolCallLog.map(t => t.name))],
      });
    }

    // Merge aggregated reasoning so the branch's thinking across all tool-use
    // turns is preserved, not just the final turn's.
    if (aggregatedReasoning.length > 0) {
      response.reasoning = aggregatedReasoning.join('\n\n---\n\n');
    }

    return response;
  }

  /**
   * Single reasoning path using GPT-5.2 with extended reasoning
   */
  async singleReasoning(prompt, context = {}) {
    // Check if in pure mode
    const explorationMode = this.fullConfig?.architecture?.roleSystem?.explorationMode || 'autonomous';
    const isPureMode = explorationMode === 'pure';
    
    let instructions;
    let userMessage;
    
    if (isPureMode) {
      // PURE MODE: Minimal prompting for dreams
      instructions = 'You are dreaming.';
      userMessage = prompt || '...';  // Use prompt as continuation cue or just ellipsis
      if (context.latentHint) {
        userMessage = `${userMessage}\n${context.latentHint}`;
      }
    } else {
      // NORMAL MODE: Full dream instructions
      instructions = context.latentHint
        ? `${prompt}\n\nContext hint: ${context.latentHint}`
        : prompt;
      userMessage = 'Generate a creative, surreal, insightful response.';
    }

    const response = await this.gpt5.generate({
      component: 'quantumReasoner',
      purpose: 'singleReasoning',
      model: 'gpt-5.2', // Use GPT-5.2 for deep dream reasoning
      instructions,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 25000, // Deep dream reasoning needs space for rich exploration
      reasoningEffort: 'high', // Deep dream = deep reasoning - this is exactly what high reasoning excels at
      systemPrompt: isPureMode ? 'You are dreaming.' : undefined
    });

    const branchId = this.buildBranchId(context.cycle, 0);
    const completedAt = Date.now();

    return {
      branchId,
      branchIndex: 0,
      cycle: context.cycle ?? null,
      hypothesis: response.content, // Main thought content
      content: response.content, // Also as content
      reasoning: response.reasoning,
      weight: 1.0,
      model: response.model || 'gpt-5.2',
      startedAt: new Date(completedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: 0,
      promptDigest: this.buildPromptDigest(prompt),
      promptPreview: prompt.substring(0, 200),
      decisionSource: 'default',
      latentHint: context.latentHint || null,
      latentVectorSize: Array.isArray(this.lastLatentContext?.vector) ? this.lastLatentContext.vector.length : null
    };
  }

  async computeBranchPlan(context) {
    const {
      cycle = null,
      defaultBranchCount,
      allowWebSearch
    } = context;

    const fallbackCount = Math.max(1, defaultBranchCount || 1);
    const fallbackPlan = {
      source: 'default',
      branchCount: fallbackCount,
      effortAssignments: new Array(fallbackCount).fill('medium'),
      webSearchAssignments: new Array(fallbackCount).fill(0)
    };

    if (!this.policyEnabled || !this.branchPolicy) {
      return fallbackPlan;
    }

    await this.ensureBranchPolicyReady();

    if (!this.branchPolicyReady) {
      return fallbackPlan;
    }

    try {
      const decision = this.branchPolicy.getDecisions({
        cycle,
        defaultBranchCount,
        availableEfforts: ['low', 'medium', 'high'],
        maxWebSearchBranches: allowWebSearch ? 2 : 0
      });

      if (decision && Number.isInteger(decision.branchCount) && decision.branchCount > 0) {
        const branchCount = Math.max(1, Math.min(decision.branchCount, this.config.parallelBranches || defaultBranchCount));

        const effortAssignments = new Array(branchCount).fill('medium');
        if (Array.isArray(decision.effortAssignments)) {
          decision.effortAssignments.slice(0, branchCount).forEach((effort, index) => {
            if (typeof effort === 'string' && effort.length > 0) {
              effortAssignments[index] = effort;
            }
          });
        }

        const webSearchAssignments = new Array(branchCount).fill(0);
        if (Array.isArray(decision.webSearchAssignments)) {
          decision.webSearchAssignments.slice(0, branchCount).forEach((flag, index) => {
            webSearchAssignments[index] = flag ? 1 : 0;
          });
        }

        return {
          source: decision.source || 'policy',
          branchCount,
          effortAssignments,
          webSearchAssignments
        };
      }
    } catch (error) {
      this.logger.warn?.('Branch policy decision failed, falling back to defaults', {
        error: error.message
      });
    }

    return fallbackPlan;
  }

  async ensureBranchPolicyReady() {
    if (!this.policyEnabled || !this.branchPolicy || this.branchPolicyReady) {
      return;
    }

    try {
      await this.branchPolicy.initialize();
      this.branchPolicyReady = true;
    } catch (error) {
      this.logger.warn?.('Failed to initialize branch policy, disabling feature', {
        error: error.message
      });
      this.policyEnabled = false;
      this.branchPolicy = null;
    }
  }

  async recordPolicyOutcome({ reward }) {
    if (!this.policyEnabled || !this.branchPolicyReady || !this.branchPolicy) {
      return;
    }

    if (!this.lastPolicyDecision || !Array.isArray(this.lastPolicyDecision.effortAssignments) || this.lastPolicyDecision.effortAssignments.length === 0) {
      return;
    }

    if (!Array.isArray(this.lastPolicyDecision.webSearchAssignments)) {
      this.lastPolicyDecision.webSearchAssignments = new Array(this.lastPolicyDecision.effortAssignments.length).fill(0);
    }

    try {
      await this.branchPolicy.recordOutcome({
        effortAssignments: this.lastPolicyDecision.effortAssignments,
        webSearchAssignments: this.lastPolicyDecision.webSearchAssignments,
        reward: typeof reward === 'number' ? reward : 0
      });
    } catch (error) {
      this.logger.warn?.('Failed to record branch policy outcome', {
        error: error.message
      });
    }
  }

  async buildLatentContext(context = {}) {
    if (!this.latentEnabled || !this.latentProjector) {
      return null;
    }

    const memoryNodes = Array.isArray(context.memory) ? context.memory : [];
    const goalDescriptions = Array.isArray(context.goals)
      ? context.goals.map(goal => (typeof goal === 'string' ? goal : goal?.description)).filter(Boolean)
      : [];

    try {
      const latent = await this.latentProjector.generateContext(memoryNodes, goalDescriptions);
      return latent;
    } catch (error) {
      this.logger.warn?.('Latent projector failed, continuing without context', {
        error: error.message
      });
      return null;
    }
  }

  getLastLatentContext() {
    return this.lastLatentContext;
  }

  /**
   * Build unique branch identifier for logging/metrics
   */
  buildBranchId(cycle = null, branchIndex = 0) {
    const sequence = this.branchSequence++;
    if (cycle === null || cycle === undefined) {
      return `branch_${Date.now()}_${sequence}`;
    }
    return `branch_${cycle}_${branchIndex}_${sequence}`;
  }

  /**
   * Generate prompt digest for observability without storing full prompt
   */
  buildPromptDigest(prompt) {
    try {
      return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
    } catch (error) {
      this.logger?.debug?.('Prompt digest failed', { error: error.message });
      return null;
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      mode: this.config.mode,
      parallelBranches: this.config.parallelBranches,
      collapseStrategy: this.config.collapseStrategy,
      tunnelingEnabled: this.config.tunnelingProbability > 0,
      usingGPT5: true,
      responsesAPI: true
    };
  }
}

module.exports = { QuantumReasoner };
