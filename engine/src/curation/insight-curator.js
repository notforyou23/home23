const { UnifiedClient } = require('../core/unified-client');
const { parseWithFallback } = require('../core/json-repair');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const path = require('path');

// `response.content || response` falls through to the whole response object
// whenever .content is an empty string (JS-falsy), which then blows up any
// downstream .match/.trim/.includes call with "X is not a function". This
// coerces safely: prefer .content, then .output_text, else a raw string
// response, else empty — never an object.
function extractResponseText(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response.content === 'string') return response.content;
  if (response && typeof response.output_text === 'string') return response.output_text;
  return '';
}

/**
 * InsightCurator
 * 
 * Automated curation layer that extracts high-value insights from COSMO's output.
 * 
 * Does what a human consultant would do:
 * 1. Reviews all agent findings, coordinator reviews, and high-quality thoughts
 * 2. Scores each insight on: actionability, specificity, novelty, business value
 * 3. Identifies the 10-20 most valuable insights
 * 4. Organizes them by type: technical, strategic, operational, market intelligence
 * 5. Generates executive summary with business implications
 * 
 * Output: "Gold Nuggets Report" ready for consultant review
 */
class InsightCurator {
  constructor(config, logger, logsDir) {
    this.config = config;
    this.logger = logger;
    this.logsDir = logsDir || path.join(__dirname, '..', '..', 'runtime');
    this.gpt5 = new UnifiedClient(config, logger);
    
    // Curation parameters
    this.minActionabilityScore = 6; // 0-10 scale
    this.minBusinessValueScore = 6;
    this.topNInsights = 20; // Extract top 20 for consultant review
    
    // Safe configuration access with defaults (handles missing config from loaded state)
    this.curationMode = this.getCurationMode();
    this.curationEnabled = this.getCurationEnabled();
    
    // Log configuration status for debugging
    if (this.logger && this.logger.info) {
      this.logger.info('InsightCurator initialized', {
        mode: this.curationMode,
        enabled: this.curationEnabled,
        hasConfig: !!this.config?.coordinator?.insightCuration
      });
    }
  }
  
  /**
   * Get curation mode with safe fallback (handles missing config from state reload)
   */
  getCurationMode() {
    try {
      return this.config?.coordinator?.insightCuration?.mode || 'goal-aligned';
    } catch (error) {
      return 'goal-aligned';
    }
  }
  
  /**
   * Get curation enabled status with safe fallback
   */
  getCurationEnabled() {
    try {
      return this.config?.coordinator?.insightCuration?.enabled !== false;
    } catch (error) {
      return true; // Default to enabled
    }
  }
  
  /**
   * Check if business context is enabled (safe access)
   */
  isBusinessContextEnabled() {
    try {
      return this.config?.coordinator?.insightCuration?.businessContext?.enabled === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Main curation workflow - extract gold from COSMO run
   * @param {Object} systemContext - System context (goals, directives, etc.) OR legacy options
   * @param {Object} options - Curation options (optional)
   * @returns {Object} Curated insights report
   */
  async curateRun(systemContext = {}, options = {}) {
    const startTime = new Date();
    this.logger.info('🔍 Starting insight curation...');

    // Backward compatibility: if systemContext looks like options (no activeGoals/directives), treat as legacy call
    if (!systemContext.activeGoals && !systemContext.strategicDirectives && !systemContext.cycleCount) {
      // Legacy call: curateRun(options)
      options = systemContext;
      systemContext = {};
    }

    // Store system context for use throughout curation
    this.systemContext = systemContext;

    // Step 1: Collect all potential insights
    this.logger.info('📥 Step 1: Collecting insights from all sources...');
    const rawInsights = await this.collectAllInsights();
    this.logger.info(`   Collected ${rawInsights.length} raw insights`);

    // Step 2: Score each insight on multiple dimensions
    this.logger.info('⚖️  Step 2: Scoring insights on actionability, specificity, value...');
    const scoredInsights = await this.scoreInsights(rawInsights);
    this.logger.info(`   Scored ${scoredInsights.length} insights`);

    // Step 3: Filter and rank
    this.logger.info('🏆 Step 3: Filtering and ranking...');
    const topInsights = this.filterAndRank(scoredInsights);
    this.logger.info(`   Top ${topInsights.length} insights identified`);

    // Step 4: Categorize by type
    this.logger.info('📊 Step 4: Categorizing insights...');
    const categorized = await this.categorizeInsights(topInsights);
    
    // Step 5: Generate executive summary (mode-aware)
    this.logger.info('📝 Step 5: Generating executive summary...');
    const executiveSummary = await this.generateExecutiveSummary(categorized, systemContext);

    // Step 6: Analyze strategic value (replaces business implications)
    this.logger.info(`💎 Step 6: Analyzing strategic value (mode: ${this.curationMode})...`);
    const strategicValue = await this.analyzeStrategicValue(categorized, systemContext);

    const duration = (new Date() - startTime) / 1000;
    this.logger.info(`✅ Curation complete in ${duration.toFixed(1)}s`);

    return {
      summary: executiveSummary,
      topInsights: categorized,
      strategicValue: strategicValue,
      mode: this.curationMode,
      metadata: {
        totalRawInsights: rawInsights.length,
        topInsightsCount: topInsights.length,
        curationDuration: duration,
        timestamp: new Date(),
        curationMode: this.curationMode
      }
    };
  }

  /**
   * Collect insights from all sources
   */
  async collectAllInsights() {
    const insights = [];

    // Source 1: Agent findings (highest priority - these are from specialist work)
    const agentFindings = await this.extractAgentFindings();
    insights.push(...agentFindings.map(f => ({
      ...f,
      source: 'agent_finding',
      priority: 10
    })));

    // Source 2: Coordinator strategic insights
    const coordinatorInsights = await this.extractCoordinatorInsights();
    insights.push(...coordinatorInsights.map(i => ({
      ...i,
      source: 'coordinator_review',
      priority: 9
    })));

    // Source 3: High-surprise thoughts with reasoning
    const highValueThoughts = await this.extractHighValueThoughts();
    insights.push(...highValueThoughts.map(t => ({
      ...t,
      source: 'core_cognition',
      priority: 7
    })));

    return insights;
  }

  /**
   * Extract findings from agent results in coordinator reviews
   */
  async extractAgentFindings() {
    const findings = [];

    try {
      const coordinatorDir = path.join(this.logsDir, 'coordinator');
      const files = await fs.readdir(coordinatorDir);
      const reviewFiles = files.filter(f => f.startsWith('review_') && f.endsWith('.md'));

      for (const file of reviewFiles) {
        const content = await fs.readFile(path.join(coordinatorDir, file), 'utf-8');
        
        // Extract cycle number
        const cycleMatch = file.match(/review_(\d+)/);
        const cycle = cycleMatch ? parseInt(cycleMatch[1]) : 0;

        // Parse agent sections
        const agentSections = content.split(/#### Agent \d+:/);
        
        for (const section of agentSections.slice(1)) {  // Skip header
          // Extract agent type
          const typeMatch = section.match(/^.*?\n.*?Goal.*?\n.*?Status.*?\n.*?Results.*?\n\n\*\*Sample (Insights|Findings):\*\*/s);
          
          // Extract sample insights
          const insightMatches = section.matchAll(/^\d+\.\s+(.+?)(?=\n\d+\.|$|\n\n)/gms);
          
          for (const match of insightMatches) {
            const text = match[1].trim();
            if (text.length > 50 && !text.startsWith('#') && !text.startsWith('{')) {
              findings.push({
                content: text,
                cycle: cycle,
                agentType: 'unknown', // Will be categorized later
                length: text.length
              });
            }
          }
        }
      }
    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Failed to extract agent findings', { error: error.message });
      }
    }

    return findings;
  }

  /**
   * Extract strategic insights from coordinator reviews
   */
  async extractCoordinatorInsights() {
    const insights = [];

    try {
      const coordinatorDir = path.join(this.logsDir, 'coordinator');
      const files = await fs.readdir(coordinatorDir);
      const reviewFiles = files.filter(f => f.startsWith('review_') && f.endsWith('.md'));

      for (const file of reviewFiles.slice(-3)) {  // Last 3 reviews only
        const content = await fs.readFile(path.join(coordinatorDir, file), 'utf-8');
        
        const cycleMatch = file.match(/review_(\d+)/);
        const cycle = cycleMatch ? parseInt(cycleMatch[1]) : 0;

        // Extract standout insights section
        const standoutMatch = content.match(/5\) Standout Insights\n([\s\S]+?)(?=\n---|\n##|$)/);
        if (standoutMatch) {
          const standoutText = standoutMatch[1];
          const insightLines = standoutText.split('\n').filter(l => l.trim().startsWith('-'));
          
          for (const line of insightLines) {
            const cleanLine = line.replace(/^-\s*\d+:\s*/, '').trim();
            if (cleanLine.length > 50) {
              insights.push({
                content: cleanLine,
                cycle: cycle,
                type: 'strategic',
                length: cleanLine.length
              });
            }
          }
        }

        // Extract gaps/blind spots (these identify opportunities)
        const gapsMatch = content.match(/4\) Gaps & Blind Spots\n([\s\S]+?)(?=\n5\)|$)/);
        if (gapsMatch) {
          const gapsText = gapsMatch[1];
          const gapLines = gapsText.split('\n').filter(l => l.trim().startsWith('-'));
          
          for (const line of gapLines) {
            const cleanLine = line.replace(/^-\s*/, '').trim();
            if (cleanLine.length > 30) {
              insights.push({
                content: `[GAP] ${cleanLine}`,
                cycle: cycle,
                type: 'opportunity',
                length: cleanLine.length
              });
            }
          }
        }
      }
    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Failed to extract coordinator insights', { error: error.message });
      }
    }

    return insights;
  }

  /**
   * Extract high-value thoughts from thought log
   */
  async extractHighValueThoughts() {
    const thoughts = [];

    try {
      const thoughtsFile = path.join(this.logsDir, 'thoughts.jsonl');
      const fileStream = createReadStream(thoughtsFile);
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        
        try {
          const thought = JSON.parse(line);
          
          // Filter for high-quality thoughts
          if (thought.surprise > 0.3 || // High surprise
              thought.usedWebSearch ||  // Used research
              thought.reasoning) {       // Has reasoning trace
            
            thoughts.push({
              content: thought.thought,
              cycle: thought.cycle,
              role: thought.role,
              surprise: thought.surprise || 0,
              hasReasoning: !!thought.reasoning,
              usedResearch: !!thought.usedWebSearch,
              length: thought.thought.length
            });
          }
        } catch (parseError) {
          // Skip malformed lines
        }
      }
    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Failed to extract thoughts', { error: error.message });
      }
    }

    return thoughts;
  }

  /**
   * Score insights on multiple dimensions using GPT-5
   * 
   * Dimensions:
   * - Actionability: Can this be implemented/tested? (0-10)
   * - Specificity: Concrete details vs vague generalities? (0-10)
   * - Novelty: Non-obvious vs common knowledge? (0-10)
   * - BusinessValue: Direct business impact potential? (0-10)
   */
  async scoreInsights(insights, options = {}) {
    const scored = [];
    
    // Score in batches to reduce API calls
    // Increased from 10 to 20 for faster processing (fewer API calls)
    const batchSize = options.batchSize || 20;
    const parallelBatches = options.parallel || 3; // Process 3 batches in parallel
    
    // Split insights into batches
    const batches = [];
    for (let i = 0; i < insights.length; i += batchSize) {
      batches.push({
        insights: insights.slice(i, i + batchSize),
        index: Math.floor(i / batchSize)
      });
    }
    
    const totalBatches = batches.length;
    
    // Process batches in parallel groups
    for (let i = 0; i < batches.length; i += parallelBatches) {
      const batchGroup = batches.slice(i, i + parallelBatches);
      
      if (this.logger && this.logger.info) {
        this.logger.info(`   Scoring batches ${i + 1}-${Math.min(i + parallelBatches, totalBatches)}/${totalBatches}`);
      }
      
      // Process this group in parallel
      const promises = batchGroup.map(async ({ insights: batch, index }) => {
        const scoringPrompt = `You are evaluating research insights for business value. Score each on 4 dimensions (0-10):

1. ACTIONABILITY: Can this be implemented, tested, or directly applied? (10 = specific action, 0 = pure theory)
2. SPECIFICITY: Concrete details and metrics vs vague generalities? (10 = specific numbers/methods, 0 = abstract)
3. NOVELTY: Non-obvious insight vs common knowledge? (10 = surprising to experts, 0 = obvious)
4. BUSINESS_VALUE: Direct business impact potential? (10 = clear ROI, 0 = academic only)

For each insight, provide scores as JSON array.

Insights to score:
${batch.map((ins, idx) => `\n${idx + 1}. ${ins.content.substring(0, 300)}`).join('\n')}

Return ONLY a JSON array: [{"index": 1, "actionability": X, "specificity": X, "novelty": X, "businessValue": X}, ...]`;

        try {
          const response = await this.gpt5.generate({
            model: this.config.models?.curatorModel || 'gpt-5-mini',
            input: scoringPrompt,
            maxTokens: 6000, // Increased from 2000 - novelty evaluation needs thorough analysis
            reasoningEffort: 'low'
          });

          // Parse scores from response content
          let scores = [];
          try {
            const content = extractResponseText(response);
            const jsonMatch = content.match(/\[[\s\S]+\]/);
            if (jsonMatch) {
              scores = JSON.parse(jsonMatch[0]);
            }
          } catch (parseError) {
            if (this.logger && this.logger.warn) {
              this.logger.warn('Failed to parse scores', { error: parseError.message });
            }
            return batch.map(ins => ({
              ...ins,
              scores: { actionability: 5, specificity: 5, novelty: 5, businessValue: 5 },
              totalScore: 20
            }));
          }

          // Apply scores to batch
          return batch.map((insight, j) => {
            const score = scores[j] || {};
            return {
              ...insight,
              scores: {
                actionability: score.actionability || 5,
                specificity: score.specificity || 5,
                novelty: score.novelty || 5,
                businessValue: score.businessValue || 5
              },
              totalScore: (score.actionability || 5) + (score.specificity || 5) + 
                         (score.novelty || 5) + (score.businessValue || 5)
            };
          });

        } catch (error) {
          if (this.logger && this.logger.error) {
            this.logger.error('Scoring batch failed', { error: error.message });
          }
          // Return batch with default scores
          return batch.map(ins => ({
            ...ins,
            scores: { actionability: 5, specificity: 5, novelty: 5, businessValue: 5 },
            totalScore: 20
          }));
        }
      });
      
      // Wait for all batches in this group to complete
      const results = await Promise.all(promises);
      
      // Flatten and add to scored array
      results.forEach(batchResults => {
        scored.push(...batchResults);
      });
    }

    return scored;
  }

  /**
   * Filter and rank insights with deduplication
   */
  filterAndRank(scoredInsights) {
    // Filter for high-value insights
    const filtered = scoredInsights.filter(ins => {
      // More lenient filtering to ensure we get results
      return ins.scores.actionability >= 5 ||
             ins.scores.businessValue >= 5 ||
             ins.scores.novelty >= 6 ||
             ins.totalScore >= 22; // At least above average on multiple dimensions
    });

    // Sort by total score
    filtered.sort((a, b) => b.totalScore - a.totalScore);

    // Deduplicate similar insights (compare first 100 chars)
    const deduplicated = [];
    const seen = new Set();
    
    for (const insight of filtered) {
      const fingerprint = insight.content.substring(0, 100).toLowerCase().trim();
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        deduplicated.push(insight);
      }
    }

    if (this.logger && this.logger.info && filtered.length !== deduplicated.length) {
      this.logger.info(`   Removed ${filtered.length - deduplicated.length} duplicate insights`);
    }

    // Return top N unique insights
    return deduplicated.slice(0, this.topNInsights);
  }

  /**
   * Categorize insights by type using GPT-5
   */
  async categorizeInsights(insights) {
    const categorizationPrompt = `You are categorizing research insights for a business report.

Categories:
- TECHNICAL: Specific technical details, algorithms, constraints, implementation specifics
- STRATEGIC: Market dynamics, competitive landscape, timelines, business strategy
- OPERATIONAL: Implementation approaches, architectures, workflows, processes
- MARKET_INTELLIGENCE: Vendor gaps, opportunities, risks, market analysis
- CROSS_DOMAIN: Connections between different fields, interdisciplinary insights

Insights to categorize:
${insights.map((ins, idx) => `\n${idx + 1}. ${ins.content.substring(0, 200)}`).join('\n')}

For each insight, provide:
1. Category (one of the 5 above)
2. A brief, specific title (5-10 words max)

Return as JSON array: [{"index": 1, "category": "TECHNICAL", "title": "Brief specific title"}, ...]`;

    try {
      const response = await this.gpt5.generate({
        model: this.config.models?.curatorModel || 'gpt-5-mini', // Use mini for faster categorization
        input: categorizationPrompt,
        maxTokens: 6000, // Increased from 2000 - novelty evaluation needs thorough analysis
        reasoningEffort: 'low',
        verbosity: 'low'
      });

      let categories = [];
      const content = extractResponseText(response);
      const jsonMatch = content.match(/\[[\s\S]+?\]/);
      if (jsonMatch) {
        try {
          categories = JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          if (this.logger && this.logger.warn) {
            this.logger.warn('Failed to parse categories JSON', { error: parseError.message });
          }
        }
      }

      // Apply categories
      const categorized = {
        technical: [],
        strategic: [],
        operational: [],
        marketIntelligence: [],
        crossDomain: []
      };

      insights.forEach((ins, idx) => {
        const cat = categories.find(c => c.index === idx + 1);
        const category = cat ? cat.category.toLowerCase().replace('_', '').replace('-', '') : 'technical';
        const title = cat ? cat.title : 'Untitled';

        const enriched = {
          ...ins,
          category: category,
          title: title
        };

        if (category.includes('technical')) categorized.technical.push(enriched);
        else if (category.includes('strategic')) categorized.strategic.push(enriched);
        else if (category.includes('operational')) categorized.operational.push(enriched);
        else if (category.includes('market')) categorized.marketIntelligence.push(enriched);
        else if (category.includes('cross')) categorized.crossDomain.push(enriched);
        else categorized.technical.push(enriched); // Default
      });

      return categorized;

    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error('Categorization failed', { error: error.message });
      }
      // Return uncategorized - put all in technical
      return {
        technical: insights.map(ins => ({
          ...ins,
          category: 'technical',
          title: ins.content.substring(0, 50) + '...'
        })),
        strategic: [],
        operational: [],
        marketIntelligence: [],
        crossDomain: []
      };
    }
  }

  /**
   * Generate executive summary of curated insights (mode-aware)
   */
  async generateExecutiveSummary(categorizedInsights, systemContext = {}) {
    const allInsights = [
      ...categorizedInsights.technical,
      ...categorizedInsights.strategic,
      ...categorizedInsights.operational,
      ...categorizedInsights.marketIntelligence,
      ...categorizedInsights.crossDomain
    ];

    // Use cached safe mode value
    const mode = this.curationMode;
    
    // Handle missing or invalid systemContext gracefully
    if (!systemContext || typeof systemContext !== 'object') {
      systemContext = {};
    }
    
    // Build context about active goals
    const goalsContext = systemContext.activeGoals && Array.isArray(systemContext.activeGoals) && systemContext.activeGoals.length > 0 
      ? `\n\nACTIVE SYSTEM GOALS:\n${systemContext.activeGoals.slice(0, 5).map((g, i) => 
          `${i + 1}. ${g.description || g.id || 'Unknown goal'} (priority: ${((g.priority || 0) * 100).toFixed(0)}%)`
        ).join('\n')}`
      : '';
    
    const directivesContext = systemContext.strategicDirectives && Array.isArray(systemContext.strategicDirectives) && systemContext.strategicDirectives.length > 0
      ? `\n\nSTRATEGIC DIRECTIVES:\n${systemContext.strategicDirectives.slice(0, 3).map((d, i) => `${i + 1}. ${typeof d === 'string' ? d : JSON.stringify(d)}`).join('\n')}`
      : '';

    // Mode-specific prompt
    let summaryPrompt = '';
    
    if (mode === 'goal-aligned') {
      summaryPrompt = `You are analyzing research insights to create an executive summary focused on goal advancement.${goalsContext}${directivesContext}

Technical Insights (${categorizedInsights.technical.length}):
${categorizedInsights.technical.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Strategic Insights (${categorizedInsights.strategic.length}):
${categorizedInsights.strategic.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Operational Insights (${categorizedInsights.operational.length}):
${categorizedInsights.operational.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Market Intelligence (${categorizedInsights.marketIntelligence.length}):
${categorizedInsights.marketIntelligence.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Write a concise 2-paragraph executive summary (under 300 words) that:
1. Highlights how these insights advance the active system goals
2. Identifies alignment with strategic directives
3. Recommends next steps for goal progression
4. Notes knowledge gaps that need addressing

Focus on goal advancement and strategic alignment.`;
    } else if (mode === 'research') {
      summaryPrompt = `You are analyzing research insights to create an executive summary for scientific research.

Technical Insights (${categorizedInsights.technical.length}):
${categorizedInsights.technical.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Strategic Insights (${categorizedInsights.strategic.length}):
${categorizedInsights.strategic.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Operational Insights (${categorizedInsights.operational.length}):
${categorizedInsights.operational.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Write a concise 2-paragraph executive summary (under 300 words) that:
1. Highlights key scientific findings and their significance
2. Identifies novel discoveries and research directions
3. Recommends next research steps
4. Notes important open questions

Focus on research value and scientific advancement.`;
    } else {
      // Business mode (backward compatibility)
      summaryPrompt = `You are analyzing research insights to create an executive summary for business stakeholders.

Technical Insights (${categorizedInsights.technical.length}):
${categorizedInsights.technical.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Strategic Insights (${categorizedInsights.strategic.length}):
${categorizedInsights.strategic.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Operational Insights (${categorizedInsights.operational.length}):
${categorizedInsights.operational.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Market Intelligence (${categorizedInsights.marketIntelligence.length}):
${categorizedInsights.marketIntelligence.slice(0, 5).map(i => `• ${i.content.substring(0, 150)}`).join('\n')}

Write a concise 2-paragraph executive summary (under 300 words) that:
1. Highlights the key findings and their business implications
2. Identifies the most actionable recommendations
3. Outlines strategic priorities

Focus on business value and actionable insights.`;
    }

    try {
      const response = await this.gpt5.generate({
        model: this.config.models?.curatorStrategic || 'gpt-5.2',
        input: summaryPrompt,
        maxTokens: 16000, // API maximum output limit (128K input + 16K output)
        reasoningEffort: 'high', // Executive synthesis for business decisions deserves deep reasoning
        verbosity: 'medium' // Ensure we get substantial text output
      });

      const content = extractResponseText(response);
      
      if (!content || content.trim().length < 50) {
        throw new Error('Insufficient summary content generated');
      }
      
      return content.trim();
    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Executive summary generation failed, trying fallback', { error: error.message });
      }
      
      // Fallback: Try with gpt-5-mini and low reasoning
      try {
        const fallbackResponse = await this.gpt5.generate({
          model: this.config.models?.curatorModel || 'gpt-5-mini',
          input: summaryPrompt,
          maxTokens: 15000, // Still need buffer for mini's reasoning tokens
          reasoningEffort: 'low',
          verbosity: 'medium'
        });
        
        const fallbackContent = fallbackResponse.content || fallbackResponse.output_text || fallbackResponse;
        if (fallbackContent && fallbackContent.trim().length >= 50) {
          return fallbackContent.trim();
        }
      } catch (fallbackError) {
        if (this.logger && this.logger.error) {
          this.logger.error('Fallback summary generation also failed', { error: fallbackError.message });
        }
      }
      
      // Last resort: Generate simple summary from top insights
      const topInsights = allInsights.slice(0, 3);
      return `This research identified ${allInsights.length} high-value insights across technical, strategic, and operational domains. Key findings include: ${topInsights.map(i => i.title || i.content.substring(0, 100)).join('; ')}. These insights present significant opportunities for business value and strategic advantage.`;
    }
  }

  /**
   * Analyze strategic value (mode-aware - replaces analyzeBusinessValue)
   */
  async analyzeStrategicValue(categorizedInsights, systemContext = {}) {
    // Use cached safe mode value
    const mode = this.curationMode;
    const businessEnabled = this.isBusinessContextEnabled();
    
    // Route to appropriate analysis method based on mode
    if (mode === 'business' && businessEnabled) {
      return this.analyzeBusinessOpportunities(categorizedInsights);
    } else if (mode === 'research') {
      return this.analyzeResearchDirections(categorizedInsights, systemContext);
    } else {
      // Default: goal-aligned mode
      return this.analyzeGoalAlignment(categorizedInsights, systemContext);
    }
  }

  /**
   * Analyze how insights align with and advance system goals
   */
  async analyzeGoalAlignment(categorizedInsights, systemContext = {}) {
    const allInsights = [
      ...categorizedInsights.technical,
      ...categorizedInsights.strategic,
      ...categorizedInsights.operational,
      ...categorizedInsights.marketIntelligence,
      ...categorizedInsights.crossDomain
    ];

    // Handle missing or invalid systemContext gracefully
    if (!systemContext || typeof systemContext !== 'object') {
      systemContext = {};
    }

    // Build context about active goals and directives
    const goalsContext = systemContext.activeGoals && Array.isArray(systemContext.activeGoals) && systemContext.activeGoals.length > 0
      ? `\n\nACTIVE SYSTEM GOALS:\n${systemContext.activeGoals.slice(0, 8).map((g, i) => 
          `${i + 1}. [${g.id || 'unknown'}] ${g.description || 'No description'} (priority: ${((g.priority || 0) * 100).toFixed(0)}%, progress: ${((g.progress || 0) * 100).toFixed(0)}%)`
        ).join('\n')}`
      : '\n\nACTIVE SYSTEM GOALS: None currently prioritized';

    const directivesContext = systemContext.strategicDirectives && Array.isArray(systemContext.strategicDirectives) && systemContext.strategicDirectives.length > 0
      ? `\n\nSTRATEGIC DIRECTIVES:\n${systemContext.strategicDirectives.map((d, i) => `${i + 1}. ${typeof d === 'string' ? d : JSON.stringify(d)}`).join('\n')}`
      : '\n\nSTRATEGIC DIRECTIVES: None currently defined';

    const analysisPrompt = `You are analyzing research insights for goal alignment and strategic value.${goalsContext}${directivesContext}

Research Insights:
${allInsights.slice(0, 10).map((ins, idx) => `\n${idx + 1}. ${ins.content.substring(0, 200)}`).join('\n')}

For the top 5-8 most valuable insights, analyze their strategic value:
1. Which insight (by number)
2. Which goal(s) does this insight advance? (use goal IDs if available)
3. How does it advance that goal? (specific contribution)
4. What's the next step to capitalize on this insight?
5. Priority level (high/medium/low) based on goal alignment

Return your analysis as a JSON array with this exact structure:
[{"insight": 1, "relatedGoals": ["goal_123"], "contribution": "How it advances the goal", "nextStep": "Specific action", "priority": "high"}, ...]

Focus on goal advancement and actionable next steps.`;

    try {
      const response = await this.gpt5.generate({
        model: this.config.models?.curatorStrategic || 'gpt-5.2',
        input: analysisPrompt,
        maxTokens: 16000, // API maximum output limit
        reasoningEffort: 'high',
        verbosity: 'medium'
      });

      let goalAlignments = [];
      const content = extractResponseText(response);
      
      // Use robust JSON parser from json-repair.js
      goalAlignments = parseWithFallback(content, 'array');
      
      if (!goalAlignments) {
        // Fallback failed - try manual extraction
        const jsonMatch = content.match(/\[[\s\S]+\]/);
        if (jsonMatch) {
          try {
            // Try to extract individual objects if array parsing failed
            const objectMatches = jsonMatch[0].match(/\{[^{}]*\}/g);
            if (objectMatches && objectMatches.length > 0) {
              goalAlignments = objectMatches.map(obj => {
                try {
                  return JSON.parse(obj);
                } catch {
                  return null;
                }
              }).filter(obj => obj !== null);
            }
          } catch (extractError) {
            if (this.logger && this.logger.warn) {
              this.logger.warn('Failed to parse goal alignment JSON', { error: extractError.message });
            }
            goalAlignments = [];
          }
        } else {
          goalAlignments = [];
        }
      }

      // Validate and return
      if (goalAlignments.length > 0) {
        return goalAlignments;
      }

      throw new Error('No goal alignment data extracted');

    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Goal alignment analysis failed, trying fallback', { error: error.message });
      }
      
      // Fallback: Use gpt-5-mini
      try {
        const fallbackResponse = await this.gpt5.generate({
          model: this.config.models?.curatorModel || 'gpt-5-mini',
          input: analysisPrompt,
          maxTokens: 20000,
          reasoningEffort: 'low',
          verbosity: 'medium'
        });

        const fallbackContent = fallbackResponse.content || fallbackResponse.output_text || fallbackResponse;
        const jsonMatch = fallbackContent.match(/\[[\s\S]+\]/);
        if (jsonMatch) {
          let jsonText = jsonMatch[0];
          // Clean up common GPT JSON errors - multiple passes
          jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas
          jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1'); // Second pass for nested
          jsonText = jsonText.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":'); // Fix unquoted keys
          jsonText = jsonText.replace(/\n/g, ' '); // Remove newlines
          jsonText = jsonText.replace(/\s{2,}/g, ' '); // Collapse whitespace
          jsonText = jsonText.replace(/"([^"]*)"([^"]*)"([^"]*)":/g, '"$1$2$3":'); // Multi-word keys
          
          try {
            const parsed = JSON.parse(jsonText);
            if (parsed.length > 0) {
              return parsed;
            }
          } catch (parseError) {
            // Last resort: extract objects one by one
            try {
              const objectMatches = jsonText.match(/\{[^{}]*\}/g);
              if (objectMatches && objectMatches.length > 0) {
                const parsed = objectMatches.map(obj => {
                  try {
                    return JSON.parse(obj);
                  } catch {
                    return null;
                  }
                }).filter(obj => obj !== null);
                
                if (parsed.length > 0) {
                  return parsed;
                }
              }
            } catch {
              // Give up
            }
          }
        }
      } catch (fallbackError) {
        if (this.logger && this.logger.error) {
          this.logger.error('Fallback goal alignment analysis also failed', { error: fallbackError.message });
        }
      }

      // Last resort: Generate basic goal alignments
      return allInsights.slice(0, 3).map((ins, idx) => ({
        insight: idx + 1,
        relatedGoals: ['general'],
        contribution: ins.title || ins.content.substring(0, 100),
        nextStep: 'Review insight and determine specific application',
        priority: 'medium'
      }));
    }
  }

  /**
   * Analyze research directions (for research mode)
   */
  async analyzeResearchDirections(categorizedInsights, systemContext = {}) {
    const allInsights = [
      ...categorizedInsights.technical,
      ...categorizedInsights.strategic,
      ...categorizedInsights.operational,
      ...categorizedInsights.marketIntelligence,
      ...categorizedInsights.crossDomain
    ];

    const analysisPrompt = `You are a research director analyzing insights for next research directions.

Research Insights:
${allInsights.slice(0, 10).map((ins, idx) => `\n${idx + 1}. ${ins.content.substring(0, 200)}`).join('\n')}

For the top 5-8 most scientifically valuable insights, identify research directions:
1. Which insight (by number)
2. Research question it raises
3. Methodology to explore further
4. Expected scientific impact
5. Priority level (high/medium/low)

Return as JSON array:
[{"insight": 1, "researchQuestion": "...", "methodology": "...", "impact": "...", "priority": "high"}, ...]`;

    try {
      const response = await this.gpt5.generate({
        model: this.config.models?.curatorStrategic || 'gpt-5.2',
        input: analysisPrompt,
        maxTokens: 16000, // API maximum output limit
        reasoningEffort: 'high',
        verbosity: 'medium'
      });

      const content = extractResponseText(response);
      const jsonMatch = content.match(/\[[\s\S]+?\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Research directions analysis failed', { error: error.message });
      }
    }

    // Fallback
    return allInsights.slice(0, 3).map((ins, idx) => ({
      insight: idx + 1,
      researchQuestion: ins.title || ins.content.substring(0, 100),
      methodology: 'Further investigation required',
      impact: 'To be determined',
      priority: 'medium'
    }));
  }

  /**
   * Analyze business opportunities (backward compatibility)
   */
  async analyzeBusinessOpportunities(categorizedInsights) {
    const allInsights = [
      ...categorizedInsights.technical,
      ...categorizedInsights.strategic,
      ...categorizedInsights.operational,
      ...categorizedInsights.marketIntelligence,
      ...categorizedInsights.crossDomain
    ];

    const analysisPrompt = `You are a business consultant analyzing research insights for commercial opportunities.

Research Insights:
${allInsights.slice(0, 10).map((ins, idx) => `\n${idx + 1}. ${ins.content.substring(0, 200)}`).join('\n')}

For the top 5-8 most commercially valuable insights, identify potential consulting services or projects:
1. Specific consulting service or project name
2. Estimated project value ($50K, $500K, $1M, $5M+)
3. Target client type who would pay for this
4. Timeline to delivery

Return your analysis as a JSON array:
[{"insight": 1, "service": "Service name", "value": "$500K", "client": "Client type", "timeline": "3-6 months"}, ...]`;

    try {
      const response = await this.gpt5.generate({
        model: this.config.models?.curatorStrategic || 'gpt-5.2',
        input: analysisPrompt,
        maxTokens: 16000, // API maximum output limit
        reasoningEffort: 'high',
        verbosity: 'medium'
      });

      const content = extractResponseText(response);
      const jsonMatch = content.match(/\[[\s\S]+?\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      if (this.logger && this.logger.warn) {
        this.logger.warn('Business opportunities analysis failed', { error: error.message });
      }
    }

    // Fallback
    return allInsights.slice(0, 3).map((ins, idx) => ({
      insight: idx + 1,
      service: `Consulting on: ${ins.title || 'Advanced research application'}`,
      value: '$250K-500K',
      client: 'Enterprise organizations',
      timeline: '3-6 months'
    }));
  }

  /**
   * Generate formatted report (mode-aware)
   */
  async generateReport(curationResults, outputPath, systemContext = {}) {
    // Use mode from results, or fall back to cached safe value
    const mode = curationResults.mode || this.curationMode;
    
    // Handle missing or invalid systemContext gracefully
    if (!systemContext || typeof systemContext !== 'object') {
      systemContext = {};
    }
    
    // Build header with mode-specific title
    const modeTitle = {
      'goal-aligned': 'Goal Alignment Report',
      'business': 'Business Opportunities Report',
      'research': 'Research Directions Report'
    }[mode] || 'Insights Report';

    // Build goals/directives context section
    const goalsSection = systemContext.activeGoals && Array.isArray(systemContext.activeGoals) && systemContext.activeGoals.length > 0
      ? `\n**Active Goals:**\n${systemContext.activeGoals.slice(0, 5).map((g, i) => 
          `${i + 1}. [${g.id || 'unknown'}] ${g.description || 'No description'} (${((g.priority || 0) * 100).toFixed(0)}% priority, ${((g.progress || 0) * 100).toFixed(0)}% progress)`
        ).join('\n')}\n`
      : '';

    const directivesSection = systemContext.strategicDirectives && Array.isArray(systemContext.strategicDirectives) && systemContext.strategicDirectives.length > 0
      ? `\n**Strategic Directives:**\n${systemContext.strategicDirectives.slice(0, 3).map((d, i) => `${i + 1}. ${typeof d === 'string' ? d : JSON.stringify(d)}`).join('\n')}\n`
      : '';

    const report = `# COSMO Insight Curation - ${modeTitle}
## ${new Date().toLocaleDateString()}

**Curation Mode:** ${mode}
**Raw Insights Generated:** ${curationResults.metadata.totalRawInsights}
**High-Value Insights Identified:** ${curationResults.metadata.topInsightsCount}
**Curation Duration:** ${curationResults.metadata.curationDuration.toFixed(1)}s
${goalsSection}${directivesSection}

---

## Executive Summary

${curationResults.summary}

---

## Technical Insights (${curationResults.topInsights.technical.length})

${curationResults.topInsights.technical.map((ins, idx) => `
### ${idx + 1}. ${ins.title || 'Technical Insight'}

**Actionability:** ${ins.scores.actionability}/10 | **Strategic Value:** ${ins.scores.businessValue}/10 | **Novelty:** ${ins.scores.novelty}/10

${ins.content}

**Source:** ${ins.source}, Cycle ${ins.cycle}

---
`).join('\n')}

## Strategic Insights (${curationResults.topInsights.strategic.length})

${curationResults.topInsights.strategic.map((ins, idx) => `
### ${idx + 1}. ${ins.title || 'Strategic Insight'}

**Actionability:** ${ins.scores.actionability}/10 | **Strategic Value:** ${ins.scores.businessValue}/10

${ins.content}

**Source:** ${ins.source}, Cycle ${ins.cycle}

---
`).join('\n')}

## Operational Insights (${curationResults.topInsights.operational.length})

${curationResults.topInsights.operational.map((ins, idx) => `
### ${idx + 1}. ${ins.title || 'Operational Insight'}

${ins.content}

**Source:** ${ins.source}, Cycle ${ins.cycle}

---
`).join('\n')}

## Market Intelligence (${curationResults.topInsights.marketIntelligence.length})

${curationResults.topInsights.marketIntelligence.map((ins, idx) => `
### ${idx + 1}. ${ins.title || 'Market Intelligence'}

${ins.content}

**Source:** ${ins.source}, Cycle ${ins.cycle}

---
`).join('\n')}

${this.generateStrategicValueSection(curationResults, mode)}

## Appendix: Methodology

**Curation Process:**
1. Collected ${curationResults.metadata.totalRawInsights} insights from agents, coordinator, and core cognition
2. Scored each on actionability, specificity, novelty, and strategic value
3. Filtered for scores >= 5/10 on key dimensions
4. Ranked by total score
5. Extracted top ${curationResults.metadata.topInsightsCount} insights
6. Categorized by type
7. Analyzed strategic value using **${mode}** mode

**Curation Duration:** ${curationResults.metadata.curationDuration.toFixed(1)}s

**Quality Control:** Automated scoring using GPT-5.2 for consistency

---

*Generated by COSMO Insight Curator*
*Mode: ${mode} | Timestamp: ${curationResults.metadata.timestamp.toISOString()}*
`;

    if (outputPath) {
      await fs.writeFile(outputPath, report, 'utf-8');
      this.logger.info('Report generated', { path: outputPath });
    }

    return report;
  }

  /**
   * Generate mode-specific strategic value section for report
   */
  generateStrategicValueSection(curationResults, mode) {
    const strategicValue = curationResults.strategicValue || [];
    
    if (mode === 'goal-aligned') {
      return `## Goal Alignment & Next Steps

${strategicValue.length > 0 ? strategicValue.map((item, idx) => `
### Alignment ${idx + 1}

**Insight:** #${item.insight}
**Related Goals:** ${Array.isArray(item.relatedGoals) ? item.relatedGoals.join(', ') : 'General'}
**Contribution:** ${item.contribution}
**Next Step:** ${item.nextStep}
**Priority:** ${item.priority}

---
`).join('\n') : '_No goal alignments generated._'}`;
    } else if (mode === 'research') {
      return `## Research Directions

${strategicValue.length > 0 ? strategicValue.map((item, idx) => `
### Direction ${idx + 1}

**Insight:** #${item.insight}
**Research Question:** ${item.researchQuestion}
**Methodology:** ${item.methodology}
**Expected Impact:** ${item.impact}
**Priority:** ${item.priority}

---
`).join('\n') : '_No research directions generated._'}`;
    } else {
      // Business mode
      return `## Business Opportunities

${strategicValue.length > 0 ? strategicValue.map((item, idx) => `
### Opportunity ${idx + 1}

**Insight:** #${item.insight}
**Service:** ${item.service}
**Estimated Value:** ${item.value}
**Client Type:** ${item.client}
**Timeline:** ${item.timeline}

---
`).join('\n') : '_No business opportunities generated._'}`;
    }
  }

  /**
   * Helper: Extract active goals context
   */
  getActiveGoalsContext(goals) {
    if (!goals || goals.length === 0) return [];
    
    return goals.slice(0, 10).map(g => ({
      id: g.id,
      description: g.description || 'No description',
      priority: g.priority || 0,
      progress: g.progress || 0
    }));
  }

  /**
   * Helper: Extract strategic directives context
   */
  getStrategicDirectivesContext(directives) {
    if (!directives || directives.length === 0) return [];
    
    return directives.slice(0, 5);
  }

  /**
   * Helper: Match insights to goals (for detailed analysis)
   */
  matchInsightsToGoals(insights, goals) {
    const matches = [];
    
    for (const insight of insights) {
      const matchedGoals = [];
      
      for (const goal of goals) {
        // Simple keyword matching (could be enhanced with semantic similarity)
        const insightText = (insight.content || '').toLowerCase();
        const goalText = (goal.description || '').toLowerCase();
        
        // Extract key terms from goal
        const goalTerms = goalText.split(/\s+/).filter(term => term.length > 4);
        
        // Check if insight contains goal terms
        let matchCount = 0;
        for (const term of goalTerms) {
          if (insightText.includes(term)) {
            matchCount++;
          }
        }
        
        // If sufficient overlap, consider it a match
        if (matchCount >= 2 || (goalTerms.length > 0 && matchCount / goalTerms.length > 0.3)) {
          matchedGoals.push({
            goalId: goal.id,
            goalDescription: goal.description,
            matchStrength: matchCount / goalTerms.length
          });
        }
      }
      
      if (matchedGoals.length > 0) {
        matches.push({
          insight: insight,
          matchedGoals: matchedGoals.sort((a, b) => b.matchStrength - a.matchStrength)
        });
      }
    }
    
    return matches;
  }
}

module.exports = { InsightCurator };

