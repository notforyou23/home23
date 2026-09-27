'use strict';

/** Read-only claim feedback. Lexical fallback is deliberately conservative:
 * it recognizes near repeats, not arbitrary paraphrases or shared topics.
 * Explicit revision links carry the relationship when wording has changed. */
const STOP = new Set('a an the is are was were be been being will would should could may might can do does did to of in on at for from with and or that this it its as by within next during over i we our my there then than'.split(' '));
function words(text) {
  return [...new Set((String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => !STOP.has(word) && !/^\d+$/.test(word))
    .map(word => word.length > 5 && word.endsWith('s') ? word.slice(0, -1) : word))];
}
function normalized(text) { return String(text || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function claimsRelated(a, b) {
  const left = typeof a === 'string' ? a : a?.claim;
  const right = typeof b === 'string' ? b : b?.claim;
  if (!left || !right) return false;
  if (normalized(left) === normalized(right)) return true;
  const x = new Set(words(left));
  const y = new Set(words(right));
  const common = [...x].filter(word => y.has(word)).length;
  // One shared subject ("watcher", "music") is never a family match.
  return common >= 3 && common / Math.max(x.size, y.size) >= 0.72
    && common / (x.size + y.size - common) >= 0.55;
}
function isExternalEvidenceRef(ref) {
  if (!ref || ref.flag !== 'COLLECTED' || typeof ref.refId !== 'string' || !ref.refId) return false;
  if (!['home23.event-ledger', 'home23.channel.bus', 'seed.adapter', 'external.inert'].includes(ref.sourceAuthority)) return false;
  if (typeof ref.head !== 'string' || !ref.head.trim() || !Number.isFinite(Date.parse(ref.observedAt))) return false;
  const source = String(ref.sourceRef || '');
  if (/^(?:action|work|coordination\.work):/.test(source)) {
    const receipt = ref.executionOutcome;
    return ref.sourceAuthority === 'home23.event-ledger'
      && receipt?.schema === 'home23.execution-outcome.v1'
      && ['action', 'work'].includes(receipt.executionKind)
      && (source.startsWith(`${receipt.executionKind}:`) || (receipt.executionKind === 'work' && source.startsWith('coordination.work:')))
      && ['completed', 'failed', 'blocked', 'rejected'].includes(receipt.status)
      && typeof receipt.receiptEventId === 'string' && receipt.receiptEventId.length > 0
      && Array.isArray(receipt.evidenceRefs) && receipt.evidenceRefs.some(value => typeof value === 'string' && value.length > 0);
  }
  // The adapter emits conversation.jtr/self/peer; only the owner's words
  // qualify here. Unknown or older resident names cannot masquerade as owner.
  if (source.startsWith('conversation.')) return /^conversation\.jtr(?::|$)/.test(source);
  return /^(?:relationship\.(?:correction|attenuation|teaching)(?::|$)|house\.|external[.:]|observation[.:]|sensor[.:]|tool[.:])/.test(source);
}
function evidenceTouchesClaim(ref, item) {
  // Relevance is necessary, not proof of entailment: a model must still explain
  // why this observation changes its warrant. Unrelated new contact cannot
  // reopen a failed family merely by supplying a fresh timestamp.
  const claimWords = new Set(words(item.claim).filter(word => word.length >= 4));
  return words(ref.head).filter(word => word.length >= 4 && claimWords.has(word)).length >= 2;
}
function getClaimFeedback(cell, candidate) {
  const item = typeof candidate === 'string' ? { claim: candidate } : (candidate || {});
  const links = new Set(Array.isArray(item.revisesPredictionIds) ? item.revisesPredictionIds : []);
  const relatedPredictions = (cell?.predictions || []).filter(p => claimsRelated(item, p) || links.has(p.predictionId));
  // Duplicate legacy rows are one occurrence, not additional failures.
  const unique = new Map();
  for (const prediction of relatedPredictions) {
    if (prediction.resolvedAt && Number.isFinite(prediction.error) && prediction.error >= 0.7) {
      unique.set(`${prediction.predictionId || normalized(prediction.claim)}:${prediction.createdAt || ''}`, prediction);
    }
  }
  const failedPredictions = [...unique.values()].sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)));
  const latestFailureAt = failedPredictions[0]?.resolvedAt || null;
  const refs = new Set(Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []);
  const failedAt = latestFailureAt === null ? NaN : Date.parse(latestFailureAt);
  const createdAt = Date.parse(item.createdAt || '');
  // A receipt-carried witness preserves why an admitted revision was allowed
  // after the bounded reality-ref window moves on. It is not proof the claim
  // became true. The writer constructs it from actual refs, never model input.
  const snapshot = item.revisionEvidence;
  const snapshotRefs = snapshot?.version === 1 && snapshot.admittedAt === item.createdAt
    && Array.isArray(snapshot.failedPredictionIds)
    && failedPredictions.some(p => p.resolvedAt === latestFailureAt && snapshot.failedPredictionIds.includes(p.predictionId))
    && Array.isArray(snapshot.refs) ? snapshot.refs : [];
  const availableRefs = [...new Map([...snapshotRefs, ...(cell?.realityRefs || [])]
    .filter(ref => ref && typeof ref.refId === 'string').map(ref => [ref.refId, ref])).values()];
  const freshEvidenceRefs = availableRefs.filter(ref => refs.has(ref.refId) && isExternalEvidenceRef(ref) && evidenceTouchesClaim(ref, item)
    && Date.parse(ref.observedAt) > failedAt
    && (!Number.isFinite(createdAt) || Date.parse(ref.observedAt) <= createdAt)).map(ref => ref.refId);
  const hasSupportedRevision = failedPredictions.length > 0 && freshEvidenceRefs.length > 0
    && failedPredictions.some(p => p.resolvedAt === latestFailureAt && links.has(p.predictionId))
    && typeof item.revisionReason === 'string' && item.revisionReason.trim().length >= 15
    && normalized(item.revisionReason) !== normalized(item.claim);
  return { relatedPredictions, failedPredictions, latestFailureAt,
    repeatedFailure: failedPredictions.length >= 2,
    hasSupportedRevision,
    failedHypothesis: failedPredictions.length > 0 && !hasSupportedRevision,
    freshEvidenceRefs };
}
module.exports = { claimsRelated, getClaimFeedback, isExternalEvidenceRef };
