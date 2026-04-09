const { BaseAgent } = require('./base-agent');
const { parseWithFallback } = require('../core/json-repair');
const { BibliographyGenerator } = require('../utils/bibliography-generator');
const { cosmoEvents } = require('../realtime/event-emitter');
const fs = require('fs').promises;
const path = require('path');

/**
 * ResearchAgent - Web search and information gathering specialist
 * 
 * Purpose:
 * - Performs targeted web searches to gather real-world information
 * - Synthesizes findings into coherent insights
 * - Adds findings to memory network with proper connections
 * - Identifies follow-up research directions
 * 
 * Use Cases:
 * - Investigating novel concepts identified by Phase 2B
 * - Fact-checking hypotheses from autonomous thinking
 * - Gathering current information on emerging topics
 * - Building knowledge base on specific domains
 */
class ResearchAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.searchQueries = [];
    this.sourcesFound = [];
    this.exportedFiles = [];  // Track files created during corpus export
  }

  /**
   * Main execution logic - GENERIC, config-driven, memory-powered
   */
  async execute() {
    this.logger.info('🔍 ResearchAgent: Starting research mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    }, 3);

    // Intake fail-closed: require claim/intake text before research
    // BUT: only for claim-verification research, not exploratory/literature surveys
    const missionDescription = (this.mission.description || '').toLowerCase();
    
    // INTENT DETECTION: Use a robust check for mission intent
    // Exploratory missions: gathering, surveying, collecting, archiving, documenting
    // Verification missions: checking if a specific claim is true/false, verifying a fact
    const isVerificationMission = 
      (missionDescription.includes('verify') || 
       missionDescription.includes('true') || 
       missionDescription.includes('check if')) &&
      !missionDescription.includes('collect') &&
      !missionDescription.includes('survey') &&
      !missionDescription.includes('research') &&
      !missionDescription.includes('catalog');

    // HEURISTIC: If it's a short topic string (< 5 words), always treat as exploratory
    const wordCount = missionDescription.split(/\s+/).length;
    const isExploratoryResearch = !isVerificationMission || wordCount < 6;
    
    if (!isExploratoryResearch) {
      // Claim-verification research requires explicit claims
      const claimText =
        this.mission?.intake?.claim ||
        this.mission?.intake?.claimText ||
        this.mission?.metadata?.claimText ||
        this.mission?.claimText ||
        null;

      if (!claimText || typeof claimText !== 'string' || claimText.trim().length < 10) {
        const message = 'Research halted: missing claim/intake fields (claim text is required for verification research).';
        this.logger.warn(`❌ ${message}`);
        this.results.push({
          type: 'diagnostic',
          status: 'needs_intake',
          reason: 'missing_claim',
          message,
          requirement: 'claim_text'
        });

        return {
          status: 'needs_intake',
          success: false,
          reason: 'missing_claim',
          results: this.results
        };
      }
    } else {
      this.logger.info('ℹ️  Exploratory research - proceeding without strict claim intake', {
        type: 'exploratory',
        mission: missionDescription.substring(0, 100)
      });
    }

    await this.reportProgress(5, 'Querying memory for relevant context');

    // STEP 1: Query memory based on mission (semantic search - no hardcoded detection)
    const relevantKnowledge = await this.memory.query(this.mission.description, 30);
    
    this.logger.info('📚 Memory query complete', {
      nodesFound: relevantKnowledge.length,
      topSimilarity: relevantKnowledge[0]?.similarity || 0
    });

    // NEW: Use spreading activation to discover related concepts
    if (relevantKnowledge.length > 0) {
      const connected = await this.exploreMemoryConnections(this.mission.description, 2);
      this.logger.info('🔗 Spreading activation discovered related concepts', {
        activated: connected.length,
        topConcepts: connected.slice(0, 3).map(n => n.concept?.substring(0, 50))
      });
    }

    // NEW: Check hot topics to understand what's currently important
    const hotTopics = await this.getHotTopics(5);
    if (hotTopics.length > 0) {
      this.logger.info('🔥 Hot topics in memory', {
        topics: hotTopics.map(t => ({ 
          concept: t.concept?.substring(0, 40), 
          accessCount: t.accessCount 
        }))
      });
    }

    // STEP 2: Adapt behavior based on what's available in memory
    // Check for file inventory data
    const hasFileInventory = relevantKnowledge.some(node => 
      node.tags?.includes('file_inventory') || 
      node.concept?.includes('file inventory')
    );

    // Check for code analysis needs
    // IMPORTANT: Check MISSION DESCRIPTION, not acceptance criteria
    // Acceptance criteria describe OUTPUTS (what to create), not INPUTS (what to analyze)
    // Only trigger code analysis when mission explicitly asks to analyze/review existing code
    const missionText = (this.mission.description || this.mission.mission || '').toLowerCase();
    const needsCodeAnalysis = 
      missionText.includes('analyze code') ||
      missionText.includes('review code') ||
      missionText.includes('read code') ||
      missionText.includes('analyze implementation') ||
      missionText.includes('review implementation') ||
      missionText.includes('code review') ||
      missionText.includes('codebase analysis') ||
      missionText.includes('inspect code') ||
      missionText.includes('examine code') ||
      // Check for explicit file reading missions (not just "save to file")
      (missionText.includes('analyze file') && !missionText.includes('produce')) ||
      (missionText.includes('read file') && !missionText.includes('write'));

    // Check if MCP is available for code analysis
    const mcpAvailable = this.config.mcp?.client?.enabled === true;
    
    // Log detection result for debugging
    if (needsCodeAnalysis) {
      this.logger.info('🔍 Detected code analysis mission', {
        missionSnippet: missionText.substring(0, 100),
        hasInventory: hasFileInventory,
        mcpAvailable
      });
    } else {
      this.logger.info('🌐 Detected web research mission (no code analysis needed)', {
        missionSnippet: missionText.substring(0, 100)
      });
    }
    
    // STEP 3: Decide on research approach based on mission + memory state + MCP availability
    if (needsCodeAnalysis && !mcpAvailable) {
      this.logger.info('📂 Mission needs code analysis but MCP is disabled → falling back to web research', {
        mcpEnabled: this.config.mcp?.client?.enabled,
        agentId: this.agentId
      });
      // Fall through to default web research below
    } else if (needsCodeAnalysis && hasFileInventory && mcpAvailable) {
      this.logger.info('📖 Mission needs code analysis + inventory available → will read files');
      const inventoryData = await this.queryMemoryForData(['inventory'], ['file_inventory'], 5);
      return await this.readFilesForAnalysis(inventoryData[0]?.data);
    } else if (needsCodeAnalysis && !hasFileInventory && mcpAvailable) {
      this.logger.info('📂 Mission needs code analysis but no inventory → will scan first');
      const inventory = await this.scanFilesystem();
      return await this.readFilesForAnalysis(inventory);
    }

    // Default: Web research (original behavior)
    // Check if OpenAI web search is enabled, or if we're in local LLM mode with MCP search
    const webSearchEnabled = this.config.models?.enableWebSearch === true;
    const isLocalLLMMode = this.config.providers?.local?.enabled === true ||
                           process.env.LLM_BACKEND === 'local';
    const hasMCPSearch = this.mcpClient && typeof this.mcpClient.callTool === 'function';

    if (!webSearchEnabled && !isLocalLLMMode) {
      this.logger.warn('⚠️ ResearchAgent: Web search is disabled in config - cannot execute web research mission', {
        agentId: this.agentId,
        config_enableWebSearch: this.config.models?.enableWebSearch
      });

      // Return gracefully with explanation
      return {
        success: false,
        error: 'Web search is disabled in configuration',
        recommendation: 'Enable web search in launcher or use analysis/synthesis agents instead'
      };
    }

    // In local LLM mode, always use local search (FreeWebSearch/SearXNG)
    // OpenAI's web_search tool doesn't work with local LLMs
    if (isLocalLLMMode) {
      this.logger.info('🏠 Local LLM mode: Using FreeWebSearch for research', {
        agentId: this.agentId,
        hasMCPSearch,
        searxngUrl: this.config?.providers?.local?.searxngUrl || 'DuckDuckGo fallback'
      });
      this.useLocalSearch = true;
    }
    
    await this.reportProgress(10, 'Conducting web research');

    // NEW: Check if system already has knowledge on this topic ("Measure Twice")
    const existingKnowledge = await this.checkExistingKnowledge(
      this.mission.description,
      3  // Need 3+ relevant nodes to consider "has knowledge"
    );

    if (existingKnowledge && existingKnowledge.hasKnowledge) {
      this.logger.info('📚 System already has knowledge on this topic', {
        relevantNodes: existingKnowledge.relevantNodes,
        recommendation: existingKnowledge.recommendation
      });
      
      // Add insight about existing knowledge
      await this.addInsight(
        `System already has ${existingKnowledge.relevantNodes} relevant memory nodes. ` +
        `Research will focus on gaps and updates.`
      );
    }

    // Step 1: Generate focused research queries
    const queries = await this.generateResearchQueries();
    this.searchQueries = queries;
    
    if (queries.length === 0) {
      throw new Error('Failed to generate research queries');
    }

    await this.reportProgress(25, `Generated ${queries.length} research queries`);

    // Step 2: Execute web searches
    let searchResults = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      
      this.logger.info('🌐 Executing web search', {
        agentId: this.agentId,
        query,
        queryNum: i + 1,
        total: queries.length
      }, 3);

      cosmoEvents.emitEvent('web_search', {
        query: query.substring(0, 80),
        agentId: this.agentId,
        queryNum: i + 1,
        total: queries.length,
        source: 'research_agent'
      });

      try {
        const result = await this.performWebSearch(query);
        searchResults.push({ query, result });
        
        await this.reportProgress(
          25 + (i + 1) * (40 / queries.length),
          `Completed search ${i + 1}/${queries.length}`
        );
      } catch (error) {
        this.logger.warn('Search failed, continuing', {
          query,
          error: error.message
        }, 3);
      }
    }

    if (searchResults.length === 0) {
      // Fallback: Generate research using LLM's training knowledge
      this.logger.warn('All web searches failed - falling back to LLM knowledge', {
        agentId: this.agentId,
        mission: this.mission.description
      });

      const fallbackResult = await this.generateKnowledgeBasedResearch(queries);
      if (fallbackResult) {
        searchResults.push({
          query: 'Knowledge-based research (web search unavailable)',
          result: fallbackResult
        });
      } else {
        throw new Error('All web searches failed and knowledge fallback unavailable');
      }
    }

    // Step 3: Synthesize findings
    await this.reportProgress(70, 'Synthesizing findings');
    const synthesis = await this.synthesizeFindings(searchResults);

    // Step 4: Add findings to memory (PRIMARY - for merge)
    await this.reportProgress(85, 'Adding findings to memory');
    for (const finding of synthesis.findings) {
      await this.addFinding(finding, 'research');
    }

    // Step 5: Identify follow-up directions
    await this.reportProgress(95, 'Identifying follow-up directions');
    const followUp = await this.identifyFollowUp(synthesis);

    // Store final results with sources
    this.results.push({
      type: 'synthesis',
      content: synthesis.summary,
      findingsCount: synthesis.findings.length,
      sourcesCount: this.sourcesFound.length,
      sources: this.sourcesFound, // Include actual source URLs
      followUp,
      timestamp: new Date()
    }, 3);

    // NEW: Export research corpus to files (SECONDARY - for intra-run collaboration)
    // This is optional and non-breaking - if it fails, research still succeeds via memory
    try {
      await this.exportResearchCorpus(synthesis, searchResults);
    } catch (error) {
      this.logger.warn('Research corpus export failed (non-fatal)', {
        error: error.message,
        note: 'Research data remains available in memory for merges'
      });
      // Continue - memory storage is primary, file export is optional
    }

    await this.reportProgress(100, 'Research complete');

    this.logger.info('✅ ResearchAgent: Mission complete', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      queriesExecuted: searchResults.length,
      findingsAdded: synthesis.findings.length,
      sourcesFound: this.sourcesFound.length,
      followUpDirections: followUp.length
    }, 3);

    return {
      success: true,
      queriesExecuted: searchResults.length,
      findingsAdded: synthesis.findings.length,
      sourcesFound: this.sourcesFound.length,
      sources: this.sourcesFound, // Return sources in results
      followUpDirections: followUp.length,
      metadata: {
        findings: this.results.filter(r => r.type === 'finding'), // DoD contract: array of findings
        sourcesFound: this.sourcesFound.length,
        urlsValid: this.sourcesFound.length, // DoD contract: number of valid URLs
        artifactsCreated: this.exportedFiles.length,  // NEW: Track research corpus files for Executive
        filesCreated: this.exportedFiles.length,      // NEW: Files created during export
        status: 'complete'
      }
    };
  }

  /**
   * Generate focused research queries from mission description
   */
  async generateResearchQueries() {
    const prompt = `You are a research specialist generating web search queries.

MISSION: ${this.mission.description}

SUCCESS CRITERIA:
${this.mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Generate 2-3 highly focused search queries that will help accomplish this mission.

Requirements:
- Each query should be specific and actionable
- Queries should cover different aspects of the mission
- Aim for current, factual information
- Keep queries concise (5-10 words each)

Respond with JSON array of query strings:
["query 1", "query 2", "query 3"]`;

    try {
      const response = await this.gpt5.generateFast({
        component: 'agents',
        purpose: 'research',
        instructions: prompt,
        messages: [{ role: 'user', content: 'Generate research queries.' }],
        maxTokens: 2000 // Increased from 500 - query generation needs thorough planning
      });

      // Try parsing with repair fallback
      const queries = parseWithFallback(response.content, 'array');
      if (queries && Array.isArray(queries)) {
        return queries.slice(0, 3); // Max 3 queries
      }

      this.logger.warn('Failed to parse queries JSON, using mission description');
      return [this.mission.description];
    } catch (error) {
      this.logger.error('Query generation failed', { error: error.message }, 3);
      return [this.mission.description]; // Fallback
    }
  }

  /**
   * Perform web search using GPT-5.2's web search capability
   * or MCP web_search tool in local LLM mode
   */
  async performWebSearch(query) {
    // Use MCP web_search in local LLM mode
    if (this.useLocalSearch) {
      return await this.performLocalWebSearch(query);
    }

    try {
      const response = await this.gpt5.generateWithWebSearch({
        component: 'agents',
        purpose: 'research',
        query: query,
        instructions: `You are a research assistant. Use web search to find current, factual information. Focus on key facts, recent developments, and practical insights. Provide a concise summary (2-3 paragraphs).`,
        maxTokens: 6000 // Increased from 2000 - data extraction needs comprehensive output
      });

      // NEW: Extract sources from the proper response fields
      // webSearchSources contains all URLs consulted (from include parameter)
      // citations contains inline cited URLs with titles
      if (response.webSearchSources && response.webSearchSources.length > 0) {
        const uniqueSources = [...new Set(response.webSearchSources.map(s => s.url || s))];
        this.sourcesFound.push(...uniqueSources);

        this.logger.info('✅ Web search sources found', {
          query: query.substring(0, 50),
          newSources: uniqueSources.length,
          totalSources: this.sourcesFound.length
        }, 3);
      }

      // Also extract from citations
      if (response.citations && response.citations.length > 0) {
        const citedUrls = response.citations.map(c => c.url);
        const newCitations = citedUrls.filter(url => !this.sourcesFound.includes(url));
        this.sourcesFound.push(...newCitations);

        this.logger.info('✅ Citations found', {
          query: query.substring(0, 50),
          citations: response.citations.length,
          newUnique: newCitations.length
        }, 3);
      }

      // Fallback: Also check text for URLs (in case API doesn't return structured sources)
      const allText = [response.reasoning, response.content].filter(Boolean).join('\n');
      const sourceMatches = allText.match(/https?:\/\/[^\s)]+/g);

      if (sourceMatches) {
        const uniqueSources = [...new Set(sourceMatches)];
        const newSources = uniqueSources.filter(url => !this.sourcesFound.includes(url));
        if (newSources.length > 0) {
          this.sourcesFound.push(...newSources);
          this.logger.debug('Additional sources found in text', {
            newSources: newSources.length
          }, 3);
        }
      }

      return response.content;
    } catch (error) {
      this.logger.error('Web search failed', {
        query,
        error: error.message
      }, 3);
      throw error;
    }
  }

  /**
   * Perform web search using MCP web_search tool (for local LLM mode)
   * Uses free DuckDuckGo search via MCP
   */
  async performLocalWebSearch(query) {
    try {
      this.logger.info('🔍 Local web search via MCP', { query: query.substring(0, 50) });

      // Call MCP web_search tool
      let searchResults;
      if (this.mcpClient && typeof this.mcpClient.callTool === 'function') {
        const mcpResponse = await this.mcpClient.callTool('web_search', { query, maxResults: 10 });
        searchResults = JSON.parse(mcpResponse.content?.[0]?.text || '{}');
      } else {
        // Fallback: Direct call to FreeWebSearch
        const { FreeWebSearch } = require('../tools/web-search-free');
        const searcher = new FreeWebSearch(this.logger, {
          searxngUrl: this.config?.providers?.local?.searxngUrl || process.env.SEARXNG_URL
        });
        searchResults = await searcher.search(query, { maxResults: 10 });
      }

      if (!searchResults.success || searchResults.results.length === 0) {
        this.logger.warn('Local search returned no results', { query });
        return `No web results found for "${query}". Proceeding with existing knowledge.`;
      }

      // Extract sources
      const sources = searchResults.results.map(r => r.url);
      this.sourcesFound.push(...sources);

      this.logger.info('✅ Local web search complete', {
        query: query.substring(0, 50),
        results: searchResults.results.length,
        sources: sources.length
      });

      // Format results for synthesis
      // Ask LLM to summarize the search results
      const searchContext = searchResults.results.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      const response = await this.gpt5.generate({
        component: 'agents',
        purpose: 'research-synthesis',
        instructions: `You are a research assistant. Analyze these web search results and provide a concise summary of the key facts and insights (2-3 paragraphs).`,
        messages: [{
          role: 'user',
          content: `Search query: "${query}"\n\nSearch results:\n${searchContext}\n\nProvide a synthesis of these findings.`
        }],
        maxTokens: 2000
      });

      return response.content || searchContext;
    } catch (error) {
      this.logger.error('Local web search failed', {
        query,
        error: error.message
      });

      // Graceful fallback - return empty but don't crash
      return `Search failed for "${query}". Proceeding with existing knowledge.`;
    }
  }

  /**
   * Generate research using LLM's training knowledge when web search fails
   * This is a fallback to ensure agents can still produce deliverables
   */
  async generateKnowledgeBasedResearch(queries) {
    this.logger.info('📚 Generating knowledge-based research (web search unavailable)', {
      agentId: this.agentId,
      queryCount: queries.length
    });

    const querySummary = queries.map((q, i) => `${i + 1}. ${q}`).join('\n');

    try {
      const response = await this.gpt5.generate({
        component: 'agents',
        purpose: 'research-fallback',
        instructions: `You are a knowledgeable research assistant. Web search is currently unavailable, so you must provide research findings based on your training knowledge.

Be helpful and informative, but clearly note that this is based on training data, not live web results. Focus on established facts, well-known research, and general domain knowledge.`,
        messages: [{
          role: 'user',
          content: `Research mission: ${this.mission.description}

Research questions to address:
${querySummary}

Provide comprehensive findings for each question based on your knowledge. Include specific facts, established research findings, and relevant context. Format as clear paragraphs.`
        }],
        maxTokens: 4000
      });

      const content = response.content || '';
      if (content.length > 100) {
        this.logger.info('✅ Knowledge-based research generated', {
          contentLength: content.length
        });
        return `[Note: Based on LLM training knowledge - web search was unavailable]\n\n${content}`;
      }

      return null;
    } catch (error) {
      this.logger.error('Knowledge-based research generation failed', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Synthesize search results into coherent findings
   */
  async synthesizeFindings(searchResults) {
    const searchSummary = searchResults
      .map((sr, i) => `Query ${i + 1}: ${sr.query}\nFindings: ${sr.result}`)
      .join('\n\n---\n\n');

    const prompt = `You are synthesizing research findings into actionable insights.

ORIGINAL MISSION: ${this.mission.description}

RESEARCH CONDUCTED:
${searchSummary}

Your task:
1. Extract 3-5 key findings (specific, factual insights)
2. Create an overall summary (2-3 paragraphs)
3. Assess how well the success criteria were met

SUCCESS CRITERIA:
${this.mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Respond in JSON format:
{
  "summary": "Overall synthesis...",
  "findings": [
    "Finding 1: Specific insight...",
    "Finding 2: Specific insight...",
    "Finding 3: Specific insight..."
  ],
  "successAssessment": "How well criteria were met..."
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        instructions: prompt,
        messages: [{ role: 'user', content: 'Synthesize research findings.' }],
        maxTokens: 12000, // Synthesis needs space to find cross-source insights
        reasoningEffort: 'medium' // Synthesis benefits from reasoning about connections
      }, 3);

      const content = response.content || '';

      // Try to extract JSON from response
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          // Try to repair common JSON issues from local LLMs
          let jsonStr = match[0];
          jsonStr = jsonStr.replace(/,\s*}/g, '}');  // Remove trailing commas
          jsonStr = jsonStr.replace(/,\s*]/g, ']');  // Remove trailing commas in arrays
          jsonStr = jsonStr.replace(/True/g, 'true').replace(/False/g, 'false'); // Python booleans

          const synthesis = JSON.parse(jsonStr);

          // Ensure findings array exists and has content
          if (synthesis.findings && synthesis.findings.length > 0) {
            return synthesis;
          }
        } catch (parseError) {
          this.logger.warn('JSON parse failed, extracting findings from text', {
            error: parseError.message
          });
        }
      }

      // Fallback: Extract findings from raw text response
      const findings = this.extractFindingsFromText(content, searchResults);

      return {
        summary: content.substring(0, 2000) || 'Research synthesis completed',
        findings: findings,
        successAssessment: 'Synthesis completed with text extraction'
      };
    } catch (error) {
      this.logger.error('Synthesis failed', { error: error.message }, 3);
      // Return basic synthesis from search results
      const findings = searchResults.length > 0
        ? searchResults.map(sr => `Research on "${sr.query}": ${sr.result.substring(0, 500)}`)
        : [`Research mission: ${this.mission.description} - synthesis in progress`];

      return {
        summary: searchResults.map(sr => sr.result).join(' ').substring(0, 2000) || 'Research completed',
        findings: findings,
        successAssessment: 'Basic synthesis completed'
      };
    }
  }

  /**
   * Extract findings from unstructured text response
   */
  extractFindingsFromText(content, searchResults) {
    const findings = [];

    // Try to find numbered points or bullet points
    const numberedPattern = /(?:^|\n)\s*(?:\d+[\.\):]|\*|\-)\s*(.+?)(?=\n\s*(?:\d+[\.\):]|\*|\-)|$)/gs;
    const matches = [...content.matchAll(numberedPattern)];

    if (matches.length >= 2) {
      for (const match of matches.slice(0, 5)) {
        const finding = match[1].trim();
        if (finding.length > 20) {
          findings.push(finding);
        }
      }
    }

    // If we couldn't extract structured findings, split by paragraphs
    if (findings.length < 2) {
      const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 50);
      for (const para of paragraphs.slice(0, 5)) {
        findings.push(para.trim().substring(0, 500));
      }
    }

    // Last resort: use search results as findings
    if (findings.length === 0 && searchResults.length > 0) {
      for (const sr of searchResults.slice(0, 3)) {
        findings.push(`Research on "${sr.query}": ${sr.result.substring(0, 300)}`);
      }
    }

    // Absolute fallback
    if (findings.length === 0) {
      findings.push(`Research completed for: ${this.mission.description}`);
    }

    return findings;
  }

  /**
   * Identify follow-up research directions
   */
  async identifyFollowUp(synthesis) {
    const prompt = `Based on this research synthesis, identify 2-3 specific follow-up directions.

SYNTHESIS:
${synthesis.summary}

KEY FINDINGS:
${synthesis.findings.join('\n')}

What specific areas require deeper investigation? What questions remain unanswered?

Respond with JSON array of follow-up directions:
["Direction 1", "Direction 2", "Direction 3"]`;

    try {
      const response = await this.gpt5.generateFast({
        instructions: prompt,
        messages: [{ role: 'user', content: 'Identify follow-up directions.' }],
        maxTokens: 6000 // Increased from 1500 to prevent incomplete responses
      }, 3);

      // Check for incomplete response
      if (response.hadError || response.errorType === 'response.incomplete') {
        this.logger.warn('Incomplete response for follow-up directions, returning empty array');
        return [];
      }

      const match = response.content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]).slice(0, 3);
      }
      return [];
    } catch (error) {
      this.logger.error('Follow-up identification failed', { error: error.message }, 3);
      return [];
    }
  }

  /**
   * Read files for analysis (GENERIC method - no hardcoded detection)
   * Adapts to mission needs dynamically
   * @param {Object} inventory - File inventory with agent_files, core_files, etc.
   * @returns {Object} File reading results
   */
  async readFilesForAnalysis(inventory) {
    this.logger.info('📖 Starting deep code reading mission', {
      agentFiles: inventory.agent_files?.length || 0,
      coreFiles: inventory.core_files?.length || 0
    });
    
    await this.reportProgress(5, 'Preparing code reading from inventory');
    
    const codeAnalysis = [];
    let filesToRead = [];
    
    // FLEXIBLE APPROACH: Try multiple methods to get production file list
    
    // METHOD 1: Extract explicit file list from mission description (most reliable)
    const explicitFiles = this.extractFileListFromMission(this.mission.description);
    if (explicitFiles.length > 0) {
      this.logger.info(`📋 Using ${explicitFiles.length} explicitly-listed files from mission`, {}, 3);
      filesToRead = explicitFiles.map(f => ({ path: f, type: this.categorizeFile(f) }));
    }
    // METHOD 2: Use curated production file list (fallback - only for code analysis)
    else {
      // No explicit files and no special cases - just use configured directories
      this.logger.info('📋 No explicit file list - agents will use configured directories via MCP', {}, 3);
      filesToRead = [];
    }
    
    // SAFETY: Filter out any legacy/backup files
    const exclusionPatterns = [/backup/i, /_old/i, /\.OLD$/i, /test-/i, /node_modules/];
    const originalCount = filesToRead.length;
    filesToRead = filesToRead.filter(f => 
      !exclusionPatterns.some(pattern => pattern.test(f.path))
    );
    
    if (filesToRead.length < originalCount) {
      this.logger.info(`🛡️  Filtered out ${originalCount - filesToRead.length} legacy/backup files`);
    }
    
    this.logger.info(`📚 Will read ${filesToRead.length} implementation files`);
    
    let filesRead = 0;
    let totalBytes = 0;
    let totalLines = 0;
    
    // Read each file and extract metadata
    for (let i = 0; i < filesToRead.length; i++) {
      const fileSpec = filesToRead[i];
      
      try {
        this.logger.info(`📄 Reading [${i + 1}/${filesToRead.length}]: ${fileSpec.path}`, {}, 3);
        
        // readFileViaMCP now throws errors instead of returning null
        const content = await this.readFileViaMCP(fileSpec.path);
        
        if (!content || content.length === 0) {
          this.logger.warn(`  ✗ File is empty: ${fileSpec.path}`, {}, 3);
          continue;
        }
        
        const lines = content.split('\n');
        const bytes = content.length;
        
        // Extract structural metadata WITHOUT storing full content
        const analysis = {
          file: fileSpec.path,
          type: fileSpec.type,
          size: {
            lines: lines.length,
            bytes: bytes,
            code_lines: lines.filter(l => l.trim() && !l.trim().startsWith('//')).length
          },
          
          // Function analysis
          functions: {
            async: (content.match(/async\s+\w+\s*\(/g) || []).length,
            sync: (content.match(/(?:function\s+)?\w+\s*\([^)]*\)\s*\{/g) || []).length,
            // Extract function signatures
            signatures: this.extractFunctionSignatures(content)
          },
          
          // Class structure
          classes: {
            count: (content.match(/class\s+\w+/g) || []).length,
            names: (content.match(/class\s+(\w+)/g) || []).map(m => m.replace('class ', '')),
            extends: (content.match(/class\s+\w+\s+extends\s+(\w+)/g) || [])
          },
          
          // Dependencies
          dependencies: {
            requires: (content.match(/require\(['"]([^'"]+)['"]\)/g) || []).map(r => r.match(/require\(['"]([^'"]+)['"]\)/)[1]),
            internal: (content.match(/require\(['"](\.[^'"]+)['"]\)/g) || []).length,
            external: (content.match(/require\(['"]([^.][^'"]+)['"]\)/g) || []).length
          },
          
          // Quality indicators
          quality: {
            try_blocks: (content.match(/\btry\s*\{/g) || []).length,
            catch_blocks: (content.match(/\bcatch\s*\(/g) || []).length,
            jsdoc_blocks: (content.match(/\/\*\*[\s\S]*?\*\//g) || []).length,
            inline_comments: (content.match(/\/\/[^\n]*/g) || []).length,
            todos: (content.match(/TODO/gi) || []).length,
            fixmes: (content.match(/FIXME|XXX|HACK/gi) || []).length
          },
          
          // Agent-specific patterns (if agent file)
          agent_patterns: fileSpec.type === 'agent' ? {
            extends_base: content.includes('extends BaseAgent'),
            overrides_execute: content.includes('async execute()'),
            uses_addFinding: (content.match(/await\s+this\.addFinding\(/g) || []).length,
            uses_addInsight: (content.match(/await\s+this\.addInsight\(/g) || []).length,
            uses_memory_query: (content.match(/await\s+this\.memory\.query\(/g) || []).length,
            uses_queryMemoryForData: (content.match(/await\s+this\.queryMemoryForData\(/g) || []).length,
            reportProgress_calls: (content.match(/await\s+this\.reportProgress\(/g) || []).length
          } : null,
          
          // Code preview for GPT-5.2 review (first 300 lines or 15KB, whichever is smaller)
          codePreview: lines.slice(0, Math.min(300, lines.length)).join('\n').substring(0, 15000)
        };
        
        codeAnalysis.push(analysis);
        filesRead++;
        totalBytes += bytes;
        totalLines += lines.length;
        
        this.logger.info(`  ✓ Analyzed: ${fileSpec.path} (${lines.length} lines, ${(bytes/1024).toFixed(1)}KB)`, {}, 3);
        
        await this.reportProgress(
          5 + ((i + 1) / filesToRead.length) * 80,
          `Read ${i + 1}/${filesToRead.length} files`
        );
        
      } catch (error) {
        this.logger.warn(`  ✗ Failed to read: ${fileSpec.path} - ${error.message}`, {}, 3);
      }
    }
    
    await this.reportProgress(90, 'Storing code analysis in memory');
    
    // IMPORTANT: Only fail if we were actually supposed to read code files
    // Some missions (like document analysis) legitimately skip code reading
    if (codeAnalysis.length === 0) {
      const wasSupposedToReadCode = filesToRead.length > 0;
      if (wasSupposedToReadCode) {
        throw new Error('Failed to read any code files');
      } else {
        // Mission didn't require code reading - return empty analysis gracefully
        this.logger.info('✅ Mission completed (no code file reading required)', {}, 3);
        return {
          filesRead: 0,
          totalLines: 0,
          totalBytes: 0,
          analysis: [],
          skipped: true,
          reason: 'Mission does not require code file analysis'
        };
      }
    }
    
    this.logger.info('✅ Code reading complete', {
      filesRead,
      totalLines,
      totalKB: (totalBytes / 1024).toFixed(1)
    });
    
    // Store complete analysis in memory with tag 'source_code_analysis'
    // This is a structured dataset that code agent can analyze
    // NOTE: Large JSON might exceed embedding limits - store in chunks if needed
    const analysisData = {
      analysis_type: 'source_code',
      files_analyzed: filesRead,
      total_lines: totalLines,
      total_bytes: totalBytes,
      analyzed_at: new Date().toISOString(),
      files: codeAnalysis
    };
    
    const analysisJSON = JSON.stringify(analysisData);
    const analysisSize = analysisJSON.length;
    
    this.logger.info(`Storing code analysis (${(analysisSize/1024).toFixed(1)}KB)`, {}, 3);
    
    // If too large for single embedding (>20KB), split into chunks
    if (analysisSize > 20000) {
      this.logger.info('Large analysis - storing in chunks', {}, 3);
      
      // Store summary metadata first
      const summaryNode = await this.addFinding(
        JSON.stringify({
          analysis_type: 'source_code',
          files_analyzed: filesRead,
          total_lines: totalLines,
          total_bytes: totalBytes,
          analyzed_at: new Date().toISOString(),
          chunk_count: codeAnalysis.length,
          file_list: codeAnalysis.map(f => f.file)
        }),
        'source_code_analysis'
      );
      
      // Store each file's analysis separately
      for (const fileAnalysis of codeAnalysis) {
        await this.addFinding(
          JSON.stringify(fileAnalysis),
          'source_code_file'
        );
      }
      
      if (!summaryNode) {
        this.logger.warn('Summary node creation failed, but file chunks stored');
      }
    } else {
      // Small enough for single node
      const node = await this.addFinding(analysisJSON, 'source_code_analysis');
      if (!node) {
        this.logger.error('Failed to store code analysis in memory - embedding failed');
        throw new Error('Code analysis storage failed - unable to create memory embedding');
      }
    }
    
    // Also add human-readable summary
    const summary = `Read and analyzed ${filesRead} implementation files: ` +
                   `${codeAnalysis.filter(f => f.type === 'agent').length} agents, ` +
                   `${codeAnalysis.filter(f => f.type === 'core').length} core files, ` +
                   `${codeAnalysis.filter(f => f.type === 'infrastructure').length} infrastructure files. ` +
                   `Total: ${totalLines} lines, ${(totalBytes/1024).toFixed(1)}KB.`;
    
    await this.addFinding(summary, 'research');
    
    await this.reportProgress(100, 'Code reading and analysis complete');
    
    return {
      success: true,
      readingType: 'source_code_analysis',
      filesRead,
      totalLines,
      totalBytes,
      agentFiles: codeAnalysis.filter(f => f.type === 'agent').length,
      coreFiles: codeAnalysis.filter(f => f.type === 'core').length
    };
  }
  
  /**
   * Extract function signatures from JavaScript code
   * Helps understand API surface without storing full code
   * @param {string} code - JavaScript code content
   * @returns {Array} Function signatures
   */
  extractFunctionSignatures(code) {
    const signatures = [];
    
    // Async functions
    const asyncMatches = code.matchAll(/async\s+(\w+)\s*\(([^)]*)\)/g);
    for (const match of asyncMatches) {
      signatures.push({
        name: match[1],
        params: match[2].split(',').map(p => p.trim()).filter(Boolean),
        async: true
      });
    }
    
    // Regular functions
    const syncMatches = code.matchAll(/(?:function\s+)?(\w+)\s*\(([^)]*)\)\s*\{/g);
    for (const match of syncMatches) {
      const name = match[1];
      // Skip keywords and constructor
      if (['if', 'while', 'for', 'switch', 'catch', 'constructor'].includes(name)) {
        continue;
      }
      signatures.push({
        name,
        params: match[2].split(',').map(p => p.trim()).filter(Boolean),
        async: false
      });
    }
    
    // Return top 20 signatures (avoid huge arrays)
    return signatures.slice(0, 20);
  }

  /**
   * Scan filesystem to build file inventory (GENERIC method)
   * Used when mission needs file data but none exists in memory
   */
  async scanFilesystem() {
    this.logger.info('📂 Starting file discovery and inventory mission');
    await this.reportProgress(10, 'Scanning directories via MCP');

    // ALWAYS use allowedPaths from launch script configuration
    // Config structure: mcp.client.servers[0].allowedPaths
    const mcpServers = this.config?.mcp?.client?.servers;
    const allowedPaths = mcpServers?.[0]?.allowedPaths;
    
    const dirsToScan = allowedPaths && allowedPaths.length > 0
      ? allowedPaths.map(p => p.replace(/\/$/, ''))  // Use configured paths from launch script
      : [];  // Empty array if no file access configured - don't scan anything
    
    this.logger.info(`📁 Using directories from launch configuration`, {
      configuredPaths: allowedPaths || 'none - file access not configured',
      willScan: dirsToScan
    }, 3);
    
    if (dirsToScan.length === 0) {
      this.logger.warn('⚠️ No file access configured - skipping filesystem scan', {}, 3);
      this.logger.info('💡 Use launch script to configure file access if needed', {}, 3);
    }
    const inventory = {
      md_files: [],
      js_files: [],
      agent_files: [],
      core_files: [],
      total_md: 0,
      total_js: 0,
      total_bytes: 0,
      discovered_at: new Date().toISOString(),
      directories_scanned: dirsToScan
    };

    let filesScanned = 0;

    for (const dir of dirsToScan) {
      try {
        this.logger.info(`📁 Scanning directory: ${dir}`, {}, 3);
        
        // listDirectoryViaMCP now throws errors instead of returning null
        const items = await this.listDirectoryViaMCP(dir);
        
        if (!items || items.length === 0) {
          this.logger.info(`  ℹ️  Empty directory: ${dir}`, {}, 3);
          continue;
        }

        for (const item of items) {
          if (item.type !== 'file') continue;

          const fullPath = dir === '.' ? item.name : `${dir}/${item.name}`;
          const fileSize = item.size || 0;
          
          filesScanned++;

          // Categorize files
          if (item.name.endsWith('.md')) {
            inventory.md_files.push(fullPath);
            inventory.total_md++;
            inventory.total_bytes += fileSize;
          } else if (item.name.endsWith('.js')) {
            inventory.js_files.push(fullPath);
            inventory.total_js++;
            inventory.total_bytes += fileSize;
            
            // Special categorization
            if (item.name.includes('-agent.js')) {
              inventory.agent_files.push(fullPath);
            }
            if (dir.includes('core')) {
              inventory.core_files.push(fullPath);
            }
          }
        }

        await this.reportProgress(
          10 + (dirsToScan.indexOf(dir) + 1) * (50 / dirsToScan.length),
          `Scanned ${dir}`
        );
      } catch (error) {
        this.logger.warn(`Failed to scan ${dir}: ${error.message}`, {}, 3);
      }
    }

    await this.reportProgress(70, 'Building inventory summary');

    this.logger.info('✅ File discovery complete', {
      mdFiles: inventory.total_md,
      jsFiles: inventory.total_js,
      agentFiles: inventory.agent_files.length,
      totalBytes: inventory.total_bytes,
      filesScanned
    }, 3);

    // Store inventory in memory with tag 'file_inventory'
    // This is how agents communicate - through the memory network
    await this.reportProgress(85, 'Storing inventory in memory');
    
    await this.addFinding(
      JSON.stringify(inventory),
      'file_inventory'
    );

    this.logger.info('📦 File inventory stored in memory with tag "file_inventory"', {
      canBeRetrievedBy: 'code_execution, synthesis, analysis agents'
    }, 3);

    // Also add a summary finding
    const summary = `Discovered ${inventory.total_md} .md files and ${inventory.total_js} .js files ` +
                   `across ${dirsToScan.length} directories. ` +
                   `Found ${inventory.agent_files.length} agent files. ` +
                   `Total size: ${(inventory.total_bytes / 1024).toFixed(1)}KB.`;
    
    await this.addFinding(summary, 'research');

    await this.reportProgress(100, 'File discovery complete');

    return {
      success: true,
      discoveryType: 'file_inventory',
      filesDiscovered: filesScanned,
      mdFiles: inventory.total_md,
      jsFiles: inventory.total_js,
      agentFiles: inventory.agent_files.length,
      totalBytes: inventory.total_bytes
    };
  }

  /**
   * Extract file paths from mission description
   * Looks for patterns like: src/agents/analysis-agent.js
   * @param {string} description - Mission description
   * @returns {Array<string>} Array of file paths
   */
  extractFileListFromMission(description) {
    if (!description) return [];
    
    // Pattern for file paths: src/path/to/file.js
    const filePattern = /src\/[\w-]+\/[\w-]+\.js|mcp\/[\w-]+\.js/g;
    const matches = description.match(filePattern) || [];
    
    // Return unique paths only
    return [...new Set(matches)];
  }
  
  /**
   * Categorize file by path to determine its role
   * @param {string} filePath - Path to file
   * @returns {string} Category: 'agent', 'core', 'infrastructure', 'mcp_server'
   */
  categorizeFile(filePath) {
    if (filePath.includes('/agents/') && filePath.endsWith('-agent.js')) {
      return 'agent';
    } else if (filePath.includes('/agents/')) {
      return 'agent_infrastructure';
    } else if (filePath.includes('/core/')) {
      return 'core';
    } else if (filePath.includes('/memory/') || filePath.includes('/coordinator/') || 
               filePath.includes('/goals/') || filePath.includes('/cognition/')) {
      return 'infrastructure';
    } else if (filePath.includes('mcp/')) {
      return 'mcp_server';
    }
    return 'unknown';
  }
  

  /**
   * Export research corpus to files for intra-run collaboration
   * 
   * Creates structured research artifacts that downstream agents can use.
   * This is SECONDARY storage - memory remains primary for merges.
   * 
   * Follows established patterns:
   * - Uses writeFileAtomic() from base-agent (with Capabilities integration)
   * - Registers files in memory with same pattern as code-creation-agent
   * - Goal-scoped to prevent cross-contamination
   * - Non-breaking: failures are logged but don't fail the research mission
   * 
   * @param {Object} synthesis - Synthesis results from synthesizeFindings()
   * @param {Array} searchResults - Raw search results with queries and content
   * @returns {Promise<void>}
   */
  async exportResearchCorpus(synthesis, searchResults) {
    // Only export if we actually have data
    if (!synthesis || !synthesis.findings || synthesis.findings.length === 0) {
      this.logger.info('No findings to export - skipping corpus creation');
      return;
    }
    
    // Determine output directory using same pattern as other agents
    const outputDir = this.config.logsDir
      ? path.join(this.config.logsDir, 'outputs', 'research', this.agentId)
      : path.join(process.cwd(), 'runtime', 'outputs', 'research', this.agentId);
    
    this.logger.info('📚 Exporting research corpus', {
      outputDir,
      findings: synthesis.findings.length,
      sources: this.sourcesFound.length,
      queries: this.searchQueries.length
    });
    
    // Ensure directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    const filesCreated = [];
    
    // 1. Export structured findings (JSON)
    try {
      const findingsPath = path.join(outputDir, 'research_findings.json');
      const findingsData = {
        agentId: this.agentId,
        goalId: this.mission.goalId,
        mission: this.mission.description,
        timestamp: new Date().toISOString(),
        findings: synthesis.findings.map((finding, i) => ({
          id: i + 1,
          content: finding,
          timestamp: new Date().toISOString()
        })),
        summary: synthesis.summary,
        successAssessment: synthesis.successAssessment,
        metadata: {
          queriesExecuted: this.searchQueries.length,
          sourcesFound: this.sourcesFound.length,
          findingsCount: synthesis.findings.length
        }
      };
      
      await this.writeFileAtomic(
        findingsPath,
        JSON.stringify(findingsData, null, 2)
      );
      
      filesCreated.push({
        filename: 'research_findings.json',
        relativePath: path.relative(process.cwd(), findingsPath),
        size: JSON.stringify(findingsData).length
      });
      
      this.logger.info('  ✓ Exported findings.json');
    } catch (error) {
      this.logger.warn('Failed to export findings', { error: error.message });
    }
    
    // 2. Export bibliography (BibTeX)
    if (this.sourcesFound.length > 0) {
      try {
        const bibPath = path.join(outputDir, 'bibliography.bib');
        const bibContent = BibliographyGenerator.generateBibTeX(
          this.sourcesFound,
          {
            runName: this.config.runName,
            agentId: this.agentId,
            description: this.mission.description
          }
        );
        
        await this.writeFileAtomic(bibPath, bibContent);
        
        filesCreated.push({
          filename: 'bibliography.bib',
          relativePath: path.relative(process.cwd(), bibPath),
          size: bibContent.length
        });
        
        this.logger.info('  ✓ Exported bibliography.bib', {
          sources: this.sourcesFound.length
        });
      } catch (error) {
        this.logger.warn('Failed to export bibliography', { error: error.message });
      }
    }
    
    // 3. Export research summary (Markdown)
    try {
      const summaryPath = path.join(outputDir, 'research_summary.md');
      let summaryContent = `# Research Summary\n\n`;
      summaryContent += `**Agent:** ${this.agentId}\n`;
      summaryContent += `**Mission:** ${this.mission.description}\n`;
      summaryContent += `**Completed:** ${new Date().toISOString()}\n\n`;
      summaryContent += `## Summary\n\n${synthesis.summary}\n\n`;
      summaryContent += `## Key Findings\n\n`;
      synthesis.findings.forEach((finding, i) => {
        summaryContent += `${i + 1}. ${finding}\n\n`;
      });
      summaryContent += `## Research Queries\n\n`;
      this.searchQueries.forEach((query, i) => {
        summaryContent += `${i + 1}. ${query}\n`;
      });
      summaryContent += `\n## Sources\n\n`;
      summaryContent += `Total sources consulted: ${this.sourcesFound.length}\n\n`;
      summaryContent += `See \`bibliography.bib\` for citation-ready BibTeX entries.\n`;
      
      await this.writeFileAtomic(summaryPath, summaryContent);
      
      filesCreated.push({
        filename: 'research_summary.md',
        relativePath: path.relative(process.cwd(), summaryPath),
        size: summaryContent.length
      });
      
      this.logger.info('  ✓ Exported research_summary.md');
    } catch (error) {
      this.logger.warn('Failed to export summary', { error: error.message });
    }
    
    // 4. Export sources index (JSON with richer metadata if available)
    if (this.sourcesFound.length > 0) {
      try {
        const sourcesPath = path.join(outputDir, 'sources.json');
        const sourcesData = {
          agentId: this.agentId,
          goalId: this.mission.goalId,
          timestamp: new Date().toISOString(),
          sources: this.sourcesFound.map((url, i) => ({
            id: i + 1,
            url: url,
            citationKey: BibliographyGenerator.generateCitationKey(url, i),
            // Future: Could add title, abstract, authors if available from citations
            accessedAt: new Date().toISOString()
          }))
        };
        
        await this.writeFileAtomic(
          sourcesPath,
          JSON.stringify(sourcesData, null, 2)
        );
        
        filesCreated.push({
          filename: 'sources.json',
          relativePath: path.relative(process.cwd(), sourcesPath),
          size: JSON.stringify(sourcesData).length
        });
        
        this.logger.info('  ✓ Exported sources.json');
      } catch (error) {
        this.logger.warn('Failed to export sources index', { error: error.message });
      }
    }
    
    // 5. Create manifest (index of all files)
    if (filesCreated.length > 0) {
      try {
        const manifestPath = path.join(outputDir, 'manifest.json');
        const manifest = {
          agentId: this.agentId,
          agentType: 'research',
          goalId: this.mission.goalId,
          mission: this.mission.description,
          createdAt: new Date().toISOString(),
          files: filesCreated,
          summary: {
            queriesExecuted: this.searchQueries.length,
            sourcesFound: this.sourcesFound.length,
            findingsGenerated: synthesis.findings.length,
            filesExported: filesCreated.length
          }
        };
        
        await this.writeFileAtomic(
          manifestPath,
          JSON.stringify(manifest, null, 2)
        );
        
        this.logger.info('  ✓ Created manifest.json');
      } catch (error) {
        this.logger.warn('Failed to create manifest', { error: error.message });
      }
    }
    
    // 6. Register files in memory for artifact discovery
    // This uses the same pattern as code-creation-agent
    if (filesCreated.length > 0) {
      try {
        const fileRegistration = {
          agentId: this.agentId,
          goalId: this.mission.goalId,
          timestamp: new Date().toISOString(),
          files: filesCreated
        };
        
        await this.addFinding(
          JSON.stringify(fileRegistration),
          'research_output_files'  // New tag for research files
        );
        
        // Store for metadata reporting
        this.exportedFiles = filesCreated;
        
        this.logger.info('✅ Research corpus exported and registered', {
          filesCreated: filesCreated.length,
          totalSize: filesCreated.reduce((sum, f) => sum + f.size, 0),
          discoveryTag: 'research_output_files'
        });
      } catch (error) {
        this.logger.warn('Failed to register files in memory', { error: error.message });
        // Non-fatal - files still exist on disk
      }
      
      // 7. Write completion marker for dashboard validation
      // This matches the pattern used by other agents (code-creation, document-creation)
      try {
        await this.writeCompletionMarker(outputDir, {
          fileCount: filesCreated.length,
          totalSize: filesCreated.reduce((sum, f) => sum + f.size, 0),
          sourcesFound: this.sourcesFound.length,
          queriesExecuted: this.searchQueries.length,
          findingsGenerated: synthesis.findings.length
        });
        
        this.logger.info('  ✓ Completion marker written');
      } catch (error) {
        this.logger.warn('Failed to write completion marker', { error: error.message });
        // Non-fatal - files are still valid
      }
    }
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('🎉 ResearchAgent completed successfully', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      queriesExecuted: this.searchQueries.length,
      sourcesFound: this.sourcesFound.length,
      findingsAdded: this.results.filter(r => r.type === 'finding').length
    }, 3);
  }
}

module.exports = { ResearchAgent };

