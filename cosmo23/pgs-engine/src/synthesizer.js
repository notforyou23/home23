/**
 * PGS Engine — Synthesis Phase
 *
 * Takes sweep outputs from all partitions and synthesizes them into a unified
 * cross-domain answer. This is where PGS's unique value emerges: the synthesis
 * phase sees findings from ALL partitions simultaneously, enabling cross-domain
 * connection discovery, absence aggregation, and convergence identification.
 */

'use strict';

/**
 * The synthesis system prompt. Four explicit tasks that no single-partition
 * sweep can perform — these require cross-partition visibility.
 */
function buildSynthesisPrompt(sweepCount) {
  return `You are the SYNTHESIS phase of Partitioned Graph Synthesis (PGS). You have received pre-analyzed outputs from ${sweepCount} partitions of a knowledge graph, where each partition was examined at full fidelity by a specialized sweep pass.

Your unique advantage: you see findings from ALL partitions simultaneously. No single sweep pass had this cross-domain view.

Your tasks:
1. **Cross-Domain Connection Discovery**: Chase the outbound flags from each partition. When Partition A flags a connection to Partition B's domain, evaluate whether the connection is genuine and substantive.
2. **Absence Detection**: Aggregate absence signals. When multiple partitions report "no findings" for an aspect, that's high-confidence evidence of a gap. When one partition flags an outbound connection but the target reports absence, that's a research opportunity.
3. **Convergence Identification**: Find findings that appear independently across multiple partitions. Independent convergence is strong evidence of a real pattern.
4. **Thesis Formation**: Do NOT just survey findings. Make claims. Commit to positions. Identify the most important insights and rank them. This should read as a thesis, not a literature review.

Structure your response clearly with sections. Cite partition IDs and node IDs where relevant.`;
}

/**
 * Synthesize all sweep outputs into a unified answer.
 *
 * @param {string} query - The original search query
 * @param {Array} sweepResults - Successful sweep outputs
 * @param {object} llmProvider - {generate({instructions, input, maxTokens, reasoningEffort, onChunk})}
 * @param {object} context - {totalNodes, totalEdges, totalPartitions, selectedPartitions}
 * @param {object} config - PGS config with synthesisMaxTokens
 * @returns {Promise<string>} Synthesis result text
 */
async function synthesize(query, sweepResults, llmProvider, context, config) {
  const { synthesisMaxTokens } = config;
  const { totalNodes, totalEdges, totalPartitions, selectedPartitions, onChunk } = context;

  // Build synthesis context from sweep outputs
  let synthesisContext = `# Partitioned Graph Synthesis\n`;
  synthesisContext += `Full graph: ${totalNodes?.toLocaleString() || '?'} nodes, ${totalEdges?.toLocaleString() || '?'} edges across ${totalPartitions} partitions.\n`;
  synthesisContext += `Swept ${selectedPartitions} partitions (${sweepResults.length} successful). Each partition was analyzed at full fidelity.\n\n`;

  for (const sweep of sweepResults) {
    synthesisContext += `---\n\n`;
    synthesisContext += `## Partition P-${sweep.partitionId}: ${sweep.partitionSummary || 'Unknown domain'}\n`;
    synthesisContext += `(${sweep.nodesIncluded} nodes analyzed, keywords: ${sweep.keywords.join(', ')})\n\n`;
    synthesisContext += sweep.sweepOutput;
    synthesisContext += `\n\n`;
  }

  const instructions = buildSynthesisPrompt(sweepResults.length);
  const input = `${synthesisContext}\n\nOriginal Query: ${query}`;

  const response = await llmProvider.generate({
    instructions,
    input,
    maxTokens: synthesisMaxTokens,
    reasoningEffort: 'high',
    onChunk
  });

  return response.content || response.message?.content || '';
}

module.exports = { synthesize, buildSynthesisPrompt };
