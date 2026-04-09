const { UnifiedClient } = require('../core/unified-client');

/**
 * Memory Summarizer - GPT-5.2 Version
 * Uses GPT-5.2's extended reasoning for intelligent summarization
 */
class MemorySummarizer {
  constructor(config, logger, fullConfig = null) {
    this.config = config;
    this.logger = logger;
    // Use fullConfig if provided, otherwise assume config IS the full config
    this.fullConfig = fullConfig || config;
    this.gpt5 = new UnifiedClient(this.fullConfig, logger);
    
    this.summaryCache = new Map();
    this.consolidationHistory = [];
    this.summaryThreshold = 20;
    this.tokenThreshold = 4000;
  }

  /**
   * Summarize recent thoughts using GPT-5.2 with reasoning
   */
  async summarizeRecentThoughts(journal, startIdx = 0) {
    if (!journal || journal.length < this.summaryThreshold) {
      return null;
    }

    const entriesToSummarize = journal.slice(startIdx);
    
    if (entriesToSummarize.length < 5) {
      return null;
    }

    const thoughtText = entriesToSummarize
      .map((entry, idx) => `[${startIdx + idx}] ${entry.thought || entry.output}`)
      .join('\n\n');

    const response = await this.gpt5.generate({
      component: 'memorySummarizer',
      purpose: 'thoughtSummarization',
      instructions: `Summarize these AI thoughts into a concise, information-dense memory entry.

INCLUDE:
- Discovered facts, data points, statistics, and evidence
- Analytical conclusions and interpretive insights
- Cross-domain connections and contradictions found
- Decisions made and their rationale
- Key findings from research, analysis, or synthesis

EXCLUDE (do not include in summary):
- Operational status updates (agent started/finished, files processed, bytes written)
- Error messages, timeouts, or retry information
- File paths, batch numbers, or process IDs
- Self-referential statements about the thinking process itself
- Platitudes or generic observations without specific content

Preserve specific facts. Be information-dense. Every sentence should teach something.`,
      messages: [{ role: 'user', content: thoughtText }],
      maxTokens: 800,
      reasoningEffort: 'low' // Summarization is efficient with low reasoning
    });

    const summary = response.content.trim();
    const topics = await this.extractTopics(summary);

    const summaryEntry = {
      type: 'summary',
      content: summary,
      reasoning: response.reasoning, // GPT-5.2's reasoning about the summary
      sourceEntries: entriesToSummarize.length,
      sourceRange: { start: startIdx, end: startIdx + entriesToSummarize.length },
      timestamp: new Date(),
      topics,
      model: response.model
    };

    this.logger?.info('Journal summarized (GPT-5.2)', {
      entries: entriesToSummarize.length,
      summaryLength: summary.length,
      hasReasoning: Boolean(response.reasoning),
      topics
    });

    return summaryEntry;
  }

  /**
   * Extract topics using GPT-5-mini (fast)
   */
  async extractTopics(text) {
    try {
      const response = await this.gpt5.generateFast({
        instructions: 'Extract 2-4 topic keywords from the text. Return only comma-separated keywords.',
        messages: [{ role: 'user', content: text }],
        max_completion_tokens: 1024 // API minimum for gpt-5-mini (was 50 - too low!)
      });

      const topics = response.content
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);

      return topics.slice(0, 4);
    } catch (error) {
      return [];
    }
  }

  /**
   * Consolidate memories using GPT-5.2 with web search for validation
   * OPTIMIZATION: Marks source nodes with consolidatedAt to prevent re-processing
   */
  async consolidateMemories(memoryNetwork, similarityThreshold = 0.75) {
    const nodes = Array.from(memoryNetwork.nodes.values());
    
    if (nodes.length < 10) {
      return [];
    }

    const clusters = await this.clusterSimilarMemories(nodes, similarityThreshold);
    const consolidations = [];
    const consolidationTimestamp = new Date().toISOString();

    for (const cluster of clusters) {
      if (cluster.length >= 3) {
        const consolidated = await this.createConsolidatedMemoryGPT5(cluster);
        
        if (consolidated) {
          consolidations.push({
            consolidated: consolidated.content,
            reasoning: consolidated.reasoning,
            sourceNodes: cluster.map(n => n.id),
            model: consolidated.model
          });

          // Mark source nodes as consolidated to prevent re-processing
          // This is critical for forked/merged runs
          for (const node of cluster) {
            node.consolidatedAt = consolidationTimestamp;
          }

          this.logger?.info('Memories consolidated (GPT-5.2)', {
            sourceCount: cluster.length,
            hasReasoning: Boolean(consolidated.reasoning),
            topics: cluster.map(n => n.tag)
          });
        }
      }
    }

    this.consolidationHistory.push({
      timestamp: new Date(),
      consolidations: consolidations.length,
      totalMemories: nodes.length
    });

    return consolidations;
  }

  /**
   * Create consolidated memory using GPT-5.2 extended reasoning
   */
  async createConsolidatedMemoryGPT5(cluster) {
    const concepts = cluster.map(n => n.concept).join('\n\n');

    try {
      const response = await this.gpt5.generate({
        component: 'memorySummarizer',
        purpose: 'memoryConsolidation',
        instructions: `Synthesize these related memory entries into a single, higher-level insight.

Focus on: What do these entries collectively REVEAL that no single entry shows alone?
Capture: The emerging pattern, trend, or conclusion.
Preserve: Specific evidence, numbers, and named entities that support the synthesis.
Avoid: Operational details (agent names, file paths, processing status, error messages).

The result should be a standalone insight valuable to someone who never saw the source entries.`,
        messages: [{ role: 'user', content: concepts }],
        maxTokens: 12000, // Abstraction requires reasoning about commonalities
        reasoningEffort: 'medium' // Medium for insightful abstraction - already correct
      });

      // Validate response
      if (!response || !response.content || response.content.trim().length === 0) {
        this.logger?.warn('GPT-5.2 consolidation returned empty content');
        return null;
      }

      return {
        content: response.content.trim(),
        reasoning: response.reasoning,
        model: response.model
      };
    } catch (error) {
      this.logger?.error('Failed to create consolidated memory', {
        error: error.message,
        clusterSize: cluster.length
      });
      return null; // Return null instead of error object
    }
  }

  /**
   * Cluster similar memories
   * OPTIMIZATION: Filters out already-consolidated nodes to prevent O(n²) re-processing
   * on forked/merged runs that inherit thousands of already-processed memories.
   */
  async clusterSimilarMemories(nodes, threshold) {
    // Filter out nodes that have already been consolidated
    // This is critical for forked/merged runs to avoid re-processing inherited memories
    const unconsolidatedNodes = nodes.filter(n => !n.consolidatedAt);
    
    if (unconsolidatedNodes.length < nodes.length) {
      this.logger?.info?.('Filtered consolidated nodes from clustering', {
        total: nodes.length,
        unconsolidated: unconsolidatedNodes.length,
        skipped: nodes.length - unconsolidatedNodes.length
      });
    }
    
    // If all nodes are already consolidated, nothing to do
    if (unconsolidatedNodes.length < 3) {
      return [];
    }
    
    const clusters = [];
    const used = new Set();

    for (let i = 0; i < unconsolidatedNodes.length; i++) {
      if (used.has(i)) continue;

      const cluster = [unconsolidatedNodes[i]];
      used.add(i);

      for (let j = i + 1; j < unconsolidatedNodes.length; j++) {
        if (used.has(j)) continue;

        // Skip nodes with null embeddings
        if (!unconsolidatedNodes[i].embedding || !unconsolidatedNodes[j].embedding) {
          this.logger?.debug?.('Skipping similarity check for node with null embedding in summarizer', {
            nodeI: i,
            nodeJ: j,
            hasIEmbedding: Boolean(unconsolidatedNodes[i].embedding),
            hasJEmbedding: Boolean(unconsolidatedNodes[j].embedding)
          });
          continue;
        }

        const similarity = this.cosineSimilarity(
          unconsolidatedNodes[i].embedding,
          unconsolidatedNodes[j].embedding
        );

        if (similarity >= threshold) {
          cluster.push(unconsolidatedNodes[j]);
          used.add(j);
        }
      }

      if (cluster.length >= 3) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Memory garbage collection - ULTRA-CONSERVATIVE VERSION
   *
   * IMPORTANT: This was previously too aggressive and deleted valuable nodes
   * from merged/forked brains. The old logic deleted nodes that were "old and
   * never accessed" - but for inherited nodes, "never accessed" just means
   * "never accessed by THIS brain instance", not "worthless".
   *
   * New ultra-conservative approach:
   * - Only delete nodes that are TRULY garbage (extremely low weight + very stale)
   * - Protected tags are NEVER deleted
   * - Consolidated nodes are NEVER deleted
   * - Merged/inherited nodes are NEVER deleted
   * - Default: 2 YEARS (730 days) minimum before considering deletion
   * - Pass minAccessAgeDays = Infinity to disable time-based GC entirely
   * - Never delete based purely on accessCount === 0
   *
   * The weight system handles relevance - low-weight nodes just won't be
   * retrieved. There's rarely a good reason to actually DELETE knowledge.
   */
  garbageCollect(memoryNetwork, minWeight = 0.01, minAccessAgeDays = 730) {
    const now = Date.now();
    const toRemove = [];
    const minAccessAgeMs = minAccessAgeDays * 24 * 60 * 60 * 1000;

    // Protected tags that should NEVER be garbage collected
    const protectedTags = new Set([
      'agent_insight', 'agent_finding', 'mission_plan', 'cross_agent_pattern',
      'consolidated', 'breakthrough', 'synthesis', 'goal', 'milestone',
      'research', 'analysis', 'important', 'core', 'foundation',
      'execution_result', 'execution_failure', 'capability_gap', 'disconfirmation'
    ]);

    let skippedProtected = 0;
    let skippedConsolidated = 0;
    let skippedMerged = 0;
    let skippedWeight = 0;
    let skippedRecent = 0;

    for (const [id, node] of memoryNetwork.nodes) {
      // NEVER delete consolidated nodes
      if (node.consolidatedAt) {
        skippedConsolidated++;
        continue;
      }

      // NEVER delete merged/inherited nodes (from merge_runs.js)
      // These have sourceRuns, mergedAt, inheritedArtifact, or domain markers
      if (node.sourceRuns || node.mergedAt || node.inheritedArtifact ||
          (node.domain && node.domain !== 'unknown')) {
        skippedMerged++;
        continue;
      }

      // NEVER delete nodes with protected tags
      if (node.tag && protectedTags.has(node.tag)) {
        skippedProtected++;
        continue;
      }

      // Only consider nodes with VERY low weight
      if (node.weight >= minWeight) {
        skippedWeight++;
        continue;
      }

      // Handle both Date objects and string timestamps (from loaded state)
      const accessedTime = node.accessed instanceof Date
        ? node.accessed.getTime()
        : (node.accessed ? new Date(node.accessed).getTime() : now);

      const accessAge = now - accessedTime;

      // Only delete if not accessed in a VERY long time (180+ days by default)
      // AND weight is below threshold
      // This means: truly abandoned, low-value nodes only
      if (accessAge < minAccessAgeMs) {
        skippedRecent++;
        continue;
      }

      // If we get here, node is:
      // - Not consolidated
      // - Not protected tag
      // - Very low weight (< 0.01)
      // - Not accessed in 180+ days
      // This is truly garbage
      toRemove.push(id);
    }

    // Actually remove the garbage nodes
    for (const id of toRemove) {
      memoryNetwork.nodes.delete(id);

      // Clean up edges properly for both numeric and string IDs
      const edgesToRemove = [];
      for (const [edgeKey, edge] of memoryNetwork.edges) {
        let source, target;
        if (edge.source !== undefined && edge.target !== undefined) {
          source = edge.source;
          target = edge.target;
        } else {
          const parts = edgeKey.split('->');
          source = isNaN(parts[0]) ? parts[0] : Number(parts[0]);
          target = isNaN(parts[1]) ? parts[1] : Number(parts[1]);
        }

        if (source == id || target == id) {
          edgesToRemove.push(edgeKey);
        }
      }

      for (const edgeKey of edgesToRemove) {
        memoryNetwork.edges.delete(edgeKey);
      }
    }

    if (toRemove.length > 0 || this.logger?.level === 'debug') {
      this.logger?.info('🗑️ Memory GC (conservative)', {
        removed: toRemove.length,
        remaining: memoryNetwork.nodes.size,
        skipped: {
          protected: skippedProtected,
          consolidated: skippedConsolidated,
          merged: skippedMerged,
          goodWeight: skippedWeight,
          recentAccess: skippedRecent
        }
      });
    }

    return toRemove.length;
  }

  /**
   * Recursive summarization
   */
  async recursiveSummarization(journal, levelsDeep = 3) {
    let currentLevel = journal;
    const summaryTree = [];

    for (let level = 0; level < levelsDeep; level++) {
      if (currentLevel.length < this.summaryThreshold) {
        break;
      }

      const levelSummaries = [];

      for (let i = 0; i < currentLevel.length; i += this.summaryThreshold) {
        const chunk = currentLevel.slice(i, i + this.summaryThreshold);
        const summary = await this.summarizeRecentThoughts(chunk, i);
        
        if (summary) {
          levelSummaries.push(summary);
        }
      }

      summaryTree.push({
        level,
        summaries: levelSummaries.length,
        sourceEntries: currentLevel.length
      });

      currentLevel = levelSummaries;

      this.logger?.info('Summary level completed (GPT-5.2)', {
        level,
        summaries: levelSummaries.length,
        reduction: (levelSummaries.length / journal.length * 100).toFixed(1) + '%'
      });
    }

    return summaryTree;
  }

  cosineSimilarity(a, b) {
    // Handle undefined inputs gracefully
    if (!a || !b || !Array.isArray(a) || !Array.isArray(b)) {
      this.logger?.warn?.('Cosine similarity called with invalid inputs', {
        a: typeof a,
        b: typeof b,
        aIsArray: Array.isArray(a),
        bIsArray: Array.isArray(b)
      });
      return 0;
    }

    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getStats() {
    return {
      summariesCreated: this.summaryCache.size,
      consolidations: this.consolidationHistory.length,
      recentConsolidation: this.consolidationHistory.slice(-1)[0] || null,
      usingGPT5: true,
      extendedReasoning: true
    };
  }
}

module.exports = { MemorySummarizer };

