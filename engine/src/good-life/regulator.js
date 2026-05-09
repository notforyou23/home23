'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTO_ACT_MODES = new Set(['repair', 'recover', 'help']);
const DEFAULT_THROTTLE_MS = 60 * 60 * 1000;
const MAX_DAILY_SELF_MAINTENANCE_ACTIONS = 4;

class GoodLifeRegulator {
  constructor(opts = {}) {
    if (!opts.brainDir) throw new Error('GoodLifeRegulator requires brainDir');
    this.brainDir = opts.brainDir;
    this.logger = opts.logger || console;
    this.getAgendaStore = typeof opts.getAgendaStore === 'function' ? opts.getAgendaStore : (() => null);
    this.getMotorCortex = typeof opts.getMotorCortex === 'function' ? opts.getMotorCortex : (() => null);
    this.throttleMs = Number(opts.throttleMs || DEFAULT_THROTTLE_MS);
    this.statePath = path.join(this.brainDir, 'good-life-regulator-state.json');
    this.agendaPath = path.join(this.brainDir, 'agenda.jsonl');
  }

  async handleObservation(obs) {
    if (!obs || obs.channelId !== 'domain.good-life' || !obs.payload?.policy?.actionCard) {
      return { status: 'ignored' };
    }

    const evaluation = obs.payload;
    const agenda = this._agendaFromEvaluation(evaluation);
    if (!agenda) return { status: 'ignored' };
    const usefulness = this._usefulnessContract(evaluation, agenda);
    if (!usefulness.passes) return { status: 'blocked_usefulness_gate', reason: usefulness.reason };

    const key = this._actionKey(evaluation);
    const state = this._readState();
    const last = state[key];
    const nowMs = Date.now();
    if (last?.at && nowMs - Date.parse(last.at) < this.throttleMs) {
      return { status: 'throttled', key };
    }
    if (this._selfMaintenanceBudgetExceeded(state, evaluation, usefulness)) {
      return { status: 'blocked_self_maintenance_budget', key };
    }

    const agendaStore = this.getAgendaStore();
    let record = null;
    if (agendaStore?.add) {
      record = agendaStore.add({
        sourceThoughtId: obs.traceId || obs.sourceRef || null,
        sourceCycleSessionId: `good-life:${evaluation.evaluatedAt || new Date().toISOString()}`,
        content: agenda.content,
        kind: agenda.kind,
        topicTags: agenda.topicTags,
        sourceSignal: 'good-life',
        temporalContext: {
          evaluatedAt: evaluation.evaluatedAt || null,
          summary: evaluation.summary || null,
          policy: evaluation.policy?.mode || null,
          lanes: agenda.lanes,
          usefulnessContract: usefulness,
        },
      });
    } else {
      record = this._appendAgendaEvent(obs, agenda, evaluation);
    }

    if (!record) return { status: 'rejected', key };
    this._writeState({
      ...state,
      [key]: {
        at: new Date().toISOString(),
        agendaId: record.id,
        mode: evaluation.policy.mode,
        summary: evaluation.summary,
        usefulnessContract: usefulness,
      },
      daily: this._nextDailyState(state.daily, evaluation, usefulness, record.id),
    });

    const shouldAct = AUTO_ACT_MODES.has(evaluation.policy.mode)
      && evaluation.policy.actionCard.evidenceRequired
      && evaluation.policy.actionCard.riskTier <= 1
      && !['acted_on', 'discarded'].includes(record.status);
    if (!shouldAct) return { status: 'queued', key, agendaId: record.id };

    const motor = this.getMotorCortex();
    if (!motor?.actOnAgendaItem) {
      return { status: 'queued_no_motor', key, agendaId: record.id };
    }

    const action = await motor.actOnAgendaItem(record, {
      actor: 'good-life-regulator',
      origin: 'good-life',
      goodLife: evaluation.policy.actionCard,
    });
    return {
      status: action?.status === 'acted' ? 'acted' : 'queued',
      key,
      agendaId: record.id,
      action,
    };
  }

  _agendaFromEvaluation(evaluation) {
    const mode = evaluation.policy?.mode || 'observe';
    const lanes = Object.entries(evaluation.lanes || {})
      .filter(([, v]) => v?.status && v.status !== 'healthy')
      .map(([name, v]) => `${name}:${v.status}`);
    const laneText = lanes.length ? lanes.join(', ') : 'development:watch';
    const base = 'using instances/jerry/brain/good-life-state.json, instances/jerry/brain/good-life-ledger.jsonl, and engine logs';

    let content = null;
    if (mode === 'repair') {
      content = `Diagnose Good Life repair drift ${base}; restore verified Home23 engine evidence and clear the failing lane(s): ${laneText}.`;
    } else if (mode === 'recover') {
      content = `Diagnose Good Life recovery drift ${base}; clear crash recovery, reduce maintenance ratio, and return the autonomous loop to useful jtr-visible work.`;
    } else if (mode === 'help') {
      content = `Diagnose Good Life usefulness drift ${base}; route one bounded Home23 action that produces jtr-visible progress.`;
    } else if (mode === 'learn') {
      content = `Investigate Good Life learning progress ${base}; crystallize one grounded finding or discard the thread with evidence.`;
    } else if (mode === 'rest') {
      content = `Diagnose Good Life friction drift ${base}; reduce loop pressure without losing active obligations.`;
    } else if (mode === 'ask') {
      content = `Determine the blocked Good Life decision ${base}; surface one concrete missing preference only if it changes the next Home23 action.`;
    } else {
      return null;
    }

    return {
      content,
      kind: mode === 'ask' ? 'question' : 'idea',
      topicTags: ['good-life', `good-life:${mode}`, ...lanes.map(l => `good-life:${l.replace(':', '-')}`)],
      lanes,
    };
  }

  _appendAgendaEvent(obs, agenda, evaluation) {
    const now = new Date().toISOString();
    const staledPrior = this._stalePriorGoodLifeAgenda(now);
    const id = `ag-gl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      id,
      content: agenda.content,
      kind: agenda.kind,
      topicTags: agenda.topicTags,
      sourceThoughtId: obs.traceId || obs.sourceRef || null,
      sourceCycleSessionId: `good-life:${evaluation.evaluatedAt || now}`,
      sourceSignal: 'good-life',
      referencedNodes: [],
      temporalContext: {
        evaluatedAt: evaluation.evaluatedAt || null,
        summary: evaluation.summary || null,
        policy: evaluation.policy?.mode || null,
        lanes: agenda.lanes,
        usefulnessContract: this._usefulnessContract(evaluation, agenda),
      },
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      seenCount: 1,
      status: 'candidate',
      history: [{
        status: 'candidate',
        at: now,
        note: staledPrior > 0
          ? `created by Good Life regulator after staling ${staledPrior} prior Good Life item(s)`
          : 'created by Good Life regulator',
      }],
    };
    fs.appendFileSync(this.agendaPath, JSON.stringify({ type: 'add', id, record }) + '\n', 'utf8');
    return record;
  }

  _stalePriorGoodLifeAgenda(now = new Date().toISOString()) {
    try {
      if (!fs.existsSync(this.agendaPath)) return 0;
      const items = new Map();
      const lines = fs.readFileSync(this.agendaPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let row = null;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.type === 'add' && row.id) {
          const record = row.record || {};
          items.set(row.id, {
            id: row.id,
            status: record.status || row.status || 'candidate',
            sourceSignal: record.sourceSignal || row.sourceSignal || null,
            topicTags: Array.isArray(record.topicTags) ? record.topicTags : [],
          });
        } else if (row.type === 'status' && row.id) {
          const rec = items.get(row.id) || { id: row.id };
          rec.status = row.status || rec.status || 'candidate';
          items.set(row.id, rec);
        }
      }

      const active = new Set(['candidate', 'surfaced', 'acknowledged']);
      const staleRows = [];
      for (const item of items.values()) {
        const isGoodLife = item.sourceSignal === 'good-life' || item.topicTags.includes('good-life');
        if (isGoodLife && active.has(item.status)) {
          staleRows.push({
            type: 'status',
            id: item.id,
            status: 'stale',
            at: now,
            note: 'superseded by newer Good Life regulator action',
            actor: 'good-life-regulator',
          });
        }
      }
      if (staleRows.length > 0) {
        fs.appendFileSync(this.agendaPath, staleRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
      }
      return staleRows.length;
    } catch (err) {
      this.logger.warn?.('[good-life] agenda stale sweep failed:', err?.message || err);
      return 0;
    }
  }

  _usefulnessContract(evaluation, agenda) {
    const mode = evaluation.policy?.mode || 'observe';
    const text = String(agenda?.content || '').toLowerCase();
    if (mode === 'repair') return { passes: true, category: 'resolves-drift', reason: 'repair clears verified viability drift' };
    if (mode === 'recover') return { passes: true, category: 'restores-usefulness', reason: 'recover returns loop to useful jtr-visible work' };
    if (mode === 'help') return { passes: true, category: 'visible-progress', reason: 'help produces jtr-visible progress' };
    if (mode === 'learn' && /\b(crystallize|grounded|evidence|discard)\b/.test(text)) {
      return { passes: true, category: 'grounded-learning', reason: 'learning has an evidence/discard stop condition' };
    }
    if (mode === 'rest' && /\bwithout losing active obligations\b/.test(text)) {
      return { passes: true, category: 'reduces-friction', reason: 'rest lowers loop pressure while preserving obligations' };
    }
    return { passes: false, category: 'churn', reason: `mode ${mode} lacks a usefulness contract` };
  }

  _selfMaintenanceBudgetExceeded(state, evaluation, usefulness) {
    const mode = evaluation.policy?.mode || 'observe';
    if (mode === 'repair' || usefulness.category === 'visible-progress') return false;
    if (evaluation.lanes?.viability?.status === 'critical') return false;
    const daily = this._currentDailyState(state.daily);
    return daily.selfMaintenanceActions >= MAX_DAILY_SELF_MAINTENANCE_ACTIONS;
  }

  _nextDailyState(existing, evaluation, usefulness, agendaId) {
    const daily = this._currentDailyState(existing);
    if (usefulness?.category !== 'visible-progress') daily.selfMaintenanceActions++;
    daily.actions.push({
      at: new Date().toISOString(),
      agendaId,
      mode: evaluation.policy?.mode || 'observe',
      category: usefulness?.category || 'unknown',
    });
    daily.actions = daily.actions.slice(-50);
    return daily;
  }

  _currentDailyState(existing) {
    const today = new Date().toISOString().slice(0, 10);
    if (!existing || existing.date !== today) {
      return { date: today, selfMaintenanceActions: 0, actions: [] };
    }
    return {
      date: existing.date,
      selfMaintenanceActions: Number(existing.selfMaintenanceActions || 0),
      actions: Array.isArray(existing.actions) ? existing.actions : [],
    };
  }

  _actionKey(evaluation) {
    const mode = evaluation.policy?.mode || 'observe';
    const lanes = Object.entries(evaluation.lanes || {})
      .filter(([, v]) => v?.status && v.status !== 'healthy')
      .map(([name, v]) => `${name}:${v.status}`)
      .sort()
      .join('|');
    return `${mode}:${lanes || 'steady'}`;
  }

  _readState() {
    try {
      if (!fs.existsSync(this.statePath)) return {};
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _writeState(state) {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn?.('[good-life] regulator state write failed:', err?.message || err);
    }
  }
}

module.exports = { GoodLifeRegulator };
