/**
 * MemoryIngest — engine-side writer that lands verified observations into
 * the harness-managed memory-objects.json + crystallization-receipts.jsonl.
 *
 * The harness's TypeScript MemoryObjectStore (src/agent/memory-objects.ts)
 * owns the schema and read path. The engine's bus writes to the same file
 * with proper-lockfile so both processes can coexist safely. When the
 * harness reloads (on conversation boundary or startup), it sees the bus-
 * ingested MemoryObjects as part of the same store.
 *
 * Confidence caps mirror config/home.yaml → osEngine.crystallization.
 */

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const lockfile = require('proper-lockfile');
const { isGeneratedMemoryMethod } = require('../../../shared/memory-authority.cjs');

const CHANNEL_CAPS = Object.freeze({
  sensor_primary:     0.95,
  sensor_derived:     0.80,
  build_event:        0.90,
  work_event:         0.90,
  neighbor_gossip:    0.70,
  zero_context_audit: 0.20,
  good_life:          0.88,
});
const DEFAULT_MAX_OBJECTS = 2500;

function applyChannelCap(method, confidence) {
  const cap = CHANNEL_CAPS[method];
  if (cap === undefined) return confidence;
  return Math.min(confidence, cap);
}

function classifyMemorySource(obs = {}, draft = {}) {
  const tags = new Set((draft.tags || []).map((tag) => String(tag).toLowerCase()));
  const channelId = String(obs.channelId || '').toLowerCase();
  const sourceRef = String(obs.sourceRef || '').toLowerCase();
  const method = String(draft.method || '').toLowerCase();
  const type = String(draft.type || '').toLowerCase();
  const payloadText = typeof obs.payload === 'string'
    ? obs.payload.toLowerCase()
    : safeStringify(obs.payload).toLowerCase();

  const hasTag = (...needles) => needles.some((needle) => tags.has(needle));
  const hasText = (...needles) => needles.some((needle) => (
    channelId.includes(needle) || sourceRef.includes(needle) || payloadText.includes(needle)
  ));
  const hasAffectLanguage = hasTag('affect', 'emotion', 'mood', 'psychology', 'interior-state', 'interior_state')
    || hasText('anxious', 'overwhelmed', 'depressed', 'angry', 'sad', 'happy', 'stressed', 'burned out', 'burnt out', 'interior state');
  const isOperationalTelemetry = hasText('cpu', 'machine.', 'domain.good-life', 'good-life', 'memory pressure', 'swap', 'process:', 'host');
  const hasSelfStateLanguage = hasTag('self-state', 'self_state', 'loop', 'first-person', 'first_person')
    || hasText('feels stuck', 'feel stuck', 'retrieval feels', 'loop feels', 'my state', 'own state', 'inside view');

  if (obs.flag === 'ZERO_CONTEXT' || method === 'zero_context_audit' || hasTag('low-provenance', 'low_provenance')) {
    return {
      source_class: 'low_provenance',
      memory_role: 'orientation_only',
      action_posture: 'do_not_promote_to_doctrine',
      doctrine_eligible: false,
    };
  }

  if (hasAffectLanguage && isOperationalTelemetry) {
    return {
      source_class: 'affect_inference',
      memory_role: 'metaphor_or_interpretation',
      action_posture: 'do_not_treat_as_personal_fact',
      doctrine_eligible: false,
      boundary: "Operational telemetry and metaphor cannot infer jtr's interior state.",
    };
  }

  if (hasSelfStateLanguage && isOperationalTelemetry) {
    return {
      source_class: 'operational_self_report',
      memory_role: 'event_segmentation',
      action_posture: 'verify_explanation_before_action',
      doctrine_eligible: false,
      boundary: 'Self-state language segments events; it does not explain cause until corroborated by channel evidence.',
      required_corroboration: ['queue_state', 'publication_state', 'channel_evidence'],
    };
  }

  if (obs.flag !== 'COLLECTED' || hasTag('needs-verification', 'needs_verification') || Number(obs.confidence) < 0.5) {
    return {
      source_class: 'needs_verification',
      memory_role: 'candidate_claim',
      action_posture: 'verify_before_action',
      doctrine_eligible: false,
    };
  }

  if (hasTag('public-facing', 'public_facing', 'publish', 'published') || hasText('publish', 'public/issues', 'from-the-inside/')) {
    return {
      source_class: 'public_facing_change',
      memory_role: 'public_record',
      action_posture: 'verify_before_reuse',
      doctrine_eligible: false,
    };
  }

  if (hasTag('action-authority', 'action_authority', 'manifest', 'verifier') || type === 'action' || hasText('allowedtransition', 'stopcondition', 'verifier')) {
    return {
      source_class: 'action_authority',
      memory_role: 'governing_contract',
      action_posture: 'may_authorize_bounded_action',
      doctrine_eligible: false,
    };
  }

  if (hasTag('historical', 'historical-context', 'historical_context') || hasText('/sessions/', '/dreams/', 'archive', 'historical context')) {
    return {
      source_class: 'historical_context',
      memory_role: 'context_modifier',
      action_posture: 'do_not_override_current_evidence',
      doctrine_eligible: false,
    };
  }

  return {
    source_class: 'orientation_clue',
    memory_role: 'orientation',
    action_posture: 'use_as_hint_only',
    doctrine_eligible: false,
  };
}

class MemoryIngest {
  constructor({ brainDir, logger, maxObjects = null }) {
    if (!brainDir) throw new Error('MemoryIngest requires brainDir');
    this.brainDir = brainDir;
    this.logger = logger || console;
    this.objectsPath = path.join(brainDir, 'memory-objects.json');
    this.archivePath = path.join(brainDir, 'memory-objects.archive.jsonl');
    this.receiptsPath = path.join(brainDir, 'crystallization-receipts.jsonl');
    this.maxObjects = maxObjects !== null && maxObjects !== undefined && Number.isFinite(Number(maxObjects))
      ? Number(maxObjects)
      : Number(process.env.HOME23_MEMORY_OBJECTS_ACTIVE_LIMIT || DEFAULT_MAX_OBJECTS);
    this._opChain = Promise.resolve();
    this._lockOptions = {
      stale: 30_000,
      update: 5_000,
      retries: { retries: 60, minTimeout: 50, maxTimeout: 500 },
    };
    try { fs.mkdirSync(brainDir, { recursive: true }); } catch {}
  }

  _loadSafe() {
    if (!fs.existsSync(this.objectsPath)) return { objects: [] };
    try {
      const raw = fs.readFileSync(this.objectsPath, 'utf8');
      if (!raw.trim()) return { objects: [] };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.objects)) return { objects: [] };
      return parsed;
    } catch { return { objects: [] }; }
  }

  _toMemoryObject(obs, draft, existing) {
    const now = new Date().toISOString();
    const confidenceRaw = applyChannelCap(draft.method, obs.confidence);
    const confidence = obs.flag === 'ZERO_CONTEXT'
      ? Math.min(confidenceRaw, CHANNEL_CAPS.zero_context_audit)
      : confidenceRaw;
    const id = existing?.memory_id || `mo-bus-${crypto.randomUUID()}`;
    const title = `[${obs.channelId}] ${summarizePayload(obs.payload)}`.slice(0, 120);
    const statement = typeof obs.payload === 'string' ? obs.payload : safeStringify(obs.payload);
    const sourceClassification = classifyMemorySource(obs, draft);
    const stateDelta = buildObservationStateDelta(existing, obs, { confidence, draft });
    const substrate = buildSubstrateProfile(existing, obs, draft, sourceClassification, stateDelta);
    const authority = buildAuthorityProfile(obs, draft, sourceClassification);
    const nodeProfile = buildNodeProvenanceProfile(obs, draft, sourceClassification, authority);
    return {
      memory_id: id,
      type: draft.type || 'observation',
      thread_id: 'bus-ingest',
      session_id: `bus-ingest-${obs.receivedAt.slice(0, 10)}`,
      lifecycle_layer: 'raw',
      status: 'candidate',
      title,
      statement: statement.slice(0, 4000),
      summary: summarizePayload(obs.payload).slice(0, 280),
      created_at: existing?.created_at || now,
      updated_at: now,
      actor: 'os-engine-bus',
      provenance: {
        trace_id: obs.traceId || null,
        source_refs: [obs.sourceRef, obs.channelId, ...(obs.traceId ? [obs.traceId] : []), ...(draft.tags || [])],
        session_refs: [`bus-ingest-${obs.receivedAt.slice(0, 10)}`],
        generation_method: draft.method || 'build_event',
        ...sourceClassification,
        authority,
        node_profile: nodeProfile,
        substrate,
        ...(obs.origin ? { origin: obs.origin } : {}),
      },
      evidence: {
        evidence_links: obs.verifierId ? [`verifier:${obs.verifierId}`] : [],
        grounding_strength: obs.flag === 'COLLECTED' ? 'strong' : obs.flag === 'UNCERTIFIED' ? 'medium' : 'weak',
        grounding_note: `flag=${obs.flag}`,
      },
      confidence: {
        score: confidence,
        basis: `bus-ingest/${obs.flag}/${draft.method || 'n/a'}`,
      },
      state_delta: stateDelta,
      triggers: [],
      scope: {
        applies_to: (draft.tags || []).slice(),
        excludes: [],
      },
      review_state: 'unreviewed',
      staleness_policy: buildStalenessPolicy(sourceClassification, substrate),
      reuse_count: existing?.reuse_count ?? 0,
    };
  }

  compactActiveStoreForWrite(store, onArchive = null) {
    if (!Array.isArray(store?.objects) || this.maxObjects <= 0 || store.objects.length <= this.maxObjects) {
      return store;
    }

    const sorted = store.objects
      .slice()
      .sort((a, b) => {
        const aMs = Date.parse(a.updated_at || a.created_at || 0) || 0;
        const bMs = Date.parse(b.updated_at || b.created_at || 0) || 0;
        return aMs - bMs;
      });
    const archiveCount = Math.max(0, sorted.length - this.maxObjects);
    const archived = sorted.slice(0, archiveCount);
    const kept = sorted.slice(archiveCount);
    for (const object of archived) onArchive?.(object);
    return { ...store, objects: kept };
  }

  _archiveObjects(objects = []) {
    if (!objects.length) return;
    try {
      const lines = objects.map((object) => JSON.stringify({
        archived_at: new Date().toISOString(),
        object,
      })).join('\n') + '\n';
      fs.appendFileSync(this.archivePath, lines);
    } catch (err) {
      this.logger.warn?.('[memory-ingest] archive append failed:', err?.message || err);
    }
  }

  async compactActiveStore({ reason = 'manual' } = {}) {
    if (!fs.existsSync(this.objectsPath)) return { archived: 0, active: 0 };

    let result = { archived: 0, active: 0 };
    await lockfile.lock(this.objectsPath, this._lockOptions)
      .then(async (release) => {
        try {
          const store = this._loadSafe();
          const archived = [];
          const compacted = this.compactActiveStoreForWrite(store, (object) => archived.push(object));
          if (!archived.length) {
            result = {
              archived: 0,
              active: Array.isArray(compacted.objects) ? compacted.objects.length : 0,
            };
            return;
          }
          this._archiveObjects(archived);
          fs.writeFileSync(this.objectsPath, JSON.stringify(compacted));
          result = { archived: archived.length, active: compacted.objects.length };
          this.logger.info?.('[memory-ingest] compacted active memory object store', {
            archived: result.archived,
            active: result.active,
            maxObjects: this.maxObjects,
            reason,
          });
        } finally {
          await release();
        }
      })
      .catch((err) => {
        this.logger.warn?.('[memory-ingest] compaction failed:', err?.message || err);
        throw err;
      });

    return result;
  }

  /**
   * applyDecay — reduces confidence on MemoryObjects whose tags match a
   * decay rule. Uses an exponential half-life model: factor = 0.5 ^ (age/halfLife).
   *
   * Tags checked are the MemoryObject's scope.applies_to list (which the
   * ingest path populates from the crystallize draft's tags).
   *
   * Returns the list of updated MemoryObjects.
   */
  async applyDecay({ now = Date.now(), rules = {} } = {}) {
    return this._withSerial(async () => {
      if (!Object.keys(rules).length) return [];
      if (!fs.existsSync(this.objectsPath)) return [];

      const updated = [];
      await lockfile.lock(this.objectsPath, this._lockOptions)
        .then(async (release) => {
          try {
            const store = this._loadSafe();
            for (const mo of store.objects) {
              const tags = Array.isArray(mo.scope?.applies_to) ? mo.scope.applies_to : [];
              let matchedRule = null;
              for (const tag of tags) {
                if (rules[tag]) { matchedRule = rules[tag]; break; }
              }
              if (!matchedRule) continue;
              const createdMs = Date.parse(mo.created_at);
              if (!Number.isFinite(createdMs)) continue;
              const age = now - createdMs;
              if (age <= 0) continue;
              const halfLives = age / matchedRule.halfLifeMs;
              const factor = Math.pow(0.5, halfLives);
              const prev = mo.confidence?.score ?? 0;
              const decayed = prev * factor;
              // Only record a change if it's meaningful (>= 0.01 delta).
              if (decayed < prev - 0.01) {
                const updatedAt = new Date(now).toISOString();
                mo.confidence = { ...mo.confidence, score: decayed, basis: `${mo.confidence?.basis || ''} + decay(${(1 - factor).toFixed(2)})` };
                mo.updated_at = updatedAt;
                mo.last_decayed_at = mo.updated_at;
                mo.provenance = {
                  ...(mo.provenance || {}),
                  substrate: buildDecaySubstrateProfile(mo, { updatedAt, factor, matchedRule }),
                };
                updated.push(mo);
              }
            }
            if (updated.length) {
              fs.writeFileSync(this.objectsPath, JSON.stringify(store));
              appendSubstrateDecayReceipts(this.receiptsPath, updated);
            }
          } finally {
            await release();
          }
        })
        .catch((err) => { this.logger.warn?.('[memory-ingest] applyDecay failed:', err?.message || err); });

      return updated;
    });
  }

  async writeFromObservation(obs, draft) {
    if (!obs || !obs.channelId) throw new Error('writeFromObservation requires obs with channelId');
    obs = ensureTraceId(obs);
    if (!draft) draft = { method: 'build_event', type: 'observation', topic: obs.channelId, tags: [] };

    return this._withSerial(() => this._writeFromObservationLocked(obs, draft));
  }

  async _writeFromObservationLocked(obs, draft) {
    // Ensure the file exists before acquiring a lock
    if (!fs.existsSync(this.objectsPath)) {
      fs.writeFileSync(this.objectsPath, JSON.stringify({ objects: [] }));
    }

    let written = null;
    await lockfile.lock(this.objectsPath, this._lockOptions)
      .then(async (release) => {
        try {
          const store = this._loadSafe();
          const existing = store.objects.find(
            (o) => Array.isArray(o.provenance?.source_refs)
              && o.provenance.source_refs.includes(obs.sourceRef)
              && o.provenance.source_refs.includes(obs.channelId),
          );
          const mo = this._toMemoryObject(obs, draft, existing);
          if (existing) {
            const idx = store.objects.indexOf(existing);
            store.objects[idx] = mo;
          } else {
            store.objects.push(mo);
          }
          const archived = [];
          const compacted = this.compactActiveStoreForWrite(store, (object) => archived.push(object));
          this._archiveObjects(archived);
          if (archived.length > 1) {
            this.logger.info?.('[memory-ingest] compacted active memory object store', {
              archived: archived.length,
              active: compacted.objects.length,
              maxObjects: this.maxObjects,
            });
          }
          fs.writeFileSync(this.objectsPath, JSON.stringify(compacted));
          written = mo;
        } finally {
          await release();
        }
      })
      .catch((err) => {
        this.logger.warn?.('[memory-ingest] write failed:', err?.message || err);
        throw err;
      });

    if (written) {
      const receipt = {
        at: new Date().toISOString(),
        traceId: obs.traceId || null,
        channelId: obs.channelId,
        sourceRef: obs.sourceRef,
        memoryObjectId: written.memory_id,
        flag: obs.flag,
        confidence: written.confidence.score,
        method: draft.method || null,
        origin: obs.origin || null,
        updateKind: written.state_delta?.delta_class || 'no_change',
        stateDelta: written.state_delta || null,
        substrate: written.provenance?.substrate || null,
        nodeProvenance: written.provenance?.node_profile || null,
      };
      try { fs.appendFileSync(this.receiptsPath, JSON.stringify(receipt) + '\n'); }
      catch (err) { this.logger.warn?.('[memory-ingest] receipt append failed:', err?.message || err); }
    }

    return written;
  }

  _withSerial(task) {
    const run = this._opChain.then(task, task);
    this._opChain = run.catch(() => {});
    return run;
  }
}

function summarizePayload(payload) {
  if (payload == null) return '(empty)';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);
  // Prefer obvious textual fields
  for (const k of ['summary', 'subject', 'content', 'title', 'message', 'event']) {
    if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k];
  }
  return safeStringify(payload).slice(0, 280);
}

function buildSubstrateProfile(existing, obs, draft, sourceClassification, stateDelta) {
  const previous = existing?.provenance?.substrate && typeof existing.provenance.substrate === 'object'
    ? existing.provenance.substrate
    : {};
  const previousRouteUseCount = Number.isFinite(Number(previous.routeUseCount))
    ? Number(previous.routeUseCount)
    : 0;
  const routeUseCount = previousRouteUseCount + 1;
  const routeState = !existing
    ? 'new_path'
    : stateDelta?.delta_class === 'updated_observation'
      ? 'rerouted_path'
      : 'reinforced_path';

  return {
    schema: 'home23.memory-substrate.v1',
    sourceIssue: 90,
    routeKey: `${obs.channelId || 'unknown'}:${obs.sourceRef || 'unknown'}`,
    sourceSurface: obs.channelId || null,
    sourceRef: obs.sourceRef || null,
    topic: draft?.topic || obs.channelId || null,
    routeState,
    routeUseCount,
    previousRouteUseCount,
    lastSignalAt: obs.producedAt || obs.receivedAt || null,
    lastIngestedAt: new Date().toISOString(),
    decayEligibleTags: (draft?.tags || []).slice(),
    boundary: 'Interfaces are negotiated contact surfaces; repeated use can reinforce, changed evidence can reroute, and stale paths must be allowed to decay.',
    failureVisible: obs.flag !== 'COLLECTED' || sourceClassification.action_posture === 'verify_before_action',
  };
}

function buildStalenessPolicy(sourceClassification = {}, substrate = {}) {
  if (sourceClassification.source_class === 'historical_context') return { review_after_days: 90 };
  if (sourceClassification.source_class === 'low_provenance') return { review_after_days: 7, expire_after_days: 30 };
  if (substrate.failureVisible) return { review_after_days: 3, expire_after_days: 30 };
  return { review_after_days: 14 };
}

function buildDecaySubstrateProfile(mo, { updatedAt, factor }) {
  const previous = mo?.provenance?.substrate && typeof mo.provenance.substrate === 'object'
    ? mo.provenance.substrate
    : substrateFromMemoryObject(mo);
  const decayCount = Number.isFinite(Number(previous.decayCount))
    ? Number(previous.decayCount) + 1
    : 1;

  return {
    ...previous,
    schema: 'home23.memory-substrate.v1',
    sourceIssue: 90,
    routeState: 'decayed_path',
    decayCount,
    lastDecayAt: updatedAt,
    lastDecayFactor: Number(factor.toFixed(4)),
    boundary: previous.boundary || 'History should bias future behavior without preserving dead routes as live signal.',
  };
}

function substrateFromMemoryObject(mo = {}) {
  const sourceRefs = Array.isArray(mo.provenance?.source_refs) ? mo.provenance.source_refs : [];
  const sourceRef = sourceRefs[0] || null;
  const sourceSurface = sourceRefs[1] || null;
  return {
    schema: 'home23.memory-substrate.v1',
    sourceIssue: 90,
    routeKey: `${sourceSurface || 'unknown'}:${sourceRef || mo.memory_id || 'unknown'}`,
    sourceSurface,
    sourceRef,
    topic: mo.provenance?.authority?.topic || null,
    routeState: 'unknown_path',
    routeUseCount: Number(mo.reuse_count || 0) + 1,
    previousRouteUseCount: Number(mo.reuse_count || 0),
    lastSignalAt: mo.updated_at || mo.created_at || null,
    lastIngestedAt: mo.updated_at || null,
    decayEligibleTags: Array.isArray(mo.scope?.applies_to) ? mo.scope.applies_to.slice() : [],
    failureVisible: false,
    boundary: 'History should bias future behavior without preserving dead routes as live signal.',
  };
}

function appendSubstrateDecayReceipts(receiptsPath, objects = []) {
  if (!objects.length) return;
  const lines = objects.map((mo) => JSON.stringify({
    at: mo.last_decayed_at || new Date().toISOString(),
    traceId: mo.provenance?.trace_id || null,
    channelId: mo.provenance?.substrate?.sourceSurface || null,
    sourceRef: mo.provenance?.substrate?.sourceRef || null,
    memoryObjectId: mo.memory_id,
    flag: parseGroundingFlag(mo.evidence?.grounding_note),
    confidence: mo.confidence?.score ?? null,
    method: mo.provenance?.generation_method || null,
    updateKind: 'substrate_decay',
    stateDelta: {
      delta_class: 'substrate_decay',
      before: {},
      after: { confidence: mo.confidence?.score ?? null },
      why: 'decay rule reduced a less-used or older substrate path',
    },
    substrate: mo.provenance?.substrate || null,
  })).join('\n') + '\n';
  fs.appendFileSync(receiptsPath, lines);
}

function buildObservationStateDelta(existing, obs, { confidence, draft } = {}) {
  const after = {
    summary: summarizePayload(obs.payload).slice(0, 280),
    flag: obs.flag || null,
    confidence: confidence ?? null,
    method: draft?.method || null,
    sourceRef: obs.sourceRef || null,
    channelId: obs.channelId || null,
  };

  if (!existing) {
    return {
      delta_class: 'no_change',
      before: {},
      after: {},
      why: 'observation ingested',
    };
  }

  const before = {
    summary: existing.summary || null,
    flag: parseGroundingFlag(existing.evidence?.grounding_note),
    confidence: existing.confidence?.score ?? null,
    method: existing.provenance?.generation_method || null,
    sourceRef: obs.sourceRef || null,
    channelId: obs.channelId || null,
  };

  const changed = before.summary !== after.summary
    || before.flag !== after.flag
    || before.confidence !== after.confidence
    || before.method !== after.method;

  return {
    delta_class: changed ? 'updated_observation' : 'refreshed_observation',
    before,
    after,
    why: changed ? 'same source observation changed' : 'same source observation refreshed',
  };
}

function buildAuthorityProfile(obs = {}, draft = {}, sourceClassification = {}) {
  const producedAt = obs.producedAt || obs.receivedAt || null;
  const producedMs = Date.parse(producedAt || '');
  const ageMs = Number.isFinite(producedMs) ? Date.now() - producedMs : null;
  const ageHours = ageMs == null ? null : Math.max(0, ageMs / 3600000);
  const tags = new Set((draft.tags || []).map((tag) => String(tag).toLowerCase()));
  const channelId = String(obs.channelId || '');
  const method = String(draft.method || '');
  const topic = String(draft.topic || channelId);
  const isHistorical = sourceClassification.source_class === 'historical_context'
    || tags.has('historical')
    || tags.has('archive')
    || tags.has('historical-context')
    || tags.has('historical_context');
  const isCurrentStateSurface = /^(machine|domain|work|build|os|notify)\./.test(channelId)
    || ['sensor_primary', 'sensor_derived', 'work_event', 'build_event', 'good_life'].includes(method);

  let temporalStatus = 'unknown';
  if (isHistorical) temporalStatus = 'historical';
  else if (ageHours == null) temporalStatus = 'unknown';
  else if (ageHours <= 6) temporalStatus = 'current';
  else if (ageHours <= 72) temporalStatus = 'recent';
  else temporalStatus = 'stale';

  const presentTenseAuthority = obs.flag === 'COLLECTED'
    && isCurrentStateSurface
    && (temporalStatus === 'current' || temporalStatus === 'recent')
    && sourceClassification.action_posture !== 'do_not_override_current_evidence';

  return {
    schema: 'home23.memory-authority.v1',
    sourceIssue: 85,
    sourceSurface: channelId || null,
    sourceRef: obs.sourceRef || null,
    topic,
    producedAt,
    receivedAt: obs.receivedAt || null,
    temporalStatus,
    ageHours: ageHours == null ? null : Number(ageHours.toFixed(2)),
    appliesTo: (draft.tags || []).slice(),
    presentTenseAuthority,
    canRouteAttention: true,
    canAuthorizeAction: Boolean(
      presentTenseAuthority
      && sourceClassification.action_posture === 'may_authorize_bounded_action'
    ),
    authorityOrder: authorityOrderFor({ channelId, method, isCurrentStateSurface, isHistorical }),
    verificationBeforeReuse: verificationBeforeReuse({
      obs,
      temporalStatus,
      presentTenseAuthority,
      sourceClassification,
    }),
    wrongTenseGuard: 'Do not reuse this memory as present-tense operational truth unless the authorityOrder source for the question is checked now.',
  };
}

function buildNodeProvenanceProfile(obs = {}, draft = {}, sourceClassification = {}, authority = {}) {
  const tags = boundedStrings(draft.tags || [], 8, 240);
  const normalizedTags = new Set(tags.map((tag) => tag.toLowerCase()));
  const method = String(draft.method || 'build_event');
  const channelId = String(obs.channelId || '');
  const sourceRef = String(obs.sourceRef || '');
  const generated = isGeneratedMemoryMethod(method) || [...normalizedTags].some((tag) => (
    tag === 'generated-report' || tag === 'generated_report' || tag === 'synthesis'
    || tag === 'narrative' || tag === 'query' || tag === 'pgs'
  ));
  const adoptedDoctrineReceipt = tags.find((tag) => (
    tag.toLowerCase().startsWith('adopted-doctrine-receipt:')
    || tag.toLowerCase().startsWith('adopted_doctrine_receipt:')
  ));
  const jtrCorrection = [...normalizedTags].some((tag) => (
    tag === 'jtr-correction' || tag === 'jtr_correction' || tag === 'owner-correction'
  )) || sourceRef.toLowerCase().startsWith('jtr:correction:');
  const verifierEvidence = obs.verifierId
    ? boundedStrings([`verifier:${obs.verifierId}`], 8, 240)
    : [];
  const isVerifiedCurrent = !generated
    && !jtrCorrection
    && obs.flag === 'COLLECTED'
    && authority.presentTenseAuthority === true
    && verifierEvidence.length > 0;
  const isWorkerReceipt = /^worker[.:]/i.test(sourceRef)
    || normalizedTags.has('worker-receipt')
    || normalizedTags.has('worker_receipt');

  let authorityClass = 'narrative';
  if (generated) authorityClass = adoptedDoctrineReceipt ? 'generated_doctrine' : 'narrative';
  else if (jtrCorrection) authorityClass = 'jtr_correction';
  else if (isVerifiedCurrent) authorityClass = 'verified_current_state';
  else if (isWorkerReceipt) authorityClass = 'worker_receipt';
  else if (sourceRef) authorityClass = 'artifact_log';

  const isClosed = [...normalizedTags].some((tag) => (
    tag === 'closed' || tag === 'resolved' || tag === 'fixed' || tag === 'archived'
  ));
  const isExternal = /^(x|news|market|research|timeline|cron)[.:]/i.test(channelId)
    || [...normalizedTags].some((tag) => (
      tag === 'external' || tag === 'news' || tag === 'x' || tag === 'twitter'
      || tag === 'market' || tag === 'cron' || tag === 'telemetry'
    ));
  const retrievalDomain = isClosed
    ? 'closed_incidents'
    : isExternal
      ? 'external_intake'
      : authority.temporalStatus === 'current' || authority.temporalStatus === 'recent'
        ? 'current_ops'
        : 'project_history';

  const volatileCorrection = jtrCorrection && (
    /^(machine|os|build|work)\./i.test(channelId)
    || [...normalizedTags].some((tag) => (
      tag === 'machine' || tag === 'runtime' || tag === 'process' || tag === 'health'
    ))
  );
  const operationalAuthority = authorityClass === 'verified_current_state'
    || (authorityClass === 'jtr_correction' && !volatileCorrection);
  const missingEvidence = [];
  if (authorityClass === 'narrative' || authorityClass === 'generated_doctrine') {
    missingEvidence.push('independent_direct_evidence');
  }
  if (authority.presentTenseAuthority === true && verifierEvidence.length === 0) {
    missingEvidence.push('verifier_evidence');
  }
  if (volatileCorrection) missingEvidence.push('live_machine_verifier');

  return {
    schema: 'home23.node-provenance.v1',
    authorityClass,
    retrievalDomain,
    semanticTime: boundedString(obs.producedAt || obs.receivedAt || null, 64),
    sourceRefs: boundedStrings([
      sourceRef,
      channelId,
      obs.traceId,
      ...tags,
    ], 8, 240),
    evidenceRefs: boundedStrings([
      ...verifierEvidence,
      ...(adoptedDoctrineReceipt ? [adoptedDoctrineReceipt] : []),
    ], 8, 240),
    generationMethod: boundedString(method, 120),
    sourcePath: null,
    contentHash: null,
    derivedNodeIds: [],
    scope: tags,
    expiresAt: null,
    operationalAuthority,
    requiresFreshVerification: !operationalAuthority,
    missingEvidence: boundedStrings(missingEvidence, 8, 120),
  };
}

function boundedStrings(values, limit = 8, maxBytes = 240) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const bounded = boundedString(value, maxBytes);
    if (!bounded || result.includes(bounded)) continue;
    result.push(bounded);
    if (result.length >= limit) break;
  }
  return result;
}

function boundedString(value, maxBytes) {
  if (typeof value !== 'string' || !value) return null;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bounded = value.slice(0, maxBytes);
  while (bounded && Buffer.byteLength(bounded, 'utf8') > maxBytes) bounded = bounded.slice(0, -1);
  return bounded || null;
}

function authorityOrderFor({ channelId, method, isCurrentStateSurface, isHistorical }) {
  if (isHistorical) {
    return ['append_only_history', 'source_file', 'memory_object', 'summary'];
  }
  if (channelId.startsWith('machine.') || channelId.startsWith('os.')) {
    return ['live_machine_observation', 'verifier_receipt', 'memory_object', 'summary'];
  }
  if (channelId.startsWith('domain.health')) {
    return ['latest_health_log_metric_date', 'health_bridge_status', 'memory_object', 'summary'];
  }
  if (channelId.startsWith('domain.good-life')) {
    return ['good_life_snapshot', 'live_problem_registry', 'memory_object', 'summary'];
  }
  if (channelId.startsWith('work.') || method === 'work_event') {
    return ['source_artifact_or_receipt', 'work_queue_state', 'memory_object', 'summary'];
  }
  if (channelId.startsWith('build.') || method === 'build_event') {
    return ['git_or_build_receipt', 'source_file', 'memory_object', 'summary'];
  }
  if (isCurrentStateSurface) {
    return ['current_source_surface', 'verifier_receipt', 'memory_object', 'summary'];
  }
  return ['source_ref', 'memory_object', 'summary'];
}

function verificationBeforeReuse({ obs, temporalStatus, presentTenseAuthority, sourceClassification }) {
  const checks = [];
  if (obs.flag !== 'COLLECTED') checks.push('observation_not_collected');
  if (!presentTenseAuthority) checks.push('not_authoritative_for_present_tense');
  if (temporalStatus === 'stale' || temporalStatus === 'historical' || temporalStatus === 'unknown') {
    checks.push('check_current_source_of_truth');
  }
  if (sourceClassification.action_posture === 'verify_before_action') checks.push('verify_before_action');
  if (sourceClassification.action_posture === 'do_not_override_current_evidence') checks.push('must_not_override_current_evidence');
  return checks.length ? checks : ['none_for_same-scope_context_reuse'];
}

function parseGroundingFlag(note) {
  const match = typeof note === 'string' ? /^flag=([^;,\s]+)/.exec(note) : null;
  return match ? match[1] : null;
}

function ensureTraceId(obs) {
  if (obs.traceId) return obs;
  const input = `${obs.channelId || 'unknown'}\0${obs.sourceRef || 'unknown'}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
  return { ...obs, traceId: `trace:${hash}` };
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { MemoryIngest, applyChannelCap, CHANNEL_CAPS };
