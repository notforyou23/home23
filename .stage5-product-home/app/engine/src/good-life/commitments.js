'use strict';

const fs = require('fs');
const path = require('path');

const COMMITMENTS = Object.freeze([
  { id: 'useful-output', lane: 'usefulness', title: 'Produce jtr-visible progress' },
  { id: 'continuity', lane: 'continuity', title: 'Preserve continuity across sessions and cycles' },
  { id: 'recovery', lane: 'recovery', title: 'Recover without losing obligations' },
  { id: 'development', lane: 'development', title: 'Learn from grounded evidence' },
  { id: 'low-friction', lane: 'friction', title: 'Keep maintenance from dominating the day' },
  { id: 'viability', lane: 'viability', title: 'Keep the Home23 engine viable and evidenced' },
]);

class GoodLifeCommitments {
  constructor(opts = {}) {
    if (!opts.brainDir) throw new Error('GoodLifeCommitments requires brainDir');
    this.path = path.join(opts.brainDir, 'good-life-commitments.json');
    this.logger = opts.logger || console;
  }

  update(evaluation) {
    const now = evaluation?.evaluatedAt || new Date().toISOString();
    const lanes = evaluation?.lanes || {};
    const commitments = COMMITMENTS.map((c) => {
      const lane = lanes[c.lane] || { status: 'unknown', reasons: [] };
      return {
        ...c,
        status: lane.status || 'unknown',
        reasons: Array.isArray(lane.reasons) ? lane.reasons : [],
        lastEvaluatedAt: now,
        active: lane.status !== 'healthy',
      };
    });
    const doc = {
      schema: 'home23.good-life.commitments.v1',
      updatedAt: now,
      policy: evaluation?.policy || null,
      commitments,
    };
    try {
      fs.writeFileSync(this.path, JSON.stringify(doc, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn?.('[good-life] commitments write failed:', err?.message || err);
    }
    return doc;
  }
}

module.exports = { GoodLifeCommitments, COMMITMENTS };
