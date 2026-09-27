'use strict';

const { createHash } = require('node:crypto');
const legacyId = (prefix, cellId, claim) => `${prefix}_${createHash('sha256').update(`${cellId}:${claim}`, 'utf8').digest('hex').slice(0, 16)}`;

/** Read-only feedback projection between checkpoints. Interpret accepted
 * receipts, never rerun admission or write/replay the resident's live Seed.
 * Legacy ID collisions keep their original first-match resolution semantics;
 * versioned receipts identify the precise admitted occurrence. */
function projectFeedbackState(checkpoint, tail) {
  const cells = checkpoint.cells.map(cell => ({ ...cell,
    predictions: (cell.predictions || []).map(p => ({ ...p })),
    estimates: (cell.estimates || []).map(e => ({ ...e })),
    intentions: (cell.intentions || []).map(i => ({ ...i })),
  }));
  const records = tail.filter(record => Number.isInteger(record.seq) && record.seq > checkpoint.ledgerSeq);
  const complete = records.every((record, index) => record.seq === checkpoint.ledgerSeq + index + 1);
  const throughSeq = records.at(-1)?.seq ?? checkpoint.ledgerSeq;
  const feedbackView = { complete, checkpointSeq: checkpoint.ledgerSeq, throughSeq };
  if (!complete) {
    // Missing records can include a correction. Keep historical verdicts but
    // do not pass stale open expectations or estimates off as current state.
    for (const cell of cells) {
      cell.predictions = cell.predictions.filter(p => p.resolvedAt !== undefined);
      cell.estimates = [];
      cell.intentions = cell.intentions.filter(i => !i.open);
    }
    return { ...checkpoint, cells, feedbackView };
  }
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  for (const record of records) {
    if (record.seq <= checkpoint.ledgerSeq || record.category !== 'lobe') continue;
    const asOf = record.payload?.asOf || record.issuedAt;
    if (typeof asOf !== 'string') continue;
    for (const delta of Array.isArray(record.payload?.appliedDeltas) ? record.payload.appliedDeltas : []) {
      const cell = byId.get(delta?.cellId);
      const body = delta?.delta;
      if (!cell || !body || typeof body !== 'object') continue;
      if (delta.field === 'predictions.append' && typeof body.claim === 'string' && typeof body.confidence === 'number') {
        const predictionId = body.feedbackVersion === 1 && typeof body.predictionId === 'string'
          ? body.predictionId : legacyId('pred', cell.id, body.claim);
        cell.predictions.push({ ...body, predictionId, createdAt: asOf });
        cell.predictions = cell.predictions.slice(-32);
      } else if (delta.field === 'predictions.resolve') {
        const matches = p => p?.predictionId === body.predictionId && p.createdAt === body.predictionCreatedAt;
        const index = body.feedbackVersion !== 1
          ? cell.predictions.findIndex(p => p.predictionId === body.predictionId)
          : Number.isInteger(body.predictionIndex)
            ? (matches(cell.predictions[body.predictionIndex]) ? body.predictionIndex : -1)
            : cell.predictions.findIndex(matches);
        if (index >= 0) cell.predictions[index] = { ...cell.predictions[index], resolvedAt: asOf, error: body.error };
      } else if (delta.field === 'intentions.append' && typeof body.description === 'string') {
        const tensionId = body.feedbackVersion === 1 && typeof body.tensionId === 'string'
          ? body.tensionId : legacyId('tension', cell.id, body.description);
        cell.intentions.push({ ...body, tensionId, createdAt: asOf, consequenceRefs: [], open: true });
        cell.intentions = cell.intentions.slice(-16);
      } else if (delta.field === 'intentions.resolve') {
        const index = cell.intentions.findIndex(i => i.tensionId === body.tensionId && i.open);
        if (index >= 0) cell.intentions[index] = { ...cell.intentions[index], open: false, closedAt: asOf, resolutionReason: body.reason };
      } else if (delta.field === 'estimates.append' && typeof body.claim === 'string' && typeof body.confidence === 'number') {
        cell.estimates.push({ ...body, estimateId: legacyId('est', cell.id, body.claim), createdAt: asOf });
        cell.estimates = cell.estimates.slice(-32);
      }
    }
  }
  return { ...checkpoint, cells, ledgerSeq: throughSeq, feedbackView };
}

module.exports = { projectFeedbackState };
