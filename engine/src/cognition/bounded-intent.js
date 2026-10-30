'use strict';

// This is a proposal for an inspection, never a grant of owner or repair
// authority. The consumer must also select the inspection-only tool registry.
const SCHEMA = 'home23.bounded-agenda-intent.v1';
const FIELDS = new Set(['schema', 'operation', 'targetRef', 'question', 'expectedEvidence', 'stopCondition', 'evidenceRefs']);
const OPERATIONS = new Set(['inspect', 'verify']);
const REQUESTS_MUTATION = /(?:^|[.;]\s*|\bthen\s+|\band\s+)(?:restart|delete|remove|disable|enable|rewrite|overwrite|install|deploy|publish|purchase|buy|send|email|merge|push|execute|run\s+(?:a\s+)?(?:shell|command))\b/i;

function hasBoundedIntent(item) {
  return !!item && typeof item === 'object' && Object.hasOwn(item, 'boundedIntent');
}

function normalizeBoundedAgendaIntent(raw, suppliedEvidenceRefs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !FIELDS.has(key)) || raw.schema !== SCHEMA || !OPERATIONS.has(raw.operation)) return null;
  const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= max;
  if (!text(raw.question, 12, 2000) || !text(raw.expectedEvidence, 10, 2000)
    || !text(raw.stopCondition, 10, 2000) || !text(raw.targetRef, 3, 1024)) return null;
  if ([raw.question, raw.expectedEvidence, raw.stopCondition].some(value => REQUESTS_MUTATION.test(value.trim()))) return null;
  if (!Array.isArray(suppliedEvidenceRefs) || !suppliedEvidenceRefs.length) return null;
  const allowed = new Set(suppliedEvidenceRefs.filter(value => typeof value === 'string'));
  if (!allowed.has(raw.targetRef) || !Array.isArray(raw.evidenceRefs) || !raw.evidenceRefs.length || raw.evidenceRefs.length > 20
    || raw.evidenceRefs.some(ref => !text(ref, 3, 1024) || !allowed.has(ref)) || !raw.evidenceRefs.includes(raw.targetRef)) return null;
  return { schema: SCHEMA, operation: raw.operation, targetRef: raw.targetRef,
    question: raw.question.trim(), expectedEvidence: raw.expectedEvidence.trim(), stopCondition: raw.stopCondition.trim(),
    evidenceRefs: [...new Set(raw.evidenceRefs)] };
}

function boundedIntentForItem(item, suppliedEvidenceRefs = item?.intentEvidenceRefs) {
  return normalizeBoundedAgendaIntent(item?.boundedIntent, suppliedEvidenceRefs);
}

function boundedIntentTarget(intent) {
  return `${intent.operation}:${intent.targetRef}`;
}

function sameBoundedIntent(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const identity = value => JSON.stringify({ ...value, evidenceRefs: [] });
  return identity(a) === identity(b);
}

module.exports = { BOUNDED_AGENDA_INTENT_SCHEMA: SCHEMA, hasBoundedIntent,
  normalizeBoundedAgendaIntent, boundedIntentForItem, boundedIntentTarget, sameBoundedIntent };
