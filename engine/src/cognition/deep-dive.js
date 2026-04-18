/**
 * Deep Dive — Phase 2 of the four-phase thinking-machine pipeline
 *
 * Takes a discovery candidate and broad graph context, lets the LLM think
 * with no grammar forced, no persona. Output is a raw thought that will be
 * passed to the connect (PGS) phase and then critique.
 *
 * See docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md Phase 2.
 */

'use strict';

const DEFAULT_CONFIG = {
  neighborhoodHops: 2,        // how many graph hops around candidate to include
  maxNeighborhoodNodes: 40,   // cap on context volume
  maxTokens: 4000,            // generous output budget
  temperature: 0.8,           // leans toward surprising rather than safe
  conversationWindowMs: 24 * 60 * 60 * 1000, // last 24h of conversation
};

class DeepDive {
  /**
   * @param {object} opts
   * @param {object} opts.unifiedClient
   * @param {object} opts.memory - NetworkMemory
   * @param {object} opts.logger
   * @param {object} [opts.config]
   * @param {Function} [opts.getConversationContext] - returns recent conversation summary (stub until Phase 7)
   */
  constructor(opts = {}) {
    if (!opts.unifiedClient) throw new Error('DeepDive requires unifiedClient');
    if (!opts.memory) throw new Error('DeepDive requires memory');
    this.unifiedClient = opts.unifiedClient;
    this.memory = opts.memory;
    this.logger = opts.logger || console;
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    this.getConversationContext = opts.getConversationContext || (() => null);
  }

  /**
   * Run a deep-dive cycle against a discovery candidate.
   *
   * @param {object} candidate - from DiscoveryEngine
   * @param {object} temporalContext - current jtr-time context
   * @param {object} [priorPass] - optional revision framing from critique feedback
   * @param {string} priorPass.previousThought - text of the earlier pass
   * @param {object} priorPass.critique - the critique verdict that triggered revision
   * @returns {Promise<{text, referencedNodes, usage}>}
   */
  async think(candidate, temporalContext, priorPass = null) {
    const started = Date.now();

    // 1. Gather broad graph context around the candidate's referenced nodes
    const seedNodeIds = candidate.nodeIds || [];
    const neighborhood = this._gatherNeighborhood(seedNodeIds);

    // 2. Build prompt: candidate + neighborhood + conversation + temporal + revision framing
    const { instructions, input } = this._buildPrompt(candidate, neighborhood, temporalContext, priorPass);

    // 3. Single LLM call, no grammar forced
    let response;
    try {
      response = await this.unifiedClient.generate({
        component: 'deepDive',
        purpose: priorPass ? 'revise' : 'think',
        instructions,
        messages: [{ role: 'user', content: input }],
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });
    } catch (err) {
      this.logger.warn?.('[deep-dive] LLM call failed', { error: err?.message });
      return {
        text: '',
        referencedNodes: seedNodeIds,
        usage: { durationMs: Date.now() - started, error: err?.message },
      };
    }

    const text = response?.content || '';
    const referencedNodes = this._extractReferencedNodes(text, neighborhood.nodes);

    return {
      text,
      referencedNodes,
      reasoning: response?.reasoning || null,
      usage: {
        durationMs: Date.now() - started,
        neighborhoodSize: neighborhood.nodes.length,
        model: response?.model || null,
      },
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  _gatherNeighborhood(seedNodeIds) {
    const visited = new Set();
    const nodes = [];
    const edges = [];

    // Validate seed nodes exist
    const validSeeds = seedNodeIds.filter(id => this.memory.nodes.has(id));
    for (const id of validSeeds) {
      visited.add(id);
    }

    // N-hop expansion
    let frontier = new Set(visited);
    for (let h = 0; h < this.config.neighborhoodHops; h++) {
      const next = new Set();
      for (const edgeKey of this.memory.edges.keys()) {
        const [a, b] = edgeKey.split('->');
        if (frontier.has(a) && !visited.has(b)) next.add(b);
        if (frontier.has(b) && !visited.has(a)) next.add(a);
      }
      for (const id of next) {
        if (visited.size >= this.config.maxNeighborhoodNodes) break;
        visited.add(id);
      }
      if (visited.size >= this.config.maxNeighborhoodNodes || next.size === 0) break;
      frontier = next;
    }

    // Collect node payloads
    for (const id of visited) {
      const n = this.memory.nodes.get(id);
      if (!n) continue;
      nodes.push({
        id,
        concept: typeof n.concept === 'string' ? n.concept : String(n.concept || ''),
        tag: n.tag,
        cluster: n.cluster,
        created: n.created,
      });
    }

    // Collect internal edges
    for (const [edgeKey, edge] of this.memory.edges.entries()) {
      const [a, b] = edgeKey.split('->');
      if (visited.has(a) && visited.has(b)) {
        edges.push({ source: a, target: b, weight: edge.weight });
      }
    }

    return { nodes, edges, seedCount: validSeeds.length };
  }

  _buildPrompt(candidate, neighborhood, temporalContext, priorPass) {
    const conversation = this.getConversationContext?.();
    const t = temporalContext?.jtrTime;
    const isRevision = Boolean(priorPass && priorPass.previousThought);

    // The instructions lean on the "free the mind" ethos. No grammar,
    // no persona, no forbidden-topic list. The brain thinks about what's
    // weird in the graph.
    const instructions = isRevision
      ? `You are the thinking phase of a persistent agent whose job is to mine its own knowledge graph for genuine insight. An earlier pass produced a thought; the critique function flagged specific gaps. Your job now is to address those gaps — not rewrite from scratch, not restate, not defensively re-argue. If the gaps reveal that the earlier thought was actually restatement or shallow, SAY SO plainly. Silence and "nothing new here after reconsidering" are honest outputs.

Style: substantive, connected, honest. No preamble. No action tags. Just think.`
      : `You are the thinking phase of a persistent agent whose job is to mine its own knowledge graph for genuine insight. You are NOT reporting on assigned surfaces. You are NOT playing a role.

The discovery engine just surfaced a candidate worth examining. Your job: think about it carefully, using the graph neighborhood provided. Make real connections. Notice what's weird, what's missing, what doesn't fit. If the candidate is dressed-up restatement of something you've said before, say so. Silence and "nothing new here" are honest outputs.

Style: substantive, connected, honest. No preamble. No action tags. No "I notice that." Just think.`;

    const temporalBlock = t ? `## When it is
- Absolute: ${temporalContext.now}
- Jtr's time: ${t.phase} ${t.dayType} (${t.dayName}), workweek phase: ${t.workweekPhase || 'none'}
- Active rhythms: ${(t.activeRhythms || []).join(', ') || 'none'}
- Loop has been running: ${humanDuration(temporalContext.loopDuration?.continuousRunMs)}
- Last conversation with jtr: ${humanDuration(temporalContext.loopDuration?.lastConversationMs)} ago` : '';

    const candidateBlock = `## Discovery candidate
Signal: ${candidate.signal}
Score: ${candidate.score?.toFixed?.(2)}
Rationale: ${candidate.rationale || '(no rationale)'}
Referenced nodes: ${(candidate.nodeIds || []).slice(0, 10).join(', ') || '(none)'}
Cluster: ${candidate.clusterId ?? 'unknown'}`;

    const neighborhoodBlock = `## Graph neighborhood (${neighborhood.nodes.length} nodes, ${neighborhood.edges.length} internal edges)
${neighborhood.nodes.slice(0, 30).map(n => `- [${n.id}${n.cluster != null ? ` · c${n.cluster}` : ''}${n.tag ? ` · ${n.tag}` : ''}] ${(n.concept || '').slice(0, 200)}`).join('\n')}`;

    const conversationBlock = conversation
      ? `## Recent conversation (last 24h)\n${conversation}`
      : '';

    const revisionBlock = isRevision ? `## Prior pass this cycle
Earlier thought:
"""
${String(priorPass.previousThought || '').slice(0, 2000)}
"""

Critique verdict: ${priorPass.critique?.verdict || 'revise'} (confidence ${priorPass.critique?.confidence?.toFixed?.(2) || '?'})
Critique rationale: ${priorPass.critique?.rationale || '(no rationale)'}
Gaps flagged by critique:
${(priorPass.critique?.gaps || []).map(g => `- ${g}`).join('\n') || '(none)'}

Address these gaps concretely. If they expose that the thought is actually restatement or shallow, say so.` : '';

    const input = [temporalBlock, candidateBlock, neighborhoodBlock, conversationBlock, revisionBlock]
      .filter(Boolean)
      .join('\n\n') + (isRevision ? '\n\nThink again — addressing the gaps above.' : '\n\nThink.');

    return { instructions, input };
  }

  _extractReferencedNodes(text, contextNodes) {
    const refs = new Set();
    const validIds = new Set(contextNodes.map(n => String(n.id)));
    const rx = /\b(?:node|n)[\s:]?(\w{2,})/gi;
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (validIds.has(m[1])) refs.add(m[1]);
    }
    return Array.from(refs);
  }
}

function humanDuration(ms) {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

module.exports = { DeepDive };
