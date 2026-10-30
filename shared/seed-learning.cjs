'use strict';

// Versioned, bounded procedural learning. This is part of Seed development,
// not another store. Models can propose feedback; provenance is admitted by
// the authenticated writer and the Seed before this pure update is used.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_DECISIONS = 32;
const MAX_LESSONS = 64;
const MAX_FEEDBACK = 512;
const STEP = 0.25;
const CLIP = 0.75;
const MAX_STATE_BYTES = 128 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 512) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0') ? value.trim() : null;
const list = value => value === undefined ? [] : Array.isArray(value) && value.length <= 16 && value.every(item => text(item)) ? [...new Set(value.map(item => item.trim()))] : null;
const scopeOf = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(value) ? value : null;
const clone = value => JSON.parse(JSON.stringify(value));
const learningLessonId = (feedbackId, scope) => `lesson_${hash([feedbackId, scope]).slice(0, 24)}`;
const learningStateWithinBudget = state => Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE_BYTES;
function executionTargetTag(target) {
  if (typeof target !== 'string' || !target.trim() || target.length > 2000) return null;
  return `target:${hash(target.trim()).slice(0, 24)}`;
}

function normalizeLearningDecision(raw) {
  if (!raw || raw.schema !== 'home23.learning-decision.v1') return null;
  const decisionId = text(raw.decisionId), scope = scopeOf(raw.scope), tags = list(raw.tags), sourceRefs = list(raw.sourceRefs);
  const criterion = raw.criterion || 'owner-value';
  if (!decisionId || !scope || !tags || !sourceRefs?.length || !['owner-value', 'execution', 'prediction'].includes(criterion)) return null;
  if (raw.cellId !== undefined && !text(raw.cellId, 120)) return null;
  return { schema: raw.schema, decisionId, scope, tags, sourceRefs, criterion,
    ...(raw.cellId ? { cellId: raw.cellId } : {}), ...(text(raw.observedAt, 100) ? { observedAt: raw.observedAt } : {}) };
}

function normalizeLearningFeedback(raw) {
  if (!raw || raw.schema !== 'home23.learning-feedback.v1') return null;
  const scope = scopeOf(raw.scope), tags = list(raw.tags), excludes = list(raw.excludes), evidenceRefs = list(raw.evidenceRefs), supersedes = list(raw.supersedes), corroborates = list(raw.corroborates);
  if (!scope || !tags || !excludes || !evidenceRefs?.length || !supersedes || !corroborates || !['attenuate', 'reinforce'].includes(raw.direction)
      || !['owner-feedback', 'verified-outcome', 'outcome-assessment'].includes(raw.basis)) return null;
  if (raw.decisionId !== undefined && !text(raw.decisionId)) return null;
  if (raw.cellId !== undefined && !text(raw.cellId, 120)) return null;
  return { schema: raw.schema, scope, direction: raw.direction, tags, excludes, evidenceRefs, basis: raw.basis, supersedes, corroborates,
    ...(raw.standing === true ? { standing: true } : {}),
    ...(raw.decisionId ? { decisionId: raw.decisionId } : {}), ...(raw.cellId ? { cellId: raw.cellId } : {}) };
}

function emptyLearningState() { return { version: 1, decisions: [], lessons: [], seenFeedbackIds: [], watermarks: {}, pendingFeedback: [] }; }
function normalizeLearningState(raw) {
  if (!raw || raw.version !== 1) return emptyLearningState();
  const lessons = clone((Array.isArray(raw.lessons) ? raw.lessons : []).filter(item => item && text(item.lessonId) && scopeOf(item.scope)
    && Number.isFinite(item.value) && Math.abs(item.value) <= CLIP && list(item.tags) && list(item.excludes) && list(item.sourceRefs)));
  if (lessons.filter(item => item.active !== false).length > MAX_LESSONS) throw new Error('active Seed lesson capacity exceeded');
  return { version: 1,
    decisions: (Array.isArray(raw.decisions) ? raw.decisions : []).map(normalizeLearningDecision).filter(Boolean).slice(-MAX_DECISIONS),
    lessons: [...lessons.filter(item => item.active !== false), ...lessons.filter(item => item.active === false).slice(-16)],
    seenFeedbackIds: (Array.isArray(raw.seenFeedbackIds) ? raw.seenFeedbackIds : []).filter(item => text(item)).slice(-MAX_FEEDBACK),
    ...(Number.isFinite(Date.parse(raw.lastConsolidatedAt)) ? { lastConsolidatedAt: raw.lastConsolidatedAt } : {}),
    watermarks: Object.fromEntries(Object.entries(raw.watermarks || {}).filter(([key, value]) => text(key) && Number.isSafeInteger(value) && value >= 0).slice(-32)),
    pendingFeedback: clone((Array.isArray(raw.pendingFeedback) ? raw.pendingFeedback : []).filter(item => normalizeLearningFeedback(item?.feedback) && text(item?.authority?.feedbackId)).slice(0, 16)) };
}

function recordLearningDecision(rawState, rawDecision) {
  const state = normalizeLearningState(rawState), decision = normalizeLearningDecision(rawDecision);
  if (!decision) return { applied: false, state, reason: 'decision_malformed' };
  const prior = state.decisions.find(item => item.decisionId === decision.decisionId);
  if (prior) return { applied: false, state, reason: hash(prior) === hash(decision) ? 'decision_already_recorded' : 'decision_identity_conflict' };
  // Decisions are a bounded eligibility window; evicting one only prevents
  // future credit, never invents a substitute context or removes its ledger.
  state.decisions = [...state.decisions, decision].slice(-MAX_DECISIONS);
  if (!state.lastConsolidatedAt && Number.isFinite(Date.parse(decision.observedAt))) state.lastConsolidatedAt = decision.observedAt;
  while (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES && state.decisions.length > 1) state.decisions.shift();
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) return { applied: false, state: normalizeLearningState(rawState), reason: 'learning_state_capacity' };
  return { applied: true, state, reason: 'decision_recorded' };
}

function applyLearningFeedback(rawState, rawFeedback, authority = {}) {
  const state = normalizeLearningState(rawState), feedback = normalizeLearningFeedback(rawFeedback);
  const before = clone(state);
  const refuse = reason => ({ applied: false, state, reason });
  if (!feedback || !text(authority.feedbackId) || !text(authority.observedAt, 100)) return refuse('feedback_malformed');
  if (state.seenFeedbackIds.includes(authority.feedbackId)) return refuse('feedback_already_applied');
  const sequenced = text(authority.stream) && Number.isSafeInteger(authority.sequence) && authority.sequence >= 0;
  if (sequenced && authority.sequence <= (state.watermarks[authority.stream] ?? -1)) return refuse('feedback_precedes_stream_watermark');
  if (sequenced && state.watermarks[authority.stream] === undefined && Object.keys(state.watermarks).length >= 32) return refuse('learning_stream_capacity');
  const decision = feedback.decisionId ? state.decisions.find(item => item.decisionId === feedback.decisionId)
    ?? state.lessons.find(item => item.eligibility?.decisionId === feedback.decisionId)?.eligibility : null;
  if (feedback.decisionId && !decision) return refuse('decision_not_retained');
  if (decision && decision.scope !== feedback.scope) return refuse('feedback_scope_mismatch');
  if (decision && feedback.tags.some(tag => !decision.tags.includes(tag))) return refuse('feedback_context_mismatch');
  const explicitOwner = feedback.basis === 'owner-feedback' && authority.ownerAuthenticated === true;
  if (feedback.basis === 'owner-feedback' && !explicitOwner) return refuse('owner_authority_missing');
  if (!decision) return refuse('actual_decision_witness_required');
  const verification = feedback.basis === 'outcome-assessment' ? authority.assessment : authority.verification;
  if (!explicitOwner && (!decision || verification?.criterion !== decision.criterion || !Array.isArray(verification.evidenceRefs)
      || !feedback.evidenceRefs.every(ref => verification.evidenceRefs.includes(ref)))) return refuse('outcome_criterion_unverified');
  const criterion = decision?.criterion || 'owner-value';
  const remember = () => {
    state.seenFeedbackIds = [...state.seenFeedbackIds, authority.feedbackId].slice(-MAX_FEEDBACK);
    if (sequenced) state.watermarks[authority.stream] = authority.sequence;
  };
  if (feedback.corroborates.length) {
    if (feedback.basis === 'outcome-assessment') return refuse('assessment_cannot_corroborate');
    const targets = feedback.corroborates.map(id => state.lessons.find(lesson => lesson.lessonId === id && lesson.active !== false));
    if (targets.some(lesson => !lesson || lesson.scope !== feedback.scope || lesson.criterion !== criterion
        || (lesson.value < 0) !== (feedback.direction === 'attenuate')
        || (decision && lesson.decisionId === decision.decisionId)
        || !lesson.tags.every(tag => decision?.tags.includes(tag) || feedback.tags.includes(tag)))) return refuse('corroboration_not_attributable');
    for (const lesson of targets) {
      lesson.corroborations = Math.min(32, lesson.corroborations + 1);
      lesson.retentionCredits = Math.min(32, (lesson.retentionCredits ?? 0) + 1);
    }
    remember();
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) return { applied: false, state: before, reason: 'learning_state_capacity' };
    return { applied: true, state, reason: 'linked_outcome_corroborated', lesson: targets[0] };
  }
  const lessonId = learningLessonId(authority.feedbackId, feedback.scope);
  if (feedback.supersedes.some(id => !state.lessons.some(lesson => lesson.lessonId === id && lesson.scope === feedback.scope))) return refuse('supersession_scope_mismatch');
  if (!explicitOwner && feedback.supersedes.some(id => state.lessons.find(lesson => lesson.lessonId === id)?.authority === 'owner')) return refuse('owner_supersession_authority_missing');
  if (feedback.supersedes.some(id => state.lessons.find(lesson => lesson.lessonId === id)?.active === false)) return refuse('supersession_target_inactive');
  const tags = [...new Set([...decision.tags, ...feedback.tags])];
  const sameSet = (a, b) => hash([...a].sort()) === hash([...b].sort());
  const prior = !explicitOwner ? state.lessons.find(lesson => lesson.active !== false && lesson.authority !== 'owner'
    && lesson.scope === feedback.scope && lesson.criterion === criterion && lesson.basis === feedback.basis
    && sameSet(lesson.tags, tags) && sameSet(lesson.excludes, feedback.excludes)) : null;
  if (prior?.decisionId === decision.decisionId) return refuse('empirical_trial_already_credited');
  const retiringIds = new Set([...feedback.supersedes, ...(prior ? [prior.lessonId] : [])]);
  if (state.lessons.filter(item => item.active !== false).length - retiringIds.size >= MAX_LESSONS) return refuse('lesson_capacity');
  // A correction can retire an earlier active contribution but never rewrite
  // that earlier record. The new receipt carries both versions.
  for (const lesson of state.lessons) if (retiringIds.has(lesson.lessonId)) lesson.active = false;
  const step = feedback.direction === 'attenuate' ? -STEP : STEP;
  const corroborated = prior && feedback.basis === 'verified-outcome' && Math.sign(prior.value) === Math.sign(step);
  const value = Math.max(-CLIP, Math.min(CLIP, (feedback.basis === 'verified-outcome' ? prior?.value ?? 0 : 0) + step));
  const lesson = { lessonId, scope: feedback.scope, tags, excludes: feedback.excludes,
    sourceRefs: [...new Set([...(prior?.sourceRefs ?? []), ...feedback.evidenceRefs])].slice(-16), value,
    basis: feedback.basis, authority: explicitOwner ? 'owner' : 'provisional', criterion,
    ...(decision ? { decisionId: decision.decisionId, eligibility: clone(decision) } : {}),
    createdAt: authority.observedAt, corroborations: corroborated ? Math.min(32, prior.corroborations + 1) : 0,
    retentionCredits: corroborated ? Math.min(32, (prior.retentionCredits ?? 0) + 1) : 0,
    ...(prior ? { replacesLessonId: prior.lessonId } : {}), active: value !== 0 };
  state.lessons.push(lesson);
  remember();
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) return { applied: false, state: before, reason: 'learning_state_capacity' };
  return { applied: true, state, reason: 'feedback_applied', lesson };
}

function consolidateLearning(rawState, asOf) {
  const state = normalizeLearningState(rawState);
  let steps = 1, now, previous;
  if (asOf !== undefined) {
    if (!state.lessons.some(lesson => lesson.active && lesson.authority !== 'owner')) return rawState?.version === 1 ? clone(rawState) : state;
    now = Date.parse(asOf);
    const first = Math.min(...state.lessons.map(lesson => Date.parse(lesson.createdAt)).filter(Number.isFinite));
    previous = Number.isFinite(Date.parse(state.lastConsolidatedAt)) ? Date.parse(state.lastConsolidatedAt) : first;
    steps = Number.isFinite(now) && Number.isFinite(previous) ? Math.min(64, Math.max(0, Math.floor((now - previous) / (30 * 60 * 1000)))) : 0;
    if (!steps) return rawState?.version === 1 ? clone(rawState) : state;
    state.lastConsolidatedAt = asOf;
  }
  for (const lesson of state.lessons) {
    const applicableSteps = asOf === undefined ? steps
      : Math.min(steps, Math.max(0, Math.floor((now - Math.max(previous, Date.parse(lesson.createdAt))) / (30 * 60 * 1000))));
    for (let i = 0; i < applicableSteps; i++) {
    // A direct preference is standing authority, not an empirical hypothesis.
    // Missing contact and unrelated successes do not corroborate or erase it.
    if (lesson.authority !== 'owner' && lesson.active) {
      const credit = lesson.retentionCredits ?? lesson.corroborations;
      if (credit > 0) lesson.retentionCredits = credit - 1;
      else {
        lesson.value *= 0.6;
        if (Array.isArray(lesson.readoutDelta)) lesson.readoutDelta = lesson.readoutDelta.map(value => value * 0.6);
      }
      // This retirement is itself committed by consolidation, never silently
      // performed by a read/clone. Owner instructions remain inviolable.
      if (Math.abs(lesson.value) < 1e-4) lesson.active = false;
    }
    }
  }
  return state;
}

function learningSnapshot(development) {
  const decisions = [], lessons = [], watermarks = {};
  for (const [cellId, plastic] of Object.entries(development || {})) {
    const state = normalizeLearningState(plastic?.experience);
    decisions.push(...state.decisions.map(item => ({ ...item, cellId: item.cellId || cellId })));
    lessons.push(...state.lessons.map(item => ({ ...item, cellId })));
    for (const [stream, sequence] of Object.entries(state.watermarks)) watermarks[stream] = Math.max(watermarks[stream] || 0, sequence);
  }
  return { version: 1, available: true, decisions, lessons,
    watermarks: Object.fromEntries(Object.entries(watermarks).sort(([a], [b]) => a.localeCompare(b)).slice(0, 32)) };
}

function evaluateLearnedDecision(snapshot, candidate) {
  const tags = list(candidate?.tags), scope = scopeOf(candidate?.scope);
  const requiredTags = list(candidate?.requiredTags);
  const baseScore = Number.isFinite(candidate?.baseScore) ? Math.max(0, Math.min(1, candidate.baseScore)) : 0.5;
  const unavailable = { adjustment: 0, score: baseScore, suppress: false, lessonIds: [], sourceRefs: [], available: false };
  if (!scope || !tags || !requiredTags || !snapshot || snapshot.available === false || snapshot.version !== 1 || !Array.isArray(snapshot.lessons)) return unavailable;
  const matched = snapshot.lessons.filter(lesson => lesson.active !== false && lesson.scope === scope
    && (!candidate.cellId || !lesson.cellId || lesson.cellId === candidate.cellId)
    && requiredTags.every(tag => (lesson.tags || []).includes(tag))
    && (lesson.tags || []).every(tag => tags.includes(tag)) && !(lesson.excludes || []).some(tag => tags.includes(tag)));
  // Capability evidence can revise an empirical expectation, not cancel an
  // applicable owner instruction. Retain both in history; only a new owner
  // revision changes the authority-bearing contribution at this choice.
  const owner = matched.filter(lesson => lesson.authority === 'owner');
  const contributors = owner.length ? owner : matched;
  const adjustment = Math.max(-CLIP, Math.min(CLIP, contributors.reduce((sum, lesson) => sum + (Number.isFinite(lesson.value) ? lesson.value : 0), 0)));
  return { adjustment, score: Math.max(0, Math.min(1, baseScore + adjustment)), suppress: adjustment <= -0.2, lessonIds: contributors.map(item => item.lessonId),
    sourceRefs: [...new Set(contributors.flatMap(item => item.sourceRefs || []))], available: true };
}

// Same canonical checkpoint projection as substrate/checkpoint.ts. Keep this
// byte-compatible: historical hashes are evidence, never migration targets.
function checkpointStateHash(checkpoint) {
  return hash({ cells: checkpoint.cells.map(c => ({
    id: c.id, generation: c.generation, status: c.status, realityRefs: c.realityRefs,
    estimates: c.estimates, intentions: c.intentions, predictions: c.predictions,
    continuousState: c.continuousState, continuousStateDimension: c.continuousStateDimension,
    dispositions: c.dispositions, associations: c.associations, lobeAffinities: c.lobeAffinities,
    workspacePressure: c.workspacePressure, interruptionPressure: c.interruptionPressure,
    uncertainty: c.uncertainty, energy: { current: c.energy.current, peak: c.energy.peak, lastSpikeAt: c.energy.lastSpikeAt ?? null },
    developmentalLineage: c.developmentalLineage, lastTransitionAt: c.lastTransitionAt })),
    dispositions: checkpoint.dispositions,
    ...(checkpoint.version >= 2 ? { development: checkpoint.development || {} } : {}),
    ...(checkpoint.version >= 3 ? { concern: checkpoint.concern || {} } : {}) });
}

/** Read a bounded committed tail; never instantiate a Seed or write live state.
 * Missing coverage or a broken anchor disables learned suppression honestly. */
function readSeedLearning(stateDir) {
  const unavailable = { version: 1, available: false, decisions: [], lessons: [], watermarks: {}, seq: null };
  let fd;
  try {
    const directory = path.join(stateDir, 'checkpoints');
    const names = fs.readdirSync(directory).filter(name => /^ckpt_.*\.json$/.test(name)).sort();
    if (!names.length) return unavailable;
    const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, names.at(-1)), 'utf8'));
    if (!Number.isSafeInteger(checkpoint.ledgerSeq) || typeof checkpoint.ledgerCursor !== 'string') return unavailable;
    if (!Array.isArray(checkpoint.cells) || checkpointStateHash(checkpoint) !== checkpoint.stateHash) return unavailable;
    fd = fs.openSync(path.join(stateDir, 'seed-ledger.jsonl'), 'r');
    const size = fs.fstatSync(fd).size, span = Math.min(size, 4 * 1024 * 1024), start = size - span;
    const buffer = Buffer.alloc(span); fs.readSync(fd, buffer, 0, span, start);
    let raw = buffer.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
    const lines = raw.split('\n').filter(Boolean).map(line => ({ line, record: JSON.parse(line) }));
    const anchor = lines.find(item => item.record.seq === checkpoint.ledgerSeq);
    if (checkpoint.ledgerSeq > 0 && (!anchor || createHash('sha256').update(anchor.line).digest('hex') !== checkpoint.ledgerCursor)) return unavailable;
    if (anchor?.record.stateHashAfter && anchor.record.stateHashAfter !== checkpoint.stateHash) return unavailable;
    let cursor = checkpoint.ledgerCursor, seq = checkpoint.ledgerSeq;
    const development = clone(checkpoint.development || {});
    for (const { line, record } of lines.filter(item => item.record.seq > checkpoint.ledgerSeq)) {
      if (record.seq !== seq + 1 || record.prevHash !== cursor) return unavailable;
      if (record.category === 'development' && record.payload?.experienceCells) {
        for (const [cellId, experience] of Object.entries(record.payload.experienceCells)) {
          development[cellId] = { ...development[cellId], experience: normalizeLearningState(experience) };
        }
      }
      cursor = createHash('sha256').update(line).digest('hex'); seq = record.seq;
    }
    return { ...learningSnapshot(development), seq };
  } catch { return unavailable; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { MAX_DECISIONS, MAX_LESSONS, normalizeLearningDecision, normalizeLearningFeedback, emptyLearningState,
  normalizeLearningState, recordLearningDecision, applyLearningFeedback, consolidateLearning, learningSnapshot,
  evaluateLearnedDecision, readSeedLearning, readSeedLearningSync: readSeedLearning, learningLessonId, executionTargetTag, learningStateWithinBudget };
