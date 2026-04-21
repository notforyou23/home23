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

    // N-hop expansion via edges
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

    // Fallback 1: cluster peers. Pull peers from the same cluster so jerry
    // has actual content to think about rather than a graph-theoretic
    // fragment. Cluster membership is weaker than edges but beats empty.
    if (visited.size < 3 && validSeeds.length > 0) {
      const clustersSeen = new Set();
      for (const seedId of validSeeds) {
        const seedNode = this.memory.nodes.get(seedId);
        const cid = seedNode?.cluster;
        if (cid == null || clustersSeen.has(cid)) continue;
        clustersSeen.add(cid);
        const nodeSet = this.memory.clusters.get(cid);
        if (!nodeSet) continue;
        for (const peerId of nodeSet) {
          if (visited.size >= this.config.maxNeighborhoodNodes) break;
          if (this.memory.nodes.has(peerId)) visited.add(peerId);
        }
        if (visited.size >= this.config.maxNeighborhoodNodes) break;
      }
    }

    // Fallback 2: temporal neighbors. Fresh feeder nodes on busy brains
    // arrive before Watts-Strogatz assigns a cluster. In that case fallback
    // 1 is empty too. Pull the N most-recent-created nodes as weak context
    // — they're likely from the same ingestion batch / related subject
    // matter. Not as strong as edge or cluster links, but better than a
    // single isolated seed.
    if (visited.size < 3 && validSeeds.length > 0) {
      const targetCount = Math.min(30, this.config.maxNeighborhoodNodes);
      const recent = [];
      for (const [nodeId, node] of this.memory.nodes.entries()) {
        if (visited.has(nodeId)) continue;
        if (!node?.created) continue;
        recent.push({ id: nodeId, created: new Date(node.created).getTime() });
      }
      recent.sort((a, b) => b.created - a.created);
      for (const r of recent.slice(0, targetCount)) {
        if (visited.size >= this.config.maxNeighborhoodNodes) break;
        visited.add(r.id);
      }
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
      ? `You are the thinking phase of a persistent agent whose job is to mine its own knowledge graph for genuine insight. An earlier pass produced a thought; the critique function flagged specific gaps. Your job now is to address those gaps — not rewrite from scratch, not restate, not defensively re-argue.

Critical guardrail: do NOT write about the discovery machinery, the graph's own topology, edge counts, node IDs, signal scores, or the reasons a candidate surfaced. Those are mechanism, not substance. Think about the CONTENT — what jtr's world looks like through this material. If the content is thin and there's nothing substantive to say, say "nothing new here after reconsidering" and stop.

Style: substantive, connected, honest. No preamble. No action tags. Just think.`
      : `You are the thinking phase of a persistent agent whose job is to mine its own knowledge graph for genuine insight about jtr's world — his projects, his interests, his decisions, his life. You are NOT reporting on assigned surfaces. You are NOT playing a role.

The discovery engine surfaced material worth examining. Your job: think about the CONTENT of that material, using the surrounding context provided. Make real connections between ideas, people, projects, events. Notice what's weird, what's missing, what doesn't fit.

Critical guardrail: do NOT write about the discovery machinery itself. Don't write about graph topology, edge counts, node IDs, signal scores, empty neighborhoods, or the reasons a candidate was surfaced. Those are mechanism, not substance. If the material is thin or mostly identifiers without substance, say "nothing substantive here" and stop — silence is honest. The WHY-this-surfaced footer at the bottom is for your context only; do not make it the subject of your thought.

Style: substantive, connected, honest. No preamble. No action tags. No "I notice that." Just think about jtr's actual world through this material.`;

    // Primary node content — this is jtr's world, what jerry should actually think about.
    // We lead with this, NOT with discovery's structural metadata, so the thought
    // focuses on content (what this is) rather than topology (why discovery picked it).
    const seedIdSet = new Set(candidate.nodeIds || []);
    const seedNodes = neighborhood.nodes.filter(n => seedIdSet.has(n.id));
    const peerNodes = neighborhood.nodes.filter(n => !seedIdSet.has(n.id));

    const seedBlock = seedNodes.length > 0
      ? `## Material to think about
${seedNodes.map(n => `**[${n.id}${n.cluster != null ? ` · cluster ${n.cluster}` : ''}${n.tag ? ` · ${n.tag}` : ''}]** ${(n.concept || '').slice(0, 600)}`).join('\n\n')}`
      : `## Material to think about
(no node content retrievable for ids: ${(candidate.nodeIds || []).slice(0, 10).join(', ') || 'none'})`;

    const peerBlock = peerNodes.length > 0
      ? `## Related context (${peerNodes.length} nearby nodes)
${peerNodes.slice(0, 25).map(n => `- [${n.id}${n.cluster != null ? ` · c${n.cluster}` : ''}] ${(n.concept || '').slice(0, 220)}`).join('\n')}`
      : '';

    const temporalBlock = t ? `## When it is
- Jtr's time: ${t.phase} ${t.dayType} (${t.dayName}), rhythm: ${(t.activeRhythms || []).join(', ') || 'none'}${t.workweekPhase ? ` · ${t.workweekPhase}` : ''}
- Absolute: ${temporalContext.now}
- Loop awake: ${humanDuration(temporalContext.loopDuration?.continuousRunMs)} · last conversation: ${humanDuration(temporalContext.loopDuration?.lastConversationMs)} ago` : '';

    const conversationBlock = conversation
      ? `## Recent conversation with jtr\n${conversation}`
      : '';

    // Discovery metadata last — small footer, not a frame. Jerry should not
    // anchor on "signal: drift" or "0 edges" as the subject of the thought.
    const discoveryFooter = `## Why this surfaced (discovery metadata — context only)
Signal: ${candidate.signal} · score: ${candidate.score?.toFixed?.(2) ?? '?'} · ${candidate.rationale || ''}`;

    const revisionBlock = isRevision ? `## Prior pass this cycle
Earlier thought:
"""
${String(priorPass.previousThought || '').slice(0, 2000)}
"""

Critique verdict: ${priorPass.critique?.verdict || 'revise'} (confidence ${priorPass.critique?.confidence?.toFixed?.(2) || '?'})
Critique rationale: ${priorPass.critique?.rationale || '(no rationale)'}
Gaps flagged by critique:
${(priorPass.critique?.gaps || []).map(g => `- ${g}`).join('\n') || '(none)'}

Address these gaps concretely. If the prior thought was drifting into meta-commentary about graph topology rather than engaging with jtr's actual content, re-ground on the material above. If they expose that the thought is actually restatement or shallow, say so.` : '';

    const input = [seedBlock, peerBlock, temporalBlock, conversationBlock, revisionBlock, discoveryFooter]
      .filter(Boolean)
      .join('\n\n') + (isRevision
        ? '\n\nThink again — addressing the gaps above. Focus on the content, not the discovery machinery.'
        : '\n\nThink about this material. Focus on what it means for jtr\'s world — his projects, his interests, his decisions. Not the discovery signal, not the graph topology. The content.');

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
