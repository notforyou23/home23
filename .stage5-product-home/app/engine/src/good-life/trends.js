'use strict';

const fs = require('fs');
const path = require('path');

const LANE_ORDER = ['viability', 'continuity', 'usefulness', 'development', 'coherence', 'friction', 'recovery'];

class GoodLifeTrends {
  constructor(opts = {}) {
    if (!opts.brainDir) throw new Error('GoodLifeTrends requires brainDir');
    this.trendsPath = path.join(opts.brainDir, 'good-life-trends.jsonl');
    this.currentPath = path.join(opts.brainDir, 'good-life-trends-current.json');
    this.logger = opts.logger || console;
  }

  append(evaluation) {
    const row = compactTrend(evaluation);
    try {
      fs.appendFileSync(this.trendsPath, JSON.stringify(row) + '\n', 'utf8');
      fs.writeFileSync(this.currentPath, JSON.stringify({
        schema: 'home23.good-life.trends.v1',
        updatedAt: row.at,
        latest: row,
        window: this._window(48),
      }, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn?.('[good-life] trend write failed:', err?.message || err);
    }
    return row;
  }

  _window(limit) {
    const rows = tailJsonl(this.trendsPath, limit);
    const counts = {};
    for (const lane of LANE_ORDER) counts[lane] = { healthy: 0, watch: 0, strained: 0, critical: 0, unknown: 0 };
    for (const row of rows) {
      for (const lane of LANE_ORDER) {
        const status = row.lanes?.[lane] || 'unknown';
        counts[lane][counts[lane][status] == null ? 'unknown' : status]++;
      }
    }
    return {
      samples: rows.length,
      lanes: counts,
      policies: countBy(rows.map(r => r.policy)),
      latestUsefulOutputAt: rows.slice().reverse().find(r => r.metrics?.lastUsefulOutputAt)?.metrics?.lastUsefulOutputAt || null,
    };
  }
}

function compactTrend(evaluation = {}) {
  const evidence = evaluation.evidence || {};
  const lanes = {};
  for (const lane of LANE_ORDER) lanes[lane] = evaluation.lanes?.[lane]?.status || 'unknown';
  return {
    at: evaluation.evaluatedAt || new Date().toISOString(),
    policy: evaluation.policy?.mode || 'observe',
    lanes,
    metrics: {
      openLiveProblems: Number(evidence.liveProblems?.open || 0),
      openGoals: Number(evidence.goals?.open || 0),
      pendingAgenda: Number(evidence.agenda?.pending || 0),
      maintenanceRatio: Number(evaluation.evidence?.actions?.maintenanceRatio || 0),
      lastUsefulOutputAt: evidence.publish?.lastUsefulOutputAt || null,
    },
  };
}

function tailJsonl(file, limit) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function countBy(values) {
  const out = {};
  for (const value of values) out[value || 'unknown'] = (out[value || 'unknown'] || 0) + 1;
  return out;
}

module.exports = { GoodLifeTrends, compactTrend };
