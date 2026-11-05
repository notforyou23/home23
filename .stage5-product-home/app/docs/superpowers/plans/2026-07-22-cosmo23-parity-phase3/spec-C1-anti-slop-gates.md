# cosmo23 memory intake — Fix 3.1: anti-slop persistence gates for NEW nodes (NetworkMemory.addNode choke point, config memory.intake.*, default OFF)

## Target current state

TARGET: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js (2686 lines at recon; ANOTHER SESSION landed Fix 3.4 delta-compaction hunks in this file during my session — see CONCURRENCY below).

addNode today (line ~716): `async addNode(concept, tag = 'general', embedding = null, metadata = null)` — positional, no options object. Birth-time hygiene = ONE gate: when `!embedding`, `classifyContent(concept, tag)` (from ../core/validation) rejects category 'operational'|'garbage' and returns null; pre-embedded inserts intentionally bypass it ("pre-embedded = intentional"). Then embeds (embedding covers whatever `concept` holds at that point), optional extractive summary, node object `{id, concept, summary, keyPhrase, tag, embedding, activation, cluster, weight:1.0, created, accessed, accessCount, metadata: metadata||null, type: metadata?.type||null}`, ID allocation + insert + edges + cluster inside withPersistenceBarrier. classifyContent facts that matter: length<10 or >50000 → garbage; STRUCTURAL_TAGS always pass; HIGH_VALUE_TAGS pass on 30-char floor; it strips `^\[(?:AGENT|AGENT INSIGHT):\s*\w+\]\s*` before pattern checks; NO preamble/meta-reasoning patterns, NO tool-call detection, NO storage size cap below 50k → that is the Fix 3.1 gap.

CREATION TOPOLOGY (verified by grep, every call site read): addNode is the sole LIVE creation path — agents/base-agent.js:655,754 (addFinding `[AGENT: id] …` / addInsight `[AGENT INSIGHT: id] …`, its own classifyContent pre-filter, journals AFTER successful addNode), core/orchestrator.js:3053 (role thoughts, tag=role.id — the primary slop source),3077 (`[REASONING]`),3948+4282 (`[SUMMARY]`),4155 (`[DREAM]`),4308 ('consolidated'),9389+9417 (replayAgentJournals — crash-recovery replay, see exemption honesty in apiNotes), cognition/trajectory-fork.js:208,352 (`[FORK:id]`), system/introspection.js:287 (`[INTROSPECTION]`), core/guided-mode-planner.js:844 (`[PLANNING ASSESSMENT]`), execution/execution-monitor.js:317 (tags execution_result/execution_failure — G1-protected evidence), artifacts/{artifact-lifecycle:139, artifact-ingestor:251, artifact-registry:369,434} (`[TASK:]`/`[CLAIM:]` + metadata), ingestion/ingestion-manifest.js:212 (feeder flush, PRE-EMBEDDED via _embedWithRetry batch — bypasses gates today by the !embedding rule). HYDRATION/MERGE/LOAD NEVER CALL addNode: orchestrator loadState writes memory.nodes.set directly (orchestrator.js:9061 loop), NetworkMemory.importGraphChanges sets nodes directly (line ~1321), NetworkMemory.load() replaces the graph wholesale, lib/memory-sidecar hydrateStateMemory streams into state, merge/ has zero addNode calls — exemption by construction, no trusted-flag plumbing needed. artifact-loop-verifier.js:143 defines its own mock addNode (not NetworkMemory).

Other current-state facts: NetworkMemory is constructed as `new NetworkMemory(config.architecture.memory, logger, …)` (engine/src/index.js:351,987; worker/orchestrator-worker.js:234) so `this.config.intake` == run-config `architecture.memory.intake`. getStats() (line ~2403) returns {nodes, edges, clusters, averageWeight, activeNodes, averageDegree} and reads this.config.decay.minimumWeight; consumed only by orchestrator.getStats() telemetry (line ~10493) — NOT persisted (checkpoint memorySummary at buildCheckpointState counts maps directly). EventLedger lives on the ORCHESTRATOR (this.eventLedger, core/event-ledger.js): log(type,data) is synchronous-enqueue fire-and-forget (never rejects), records flat-merge `{type,…data,seq,prevHash,ts}`; existing cycle anchor `this.eventLedger?.log('cycle_complete', …)` at line ~3669 is unique. applyDecay honors config.decay.exemptTags (execution evidence protected — G1).

REAL-BRAIN SIZE SAMPLING (task-required, from runs/*/memory-nodes.base-1.jsonl.gz): merged-mplkc79l 1483 nodes p50=422 p90=1964 p99=5510 max=30389, 39 nodes >4000 (2.6%); jerry2-import 319 nodes p50=424 p90=1396 max=28682, 11 >4000. Tags of the >4000 tail: consistency_review 29, synthesis_report 6, summary 2, critic 1, fork_1 1 — exactly the verbose-slop tail; no structural/execution tags. maxConceptChars default 4000 confirmed sane.

CONCURRENCY OBSERVED LIVE: while I validated, other sessions landed (a) a SleepPolicy/Component 4.4 change (~141 lines) in core/orchestrator.js and (b) Fix 3.4 delta-compaction hunks (projectExportedNodeRecord/projectExportedEdgeRecord + capturePersistenceChangesSnapshot) in network-memory.js. I validated by applying my hunks, ran tests (all green), then reverted SURGICALLY via exact-text removal — never copy-back — and verified 0 traces of my work remain and both files pass node --check with the foreign work intact. All five anchors below re-verified grep-unique in the post-revert CURRENT tree, but the implementer MUST re-verify each anchor count at apply time (this file set is hot).

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/node-intake-gate.js

NEW FILE (the entire gate — single choke-point module). Create with exactly this content. Validated: node --check clean; drives 9/9 green tests through the real NetworkMemory.addNode.

### Anchor
```
NEW FILE — no anchor. Directory: cosmo23/engine/src/memory/ (siblings: network-memory.js, summarizer.js).
```

### Code
```js
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

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Hunk 1/4 — require the gate. Find the anchor line (grep-unique, no trailing whitespace) and REPLACE it with the two lines in `code` (anchor line + new require).

### Anchor
```
const { classifyContent } = require('../core/validation');
```

### Code
```js
const { classifyContent } = require('../core/validation');
const { NodeIntakeGate } = require('./node-intake-gate');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Hunk 2/4 — instantiate the gate in the constructor. Find the 2-line anchor block (grep-unique; 4-space indent; no trailing whitespace) and REPLACE with `code` (gate init inserted above the anchor lines, which are retained). WARNING: do NOT anchor on `this._lastEmbeddingError = null;` alone — that line appears twice in the file (constructor and embed()).

### Anchor
```
    // Initialize extractive summarizer for memory compression
    this.extractiveSummarizer = new ExtractiveSummarizer(logger);
```

### Code
```js
    // Fix 3.1: anti-slop node intake gate (config memory.intake.*, master
    // gate DEFAULT OFF). Applied inside addNode() only — hydration, merge,
    // and load paths write this.nodes directly and never pass through it.
    this.intakeGate = new NodeIntakeGate({ logger });

    // Initialize extractive summarizer for memory compression
    this.extractiveSummarizer = new ExtractiveSummarizer(logger);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Hunk 3/4 — apply the gate inside addNode(). Find the 2-line anchor block (grep-unique; sits ~15 lines below the existing classifyContent quality-gate block inside addNode; no trailing whitespace on either line) and REPLACE with `code` (gate block inserted above the retained anchor lines). Ordering is deliberate: the gate runs AFTER the legacy classifyContent gate (every today-rejection still happens first, on the original bytes) and BEFORE this.embed() (the embedding always covers the FINAL stored bytes). NOTE: the debug-log block ~80 lines below ('Node added to network') has trailing spaces on 3 lines — do not anchor near it.

### Anchor
```
    // All nodes use same dimensions for network consistency
    const embed = embedding || await this.embed(concept);
```

### Code
```js
    // Fix 3.1: anti-slop intake gate (config memory.intake.*, default OFF).
    // Runs AFTER the legacy quality gate so every rejection that exists
    // today still happens first on the original bytes, and ONLY for
    // live-created nodes: pre-embedded inserts (feeder batches) keep the
    // existing "pre-embedded = intentional" exemption above, and
    // hydration/merge/load never call addNode at all.
    if (!embedding && this.intakeGate) {
      const intake = this.intakeGate.apply(concept, tag, this.config?.intake);
      if (intake.action === 'reject') {
        this.logger?.debug?.('Node rejected by intake gate', {
          tag,
          reason: intake.reason,
          preview: String(concept).substring(0, 80),
        });
        return null;
      }
      if (intake.stripped || intake.truncated) {
        concept = intake.concept;
        metadata = {
          ...(metadata || {}),
          intake: {
            ...(intake.stripped ? { stripped: true } : {}),
            ...(intake.truncated ? { truncated: true } : {}),
            originalChars: intake.originalChars,
          },
        };
      }
    }

    // All nodes use same dimensions for network consistency
    const embed = embedding || await this.embed(concept);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Hunk 4/4 — additive intake counters in getStats(). Find the 2-line anchor (grep-unique; note the anchor's averageDegree line has NO trailing comma today — the replacement adds one) and REPLACE with `code`. Guarded with `this.intakeGate ?` so Object.create(NetworkMemory.prototype) test fixtures without a constructor still work. getStats() feeds telemetry/status only — verified NOT persisted (checkpoints count maps directly in buildCheckpointState).

### Anchor
```
      averageDegree: (this.edges.size * 2) / this.nodes.size || 0
    };
```

### Code
```js
      averageDegree: (this.edges.size * 2) / this.nodes.size || 0,
      // Fix 3.1: additive intake-gate counters (zeros while the gate is off).
      intake: this.intakeGate ? this.intakeGate.getStats(this.config?.intake) : null
    };
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Cycle-boundary ledger flush — at most ONE aggregated 'memory_intake_gate' event per cycle (G3 aggregation). Find the anchor line (grep-unique, no trailing whitespace, inside executeCycle's end-of-cycle section right after saveState) and REPLACE with `code` (anchor retained + 3 new lines). Fully optional-chained: worker/standalone NetworkMemory users without a ledger are no-ops, and when the gate is off or idle no event is emitted (ledger stays bit-identical). WARNING: another session is actively editing this file (SleepPolicy/Component 4.4 landed mid-session) — re-verify the anchor is still unique immediately before applying.

### Anchor
```
      this.eventLedger?.log('cycle_complete', { cycle: this.cycleCount, durationMs: cycleDuration });
```

### Code
```js
      this.eventLedger?.log('cycle_complete', { cycle: this.cycleCount, durationMs: cycleDuration });
      // Fix 3.1: at most ONE aggregated intake-gate ledger event per cycle
      // (fire-and-forget; no event when the gate is off or idle).
      this.memory?.intakeGate?.flushToLedger?.(this.eventLedger, this.cycleCount);
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new suite in the test chain EXACTLY ONCE (G5). In the "test" script (line ~17), find the anchor substring (grep-unique in package.json, occurs once, followed by a space) and REPLACE with `code` — i.e., insert `tests/cosmo23/node-intake-gate.test.cjs ` immediately after it, inside the same `node --test --test-concurrency=1` cosmo23 segment. CAUTION: package.json carries FOREIGN UNCOMMITTED HUNKS from other sessions — stage surgically (git add -p), never wholesale.

### Anchor
```
tests/cosmo23/network-memory-embedding-batch.test.cjs 
```

### Code
```js
tests/cosmo23/network-memory-embedding-batch.test.cjs tests/cosmo23/node-intake-gate.test.cjs 
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Register the new suite in the registration pin EXACTLY ONCE (G5). Find the anchor line (grep-unique; 4-space indent; no trailing whitespace) and REPLACE with `code` (anchor line + new entry line after it). CAUTION: this file also carries FOREIGN UNCOMMITTED HUNKS — stage surgically.

### Anchor
```
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
```

### Code
```js
    'tests/cosmo23/network-memory-embedding-batch.test.cjs',
    'tests/cosmo23/node-intake-gate.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/node-intake-gate.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');
const {
  NodeIntakeGate,
  TRUNCATION_MARKER,
} = require('../../cosmo23/engine/src/memory/node-intake-gate.js');
const { EventLedger } = require('../../cosmo23/engine/src/core/event-ledger.js');

const SILENT_LOGGER = { info() {}, warn() {}, debug() {}, error() {} };

const PREAMBLE_WRAPPED =
  '[AGENT: agent_x1] The user is asking me to analyze the corpus. '
  + 'Let me first ground the current state. '
  + 'Kolmogorov complexity bounds the compressibility of research transcripts; '
  + 'the measured ratio across 1483 nodes was 0.42 with variance 0.03.';
const PREAMBLE_WRAPPED_RESIDUAL =
  '[AGENT: agent_x1] Kolmogorov complexity bounds the compressibility of research transcripts; '
  + 'the measured ratio across 1483 nodes was 0.42 with variance 0.03.';
const PURE_PREAMBLE = 'Let me check the current state properly before answering anything else.';
const FAKE_TOOL_TRANSCRIPT =
  '[TOOL_CALL: query_brain] Retrieve prior findings about mitochondrial protein '
  + 'synthesis latency measured in the 2019 cohort.';
const OVERSIZED = `Synthesis of entropy-gradient findings across the corpus: ${'x'.repeat(12000)}`;

function createMemory(intakeConfig) {
  const config = {
    embedding: { model: 'test-embedding', dimensions: 2 },
    smallWorld: {},
    spreading: {},
    decay: { minimumWeight: 0.1 },
    hebbian: { enabled: false },
  };
  if (intakeConfig !== undefined) config.intake = intakeConfig;
  const memory = new NetworkMemory(config, SILENT_LOGGER, null, {
    getEmbeddingClient: () => ({ embeddings: { create: async () => ({ data: [] }) } }),
  });
  memory.tokenizer = null;
  const embedCalls = [];
  memory.embed = async (text) => {
    embedCalls.push(text);
    return [1, 0];
  };
  return { memory, embedCalls };
}

test('COSMO intake gate strips leading preamble, keeps residual, marks metadata, embeds final bytes', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true });

  const node = await memory.addNode(PREAMBLE_WRAPPED, 'analyst');

  assert.ok(node, 'substantive residual must be accepted');
  assert.equal(node.concept, PREAMBLE_WRAPPED_RESIDUAL);
  assert.equal(node.metadata.intake.stripped, true);
  assert.equal(node.metadata.intake.originalChars, PREAMBLE_WRAPPED.length);
  assert.deepEqual(embedCalls, [PREAMBLE_WRAPPED_RESIDUAL], 'embedding must cover the stored bytes');
  assert.equal(memory.getStats().intake.preambleStripped, 1);
  assert.equal(memory.getStats().intake.enabled, true);
});

test('COSMO intake gate rejects pure preamble with nothing substantive left', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true });

  const node = await memory.addNode(PURE_PREAMBLE, 'analyst');

  assert.equal(node, null);
  assert.deepEqual(embedCalls, [], 'rejected content must never reach the embedder');
  assert.equal(memory.getStats().intake.preambleRejected, 1);
  assert.equal(memory.nodes.size, 0);
});

test('COSMO intake gate rejects hallucinated tool-call transcripts', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true });

  const node = await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding');

  assert.equal(node, null);
  assert.deepEqual(embedCalls, []);
  assert.equal(memory.getStats().intake.toolCallRejected, 1);
});

test('COSMO intake gate truncates oversized concepts with a marked diet cap', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true, maxConceptChars: 4000 });

  const node = await memory.addNode(OVERSIZED, 'synthesis_report');

  assert.ok(node);
  assert.ok(node.concept.length <= 4000, `capped length, got ${node.concept.length}`);
  assert.ok(node.concept.endsWith(TRUNCATION_MARKER), 'truncation must be marked');
  assert.equal(node.metadata.intake.truncated, true);
  assert.equal(node.metadata.intake.originalChars, OVERSIZED.length);
  assert.deepEqual(embedCalls, [node.concept], 'embedding must cover the truncated bytes');
  assert.equal(memory.getStats().intake.truncated, 1);
});

test('COSMO intake gate exempts pre-embedded, protected-evidence, and structural intake', async () => {
  const { memory } = createMemory({ enabled: true });

  const preEmbedded = await memory.addNode(PURE_PREAMBLE, 'analyst', [0.25, 0.75]);
  assert.ok(preEmbedded, 'pre-embedded inserts keep the existing intentional-bypass convention');
  assert.equal(preEmbedded.concept, PURE_PREAMBLE);

  const evidence = await memory.addNode(
    `Execution failed (exit 2): [TOOL_CALL: bash] ${PURE_PREAMBLE}`,
    'execution_failure',
  );
  assert.ok(evidence, 'execution evidence is protected from reshaping');
  assert.equal(evidence.concept, `Execution failed (exit 2): [TOOL_CALL: bash] ${PURE_PREAMBLE}`);
  assert.equal(evidence.metadata, null);

  const structural = await memory.addNode(
    '{"phase":1,"objective":"The user is asking me to map the corpus","tasks":["t1","t2"]}',
    'mission_plan',
  );
  assert.ok(structural, 'structural JSON must pass untouched');
  assert.equal(
    structural.concept,
    '{"phase":1,"objective":"The user is asking me to map the corpus","tasks":["t1","t2"]}',
  );

  const stats = memory.getStats().intake;
  assert.equal(stats.exempted, 2, 'evidence + structural exemptions counted (pre-embedded never consults the gate)');
  assert.equal(stats.preambleStripped + stats.preambleRejected + stats.toolCallRejected + stats.truncated, 0);
});

test('COSMO intake gate never strips past non-preamble content', () => {
  const gate = new NodeIntakeGate({});
  const config = { enabled: true };

  const midContent = 'Measured variance was 0.03 across 1483 nodes. Let me check the current state.';
  const untouched = gate.apply(midContent, 'analyst', config);
  assert.equal(untouched.action, 'accept');
  assert.equal(untouched.concept, midContent, 'stripping is leading-sentences-only');

  const insight = gate.apply(
    '[AGENT INSIGHT: a2] I should first check the corpus. Signal-to-noise measured 3.4 across all validated partitions.',
    'agent_insight',
    config,
  );
  assert.equal(insight.action, 'accept');
  assert.equal(
    insight.concept,
    '[AGENT INSIGHT: a2] Signal-to-noise measured 3.4 across all validated partitions.',
    'structural bracket prefix survives stripping',
  );
});

test('COSMO gates-off pin: default-off behavior is bit-identical to today', async () => {
  for (const intakeConfig of [undefined, { enabled: false }]) {
    const { memory, embedCalls } = createMemory(intakeConfig);

    const wrapped = await memory.addNode(PREAMBLE_WRAPPED, 'analyst');
    assert.equal(wrapped.concept, PREAMBLE_WRAPPED, 'no stripping when off');
    assert.equal(wrapped.metadata, null, 'metadata stays null when off');

    const toolCall = await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding');
    assert.equal(toolCall.concept, FAKE_TOOL_TRANSCRIPT, 'no tool-call rejection when off');

    const oversized = await memory.addNode(OVERSIZED, 'synthesis_report');
    assert.equal(oversized.concept, OVERSIZED, 'no diet cap when off');

    assert.deepEqual(
      embedCalls,
      [PREAMBLE_WRAPPED, FAKE_TOOL_TRANSCRIPT, OVERSIZED],
      'embedder sees the original bytes when off',
    );

    const stats = memory.getStats();
    assert.equal(stats.nodes, 3);
    assert.equal(stats.intake.enabled, false);
    assert.equal(stats.intake.examined, 0, 'gate is a pure no-op when off');
    assert.equal(
      stats.intake.preambleStripped + stats.intake.preambleRejected
        + stats.intake.toolCallRejected + stats.intake.truncated + stats.intake.exempted,
      0,
    );
  }
});

test('COSMO intake gate emits ONE aggregated ledger event per flush, none when idle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-gate-ledger-'));
  try {
    const ledger = new EventLedger(dir, { logger: SILENT_LOGGER });
    await ledger.initialize();

    const { memory } = createMemory({ enabled: true, maxConceptChars: 4000 });
    await memory.addNode(PREAMBLE_WRAPPED, 'analyst'); // strip
    await memory.addNode(PURE_PREAMBLE, 'analyst'); // reject
    await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding'); // reject
    await memory.addNode(OVERSIZED, 'synthesis_report'); // truncate

    assert.equal(memory.intakeGate.flushToLedger(ledger, 7), true);
    assert.equal(memory.intakeGate.flushToLedger(ledger, 8), false, 'no second event without new activity');

    await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding');
    assert.equal(memory.intakeGate.flushToLedger(ledger, 9), true);

    await ledger.flush();
    await ledger.close();

    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === 'memory_intake_gate');

    assert.equal(events.length, 2, 'one aggregated event per active cycle, never per-node spam');
    assert.equal(events[0].cycle, 7);
    assert.equal(events[0].examined, 4);
    assert.equal(events[0].preambleStripped, 1);
    assert.equal(events[0].preambleRejected, 1);
    assert.equal(events[0].toolCallRejected, 1);
    assert.equal(events[0].truncated, 1);
    assert.equal(events[0].totals.examined, 4);
    assert.equal(events[1].cycle, 9);
    assert.equal(events[1].examined, 1);
    assert.equal(events[1].toolCallRejected, 1);
    assert.equal(events[1].preambleStripped, 0);
    assert.equal(events[1].totals.toolCallRejected, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('COSMO intake gate keeps existing getStats surface intact (additive only)', async () => {
  const { memory } = createMemory({ enabled: true });
  await memory.addNode(PREAMBLE_WRAPPED, 'analyst');

  const stats = memory.getStats();
  for (const key of ['nodes', 'edges', 'clusters', 'averageWeight', 'activeNodes', 'averageDegree']) {
    assert.ok(key in stats, `existing stats key ${key} preserved`);
  }
  assert.equal(stats.nodes, 1);
  assert.equal(stats.intake.accepted, 1);
});

```

## API NOTES

VALIDATION RECEIPTS (I applied, tested, and reverted byte-exact — stating so per contract): with all hunks applied to the live tree, `node --check` passed on all three JS files and `node --test tests/cosmo23/node-intake-gate.test.cjs` ran 9/9 green from the repo root; adjacent suites `network-memory-embedding-batch` + `state-hydration` + `merge-engine-state-io` ran 19/19 green (empirically confirms hydration/merge unaffected). Revert was SURGICAL (exact-text removal of only my hunks, then rm of the two new files) because two other sessions wrote into the same files mid-window: orchestrator.js gained a SleepPolicy/Component 4.4 change and network-memory.js gained Fix 3.4 delta-compaction hunks (projectExportedNodeRecord/projectExportedEdgeRecord/capturePersistenceChangesSnapshot). Post-revert: 0 grep hits for intakeGate|NodeIntakeGate|node-intake-gate|'Fix 3.1' in both files, both node --check clean, foreign work intact. IMPLEMENTER: re-verify every anchor's grep count immediately before applying — this file set is hot. NEVER git stash; stage package.json and package-test-registration.test.cjs surgically (both carry foreign uncommitted hunks).

CONFIG SURFACE (run config.yaml, read live at each addNode — no config-template change required since default is OFF): architecture.memory.intake.{enabled:false(master, G2 pattern), stripPreamble:true-when-enabled, rejectHallucinatedToolCalls:true-when-enabled, maxConceptChars:4000 (0/false disables cap; clamped >=200), minResidualChars:40, exemptTags:[] (additive)}. Inside NetworkMemory this is `this.config.intake` because NetworkMemory is constructed with config.architecture.memory (index.js:351,987; orchestrator-worker.js:234).

G-CONTRACT MAPPING: G1 — execution_result/execution_failure are hard-exempt (PROTECTED_EVIDENCE_TAGS); nothing existing is deleted/degraded (creation-time only); rejections are non-destructive in design intent: content never entered the brain and emitters keep originals (base-agent pushes filtered content into this.results; journals record only post-acceptance content); strips/truncations carry per-node provenance marks (metadata.intake.{stripped,truncated,originalChars}) + counted ledger receipts. G2-style gating — memory.intake.enabled default OFF; gates-off pin test asserts byte-identical stored concepts, null metadata, original bytes to the embedder, zero counters. G3 — ledger via this.eventLedger?.log fire-and-forget (EventLedger.log never rejects, verified core/event-ledger.js:199), aggregated to at most ONE 'memory_intake_gate' event per cycle with flat delta fields + totals (record shape: reserved seq/prevHash/type/ts always win, payload flat-merged); no interaction with persistResearchState/manifest writer — the gate acts BEFORE node insertion, so Fix 3.4 delta capture and full saves both see only final accepted bytes (clean composition, zero changes needed on either side). G4 — creation-time only; loadState/importGraphChanges/load()/merge insert nodes directly and never traverse addNode (verified by grep + by the green hydration/merge suites); no retroactive sweep exists anywhere in this change. G5 — node:test/.test.cjs/assert-strict/tmpdir (real EventLedger in mkdtemp); registered exactly once in both authorities. G6 — donor APIs verified by reading: brain-cleanup.js contributed SHORT_META_FRAGMENT/META_REASONING_OPENER pattern shapes; hallucinated-tool-call-detector.js contributed TOOL_CALL_PATTERN verbatim + the preamble/substantive-tail idea; Home23's KNOWN_CYCLE_TOOLS, ACTION_ONLY, RESTLESS_STIMULATION, TOOL_PLAN patterns and HOME23_PROMPT_PREAMBLE_GATE_DISABLE env var were deliberately NOT imported (Home23-specific tool names/thought taxonomy — the donor-mismatch class the phase warned about).

EXEMPTION HONESTY (the design decisions a reviewer will probe): (1) pre-embedded bypass reuses the exact existing `!embedding` convention of the legacy classifyContent gate — feeder document chunks arrive pre-embedded via ingestion-manifest._embedWithRetry, and reshaping a concept AFTER its embedding exists would poison concept/embedding correspondence. (2) replayAgentJournals (orchestrator.js:9389,9417) intentionally REMAINS gated: journals are written only after a successful addNode (base-agent.js appendToJournal placement), so replayed entries passed birth-time gates originally, and the legacy gate already re-runs on replay today — same-config replay is deterministic; an options.trusted flag was considered and rejected as dishonest surface area since no hydration/merge path calls addNode at all. (3) STRUCTURAL_TAGS exemption prevents JSON corruption; the legacy 10..50000-char classifyContent bounds still apply to everything first (gate runs second, so a >50k monster is still rejected as garbage today-style, never resurrected as a truncated stub).

KNOWN LIMITATIONS (documented, acceptable for a default-OFF gate): sentence splitter treats '.' in decimals as a boundary, which can over-reject a preamble sentence containing a version/decimal plus a tiny tail (conservative direction — content sentences that don't match preamble openers are never touched); tool-call rejection fires on ANY literal [TOOL_CALL: x] occurrence per the donor's semantics — a live-created node QUOTING that syntax is rejected unless its tag is exempt/high-value-irrelevant (operators can set rejectHallucinatedToolCalls:false or exemptTags). MAX_PREAMBLE_SENTENCES=6 caps stripping.

RUN COMMANDS: `node --test tests/cosmo23/node-intake-gate.test.cjs` (fast), then the full chain `npm test` from repo root. Registration self-pins via tests/cosmo23/package-test-registration.test.cjs. Doc note: this is structural engine work under the 2026-07-21 first-class-editable doctrine — NO entry in docs/design/COSMO23-VENDORED-PATCHES.md (integration boundaries only); the new memory.intake.* knobs belong in the phase's config-knob doc pass alongside the G2 gates (cf. commit 2cfb41c0 precedent).
