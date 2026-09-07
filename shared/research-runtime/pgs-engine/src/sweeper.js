/**
 * PGS Engine — Sweep Phase
 *
 * Parallel full-fidelity analysis of individual partitions.
 * Each partition gets its own LLM call with all node content,
 * producing structured output: Domain State, Findings, Outbound Flags, Absences.
 */

'use strict';

// Maximum characters of node content per sweep (safety cap, ~125K tokens)
const MAX_CONTEXT_CHARS = 500000;

/**
 * The sweep system prompt. Each partition gets analyzed with this structure.
 * The 4-section response contract is the core innovation of PGS:
 * - Domain State: what this partition covers
 * - Findings: discoveries with node ID citations
 * - Outbound Flags: connections to other partitions
 * - Absences: what was searched for and NOT found
 */
function buildSweepPrompt(partitionNodeCount, totalPartitions) {
  return `You are analyzing ONE partition of a larger knowledge graph as part of Partitioned Graph Synthesis (PGS).
This partition contains ${partitionNodeCount} nodes. The full graph has ${totalPartitions > 1 ? 'many more partitions being analyzed in parallel' : 'this single partition'}.

Your job is to extract ALL information relevant to the query from THIS partition. Be thorough - the synthesis phase will combine your output with outputs from other partitions.

Respond with EXACTLY this structure:

## Domain State
A brief (2-3 sentence) summary of what this partition covers and its current research state relative to the query.

## Findings
List the key discoveries, quantitative results, and connections WITHIN this partition that are relevant to the query. For each finding, cite the Node ID(s) that support it.

## Outbound Flags
List specific, characterized connections you see to content that likely exists in OTHER partitions (see adjacent partition summaries below). Be specific: "Node X's discussion of [topic] has structural parallels to [adjacent partition topic]" -- not just "might relate."

## Absences
Explicitly state what was searched for and NOT found in this partition. "This partition contains no findings relevant to [aspect]" is valuable information for the synthesizer.`;
}

/**
 * Sweep all selected partitions with concurrency control.
 *
 * @param {string} query - The search query
 * @param {Array} selectedPartitions - Partitions to sweep
 * @param {Map} nodeMap - Map<String(nodeId), node>
 * @param {Array} edges - All graph edges
 * @param {Array} allPartitions - All enriched partitions (for adjacent context)
 * @param {object} llmProvider - {generate({instructions, input, maxTokens, reasoningEffort})}
 * @param {object} config - PGS config
 * @param {Function} [onEvent] - Event callback
 * @returns {Promise<Array<{status: string, value: object|null}>>}
 */
async function sweepPartitions(query, selectedPartitions, nodeMap, edges, allPartitions, llmProvider, config, onEvent) {
  const { maxConcurrentSweeps } = config;
  const results = [];
  const batches = [];
  const total = selectedPartitions.length;
  const emit = (event) => { if (onEvent) onEvent(event); };

  // Build partition index map for structured events
  const partitionIndexMap = new Map();
  selectedPartitions.forEach((p, i) => partitionIndexMap.set(p.id, i));

  // Split into batches of maxConcurrentSweeps
  for (let i = 0; i < selectedPartitions.length; i += maxConcurrentSweeps) {
    batches.push(selectedPartitions.slice(i, i + maxConcurrentSweeps));
  }

  let completedCount = 0;

  for (const batch of batches) {
    const batchPromises = batch.map(async (partition) => {
      const idx = partitionIndexMap.get(partition.id);
      const summary = (partition.summary || `Partition ${partition.id}`).substring(0, 60);

      try {
        emit({
          type: 'sweep_started',
          partitionIndex: idx,
          total,
          partitionId: partition.id,
          summary,
          nodeCount: partition.nodeCount,
          message: `Sweeping: ${summary} (${partition.nodeCount} nodes)`
        });

        const result = await sweepPartition(query, partition, nodeMap, edges, allPartitions, llmProvider, config);
        completedCount++;

        emit({
          type: 'sweep_complete',
          partitionIndex: idx,
          total,
          partitionId: partition.id,
          summary,
          completed: completedCount,
          message: `Complete (${completedCount}/${total}): ${summary}`
        });

        return result;
      } catch (error) {
        completedCount++;

        emit({
          type: 'sweep_failed',
          partitionIndex: idx,
          total,
          partitionId: partition.id,
          summary,
          error: error.message,
          completed: completedCount,
          message: `Failed (${completedCount}/${total}): ${summary}`
        });

        return null;
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Sweep a single partition at full fidelity.
 *
 * @param {string} query - The search query
 * @param {object} partition - Enriched partition {id, nodeIds, summary, keywords, adjacentPartitions}
 * @param {Map} nodeMap - Map<String(nodeId), node>
 * @param {Array} edges - All graph edges (unused directly, reserved for future)
 * @param {Array} allPartitions - All enriched partitions (for adjacent context)
 * @param {object} llmProvider - {generate({instructions, input, maxTokens, reasoningEffort})}
 * @param {object} config - PGS config with sweepMaxTokens
 * @returns {Promise<object>} Sweep result
 */
async function sweepPartition(query, partition, nodeMap, edges, allPartitions, llmProvider, config) {
  const { sweepMaxTokens } = config;

  // Build full-fidelity context for this partition
  const partitionNodes = partition.nodeIds
    .map(nid => nodeMap.get(nid))
    .filter(n => n && n.concept);

  // Sort by weight for best information ordering
  partitionNodes.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  // Build node context at full fidelity (no tier compression!)
  let nodeContext = '';
  let charCount = 0;

  for (const node of partitionNodes) {
    const nodeText = `[Node ${node.id}] (${node.tag || 'general'}, weight: ${(node.weight || 0).toFixed(2)})\n${node.concept}\n\n`;
    if (charCount + nodeText.length > MAX_CONTEXT_CHARS) break;
    nodeContext += nodeText;
    charCount += nodeText.length;
  }

  // Build adjacent partition summaries for peripheral vision
  let adjacentContext = '';
  if (partition.adjacentPartitions?.length > 0) {
    adjacentContext = '\n--- ADJACENT PARTITIONS (for cross-domain awareness) ---\n';
    for (const adj of partition.adjacentPartitions) {
      const adjPartition = allPartitions.find(p => p.id === adj.id);
      if (adjPartition) {
        adjacentContext += `Partition P-${adj.id} (${adj.sharedEdges} shared edges): ${adjPartition.summary || 'No summary'}\n`;
        if (adjPartition.keywords?.length > 0) {
          adjacentContext += `  Keywords: ${adjPartition.keywords.slice(0, 10).join(', ')}\n`;
        }
      }
    }
  }

  const instructions = buildSweepPrompt(partitionNodes.length, allPartitions.length);
  const input = `${nodeContext}\n${adjacentContext}\n\nQuery: ${query}`;

  const response = await llmProvider.generate({
    instructions,
    input,
    maxTokens: sweepMaxTokens,
    reasoningEffort: 'medium'
  });

  const content = response.content || response.message?.content || '';

  return {
    partitionId: partition.id,
    partitionSummary: partition.summary,
    nodeCount: partition.nodeCount,
    nodesIncluded: partitionNodes.length,
    keywords: partition.keywords?.slice(0, 10) || [],
    adjacentPartitions: partition.adjacentPartitions || [],
    sweepOutput: content
  };
}

module.exports = { sweepPartitions, sweepPartition, buildSweepPrompt, MAX_CONTEXT_CHARS };
