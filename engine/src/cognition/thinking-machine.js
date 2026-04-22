/**
 * Thinking Machine — pipeline runner for the four-phase autonomous cycle
 *
 * Phase 3 of the rebuild (see docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md).
 *
 * Current phases wired:
 *   - Phase 1 (discover)   — handled by DiscoveryEngine, queue ready
 *   - Phase 2 (deep-dive)  — DeepDive module, wired here
 *   - Phase 3 (connect)    — PGSAdapter, wired here
 *   - Phase 4 (critique)   — STUB (Phase 4 implementation follows this)
 *
 * Behind `architecture.cognitionMode` flag. When `legacy_roles`, this runner
 * never fires — the orchestrator's existing cycle continues untouched. When
 * `thinking_machine`, this is how thoughts get produced.
 *
 * Emits results via the same events as legacy role thoughts so the dashboard
 * thoughts stream keeps working without changes.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { DeepDive } = require('./deep-dive');
const { PGSAdapter } = require('./pgs-adapter');
const { Critique } = require('./critique');
const { assessConvergence } = require('./convergence');

const DEFAULT_CONFIG = {
  heartbeatMs: 15 * 60 * 1000,   // 15-min minimum between deep cycles (per spec)
  maxCandidatesPerHeartbeat: 1,  // one candidate per heartbeat for v1
  pgsBudget: undefined,          // defaults from pgs-adapter
  discardedLogPath: null,        // path for discarded.jsonl; set by orchestrator
  eventLedger: null,             // EventLedger instance for continuity events
};

class ThinkingMachine {
  /**
   * @param {object} opts
   * @param {object} opts.unifiedClient
   * @param {object} opts.memory
   * @param {object} opts.discoveryEngine
   * @param {object} opts.logger
   * @param {Function} opts.getTemporalContext
   * @param {Function} [opts.emitThought] - optional hook; defaults to cosmoEvents.emitThought
   * @param {Function} [opts.logThought] - optional persistence hook
   * @param {object} [opts.config]
   */
  constructor(opts = {}) {
    if (!opts.unifiedClient) throw new Error('ThinkingMachine requires unifiedClient');
    if (!opts.memory) throw new Error('ThinkingMachine requires memory');
    if (!opts.discoveryEngine) throw new Error('ThinkingMachine requires discoveryEngine');

    this.unifiedClient = opts.unifiedClient;
    this.memory = opts.memory;
    this.discoveryEngine = opts.discoveryEngine;
    this.logger = opts.logger || console;
    this.getTemporalContext = opts.getTemporalContext || (() => null);
    this.emitThought = opts.emitThought || null;
    this.logThought = opts.logThought || null;
    // Step 24 hooks: called at the end of each cycle and on each critic
    // verdict. Used by the OS-engine publish layer to trigger workspace-
    // insights (cadence) and dream-log (critic-keep gated).
    this.onCycleComplete = typeof opts.onCycleComplete === 'function' ? opts.onCycleComplete : null;
    this.onCriticVerdict = typeof opts.onCriticVerdict === 'function' ? opts.onCriticVerdict : null;
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    // Back-pressure: track cycles since last crystallization receipt. Warn
    // when over threshold so slowness is observable. Receipts land on a
    // separate file; index.js updates this via notifyCrystallizationReceipt().
    this.cyclesWithoutReceipt = 0;
    this.backpressureThreshold = this.config.cyclesWithoutReceiptThreshold || 10;

    this.deepDive = new DeepDive({
      unifiedClient: this.unifiedClient,
      memory: this.memory,
      logger: this.logger,
    });

    this.pgsAdapter = new PGSAdapter({
      unifiedClient: this.unifiedClient,
      memory: this.memory,
      logger: this.logger,
    });

    this.critique = new Critique({
      unifiedClient: this.unifiedClient,
      logger: this.logger,
    });

    this.eventLedger = this.config.eventLedger || null;  // EventLedger instance (optional)
    this.agendaStore = this.config.agendaStore || null;  // AgendaStore instance (optional)

    // Retain the N most-recent kept thoughts with full provenance so the
    // observability panel can show them with PGS edges + critique passes.
    this.recentThoughts = [];
    this.recentThoughtsMax = this.config.recentThoughtsMax || 20;

    this.running = false;
    this.heartbeatTimer = null;
    this.lastHeartbeatAt = null;
    this.cycleInFlight = false;

    this.stats = {
      heartbeats: 0,
      cyclesRun: 0,
      cyclesKept: 0,
      cyclesDiscarded: 0,
      lastRunAt: null,
      lastRunDurationMs: null,
      errors: 0,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    this.logger.info?.('[thinking-machine] started', {
      heartbeatMs: this.config.heartbeatMs,
      pgsAvailable: this.pgsAdapter.available,
    });

    // Fire first heartbeat shortly after start so we don't wait 15 min for first signal
    setTimeout(() => this._heartbeat().catch(e => this._onError('first-heartbeat', e)), 5000);
    this.heartbeatTimer = setInterval(
      () => this._heartbeat().catch(e => this._onError('heartbeat', e)),
      this.config.heartbeatMs
    );
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.logger.info?.('[thinking-machine] stopped');
  }

  /**
   * Step 24 — reset back-pressure counter. Called by the engine boot's
   * bus `crystallize` handler so the thinking-machine sees observation
   * flow even though crystallization happens off-cycle.
   */
  notifyCrystallizationReceipt() {
    this.cyclesWithoutReceipt = 0;
  }

  getStats() {
    return {
      ...this.stats,
      running: this.running,
      cyclesWithoutReceipt: this.cyclesWithoutReceipt,
      pgsAdapterStats: this.pgsAdapter.getStats(),
    };
  }

  /**
   * Return the last N kept thoughts with full provenance for observability.
   */
  getRecentThoughts(n = 10) {
    const count = Math.min(n || 10, this.recentThoughts.length);
    return this.recentThoughts.slice(0, count);
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────

  async _heartbeat() {
    if (!this.running) return;
    if (this.cycleInFlight) {
      this.logger.info?.('[thinking-machine] skip heartbeat — prior cycle still running');
      return;
    }

    this.stats.heartbeats++;
    this.lastHeartbeatAt = new Date().toISOString();

    const candidates = this.discoveryEngine.pop(this.config.maxCandidatesPerHeartbeat);
    if (!candidates || candidates.length === 0) {
      this.logger.info?.('[thinking-machine] discovery queue empty, skipping heartbeat');
      return;
    }

    for (const candidate of candidates) {
      if (!this.running) break;
      await this._runCycle(candidate).catch(e => this._onError('cycle', e));
    }
  }

  // ─── Single cycle: discover → deep-dive → connect → critique ─────────

  async _runCycle(candidate) {
    this.cycleInFlight = true;
    const started = Date.now();
    const temporalContext = this._safeTemporalContext();
    const cycleSessionId = `tm-cycle-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    try {
      this.stats.cyclesRun++;

      // Phase 2: deep-dive (first pass)
      this.logger.info?.('[thinking-machine] deep-dive start', {
        signal: candidate.signal,
        score: candidate.score,
      });
      let dive = await this.deepDive.think(candidate, temporalContext, null);

      // Event: ThoughtEmerged (raw output of deep-dive, pre-critique)
      this._emit('ThoughtEmerged', cycleSessionId, {
        candidate: { signal: candidate.signal, score: candidate.score, clusterId: candidate.clusterId, rationale: candidate.rationale },
        textLength: dive.text?.length || 0,
        referencedNodes: dive.referencedNodes,
        neighborhoodSize: dive.usage?.neighborhoodSize,
        temporalPhase: temporalContext?.jtrTime?.phase,
        temporalRhythms: temporalContext?.jtrTime?.activeRhythms,
        pipelinePhase: 'deep-dive',
        passNum: 1,
      });

      if (!dive.text || dive.text.trim().length < 20) {
        this.logger.info?.('[thinking-machine] deep-dive returned empty, discarding');
        this.stats.cyclesDiscarded++;
        this._emit('ThoughtDiscarded', cycleSessionId, { reason: 'empty_deep_dive', passes: 0 });
        await this._logDiscarded({ reason: 'empty_deep_dive', candidate, temporalContext, dive: null, passes: [] });
        return;
      }

      // Phase 3: connect (PGS) — runs once per cycle; revisions don't re-query PGS
      const connect = await this.pgsAdapter.connect({
        thought: dive.text,
        referencedNodes: dive.referencedNodes,
        temporalContext,
        budget: this.config.pgsBudget,
      });

      // Event: PgsInvoked
      this._emit('PgsInvoked', cycleSessionId, {
        available: connect.available,
        note: connect.note,
        partitionsTouched: connect.usage?.partitionsTouched || 0,
        candidateEdges: (connect.candidateEdges || []).length,
        perspectives: (connect.perspectives || []).length,
        durationMs: connect.usage?.durationMs,
      });

      // Phase 4: critique loop with convergence
      const passes = [];
      let finalVerdict = null;
      let terminationReason = null;

      for (let passNum = 1; passNum <= 10; passNum++) { // safety ceiling; convergence detector will terminate far sooner
        const pass = await this.critique.evaluate({
          thought: dive.text,
          pgsResult: connect,
          temporalContext,
          candidate,
          priorPasses: passes,
        });
        passes.push(pass);

        const conv = assessConvergence(passes);

        // Event: CritiqueVerdict (one per pass)
        this._emit('CritiqueVerdict', cycleSessionId, {
          passNum,
          verdict: pass.verdict,
          confidence: pass.confidence,
          gaps: pass.gaps,
          rationale: pass.rationale,
          terminate: conv.terminate,
          terminationReason: conv.reason,
          forcedVerdict: conv.forcedVerdict || null,
        });

        this.logger.info?.('[thinking-machine] critique pass', {
          pass: passNum,
          verdict: pass.verdict,
          confidence: pass.confidence,
          gaps: pass.gaps.length,
          terminate: conv.terminate,
          reason: conv.reason,
        });

        if (conv.terminate) {
          terminationReason = conv.reason;
          finalVerdict = conv.forcedVerdict
            ? { ...pass, verdict: conv.forcedVerdict, forcedBy: conv.reason }
            : pass;
          break;
        }

        // Not terminating — critique said revise with actionable gaps. Re-run deep-dive.
        const priorText = dive.text;
        dive = await this.deepDive.think(candidate, temporalContext, {
          previousThought: priorText,
          critique: pass,
        });

        // Event: ThoughtEmerged (revised)
        this._emit('ThoughtEmerged', cycleSessionId, {
          candidate: { signal: candidate.signal, score: candidate.score, clusterId: candidate.clusterId },
          textLength: dive.text?.length || 0,
          referencedNodes: dive.referencedNodes,
          pipelinePhase: 'deep-dive-revision',
          passNum: passNum + 1,
          respondingToGaps: pass.gaps,
        });

        if (!dive.text || dive.text.trim().length < 20) {
          this.logger.info?.('[thinking-machine] revised deep-dive returned empty, discarding');
          finalVerdict = { verdict: 'discard', confidence: pass.confidence, gaps: [], rationale: 'revised deep-dive empty', forcedBy: 'empty_revision' };
          terminationReason = 'empty_revision';
          break;
        }
      }

      // If somehow we exit the loop without a verdict, force discard
      if (!finalVerdict) {
        finalVerdict = { verdict: 'discard', confidence: 0.5, gaps: [], rationale: 'critique loop fell through without verdict', forcedBy: 'loop_exit' };
        terminationReason = 'loop_exit';
      }

      // Build the canonical thought record
      const thought = {
        text: dive.text,
        reasoning: dive.reasoning,
        referencedNodes: dive.referencedNodes,
        temporalContext,
        deepDiveUsage: dive.usage,
        connect: {
          available: connect.available,
          note: connect.note,
          perspectives: connect.perspectives,
          candidateEdges: connect.candidateEdges,
          connectionNotes: connect.connectionNotes,
          usage: connect.usage,
        },
        verdict: finalVerdict,
        critiquePasses: passes,
        terminationReason,
        provenance: {
          pipeline: 'thinking-machine',
          phaseSet: ['discover', 'deep-dive', 'connect', 'critique'],
          candidate,
        },
      };

      // Route by verdict: keep → emit + log; discard → silence (write to discarded.jsonl only)
      if (finalVerdict.verdict === 'keep') {
        if (this.emitThought) {
          try { this.emitThought(thought); } catch (e) {
            this.logger.warn?.('[thinking-machine] emitThought failed', { error: e?.message });
          }
        }
        if (this.logThought) {
          try { await this.logThought(thought); } catch (e) {
            this.logger.warn?.('[thinking-machine] logThought failed', { error: e?.message });
          }
        }

        // Event: MemoryCandidateCreated (kept thought enters promotion pipeline)
        this._emit('MemoryCandidateCreated', cycleSessionId, {
          source: 'thinking-machine',
          textLength: dive.text.length,
          referencedNodes: dive.referencedNodes,
          confidence: finalVerdict.confidence,
          passes: passes.length,
          candidateSignal: candidate.signal,
          pgsAvailable: connect.available,
          pgsEdges: (connect.candidateEdges || []).length,
        });

        // Retain this kept thought in the recent-thoughts ring buffer for
        // the observability panel. Include the cycleSessionId so the UI can
        // cross-reference agenda items back to their parent thought.
        const recentEntry = {
          cycleSessionId,
          ts: new Date().toISOString(),
          candidate: { signal: candidate.signal, score: candidate.score, clusterId: candidate.clusterId, rationale: candidate.rationale },
          text: dive.text,
          referencedNodes: dive.referencedNodes,
          neighborhoodSize: dive.usage?.neighborhoodSize,
          temporalContext: temporalContext ? {
            now: temporalContext.now,
            phase: temporalContext.jtrTime?.phase,
            dayType: temporalContext.jtrTime?.dayType,
            dayName: temporalContext.jtrTime?.dayName,
            activeRhythms: temporalContext.jtrTime?.activeRhythms,
          } : null,
          connect: {
            available: connect.available,
            note: connect.note,
            partitionsTouched: connect.usage?.partitionsTouched || 0,
            candidateEdges: connect.candidateEdges,
            perspectives: (connect.perspectives || []).map(p => ({ angle: p.angle, searchCount: (p.searchResult || []).length })),
            connectionNotes: connect.connectionNotes,
            answer: (connect.answer || '').slice(0, 4000),
            durationMs: connect.usage?.durationMs,
          },
          critiquePasses: passes.map(p => ({
            verdict: p.verdict,
            confidence: p.confidence,
            rationale: p.rationale,
            gaps: p.gaps,
            agendaCandidates: p.agendaCandidates,
          })),
          finalVerdict,
          terminationReason,
          model: dive.usage?.model || null,
          agendaIds: [],  // filled in below
        };

        // Persist agenda candidates from the final (keep) critique pass
        const agendaIds = [];
        if (this.agendaStore && Array.isArray(finalVerdict.agendaCandidates) && finalVerdict.agendaCandidates.length > 0) {
          for (const ac of finalVerdict.agendaCandidates) {
            const rec = this.agendaStore.add({
              content: ac.content,
              kind: ac.kind,
              topicTags: ac.topicTags,
              sourceCycleSessionId: cycleSessionId,
              sourceSignal: candidate.signal,
              referencedNodes: dive.referencedNodes,
              temporalContext,
            });
            if (rec) {
              agendaIds.push(rec.id);
              this._emit('AgendaCandidateCreated', cycleSessionId, {
                agendaId: rec.id,
                content: rec.content,
                kind: rec.kind,
                topicTags: rec.topicTags,
              });
            }
          }
        }
        thought.agendaIds = agendaIds;
        recentEntry.agendaIds = agendaIds;

        // Ring-buffer: newest first, cap at recentThoughtsMax
        this.recentThoughts.unshift(recentEntry);
        if (this.recentThoughts.length > this.recentThoughtsMax) {
          this.recentThoughts.length = this.recentThoughtsMax;
        }

        this.stats.cyclesKept++;
        this.logger.info?.('[thinking-machine] cycle KEPT', {
          signal: candidate.signal,
          passes: passes.length,
          confidence: finalVerdict.confidence,
          textLen: dive.text.length,
          pgsAvailable: connect.available,
        });
      } else {
        // discard — silence is the output
        this.stats.cyclesDiscarded++;
        await this._logDiscarded({ reason: terminationReason, candidate, temporalContext, dive, passes, finalVerdict });

        // Event: ThoughtDiscarded
        this._emit('ThoughtDiscarded', cycleSessionId, {
          reason: terminationReason,
          passes: passes.length,
          confidence: finalVerdict.confidence,
          forcedBy: finalVerdict.forcedBy || null,
          candidateSignal: candidate.signal,
          rationale: finalVerdict.rationale?.slice(0, 300),
        });

        this.logger.info?.('[thinking-machine] cycle DISCARDED', {
          signal: candidate.signal,
          passes: passes.length,
          reason: terminationReason,
          confidence: finalVerdict.confidence,
          rationale: finalVerdict.rationale?.slice(0, 120),
        });
      }

      this.stats.lastRunAt = new Date().toISOString();
      this.stats.lastRunDurationMs = Date.now() - started;

      // Step 24 — cycleComplete hook (publishers consume this to emit
      // cadence-based workspace-insights artifacts).
      this.cyclesWithoutReceipt += 1;
      if (this.cyclesWithoutReceipt >= this.backpressureThreshold) {
        this.logger.warn?.('[thinking-machine] back-pressure: ' + this.cyclesWithoutReceipt + ' cycles without crystallization receipt — observation flow may be stalled');
      }
      if (this.onCycleComplete) {
        try {
          await this.onCycleComplete({
            cycleIndex: this.stats.cyclesRun,
            verdict: finalVerdict?.verdict || 'discard',
            cycleSessionId,
            durationMs: this.stats.lastRunDurationMs,
          });
        } catch (e) { this.logger.warn?.('[thinking-machine] onCycleComplete failed', { error: e?.message }); }
      }
      // Critic-keep verdict hook (dream-log consumes this to publish
      // creative outputs that pass the critic ratchet).
      if (this.onCriticVerdict && finalVerdict?.verdict) {
        try {
          await this.onCriticVerdict({
            verdict: finalVerdict.verdict,
            cycleIndex: this.stats.cyclesRun,
            creative: finalVerdict.verdict === 'keep' ? { title: (candidate?.rationale || '').slice(0, 60), text: dive?.text || '' } : null,
            thought: finalVerdict.verdict === 'keep' ? dive?.text : null,
          });
        } catch (e) { this.logger.warn?.('[thinking-machine] onCriticVerdict failed', { error: e?.message }); }
      }
    } finally {
      this.cycleInFlight = false;
    }
  }

  _emit(eventType, sessionId, payload) {
    if (!this.eventLedger) return;
    try {
      this.eventLedger.record(eventType, sessionId, payload, { actor: 'thinking-machine' });
    } catch (e) {
      this.logger.warn?.('[thinking-machine] ledger emit failed', { eventType, error: e?.message });
    }
  }

  async _logDiscarded(record) {
    if (!this.config.discardedLogPath) return;
    try {
      const entry = {
        ts: new Date().toISOString(),
        reason: record.reason,
        candidate: record.candidate,
        temporalContext: record.temporalContext,
        finalVerdict: record.finalVerdict || null,
        passes: record.passes || [],
        thought: record.dive ? {
          text: record.dive.text,
          referencedNodes: record.dive.referencedNodes,
        } : null,
      };
      await fs.promises.appendFile(this.config.discardedLogPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      this.logger.warn?.('[thinking-machine] failed to write discarded log', { error: e?.message });
    }
  }

  _safeTemporalContext() {
    try {
      return this.getTemporalContext() || null;
    } catch {
      return null;
    }
  }

  _onError(where, err) {
    this.stats.errors++;
    this.logger.warn?.('[thinking-machine] error', {
      where,
      error: err?.message,
      stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
    });
  }
}

module.exports = { ThinkingMachine };
