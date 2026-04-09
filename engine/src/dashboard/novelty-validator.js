const { getOpenAIClient } = require('../core/openai-client');
const { UnifiedClient } = require('../core/unified-client');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const path = require('path');

/**
 * Novelty Validator
 * 
 * Validates whether insights are genuinely novel or just retrieval/hallucination.
 * Implements 4-test decision framework:
 * 1. Provenance (did it come from web search? - checks actual run logs)
 * 2. Reproducibility (stable across reruns? - uses embedding similarity)
 * 3. Embedding similarity (novel vs existing knowledge? - real corpus comparison)
 * 4. Idea density (high information content? - robust calculation)
 * 
 * Additive layer - doesn't modify existing insights, just adds validation metadata
 */
class NoveltyValidator {
  constructor(config, logger, logsDir) {
    this.config = config;
    this.logger = logger;
    this.logsDir = logsDir || path.join(__dirname, '..', '..', 'runtime');
    this.client = getOpenAIClient();
    this.gpt5 = new UnifiedClient(config, logger);
    
    // Thresholds (configurable)
    this.embeddingCosineThreshold = 0.75; // Below this = novel
    this.ideaDensityPercentile = 80; // Top 20% = high density
    this.reproducibilityMinRuns = 3; // Run 3x to test stability
    this.reproducibilityEmbeddingThreshold = 0.80; // Semantic overlap for reproducibility
    
    // Scoring weights (total = 100)
    this.weights = {
      provenance: 20,
      reproducibility: 30,
      embeddingNovelty: 35,
      ideaDensity: 15
    };
    
    // LRU-style cache for embeddings (with size limit)
    this.embeddingCache = new Map();
    this.embeddingCacheLimit = 200;
    
    // Historical baseline for idea density (loaded from existing data)
    this.ideaDensityBaseline = [];
    this.minBaselineSize = 50; // Minimum baseline size for reliable percentile
    
    // Memory embeddings index for novelty comparison
    this.memoryEmbeddingsIndex = null;
    
    // Initialize tokenizer for token-aware truncation
    try {
      const { encoding_for_model } = require('tiktoken');
      this.tokenizer = encoding_for_model('text-embedding-3-small');
      this.logger?.info?.('NoveltyValidator: Tokenizer initialized');
    } catch (error) {
      this.logger?.warn?.('NoveltyValidator: Failed to initialize tokenizer', {
        error: error.message
      });
      this.tokenizer = null;
    }
  }

  /**
   * Validate a single insight through all 4 tests
   * @param {Object} insight - Insight object with content and metadata
   * @returns {Object} Validation results with novelty score
   */
  async validateInsight(insight) {
    const validationResults = {
      insightId: insight.id || insight.agentId,
      content: insight.content || insight.thought,
      timestamp: new Date(),
      
      // Test results
      provenanceClean: null,
      reproducible: null,
      embeddingNovel: null,
      highIdeaDensity: null,
      
      // Scores
      noveltyScore: 0,
      confidence: 0,
      
      // Decision
      isNovelCandidate: false,
      escalate: false,
      
      // Details
      details: {}
    };

    try {
      // Test 1: Provenance Check
      validationResults.provenanceClean = await this.checkProvenance(insight);
      validationResults.details.provenance = validationResults.provenanceClean.details;

      // Test 2: Reproducibility 
      // CHANGED: Run even if provenance uncertain (for agent insights without full logs)
      // Only skip if provenance explicitly verified as retrieval
      const skipReproducibility = 
        validationResults.provenanceClean.details?.verifiedFromLog && 
        !validationResults.provenanceClean.passed;
      
      if (!skipReproducibility) {
        validationResults.reproducible = await this.checkReproducibility(insight);
        validationResults.details.reproducibility = validationResults.reproducible.details;
      } else {
        validationResults.reproducible = { passed: false, reason: 'Skipped (verified retrieval used)' };
      }

      // Test 3: Embedding Novelty
      validationResults.embeddingNovel = await this.checkEmbeddingNovelty(insight);
      validationResults.details.embedding = validationResults.embeddingNovel.details;

      // Test 4: Idea Density
      validationResults.highIdeaDensity = this.checkIdeaDensity(insight);
      validationResults.details.ideaDensity = validationResults.highIdeaDensity.details;

      // Calculate overall novelty score
      const scores = this.calculateNoveltyScore(validationResults);
      validationResults.noveltyScore = scores.noveltyScore;
      validationResults.confidence = scores.confidence;
      
      // Decision rule: All 4 tests must pass for candidate-emergent
      validationResults.isNovelCandidate = 
        validationResults.provenanceClean.passed &&
        validationResults.reproducible.passed &&
        validationResults.embeddingNovel.passed &&
        validationResults.highIdeaDensity.passed;
      
      // Escalate if candidate + high novelty score
      validationResults.escalate = 
        validationResults.isNovelCandidate && 
        validationResults.noveltyScore > 80;

      this.logger?.debug('Insight validated', {
        insightId: validationResults.insightId,
        noveltyScore: validationResults.noveltyScore,
        isNovelCandidate: validationResults.isNovelCandidate,
        escalate: validationResults.escalate
      });

      return validationResults;
      
    } catch (error) {
      this.logger?.error('Validation failed', {
        insightId: insight.id,
        error: error.message
      });
      
      return {
        ...validationResults,
        error: error.message,
        isNovelCandidate: false
      };
    }
  }

  /**
   * Test 1: Provenance Check
   * Determine if insight came from web search retrieval
   * FIXED: Checks actual run logs, not just metadata heuristics
   */
  async checkProvenance(insight) {
    // If we have agentId, check the actual agent result record
    if (insight.agentId || insight.id) {
      try {
        const agentResult = await this.loadAgentResult(insight.agentId || insight.id);
        
        if (agentResult) {
          // Check if agent used web search
          const agentType = agentResult.agentType?.toLowerCase() || 
                           agentResult.agent?.constructor.name?.replace(/Agent$/, '').toLowerCase();
          const usedWebSearch = agentType === 'research';
          
          // Check for web search sources in results
          const hasSources = agentResult.results?.some(r => 
            r.sources && r.sources.length > 0
          ) || false;
          
          const passed = !usedWebSearch && !hasSources;
          
          return {
            passed,
            reason: passed ? 'No retrieval used in agent run' : 'Agent used web retrieval',
            details: {
              agentType: agentResult.agentType,
              usedWebSearch,
              sourceCount: hasSources ? 'present' : 0,
              verifiedFromLog: true
            }
          };
        }
      } catch (error) {
        this.logger?.warn('Could not load agent result for provenance', {
          agentId: insight.agentId,
          error: error.message
        });
      }
    }
    
    // Fallback: Use metadata heuristics for thoughts/insights without runId
    const hasWebSources = insight.usedWebSearch || 
                          (insight.sources && insight.sources.length > 0) ||
                          insight.category === 'Web-Enhanced';
    
    const content = insight.content || insight.thought || '';
    const mentionsSources = content.match(/according to|source:|cited|reference:|retrieved from/i);
    
    const agentType = insight.agentType?.toLowerCase() || 'unknown';
    const fromResearch = agentType === 'research';
    
    // CHANGED: If from agent (not web-enhanced), give it a chance
    // Only fail if explicitly web-enhanced or research agent
    const explicitRetrieval = hasWebSources || fromResearch;
    const passed = !explicitRetrieval && !mentionsSources;
    
    return {
      passed,
      reason: passed ? 
        'No retrieval indicators (heuristic)' : 
        'Contains retrieval indicators',
      details: {
        hasWebSources,
        mentionsSources: !!mentionsSources,
        fromResearch,
        verifiedFromLog: false,
        note: 'Heuristic check - no run log available (not necessarily a fail)'
      }
    };
  }

  /**
   * Test 2: Reproducibility Check
   * Rerun idea generation at different temperatures to test stability
   * FIXED: Uses embedding similarity instead of word overlap
   */
  async checkReproducibility(insight) {
    const content = insight.content || insight.thought || '';
    
    if (content.length < 50) {
      return { passed: false, reason: 'Content too short for reproducibility test', details: {} };
    }

    try {
      // Create a deterministic prompt that asks for the same concept
      const testPrompt = `State the key idea: ${content.substring(0, 150)}`;
      
      // Run N times at temperature=0 (deterministic via reasoningEffort='low')
      const runs = [];
      
      for (let i = 0; i < this.reproducibilityMinRuns; i++) {
        try {
          const response = await this.withTimeout(
            this.gpt5.generate({
              model: 'gpt-5-mini',
              instructions: testPrompt,
              messages: [{ role: 'user', content: 'Restate this concept briefly (2-3 sentences)' }],
              maxTokens: 1500, // Increased from 300 - novelty validation needs analysis space
              reasoningEffort: 'low' // Low = most deterministic
            }),
            10000 // 10 second timeout
          );
          
          runs.push(response.content);
          
          // Rate limiting
          if (i < this.reproducibilityMinRuns - 1) {
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        } catch (error) {
          this.logger?.warn('Reproducibility run failed', { run: i, error: error.message });
          runs.push(null); // Mark failed run
        }
      }
      
      // Filter out failed runs
      const validRuns = runs.filter(r => r !== null);
      
      if (validRuns.length < 2) {
        return {
          passed: false,
          reason: 'Insufficient successful runs for comparison',
          details: { successfulRuns: validRuns.length, required: 2 }
        };
      }
      
      // Compare runs using EMBEDDING SIMILARITY (not word overlap)
      const emb0 = await this.getEmbedding(validRuns[0]);
      const emb1 = await this.getEmbedding(validRuns[1]);
      const semanticSimilarity = this.cosineSimilarity(emb0, emb1);
      
      // Pass if semantic similarity >= threshold (default 0.80)
      const passed = semanticSimilarity >= this.reproducibilityEmbeddingThreshold;
      
      return {
        passed,
        reason: passed ? 
          `Semantically stable (${(semanticSimilarity * 100).toFixed(0)}% similarity across runs)` : 
          `Semantically unstable (${(semanticSimilarity * 100).toFixed(0)}% < ${(this.reproducibilityEmbeddingThreshold * 100).toFixed(0)}%)`,
        details: {
          runs: validRuns.length,
          semanticSimilarity,
          threshold: this.reproducibilityEmbeddingThreshold,
          run1Preview: validRuns[0].substring(0, 100),
          run2Preview: validRuns[1].substring(0, 100)
        }
      };
      
    } catch (error) {
      this.logger?.warn('Reproducibility check failed', { error: error.message });
      return { 
        passed: false, 
        reason: `Check failed: ${error.message}`,
        details: { error: error.message }
      };
    }
  }

  /**
   * Test 3: Embedding Novelty Check
   * Compare insight embedding to existing memory/knowledge base
   * FIXED: Real corpus comparison against memory embeddings
   */
  async checkEmbeddingNovelty(insight) {
    const content = insight.content || insight.thought || '';
    
    if (content.length < 30) {
      return { passed: false, reason: 'Content too short for embedding', details: {} };
    }

    try {
      // Get embedding for insight
      const insightEmbedding = await this.getEmbedding(content);
      
      // Load memory embeddings index if not already loaded
      if (!this.memoryEmbeddingsIndex) {
        await this.buildMemoryEmbeddingsIndex();
      }
      
      // Find k-nearest neighbors in memory
      const k = 5;
      const nearest = this.findKNearestEmbeddings(insightEmbedding, k);
      
      // Calculate max cosine similarity
      const maxCosine = nearest.length > 0 ? 
        Math.max(...nearest.map(n => n.similarity)) : 
        0;
      
      const passed = maxCosine < this.embeddingCosineThreshold;
      
      return {
        passed,
        reason: passed ? 
          `Novel (max cosine ${maxCosine.toFixed(3)} < ${this.embeddingCosineThreshold})` : 
          `Similar to existing (max cosine ${maxCosine.toFixed(3)} >= ${this.embeddingCosineThreshold})`,
        details: {
          insightEmbeddingDim: insightEmbedding.length,
          maxCosine,
          threshold: this.embeddingCosineThreshold,
          nearestNeighbors: nearest.length,
          topMatches: nearest.slice(0, 3).map(n => ({
            concept: n.concept.substring(0, 80),
            similarity: n.similarity.toFixed(3)
          })),
          memoryIndexSize: this.memoryEmbeddingsIndex?.length || 0
        }
      };
      
    } catch (error) {
      this.logger?.warn('Embedding check failed', { error: error.message });
      return { 
        passed: false, 
        reason: `Check failed: ${error.message}`,
        details: { error: error.message }
      };
    }
  }

  /**
   * Test 4: Idea Density Check
   * Measure information content (content words / sentences)
   * FIXED: Calculates percentile against snapshot, requires minimum baseline
   */
  checkIdeaDensity(insight) {
    const content = insight.content || insight.thought || '';
    
    if (content.length < 50) {
      return { passed: false, reason: 'Content too short', details: {} };
    }

    // Count sentences (more robust)
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const sentenceCount = Math.max(1, sentences.length);
    
    // Count content words with robust stopword list
    const stopwords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'as', 'are', 'was', 'were',
      'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
      'will', 'would', 'should', 'could', 'may', 'might', 'can', 'to', 'of',
      'and', 'or', 'but', 'in', 'with', 'for', 'from', 'by', 'this', 'that',
      'it', 'they', 'them', 'their', 'there', 'here', 'where', 'when', 'why',
      'how', 'what', 'who', 'which', 'such', 'more', 'most', 'very', 'so',
      'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
      'once', 'also', 'than', 'only', 'just', 'now', 'some', 'any', 'all'
    ]);
    
    const words = content.toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));
    
    const contentWords = words.length;
    const ideaDensity = contentWords / sentenceCount;
    
    // FIXED: Check baseline size BEFORE calculating percentile
    if (this.ideaDensityBaseline.length < this.minBaselineSize) {
      // Add to baseline but don't pass/fail yet
      this.ideaDensityBaseline.push(ideaDensity);
      
      return {
        passed: false,
        reason: `Baseline too small (${this.ideaDensityBaseline.length}/${this.minBaselineSize})`,
        details: {
          contentWords,
          sentences: sentenceCount,
          ideaDensity,
          baselineSize: this.ideaDensityBaseline.length,
          required: this.minBaselineSize,
          note: 'Building baseline - check will activate once baseline >= 50'
        }
      };
    }
    
    // FIXED: Calculate percentile against SNAPSHOT (before adding current)
    const baselineSnapshot = [...this.ideaDensityBaseline];
    const sorted = baselineSnapshot.sort((a, b) => a - b);
    const percentileIndex = Math.floor(sorted.length * (this.ideaDensityPercentile / 100));
    const threshold = sorted[percentileIndex] || ideaDensity;
    
    // Calculate where current density falls in baseline
    const percentile = (sorted.filter(d => d <= ideaDensity).length / sorted.length) * 100;
    
    const passed = ideaDensity >= threshold;
    
    // NOW add to baseline after comparison
    this.ideaDensityBaseline.push(ideaDensity);
    if (this.ideaDensityBaseline.length > 1000) {
      this.ideaDensityBaseline.shift(); // Keep rolling window
    }
    
    return {
      passed,
      reason: passed ? 
        `High density (${ideaDensity.toFixed(1)} words/sentence, ${percentile.toFixed(0)}th percentile)` : 
        `Low density (${ideaDensity.toFixed(1)} words/sentence, ${percentile.toFixed(0)}th percentile < ${this.ideaDensityPercentile}th)`,
      details: {
        contentWords,
        sentences: sentenceCount,
        ideaDensity: ideaDensity.toFixed(1),
        percentile: percentile.toFixed(0),
        threshold: threshold.toFixed(1),
        baselineSize: this.ideaDensityBaseline.length
      }
    };
  }

  /**
   * Validate a batch of insights
   * @param {Array} insights - Array of insight objects
   * @returns {Array} Insights with validation metadata
   */
  async validateBatch(insights) {
    this.logger?.info('Starting novelty validation batch', {
      count: insights.length
    });

    const validated = [];
    
    for (let i = 0; i < insights.length; i++) {
      const insight = insights[i];
      
      try {
        const validation = await this.validateInsight(insight);
        
        validated.push({
          ...insight,
          validation,
          noveltyScore: validation.noveltyScore,
          isNovelCandidate: validation.isNovelCandidate,
          escalate: validation.escalate
        });
        
        // Rate limiting
        if (i < insights.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        this.logger?.error('Validation failed for insight', {
          insightId: insight.id,
          error: error.message
        });
        
        validated.push({
          ...insight,
          validation: {
            error: error.message,
            isNovelCandidate: false
          }
        });
      }
    }

    this.logger?.info('Batch validation complete', {
      total: validated.length,
      novel: validated.filter(v => v.isNovelCandidate).length,
      escalated: validated.filter(v => v.escalate).length
    });

    return validated;
  }

  /**
   * Filter and rank insights by novelty
   * @param {Array} validatedInsights - Insights with validation metadata
   * @returns {Object} Categorized insights
   */
  rankByNovelty(validatedInsights) {
    return {
      // Escalate - Highest novelty, all tests passed, worth immediate attention
      escalated: validatedInsights
        .filter(i => i.escalate)
        .sort((a, b) => (b.noveltyScore || 0) - (a.noveltyScore || 0)),
      
      // Novel candidates - All tests passed but lower score
      novelCandidates: validatedInsights
        .filter(i => i.isNovelCandidate && !i.escalate)
        .sort((a, b) => (b.noveltyScore || 0) - (a.noveltyScore || 0)),
      
      // Partial - Some tests passed
      partialNovelty: validatedInsights
        .filter(i => !i.isNovelCandidate && (i.noveltyScore || 0) > 50)
        .sort((a, b) => (b.noveltyScore || 0) - (a.noveltyScore || 0)),
      
      // Low novelty - Likely retrieval or recombination
      lowNovelty: validatedInsights
        .filter(i => (i.noveltyScore || 0) <= 50)
        .sort((a, b) => (b.noveltyScore || 0) - (a.noveltyScore || 0)),
      
      stats: {
        total: validatedInsights.length,
        escalated: validatedInsights.filter(i => i.escalate).length,
        novelCandidates: validatedInsights.filter(i => i.isNovelCandidate && !i.escalate).length,
        partial: validatedInsights.filter(i => !i.isNovelCandidate && (i.noveltyScore || 0) > 50).length,
        lowNovelty: validatedInsights.filter(i => (i.noveltyScore || 0) <= 50).length
      }
    };
  }

  /**
   * Calculate overall novelty score from validation results
   * FIXED: Uses weighted scoring (not equal weights)
   */
  calculateNoveltyScore(validationResults) {
    let score = 0;
    let passedTests = 0;
    const totalTests = 4;
    const reasons = [];
    
    // Provenance (20 points)
    if (validationResults.provenanceClean?.passed) {
      score += this.weights.provenance;
      passedTests++;
      reasons.push('provenance:clean');
    } else {
      reasons.push(`provenance:${validationResults.provenanceClean?.reason || 'unknown'}`);
    }
    
    // Reproducibility (30 points - higher weight)
    if (validationResults.reproducible?.passed) {
      score += this.weights.reproducibility;
      passedTests++;
      reasons.push('reproducibility:stable');
    } else {
      reasons.push(`reproducibility:${validationResults.reproducible?.reason || 'unknown'}`);
    }
    
    // Embedding novelty (35 points - highest weight)
    if (validationResults.embeddingNovel?.passed) {
      score += this.weights.embeddingNovelty;
      passedTests++;
      reasons.push('embedding:novel');
    } else {
      reasons.push(`embedding:${validationResults.embeddingNovel?.reason || 'unknown'}`);
    }
    
    // Idea density (15 points - lowest weight)
    if (validationResults.highIdeaDensity?.passed) {
      score += this.weights.ideaDensity;
      passedTests++;
      reasons.push('density:high');
    } else {
      reasons.push(`density:${validationResults.highIdeaDensity?.reason || 'unknown'}`);
    }
    
    // Confidence = float 0.0-1.0 representing test passage rate
    const confidence = passedTests / totalTests;
    
    return { 
      noveltyScore: score, 
      confidence: parseFloat((confidence * 100).toFixed(1)), // Return as percentage
      passedTests,
      totalTests,
      reasons // Structured reasons array
    };
  }

  /**
   * Helper: Get embedding from OpenAI with LRU caching
   * FIXED: LRU-style cache with size limit, token-aware truncation
   */
  async getEmbedding(text) {
    // Token-aware truncation before checking cache
    let processedText = text;
    if (this.tokenizer) {
      const tokens = this.tokenizer.encode(text);
      const maxTokens = 8191;
      
      if (tokens.length > maxTokens) {
        this.logger?.warn?.('NoveltyValidator: Text exceeds token limit, truncating', {
          originalTokens: tokens.length,
          truncatedTo: maxTokens
        });
        processedText = this.tokenizer.decode(tokens.slice(0, maxTokens));
      }
    } else {
      // Fallback to character-based truncation
      if (text.length > 30000) {
        processedText = text.substring(0, 30000);
      }
    }
    
    // Check cache with processed text
    if (this.embeddingCache.has(processedText)) {
      // Move to end (LRU)
      const embedding = this.embeddingCache.get(processedText);
      this.embeddingCache.delete(processedText);
      this.embeddingCache.set(processedText, embedding);
      return embedding;
    }
    
    try {
      // Use same dimensions as memory (512) for proper comparison
      const response = await this.withTimeout(
        this.client.embeddings.create({
          model: 'text-embedding-3-small',
          input: processedText,
          dimensions: 512 // Match memory node dimensions
        }),
        15000 // 15 second timeout
      );
      
      const embedding = response.data[0].embedding;
      
      // LRU eviction: Remove oldest if at limit
      if (this.embeddingCache.size >= this.embeddingCacheLimit) {
        const firstKey = this.embeddingCache.keys().next().value;
        this.embeddingCache.delete(firstKey);
      }
      
      this.embeddingCache.set(processedText, embedding);
      
      return embedding;
    } catch (error) {
      this.logger?.error('Embedding generation failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Load agent result from results queue - CURRENT RUN ONLY
   */
  async loadAgentResult(agentId) {
    const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
    
    try {
      // Get current run start time to filter old agents
      const { StateCompression } = require('../core/state-compression');
      const statePath = path.join(this.logsDir, 'state.json');
      let runStartTime = 0;
      
      try {
        const state = await StateCompression.loadCompressed(statePath);
        const currentCycle = state.cycleCount || 0;
        runStartTime = state.timestamp ? new Date(state.timestamp).getTime() - (currentCycle * 240000) : 0;
      } catch (e) {
        // If can't load state, don't filter (allow all)
      }
      
      const fileStream = createReadStream(resultsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const result = JSON.parse(line);
            if (result.agentId === agentId) {
              // Filter by run time if we have it
              if (runStartTime > 0 && result.endTime) {
                const agentTime = new Date(result.endTime).getTime();
                if (agentTime < runStartTime) {
                  continue; // Skip old run agents
                }
              }
              return result;
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      }
    } catch (error) {
      // File not found or read error
      this.logger?.debug('Could not read results queue', { error: error.message });
    }
    
    return null;
  }

  /**
   * Build index of memory embeddings for novelty comparison
   */
  async buildMemoryEmbeddingsIndex() {
    this.logger?.info('Building memory embeddings index...');
    
    try {
      const { StateCompression } = require('../core/state-compression');
      const statePath = path.join(this.logsDir, 'state.json');
      const state = await StateCompression.loadCompressed(statePath);
      
      if (!state.memory || !state.memory.nodes) {
        this.logger?.warn('No memory nodes found in state');
        this.memoryEmbeddingsIndex = [];
        return;
      }
      
      // Extract nodes with embeddings
      const nodesWithEmbeddings = state.memory.nodes
        .filter(n => n.embedding && Array.isArray(n.embedding))
        .map(n => ({
          id: n.id,
          concept: n.concept,
          embedding: n.embedding,
          tag: n.tag,
          activation: n.activation || 0
        }));
      
      this.memoryEmbeddingsIndex = nodesWithEmbeddings;
      
      this.logger?.info('Memory embeddings index built', {
        nodes: this.memoryEmbeddingsIndex.length
      });
      
    } catch (error) {
      this.logger?.warn('Failed to build memory index', { error: error.message });
      this.memoryEmbeddingsIndex = [];
    }
  }

  /**
   * Find k-nearest neighbors using brute-force cosine similarity
   */
  findKNearestEmbeddings(queryEmbedding, k = 5) {
    if (!this.memoryEmbeddingsIndex || this.memoryEmbeddingsIndex.length === 0) {
      return [];
    }
    
    // Calculate cosine similarity for all memory nodes
    const similarities = this.memoryEmbeddingsIndex.map(node => ({
      ...node,
      similarity: this.cosineSimilarity(queryEmbedding, node.embedding)
    }));
    
    // Sort by similarity descending and take top k
    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  /**
   * Timeout wrapper for async operations
   */
  async withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
      )
    ]);
  }

  /**
   * Helper: Calculate word overlap between two texts
   */
  calculateWordOverlap(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Helper: Calculate cosine similarity
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    if (normA === 0 || normB === 0) return 0;
    
    return dotProduct / (normA * normB);
  }

  /**
   * Get configuration summary
   */
  getConfig() {
    return {
      embeddingCosineThreshold: this.embeddingCosineThreshold,
      ideaDensityPercentile: this.ideaDensityPercentile,
      reproducibilityMinRuns: this.reproducibilityMinRuns,
      baselineSize: this.ideaDensityBaseline.length
    };
  }

  /**
   * Update thresholds
   */
  updateThresholds(config) {
    if (config.embeddingCosineThreshold !== undefined) {
      this.embeddingCosineThreshold = config.embeddingCosineThreshold;
    }
    if (config.ideaDensityPercentile !== undefined) {
      this.ideaDensityPercentile = config.ideaDensityPercentile;
    }
    if (config.reproducibilityMinRuns !== undefined) {
      this.reproducibilityMinRuns = config.reproducibilityMinRuns;
    }
  }
}

module.exports = { NoveltyValidator };

