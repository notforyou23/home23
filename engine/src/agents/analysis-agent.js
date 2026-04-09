const { BaseAgent } = require('./base-agent');
const { parseWithFallback } = require('../core/json-repair');

/**
 * AnalysisAgent - Deep analysis and novel idea exploration specialist
 * 
 * Purpose:
 * - Performs deep analysis on specific concepts or hypotheses
 * - Explores novel ideas through systematic reasoning
 * - Identifies implications, connections, and consequences
 * - Tests ideas against different frameworks and perspectives
 * 
 * Use Cases:
 * - Deep dive into breakthrough insights from Phase 2B
 * - Systematic exploration of novel hypotheses
 * - Multi-perspective analysis of complex topics
 * - Identifying hidden implications and connections
 */
class AnalysisAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.analysisFrameworks = [
      // Foundational analysis
      'first_principles',
      'systems_thinking',
      'causal_mechanisms',
      'implications_and_consequences',
      'cross_domain_connections',
      
      // Human-centered
      'psychological_perspective',
      'historical_analysis',
      'practical_applications',
      
      // Critical thinking
      'failure_modes',
      'ethical_implications',
      'resource_constraints',
      'edge_cases',
      'contrarian_view'
    ];
    this.perspectives = [];
  }

  /**
   * Main execution logic - GENERIC, memory-driven
   */
  async execute() {
    this.logger.info('🧠 AnalysisAgent: Starting deep analysis mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    }, 3);

    await this.reportProgress(5, 'Querying memory for relevant knowledge');

    // STEP 1: Query memory based on mission (semantic search)
    const relevantKnowledge = await this.memory.query(this.mission.description, 30);
    
    this.logger.info('📚 Memory query complete', {
      nodesFound: relevantKnowledge.length,
      hasCodeData: relevantKnowledge.some(n => n.tags?.includes('source_code_file'))
    });

    // NEW: Explore knowledge domain to understand context
    if (relevantKnowledge.length > 0) {
      const domain = await this.getKnowledgeDomain(this.mission.description);
      this.logger.info('🌐 Knowledge domain analysis', {
        clusterId: domain.clusterId,
        domainSize: domain.size,
        relatedConcepts: domain.nodes.slice(0, 5).map(n => n.concept?.substring(0, 40))
      });
    }

    // NEW: Check clusters to understand knowledge landscape
    const clusters = await this.getKnowledgeClusters();
    this.logger.info('🗺️  Knowledge landscape', {
      totalClusters: clusters.size,
      largestCluster: Math.max(...Array.from(clusters.values()).map(nodes => nodes.length), 0)
    });

    // STEP 2: Adapt analysis approach based on available data
    const codeDataAvailable = relevantKnowledge.some(node =>
      node.tags?.includes('source_code_file') ||
      node.tags?.includes('source_code_analysis')
    );

    if (codeDataAvailable) {
      this.logger.info('💻 Code data found in memory → will include code analysis');
      return await this.analyzeWithCodeContext(relevantKnowledge);
    }

    await this.reportProgress(10, 'Framing analysis approach');

    // NEW: Get strategic context from coordinator
    const strategicContext = await this.getStrategicContext();
    if (strategicContext && strategicContext.priorities) {
      this.logger.info('🎯 Strategic context retrieved', {
        hasPriorities: true,
        hasRecommendations: !!strategicContext.recommendations
      });
    }

    // NEW: Check for related analysis work
    const relatedWork = await this.checkExistingKnowledge(this.mission.description, 2);
    if (relatedWork && relatedWork.hasKnowledge) {
      this.logger.info('📚 Found related analysis in memory', {
        relevantNodes: relatedWork.relevantNodes,
        willBuildOn: true
      });
      
      await this.addInsight(
        `Building on ${relatedWork.relevantNodes} existing memory nodes. ` +
        `Analysis will extend and deepen current understanding.`
      );
    }

    // NEW: Check if research agents have relevant findings
    const agentActivity = await this.checkAgentActivity();
    if (agentActivity && agentActivity.recentTypes.includes('research')) {
      this.logger.info('🔬 Recent research agent activity detected - may have fresh findings');
    }

    // Step 1: Frame the analysis problem
    const framework = await this.frameAnalysisProblem();
    
    await this.reportProgress(25, 'Analysis framework established');

    // Step 2: Multi-perspective analysis
    const perspectives = [];
    const frameworksToUse = this.selectAnalysisFrameworks(framework);
    
    for (let i = 0; i < frameworksToUse.length; i++) {
      const fw = frameworksToUse[i];
      
      this.logger.info('🔬 Analyzing from perspective', {
        agentId: this.agentId,
        framework: fw,
        perspectiveNum: i + 1,
        total: frameworksToUse.length
      }, 3);

      try {
        const perspective = await this.analyzePerspective(fw, framework);
        perspectives.push({ framework: fw, analysis: perspective });
        this.perspectives.push(perspective);
        
        await this.reportProgress(
          25 + (i + 1) * (45 / frameworksToUse.length),
          `Analyzed from ${fw} perspective`
        );
      } catch (error) {
        this.logger.warn('Perspective analysis failed, continuing', {
          framework: fw,
          error: error.message
        }, 3);
      }
    }

    if (perspectives.length === 0) {
      throw new Error('All perspective analyses failed');
    }

    // Step 3: Synthesize cross-perspective insights
    await this.reportProgress(75, 'Synthesizing cross-perspective insights');
    const synthesis = await this.synthesizePerspectives(perspectives);

    // Step 4: Identify novel implications
    await this.reportProgress(85, 'Identifying novel implications');
    const implications = await this.identifyImplications(synthesis);

    // Step 5: Add insights to memory
    await this.reportProgress(95, 'Adding insights to memory');
    
    // Add main synthesis as finding
    await this.addFinding(synthesis.summary, 'analysis');
    
    // Add key insights (using addInsight for proper categorization)
    for (const insight of synthesis.keyInsights) {
      await this.addInsight(insight, 'analysis_insight');
    }
    
    // Add novel implications as insights (they're interpretations, not raw findings)
    for (const implication of implications) {
      await this.addInsight(implication, 'novel_implication');
    }

    // Store final results
    this.results.push({
      type: 'deep_analysis',
      content: synthesis.summary,
      perspectivesAnalyzed: perspectives.length,
      keyInsights: synthesis.keyInsights,
      novelImplications: implications,
      timestamp: new Date()
    }, 3);

    await this.reportProgress(100, 'Deep analysis complete');

    this.logger.info('✅ AnalysisAgent: Mission complete', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      perspectivesAnalyzed: perspectives.length,
      keyInsights: synthesis.keyInsights.length,
      novelImplications: implications.length
    }, 3);

    return {
      success: true,
      perspectivesAnalyzed: perspectives.length,
      insightsGenerated: synthesis.keyInsights.length,
      implicationsIdentified: implications.length,
      metadata: {
        perspectivesAnalyzed: perspectives.length,
        insightsGenerated: synthesis.keyInsights.length,
        status: 'complete'
      }
    };
  }

  /**
   * Frame the analysis problem and determine approach
   */
  async frameAnalysisProblem() {
    const prompt = `You are framing a deep analysis problem.

MISSION: ${this.mission.description}

SUCCESS CRITERIA:
${this.mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Your task:
1. Identify the core question or concept to analyze
2. Determine what aspects are most important to explore
3. Identify what kind of analysis would be most valuable

Respond in JSON format:
{
  "coreQuestion": "The central question or concept...",
  "keyAspects": ["aspect 1", "aspect 2", "aspect 3"],
  "analysisApproach": "What type of analysis is most appropriate..."
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: 'gpt-5-mini', // Use mini for framing
        instructions: prompt,
        messages: [{ role: 'user', content: 'Frame the analysis problem.' }],
        maxTokens: 1200, // Above gpt-5-mini minimum of 1024
        reasoningEffort: 'low' // Simple framing task
      }, 3);

      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }

      return {
        coreQuestion: this.mission.description,
        keyAspects: this.mission.successCriteria,
        analysisApproach: 'Systematic multi-perspective analysis'
      };
    } catch (error) {
      this.logger.error('Framework generation failed', { error: error.message }, 3);
      return {
        coreQuestion: this.mission.description,
        keyAspects: this.mission.successCriteria,
        analysisApproach: 'Systematic multi-perspective analysis'
      };
    }
  }

  /**
   * Select which analysis frameworks to use (3 random frameworks for diversity)
   */
  selectAnalysisFrameworks(framework) {
    // Randomly select 3 frameworks to ensure variety
    const shuffled = [...this.analysisFrameworks].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  }

  /**
   * Analyze from a specific perspective/framework
   */
  async analyzePerspective(frameworkName, overallFramework) {
    const frameworkDescriptions = {
      // Existing foundational
      first_principles: 'Break down to fundamental truths and rebuild understanding from the ground up',
      systems_thinking: 'Analyze as a system with components, feedback loops, and emergent properties',
      causal_mechanisms: 'Identify underlying causal mechanisms and how they produce observed effects',
      implications_and_consequences: 'Explore logical implications and potential consequences',
      cross_domain_connections: 'Find analogies and connections to other domains and fields',
      
      // NEW - Human-centered
      psychological_perspective: 'Examine through the lens of human psychology, behavior, cognition, motivation, and decision-making',
      historical_analysis: 'Study how this concept or phenomenon developed over time, what preceded it, key turning points, and evolutionary trajectory',
      practical_applications: 'Focus on concrete real-world applications, specific use cases, implementation details, and actionable steps',
      
      // NEW - Critical analysis
      failure_modes: 'Systematically identify what could go wrong, common failure patterns, risk scenarios, and vulnerability points',
      ethical_implications: 'Analyze moral considerations, societal impact, fairness, justice, and ethical trade-offs',
      resource_constraints: 'Consider practical limitations including cost, time, energy, materials, skills, and scalability',
      edge_cases: 'Explore unusual scenarios, boundary conditions, exceptional situations, and limit cases',
      contrarian_view: 'Challenge mainstream assumptions, explore alternative perspectives, and question conventional wisdom'
    };

    const prompt = `You are conducting deep analysis from a specific perspective.

CORE QUESTION: ${overallFramework.coreQuestion}

KEY ASPECTS TO EXPLORE:
${overallFramework.keyAspects.join('\n')}

ANALYSIS FRAMEWORK: ${frameworkName}
${frameworkDescriptions[frameworkName]}

Conduct a thorough analysis (3-4 paragraphs) exploring this question through this specific lens.

Focus on:
- Novel insights not obvious at surface level
- Connections and patterns
- Surprising implications
- Deep understanding

Be specific and substantive. Avoid generic observations.`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: 'gpt-5.2', // Use GPT-5.2 for deep analysis
        instructions: prompt,
        messages: [{ role: 'user', content: `Analyze from ${frameworkName} perspective.` }],
        maxTokens: 20000, // Deep analysis needs space for non-obvious insights
        reasoningEffort: 'high' // Deep analytical work - exactly what reasoning models excel at
      }, 3);

      return response.content;
    } catch (error) {
      this.logger.error('Perspective analysis failed', {
        framework: frameworkName,
        error: error.message
      }, 3);
      throw error;
    }
  }

  /**
   * Synthesize insights across multiple perspectives
   */
  async synthesizePerspectives(perspectives) {
    const perspectivesSummary = perspectives
      .map(p => `${p.framework.toUpperCase()} PERSPECTIVE:\n${p.analysis}`)
      .join('\n\n---\n\n');

    const prompt = `You are synthesizing insights from multiple analytical perspectives.

ORIGINAL QUESTION: ${this.mission.description}

ANALYSES CONDUCTED:
${perspectivesSummary}

Your task:
1. Synthesize the most important cross-cutting insights
2. Identify patterns that emerge across multiple perspectives
3. Highlight the most novel or surprising findings
4. Create an integrated understanding

Respond in JSON format:
{
  "summary": "Integrated synthesis across all perspectives (3-4 paragraphs)...",
  "keyInsights": [
    "Insight 1: A specific, substantive insight...",
    "Insight 2: Another specific insight...",
    "Insight 3: A third specific insight..."
  ],
  "mostNovel": "The single most novel or surprising finding..."
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: 'gpt-5.2', // Use GPT-5.2 for synthesis
        instructions: prompt,
        messages: [{ role: 'user', content: 'Synthesize cross-perspective insights.' }],
        maxTokens: 25000, // Cross-perspective synthesis is complex cognitive work
        reasoningEffort: 'high' // Synthesizing multiple analytical perspectives requires deep reasoning
      }, 3);

      // Try parsing with repair fallback
      const parsed = parseWithFallback(response.content, 'object');
      if (parsed && parsed.summary) {
        return {
          summary: parsed.summary || response.content,
          keyInsights: parsed.keyInsights || [response.content],
          mostNovel: parsed.mostNovel || 'See synthesis for novel findings'
        };
      }

      // Fallback if no structured response
      return {
        summary: response.content,
        keyInsights: [response.content],
        mostNovel: 'See synthesis for novel findings'
      };
    } catch (error) {
      this.logger.error('Synthesis failed', { error: error.message }, 3);
      return {
        summary: perspectives.map(p => p.analysis).join('\n\n'),
        keyInsights: perspectives.map(p => `${p.framework}: ${p.analysis.substring(0, 200)}`),
        mostNovel: 'Multiple perspectives analyzed'
      };
    }
  }

  /**
   * Identify novel implications and consequences
   */
  async identifyImplications(synthesis) {
    const prompt = `Based on this deep analysis, identify 3-4 novel implications or consequences.

SYNTHESIS:
${synthesis.summary}

KEY INSIGHTS:
${synthesis.keyInsights.join('\n')}

MOST NOVEL FINDING:
${synthesis.mostNovel}

What are the non-obvious implications? What follows from these insights?

Focus on:
- Implications that aren't immediately apparent
- Actionable consequences
- Connections to other areas
- Questions worth exploring further

Respond with JSON array:
["Implication 1: Specific implication...", "Implication 2: Another implication...", "Implication 3: Third implication..."]`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: 'gpt-5.2', // Use GPT-5.2 for novel implications
        instructions: prompt,
        messages: [{ role: 'user', content: 'Identify novel implications.' }],
        maxTokens: 15000, // Finding non-obvious implications needs reasoning space
        reasoningEffort: 'medium' // Implications require reasoning about downstream consequences
      }, 3);

      const match = response.content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]).slice(0, 4);
      }
      return [];
    } catch (error) {
      this.logger.error('Implications identification failed', { error: error.message }, 3);
      return [];
    }
  }

  /**
   * Analyze with code context from memory (GENERIC method)
   * Adapts to whatever code data is available
   */
  async analyzeWithCodeContext(relevantKnowledge) {
    this.logger.info('💻 Starting analysis with code context from memory');
    await this.reportProgress(10, 'Processing code data from memory');
    
    // Get code files/analysis from memory
    const codeFiles = await this.queryMemoryForData(['code', 'source'], ['source_code_file'], 30);
    
    if (codeFiles.length === 0) {
      this.logger.info('No detailed code files in memory - will use contextual knowledge');
      // Graceful fallback - use whatever relevant knowledge we have
      return await this.performStandardAnalysis(relevantKnowledge);
    }
    
    this.logger.info(`Found ${codeFiles.length} code files in memory`);
    await this.reportProgress(20, 'Analyzing code with multi-perspective approach');
    
    // Use GPT-5.2 to analyze code with deep reasoning
    const analysisPrompt = `You are conducting deep analysis of code from memory.

MISSION: ${this.mission.description}

CODE FILES AVAILABLE (${codeFiles.length} files):
${codeFiles.slice(0, 5).map((f, i) => `
FILE ${i + 1}: ${f.data.file}
  Lines: ${f.data.size?.lines || 'unknown'}
  Functions: ${(f.data.functions?.async || 0) + (f.data.functions?.sync || 0)}
  
CODE PREVIEW:
${f.data.codePreview ? f.data.codePreview.split('\n').slice(0, 50).join('\n') : 'No preview'}
`).join('\n---\n')}

... (${codeFiles.length} files total)

YOUR TASK - Deep analysis addressing the mission:

Analyze the code to address the mission goals. Consider:

1. **Mission Alignment**: How well does the code address mission objectives?
2. **Patterns & Architecture**: What patterns emerge across files?
3. **Quality Indicators**: Error handling, documentation, structure
4. **Key Insights**: Non-obvious findings about the implementation
5. **Specific Observations**: Reference actual files and code patterns

REQUIREMENTS:
- Address the mission description directly
- Reference specific files when possible
- Provide substantive insights (not generic advice)
- Identify patterns across the codebase
- Be constructive and specific

Generate 5-10 key findings/insights that address the mission.`;

    try {
      await this.reportProgress(40, 'Performing deep analysis');
      
      const response = await this.gpt5.generateWithRetry({
        model: 'gpt-5.2',
        instructions: analysisPrompt,
        messages: [{ role: 'user', content: 'Analyze code and generate insights' }],
        maxTokens: 16000, // API maximum output limit
        reasoningEffort: 'high'
      }, 3);
      
      await this.reportProgress(70, 'Extracting insights');
      
      // Extract insights from analysis
      const insights = this.extractInsightsFromAnalysis(response.content);
      
      this.logger.info(`Extracted ${insights.length} insights from code analysis`);
      
      // Store insights in memory
      for (const insight of insights) {
        await this.addInsight(insight, 'code_analysis_insight');
      }
      
      // Store summary finding
      await this.addFinding(
        `Analyzed ${codeFiles.length} code files from memory. Generated ${insights.length} insights.`,
        'analysis'
      );
      
      await this.reportProgress(100, 'Analysis complete');
      
      return {
        success: true,
        filesAnalyzed: codeFiles.length,
        insightsGenerated: insights.length,
        usedMemoryNetwork: true
      };
      
    } catch (error) {
      this.logger.error('Code analysis failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Perform standard multi-perspective analysis (fallback when no code data)
   */
  async performStandardAnalysis(relevantKnowledge) {
    this.logger.info('📊 Performing standard analysis with available knowledge');
    
    // Continue with normal analysis flow (from original execute method)
    await this.reportProgress(10, 'Framing analysis approach');

    // Step 1: Frame the analysis problem
    const framework = await this.frameAnalysisProblem();
    
    await this.reportProgress(25, 'Analysis framework established');

    // Step 2: Multi-perspective analysis
    const perspectives = [];
    const frameworksToUse = this.selectAnalysisFrameworks(framework);
    
    for (let i = 0; i < frameworksToUse.length; i++) {
      const fw = frameworksToUse[i];
      
      try {
        const perspective = await this.analyzePerspective(fw, framework);
        perspectives.push({ framework: fw, analysis: perspective });
        this.perspectives.push(perspective);
        
        await this.reportProgress(
          25 + (i + 1) * (45 / frameworksToUse.length),
          `Analyzed from ${fw} perspective`
        );
      } catch (error) {
        this.logger.warn('Perspective analysis failed, continuing', {
          framework: fw,
          error: error.message
        });
      }
    }

    // Step 3: Synthesize cross-perspective insights
    await this.reportProgress(75, 'Synthesizing cross-perspective insights');
    const synthesis = await this.synthesizePerspectives(perspectives);

    // Step 4: Identify novel implications
    await this.reportProgress(85, 'Identifying novel implications');
    const implications = await this.identifyImplications(synthesis);

    // Step 5: Add insights to memory
    await this.reportProgress(95, 'Adding insights to memory');
    
    await this.addFinding(synthesis.summary, 'analysis');
    
    for (const insight of synthesis.keyInsights) {
      await this.addInsight(insight, 'analysis_insight');
    }
    
    for (const implication of implications) {
      await this.addInsight(implication, 'novel_implication');
    }

    await this.reportProgress(100, 'Analysis complete');

    return {
      success: true,
      perspectivesAnalyzed: perspectives.length,
      insightsGenerated: synthesis.keyInsights.length,
      implicationsIdentified: implications.length
    };
  }
  
  /**
   * Extract insights from analysis text (GENERIC extraction)
   */
  extractInsightsFromAnalysis(analysisText) {
    const insights = [];
    const lines = analysisText.split('\n');
    
    for (const line of lines) {
      // Match numbered lists, bullet points, or dashes
      const match = line.match(/^(?:\d+\.|[-•*])\s+(.+)$/);
      if (match) {
        const insight = match[1].trim();
        // Filter out very short or header-like lines
        if (insight.length > 40 && !insight.match(/^(Finding|Insight|Observation|Key)/i)) {
          insights.push(insight);
        }
      }
    }
    
    // If no structured insights found, try paragraphs
    if (insights.length === 0) {
      const paragraphs = analysisText.split('\n\n').filter(p => p.length > 60);
      insights.push(...paragraphs.slice(0, 10).map(p => p.trim()));
    }
    
    return insights.slice(0, 10);  // Top 10 insights
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('🎉 AnalysisAgent completed successfully', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      perspectivesAnalyzed: this.perspectives.length,
      findingsAdded: this.results.filter(r => r.type === 'finding').length
    }, 3);
  }
}

module.exports = { AnalysisAgent };

