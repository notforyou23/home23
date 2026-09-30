/**
 * Critique — Phase 4 of the four-phase thinking-machine pipeline
 *
 * A function (not a persona) that stress-tests the emergent thought against
 * the graph, conversation, temporal context, and PGS result. Emits a verdict
 * with confidence and specific gaps for recursion.
 *
 * Convergence-based self-termination: no hard pass count inside this module;
 * it runs ONE pass per call. The pipeline runner (thinking-machine.js) drives
 * recursion based on convergence heuristics (plateau + confidence delta).
 *
 * See docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md Phase 4.
 */

'use strict';

const { parseWithFallback } = require('../core/json-repair');

const DEFAULT_CONFIG = {
  maxTokens: 2500,
  temperature: 0.4,   // lower than deep-dive — critique should be grounded, not creative
};

class Critique {
  /**
   * @param {object} opts
   * @param {object} opts.unifiedClient
   * @param {object} opts.logger
   * @param {object} [opts.config]
   */
  constructor(opts = {}) {
    if (!opts.unifiedClient) throw new Error('Critique requires unifiedClient');
    this.unifiedClient = opts.unifiedClient;
    this.logger = opts.logger || console;
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  }

  /**
   * Run one critique pass.
   *
   * @param {object} args
   * @param {string} args.thought - current deep-dive output being evaluated
   * @param {object} [args.pgsResult] - result from connect phase
   * @param {object} [args.temporalContext]
   * @param {string} [args.conversationContext]
   * @param {object[]} [args.priorPasses] - earlier critique outputs in this cycle (for recursion awareness)
   * @param {object} [args.candidate] - original discovery candidate (so critique can sanity-check relevance)
   * @returns {Promise<{verdict, confidence, gaps, rationale, raw}>}
   */
  async evaluate(args = {}) {
    const { instructions, input } = this._buildPrompt(args);

    let response;
    try {
      response = await this.unifiedClient.generate({
        component: 'critique',
        purpose: 'evaluate',
        instructions,
        messages: [{ role: 'user', content: input }],
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });
    } catch (err) {
      this.logger.warn?.('[critique] LLM call failed', { error: err?.message });
      // Failure mode: force discard so the pipeline doesn't emit an un-critiqued thought
      return {
        verdict: 'discard',
        confidence: 0.5,
        gaps: [],
        rationale: `critique LLM call failed: ${err?.message}`,
        failure: 'provider_error',
        raw: null,
      };
    }

    const rawText = response?.content || '';
    return this._parseVerdict(rawText, response, args);
  }

  _buildPrompt(args) {
    const instructions = `You are the critique function of a persistent agent's thinking pipeline. You are NOT a persona. You are NOT "the critic." You are a function that stress-tests a thought against the graph and conversation to produce a verdict.

Your job:
1. Read the thought produced by the deep-dive phase.
2. Check it against the graph neighborhood and PGS connection output.
3. Decide: does this add a grounded connection, a worthwhile question, a useful contrast, or a clearer uncertainty? Practical action is optional. A tentative association can be worth keeping without pretending it is a fact.
4. If the thought adds understanding or opens a grounded inquiry and the verdict is stable → verdict: keep. An unresolved question can remain unresolved.
5. If worth refining but has specific missing angles → verdict: revise, list the gaps concretely.
6. If restatement, shallow, or doesn't survive scrutiny → verdict: discard. Silence is honest.

Output format (STRICT — JSON inside a markdown code block, no prose outside):

\`\`\`json
{
  "verdict": "keep" | "revise" | "discard",
  "confidence": <number in [0, 1]>,
  "rationale": "<1-3 sentences explaining why>",
  "gaps": ["<specific gap>", "..."],
  "agendaCandidates": [
    { "content": "<1-2 sentence actionable item>", "kind": "decision" | "question" | "idea", "topicTags": ["..."] }
  ],
  "ownerOutreach": null | { "category": "question" | "insight" | "action", "text": "<message in the resident's voice>", "reason": "<why this is worth contacting the owner now>", "evidenceRefs": ["<exact supplied reference>"], "attention": { "kind": "problem" | "recovery" | "progress" | "decision" | "connection", "consequence": "<specific grounded consequence making contact worthwhile>", "evidenceRefs": ["<subset of this message's exact references supporting that consequence>"] } },
  "residentInitiative": null | { "purpose": "action" | "exploration" | "question", "scope": "private_research" | "private_artifact" | "verification", "why": "<why this specific move is worthwhile now>", "nextMove": "<one bounded move with a named subject or artifact>", "stopCondition": "<what ends this move, including uncertainty or unavailable evidence>", "evidenceRefs": ["<exact supplied reference>"] }
}
\`\`\`

Notes on confidence:
- 0.0-0.3: strong signal — either this is clearly keep-worthy or clearly restatement
- 0.3-0.7: uncertain — probably needs revision
- 0.7-1.0: high confidence in whatever verdict you picked

Rules:
- Evaluate against the supplied material and conversation, respecting their source and correction labels. Narrative, historical material, external intake and hypotheses are not verified current facts. Creative associations need a real starting point, not operational proof or an invented personal story.
- If verdict is "keep" or "discard", gaps MUST be [].
- If verdict is "revise", gaps MUST be concrete, specific, and actionable by the deep-dive phase.
- agendaCandidates: ONLY on verdict "keep". Extract things that warrant jtr's attention — decisions to make, questions worth answering, concrete next-step ideas. MUST be [] on "discard" or "revise". 0-3 items typical. Each item: 1-2 short sentences, actionable, reference specific graph material where relevant. Leave agendaCandidates: [] if nothing genuinely actionable emerged — not every kept thought needs an agenda item.
- Do NOT emit agendaCandidates for broad theory prompts, graph archaeology, or open-ended "consider/explore/map/trace" questions unless they cash out into a named decision, a bounded investigation against a specific artifact, or a direct question to jtr that would change what gets built next.
- Prefer no agenda item over a vague one. If the thought is mainly interpretive/philosophical framing, agendaCandidates should usually be [].
- For Home23 specifically: agendaCandidates should overwhelmingly be operational. Good examples: fix a broken bridge, verify a stale sensor, resolve a recurring SyntaxError, audit a specific cron/process/log/API mismatch, or ask jtr for a decision that changes what gets built now. Bad examples: "follow this node", "map the mythology", "trace this theme", "answer what Home23 really is", "consider whether absence means X".
- A node id by itself is NOT enough to justify an agenda item. "Investigate node 77762" is only valid if tied to a concrete operational failure mode, artifact, or fix path.
- If the thought is fresh research, speculative synthesis, philosophy, or worldbuilding, keep the thought if it deserves to be kept — but agendaCandidates should be [].
- ownerOutreach is a separate, optional conversational act, independent of tasks, predictions, and agendaCandidates. Only on an explicit keep, propose a question worth asking, an insight worth sharing, or a concrete next action to discuss. Do not require every thought to be sent. Silence remains available.
- Outreach must use the actual conversation/material and exact references supplied below, with a concrete reason to contact the owner. Preserve uncertainty and historical/source labels. Never present a failed, superseded, or unverified hypothesis as a current fact. A tentative connection may be shared as a tentative connection. An action proposal is not a claim of completed work.
- Do not repeat an earlier outreach without new relevant evidence or owner contact. If the source does not support a useful message, set ownerOutreach to null. Never invent a source reference. MUST be null on revise or discard.
- For machine-derived outreach, attention is required: identify an actual actionable problem, meaningful recovery, verified progress, owner decision, or a meaningful connection to attributed owner context. A changed telemetry bucket makes a condition eligible for attention; it does not itself justify interrupting the owner. Normal RAM/CPU snapshots, fresh timestamps, routine sampling wishes, and repeating a proposed diagnostic are not consequences. Carry authorized diagnostics through the action path. Never invent impact on the owner's experience from machine numbers. A grounded connection needs actual contextual evidence in addition to telemetry.
- Use the durable attention history below as well as recent outreach. Owner corrections change subsequent judgment and conduct; a new correction/contact reference is not permission to repeat the corrected topic. Recovery from an acknowledged problem can be worth sharing; a routine reassurance without a prior meaningful problem is not. For other subjects attention is optional; worthwhile questions and tentative discoveries need not imitate an operational emergency.

- residentInitiative is optional and only valid on keep. Choose one useful bounded move when the supplied material gives it a concrete reason now. This path supports private research, a reversible private artifact, or verification through existing authorized tools. A named musical question, a useful practice draft, or investigating a specific unfinished responsibility can qualify. Interests need not pretend to be machine faults. Do not duplicate an agenda diagnostic or an existing execution. A plain connection or insight does not require initiative or a task.
- These scopes describe intent and grant no authority. Do not propose publication, external messages, purchases, destructive changes, production changes, credential access, or personal/medical decisions through this path. Quote exact supplied evidence, preserve uncertainty, reconcile owner corrections, declare a useful stopping point, and allow null. Do not propose routine sampling or repeat the same move just because a timestamp changed.

Do not pad. Do not restate the thought. Output the JSON block and nothing else.`;

    const priorBlock = Array.isArray(args.priorPasses) && args.priorPasses.length > 0
      ? `## Prior critique passes this cycle (${args.priorPasses.length})\n` + args.priorPasses.map((p, i) =>
          `### Pass ${i + 1}\nverdict: ${p.verdict} · confidence: ${p.confidence?.toFixed?.(2)}\nrationale: ${p.rationale}\ngaps: ${(p.gaps || []).join(' | ') || '(none)'}`
        ).join('\n\n') + '\n\nYou are now evaluating the revised thought. If the same gaps persist or the critique is starting to repeat itself, lean toward a verdict (keep OR discard) rather than another revise. Plateau = we\'ve extracted what\'s extractable.'
      : '';

    const candidateBlock = args.candidate ? `## Original discovery candidate
Signal: ${args.candidate.signal}
Score: ${args.candidate.score?.toFixed?.(2)}
Rationale: ${args.candidate.rationale}
Nodes: ${(args.candidate.nodeIds || []).slice(0, 10).join(', ')}` : '';

    const temporalBlock = args.temporalContext?.jtrTime
      ? `## Current temporal context
${args.temporalContext.jtrTime.phase} ${args.temporalContext.jtrTime.dayType}, rhythms: ${(args.temporalContext.jtrTime.activeRhythms || []).join(', ') || 'none'}`
      : '';

    const pgsBlock = args.pgsResult && args.pgsResult.available
      ? `## Connect-phase (PGS) output
Partitions touched: ${args.pgsResult.usage?.partitionsTouched || 0}
Candidate edges (${(args.pgsResult.candidateEdges || []).length}):
${(args.pgsResult.candidateEdges || []).slice(0, 5).map(e => `- ${e.from}→${e.to}: ${e.rationale?.slice(0, 150)}`).join('\n') || '(none)'}

Connection notes:
${(args.pgsResult.connectionNotes || []).slice(0, 3).map(n => `- ${n.text?.slice(0, 200)}`).join('\n') || '(none)'}

PGS answer:
${(args.pgsResult.answer || '').slice(0, 2000)}`
      : args.pgsResult?.note === 'skipped_isolated'
        ? `## Connect-phase (PGS) output
PGS was intentionally SKIPPED — the seed node is isolated (no cross-partition signal to find).

IMPORTANT: do not penalize the thought for lacking cross-partition connections. There were none to find. On isolated/novelty candidates the bar is different:
- KEEP if the thought extracts meaningful characterization, framing, or understanding of the seed content — especially if it grounds an observation about jtr's world.
- KEEP even if it partially restates the node, provided it adds genuine interpretive framing ("this is a particular kind of self-tracking practice", "this suggests X about his rhythm", etc.).
- DISCARD only if the thought is pure verbatim restatement with zero added framing, or if it drifts into meta-commentary about graph structure.
- REVISE if the framing is present but thin — ask for the specific connection to jtr's known world, patterns, or rhythms that makes the fresh content load-bearing.`
        : args.pgsResult
          ? `## Connect-phase (PGS) output\nPGS unavailable (${args.pgsResult.note || 'unknown'}). Evaluate the thought on its own merits; cross-partition absence is not a discard reason.`
          : '';

    const conversationBlock = args.conversationContext
      ? `## Recent conversation with jtr\n${args.conversationContext}`
      : '';

    const materialBlock = args.materialContext ? `## Source material and authority labels\n${args.materialContext}` : '';
    const livedBlock = args.livedContext ? `## Lived context and correction history (respect uncertainty and failure labels)\n${args.livedContext}` : '';
    const outreachBlock = `## Permitted outreach evidence references\n${(args.outreachEvidenceRefs || []).join('\n') || '(none; do not propose outreach)'}`;
    const recentOutreachBlock = (args.recentOutreach || []).length
      ? `## Recent owner outreach (delivery state, not proof it was read)\n${args.recentOutreach.map(item => `${item.status}: ${item.text}\nBasis: ${(item.evidenceRefs || []).join(', ')}`).join('\n\n')}` : '';
    const attentionBlock = args.ownerAttentionContext ? `## Durable owner attention history and current condition\n${args.ownerAttentionContext}` : '';
    const initiativeBlock = args.residentInitiativeContext ? `## Resident moves already admitted (execution state, not proof of the desired outcome)\n${args.residentInitiativeContext}\nContinue existing responsibility through its Work outcome path; do not create a new initiative by rewording the move or stop condition.` : '';

    const thoughtBlock = `## Thought to evaluate
${args.thought || '(empty thought)'}`;

    const input = [candidateBlock, temporalBlock, conversationBlock, materialBlock, livedBlock, thoughtBlock, pgsBlock, priorBlock, outreachBlock, recentOutreachBlock, attentionBlock, initiativeBlock]
      .filter(Boolean)
      .join('\n\n') + '\n\nEvaluate. Output the JSON verdict block only.';

    return { instructions, input };
  }

  _parseVerdict(rawText, response, args = {}) {
    let parsed;
    try {
      parsed = parseWithFallback(rawText, 'object');
    } catch (err) {
      this.logger.warn?.('[critique] failed to parse verdict JSON, forcing discard', {
        error: err?.message,
        sample: rawText.slice(0, 200),
      });
      return {
        verdict: 'discard',
        confidence: 0.5,
        gaps: [],
        rationale: `critique output could not be parsed: ${err?.message}`,
        failure: 'invalid_verdict',
        raw: rawText,
      };
    }

    const verdict = this._normalizeVerdict(parsed?.verdict);
    const confidence = this._normalizeConfidence(parsed?.confidence);
    const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps.filter(g => typeof g === 'string' && g.trim().length > 0) : [];
    const rationale = typeof parsed?.rationale === 'string' ? parsed.rationale : '';

    // Sanity enforcement: keep/discard must have empty gaps
    const finalGaps = (verdict === 'keep' || verdict === 'discard') ? [] : gaps;

    // Agenda candidates — only valid on keep
    let agendaCandidates = [];
    if (verdict === 'keep' && Array.isArray(parsed?.agendaCandidates)) {
      agendaCandidates = parsed.agendaCandidates
        .filter(a => a && typeof a === 'object' && typeof a.content === 'string' && a.content.trim().length > 0)
        .map(a => ({
          content: String(a.content).trim(),
          kind: ['decision', 'question', 'idea'].includes(a.kind) ? a.kind : 'idea',
          topicTags: Array.isArray(a.topicTags) ? a.topicTags.filter(t => typeof t === 'string') : [],
        }))
        .filter(a => this._isActionableAgendaCandidate(a));
    }

    const { normalizeOwnerOutreach } = require('./owner-outreach');
    const ownerOutreach = verdict === 'keep' ? normalizeOwnerOutreach(parsed?.ownerOutreach, args.outreachEvidenceRefs) : null;
    const { normalizeResidentInitiative } = require('./resident-initiative');
    const residentInitiative = verdict === 'keep' ? normalizeResidentInitiative(parsed?.residentInitiative, args.outreachEvidenceRefs) : null;
    return { verdict, confidence, gaps: finalGaps, rationale, agendaCandidates, ownerOutreach, residentInitiative, raw: rawText, model: response?.model || null };
  }

  _normalizeVerdict(v) {
    if (typeof v !== 'string') return 'discard';
    const lower = v.toLowerCase().trim();
    if (['keep', 'revise', 'discard'].includes(lower)) return lower;
    // Tolerate common synonyms
    if (['accept', 'commit', 'emit'].includes(lower)) return 'keep';
    if (['refine', 'rework', 'retry'].includes(lower)) return 'revise';
    if (['drop', 'reject', 'silence'].includes(lower)) return 'discard';
    return 'discard';
  }

  _normalizeConfidence(c) {
    const n = typeof c === 'number' ? c : parseFloat(c);
    if (!Number.isFinite(n)) return 0.5;
    if (n < 0) return 0;
    if (n > 1) return n > 1 && n <= 100 ? n / 100 : 1; // tolerate 0-100 scale
    return n;
  }

  _isActionableAgendaCandidate(item) {
    if (!item || typeof item.content !== 'string') return false;
    const text = item.content.trim();
    if (text.length < 24) return false;

    const lower = text.toLowerCase();
    const operationalAnchor = /(?:api\b|endpoint\b|dashboard\b|shortcut\b|health\b|sauna\b|pressure\b|sensor\b|bridge\b|pipeline\b|correlation\b|cron\b|pm2\b|process\b|syntaxerror\b|log\b|config\b|workflow\b|harness\b|chrome cdp\b|disk\b|port\b|recent\.md\b|heartbeat\.md\b|run-intraday-review\.js\b|brain-housekeeping\b|node count\b|regression\b)/i.test(text);
    const boundedArtifact = /(?:node\s+\d+.*(?:syntaxerror|pipeline|sensor|bridge|cron|health|dashboard|regression|metadata|corruption)|goal[_-]\d+|run-intraday-review\.js|lib\/time\.js|ettimehm|ticker-home23|health shortcut|shortcut bridge)/i.test(text);
    const directUserDecision = /^(clarify focus:|decide:|answer explicitly:|what should|which should|is jtr)/i.test(text);
    const broadTheoryPrompt = /^(consider|explore|trace|map|locate|look for|find any|corroborate|cross-reference|re-examine)\b/i.test(lower);
    const archeologyPrompt = /^(follow the node|map which other nodes|locate and read|answer explicitly: why is jtr|answer the stated question: what is the primary purpose|consider what deliberate absence|test whether home23 can be induced|re-examine the truncated node)/i.test(lower);

    if (archeologyPrompt) return false;
    if (broadTheoryPrompt && !operationalAnchor && !boundedArtifact && !directUserDecision) return false;
    if (item.kind === 'idea' && !operationalAnchor && !boundedArtifact && !directUserDecision) return false;
    if (!operationalAnchor && !boundedArtifact && !directUserDecision) return false;
    return true;
  }
}

module.exports = { Critique };
