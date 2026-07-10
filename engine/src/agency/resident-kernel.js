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

function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
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

function compactStatePursuit(pursuit = {}) {
  return {
    id: pursuit.id,
    status: pursuit.status,
    title: pursuit.title || pursuit.summary || null,
    summary: pursuit.summary || null,
    owner: pursuit.owner || null,
    authorityLevel: pursuit.authorityLevel || 'L1',
    risk: pursuit.risk || pursuit.authorityLevel || 'L1',
    source: pursuit.source || null,
    kind: pursuit.kind || null,
    tags: Array.isArray(pursuit.tags) ? pursuit.tags : [],
    whyItMatters: pursuit.whyItMatters || null,
    currentTheory: pursuit.currentTheory || null,
    desiredChangedFuture: pursuit.desiredChangedFuture || null,
    nextMove: pursuit.nextMove || null,
    attentionBudget: pursuit.attentionBudget || null,
    evidenceStandard: pursuit.evidenceStandard || null,
    stopCondition: pursuit.stopCondition || null,
    decay: pursuit.decay || null,
    escalation: pursuit.escalation || null,
    whatWouldChangeMyMind: pursuit.whatWouldChangeMyMind || null,
    linkedEvidence: Array.isArray(pursuit.linkedEvidence) ? pursuit.linkedEvidence.slice(-10) : [],
    latestEvidence: Array.isArray(pursuit.latestEvidence) ? pursuit.latestEvidence.slice(-5) : [],
    createdAt: pursuit.createdAt || null,
    updatedAt: pursuit.updatedAt || null,
    lastTouched: pursuit.lastTouched || pursuit.updatedAt || null,
    lastSeenAt: pursuit.lastSeenAt || null,
    seenCount: Number(pursuit.seenCount || 0),
  };
}

function compactStateConsequence(row = {}) {
  return {
    at: row.at || null,
    pursuitId: row.pursuitId || null,
    status: row.status || null,
    changeType: row.changeType || row.event || 'change',
    summary: row.summary || row.reason || null,
    source: row.source || null,
    evidence: Array.isArray(row.evidence) ? row.evidence.slice(-10) : [],
  };
}

function compactStateTask(task = {}) {
  return {
    id: task.id,
    status: task.status || 'open',
    pursuitId: task.pursuitId || null,
    summary: task.summary || null,
    actionKind: task.actionKind || 'bounded_action',
    authorityLevel: task.authorityLevel || 'L2',
    handoff: task.handoff || null,
    stopCondition: task.stopCondition || null,
    updatedAt: task.updatedAt || task.createdAt || null,
  };
}

function normalizeNextActionForMode(nextAction, mode) {
  if (!nextAction) return null;
  return {
    ...nextAction,
    dryRun: mode !== 'live',
  };
}

/**
 * Witness-independence check for pursuit closure.
 *
 * A close is self-attested when the only evidence sources are the same agent
 * that owns the pursuit (self+subject). Such closes are marked 'provisional'
 * rather than 'closed', so 'verified' carries real evidentiary weight.
 *
 * Evidence from a different agent (e.g., forrest, a worker run, jtr correction)
 * or from an independent system artifact (e.g., file on disk, API response)
 * counts as an independent witness.
 */
function isSelfAttestedClose(pursuit, evidence = []) {
  const owner = pursuit.owner || 'jerry';
  const allEvidence = [
    ...(Array.isArray(pursuit.evidence) ? pursuit.evidence : []),
    ...(Array.isArray(evidence) ? evidence : []),
  ];
  if (!allEvidence.length) return true; // no evidence = self-attested
  // Check if any evidence item has an independent witness
  const hasIndependent = allEvidence.some(item => {
    const ref = String(item.ref || item.type || '');
    const source = String(item.source || '');
    const type = String(item.type || '').toLowerCase();
    // Independent witnesses: other agents, worker runs, file artifacts, API responses, jtr
    if (ref.startsWith('trace:') && source && source !== owner && source !== 'work.worker-runs') return true;
    if (type === 'jtr_correction' || type === 'verifier_receipt') return true;
    if (type === 'live_problem' || ref.startsWith('live-problem:')) return true;
    if (type === 'cron_job' || source === 'scheduler.cron.bootcamp') return true;
    if (type === 'reference' && (ref.includes('.md') || ref.includes('.json') || ref.includes('/'))) return true;
    if (type === 'worker_receipt' || type === 'file_artifact') return true;
    if (source.startsWith('jtr') || source === 'chat' || source === 'human') return true;
    return false;
  });
  return !hasIndependent;
}

export class AgencyKernel {
  constructor({ brainDir, agentName = 'jerry', config = {}, charterPath = null, logger = console } = {}) {
    if (!brainDir) throw new Error('AgencyKernel requires brainDir');
    this.agentName = agentName;
    this.charter = loadAgencyCharter({ charterPath, config, agentName });
    this.config = {
      enabled: config.enabled !== false,
      mode: config.mode || 'live',
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
    this.reconcileMisroutedCronReceiptAttention();
    this.reconcileDuplicateAttention();
    this.reconcileStaleTruthClaims();
    this.enforceAttentionCaps();
    const active = this.store.listPursuits({ status: 'active', limit: 10000 });
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    const deferred = this.store.listPursuits({ status: 'deferred', limit: 10000 });
    const provisional = this.store.listPursuits({ status: 'provisional', limit: 10000 });
    const openTasks = this.store.listTasks({ status: 'open', limit: 50 });
    const recentMemoryCandidates = this.store.listMemoryCandidates({ limit: 10 });
    const recentConsequences = this.store.listConsequences({ limit: 1000 })
      .filter(isMeaningfulConsequence)
      .slice(0, 20)
      .map(compactStateConsequence);
    const claims = this.store.listTruth({ limit: 10000 }).reverse();
    const truthSummary = this.truth.summarize(claims);
    const existing = this.store.readState() || {};
    if (existing.mode && existing.mode !== this.config.mode) {
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'agency_mode_changed',
        route: 'authority_posture_changed',
        fromMode: existing.mode,
        toMode: this.config.mode,
        reason: 'current_config_overrides_persisted_agency_mode',
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: null,
        status: 'applied',
        changeType: 'agency_mode_changed',
        summary: `Resident agency mode changed from ${existing.mode} to ${this.config.mode}.`,
        evidence: [{ type: 'config', ref: 'agency.mode' }],
      });
    }
    const postureOverride = existing.governance?.postureOverride || null;
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
        operatingContract: this.charter.operatingContract,
      },
      bootcamp: this.charter.bootcamp,
      attention: {
        currentPursuitId: active[0]?.id || watch[0]?.id || existing.attention?.currentPursuitId || null,
        queueDepth: this.store.countInboxLines(),
        activePursuits: active.length,
        watchItems: watch.length,
        deferredItems: deferred.length,
        provisionalCloses: provisional.length,
        openTasks: openTasks.length,
        maxActivePursuits: this.charter.attention.maxActivePursuits,
        maxWatchItems: this.charter.attention.maxWatchItems,
        maxDeferredItems: this.charter.attention.maxDeferredItems,
      },
      self: {
        role: 'resident-agency-kernel',
        posture: postureOverride?.posture || (this.config.mode === 'live' ? 'bounded-live' : 'dry-run-observer'),
        postureReason: postureOverride?.reason || null,
      },
      currentPursuit: active[0] ? compactStatePursuit(active[0]) : null,
      activePursuits: active.slice(0, this.charter.attention.maxActivePursuits || 5).map(compactStatePursuit),
      organs: this.charter.organs || {},
      obligations,
      openTasks: openTasks.slice(0, 20).map(compactStateTask),
      watchlist: watch.slice(0, this.charter.attention.maxWatchItems || 20).map(compactStatePursuit),
      truth: truthSummary,
      recentBeliefChanges: truthSummary.recentBeliefChanges,
      recentConsequences,
      recentMemoryCandidates: recentMemoryCandidates.map(candidate => ({
        id: candidate.id,
        domain: candidate.domain,
        summary: candidate.summary,
        pursuitId: candidate.pursuitId || null,
        status: candidate.status || 'candidate',
        createdAt: candidate.createdAt || candidate.at || null,
      })),
      openContradictions: truthSummary.unresolvedClaims || [],
      governance: existing.governance || null,
      lastMeaningfulActions: existing.lastMeaningfulActions || [],
      nextAction: normalizeNextActionForMode(existing.nextAction, this.config.mode),
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
    // Build a set of questionIds that have been explicitly resolved/rejected by a
    // later `jtr_question_resolved` receipt. Without this, an operator_question
    // with no bound pursuit (pursuitId:null) can NEVER clear — it stays an open
    // obligation forever even after the answer is known. This is how the phantom
    // write_path authorization (q_mpzgh6ed_b0e455) kept re-surfacing to jtr.
    const resolvedQuestionIds = new Set();
    for (const row of this.store.listReceipts({ limit: 500 })) {
      if (row.event === 'jtr_question_resolved' && row.questionId) {
        resolvedQuestionIds.add(row.questionId);
      }
    }
    for (const row of this.store.listReceipts({ limit: 200 })) {
      if (row.event !== 'jtr_question_raised') continue;
      if (row.questionId && resolvedQuestionIds.has(row.questionId)) continue;
      const pursuit = row.pursuitId ? this.store.getPursuit(row.pursuitId) : null;
      if (pursuit && (pursuit.status === 'closed' || pursuit.status === 'discarded')) continue;
      add({
        kind: 'operator_question',
        at: row.at,
        questionId: row.questionId || null,
        pursuitId: row.pursuitId || null,
        authorityLevel: row.authorityLevel || 'L3',
        reason: row.question || row.reason || 'operator question raised',
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
    for (const task of this.store.listTasks({ status: 'open', limit: 100 })) {
      add({
        kind: 'open_task',
        at: task.updatedAt || task.createdAt,
        taskId: task.id,
        pursuitId: task.pursuitId || null,
        authorityLevel: task.authorityLevel || 'L2',
        actionKind: task.actionKind || 'bounded_action',
        reason: task.summary || 'open resident task needs closure receipt',
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

  reconcileStaleTruthClaims() {
    const claims = this.store.listTruth({ limit: 10000 }).reverse();
    const staleClaims = this.truth.staleClaims(claims);
    for (const claim of staleClaims) {
      this.store.appendTruth(claim);
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'truth_claim_decayed',
        claimId: claim.id,
        sourceType: claim.sourceType,
        sourceRef: claim.sourceRef,
        route: 'stale',
        reason: claim.staleReason || 'claim_decay_policy_elapsed',
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: null,
        status: 'stale',
        changeType: 'stale_claim_demoted',
        summary: `Claim ${claim.id} decayed out of current state: ${claim.staleReason || 'claim_decay_policy_elapsed'}.`,
        evidence: [{ type: 'truth_claim', ref: claim.id }],
      });
    }
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

  reconcileDuplicateAttention() {
    const pursuits = this.store.listPursuits({ status: ['active', 'watch'], limit: 10000 });
    const groups = new Map();
    for (const pursuit of pursuits) {
      const key = String(pursuit.dedupeKey || '').trim();
      if (!key) continue;
      const list = groups.get(key) || [];
      list.push(pursuit);
      groups.set(key, list);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((a, b) => String(a.createdAt || a.updatedAt || '').localeCompare(String(b.createdAt || b.updatedAt || '')));
      const keeper = ordered[0];
      const duplicates = ordered.slice(1);
      const mergedEvidence = mergeEvidenceItems(ordered.flatMap(pursuit => pursuit.evidence || []));
      const mergedLatestEvidence = mergeEvidenceItems(ordered.flatMap(pursuit => pursuit.latestEvidence || []));
      const status = ordered.some(pursuit => pursuit.status === 'active') ? 'active' : keeper.status;
      const seenCount = ordered.reduce((sum, pursuit) => sum + Number(pursuit.seenCount || 1), 0);
      const lastSeenAt = latestIso(ordered.map(pursuit => pursuit.lastSeenAt || pursuit.updatedAt || pursuit.createdAt));
      this.store.updatePursuit(keeper.id, {
        status,
        evidence: mergedEvidence,
        linkedEvidence: mergedEvidence,
        latestEvidence: mergedLatestEvidence.slice(-3),
        seenCount,
        lastSeenAt: lastSeenAt || keeper.lastSeenAt,
      }, {
        type: 'duplicate_attention_merged',
        reason: 'duplicate_dedupe_key_attention_merged',
      });
      for (const duplicate of duplicates) {
        this.store.updatePursuit(duplicate.id, { status: 'discarded' }, {
          type: 'duplicate_attention_deduped',
          reason: 'duplicate_dedupe_key_attention_merged',
          detail: { mergedInto: keeper.id },
        });
        this.store.appendReceipt({
          schema: 'home23.agency.receipt.v1',
          at: nowIso(),
          event: 'deduped',
          pursuitId: duplicate.id,
          mergedInto: keeper.id,
          route: 'discard',
          reason: 'duplicate_dedupe_key_attention_merged',
          mode: this.config.mode,
        });
        this.store.appendConsequence({
          schema: 'home23.agency.consequence.v1',
          at: nowIso(),
          pursuitId: duplicate.id,
          status: 'discarded',
          changeType: 'duplicate_attention_deduped',
          summary: `Duplicate pursuit ${duplicate.id} merged into ${keeper.id}.`,
          evidence: [
            { type: 'agency_pursuit', ref: duplicate.id },
            { type: 'agency_pursuit', ref: keeper.id },
          ],
        });
      }
    }
  }

  reconcileMisroutedCronReceiptAttention() {
    const pursuits = this.store.listPursuits({ status: ['active', 'watch'], limit: 10000 });
    for (const pursuit of pursuits) {
      if (!isMisroutedBoundCronReceiptPursuit(pursuit)) continue;
      const targetPursuitId = impliedTargetPursuitId(pursuit);
      const target = targetPursuitId ? this.store.getPursuit(targetPursuitId) : null;
      const evidence = Array.isArray(pursuit.latestEvidence) && pursuit.latestEvidence.length
        ? pursuit.latestEvidence
        : (Array.isArray(pursuit.evidence) ? pursuit.evidence : []);
      if (target && target.status !== 'closed' && target.status !== 'discarded') {
        const mergedEvidence = mergeEvidenceItems([...(target.evidence || []), ...evidence]);
        this.store.updatePursuit(target.id, {
          evidence: mergedEvidence,
          linkedEvidence: mergedEvidence,
          latestEvidence: evidence.length ? evidence.slice(-3) : target.latestEvidence,
          lastSeenAt: nowIso(),
          lastTouched: nowIso(),
          seenCount: Number(target.seenCount || 1) + 1,
        }, {
          type: 'cron_receipt_reattached',
          reason: 'legacy_bound_cron_receipt_reattached',
          detail: { sourcePursuitId: pursuit.id },
        });
      }
      this.store.updatePursuit(pursuit.id, { status: 'discarded' }, {
        type: 'cron_receipt_reattached',
        reason: target ? 'legacy_bound_cron_receipt_reattached' : 'legacy_bound_cron_target_unavailable',
        detail: { targetPursuitId },
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'cron_receipt_reattached',
        pursuitId: pursuit.id,
        targetPursuitId,
        route: 'discard',
        reason: target ? 'legacy_bound_cron_receipt_reattached' : 'legacy_bound_cron_target_unavailable',
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: pursuit.id,
        status: 'discarded',
        changeType: 'cron_receipt_reattached',
        summary: target
          ? `Cron receipt pursuit ${pursuit.id} reattached to ${target.id}.`
          : `Cron receipt pursuit ${pursuit.id} discarded because target ${targetPursuitId || 'unknown'} was unavailable.`,
        evidence: [
          ...evidence,
          ...(targetPursuitId ? [{ type: 'agency_pursuit', ref: targetPursuitId }] : []),
        ],
      });
    }
  }

  reconcileResolvedLiveProblemAttention() {
    const pursuits = this.store.listPursuits({ status: ['active', 'watch'], limit: 10000 });
    for (const pursuit of pursuits) {
      if (isResolvedLiveProblemPursuit(pursuit)) {
        const evidence = pursuit.latestEvidence || pursuit.evidence || [];
        const selfAttested = isSelfAttestedClose(pursuit, evidence);
        this.store.updatePursuit(pursuit.id, {
          status: selfAttested ? 'provisional' : 'closed',
          consequence: {
            changed: true,
            pursuitId: pursuit.id,
            summary: pursuit.desiredChangedFuture || pursuit.summary,
            evidence,
          },
          lastTouched: nowIso(),
        }, {
          type: 'resolved_live_problem_reconciled',
          reason: selfAttested ? 'resolved_live_problem_verified_self_attested' : 'resolved_live_problem_verified',
          detail: { witnessIndependent: !selfAttested },
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
      const cronEvidence = consequence.evidence || pursuit.latestEvidence || pursuit.evidence || [];
      const cronSelfAttested = isSelfAttestedClose(pursuit, cronEvidence);
      this.store.updatePursuit(pursuit.id, {
        status: cronSelfAttested ? 'provisional' : 'closed',
        consequence: {
          changed: true,
          pursuitId: pursuit.id,
          summary: consequence.summary || pursuit.desiredChangedFuture || pursuit.summary,
          evidence: cronEvidence,
        },
        lastTouched: nowIso(),
      }, {
        type: 'cron_bootcamp_stop_condition_reconciled',
        reason: cronSelfAttested ? 'cron_bootcamp_stop_condition_satisfied_self_attested' : 'cron_bootcamp_stop_condition_satisfied',
        detail: { witnessIndependent: !cronSelfAttested },
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
    const maxDeferred = Number(this.charter.attention.maxDeferredItems || 200);
    const active = this.store.listPursuits({ status: 'active', limit: 10000 });
    const watch = this.store.listPursuits({ status: 'watch', limit: 10000 });
    const deferred = this.store.listPursuits({ status: 'deferred', limit: 10000 });
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
    for (const pursuit of deferred.slice(maxDeferred)) {
      this.store.updatePursuit(pursuit.id, { status: 'discarded' }, {
        type: 'attention_cap_discarded',
        reason: 'deferred_attention_budget_reconciled',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'discarded',
        pursuitId: pursuit.id,
        route: 'discard',
        reason: 'deferred_attention_budget_reconciled',
        mode: this.config.mode,
      });
    }
  }

  async intake(input = {}) {
    const candidate = this.router.normalize(input);
    const existing = this.store.findSimilar(candidate);
    if (isRedundantGoodLifePolicyPulse(candidate, existing)) {
      const decision = {
        route: 'discard',
        reason: 'active_good_life_policy_already_tracked',
        score: 0,
      };
      return {
        candidate: { ...candidate, decision },
        decision,
        pursuit: existing,
        state: this.ensureState(),
      };
    }
    const decision = this.selector.select(candidate, { existing, budget: this.attentionBudget() });
    const inboxEntry = {
      ...candidate,
      decision,
    };
    // Only append to inbox log if the item has signal (not discarded).
    // Discarded items are already captured in receipts — no need to bloat the inbox.
    if (decision.route !== 'discard') {
      this.store.appendInbox(inboxEntry);
    }

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
    if (!candidate.pursuitId) {
      const targetPursuitId = impliedTargetPursuitId(candidate);
      if (targetPursuitId && this.store.getPursuit(targetPursuitId)) {
        candidate.pursuitId = targetPursuitId;
      }
    }
    if (hasStructuredReportFanout(input)) {
      return this.assimilateStructuredReport(input, candidate);
    }
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
      // Mechanical cron ok / explicit no-change attachments are receipts, not inbox events.
      // Appending them recreated the cron_report flood (hundreds of "finished with status ok").
      const mechanicalAttach = candidate.explicitNoChange === true
        || isMechanicalCronNoChangePursuit({ ...candidate, kind: candidate.kind || 'cron_report' });
      if (!mechanicalAttach) {
        this.store.appendInbox({ ...candidate, decision });
      }
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
    // Dead/missing bound pursuit + mechanical ok must not fall through into pursue.
    // Bootcamp left most cron jobs bound to closed/discarded pursuits.
    if (candidate.pursuitId && isMechanicalCronNoChangeCandidate(candidate)) {
      const decision = { route: 'discard', reason: 'mechanical_cron_dead_binding_no_change' };
      const receipt = this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'discarded',
        candidateId: candidate.candidateId,
        pursuitId: candidate.pursuitId,
        source: candidate.source,
        route: decision.route,
        outcome: 'dead_binding_mechanical_ok',
        seen: candidate.seen,
        reason: decision.reason,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: candidate.pursuitId,
        status: 'discarded',
        changeType: 'mechanical_cron_dead_binding_no_change',
        summary: candidate.summary,
        evidence: candidate.evidence,
      });
      const state = this.ensureState();
      return { candidate: { ...candidate, decision }, decision, pursuit: null, receipt, state };
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
    const editorBlock = this.editor.evaluate({
      ...candidate,
      status: 'candidate',
      title: candidate.title || candidate.summary,
    });
    if (!candidate.explicitNoChange && (editorBlock.action === 'require_consequence' || editorBlock.verdict === 'veto')) {
      const decision = { route: 'discard', reason: editorBlock.reason };
      // Discarded — don't bloat the inbox log; receipt captures it.
      const receipt = this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_assimilated',
        candidateId: candidate.candidateId,
        source: candidate.source,
        route: decision.route,
        outcome: 'editor_rejected_no_consequence',
        seen: candidate.seen,
        discarded: candidate.discarded,
        connectsTo: candidate.connectsTo,
        nextMove: candidate.nextMove || null,
        reason: decision.reason,
        editor: editorBlock,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: null,
        status: 'discarded',
        changeType: 'explicit_no_change',
        summary: editorBlock.reason,
        evidence: candidate.evidence,
      });
      const state = this.ensureState();
      return { candidate, decision, pursuit: null, receipt, state };
    }
    const existing = this.store.findSimilar(candidate);
    const decision = candidate.explicitNoChange
      ? { route: 'discard', reason: 'explicit_no_change' }
      : this.selector.select(candidate, { existing, budget: this.attentionBudget() });
    // Only append to inbox log if the item has signal (not discarded).
    if (decision.route !== 'discard') {
      this.store.appendInbox({ ...candidate, decision });
    }

    let pursuit = null;
    if (decision.route === 'pursue' || decision.route === 'watch') {
      pursuit = existing
        ? this.store.mergeSeen(existing, candidate, decision)
        : this.store.createPursuit(candidate, decision);
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

  assimilateStructuredReport(input = {}, candidate = this.router.normalize(input)) {
    const decision = { route: 'fanout', reason: 'structured_report_items_assimilated' };
    this.store.appendInbox({ ...candidate, decision });
    const at = nowIso();
    const receipt = this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'world_stream_assimilated',
      candidateId: candidate.candidateId,
      source: candidate.source,
      route: decision.route,
      outcome: 'structured_report_fanout',
      seen: candidate.seen,
      discarded: candidate.discarded,
      connectsTo: candidate.connectsTo,
      nextMove: candidate.nextMove || null,
      reason: decision.reason,
      mode: this.config.mode,
    });
    const children = {
      actionWorthy: [],
      watchItems: [],
      claims: [],
      contradictions: [],
      memoryCandidates: [],
      operatorQuestions: [],
      tasks: [],
      discarded: [],
    };
    for (const item of normalizeStructuredItems(input.actionWorthy)) {
      const child = this.createStructuredReportPursuitChild({
        item,
        parent: candidate,
        route: 'pursue',
        childKind: 'report_action',
        reason: 'structured_report_action_worthy',
      });
      children.actionWorthy.push(child);
    }
    for (const item of normalizeStructuredItems(input.watchItems)) {
      const child = this.createStructuredReportPursuitChild({
        item,
        parent: candidate,
        route: 'watch',
        childKind: 'report_watch',
        reason: 'structured_report_watch_item',
      });
      children.watchItems.push(child);
    }
    for (const item of [
      ...normalizeStructuredItems(input.claims),
      ...normalizeStructuredItems(input.beliefUpdates),
    ]) {
      const claimText = String(item.claim || item.summary || item.title || '').trim();
      if (!claimText) continue;
      const evidence = structuredItemEvidence(item, candidate);
      const claim = this.recordClaim({
        claim: claimText,
        sourceType: item.sourceType || 'source_artifact',
        sourceRef: item.sourceRef || item.evidenceRef || candidate.source,
        contradicts: item.contradicts || null,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_child_claim_recorded',
        parentCandidateId: candidate.candidateId,
        claimId: claim.id,
        source: candidate.source,
        route: 'claim',
        outcome: 'belief_updated',
        reason: 'structured_report_claim',
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: item.pursuitId || item.targetPursuitId || null,
        status: 'applied',
        changeType: 'belief_updated',
        summary: claim.claim,
        evidence: [{ type: 'truth_claim', ref: claim.id }, ...evidence],
      });
      children.claims.push({ claimId: claim.id, route: 'claim' });
    }
    for (const item of normalizeStructuredItems(input.contradictions)) {
      const claimText = String(item.claim || item.summary || item.title || '').trim();
      if (!claimText) continue;
      const claim = this.recordClaim({
        claim: claimText,
        sourceType: item.sourceType || 'source_artifact',
        sourceRef: item.sourceRef || item.evidenceRef || candidate.source,
        contradicts: item.contradicts || null,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_child_claimed',
        parentCandidateId: candidate.candidateId,
        claimId: claim.id,
        source: candidate.source,
        route: 'claim',
        outcome: 'durable_claim',
        reason: 'structured_report_contradiction_claim',
        mode: this.config.mode,
      });
      children.contradictions.push({ claimId: claim.id, route: 'claim' });
    }
    for (const item of normalizeStructuredItems(input.memoryCandidates)) {
      const evidence = structuredItemEvidence(item, candidate);
      const memory = this.recordMemoryCandidate({
        summary: item.summary || item.title || item.content,
        memoryContent: item.memoryContent || item.content || item.summary || item.title,
        memoryDomain: item.memoryDomain || item.domain || 'project',
        pursuitId: item.pursuitId || item.targetPursuitId || null,
        source: candidate.source,
        evidence,
        reason: 'structured_report_memory_candidate',
        promoteHint: item.promoteHint || null,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_child_memory_candidate_created',
        parentCandidateId: candidate.candidateId,
        memoryCandidateId: memory.id,
        source: candidate.source,
        route: 'memory_candidate',
        outcome: 'memory_candidate_created',
        reason: 'structured_report_memory_candidate',
        mode: this.config.mode,
      });
      children.memoryCandidates.push({ memoryCandidateId: memory.id, route: 'memory_candidate' });
    }
    for (const item of normalizeStructuredItems(input.operatorQuestions)) {
      const evidence = structuredItemEvidence(item, candidate);
      const question = this.raiseQuestion({
        question: item.question || item.summary || item.title,
        reason: item.reason || 'structured_report_operator_question',
        authorityLevel: item.authorityLevel || 'L3',
        pursuitId: item.pursuitId || item.targetPursuitId || null,
        evidence,
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_child_question_raised',
        parentCandidateId: candidate.candidateId,
        questionId: question.id,
        source: candidate.source,
        route: 'question',
        outcome: 'jtr_question_raised',
        reason: item.reason || 'structured_report_operator_question',
        mode: this.config.mode,
      });
      children.operatorQuestions.push({ questionId: question.id, route: 'question' });
    }
    for (const item of [
      ...normalizeStructuredItems(input.taskItems),
      ...normalizeStructuredItems(input.tasks),
    ]) {
      const evidence = structuredItemEvidence(item, candidate);
      const handoff = item.handoff && typeof item.handoff === 'object'
        ? item.handoff
        : (item.handoffTo || item.handoffObjective
          ? {
              to: item.handoffTo || null,
              objective: item.handoffObjective || item.objective || item.summary || null,
            }
          : null);
      const task = this.recordTask({
        summary: item.summary || item.title || item.objective,
        actionKind: item.actionKind || item.kind || (handoff ? 'handoff' : 'bounded_action'),
        authorityLevel: item.authorityLevel || 'L2',
        pursuitId: item.pursuitId || item.targetPursuitId || null,
        handoff,
        evidence,
        stopCondition: item.stopCondition || 'structured report task is closed with a receipt or explicitly discarded',
        reason: 'structured_report_task',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_child_task_created',
        parentCandidateId: candidate.candidateId,
        taskId: task.id,
        source: candidate.source,
        route: 'task',
        outcome: 'task_created',
        reason: 'structured_report_task_created',
        mode: this.config.mode,
      });
      children.tasks.push({ taskId: task.id, route: 'task' });
    }
    for (const item of normalizeStructuredDiscards(candidate.discarded)) {
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at: nowIso(),
        event: 'world_stream_child_discarded',
        parentCandidateId: candidate.candidateId,
        source: candidate.source,
        route: 'discard',
        outcome: 'discard',
        ref: item.ref,
        reason: item.reason,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: null,
        status: 'discarded',
        changeType: 'report_noise_discarded',
        summary: item.reason,
        evidence: [{ type: 'discarded_report_item', ref: item.ref }],
      });
      children.discarded.push({ ref: item.ref, route: 'discard' });
    }
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: null,
      status: 'fanout',
      changeType: 'structured_report_fanout',
      summary: candidate.summary,
      evidence: candidate.evidence,
      children,
    });
    const state = this.ensureState();
    return { candidate, decision, receipt, children, state };
  }

  createStructuredReportPursuitChild({ item = {}, parent, route, childKind, reason }) {
    const evidence = structuredItemEvidence(item, parent);
    const childCandidate = this.router.normalize({
      source: parent.source,
      kind: item.kind || childKind,
      summary: item.summary || item.title,
      title: item.title,
      authorityLevel: item.authorityLevel || parent.authorityLevel,
      desiredChangedFuture: item.desiredChangedFuture || item.changedFuture || parent.desiredChangedFuture,
      nextMove: item.nextMove || item.next || parent.nextMove,
      whyItMatters: item.whyItMatters || parent.whyItMatters || parent.summary,
      currentTheory: item.currentTheory || item.theory || null,
      evidence,
      tags: [...new Set([...(parent.tags || []), childKind])],
      stopCondition: item.stopCondition || null,
      verifier: item.verifier || null,
      artifacts: Array.isArray(item.artifacts) ? item.artifacts : [],
    });
    let finalRoute = route;
    let finalReason = reason;
    const existing = this.store.findSimilar(childCandidate);
    if (!existing) {
      const budget = this.attentionBudget();
      if (route === 'pursue' && Number(budget.activeCount || 0) >= Number(budget.maxActivePursuits || 0)) {
        finalRoute = 'defer';
        finalReason = 'active_attention_budget_exhausted';
      } else if (route === 'watch' && Number(budget.watchCount || 0) >= Number(budget.maxWatchItems || 0)) {
        finalRoute = 'defer';
        finalReason = 'watch_attention_budget_exhausted';
      }
    }
    const pursuit = existing
      ? this.store.mergeSeen(existing, childCandidate, { route, reason: 'structured_report_child_merged' })
      : this.store.createPursuit(childCandidate, { route: finalRoute === 'defer' ? 'watch' : finalRoute, reason: finalReason });
    const finalPursuit = finalRoute === 'defer'
      ? this.store.updatePursuit(pursuit.id, { status: 'deferred' }, { type: 'structured_report_child_deferred', reason: finalReason })
      : pursuit;
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at: nowIso(),
      event: 'world_stream_child_selected',
      parentCandidateId: parent.candidateId,
      candidateId: childCandidate.candidateId,
      pursuitId: finalPursuit.id,
      source: parent.source,
      route: finalRoute,
      reason: existing ? 'structured_report_child_merged' : finalReason,
      mode: this.config.mode,
      authority: this.authority.evaluate({ authorityLevel: finalPursuit.authorityLevel }),
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at: nowIso(),
      pursuitId: finalPursuit.id,
      status: finalPursuit.status,
      changeType: route === 'watch' ? 'watch_item_created' : 'pursuit_created',
      summary: finalPursuit.summary,
      evidence,
    });
    return { pursuitId: finalPursuit.id, route: finalRoute };
  }

  applyReceiptClosure(candidate = {}) {
    const pursuitId = candidate.pursuitId;
    if (!pursuitId) return null;
    const status = String(candidate.consequenceStatus || '').toLowerCase();
    const provesClosure = status === 'closed' || status === 'resolved' || status === 'passed' || Boolean(candidate.changedFuture);
    if (!provesClosure) return null;
    const existing = this.store.getPursuit(pursuitId);
    if (!existing || existing.status === 'closed') return null;
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
    const selfAttested = isSelfAttestedClose(existing, evidence);
    const closeStatus = selfAttested ? 'provisional' : 'closed';
    const pursuit = this.store.updatePursuit(pursuitId, {
      status: closeStatus,
      consequence: {
        changed: true,
        pursuitId,
        summary: candidate.changedFuture || candidate.summary,
        evidence,
      },
      latestEvidence: evidence.length ? evidence.slice(-3) : existing.latestEvidence,
      lastTouched: nowIso(),
    }, {
      type: 'receipt_closure',
      reason: selfAttested ? 'receipt_proved_stop_condition_self_attested' : 'receipt_proved_stop_condition',
      detail: { candidateId: candidate.candidateId, source: candidate.source, witnessIndependent: !selfAttested },
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

  scratch(options = {}) {
    return { scratch: this.store.listScratch(options) };
  }

  questions(options = {}) {
    const questions = this.store.listReceipts(options)
      .filter(row => row.event === 'jtr_question_raised')
      .map(row => ({
        id: row.questionId,
        at: row.at,
        status: row.status || 'open',
        pursuitId: row.pursuitId || null,
        question: row.question || row.reason || null,
        reason: row.reason || null,
        authorityLevel: row.authorityLevel || 'L3',
    }));
    return { questions };
  }

  tasks(options = {}) {
    return { tasks: this.store.listTasks(options) };
  }

  recordScratch(input = {}) {
    const at = input.at || nowIso();
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
      : (input.evidenceRef ? [{ type: 'reference', ref: String(input.evidenceRef) }] : []);
    const entry = this.store.appendScratch({
      schema: 'home23.agency.scratch.v1',
      id: input.id || shortId('scratch'),
      at,
      kind: input.kind || 'scratch_note',
      visibility: 'private',
      promoted: false,
      pursuitId: input.pursuitId || null,
      provisionalTheory: input.provisionalTheory || input.theory || null,
      note: input.note || input.summary || null,
      evidence,
      tags: Array.isArray(input.tags) ? input.tags : [],
    });
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'scratch_recorded',
      scratchId: entry.id,
      pursuitId: entry.pursuitId,
      route: 'private_scratch',
      visibility: entry.visibility,
      reason: input.reason || 'private_scratch_not_promoted',
      mode: this.config.mode,
    });
    return entry;
  }

  recordMemoryCandidate(input = {}) {
    const at = input.at || nowIso();
    const content = String(input.memoryContent || input.content || input.summary || '').trim();
    if (!content) throw new Error('Agency memory candidate requires content');
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
      : (input.evidenceRef ? [{ type: 'reference', ref: String(input.evidenceRef) }] : []);
    const candidate = {
      schema: 'home23.agency.memory-candidate.v1',
      id: input.id || shortId('mem'),
      createdAt: at,
      updatedAt: at,
      status: input.status || 'candidate',
      pursuitId: input.pursuitId || null,
      summary: input.summary || content.slice(0, 180),
      content,
      domain: input.memoryDomain || input.domain || 'project',
      source: input.source || 'agency.delta',
      evidence,
      promoteHint: input.promoteHint || 'promote_to_memory_when_verified_or_reused',
    };
    this.store.appendMemoryCandidate({ type: 'created', at, candidate });
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'memory_candidate_created',
      memoryCandidateId: candidate.id,
      pursuitId: candidate.pursuitId,
      route: 'memory_candidate',
      domain: candidate.domain,
      reason: input.reason || input.summary || 'resident_memory_candidate_created',
      evidence,
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: candidate.pursuitId,
      status: 'applied',
      changeType: 'memory_candidate_created',
      summary: candidate.summary,
      evidence,
    });
    this.ensureState();
    return candidate;
  }

  recordTask(input = {}) {
    const at = input.at || nowIso();
    const summary = String(input.summary || input.title || '').trim();
    if (!summary) throw new Error('Agency task requires summary');
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
      : (input.evidenceRef ? [{ type: 'reference', ref: String(input.evidenceRef) }] : []);
    const task = {
      schema: 'home23.agency.task.v1',
      id: input.id || shortId('task'),
      createdAt: at,
      updatedAt: at,
      status: input.status || 'open',
      pursuitId: input.pursuitId || null,
      summary,
      actionKind: input.actionKind || input.kind || 'bounded_action',
      authorityLevel: input.authorityLevel || 'L2',
      reversible: input.reversible !== false,
      handoff: input.handoff && typeof input.handoff === 'object' ? input.handoff : null,
      evidence,
      stopCondition: input.stopCondition || 'task is closed with receipt or explicitly discarded',
    };
    this.store.appendTask({ type: 'created', at, task });
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'task_created',
      taskId: task.id,
      pursuitId: task.pursuitId,
      route: 'task',
      actionKind: task.actionKind,
      authorityLevel: task.authorityLevel,
      reason: input.reason || 'resident_task_created',
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: task.pursuitId,
      status: task.status,
      changeType: 'task_created',
      summary: task.summary,
      evidence,
    });
    this.ensureState();
    return task;
  }

  closeTask(taskId, input = {}) {
    const existing = this.store.getTask(taskId);
    if (!existing) throw new Error(`Agency task not found: ${taskId}`);
    const at = input.at || nowIso();
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
      : (input.evidenceRef ? [{ type: 'reference', ref: String(input.evidenceRef) }] : []);
    const closureEvidence = evidence.length ? evidence : (Array.isArray(existing.evidence) ? existing.evidence : []);
    const task = this.store.updateTask(taskId, {
      status: 'closed',
      closedAt: at,
      closureSummary: input.summary || input.reason || null,
      closureEvidence,
    }, {
      type: 'closed',
      reason: input.reason || input.summary || 'resident_task_closed',
    });
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'task_closed',
      taskId: task.id,
      pursuitId: task.pursuitId,
      route: 'task',
      actionKind: task.actionKind,
      authorityLevel: task.authorityLevel,
      reason: input.reason || input.summary || 'resident_task_closed',
      evidence: closureEvidence,
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: task.pursuitId,
      status: 'closed',
      changeType: 'task_closed',
      summary: input.summary || task.summary,
      evidence: closureEvidence,
    });
    this.ensureState();
    return task;
  }

  raiseQuestion(input = {}) {
    const at = input.at || nowIso();
    const question = String(input.question || input.summary || '').trim();
    if (!question) throw new Error('Agency question requires question');
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
      : (input.evidenceRef ? [{ type: 'reference', ref: String(input.evidenceRef) }] : []);
    const entry = {
      schema: 'home23.agency.question.v1',
      id: input.id || shortId('q'),
      at,
      status: 'open',
      pursuitId: input.pursuitId || null,
      question,
      reason: input.reason || 'operator_judgment_required',
      authorityLevel: input.authorityLevel || 'L3',
      evidence,
    };
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'jtr_question_raised',
      questionId: entry.id,
      pursuitId: entry.pursuitId,
      status: entry.status,
      question: entry.question,
      reason: entry.reason,
      authorityLevel: entry.authorityLevel,
      evidence,
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      pursuitId: entry.pursuitId,
      status: 'open',
      changeType: 'jtr_question_raised',
      summary: entry.question,
      evidence,
    });
    this.ensureState();
    return entry;
  }

  // Explicitly resolve/reject an operator question so it stops being a standing
  // obligation. Works even when the original question had no bound pursuit.
  resolveQuestion(input = {}) {
    const at = input.at || nowIso();
    const questionId = String(input.questionId || '').trim();
    if (!questionId) throw new Error('resolveQuestion requires questionId');
    const resolution = String(input.resolution || input.answer || 'rejected').trim();
    const evidence = Array.isArray(input.evidence)
      ? input.evidence
      : (input.evidenceRef ? [{ type: 'reference', ref: String(input.evidenceRef) }] : []);
    this.store.appendReceipt({
      schema: 'home23.agency.receipt.v1',
      at,
      event: 'jtr_question_resolved',
      questionId,
      resolution,
      reason: input.reason || 'resolved_by_operator_or_evidence',
      evidence,
      mode: this.config.mode,
    });
    this.store.appendConsequence({
      schema: 'home23.agency.consequence.v1',
      at,
      status: 'closed',
      changeType: 'jtr_question_resolved',
      summary: `${resolution}: ${input.reason || questionId}`,
      evidence,
    });
    this.ensureState();
    return { questionId, resolution, at };
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
    if (delta.changeType === 'watch_item_closed') {
      const pursuitId = input.pursuitId || input.targetPursuitId || null;
      if (!pursuitId) {
        return {
          kind: 'no_op',
          reason: 'watch_close_delta_requires_pursuit_id',
        };
      }
      const existing = this.store.getPursuit(pursuitId);
      if (!existing || existing.status !== 'watch') {
        return {
          kind: 'no_op',
          reason: 'watch_close_delta_target_unavailable',
          pursuitId,
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const at = nowIso();
      this.store.updatePursuit(pursuitId, {
        status: 'closed',
        consequence: {
          changed: true,
          pursuitId,
          summary: input.summary || 'watch item closed by approved delta',
          evidence,
        },
        latestEvidence: evidence.length ? evidence.slice(-3) : existing.latestEvidence,
        lastTouched: at,
      }, {
        type: 'watch_item_closed',
        reason: input.summary || 'approved_live_delta_watch_item_closed',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'watch_item_closed',
        pursuitId,
        route: 'close',
        reason: input.summary || 'approved_live_delta_watch_item_closed',
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId,
        status: 'closed',
        changeType: 'watch_item_closed',
        summary: input.summary || 'watch item closed by approved delta',
        evidence,
      });
      return {
        kind: 'watch_item_closed',
        pursuitId,
      };
    }
    if (delta.changeType === 'pursuit_killed') {
      const pursuitId = input.pursuitId || input.targetPursuitId || null;
      if (!pursuitId) {
        return {
          kind: 'no_op',
          reason: 'pursuit_kill_delta_requires_pursuit_id',
        };
      }
      const existing = this.store.getPursuit(pursuitId);
      if (!existing || existing.status === 'closed' || existing.status === 'discarded') {
        return {
          kind: 'no_op',
          reason: 'pursuit_kill_delta_target_unavailable',
          pursuitId,
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const at = nowIso();
      this.store.updatePursuit(pursuitId, {
        status: 'discarded',
        consequence: {
          changed: true,
          pursuitId,
          summary: input.summary || 'pursuit killed by approved delta',
          evidence,
        },
        latestEvidence: evidence.length ? evidence.slice(-3) : existing.latestEvidence,
        lastTouched: at,
      }, {
        type: 'pursuit_killed',
        reason: input.summary || 'approved_live_delta_pursuit_killed',
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'pursuit_killed',
        pursuitId,
        route: 'discard',
        reason: input.summary || 'approved_live_delta_pursuit_killed',
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId,
        status: 'discarded',
        changeType: 'pursuit_killed',
        summary: input.summary || 'pursuit killed by approved delta',
        evidence,
      });
      return {
        kind: 'pursuit_killed',
        pursuitId,
      };
    }
    if (delta.changeType === 'state_posture_updated') {
      const posture = String(input.posture || input.targetPosture || '').trim();
      if (!posture) {
        return {
          kind: 'no_op',
          reason: 'state_posture_delta_requires_posture',
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const at = nowIso();
      const existing = this.store.readState() || {};
      const postureOverride = {
        posture,
        reason: input.summary || 'approved_live_delta_state_posture_updated',
        target: input.target || 'self.posture',
        evidence,
        updatedAt: at,
      };
      this.store.writeState({
        ...existing,
        governance: {
          ...(existing.governance || {}),
          postureOverride,
        },
        self: {
          ...(existing.self || {}),
          posture,
          postureReason: postureOverride.reason,
        },
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'state_posture_updated',
        route: 'state',
        reason: postureOverride.reason,
        target: postureOverride.target,
        posture,
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId: input.pursuitId || null,
        status: 'applied',
        changeType: 'state_posture_updated',
        summary: postureOverride.reason,
        evidence,
      });
      return {
        kind: 'state_posture_updated',
        posture,
      };
    }
    if (delta.changeType === 'prompt_updated') {
      const promptScope = String(input.promptScope || input.scope || input.target || 'resident').trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'resident';
      const promptText = String(input.promptText || input.prompt || input.contractText || '').trim();
      if (!promptText) {
        return {
          kind: 'no_op',
          reason: 'prompt_update_delta_requires_prompt_text',
          promptScope,
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const at = nowIso();
      const existing = this.store.readState() || {};
      const promptContracts = {
        ...(existing.governance?.promptContracts || {}),
        [promptScope]: {
          promptScope,
          target: input.target || null,
          promptText,
          reason: input.summary || 'approved_live_delta_prompt_updated',
          evidence,
          updatedAt: at,
        },
      };
      this.store.writeState({
        ...existing,
        governance: {
          ...(existing.governance || {}),
          promptContracts,
        },
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'prompt_updated',
        route: 'state',
        promptScope,
        target: input.target || null,
        reason: input.summary || 'approved_live_delta_prompt_updated',
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId: input.pursuitId || null,
        status: 'applied',
        changeType: 'prompt_updated',
        summary: input.summary || promptText,
        evidence,
      });
      return {
        kind: 'prompt_updated',
        promptScope,
      };
    }
    if (delta.changeType === 'memory_candidate_created') {
      const content = String(input.memoryContent || input.content || input.summary || '').trim();
      if (!content) {
        return {
          kind: 'no_op',
          reason: 'memory_candidate_delta_requires_content',
        };
      }
      const candidate = this.recordMemoryCandidate({
        summary: input.summary || content.slice(0, 180),
        memoryContent: content,
        memoryDomain: input.memoryDomain || input.domain || 'project',
        pursuitId: input.pursuitId || input.targetPursuitId || null,
        source: input.source || 'agency.delta',
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        reason: 'approved_live_delta_memory_candidate_created',
        promoteHint: input.promoteHint || null,
      });
      return {
        kind: 'memory_candidate_created',
        memoryCandidateId: candidate.id,
        pursuitId: candidate.pursuitId,
      };
    }
    if (delta.changeType === 'dashboard_contract_changed') {
      const surface = String(input.surface || input.target || 'dashboard').trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'dashboard';
      const contractText = String(input.contractText || input.contract || input.summary || '').trim();
      if (!contractText) {
        return {
          kind: 'no_op',
          reason: 'dashboard_contract_delta_requires_contract_text',
          surface,
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const at = nowIso();
      const existing = this.store.readState() || {};
      const dashboardContracts = {
        ...(existing.governance?.dashboardContracts || {}),
        [surface]: {
          surface,
          target: input.target || null,
          contractText,
          reason: input.summary || 'approved_live_delta_dashboard_contract_changed',
          evidence,
          updatedAt: at,
        },
      };
      this.store.writeState({
        ...existing,
        governance: {
          ...(existing.governance || {}),
          dashboardContracts,
        },
      });
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'dashboard_contract_changed',
        route: 'state',
        surface,
        target: input.target || null,
        reason: input.summary || 'approved_live_delta_dashboard_contract_changed',
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId: input.pursuitId || null,
        status: 'applied',
        changeType: 'dashboard_contract_changed',
        summary: input.summary || contractText,
        evidence,
      });
      return {
        kind: 'dashboard_contract_changed',
        surface,
      };
    }
    if (delta.changeType === 'worker_delegated') {
      const worker = String(input.worker || input.handoffTo || '').trim();
      if (!worker) {
        return {
          kind: 'no_op',
          reason: 'worker_delegation_delta_requires_worker',
        };
      }
      const objective = input.handoffObjective || input.objective || input.summary || 'Run bounded worker delegation.';
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const task = this.recordTask({
        summary: input.summary || objective,
        pursuitId: input.pursuitId || input.targetPursuitId || null,
        actionKind: 'worker_delegation',
        authorityLevel: authority.level || input.authorityLevel || 'L2',
        reversible: input.reversible !== false,
        handoff: {
          to: worker,
          objective,
        },
        evidence,
        stopCondition: input.stopCondition || 'worker returns a receipt that closes, advances, or rejects the delegation',
        reason: 'approved_live_delta_worker_delegated',
      });
      const at = nowIso();
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'worker_delegated',
        taskId: task.id,
        pursuitId: task.pursuitId,
        worker,
        route: 'task',
        reason: input.summary || objective,
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId: task.pursuitId,
        status: 'open',
        changeType: 'worker_delegated',
        summary: input.summary || objective,
        evidence,
      });
      return {
        kind: 'worker_delegated',
        taskId: task.id,
        pursuitId: task.pursuitId,
      };
    }
    if (delta.changeType === 'cron_adjusted') {
      const jobId = String(input.jobId || input.job_id || input.target || '').trim();
      if (!jobId) {
        return {
          kind: 'no_op',
          reason: 'cron_adjustment_delta_requires_job_id',
        };
      }
      const changes = {};
      if (typeof input.cronExpr === 'string' && input.cronExpr.trim()) changes.cron_expr = input.cronExpr.trim();
      if (typeof input.cron_expr === 'string' && input.cron_expr.trim()) changes.cron_expr = input.cron_expr.trim();
      if (typeof input.everyMs === 'number' && Number.isFinite(input.everyMs)) changes.every_ms = input.everyMs;
      if (typeof input.every_ms === 'number' && Number.isFinite(input.every_ms)) changes.every_ms = input.every_ms;
      if (typeof input.announceMode === 'string' && input.announceMode.trim()) changes.announce_mode = input.announceMode.trim();
      if (typeof input.deliveryProfile === 'string') changes.delivery_profile = input.deliveryProfile;
      if (typeof input.deliveryTo === 'string') changes.delivery_to = input.deliveryTo;
      if (typeof input.deliveryChannel === 'string') changes.delivery_channel = input.deliveryChannel;
      if (typeof input.messagePath === 'string') changes.message_path = input.messagePath;
      if (typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds)) changes.timeout_seconds = input.timeoutSeconds;
      if (typeof input.model === 'string' && input.model.trim()) changes.model = input.model.trim();
      if (!Object.keys(changes).length) {
        return {
          kind: 'no_op',
          reason: 'cron_adjustment_delta_requires_changes',
          jobId,
        };
      }
      const evidence = Array.isArray(input.evidence) ? input.evidence : [];
      const task = this.recordTask({
        summary: input.summary || `Apply bounded cron adjustment to ${jobId}.`,
        pursuitId: input.pursuitId || input.targetPursuitId || null,
        actionKind: 'cron_adjustment',
        authorityLevel: authority.level || input.authorityLevel || 'L2',
        reversible: input.reversible !== false,
        handoff: {
          to: 'cron_update',
          jobId,
          changes,
        },
        evidence,
        stopCondition: input.stopCondition || 'cron_update persists the scheduler change and the next run produces an agency receipt',
        reason: 'approved_live_delta_cron_adjusted',
      });
      const at = nowIso();
      this.store.appendReceipt({
        schema: 'home23.agency.receipt.v1',
        at,
        event: 'cron_adjusted',
        taskId: task.id,
        pursuitId: task.pursuitId,
        jobId,
        route: 'task',
        reason: input.summary || `Apply bounded cron adjustment to ${jobId}.`,
        changes,
        evidence,
        mode: this.config.mode,
      });
      this.store.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at,
        pursuitId: task.pursuitId,
        status: 'open',
        changeType: 'cron_adjusted',
        summary: input.summary || `Apply bounded cron adjustment to ${jobId}.`,
        evidence,
      });
      return {
        kind: 'cron_adjusted',
        taskId: task.id,
        pursuitId: task.pursuitId,
        jobId,
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
    if (delta.changeType === 'task_created') {
      const task = this.recordTask({
        summary: input.summary,
        pursuitId: input.pursuitId || input.targetPursuitId || null,
        actionKind: input.actionKind || input.kind || 'bounded_action',
        authorityLevel: authority.level || input.authorityLevel || 'L2',
        reversible: input.reversible !== false,
        handoff: input.handoff || null,
        evidence: Array.isArray(input.evidence) ? input.evidence : [],
        stopCondition: input.stopCondition || null,
        reason: 'approved_live_delta_task_created',
      });
      return {
        kind: 'task_created',
        taskId: task.id,
        pursuitId: task.pursuitId,
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
    if (editor.action === 'demote_ornamental_dashboard_panel') {
      this.store.updatePursuit(selected.id, { status: 'discarded' }, {
        type: 'editor_dashboard_demote',
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
        changeType: 'ornamental_dashboard_panel_demoted',
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

function isMeaningfulConsequence(row = {}) {
  const changeType = String(row.changeType || row.event || '').toLowerCase();
  const status = String(row.status || '').toLowerCase();
  const summary = String(row.summary || row.reason || '').toLowerCase();
  if (changeType === 'explicit_no_change') return false;
  if (status === 'discarded' && (changeType === 'explicit_no_change' || summary.includes('already resolved'))) return false;
  if (summary.includes('already resolved with verifier evidence')) return false;
  return true;
}

function isRedundantGoodLifePolicyPulse(candidate = {}, existing = null) {
  if (!existing || candidate.source !== 'domain.good-life') return false;
  if (!['active', 'watch'].includes(String(existing.status || '').toLowerCase())) return false;
  if (existing.dedupeKey && candidate.dedupeKey && existing.dedupeKey !== candidate.dedupeKey) return false;
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  return evidence.every((item) => {
    const type = String(item?.type || '').toLowerCase();
    return !type || type === 'observation' || type === 'good-life';
  });
}

function isRawObservationPursuit(pursuit = {}) {
  if (pursuit.kind !== 'observation') return false;
  if (hasMeaningfulPursuitOutcome(pursuit)) return false;
  const source = String(pursuit.source || '');
  return source.startsWith('machine.')
    || source.startsWith('os.')
    || (source.startsWith('domain.') && source !== 'domain.good-life')
    || source === 'work.agenda'
    || source === 'work.heartbeat';
}

function isSyntheticCronBindingFuture(text = '') {
  return /cron outcome updates (?:a bound )?resident pursuit/i.test(String(text || ''));
}

function isRealNonSyntheticDesiredFuture(candidate = {}) {
  const desired = String(candidate.desiredChangedFuture || '').trim();
  if (!desired) return false;
  const summary = String(candidate.summary || '').trim();
  // createPursuit often copies summary into desiredChangedFuture as a placeholder
  if (desired === summary) return false;
  if (isSyntheticCronBindingFuture(desired)) return false;
  return true;
}

function isMechanicalCronNoChangeCandidate(candidate = {}) {
  if (candidate.kind !== 'cron_report') return false;
  if (candidate.stopCondition || candidate.changedFuture || candidate.consequence?.changed) return false;
  const source = String(candidate.source || '');
  const summary = String(candidate.summary || '');
  if (!source.startsWith('cron.') || !/finished with status ok/i.test(summary)) return false;
  if (isRealNonSyntheticDesiredFuture(candidate)) return false;
  return true;
}

function isMechanicalCronNoChangePursuit(pursuit = {}) {
  if (pursuit.kind !== 'cron_report') return false;
  if (pursuit.consequence?.changed) return false;
  if (hasMeaningfulPursuitOutcome(pursuit)) return false;
  const source = String(pursuit.source || '');
  const summary = String(pursuit.summary || '');
  if (!source.startsWith('cron.') || !/finished with status ok/i.test(summary)) return false;
  // pursuitId alone / synthetic binding future / summary-placeholder desired future
  // do not make mechanical ok attention-worthy
  if (isRealNonSyntheticDesiredFuture(pursuit)) return false;
  return true;
}

function isMisroutedBoundCronReceiptPursuit(pursuit = {}) {
  if (pursuit.kind !== 'cron_report') return false;
  if (!String(pursuit.source || '').startsWith('cron.')) return false;
  if (!/finished with status ok/i.test(String(pursuit.summary || ''))) return false;
  return Boolean(impliedTargetPursuitId(pursuit));
}

function impliedTargetPursuitId(input = {}) {
  const text = [
    input.pursuitId,
    input.targetPursuitId,
    input.desiredChangedFuture,
    input.stopCondition,
    input.nextMove,
    input.summary,
  ].filter(Boolean).join(' ');
  const match = String(text).match(/\b(ap_[a-z0-9]+)\b/i);
  return match ? match[1] : null;
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

function normalizeStructuredItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .map(item => ({ ...item }));
}

function normalizeStructuredDiscards(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      ref: String(item.ref || item.id || item.summary || 'report_noise'),
      reason: String(item.reason || 'discarded_by_structured_report'),
    }));
}

function hasStructuredReportFanout(input = {}) {
  return normalizeStructuredItems(input.actionWorthy).length > 0
    || normalizeStructuredItems(input.watchItems).length > 0
    || normalizeStructuredItems(input.claims).length > 0
    || normalizeStructuredItems(input.beliefUpdates).length > 0
    || normalizeStructuredItems(input.memoryCandidates).length > 0
    || normalizeStructuredItems(input.operatorQuestions).length > 0
    || normalizeStructuredItems(input.taskItems).length > 0
    || normalizeStructuredItems(input.tasks).length > 0
    || normalizeStructuredItems(input.contradictions).length > 0;
}

function structuredItemEvidence(item = {}, parent = {}) {
  const evidence = [];
  if (Array.isArray(item.evidence)) evidence.push(...item.evidence);
  if (item.evidenceRef) evidence.push({ type: 'report_item', ref: String(item.evidenceRef) });
  if (Array.isArray(parent.evidence)) evidence.push(...parent.evidence);
  return mergeEvidenceItems(evidence);
}

function mergeEvidenceItems(evidence = []) {
  const unique = [];
  const seen = new Set();
  for (const row of evidence) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function latestIso(values = []) {
  return values
    .filter(Boolean)
    .map(String)
    .sort()
    .at(-1) || null;
}
