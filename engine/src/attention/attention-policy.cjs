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

function classifyAttentionRequest(input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : input;
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

  if (explicitMode === 'ambient' && !requiresAction && !anomaly && !exhausted && !INTERRUPTIVE_SEVERITIES.has(severity)) {
    return { mode: 'ambient', reason: 'explicit_ambient_no_action_required' };
  }
  if (explicitMode === 'interruptive') {
    return { mode: 'interruptive', reason: 'explicit_interruptive' };
  }
  if (requiresAction) return { mode: 'interruptive', reason: 'action_required' };
  if (exhausted) return { mode: 'interruptive', reason: 'automation_exhausted' };
  if (INTERRUPTIVE_SEVERITIES.has(severity)) return { mode: 'interruptive', reason: `severity_${severity}` };
  if (anomaly) return { mode: 'interruptive', reason: 'anomaly' };
  if (AMBIENT_SEVERITIES.has(severity)) return { mode: 'ambient', reason: `severity_${severity}` };
  return { mode: 'ambient', reason: 'routine_observation' };
}

function classifyObservationAttention(obs = {}) {
  const payload = readPayload(obs);
  return classifyAttentionRequest({
    ...payload,
    payload,
    severity: payload.severity,
  });
}

function shouldInterrupt(obs = {}) {
  return classifyObservationAttention(obs).mode === 'interruptive';
}

module.exports = {
  classifyAttentionRequest,
  classifyObservationAttention,
  shouldInterrupt,
};
