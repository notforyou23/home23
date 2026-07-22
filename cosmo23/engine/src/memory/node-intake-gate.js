'use strict';

/**
 * NodeIntakeGate — Fix 3.1: anti-slop persistence gates for NEW nodes.
 *
 * ONE choke point, applied inside NetworkMemory.addNode() and nowhere else.
 * Verified creation topology (2026-07-22 tree):
 *   - addNode() is the only LIVE creation path (agents/base-agent addFinding/
 *     addInsight, orchestrator thoughts/reasoning/summary/dream/consolidated,
 *     trajectory-fork, introspection, guided-mode-planner, execution-monitor,
 *     artifacts/*, ingestion-manifest).
 *   - Hydration/merge/load NEVER pass through addNode: loadState writes
 *     memory.nodes directly (orchestrator loadState + lib/memory-sidecar
 *     hydrateStateMemory), importGraphChanges() sets nodes directly, and
 *     merge/ has no addNode call. Those paths are exempt BY CONSTRUCTION —
 *     no trusted-flag plumbing is needed, and existing brains are never
 *     retroactively swept (G4).
 *   - Crash-recovery journal replay (orchestrator.replayAgentJournals) DOES
 *     go through addNode — deliberately gated: journals only contain content
 *     that passed birth-time gates in the original run (appendToJournal runs
 *     after a successful addNode), and the legacy classifyContent gate
 *     already re-runs on replay today. Same-config replay reproduces the
 *     original decisions deterministically.
 *
 * Three birth-time actions (config architecture.memory.intake.*, master
 * gate DEFAULT OFF — gates-off behavior is bit-identical to today):
 *   (a) preamble/meta-reasoning stripping — strip leading prompt-handling
 *       sentences when substantive residual remains; reject when nothing
 *       substantive is left (patterns adapted from Home23 donors
 *       engine/src/memory/brain-cleanup.js and
 *       engine/src/cognition/hallucinated-tool-call-detector.js — pattern
 *       donors only, no Home23 tag/tool lists imported).
 *   (b) hallucinated-tool-call rejection — literal [TOOL_CALL: x] syntax or
 *       fake tool-transcript markers make a node inert noise.
 *   (c) node diet — maxConceptChars cap (default 4000; real-brain sampling
 *       2026-07-22: merged-mplkc79l p50=422 p90=1964 p99=5510, oversize tail
 *       is consistency_review/synthesis_report slop), truncation marked
 *       with '[truncated]'.
 *
 * Exemptions (honest, by design):
 *   - pre-embedded inserts (feeder batches) — existing addNode convention
 *     "pre-embedded = intentional"; also keeps concept/embedding coherent.
 *     Enforced by the caller (addNode only consults the gate when it is
 *     about to embed).
 *   - STRUCTURAL_TAGS (agent-to-agent JSON) — stripping/truncating JSON
 *     corrupts it.
 *   - execution_result / execution_failure — G1 protected evidence; raw
 *     transcripts legitimately contain tool-ish text.
 *   - config memory.intake.exemptTags — additive operator escape hatch.
 *
 * Ledger contract (G3): counters aggregate in-process; flushToLedger()
 * emits AT MOST ONE 'memory_intake_gate' event per cycle covering all
 * action types (fire-and-forget via eventLedger.log — never awaited).
 * Rejection here is non-destructive: content never entered the brain, and
 * emitter-side results/journals retain the original text (G1).
 */

const { STRUCTURAL_TAGS } = require('../core/validation');

// cosmo23 convention: execution evidence is protected (see decay exemptTags
// and CLAUDE.md "Execution results become memory nodes"). The intake gate
// must never reshape evidence records.
const PROTECTED_EVIDENCE_TAGS = new Set(['execution_result', 'execution_failure']);

// Donor pattern (verified against Home23 hallucinated-tool-call-detector.js):
// bare [TOOL_CALL: name] / [tool: name] variants.
const TOOL_CALL_PATTERN = /\[\s*(?:TOOL[_\s]*CALL|tool[_\s]*call|TOOL|tool)\s*:\s*[a-zA-Z_][\w-]*\s*[\]\s]/;
const TOOL_CALL_PATTERN_GLOBAL = new RegExp(TOOL_CALL_PATTERN.source, 'g');
// Fake chat-transcript markers (XML-ish tool blocks pasted as prose).
const FAKE_TOOL_TRANSCRIPT_PATTERN = /<\s*(?:tool_call|tool_use|function_call|invoke\s+name=)/gi;

// Leading structural prefix ([AGENT: x], [AGENT INSIGHT: x], [REASONING],
// [SUMMARY], [DREAM], [FORK:id], [INTROSPECTION], [PLANNING ASSESSMENT],
// [TASK:id], [CLAIM:id], ...). Preserved verbatim; preamble stripping only
// looks at the text AFTER it. Negative lookahead keeps tool-call brackets
// out even when the tool-call sub-gate is disabled.
const STRUCTURAL_PREFIX_PATTERN = /^\[(?!\s*(?:TOOL[_\s]*CALL|tool[_\s]*call|TOOL|tool)\s*:)[^\]\n]{1,120}\]\s*/;

// Prompt-handling / meta-reasoning sentence openers. Adapted from the Home23
// donors' META_REASONING_OPENER_PATTERN, PROMPT_HANDLING_PREAMBLE_PATTERN and
// SHORT_META_FRAGMENT_PATTERN; cosmo23 role-thought flavor added. Anchored —
// only ever tested against the START of a leading sentence.
const PREAMBLE_SENTENCE_PATTERN = new RegExp(
  '^(?:'
  + 'the user (?:is asking|wants|asked)(?: me)?(?: to)?\\b'
  + '|i need to (?:produce output|answer|respond|follow|ground|check|read|think|understand|figure out)\\b'
  + '|i should (?:first |now )?(?:ground|check|read|think|start|begin|look|analyze|consider|understand)\\b'
  + "|i(?: will|'ll) (?:first |now )?(?:ground|check|read|think|start|begin|look|analyze|examine|consider)\\b"
  + '|i am going to (?:analyze|examine|look|start|begin|check|read|think)\\b'
  + '|let me (?:first |now )?(?:ground|check|read|think|look|start|begin|analyze|examine|consider|understand)\\b'
  + '|(?:okay|ok|alright|sure)[,.]? (?:let me|i will|i\'ll|so let)\\b'
  + '|as an ai\\b'
  + '|my (?:task|job|goal|role) (?:here )?is to\\b'
  + '|to answer (?:this|that)[, ]'
  + '|first[,]? i (?:will|need to|should)\\b'
  + '|before (?:i|we) (?:begin|start|dive|proceed)\\b'
  + '|in this (?:analysis|response|thought)[, ]?\\s*i (?:will|shall)\\b'
  + ')',
  'i'
);

// One leading "sentence": text up to the first ./!/?/newline. Length-capped —
// a 400+ char run without a terminator is content, not preamble.
const LEADING_SENTENCE_PATTERN = /^([^.!?\n]{1,400}(?:[.!?]+|\n|$))/;

const MAX_PREAMBLE_SENTENCES = 6;
const TRUNCATION_MARKER = '[truncated]';
const DEFAULT_MAX_CONCEPT_CHARS = 4000;
const MIN_CONCEPT_CAP = 200; // marker + a substantive residual must fit
const DEFAULT_MIN_RESIDUAL_CHARS = 40;

function zeroCounters() {
  return {
    examined: 0,
    exempted: 0,
    accepted: 0,
    preambleStripped: 0,
    preambleRejected: 0,
    toolCallRejected: 0,
    truncated: 0,
  };
}

function countToolCallMarkers(text) {
  const literal = text.match(TOOL_CALL_PATTERN_GLOBAL);
  const transcript = text.match(FAKE_TOOL_TRANSCRIPT_PATTERN);
  return (literal ? literal.length : 0) + (transcript ? transcript.length : 0);
}

/**
 * Strip leading preamble sentences from `body`, preserving the bytes of
 * everything kept (offset slice — no re-joining, no reformatting).
 * Returns { strippedCount, residual }.
 */
function stripLeadingPreamble(body) {
  let offset = 0;
  let strippedCount = 0;
  while (strippedCount < MAX_PREAMBLE_SENTENCES) {
    const rest = body.slice(offset);
    const leadingWhitespace = rest.match(/^\s*/)[0].length;
    const sentenceMatch = rest.slice(leadingWhitespace).match(LEADING_SENTENCE_PATTERN);
    if (!sentenceMatch) break;
    const sentence = sentenceMatch[1];
    if (!PREAMBLE_SENTENCE_PATTERN.test(sentence.trim())) break;
    offset += leadingWhitespace + sentence.length;
    strippedCount += 1;
  }
  return { strippedCount, residual: body.slice(offset).replace(/^\s+/, '') };
}

class NodeIntakeGate {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this._totals = zeroCounters();
    this._deltas = zeroCounters();
  }

  _bump(key) {
    this._totals[key] += 1;
    this._deltas[key] += 1;
  }

  /**
   * Evaluate one candidate node at creation time.
   *
   * @param {string} concept - candidate concept text
   * @param {string} tag - node tag
   * @param {object|null} config - live memory.intake config (architecture.memory.intake)
   * @returns {{action: 'disabled'|'exempt'|'accept'|'reject', concept: string,
   *            reason?: string, stripped?: boolean, truncated?: boolean,
   *            originalChars?: number, toolCallMarkers?: number}}
   *
   * DEFAULT OFF: without config.enabled === true this is a pure no-op —
   * no counters move, the concept is returned byte-identical.
   */
  apply(concept, tag, config) {
    if (!config || config.enabled !== true) {
      return { action: 'disabled', concept };
    }
    if (typeof concept !== 'string' || concept.length === 0) {
      // classifyContent already rejects non-strings before the gate runs;
      // stay a no-op if that ordering ever changes.
      return { action: 'accept', concept, stripped: false, truncated: false };
    }

    this._bump('examined');

    const exemptTags = Array.isArray(config.exemptTags) ? config.exemptTags : [];
    if (STRUCTURAL_TAGS.has(tag) || PROTECTED_EVIDENCE_TAGS.has(tag) || exemptTags.includes(tag)) {
      this._bump('exempted');
      return { action: 'exempt', concept };
    }

    const originalChars = concept.length;

    // (b) hallucinated tool calls — reject, counted.
    if (config.rejectHallucinatedToolCalls !== false) {
      const toolCallMarkers = countToolCallMarkers(concept);
      if (toolCallMarkers > 0) {
        this._bump('toolCallRejected');
        return {
          action: 'reject',
          reason: 'hallucinated_tool_call',
          concept,
          toolCallMarkers,
          originalChars,
        };
      }
    }

    let working = concept;
    let stripped = false;

    // (a) preamble/meta-reasoning stripping — strip when substantive
    // residual remains, reject when nothing substantive is left.
    if (config.stripPreamble !== false) {
      const prefixMatch = working.match(STRUCTURAL_PREFIX_PATTERN);
      const prefix = prefixMatch ? prefixMatch[0] : '';
      const body = working.slice(prefix.length);
      const { strippedCount, residual } = stripLeadingPreamble(body);
      if (strippedCount > 0) {
        const minResidualRaw = Number(config.minResidualChars);
        const minResidual = Number.isFinite(minResidualRaw) && minResidualRaw >= 1
          ? minResidualRaw
          : DEFAULT_MIN_RESIDUAL_CHARS;
        if (residual.length < minResidual) {
          this._bump('preambleRejected');
          return { action: 'reject', reason: 'pure_preamble', concept, originalChars };
        }
        working = prefix + residual;
        stripped = true;
        this._bump('preambleStripped');
      }
    }

    // (c) node diet — cap stored concept size, marked '[truncated]'.
    let truncated = false;
    const capRaw = config.maxConceptChars;
    const capDisabled = capRaw === 0 || capRaw === false;
    if (!capDisabled) {
      const capNumber = Number(capRaw);
      const cap = Math.max(
        Number.isFinite(capNumber) && capNumber > 0 ? capNumber : DEFAULT_MAX_CONCEPT_CHARS,
        MIN_CONCEPT_CAP,
      );
      if (working.length > cap) {
        working = `${working.slice(0, cap - TRUNCATION_MARKER.length - 1).trimEnd()} ${TRUNCATION_MARKER}`;
        truncated = true;
        this._bump('truncated');
      }
    }

    this._bump('accepted');
    return { action: 'accept', concept: working, stripped, truncated, originalChars };
  }

  /**
   * Counters for NetworkMemory.getStats() — additive, never replaces
   * existing stats fields. `enabled` reflects the LIVE config.
   */
  getStats(config) {
    return {
      enabled: Boolean(config && config.enabled === true),
      ...this._totals,
    };
  }

  /**
   * Emit at most ONE aggregated durable ledger event for everything since
   * the previous flush (G3: this.eventLedger?.log fire-and-forget, never
   * awaited; per-node ledger spam is exactly the slop this gate exists to
   * prevent). Returns true when an event was emitted.
   */
  flushToLedger(eventLedger, cycle = null) {
    if (!eventLedger || typeof eventLedger.log !== 'function') return false;
    const deltas = this._deltas;
    const hasActivity = deltas.examined > 0
      || deltas.exempted > 0
      || deltas.preambleStripped > 0
      || deltas.preambleRejected > 0
      || deltas.toolCallRejected > 0
      || deltas.truncated > 0;
    if (!hasActivity) return false;
    this._deltas = zeroCounters();
    // Fire-and-forget: EventLedger.log never rejects.
    eventLedger.log('memory_intake_gate', {
      cycle,
      ...deltas,
      totals: { ...this._totals },
    });
    return true;
  }
}

module.exports = {
  NodeIntakeGate,
  PROTECTED_EVIDENCE_TAGS,
  TOOL_CALL_PATTERN,
  PREAMBLE_SENTENCE_PATTERN,
  STRUCTURAL_PREFIX_PATTERN,
  TRUNCATION_MARKER,
  DEFAULT_MAX_CONCEPT_CHARS,
};
