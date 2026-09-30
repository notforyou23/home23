'use strict';

// A kept thought may propose one bounded move. Source references support the
// proposal; neither this structure nor quoted material grants tool authority.
const SCOPES = new Set(['private_research', 'private_artifact', 'verification']);
const PURPOSES = new Set(['action', 'exploration', 'question']);

function normalizeResidentInitiative(raw, suppliedEvidenceRefs = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some(key => !['purpose', 'scope', 'why', 'nextMove', 'stopCondition', 'evidenceRefs'].includes(key))) return null;
  if (!PURPOSES.has(raw.purpose) || !SCOPES.has(raw.scope)) return null;
  const bounded = (value, max) => typeof value === 'string' && value.trim().length >= 10
    && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= max;
  if (!bounded(raw.why, 1000) || !bounded(raw.nextMove, 8192) || !bounded(raw.stopCondition, 4096)) return null;
  const allowed = new Set(suppliedEvidenceRefs);
  if (!Array.isArray(raw.evidenceRefs) || !raw.evidenceRefs.length || raw.evidenceRefs.length > 20
      || raw.evidenceRefs.some(ref => typeof ref !== 'string' || !allowed.has(ref) || Buffer.byteLength(ref, 'utf8') > 1024)) return null;
  return { purpose: raw.purpose, scope: raw.scope, why: raw.why.trim(), nextMove: raw.nextMove.trim(),
    stopCondition: raw.stopCondition.trim(), evidenceRefs: [...new Set(raw.evidenceRefs)] };
}

module.exports = { normalizeResidentInitiative };
