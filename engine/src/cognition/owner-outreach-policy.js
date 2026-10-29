'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { semanticObservationBucket } = require('./discovery-engine');
const { writeFileDurableSync } = require('../utils/durable-write');
const { evaluateLearnedDecision, normalizeLearningDecision } = require('../../../shared/seed-learning.cjs');

const SCHEMA = 'home23.owner-attention.v1';
const INTENT_SCHEMA = 'home23.owner-attention-intent.v1';
const LEARNED_INTENT_SCHEMA = 'home23.owner-attention-intent.v2';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isMachine = channel => /^machine\./.test(channel || '') || channel === 'os.pm2';

// Source metadata, not wording such as "RAM", decides whether this is machine
// commentary. Adding an unrelated allowed reference cannot change that scope.
function machineEvidence(candidate, memory, evidenceRefs = null) {
  const evidence = [];
  if (isMachine(candidate?.observation?.channelId)) evidence.push(candidate.observation);
  const ids = [...new Set([...(candidate?.nodeIds || []),
    ...(evidenceRefs || []).filter(ref => ref.startsWith('memory:')).map(ref => ref.slice(7))])];
  for (const id of ids) {
    const node = memory?.nodes?.get?.(id) || memory?.nodes?.get?.(Number(id));
    if (!node) continue;
    const provenance = node.provenance || {};
    const refs = [...(provenance.sourceRefs || []), ...(provenance.source_refs || []), ...(node.metadata?.source_refs || [])];
    const channelId = [provenance.substrate?.sourceSurface, node.metadata?.channelId, ...refs].find(isMachine);
    if (!channelId) continue;
    let payload = node.metadata?.observation?.payload || node.metadata?.payload || null;
    if (!payload) {
      const text = typeof node.statement === 'string' ? node.statement : node.concept;
      if (typeof text === 'string') {
        const json = text.startsWith(`[${channelId}] `) ? text.slice(channelId.length + 3) : text;
        try { payload = JSON.parse(json); } catch { /* summarized text is not structured current telemetry */ }
      }
    }
    evidence.push({ channelId, payload: payload || {}, sourceRef: refs.find(ref => ref !== channelId) || `memory:${id}`,
      producedAt: provenance.semanticTime || node.asserted_at, flag: node.metadata?.observation?.flag || null,
      memoryRef: `memory:${id}` });
  }
  return evidence;
}

function describeMachine(obs) {
  const payload = obs.payload || {};
  let topic = obs.channelId;
  let condition = semanticObservationBucket(obs);
  let severity = null;
  if (obs.channelId === 'machine.memory') {
    // Raw free RAM is not reclaimable headroom. The production channel has
    // explicit Darwin pressure / Linux MemAvailable metrics when available.
    const capacity = payload.pressureFreePct ?? payload.memoryPressure?.freePct;
    if (payload.memoryPressure?.available === false || typeof capacity !== 'number'
      || !Number.isFinite(capacity) || capacity < 0 || capacity > 100) condition = null;
    if (condition === 'memory:pressure-unavailable') condition = null;
    const levels = { 'memory:normal': 0, 'memory:tight': 1, 'memory:low': 1, 'memory:severe': 2, 'memory:critical': 3 };
    severity = levels[condition] ?? null;
  } else if (obs.channelId === 'machine.cpu') {
    if (typeof payload.loadAvg?.[0] !== 'number' || !Number.isFinite(payload.loadAvg[0]) || payload.loadAvg[0] < 0
      || !Number.isSafeInteger(payload.cpuCount) || payload.cpuCount < 1) condition = null;
    const levels = { 'cpu:normal': 0, 'cpu:elevated': 1, 'cpu:load-pressure': 1, 'cpu:saturated': 2, 'cpu:overcommitted': 3 };
    severity = levels[condition] ?? null;
  } else if (obs.channelId === 'machine.disk') {
    topic += `:${payload.mount || 'unknown'}`;
    const pct = payload.usagePct;
    if (typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      severity = pct >= 95 ? 2 : pct >= 85 ? 1 : 0;
      condition = `disk:${['normal', 'high', 'critical'][severity]}`;
    }
  } else if (obs.channelId === 'machine.swap') {
    const pct = payload.swap?.usedPct;
    if (!payload.swap?.error && typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      severity = pct >= 90 ? 2 : pct >= 70 ? 1 : 0;
      condition = `swap:${['normal', 'high', 'critical'][severity]}`;
    }
  } else if (obs.channelId === 'os.pm2') {
    topic += `:${typeof payload.name === 'string' ? payload.name : 'unknown'}`;
    if (typeof payload.status === 'string' && payload.name) {
      severity = payload.status === 'online' ? 0 : 1;
      // Restart counters and fresh PIDs alone are not a changed consequence.
      condition = `process:${payload.status}`;
    }
  } else if (obs.channelId === 'machine.process' && Array.isArray(payload.processes)) {
    const anomalies = [...payload.processes, ...(payload.memoryProcesses || [])]
      .filter(item => item.topology?.duplicateCandidate === true || item.topology?.topologyWarning)
      .map(item => [item.topology?.agentName || item.name || 'unknown', item.topology?.role || 'unknown',
        item.topology?.topologyWarning || 'duplicate-role']);
    severity = anomalies.length ? 1 : 0;
    condition = anomalies.length ? `process:topology:${hash(anomalies.sort())}` : 'process:topology-normal';
  } else if (obs.channelId === 'machine.rf') {
    const level = payload.posture?.severity;
    severity = { clear: 0, watch: 1, degraded: 2 }[level] ?? null;
    if (severity !== null) condition = `transport:${level}`;
  }
  return { topic, condition, severity, sourceRef: obs.memoryRef || obs.sourceRef || null,
    availability: condition && severity !== null ? 'available' : 'unavailable' };
}

function learningDecisionsFor(intent) {
  // Hard policy still owns criticality, recovery, dedupe and provenance.
  // A routine learned preference must never become a general alert mute.
  if (intent.attention?.kind !== 'problem' || !intent.conditions.length
      || intent.conditions.some(item => item.severity >= 2)) return [];
  const measurementRefs = new Set(intent.conditions.map(item => item.sourceRef));
  // These producers attest pressure/load/capacity, not the presence or
  // absence of operational impact. Learn only about measurement-only
  // commentary. Any additional owner, Work, execution or unknown evidence
  // keeps the authored consequence judgment; it is never treated as noise.
  if (intent.contextRefs.length || intent.evidenceRefs.some(ref => !measurementRefs.has(ref))) return [];
  return intent.conditions.filter(item => item.availability === 'available'
      && /^(?:machine\.(?:memory|cpu|disk|swap))(?::|$)/.test(item.topic))
    .map(item => normalizeLearningDecision({
      schema: 'home23.learning-decision.v1', decisionId: `${intent.deliveryId}:${item.topic}`,
      scope: `owner.outreach:${/^[a-zA-Z0-9_.:-]+$/.test(item.topic) ? item.topic
        : `${item.topic.split(':')[0]}:${hash(item.topic).slice(0, 16)}`}`, criterion: 'owner-value',
      tags: ['unsolicited', 'routine', 'attention:problem', 'context:measurement-only',
        item.severity > 0 ? 'mild' : 'normal', 'impact:unestablished', item.condition],
      sourceRefs: intent.evidenceRefs,
      ...(intent.observedAt ? { observedAt: intent.observedAt } : {}),
    })).filter(Boolean);
}

class OwnerOutreachPolicy {
  constructor({ brainDir, readLearning = null } = {}) {
    this.file = brainDir ? path.join(brainDir, 'owner-attention.json') : null;
    this.readLearning = typeof readLearning === 'function' ? readLearning : null;
  }

  _load() {
    if (!this.file) throw new Error('owner attention durable directory unavailable');
    let state;
    try { state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { schema: SCHEMA, topics: {}, fingerprints: {}, deliveries: {} };
      throw error;
    }
    if (state?.schema !== SCHEMA || typeof state.topics !== 'object' || !state.topics
      || typeof state.fingerprints !== 'object' || !state.fingerprints || typeof state.deliveries !== 'object' || !state.deliveries
      || Array.isArray(state.topics) || Array.isArray(state.fingerprints) || Array.isArray(state.deliveries)) {
      throw new Error('invalid durable owner attention state');
    }
    return state;
  }

  _save(state) {
    writeFileDurableSync(this.file, JSON.stringify(state), { mode: 0o600, strictDirectorySync: true });
  }

  observe(candidate, memory) {
    try {
      const state = this._load();
      let changed = false;
      for (const condition of machineEvidence(candidate, memory).map(describeMachine)) {
        if (condition.availability !== 'available') continue;
        const key = hash(condition.topic);
        const previous = state.topics[key] || { topic: condition.topic, episode: 0 };
        if (previous.current?.condition === condition.condition) continue;
        const episode = previous.episode + (condition.severity === 0 && previous.current?.severity > 0 ? 1 : 0);
        state.topics[key] = { ...previous, episode, current: condition };
        changed = true;
      }
      if (changed) this._save(state);
      return { status: 'available' };
    } catch (error) { return { status: 'unavailable', detail: String(error.message || error).slice(0, 300) }; }
  }

  context(candidate, memory) {
    try {
      const state = this._load();
      const conditions = machineEvidence(candidate, memory).map(describeMachine);
      if (!conditions.length) return null;
      return conditions.map(condition => {
        const prior = state.topics[hash(condition.topic)]?.contact;
        return `${condition.topic}: ${condition.condition || 'structured condition unavailable'}. `
          + (prior ? `Previous admitted contact (${prior.status}, not proof it was read): ${prior.text}\nConsequence: ${prior.consequence || '(none)'}\nCondition: ${prior.condition}; evidence: ${prior.evidenceRefs.join(', ')}` : 'No earlier contact recorded by this attention policy.');
      }).join('\n\n');
    } catch (error) { return `Durable owner attention state unavailable: ${String(error.message || error).slice(0, 300)}. Do not treat unavailable history as a fresh reason to contact.`; }
  }

  buildIntent(outreach, { candidate, memory, deliveryId }) {
    const conditions = machineEvidence(candidate, memory, outreach.evidenceRefs).map(describeMachine);
    const machineRefs = new Set(conditions.map(item => item.sourceRef));
    const contextRefs = (outreach.attention?.evidenceRefs || []).filter(ref => !machineRefs.has(ref));
    const observedAt = new Date().toISOString();
    const intent = { schema: LEARNED_INTENT_SCHEMA, deliveryId, fingerprint: hash([outreach.text.replace(/\s+/g, ' ').trim(), [...outreach.evidenceRefs].sort()]),
      conditions, attention: outreach.attention || null, contextRefs,
      text: outreach.text, evidenceRefs: outreach.evidenceRefs, observedAt };
    intent.learningDecisions = learningDecisionsFor(intent);
    // The existing durable outbox retains these exact bytes before source
    // projection. A retry never creates a new event ID or observation time.
    intent.learningDecisionEvents = intent.learningDecisions.map(decision => ({
      event_id: crypto.randomUUID(), event_type: 'LearningDecisionObserved',
      session_id: `owner-outreach:${deliveryId}`, object_id: decision.decisionId,
      timestamp: observedAt, ts: observedAt, actor: 'engine-owner-outreach',
      payload: { learningVersion: 2, ...decision },
    }));
    return intent;
  }

  _judgeAuthored(state, intent, { retry = false } = {}) {
    if (!intent || ![INTENT_SCHEMA, LEARNED_INTENT_SCHEMA].includes(intent.schema) || typeof intent.deliveryId !== 'string'
      || !/^[a-f0-9]{64}$/.test(intent.fingerprint || '') || !Array.isArray(intent.conditions)
      || !Array.isArray(intent.evidenceRefs) || !Array.isArray(intent.contextRefs)) {
      return { allow: false, status: 'unavailable', reason: 'attention_intent_unavailable' };
    }
    const reserved = state.deliveries[hash(intent.deliveryId)];
    if (reserved) return { allow: retry, status: retry ? 'reserved' : 'suppressed', reason: 'same_reserved_delivery',
      reservedAt: reserved.reservedAt, reservedReason: reserved.reason };
    if (state.fingerprints[intent.fingerprint]) return { allow: false, status: 'suppressed', reason: 'same_message_and_evidence' };
    if (!intent.conditions.length) return { allow: true, status: 'eligible', reason: 'grounded_nonmachine_contact' };
    if (!intent.attention) return { allow: false, status: 'suppressed', reason: 'machine_consequence_missing' };
    if (intent.conditions.some(item => item.availability !== 'available')) {
      return { allow: false, status: 'unavailable', reason: 'machine_condition_unavailable' };
    }
    const contextual = ['connection', 'decision', 'progress'].includes(intent.attention.kind);
    if (contextual && !intent.contextRefs.length) return { allow: false, status: 'suppressed', reason: 'contextual_consequence_missing_evidence' };
    for (const condition of intent.conditions) {
      const topic = state.topics[hash(condition.topic)];
      const previous = topic?.contact;
      const contextChanged = contextual && hash(intent.contextRefs.slice().sort()) !== previous?.contextFingerprint;
      if (contextChanged) return { allow: true, status: 'eligible', reason: 'new_grounded_contextual_consequence', topic: condition.topic };
      if (intent.attention.kind === 'recovery') {
        if (condition.severity === 0 && previous?.severity > 0) return { allow: true, status: 'eligible', reason: 'meaningful_recovery', topic: condition.topic };
        continue;
      }
      if (condition.severity > 0 && (!previous || previous.episode !== topic?.episode || condition.severity > previous.severity
        || (condition.topic.startsWith('os.pm2:') && condition.condition !== previous.condition))) {
        return { allow: true, status: 'eligible', reason: previous ? 'changed_machine_problem' : 'new_machine_problem', topic: condition.topic };
      }
    }
    return { allow: false, status: 'suppressed', reason: 'unchanged_or_unactionable_machine_condition' };
  }

  _judge(state, intent, options = {}) {
    const authored = this._judgeAuthored(state, intent, options);
    const reserved = intent?.deliveryId && state.deliveries[hash(intent.deliveryId)];
    if (reserved) return { ...authored, ...(reserved.learning ? { learning: reserved.learning } : {}) };
    if (!authored.allow || intent.schema !== LEARNED_INTENT_SCHEMA) return authored;
    // Recompute scope from the validated structured intent. Caller-supplied
    // learningDecisions are evidence to retain, never authority to broaden it.
    const decisions = learningDecisionsFor(intent);
    if (!decisions.length) return authored;
    let snapshot;
    try { snapshot = this.readLearning?.() || null; }
    catch { snapshot = null; }
    const evaluations = decisions.map(decision => ({ decision,
      ...evaluateLearnedDecision(snapshot, { scope: decision.scope, tags: decision.tags }) }));
    const learning = {
      version: 1, available: evaluations.every(item => item.available),
      ...(Number.isSafeInteger(snapshot?.seq) ? { seq: snapshot.seq } : {}),
      lessonIds: [...new Set(evaluations.flatMap(item => item.lessonIds))],
      sourceRefs: [...new Set(evaluations.flatMap(item => item.sourceRefs))],
      adjustment: Math.min(...evaluations.map(item => item.adjustment)), decisions,
    };
    if (evaluations.some(item => item.suppress)) {
      return { ...authored, allow: false, status: 'suppressed', reason: 'learned_scoped_attenuation', learning };
    }
    return { ...authored, learning };
  }

  preview(intent) {
    try { return this._judge(this._load(), intent); }
    catch (error) { return { allow: false, status: 'unavailable', reason: 'attention_state_unavailable', detail: String(error.message || error).slice(0, 300) }; }
  }

  reserve(intent, request) {
    const state = this._load();
    const decision = this._judge(state, intent, { retry: true });
    if (!decision.allow) return decision;
    if (intent?.deliveryId !== request?.deliveryId) throw new Error('owner attention intent and delivery identity differ');
    const key = hash(intent.deliveryId);
    const requestHash = hash(request);
    const intentHash = hash(intent);
    const existing = state.deliveries[key];
    if (existing) {
      if (existing.requestHash !== requestHash || existing.intentHash !== intentHash) throw new Error('owner attention delivery identity conflicts with reserved content or judgment');
      return decision;
    }
    const reservedAt = new Date().toISOString();
    state.deliveries[key] = { deliveryId: intent.deliveryId, requestHash, intentHash, reservedAt, reason: decision.reason, status: 'pending',
      ...(decision.learning ? { learning: decision.learning } : {}) };
    state.fingerprints[intent.fingerprint] = intent.deliveryId;
    for (const condition of intent.conditions) {
      const topicKey = hash(condition.topic);
      const topic = state.topics[topicKey] || { topic: condition.topic, episode: 0, current: condition };
      state.topics[topicKey] = { ...topic, contact: {
        deliveryId: intent.deliveryId, reservedAt, episode: topic.episode, condition: condition.condition, severity: condition.severity,
        status: 'pending', text: intent.text, consequence: intent.attention?.consequence || null,
        evidenceRefs: intent.evidenceRefs, contextFingerprint: hash(intent.contextRefs.slice().sort()),
      } };
    }
    this._save(state);
    return decision;
  }

  complete(deliveryId, result) {
    const state = this._load();
    const record = state.deliveries[hash(deliveryId)];
    if (!record) throw new Error('owner attention delivery reservation missing');
    record.status = result.status;
    for (const topic of Object.values(state.topics)) if (topic.contact?.deliveryId === deliveryId) topic.contact.status = result.status;
    this._save(state);
  }
}

module.exports = { OwnerOutreachPolicy, machineEvidence, describeMachine };
