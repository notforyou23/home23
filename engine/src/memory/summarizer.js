const { UnifiedClient } = require('../core/unified-client');

const DEFAULT_CONSOLIDATION_MAX_NODES = 80;
const DEFAULT_CONSOLIDATION_MAX_CHARS = 50000;
const DEFAULT_CONSOLIDATION_MAX_CONCEPT_CHARS = 600;
const DEFAULT_CONSOLIDATION_MAX_CLUSTERS_PER_RUN = 4;
const COMPOST_MODES = new Set(['off', 'dry-run', 'apply']);

/**
 * Memory Summarizer - GPT-5.5 Version
 * Uses GPT-5.5's extended reasoning for intelligent summarization
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
    const consolidation = this.fullConfig?.memory?.consolidation || this.config?.consolidation || {};
    this.consolidationMaxNodes = Number.isFinite(consolidation.maxClusterPromptNodes)
      ? consolidation.maxClusterPromptNodes
      : DEFAULT_CONSOLIDATION_MAX_NODES;
    this.consolidationMaxChars = Number.isFinite(consolidation.maxClusterPromptChars)
      ? consolidation.maxClusterPromptChars
      : DEFAULT_CONSOLIDATION_MAX_CHARS;
    this.consolidationMaxConceptChars = Number.isFinite(consolidation.maxConceptChars)
      ? consolidation.maxConceptChars
      : DEFAULT_CONSOLIDATION_MAX_CONCEPT_CHARS;
    this.consolidationMaxClustersPerRun = Number.isFinite(consolidation.maxClustersPerRun)
      ? consolidation.maxClustersPerRun
      : DEFAULT_CONSOLIDATION_MAX_CLUSTERS_PER_RUN;
  }

  /**
   * Summarize recent thoughts using GPT-5.5 with reasoning
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
      model: 'gpt-5.4-mini', // Use mini - more reliable, less prone to incomplete responses
      instructions: `Summarize these AI thoughts into a concise, information-dense memory entry. 
Capture key insights, decisions, patterns, and learnings. Preserve important facts.`,
      messages: [{ role: 'user', content: thoughtText }],
      maxTokens: 800,
      reasoningEffort: 'low' // Summarization is efficient with low reasoning
    });

    const summary = response.content.trim();
    const topics = await this.extractTopics(summary);

    const summaryEntry = {
      type: 'summary',
      content: summary,
      reasoning: response.reasoning, // GPT-5.5's reasoning about the summary
      sourceEntries: entriesToSummarize.length,
      sourceRange: { start: startIdx, end: startIdx + entriesToSummarize.length },
      timestamp: new Date(),
      topics,
      model: response.model
    };

    this.logger?.info('Journal summarized (GPT-5.5)', {
      entries: entriesToSummarize.length,
      summaryLength: summary.length,
      hasReasoning: Boolean(response.reasoning),
      topics
    });

    return summaryEntry;
  }

  /**
   * Extract topics using GPT-5.4-mini (fast)
   */
  async extractTopics(text) {
    try {
      const response = await this.gpt5.generateFast({
        instructions: 'Extract 2-4 topic keywords from the text. Return only comma-separated keywords.',
        messages: [{ role: 'user', content: text }],
        max_completion_tokens: 1024 // API minimum for gpt-5.4-mini (was 50 - too low!)
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
   * Consolidate memories using GPT-5.5 with web search for validation
   * OPTIMIZATION: Marks source nodes with consolidatedAt to prevent re-processing
   */
  async consolidateMemories(memoryNetwork, similarityThreshold = 0.75, options = {}) {
    const nodes = Array.from(memoryNetwork.nodes.values());
    
    if (nodes.length < 10) {
      return [];
    }

    const clusters = await this.clusterSimilarMemories(nodes, similarityThreshold);
    const consolidations = [];
    const consolidationTimestamp = new Date().toISOString();
    const maxClustersPerRun = Math.max(
      1,
      Number.isFinite(options.maxClustersPerRun)
        ? options.maxClustersPerRun
        : this.consolidationMaxClustersPerRun
    );
    const compostMode = this.resolveCompostMode(options);
    const compostDryRun = { wouldRemoveSourceNodes: 0, clusters: 0 };
    let attemptedClusters = 0;

    for (const cluster of clusters) {
      if (attemptedClusters >= maxClustersPerRun) break;

      if (cluster.length >= 3) {
        attemptedClusters++;
        const consolidated = await this.createConsolidatedMemoryGPT5(cluster);
        
        if (consolidated) {
          if (typeof memoryNetwork.patchNodes !== 'function') {
            throw new Error('memory_node_patch_api_required');
          }
          // Provider work yields. Require the exact source identities to remain
          // current before publishing either the consolidated marker or result.
          // The following check and patch are synchronous, so no other turn can
          // replace a node between them.
          const sourceStillCurrent = cluster.every((node) => memoryNetwork.nodes.get(node.id) === node);
          if (!sourceStillCurrent) {
            this.logger?.warn?.('Memory consolidation discarded after source changed', {
              sourceCount: cluster.length,
            });
            continue;
          }
          const patched = memoryNetwork.patchNodes(cluster.map((node) => ({
            nodeId: node.id,
            expectedNode: node,
            patch: { consolidatedAt: consolidationTimestamp },
          })));
          if (Number(patched?.updated || 0) !== cluster.length) {
            this.logger?.warn?.('Memory consolidation discarded after incomplete source commit', {
              sourceCount: cluster.length,
              updated: Number(patched?.updated || 0),
            });
            continue;
          }

          const compost = this.buildCompostPlan(cluster, compostMode);
          if (compost.mode === 'dry-run') {
            compostDryRun.wouldRemoveSourceNodes += compost.wouldRemoveSourceNodes;
            compostDryRun.clusters += 1;
          }

          const consolidationRecord = {
            consolidated: consolidated.content,
            reasoning: consolidated.reasoning,
            sourceNodes: cluster.map(n => n.id),
            model: consolidated.model,
            compost
          };
          // The summary node is embedded after this method returns, so another
          // turn can replace a source record before compost finalization. Keep
          // exact in-process identities off the serialized result surface and
          // require them when deciding which current records are still safe to
          // remove.
          Object.defineProperty(consolidationRecord, 'sourceIdentityTokens', {
            configurable: false,
            enumerable: false,
            writable: false,
            value: new Map(cluster.map((node) => [node.id, node])),
          });
          consolidations.push(consolidationRecord);

          this.logger?.info('Memories consolidated (GPT-5.5)', {
            sourceCount: cluster.length,
            hasReasoning: Boolean(consolidated.reasoning),
            topics: cluster.map(n => n.tag),
            compostMode: compost.mode,
            compostWouldRemoveSourceNodes: compost.wouldRemoveSourceNodes
          });
        }
      }
    }

    this.consolidationHistory.push({
      timestamp: new Date(),
      consolidations: consolidations.length,
      totalMemories: nodes.length,
      attemptedClusters,
      eligibleClusters: clusters.length,
      deferredClusters: Math.max(0, clusters.length - attemptedClusters),
      ...(compostDryRun.clusters > 0 ? { compostDryRun } : {})
    });

    if (compostDryRun.clusters > 0) {
      this.logger?.info?.('Consolidation compost dry-run complete', compostDryRun);
    }

    if (clusters.length > attemptedClusters) {
      this.logger?.info?.('Consolidation run deferred remaining clusters', {
        attemptedClusters,
        eligibleClusters: clusters.length,
        deferredClusters: clusters.length - attemptedClusters,
        maxClustersPerRun
      });
    }

    return consolidations;
  }

  resolveCompostMode(options = {}) {
    const requested = options.compostSources
      || options.compostMode
      || this.fullConfig?.memory?.consolidation?.compostSources
      || this.config?.consolidation?.compostSources
      || process.env.HOME23_MEMORY_COMPOST_MODE
      || 'off';
    const normalized = String(requested === true ? 'dry-run' : requested || 'off').toLowerCase();
    return COMPOST_MODES.has(normalized) ? normalized : 'off';
  }

  buildCompostPlan(cluster, mode) {
    const sourceNodes = cluster
      .map(node => node?.id)
      .filter(id => id !== undefined && id !== null);
    const activeMode = mode === 'apply' ? 'ready' : mode;
    return {
      mode: activeMode,
      sourceNodes,
      wouldRemoveSourceNodes: sourceNodes.length
    };
  }

  finalizeConsolidationCompost(memoryNetwork, consolidation, options = {}) {
    const mode = String(options.mode || consolidation?.compost?.mode || 'off').toLowerCase();
    const sourceNodes = Array.isArray(consolidation?.sourceNodes)
      ? consolidation.sourceNodes.filter((id) => id !== undefined && id !== null)
      : (Array.isArray(consolidation?.compost?.sourceNodes)
        ? consolidation.compost.sourceNodes.filter((id) => id !== undefined && id !== null)
        : []);
    const summaryNodeId = options.summaryNodeId ?? null;

    if (!sourceNodes.length || mode === 'off') {
      return { mode: 'off', removedSourceNodes: 0, skippedSourceNodes: sourceNodes.length };
    }

    if (mode === 'dry-run' || consolidation?.compost?.mode === 'dry-run') {
      this.logger?.info?.('Consolidation compost dry-run', {
        summaryNodeId,
        wouldRemoveSourceNodes: sourceNodes.length
      });
      return {
        mode: 'dry-run',
        wouldRemoveSourceNodes: sourceNodes.length,
        removedSourceNodes: 0,
        skippedSourceNodes: sourceNodes.length
      };
    }

    if (mode !== 'apply') {
      return { mode, removedSourceNodes: 0, skippedSourceNodes: sourceNodes.length };
    }

    if (!summaryNodeId || !options.confirmedDryRunAt) {
      this.logger?.warn?.('Consolidation compost apply blocked; dry-run confirmation and summary node are required', {
        summaryNodeId,
        hasConfirmedDryRunAt: Boolean(options.confirmedDryRunAt),
        sourceNodes: sourceNodes.length
      });
      return {
        mode: 'blocked',
        reason: 'dry_run_confirmation_required',
        removedSourceNodes: 0,
        skippedSourceNodes: sourceNodes.length
      };
    }

    const summaryNode = memoryNetwork?.nodes?.get?.(summaryNodeId);
    if (!summaryNode) {
      this.logger?.warn?.('Consolidation compost apply blocked; summary node not found', {
        summaryNodeId,
        sourceNodes: sourceNodes.length
      });
      return {
        mode: 'blocked',
        reason: 'summary_node_not_found',
        removedSourceNodes: 0,
        skippedSourceNodes: sourceNodes.length
      };
    }

    const pendingMetadata = {
      ...(summaryNode.metadata || {}),
      consolidationProvenance: {
        sourceNodes,
        plannedSourceCount: sourceNodes.length,
        compostedSourceNodes: [],
        compostedSourceCount: 0,
        compostStatus: 'pending',
        confirmedDryRunAt: options.confirmedDryRunAt,
        model: consolidation?.model || null
      }
    };
    if (typeof memoryNetwork.patchNode !== 'function') {
      throw new Error('memory_node_patch_api_required');
    }
    const updatedSummaryNode = memoryNetwork.patchNode(summaryNodeId, { metadata: pendingMetadata }, {
      expectedNode: summaryNode,
    });
    if (!updatedSummaryNode) {
      return {
        mode: 'blocked',
        reason: 'summary_node_changed',
        removedSourceNodes: 0,
        skippedSourceNodes: sourceNodes.length
      };
    }

    if (typeof memoryNetwork.removeNodes !== 'function') {
      throw new Error('memory_node_remove_api_required');
    }
    const removableSourceNodes = Array.from(new Set(
      sourceNodes.filter((sourceNodeId) => sourceNodeId !== summaryNodeId),
    ));
    const sourceIdentityTokens = consolidation?.sourceIdentityTokens instanceof Map
      ? consolidation.sourceIdentityTokens
      : null;
    const identityChangedSourceNodes = [];
    const identitySafeSourceNodes = removableSourceNodes.filter((sourceNodeId) => {
      if (!sourceIdentityTokens) return true;
      const current = memoryNetwork.nodes.get(sourceNodeId);
      if (!sourceIdentityTokens.has(sourceNodeId) || current !== sourceIdentityTokens.get(sourceNodeId)) {
        identityChangedSourceNodes.push(sourceNodeId);
        return false;
      }
      return true;
    });
    const presentBefore = identitySafeSourceNodes.filter((sourceNodeId) => memoryNetwork.nodes.has(sourceNodeId));
    memoryNetwork.removeNodes(identitySafeSourceNodes);
    const removedSourceNodes = presentBefore.filter((sourceNodeId) => !memoryNetwork.nodes.has(sourceNodeId));
    const removed = removedSourceNodes.length;
    const removedSourceNodeSet = new Set(removedSourceNodes);
    const skippedSourceNodes = removableSourceNodes.filter((sourceNodeId) => !removedSourceNodeSet.has(sourceNodeId));
    const skipped = skippedSourceNodes.length;
    const finalMetadata = {
      ...(updatedSummaryNode.metadata || pendingMetadata),
      consolidationProvenance: {
        ...pendingMetadata.consolidationProvenance,
        compostedSourceNodes: removedSourceNodes,
        compostedSourceCount: removed,
        skippedSourceNodes,
        skippedSourceCount: skipped,
        identityChangedSourceNodes,
        compostStatus: skipped > 0 ? 'complete_with_skips' : 'complete',
        compostedAt: new Date().toISOString(),
      },
    };
    const finalizedSummaryNode = memoryNetwork.patchNode(summaryNodeId, { metadata: finalMetadata }, {
      expectedNode: updatedSummaryNode,
    });
    if (!finalizedSummaryNode) {
      return {
        mode: 'partial',
        reason: 'provenance_finalize_failed',
        removedSourceNodes: removed,
        skippedSourceNodes: skipped,
        identityChangedSourceNodes,
        summaryNodeId,
      };
    }

    const finalMode = skipped > 0 ? 'partial' : 'apply';
    const reason = skipped > 0
      ? (identityChangedSourceNodes.length > 0 ? 'source_identity_changed' : 'source_removal_incomplete')
      : null;
    this.logger?.info?.('Consolidation compost finalized', {
      mode: finalMode,
      reason,
      summaryNodeId,
      removedSourceNodes: removed,
      skippedSourceNodes: skipped
    });

    return {
      mode: finalMode,
      ...(reason ? { reason } : {}),
      removedSourceNodes: removed,
      skippedSourceNodes: skipped,
      identityChangedSourceNodes,
      summaryNodeId
    };
  }

  /**
   * Create consolidated memory using GPT-5.5 extended reasoning
   */
  async createConsolidatedMemoryGPT5(cluster) {
    const prompt = this.buildConsolidationPrompt(cluster);

    try {
      const response = await this.gpt5.generate({
        model: 'gpt-5.5', // Use GPT-5.5 for deep consolidation/abstraction
        instructions: `Create a single, generalized abstract statement that captures the common insight 
across these related memory entries. This should be a higher-level understanding that encompasses 
the specific instances.`,
        messages: [{ role: 'user', content: prompt.content }],
        maxTokens: 12000, // Abstraction requires reasoning about commonalities
        reasoningEffort: 'medium' // Medium for insightful abstraction - already correct
      });

      // Validate response
      if (!response || !response.content || response.content.trim().length === 0) {
        this.logger?.warn('GPT-5.5 consolidation returned empty content');
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

  buildConsolidationPrompt(cluster) {
    const sorted = [...cluster].sort((a, b) => {
      const weightA = Number.isFinite(a?.weight) ? a.weight : 0;
      const weightB = Number.isFinite(b?.weight) ? b.weight : 0;
      return weightB - weightA;
    });

    const selected = [];
    let chars = 0;
    const maxNodes = Math.max(1, this.consolidationMaxNodes);
    const maxChars = Math.max(1000, this.consolidationMaxChars);
    const maxConceptChars = Math.max(100, this.consolidationMaxConceptChars);

    for (const node of sorted) {
      if (selected.length >= maxNodes) break;

      const concept = String(node?.concept || '').trim();
      if (!concept) continue;

      const truncated = concept.length > maxConceptChars
        ? `${concept.slice(0, maxConceptChars)}...`
        : concept;
      const line = `[${selected.length + 1}] ${truncated}`;
      const nextChars = chars + line.length + 2;

      if (selected.length > 0 && nextChars > maxChars) break;

      selected.push(line);
      chars = nextChars;
    }

    const omitted = Math.max(0, cluster.length - selected.length);
    if (omitted > 0) {
      selected.push(`[omitted] ${omitted} additional related memory entries were omitted to keep this consolidation request bounded.`);
      this.logger?.info?.('Large memory cluster compacted before consolidation', {
        clusterSize: cluster.length,
        selected: selected.length - 1,
        omitted,
        maxNodes,
        maxChars,
        maxConceptChars
      });
    }

    return {
      content: selected.join('\n\n'),
      selected: selected.length - (omitted > 0 ? 1 : 0),
      omitted
    };
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
   * Memory garbage collection
   */
  garbageCollect(memoryNetwork, minWeight = 0.1, maxAge = 30 * 24 * 60 * 60 * 1000) {
    // Disabled by default after repeated brain_node_count_stable regressions:
    // this routine deletes durable knowledge based on weak access heuristics,
    // and routine awake/sleep maintenance was bleeding thousands of nodes below
    // the high-water floor. Re-enable only with explicit config after a safer
    // archival/compaction policy exists.
    if (!this.config?.memory?.enableGarbageCollection) {
      this.logger?.info('Memory garbage collection skipped (disabled)', {
        remaining: memoryNetwork?.nodes?.size ?? 0,
      });
      return 0;
    }

    const now = Date.now();
    const toRemove = [];

    for (const [id, node] of memoryNetwork.nodes) {
      // Handle both Date objects and string timestamps (from loaded state)
      const createdTime = node.created instanceof Date 
        ? node.created.getTime() 
        : (node.created ? new Date(node.created).getTime() : now);
      
      const accessedTime = node.accessed instanceof Date 
        ? node.accessed.getTime() 
        : (node.accessed ? new Date(node.accessed).getTime() : now);

      const age = now - createdTime;
      const accessAge = now - accessedTime;

      if ((node.weight < minWeight && accessAge > 7 * 24 * 60 * 60 * 1000) ||
          (age > maxAge && node.accessCount === 0)) {
        toRemove.push(id);
      }
    }

    if (toRemove.length > 0) {
      if (typeof memoryNetwork.removeNodes !== 'function') {
        throw new Error('memory_node_remove_api_required');
      }
      memoryNetwork.removeNodes(toRemove);
    }

    this.logger?.info('Memory garbage collection (GPT-5.5)', {
      removed: toRemove.length,
      remaining: memoryNetwork.nodes.size
    });

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

      this.logger?.info('Summary level completed (GPT-5.5)', {
        level,
        summaries: levelSummaries.length,
        reduction: (levelSummaries.length / journal.length * 100).toFixed(1) + '%'
      });
    }

    return summaryTree;
  }

  cosineSimilarity(a, b) {
    // Handle undefined inputs gracefully
    const aIsVector = Array.isArray(a) || (ArrayBuffer.isView(a) && typeof a.length === 'number');
    const bIsVector = Array.isArray(b) || (ArrayBuffer.isView(b) && typeof b.length === 'number');
    if (!a || !b || !aIsVector || !bIsVector) {
      this.logger?.warn?.('Cosine similarity called with invalid inputs', {
        a: typeof a,
        b: typeof b,
        aIsVector,
        bIsVector
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
