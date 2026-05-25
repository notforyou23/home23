import { AuthorityPolicy } from './authority-policy.js';
import { loadAgencyCharter } from './charter.js';
import { ConsequenceEngine } from './consequence-engine.js';
import { AgencyEditor } from './editor.js';
import { InboxRouter } from './inbox-router.js';
import { PursuitStore } from './pursuit-store.js';
import { AgencySelector } from './selector.js';
import { SourceTruthHierarchy } from './source-truth.js';

function nowIso() {
  return new Date().toISOString();
}

export class AgencyKernel {
  constructor({ brainDir, agentName = 'jerry', config = {}, charterPath = null, logger = console } = {}) {
    if (!brainDir) throw new Error('AgencyKernel requires brainDir');
    this.agentName = agentName;
    this.charter = loadAgencyCharter({ charterPath, config, agentName });
    this.config = {
      enabled: config.enabled !== false,
      mode: config.mode || 'dry_run',
      residentTickMs: config.residentTickMs || this.charter.attention?.residentTickMs || 60_000,
    };
    this.logger = logger;
    this.store = new PursuitStore({ brainDir, agentName });
    this.router = new InboxRouter();
    this.selector = new AgencySelector();
    this.authority = new AuthorityPolicy({ mode: this.config.mode, approvals: config.approvals || [] });
    this.consequences = new ConsequenceEngine({ charter: this.charter });
    this.editor = new AgencyEditor({ charter: this.charter });
    this.truth = new SourceTruthHierarchy({ hierarchy: this.charter.sourceTruthHierarchy });
    this.ensureState();
  }

  ensureState() {
    this.enforceAttentionCaps();
    const active = this.store.listPursuits({ status: 'active', limit: 10000 });
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    const deferred = this.store.listPursuits({ status: 'deferred', limit: 10000 });
    const claims = this.store.listTruth({ limit: 10000 }).reverse();
    const truthSummary = this.truth.summarize(claims);
    const existing = this.store.readState() || {};
    const state = {
      schema: 'home23.agency.state.v1',
      agent: this.agentName,
      enabled: this.config.enabled,
      mode: this.config.mode,
      updatedAt: nowIso(),
      charter: {
        schema: this.charter.schema,
        attention: this.charter.attention,
        authority: this.charter.authority,
      },
      bootcamp: this.charter.bootcamp,
      attention: {
        currentPursuitId: active[0]?.id || watch[0]?.id || existing.attention?.currentPursuitId || null,
        queueDepth: this.store.listInbox({ limit: 10000 }).length,
        activePursuits: active.length,
        watchItems: watch.length,
        deferredItems: deferred.length,
        maxActivePursuits: this.charter.attention.maxActivePursuits,
        maxWatchItems: this.charter.attention.maxWatchItems,
      },
      self: {
        role: 'resident-agency-kernel',
        posture: this.config.mode === 'live' ? 'bounded-live' : 'dry-run-observer',
      },
      obligations: existing.obligations || [],
      watchlist: watch.slice(0, 20).map(row => ({ id: row.id, title: row.title, lastTouched: row.lastTouched || row.updatedAt })),
      truth: truthSummary,
      recentBeliefChanges: truthSummary.recentBeliefChanges,
      openContradictions: claims.filter(claim => claim.contradicts && claim.status !== 'resolved').slice(-20),
      governance: existing.governance || null,
      lastMeaningfulActions: existing.lastMeaningfulActions || [],
      nextAction: existing.nextAction || null,
    };
    this.store.writeState(state);
    return state;
  }

  enforceAttentionCaps() {
    const maxActive = Number(this.charter.attention.maxActivePursuits || 5);
    const maxWatch = Number(this.charter.attention.maxWatchItems || 20);
    const active = this.store.listPursuits({ status: 'active', limit: 10000 });
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    for (const pursuit of active.slice(maxActive)) {
      this.store.updatePursuit(pursuit.id, { status: 'deferred' }, {
        type: 'attention_cap_deferred',
        reason: 'active_attention_budget_reconciled',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'deferred',
        pursuitId: pursuit.id,
        route: 'defer',
        reason: 'active_attention_budget_reconciled',
        mode: this.config.mode,
      });
    }
    for (const pursuit of watch.slice(maxWatch)) {
      this.store.updatePursuit(pursuit.id, { status: 'deferred' }, {
        type: 'attention_cap_deferred',
        reason: 'watch_attention_budget_reconciled',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'deferred',
        pursuitId: pursuit.id,
        route: 'defer',
        reason: 'watch_attention_budget_reconciled',
        mode: this.config.mode,
      });
    }
  }

  async intake(input = {}) {
    const candidate = this.router.normalize(input);
    const existing = this.store.findSimilar(candidate);
    const decision = this.selector.select(candidate, { existing, budget: this.attentionBudget() });
    const inboxEntry = {
      ...candidate,
      decision,
    };
    this.store.appendInbox(inboxEntry);

    let pursuit = null;
    if (decision.route === 'pursue' || decision.route === 'watch') {
      pursuit = existing
        ? this.store.mergeSeen(existing, candidate, decision)
        : this.store.createPursuit(candidate, decision);
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: existing ? 'merged' : 'selected',
        candidateId: candidate.candidateId,
        pursuitId: pursuit.id,
        route: decision.route,
        reason: decision.reason,
        mode: this.config.mode,
        authority: this.authority.evaluate({ authorityLevel: pursuit.authorityLevel }),
      });
    } else if (decision.route === 'request-authority') {
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'authority_requested',
        candidateId: candidate.candidateId,
        route: decision.route,
        reason: decision.reason,
        mode: this.config.mode,
        authority: this.authority.evaluate({ authorityLevel: candidate.authorityLevel }),
      });
    } else if (decision.route === 'defer') {
      pursuit = existing || this.store.createPursuit(candidate, { ...decision, route: 'watch' });
      pursuit = this.store.updatePursuit(pursuit.id, { status: 'deferred' }, { type: 'deferred', reason: decision.reason });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'deferred',
        candidateId: candidate.candidateId,
        pursuitId: pursuit.id,
        route: decision.route,
        reason: decision.reason,
        mode: this.config.mode,
      });
    } else {
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'discarded',
        candidateId: candidate.candidateId,
        route: decision.route,
        reason: decision.reason,
        mode: this.config.mode,
      });
    }

    const state = this.ensureState();
    return { candidate: inboxEntry, decision, pursuit, state };
  }

  attentionBudget() {
    return {
      activeCount: this.store.listPursuits({ status: 'active', limit: 10000 }).length,
      watchCount: this.store.listPursuits({ status: 'watch', limit: 10000 }).length,
      maxActivePursuits: this.charter.attention.maxActivePursuits,
      maxWatchItems: this.charter.attention.maxWatchItems,
    };
  }

  async intakeWorldStream(input = {}) {
    const candidateInput = {
      ...input,
      kind: input.kind || 'world_stream',
      tags: [...(Array.isArray(input.tags) ? input.tags : []), 'world-stream'],
    };
    if (input.explicitNoChange) {
      candidateInput.summary = input.summary || 'World-stream item produced explicit no-change receipt.';
    }
    const candidate = this.router.normalize(candidateInput);
    const closure = this.applyReceiptClosure(candidate);
    if (closure) {
      const decision = { route: 'close', reason: 'receipt_proved_stop_condition' };
      this.store.appendInbox({ ...candidate, decision });
      const receipt = this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'closed',
        candidateId: candidate.candidateId,
        pursuitId: closure.pursuit.id,
        source: candidate.source,
        route: decision.route,
        outcome: 'pursuit_closed_by_receipt',
        seen: candidate.seen,
        discarded: candidate.discarded,
        connectsTo: candidate.connectsTo,
        nextMove: candidate.nextMove || null,
        reason: decision.reason,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: closure.pursuit.id,
        status: 'closed',
        changeType: 'pursuit_closed_by_receipt',
        summary: candidate.changedFuture || candidate.summary,
        evidence: candidate.evidence,
      });
      const state = this.ensureState();
      return { candidate, decision, pursuit: closure.pursuit, receipt, state };
    }
    const decision = candidate.explicitNoChange
      ? { route: 'discard', reason: 'explicit_no_change' }
      : this.selector.select(candidate, { existing: this.store.findSimilar(candidate), budget: this.attentionBudget() });
    this.store.appendInbox({ ...candidate, decision });

    let pursuit = null;
    if (decision.route === 'pursue' || decision.route === 'watch') {
      pursuit = this.store.createPursuit(candidate, decision);
    }
    const outcome = candidate.explicitNoChange
      ? 'explicit_no_change'
      : decision.route;
    const receipt = this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at: nowIso(),
      event: 'world_stream_assimilated',
      candidateId: candidate.candidateId,
      pursuitId: pursuit?.id || null,
      source: candidate.source,
      route: decision.route,
      outcome,
      seen: candidate.seen,
      discarded: candidate.discarded,
      connectsTo: candidate.connectsTo,
      nextMove: candidate.nextMove || null,
      reason: decision.reason,
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at: nowIso(),
      pursuitId: pursuit?.id || null,
      status: decision.route,
      changeType: outcome,
      summary: candidate.summary,
      evidence: candidate.evidence,
    });
    const state = this.ensureState();
    return { candidate, decision, pursuit, receipt, state };
  }

  applyReceiptClosure(candidate = {}) {
    const pursuitId = candidate.pursuitId;
    if (!pursuitId) return null;
    const status = String(candidate.consequenceStatus || '').toLowerCase();
    const provesClosure = status === 'closed' || status === 'resolved' || status === 'passed' || Boolean(candidate.changedFuture);
    if (!provesClosure) return null;
    const existing = this.store.getPursuit(pursuitId);
    if (!existing || existing.status === 'closed') return null;
    const pursuit = this.store.updatePursuit(pursuitId, {
      status: 'closed',
      consequence: {
        changed: true,
        pursuitId,
        summary: candidate.changedFuture || candidate.summary,
        evidence: candidate.evidence,
      },
      latestEvidence: Array.isArray(candidate.evidence) ? candidate.evidence.slice(-3) : existing.latestEvidence,
      lastTouched: nowIso(),
    }, {
      type: 'receipt_closure',
      reason: 'receipt_proved_stop_condition',
      detail: { candidateId: candidate.candidateId, source: candidate.source },
    });
    return { pursuit };
  }

  transition(pursuitId, transition = {}) {
    const existing = this.store.getPursuit(pursuitId);
    if (!existing) throw new Error(`Pursuit not found: ${pursuitId}`);
    const consequence = this.consequences.evaluate(existing, transition);
    const pursuit = this.store.transition(pursuitId, {
      ...transition,
      consequence,
      evidence: transition.evidence || (transition.evidenceRef ? [{ type: 'reference', ref: transition.evidenceRef }] : []),
    });
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at: nowIso(),
      event: transition.transition === 'request_authority' ? 'authority_requested' : 'transitioned',
      pursuitId,
      status: pursuit.status,
      reason: transition.reason || transition.summary || null,
      mode: this.config.mode,
      authority: this.authority.evaluate({
        authorityLevel: transition.authorityLevel || pursuit.authorityLevel,
        action: transition.action,
        approvalId: transition.approvalId,
      }),
    });
    const state = this.ensureState();
    return { pursuit, state, consequence };
  }

  state() {
    return this.ensureState();
  }

  pursuits(options = {}) {
    return this.store.listPursuits(options);
  }

  pursuit(id) {
    return this.store.getPursuit(id);
  }

  inbox(options = {}) {
    return this.store.listInbox(options);
  }

  events(options = {}) {
    const receipts = this.store.listReceipts(options);
    return {
      inbox: this.store.listInbox(options),
      receipts,
      actions: receipts,
      consequences: this.store.listConsequences(options),
      scratch: this.store.listScratch(options),
      truth: this.store.listTruth(options),
    };
  }

  recordClaim(input = {}) {
    const claim = this.truth.claim(input);
    this.store.appendTruth(claim);
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at: nowIso(),
      event: 'truth_claim_recorded',
      claimId: claim.id,
      sourceType: claim.sourceType,
      authorityRank: claim.authorityRank,
      reason: claim.contradicts ? 'claim_contests_existing_truth' : 'claim_added_to_source_hierarchy',
      mode: this.config.mode,
    });
    this.ensureState();
    return claim;
  }

  proposeDelta(input = {}) {
    const at = nowIso();
    const authority = this.authority.evaluate({
      authorityLevel: input.authorityLevel || 'L1',
      action: input.changeType || input.action || 'delta',
      approvalId: input.approvalId,
    });
    const decision = this.consequences.arbitrateDelta(input, authority, this.config.mode);
    const delta = {
      schema: 'home23.agency.delta.v1',
      at,
      changeType: input.changeType || 'behavioral_delta',
      summary: input.summary || null,
      target: input.target || null,
      reversible: input.reversible !== false,
      authorityLevel: authority.level,
      decision,
    };
    const applied = decision.apply ? this.applyDelta(input, delta, authority) : null;
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'delta_proposed',
      changeType: delta.changeType,
      route: decision.route,
      reason: decision.reason,
      authority,
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: input.pursuitId || null,
      status: decision.route,
      changeType: delta.changeType,
      summary: delta.summary,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      authority,
      apply: decision.apply,
    });
    if (applied) {
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'delta_applied',
        changeType: delta.changeType,
        pursuitId: applied.pursuitId || null,
        route: 'applied',
        reason: decision.reason,
        authority,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId: applied.pursuitId || null,
        status: 'applied',
        changeType: delta.changeType,
        summary: delta.summary,
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        authority,
      });
    }
    this.store.appendScratch({
      schema: 'home23.agency.scratch.v1',
      at,
      kind: 'delta_arbitration',
      provisionalTheory: input.summary || null,
      note: `${delta.changeType} -> ${decision.route}`,
    });
    const state = this.ensureState();
    return { delta, decision, authority, applied, state };
  }

  applyDelta(input = {}, delta = {}, authority = {}) {
    if (delta.changeType === 'watch_item_created') {
      const candidate = this.router.normalize({
        source: input.source || 'agency.delta',
        kind: 'watch_item',
        summary: input.summary || 'Agency watch item created by approved delta.',
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        authorityLevel: authority.level || input.authorityLevel || 'L1',
        desiredChangedFuture: input.desiredChangedFuture || input.summary || null,
        nextMove: input.nextMove || 'review during resident tick',
        tags: Array.isArray(input.tags) ? input.tags : ['watch'],
        whyItMatters: input.whyItMatters || input.desiredChangedFuture || input.summary || null,
        currentTheory: input.currentTheory || 'Approved live delta created this watch item.',
      });
      const pursuit = this.store.createPursuit(candidate, {
        route: 'watch',
        reason: 'approved_live_delta_watch_item_created',
      });
      return {
        kind: 'watch_item_created',
        pursuitId: pursuit.id,
      };
    }
    return {
      kind: 'no_op',
      reason: 'delta_type_has_no_live_applier',
    };
  }

  async tick({ reason = 'resident_tick', now = nowIso() } = {}) {
    if (!this.config.enabled) return null;
    const selected = this.selectResidentPursuit();
    const killReview = this.runKillReview({ now, excludeId: selected?.id || null });
    if (!selected) {
      const state = this.writeNextAction({
        kind: 'rest',
        reason: 'no_active_or_watch_pursuits',
        at: now,
      });
      return { selected: null, editor: null, killReview, nextAction: state.nextAction, state };
    }

    const editor = this.editor.evaluate(selected);
    const nextAction = {
      kind: editor.action,
      pursuitId: selected.id,
      authorityLevel: selected.authorityLevel,
      reason: editor.reason,
      at: now,
      dryRun: this.config.mode !== 'live',
    };
    this.store.appendScratch({
      schema: 'home23.agency.scratch.v1',
      at: now,
      kind: 'resident_tick',
      pursuitId: selected.id,
      provisionalTheory: selected.currentTheory,
      editorVerdict: editor.verdict,
      note: `Resident tick selected one pursuit and chose ${editor.action}.`,
    });
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at: now,
      event: 'resident_tick',
      pursuitId: selected.id,
      reason,
      editor,
      nextAction,
      authority: this.authority.evaluate({ authorityLevel: selected.authorityLevel, action: nextAction.kind }),
      mode: this.config.mode,
    });
    if (editor.action === 'kill_stale_thread') {
      this.store.updatePursuit(selected.id, { status: 'discarded' }, {
        type: 'editor_kill',
        reason: editor.reason,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: now,
        event: 'discarded',
        pursuitId: selected.id,
        route: 'discard',
        reason: editor.reason,
        editor,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: now,
        pursuitId: selected.id,
        status: 'discarded',
        changeType: 'stale_thread_killed',
        summary: editor.reason,
        evidence: selected.latestEvidence || selected.evidence || [],
      });
    }
    if (editor.verdict === 'veto' || editor.action === 'require_consequence') {
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: now,
        pursuitId: selected.id,
        status: selected.status,
        changeType: 'explicit_no_change',
        summary: editor.reason,
        evidence: selected.latestEvidence || selected.evidence || [],
      });
    }
    const state = this.writeNextAction(nextAction);
    return { selected: { pursuitId: selected.id, status: selected.status }, editor, killReview, nextAction, state };
  }

  runKillReview({ now = nowIso(), excludeId = null } = {}) {
    if (!this.charter.bootcamp?.weeklyKillReview) return { checked: 0, killed: [] };
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    const killed = [];
    let checked = 0;
    for (const pursuit of watch) {
      if (pursuit.id === excludeId) continue;
      checked += 1;
      const verdict = this.editor.evaluate(pursuit);
      if (verdict.action !== 'kill_stale_thread') continue;
      this.store.updatePursuit(pursuit.id, { status: 'discarded' }, {
        type: 'bootcamp_kill_review',
        reason: verdict.reason,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: now,
        event: 'kill_review',
        pursuitId: pursuit.id,
        route: 'discard',
        reason: verdict.reason,
        editor: verdict,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: now,
        pursuitId: pursuit.id,
        status: 'discarded',
        changeType: 'stale_thread_killed',
        summary: verdict.reason,
        evidence: pursuit.latestEvidence || pursuit.evidence || [],
      });
      killed.push({ pursuitId: pursuit.id, reason: verdict.reason });
    }
    const existing = this.store.readState() || {};
    this.store.writeState({
      ...existing,
      governance: {
        ...(existing.governance || {}),
        lastKillReview: { at: now, checked, killed: killed.length },
      },
    });
    return { checked, killed };
  }

  selectResidentPursuit() {
    const active = this.store.listPursuits({ status: 'active', limit: 10000 });
    if (active.length) return active[0];
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    return watch[0] || null;
  }

  writeNextAction(nextAction) {
    const existing = this.store.readState() || {};
    const recent = [
      ...(existing.lastMeaningfulActions || []),
      { ...nextAction, recordedAt: nowIso() },
    ].slice(-20);
    const state = {
      ...this.ensureState(),
      nextAction,
      lastMeaningfulActions: recent,
    };
    this.store.writeState(state);
    return state;
  }

  async handleObservation(obs) {
    if (!obs || !this.config.enabled) return null;
    return this.intake({
      source: obs.channelId,
      kind: obs.channelId === 'domain.good-life' ? 'good_life_policy' : 'observation',
      summary: summarizeObservation(obs),
      evidence: [{ type: 'observation', ref: obs.traceId || obs.sourceRef || obs.channelId }],
      authorityLevel: obs.channelId === 'domain.good-life' || obs.channelId?.startsWith('work.') ? 'L2' : 'L1',
      desiredChangedFuture: obs.payload?.policy?.actionCard?.expectedOutcome || null,
      verifier: obs.verifierId ? { type: 'verifier', ref: obs.verifierId } : null,
      tags: [obs.channelId, ...(obs.payload?.policy?.mode ? [`good-life:${obs.payload.policy.mode}`] : [])],
      policyMode: obs.payload?.policy?.mode || null,
      payload: obs.payload || null,
    });
  }
}

function summarizeObservation(obs) {
  if (obs?.payload?.summary) return String(obs.payload.summary);
  if (obs?.payload?.policy?.reason) return `Good Life ${obs.payload.policy.mode}: ${obs.payload.policy.reason}`;
  if (obs?.payload?.summary !== undefined) return String(obs.payload.summary);
  if (typeof obs?.payload === 'string') return obs.payload;
  return `[${obs?.channelId || 'observation'}] ${JSON.stringify(obs?.payload || {}).slice(0, 240)}`;
}
