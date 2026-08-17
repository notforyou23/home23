'use strict';

/**
 * Promotion gate — the ONLY path that writes canonical Brain state.
 *
 * July 30 law:
 * - Inv 4: No worker writes canonical Brain state. Workers emit typed events
 *   and candidate objects.
 * - Inv 14: The Principal organizes; it does not own truth. It proposes;
 *   this deterministic gate validates and commits.
 * - Dreams cannot directly create sourced facts or change epistemic status:
 *   a dream-origin candidate may be promoted only as a hypothesis or a
 *   question, never as a supported finding.
 *
 * The gate performs deterministic checks only — no semantic judgment.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const PROMOTION_GENESIS = 'promotion-genesis';

const PROMOTABLE_KINDS = new Set(['finding', 'hypothesis', 'question', 'connection', 'contradiction']);

function recordHash(prevHash, payload) {
  return crypto.createHash('sha256')
    .update(String(prevHash))
    .update(JSON.stringify(payload))
    .digest('hex');
}

class PromotionGate {
  constructor(runtimePath, logger = console) {
    this.runtimePath = runtimePath;
    this.candidatesFile = path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl');
    this.ledgerFile = path.join(runtimePath, 'ecology', 'promotions.jsonl');
    this.logger = logger;
    this.tailHash = PROMOTION_GENESIS;
    this.count = 0;
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    try {
      const raw = await fsp.readFile(this.ledgerFile, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        this.tailHash = last.hash || PROMOTION_GENESIS;
        this.count = lines.length;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn?.('Promotion ledger unreadable', { error: err.message });
      }
    }
    this._loaded = true;
  }

  async findCandidate(candidateId) {
    try {
      const raw = await fsp.readFile(this.candidatesFile, 'utf8');
      for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.id === candidateId) return row;
      }
    } catch { /* no candidates journaled yet */ }
    return null;
  }

  /**
   * Deterministic validation + commit of one promotion.
   *
   * decision: a typed Principal decision
   *   { id, actor: 'principal', kind: 'promotion_proposal',
   *     candidateId, promoteAs: 'finding'|'hypothesis'|'question'|..., rationale }
   * memory: the run's NetworkMemory (or null — refusal, degraded honest)
   */
  async promote({ decision, memory }) {
    await this.load();

    if (!decision || decision.kind !== 'promotion_proposal') {
      return { promoted: false, reason: 'not_a_promotion_proposal' };
    }
    if (decision.actor !== 'principal') {
      // Workers may not promote their own output; nothing else proposes.
      return { promoted: false, reason: 'promotion_requires_principal_decision' };
    }
    const promoteAs = String(decision.promoteAs || 'finding');
    if (!PROMOTABLE_KINDS.has(promoteAs)) {
      return { promoted: false, reason: `unknown_promotion_kind:${promoteAs}` };
    }

    const candidate = await this.findCandidate(decision.candidateId);
    if (!candidate) {
      return { promoted: false, reason: 'candidate_not_in_journal' };
    }
    if (candidate.origin === 'dream' && promoteAs === 'finding') {
      // Dreams cannot directly create sourced facts.
      return { promoted: false, reason: 'dream_cannot_become_fact' };
    }
    if (candidate.origin === 'principal') {
      // The Principal cannot launder its own prose into the Brain.
      return { promoted: false, reason: 'principal_cannot_promote_own_output' };
    }

    let nodeId = null;
    if (memory && typeof memory.addNode === 'function') {
      const tag = promoteAs === 'finding' ? 'promoted_finding'
        : promoteAs === 'hypothesis' ? 'hypothesis'
          : promoteAs === 'connection' ? 'promoted_connection'
            : promoteAs === 'contradiction' ? 'contradiction'
              : 'promoted_question';
      try {
        // NetworkMemory.addNode(concept, tag, embedding, metadata)
        const node = await memory.addNode(candidate.content, tag, null, {
          source: 'ecology_promotion',
          candidateId: candidate.id,
          decisionId: decision.id,
          origin: candidate.origin || 'worker',
          lane: candidate.lane || null,
          epistemicStatus: promoteAs === 'finding' ? 'supported_candidate' : 'candidate'
        });
        nodeId = node?.id ?? null;
      } catch (err) {
        return { promoted: false, reason: `brain_write_failed:${err.message}` };
      }
    } else {
      return { promoted: false, reason: 'no_brain_available' };
    }

    const payload = {
      seq: this.count + 1,
      at: Date.now(),
      candidateId: candidate.id,
      decisionId: decision.id || null,
      promoteAs,
      origin: candidate.origin || 'worker',
      lane: candidate.lane || null,
      nodeId,
      rationale: decision.rationale || null
    };
    const hash = recordHash(this.tailHash, payload);
    const record = { ...payload, prevHash: this.tailHash, hash };
    await fsp.mkdir(path.dirname(this.ledgerFile), { recursive: true });
    await fsp.appendFile(this.ledgerFile, `${JSON.stringify(record)}\n`);
    this.tailHash = hash;
    this.count += 1;

    return { promoted: true, record };
  }

  async ledgerTail() {
    await this.load();
    return { count: this.count, tailHash: this.tailHash };
  }
}

module.exports = { PromotionGate, PROMOTABLE_KINDS, PROMOTION_GENESIS };
