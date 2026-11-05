/**
 * Attention policy for Home23 operator surfaces.
 *
 * Routine observations should stay ambient. Interruptive lanes are reserved
 * for action-required anomalies, exhausted automation, or explicit user
 * intervention. This keeps salience from becoming a notification economy.
 */

'use strict';

const INTERRUPTIVE_SEVERITIES = new Set(['alert', 'urgent', 'critical', 'emergency']);
const AMBIENT_SEVERITIES = new Set(['low', 'info', 'normal', 'routine', 'ambient']);
const DEFAULT_SIGNAL_MAX_AGE_MS = 30 * 60 * 1000;
const PROTECTED_RHYTHMS = new Set(['family-evening', 'family', 'sleep', 'recovery']);

function truthy(v) {
  if (v === true) return true;
  if (typeof v === 'string') return ['true', 'yes', 'required', 'action_required'].includes(v.toLowerCase());
  return false;
}

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['interrupt', 'interruptive', 'alert', 'page'].includes(s)) return 'interruptive';
  if (['ambient', 'dashboard', 'silent', 'observe'].includes(s)) return 'ambient';
  return null;
}

function readPayload(obs) {
  if (!obs || typeof obs !== 'object') return {};
  return obs.payload && typeof obs.payload === 'object' ? obs.payload : {};
}

function activeRhythmsFrom(input = {}) {
  const temporal = input.temporalContext
    || input.payload?.temporalContext
    || input.attention?.temporalContext
    || null;
  const rhythms = temporal?.jtrTime?.activeRhythms || temporal?.activeRhythms || input.activeRhythms;
  return Array.isArray(rhythms) ? rhythms.map(r => String(r).toLowerCase()) : [];
}

function normalizeFreshnessStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (['current', 'fresh', 'live'].includes(s)) return 'current';
  if (['stale', 'expired', 'old'].includes(s)) return 'stale';
  if (['unknown', 'missing', 'unverified'].includes(s)) return 'unknown';
  return null;
}

function readTimestampMs(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function nowFrom(input = {}, temporal = {}) {
  const raw = input.now ?? temporal.now ?? temporal.at;
  const parsed = readTimestampMs(raw);
  return parsed ?? Date.now();
}

function buildContactContext(input = {}, options = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : input;
  const temporal = options.temporalContext || input.temporalContext || payload.temporalContext || {};
  const rhythms = activeRhythmsFrom({ ...input, temporalContext: temporal });
  const now = nowFrom(input, temporal);
  const freshness = payload.freshness && typeof payload.freshness === 'object' ? payload.freshness : {};
  const observedAtMs = readTimestampMs(
    freshness.observedAt,
    freshness.receivedAt,
    freshness.checkedAt,
    payload.observedAt,
    payload.receivedAt,
    payload.checkedAt,
    input.observedAt,
    input.receivedAt,
    input.checkedAt
  );
  const maxAgeMs = Number(freshness.maxAgeMs ?? payload.maxAgeMs ?? options.maxAgeMs ?? DEFAULT_SIGNAL_MAX_AGE_MS);
  const explicitStatus = normalizeFreshnessStatus(freshness.status || payload.freshnessStatus || payload.statusFreshness);
  const ageMs = observedAtMs == null ? null : Math.max(0, now - observedAtMs);
  const status = explicitStatus
    || (ageMs == null ? 'unknown' : ageMs > maxAgeMs ? 'stale' : 'current');
  const protectedRhythm = rhythms.find(rhythm => PROTECTED_RHYTHMS.has(rhythm)) || null;
  const modeSwitchCost = protectedRhythm || rhythms.includes('deep-work') ? 'high' : 'normal';

  return {
    schema: 'home23.attention-contact.v1',
    sourceIssues: [89],
    activeRhythms: rhythms,
    protectedRhythm,
    modeSwitchCost,
    freshness: {
      status,
      observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
      ageMs,
      maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : DEFAULT_SIGNAL_MAX_AGE_MS,
      liveState: status === 'current',
    },
    interpretationBoundary: 'Home/body signals are context, not identity; signal first, interpretation second, speech last.',
  };
}

function classifyAttentionRequest(input = {}, options = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : input;
  const contact = buildContactContext(input, options);
  const rhythms = contact.activeRhythms;
  const explicitMode = normalizeMode(
    payload.attentionMode
    || payload.deliveryMode
    || payload.delivery?.mode
    || payload.attention?.mode
  );
  const severity = String(payload.severity || payload.level || input.severity || '').toLowerCase();
  const requiresAction = truthy(payload.requiresAction)
    || truthy(payload.actionRequired)
    || truthy(payload.userInterventionRequired)
    || truthy(payload.needsUser)
    || truthy(payload.attention?.requiresAction);
  const anomaly = truthy(payload.anomaly)
    || truthy(payload.isAnomaly)
    || truthy(payload.attention?.anomaly)
    || ['anomaly', 'open_problem', 'live_problem'].includes(String(payload.kind || '').toLowerCase());
  const exhausted = truthy(payload.automationExhausted)
    || truthy(payload.remediationExhausted)
    || String(payload.source || '').toLowerCase() === 'live-problems';
  const emergency = ['critical', 'emergency'].includes(severity);

  function decision(mode, reason, extra = {}) {
    return { mode, reason, contact, ...extra };
  }

  if (explicitMode === 'ambient' && !requiresAction && !anomaly && !exhausted && !INTERRUPTIVE_SEVERITIES.has(severity)) {
    return decision('ambient', 'explicit_ambient_no_action_required');
  }

  let interruptReason = null;
  if (explicitMode === 'interruptive') interruptReason = 'explicit_interruptive';
  else if (requiresAction) interruptReason = 'action_required';
  else if (exhausted) interruptReason = 'automation_exhausted';
  else if (INTERRUPTIVE_SEVERITIES.has(severity)) interruptReason = `severity_${severity}`;
  else if (anomaly) interruptReason = 'anomaly';

  if (interruptReason) {
    if (contact.freshness.status === 'stale' && !truthy(payload.allowStaleInterrupt)) {
      return decision('ambient', 'stale_signal_deferred', { deferredReason: interruptReason });
    }
    if (contact.protectedRhythm && !requiresAction && !exhausted && !emergency) {
      return decision('ambient', 'protected_rhythm_defers_non_urgent', { deferredReason: interruptReason });
    }
    return decision('interruptive', interruptReason);
  }

  if (rhythms.includes('deep-work')) {
    return decision('ambient', 'deep_work_suppresses_non_action');
  }
  if (AMBIENT_SEVERITIES.has(severity)) return decision('ambient', `severity_${severity}`);
  return decision('ambient', 'routine_observation');
}

function classifyObservationAttention(obs = {}, options = {}) {
  const payload = readPayload(obs);
  return classifyAttentionRequest({
    ...payload,
    payload,
    severity: payload.severity,
    temporalContext: options.temporalContext || obs.temporalContext || payload.temporalContext,
    activeRhythms: options.activeRhythms || obs.activeRhythms || payload.activeRhythms,
  });
}

function shouldInterrupt(obs = {}, options = {}) {
  return classifyObservationAttention(obs, options).mode === 'interruptive';
}

module.exports = {
  buildContactContext,
  classifyAttentionRequest,
  classifyObservationAttention,
  shouldInterrupt,
};
