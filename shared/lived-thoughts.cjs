'use strict';

/** Receipt-backed thought history. A recorded interpretation is something the
 * resident considered, not external evidence and not an action or commitment. */
function thoughtsFromReceipt(record) {
  if (record?.category !== 'lobe') return [];
  const thoughts = [];
  const payload = record.payload || {};
  const asOf = payload.asOf || record.issuedAt;
  for (const delta of Array.isArray(payload.appliedDeltas) ? payload.appliedDeltas : []) {
    if (!['estimates.append', 'predictions.append'].includes(delta?.field)
        || typeof delta.delta?.claim !== 'string') continue;
    thoughts.push({ cellId: delta.cellId, kind: delta.field === 'predictions.append' ? 'prediction' : 'estimate',
      text: delta.delta.claim, candidate: { ...delta.delta, createdAt: asOf }, seq: record.seq, asOf });
  }
  if (payload.advisory?.version === 1) {
    for (const [key, kind, textKey] of [['observations', 'observation', 'claim'], ['interpretations', 'reflection', 'interpretation']]) {
      for (const item of Array.isArray(payload.advisory[key]) ? payload.advisory[key] : []) {
        if (typeof item?.cellId !== 'string' || typeof item[textKey] !== 'string' || !item[textKey].trim()) continue;
        if (thoughts.some(thought => thought.cellId === item.cellId && thought.text === item[textKey])) continue;
        thoughts.push({ cellId: item.cellId, kind, text: item[textKey], candidate: { claim: item[textKey], createdAt: asOf },
          seq: record.seq, asOf });
      }
    }
  }
  return thoughts;
}

module.exports = { thoughtsFromReceipt };
