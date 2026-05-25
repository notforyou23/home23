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

function renderBriefText(questions = {}) {
  const following = Array.isArray(questions.whatFollowing) && questions.whatFollowing.length
    ? questions.whatFollowing.map(item => `- ${item.id}: ${briefText(item.title || 'untitled', 120)} (${item.status}, ${item.authorityLevel || 'L1'}) -> ${briefText(item.nextMove || item.desiredChangedFuture || 'no next move recorded', 160)}`).join('\n')
    : '- nothing active; resident spine should rest or intake new evidence';
  const changed = Array.isArray(questions.whatChanged) && questions.whatChanged.length
    ? questions.whatChanged.map(item => `- ${item.changeType || 'change'}: ${briefText(item.summary || item.status || 'recorded', 180)}${item.pursuitId ? ` (${item.pursuitId})` : ''}`).join('\n')
    : '- no meaningful change recorded yet';
  const next = questions.whatDoingNext || {};
  const needs = Array.isArray(questions.whatNeedFromJtr) && questions.whatNeedFromJtr.length
    ? questions.whatNeedFromJtr.map(item => `- ${item.authorityLevel || 'approval'}${item.pursuitId ? ` for ${item.pursuitId}` : ''}: ${briefText(item.reason || 'decision needed', 180)}`).join('\n')
    : '- nothing right now';
  return [
    'What we are following:',
    following,
    '',
    'What changed:',
    changed,
    '',
    'What I am doing next:',
    `- ${next.kind || 'none'}${next.pursuitId ? ` for ${next.pursuitId}` : ''}: ${briefText(next.reason || next.summary || next.nextMove || 'no next action recorded', 180)}`,
    '',
    'What I need from jtr:',
    needs,
  ].join('\n');
}

function briefText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
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
    this.reconcileResolvedLiveProblemAttention();
    this.reconcileCronBootcampStopConditions();
    this.reconcileLowSignalAttention();
    this.enforceAttentionCaps();
    const active = this.store.listPursuits({ status: 'active', limit: 10000 });
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    const deferred = this.store.listPursuits({ status: 'deferred', limit: 10000 });
    const claims = this.store.listTruth({ limit: 10000 }).reverse();
    const truthSummary = this.truth.summarize(claims);
    const existing = this.store.readState() || {};
    const obligations = this.deriveObligations({ truthSummary });
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
      organs: this.charter.organs || {},
      obligations,
      watchlist: watch.slice(0, 20).map(row => ({ id: row.id, title: row.title, lastTouched: row.lastTouched || row.updatedAt })),
      truth: truthSummary,
      recentBeliefChanges: truthSummary.recentBeliefChanges,
      openContradictions: truthSummary.unresolvedClaims || [],
      governance: existing.governance || null,
      lastMeaningfulActions: existing.lastMeaningfulActions || [],
      nextAction: existing.nextAction || null,
    };
    this.store.writeState(state);
    return state;
  }

  deriveObligations({ truthSummary = {} } = {}) {
    const obligations = [];
    const seen = new Set();
    const add = (item = {}) => {
      const key = `${item.kind}:${item.pursuitId || item.candidateId || item.claimId || item.reason || item.at || obligations.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      obligations.push({
        schema: 'home23.agency.obligation.v1',
        status: 'open',
        ...item,
      });
    };
    for (const row of this.store.listReceipts({ limit: 200 })) {
      if (!(row.event === 'authority_requested' || row.route === 'request-authority')) continue;
      const pursuit = row.pursuitId ? this.store.getPursuit(row.pursuitId) : null;
      if (pursuit && (pursuit.status === 'closed' || pursuit.status === 'discarded')) continue;
      add({
        kind: 'authority_request',
        at: row.at,
        candidateId: row.candidateId || null,
        pursuitId: row.pursuitId || null,
        authorityLevel: row.authority?.level || row.authorityLevel || 'unknown',
        reason: row.reason || row.authority?.reason || 'authority requested',
      });
    }
    for (const pursuit of this.store.listPursuits({ status: 'blocked', limit: 100 })) {
      add({
        kind: 'blocked_pursuit',
        at: pursuit.updatedAt,
        pursuitId: pursuit.id,
        authorityLevel: pursuit.authorityLevel || 'unknown',
        reason: pursuit.nextMove || pursuit.summary || 'blocked pursuit needs operator decision',
      });
    }
    const unresolvedClaims = Array.isArray(truthSummary.unresolvedClaims) ? truthSummary.unresolvedClaims : [];
    for (const claim of unresolvedClaims.slice(0, 20)) {
      add({
        kind: 'truth_contradiction',
        at: claim.at,
        claimId: claim.id || null,
        authorityLevel: 'jtr_correction',
        reason: `Resolve contradiction: ${claim.claim || claim.id}`,
      });
    }
    return obligations.slice(0, 50);
  }

  reconcileLowSignalAttention() {
    const pursuits = this.store.listPursuits({ status: ['active', 'watch'], limit: 10000 });
    for (const pursuit of pursuits) {
      const reason = lowSignalAttentionReason(pursuit);
      if (!reason) continue;
      this.store.updatePursuit(pursuit.id, { status: 'discarded' }, {
        type: 'attention_quality_discarded',
        reason,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'discarded',
        pursuitId: pursuit.id,
        route: 'discard',
        reason,
        mode: this.config.mode,
      });
    }
  }

  reconcileResolvedLiveProblemAttention() {
    const pursuits = this.store.listPursuits({ status: ['active', 'watch'], limit: 10000 });
    for (const pursuit of pursuits) {
      if (isResolvedLiveProblemPursuit(pursuit)) {
        this.store.updatePursuit(pursuit.id, {
          status: 'closed',
          consequence: {
            changed: true,
            pursuitId: pursuit.id,
            summary: pursuit.desiredChangedFuture || pursuit.summary,
            evidence: pursuit.latestEvidence || pursuit.evidence || [],
          },
          lastTouched: nowIso(),
        }, {
          type: 'resolved_live_problem_reconciled',
          reason: 'resolved_live_problem_verified',
        });
        this.store.appendReceipt({
          schema: 'home23.agency.receipt.v1',
          at: nowIso(),
          event: 'closed',
          pursuitId: pursuit.id,
          route: 'close',
          outcome: 'pursuit_closed_by_receipt',
          reason: 'resolved_live_problem_verified',
          mode: this.config.mode,
        });
        this.store.appendConsequence({
          schema: 'home23.agency.consequence.v1',
          at: nowIso(),
          pursuitId: pursuit.id,
          status: 'closed',
          changeType: 'pursuit_closed_by_receipt',
          summary: pursuit.desiredChangedFuture || pursuit.summary,
          evidence: pursuit.latestEvidence || pursuit.evidence || [],
        });
        continue;
      }
      if (!isResolvedLiveProblemObservationPursuit(pursuit)) continue;
      this.store.updatePursuit(pursuit.id, { status: 'discarded' }, {
        type: 'resolved_live_problem_observation_discarded',
        reason: 'resolved_live_problem_observation_not_attention',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'discarded',
        pursuitId: pursuit.id,
        route: 'discard',
        reason: 'resolved_live_problem_observation_not_attention',
        mode: this.config.mode,
      });
    }
  }

  reconcileCronBootcampStopConditions() {
    const pursuits = this.store.listPursuits({ status: ['active', 'watch'], limit: 10000 });
    const boundConsequences = this.store.listConsequences({ limit: 10000 })
      .filter(row => row.changeType === 'cron_bound_to_pursuit' && row.status === 'applied' && row.pursuitId);
    const boundByPursuitId = new Map(boundConsequences.map(row => [row.pursuitId, row]));
    for (const pursuit of pursuits) {
      if (!isCronBootcampAuditPursuit(pursuit)) continue;
      const consequence = boundByPursuitId.get(pursuit.id);
      if (!consequence) continue;
      this.store.updatePursuit(pursuit.id, {
        status: 'closed',
        consequence: {
          changed: true,
          pursuitId: pursuit.id,
          summary: consequence.summary || pursuit.desiredChangedFuture || pursuit.summary,
          evidence: consequence.evidence || pursuit.latestEvidence || pursuit.evidence || [],
        },
        lastTouched: nowIso(),
      }, {
        type: 'cron_bootcamp_stop_condition_reconciled',
        reason: 'cron_bootcamp_stop_condition_satisfied',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'closed',
        pursuitId: pursuit.id,
        route: 'close',
        outcome: 'pursuit_closed_by_receipt',
        reason: 'cron_bootcamp_stop_condition_satisfied',
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: pursuit.id,
        status: 'closed',
        changeType: 'pursuit_closed_by_receipt',
        summary: consequence.summary || pursuit.desiredChangedFuture || pursuit.summary,
        evidence: consequence.evidence || pursuit.latestEvidence || pursuit.evidence || [],
      });
    }
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
    const attachment = this.applyReceiptAttachment(candidate);
    if (attachment) {
      const decision = { route: 'attach', reason: 'receipt_attached_to_existing_pursuit' };
      this.store.appendInbox({ ...candidate, decision });
      const receipt = this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'pursuit_evidence_assimilated',
        candidateId: candidate.candidateId,
        pursuitId: attachment.pursuit.id,
        source: candidate.source,
        route: decision.route,
        outcome: candidate.consequenceStatus || candidate.kind || 'attached',
        seen: candidate.seen,
        connectsTo: candidate.connectsTo,
        nextMove: candidate.nextMove || null,
        reason: decision.reason,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: attachment.pursuit.id,
        status: candidate.consequenceStatus || 'observed',
        changeType: candidate.kind || 'world_stream_attached',
        summary: candidate.summary,
        evidence: candidate.evidence,
      });
      const state = this.ensureState();
      return { candidate, decision, pursuit: attachment.pursuit, receipt, state };
    }
    if (candidate.claim) {
      const claim = this.recordClaim({
        ...candidate.claim,
        sourceRef: candidate.claim.sourceRef || candidate.evidence?.[0]?.ref || candidate.source,
      });
      const decision = { route: 'claim', reason: 'world_stream_recorded_durable_claim' };
      this.store.appendInbox({ ...candidate, decision });
      const receipt = this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_assimilated',
        candidateId: candidate.candidateId,
        claimId: claim.id,
        source: candidate.source,
        route: decision.route,
        outcome: 'durable_claim',
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
        pursuitId: null,
        status: 'claim_recorded',
        changeType: 'belief_updated',
        summary: claim.claim,
        evidence: candidate.evidence,
      });
      const state = this.ensureState();
      return { candidate, decision, claim, receipt, state };
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

  applyReceiptAttachment(candidate = {}) {
    const pursuitId = candidate.pursuitId;
    if (!pursuitId) return null;
    const existing = this.store.getPursuit(pursuitId);
    if (!existing || existing.status === 'closed' || existing.status === 'discarded') return null;
    const evidence = [...(existing.evidence || []), ...(Array.isArray(candidate.evidence) ? candidate.evidence : [])];
    const uniqueEvidence = [];
    const seen = new Set();
    for (const item of evidence) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueEvidence.push(item);
    }
    const pursuit = this.store.updatePursuit(pursuitId, {
      evidence: uniqueEvidence,
      linkedEvidence: uniqueEvidence,
      latestEvidence: Array.isArray(candidate.evidence) ? candidate.evidence.slice(-3) : existing.latestEvidence,
      lastSeenAt: nowIso(),
      lastTouched: nowIso(),
      seenCount: Number(existing.seenCount || 1) + 1,
    }, {
      type: 'world_stream_attached',
      reason: candidate.summary || 'receipt_attached_to_existing_pursuit',
      detail: { candidateId: candidate.candidateId, source: candidate.source, consequenceStatus: candidate.consequenceStatus },
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

  inspector(options = {}) {
    const filter = options.filter || 'all';
    const limit = Math.max(1, Math.min(Number(options.limit || 50), 200));
    const consequences = this.store.listConsequences({ limit: Math.max(limit * 5, 100) });
    const cronRetirementRows = consequences.filter(row => (
      row.changeType === 'cron_retirement_proposed'
      || row.changeType === 'cron_retired_by_editor'
    ));
    const cronRetirementProposals = cronRetirementRows.slice(0, limit).map(row => {
      const evidence = Array.isArray(row.evidence) ? row.evidence : [];
      return {
        at: row.at,
        pursuitId: row.pursuitId || null,
        status: row.status || null,
        changeType: row.changeType,
        summary: row.summary || row.reason || null,
        job: evidence.find(item => item?.type === 'cron_job') || null,
        pursuit: evidence.find(item => item?.type === 'agency_pursuit') || null,
        runEvidence: evidence.filter(item => item?.type === 'cron_run_log_excerpt'),
        evidenceChain: evidence,
      };
    });
    return {
      schema: 'home23.agency.inspector.v1',
      agent: this.agentName,
      at: nowIso(),
      mode: this.config.mode,
      filter,
      filters: {
        cronRetirementProposals: {
          count: cronRetirementRows.length,
          items: cronRetirementProposals,
        },
      },
    };
  }

  brief() {
    const state = this.ensureState();
    const following = [
      ...this.store.listPursuits({ status: 'active', limit: 5 }),
      ...this.store.listPursuits({ status: 'watch', limit: 5 }),
    ].slice(0, 8).map(pursuit => ({
      id: pursuit.id,
      status: pursuit.status,
      title: pursuit.title || pursuit.summary,
      authorityLevel: pursuit.authorityLevel,
      whyItMatters: pursuit.whyItMatters,
      desiredChangedFuture: pursuit.desiredChangedFuture,
      nextMove: pursuit.nextMove,
      lastTouched: pursuit.lastTouched || pursuit.updatedAt,
    }));
    const consequences = this.store.listConsequences({ limit: 20 });
    const changed = (Array.isArray(state.lastMeaningfulActions) && state.lastMeaningfulActions.length
      ? state.lastMeaningfulActions
      : consequences
    ).slice(0, 8).map(row => ({
      at: row.at,
      pursuitId: row.pursuitId || null,
      status: row.status || null,
      changeType: row.changeType || row.event || 'change',
      summary: row.summary || row.reason || null,
    }));
    const nextAction = state.nextAction || {
      kind: 'rest',
      reason: 'no_next_action_recorded',
    };
    const needFromJtr = Array.isArray(state.obligations)
      ? state.obligations.slice(0, 8).map(item => ({
          at: item.at,
          pursuitId: item.pursuitId || null,
          authorityLevel: item.authorityLevel || 'unknown',
          reason: item.reason || 'operator decision needed',
        }))
      : [];
    const questions = {
      whatFollowing: following,
      whatChanged: changed,
      whatDoingNext: nextAction,
      whatNeedFromJtr: needFromJtr,
    };
    return {
      schema: 'home23.agency.brief.v1',
      agent: this.agentName,
      at: nowIso(),
      mode: state.mode,
      questions,
      text: renderBriefText(questions),
    };
  }

  recordClaim(input = {}) {
    const existingClaims = this.store.listTruth({ limit: 10000 }).reverse();
    const { claim, superseded } = this.truth.settleClaim(input, existingClaims);
    this.store.appendTruth(claim);
    for (const stale of superseded) {
      this.store.appendTruth(stale);
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: stale.supersededAt || nowIso(),
        event: 'truth_claim_superseded',
        claimId: stale.id,
        supersededBy: stale.supersededBy,
        reason: stale.supersessionReason || 'higher_authority_claim',
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: stale.supersededAt || nowIso(),
        pursuitId: null,
        status: 'superseded',
        changeType: 'truth_claim_demoted',
        summary: `Claim ${stale.id} superseded by ${stale.supersededBy}.`,
        evidence: [
          { type: 'truth_claim', ref: stale.id },
          { type: 'truth_claim', ref: stale.supersededBy },
        ],
      });
    }
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at: nowIso(),
      event: 'truth_claim_recorded',
      claimId: claim.id,
      sourceType: claim.sourceType,
      authorityRank: claim.authorityRank,
      reason: claim.resolvesContradiction
        ? 'claim_supersedes_lower_authority_truth'
        : claim.contradicts
          ? 'claim_contests_existing_truth'
          : 'claim_added_to_source_hierarchy',
      mode: this.config.mode,
    });
    this.ensureState();
    return claim;
  }

  recordConsequence(input = {}) {
    const at = input.at || nowIso();
    const consequence = {
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: input.pursuitId || null,
      status: input.status || 'observed',
      changeType: input.changeType || 'external_consequence',
      summary: input.summary || null,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      source: input.source || null,
    };
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: input.event || 'external_consequence',
      pursuitId: consequence.pursuitId,
      route: consequence.status,
      reason: input.reason || consequence.summary,
      changeType: consequence.changeType,
      mode: this.config.mode,
    });
    this.store.appendConsequence(consequence);
    const existing = this.store.readState() || {};
    const lastMeaningfulActions = [
      {
        at,
        pursuitId: consequence.pursuitId,
        status: consequence.status,
        changeType: consequence.changeType,
        summary: consequence.summary,
      },
      ...(Array.isArray(existing.lastMeaningfulActions) ? existing.lastMeaningfulActions : []),
    ].slice(0, 20);
    this.store.writeState({
      ...existing,
      lastMeaningfulActions,
    });
    this.ensureState();
    return consequence;
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
    if (delta.changeType === 'pursuit_note_added') {
      const pursuitId = input.pursuitId || input.targetPursuitId || null;
      if (!pursuitId) {
        return {
          kind: 'no_op',
          reason: 'pursuit_note_delta_requires_pursuit_id',
        };
      }
      const existing = this.store.getPursuit(pursuitId);
      if (!existing || existing.status === 'closed' || existing.status === 'discarded') {
        return {
          kind: 'no_op',
          reason: 'pursuit_note_delta_target_unavailable',
          pursuitId,
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const agencyNotes = [
        {
          at: nowIso(),
          summary: input.summary || null,
          currentTheory: input.currentTheory || null,
          nextMove: input.nextMove || null,
          evidence,
        },
        ...(Array.isArray(existing.agencyNotes) ? existing.agencyNotes : []),
      ].slice(0, 25);
      const mergedEvidence = [];
      const seen = new Set();
      for (const item of [...(existing.evidence || []), ...evidence]) {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        mergedEvidence.push(item);
      }
      this.store.updatePursuit(pursuitId, {
        currentTheory: input.currentTheory || existing.currentTheory,
        nextMove: input.nextMove || existing.nextMove,
        agencyNotes,
        evidence: mergedEvidence,
        linkedEvidence: mergedEvidence,
        latestEvidence: evidence.length ? evidence.slice(-3) : existing.latestEvidence,
        lastTouched: nowIso(),
      }, {
        type: 'pursuit_note_added',
        reason: input.summary || 'approved_live_delta_pursuit_note_added',
      });
      return {
        kind: 'pursuit_note_added',
        pursuitId,
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
    if (obs.channelId === 'work.live-problems') {
      return this.handleLiveProblemObservation(obs);
    }
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

  async handleLiveProblemObservation(obs) {
    const problem = obs.payload || {};
    const problemId = problem.id || obs.sourceRef || 'unknown';
    const summary = problem.claim || problem.issue || problem.summary || `Live problem ${problemId} changed state to ${problem.state || 'unknown'}.`;
    const evidence = [{
      type: 'live_problem',
      ref: obs.sourceRef || `live-problem:${problemId}:${problem.updatedAt || problem.resolvedAt || problem.openedAt || nowIso()}`,
      state: problem.state || null,
      verifier: obs.verifierId || null,
    }];
    const candidate = this.router.normalize({
      source: 'work.live-problems',
      kind: 'live_problem',
      dedupeKey: `live-problem:${problemId}`,
      summary,
      evidence,
      authorityLevel: 'L2',
      desiredChangedFuture: problem.state === 'resolved'
        ? `Live problem ${problemId} is resolved with verifier evidence.`
        : `Live problem ${problemId} is verified, repaired, or explicitly demoted.`,
      nextMove: problem.state === 'resolved'
        ? 'close the resident pursuit with live-problem verifier evidence'
        : 'advance the smallest remediation or verifier-backed handoff',
      stopCondition: `live-problem ${problemId} state becomes resolved or unverifiable with receipt`,
      verifier: obs.verifierId ? { type: 'verifier', ref: obs.verifierId } : (problem.verifier || null),
      tags: ['work.live-problems', 'live-problem', problem.state || 'unknown'],
      payload: problem,
    });
    if (problem.state === 'resolved') {
      const existing = this.store.findSimilar(candidate);
      if (existing) {
        return this.intakeWorldStream({
          source: 'work.live-problems',
          kind: 'live_problem_receipt',
          summary: `Live problem ${problemId} resolved: ${summary}`,
          pursuitId: existing.id,
          consequenceStatus: 'closed',
          changedFuture: `Live problem ${problemId} resolved with verifier evidence.`,
          desiredChangedFuture: `Live problem ${problemId} resolved with verifier evidence.`,
          nextMove: 'keep closed unless the live-problem registry reopens it',
          seen: [summary],
          evidence,
          tags: ['work.live-problems', 'live-problem', 'resolved'],
        });
      }
      return this.intakeWorldStream({
        source: 'work.live-problems',
        kind: 'live_problem_receipt',
        summary: `Live problem ${problemId} is already resolved with verifier evidence: ${summary}`,
        consequenceStatus: 'resolved',
        explicitNoChange: true,
        nextMove: 'keep closed unless the live-problem registry reopens it',
        seen: [summary],
        discarded: [],
        evidence,
        tags: ['work.live-problems', 'live-problem', 'resolved'],
      });
    }
    return this.intake(candidate);
  }
}

function summarizeObservation(obs) {
  if (obs?.payload?.summary) return String(obs.payload.summary);
  if (obs?.payload?.policy?.reason) return `Good Life ${obs.payload.policy.mode}: ${obs.payload.policy.reason}`;
  if (obs?.payload?.summary !== undefined) return String(obs.payload.summary);
  if (typeof obs?.payload === 'string') return obs.payload;
  return `[${obs?.channelId || 'observation'}] ${JSON.stringify(obs?.payload || {}).slice(0, 240)}`;
}

function lowSignalAttentionReason(pursuit = {}) {
  if (isRawObservationPursuit(pursuit)) return 'raw_observation_not_attention';
  if (isMechanicalCronNoChangePursuit(pursuit)) return 'mechanical_cron_no_change_not_attention';
  return null;
}

function hasMeaningfulPursuitOutcome(pursuit = {}) {
  if (pursuit.consequence?.changed) return true;
  const summary = String(pursuit.summary || '');
  const changedFuture = String(pursuit.desiredChangedFuture || '');
  const stopCondition = String(pursuit.stopCondition || '');
  const hasMeaningfulChangedFuture = changedFuture && changedFuture !== summary;
  const genericStopCondition = stopCondition === 'changed future is verified or the pursuit is explicitly discarded';
  const hasMeaningfulStopCondition = stopCondition && !genericStopCondition && stopCondition !== summary && stopCondition !== changedFuture;
  return Boolean(hasMeaningfulChangedFuture || hasMeaningfulStopCondition);
}

function isRawObservationPursuit(pursuit = {}) {
  if (pursuit.kind !== 'observation') return false;
  if (hasMeaningfulPursuitOutcome(pursuit)) return false;
  const source = String(pursuit.source || '');
  return source.startsWith('machine.') || source.startsWith('os.') || source === 'work.heartbeat';
}

function isMechanicalCronNoChangePursuit(pursuit = {}) {
  if (pursuit.kind !== 'cron_report') return false;
  if (pursuit.pursuitId || pursuit.consequence?.changed) return false;
  if (hasMeaningfulPursuitOutcome(pursuit)) return false;
  const source = String(pursuit.source || '');
  const summary = String(pursuit.summary || '');
  return source.startsWith('cron.') && /finished with status ok/i.test(summary);
}

function hasResolvedLiveProblemEvidence(pursuit = {}) {
  const tags = Array.isArray(pursuit.tags) ? pursuit.tags : [];
  if (tags.includes('resolved')) return true;
  const evidence = [
    ...(Array.isArray(pursuit.evidence) ? pursuit.evidence : []),
    ...(Array.isArray(pursuit.latestEvidence) ? pursuit.latestEvidence : []),
  ];
  if (evidence.some(item => item?.state === 'resolved')) return true;
  return /"state"\s*:\s*"resolved"/i.test(String(pursuit.summary || ''));
}

function isResolvedLiveProblemPursuit(pursuit = {}) {
  return pursuit.kind === 'live_problem'
    && pursuit.source === 'work.live-problems'
    && hasResolvedLiveProblemEvidence(pursuit);
}

function isResolvedLiveProblemObservationPursuit(pursuit = {}) {
  return pursuit.kind === 'observation'
    && pursuit.source === 'work.live-problems'
    && hasResolvedLiveProblemEvidence(pursuit);
}

function isCronBootcampAuditPursuit(pursuit = {}) {
  return pursuit.kind === 'cron_bootcamp_audit'
    && pursuit.source === 'scheduler.cron.bootcamp';
}
