'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTO_ACT_MODES = new Set(['repair', 'recover', 'help']);
const DEFAULT_THROTTLE_MS = 60 * 60 * 1000;
const MAX_DAILY_SELF_MAINTENANCE_ACTIONS = 4;
const SELF_MAINTENANCE_DAILY_LIMIT = MAX_DAILY_SELF_MAINTENANCE_ACTIONS;

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

    const agendaStore = this.getAgendaStore();
    const cleanupAt = new Date().toISOString();
    const staledSupersededRepair = agendaStore
      ? this._staleSupersededRepairAgendaStore(agendaStore, evaluation, cleanupAt)
      : this._staleSupersededRepairAgenda(evaluation, cleanupAt);
    const staledSupersededDrift = agendaStore
      ? this._staleSupersededDriftAgendaStore(agendaStore, evaluation, cleanupAt)
      : this._staleSupersededDriftAgenda(evaluation, cleanupAt);

    const key = this._actionKey(evaluation);
    const state = this._readState();
    const last = state[key];
    const nowMs = Date.now();
    if (last?.at && nowMs - Date.parse(last.at) < this.throttleMs) {
      return { status: 'throttled', key, staledSupersededRepair, staledSupersededDrift };
    }
    if (this._selfMaintenanceBudgetExceeded(state, evaluation, usefulness)) {
      return { status: 'blocked_self_maintenance_budget', key, staledSupersededRepair, staledSupersededDrift };
    }

    let record = null;
    if (agendaStore?.add) {
      const now = new Date().toISOString();
      const staledPrior = this._stalePriorGoodLifeAgendaStore(agendaStore, now);
      record = agendaStore.add({
        sourceThoughtId: obs.traceId || obs.sourceRef || null,
        sourceCycleSessionId: `good-life:${evaluation.evaluatedAt || now}`,
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
          workerRoute: agenda.workerRoute,
          staledPriorGoodLifeAgenda: staledPrior,
          staledSupersededRepairAgenda: staledSupersededRepair,
          staledSupersededDriftAgenda: staledSupersededDrift,
        },
      });
    } else {
      record = this._appendAgendaEvent(obs, agenda, evaluation, { staledSupersededRepair, staledSupersededDrift });
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
        workerRoute: agenda.workerRoute,
        staledSupersededRepairAgenda: staledSupersededRepair,
        staledSupersededDriftAgenda: staledSupersededDrift,
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
    const base = this._evidenceBaseText();

    const workerRoute = this._workerRouteForEvaluation(evaluation, lanes);
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

    if (workerRoute) {
      content = `${content} Recommended worker: ${workerRoute.worker} (${workerRoute.reason}).`;
    }

    return {
      content,
      kind: mode === 'ask' ? 'question' : 'idea',
      topicTags: [
        'good-life',
        `good-life:${mode}`,
        ...lanes.map(l => `good-life:${l.replace(':', '-')}`),
        ...(workerRoute ? [`worker:${workerRoute.worker}`] : []),
      ],
      lanes,
      workerRoute,
    };
  }

  _workerRouteForEvaluation(evaluation, lanes = []) {
    const mode = evaluation?.policy?.mode || 'observe';
    if (mode === 'learn') {
      return {
        worker: 'freshness',
        reason: 'learning progress needs freshness and visible-output evidence',
      };
    }
    if (!AUTO_ACT_MODES.has(mode) && mode !== 'rest') return null;

    const laneText = lanes.join('|').toLowerCase();
    const has = (pattern) => pattern.test(laneText);
    if (has(/viability:critical|recovery:critical|friction:critical|friction:strained/)) {
      return {
        worker: 'systems',
        reason: 'system viability, recovery, and friction drift need host/process evidence',
      };
    }
    if (has(/continuity:critical|continuity:strained|coherence:critical|coherence:strained/)) {
      return {
        worker: 'memory',
        reason: 'continuity and coherence drift need memory, agenda, and receipt inspection',
      };
    }
    if (has(/usefulness:critical|usefulness:strained|usefulness:watch|development:critical|development:strained/)) {
      return {
        worker: 'freshness',
        reason: 'usefulness or development drift needs freshness and visible-output evidence',
      };
    }
    if (mode === 'recover' || mode === 'repair') {
      return {
        worker: 'systems',
        reason: `${mode} policy defaults to systems evidence when no narrower lane owns it`,
      };
    }
    if (mode === 'help') {
      return {
        worker: 'freshness',
        reason: 'help policy needs a bounded evidence check before claiming visible progress',
      };
    }
    return null;
  }

  _evidenceBaseText() {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const relativeBrainDir = path.relative(repoRoot, this.brainDir);
    const brainDir = relativeBrainDir && !relativeBrainDir.startsWith('..') && !path.isAbsolute(relativeBrainDir)
      ? relativeBrainDir
      : this.brainDir;
    return `using ${path.join(brainDir, 'good-life-state.json')}, ${path.join(brainDir, 'good-life-ledger.jsonl')}, and engine logs`;
  }

  _appendAgendaEvent(obs, agenda, evaluation, opts = {}) {
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
        workerRoute: agenda.workerRoute,
        staledSupersededRepairAgenda: opts.staledSupersededRepair || 0,
        staledSupersededDriftAgenda: opts.staledSupersededDrift || 0,
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

  _staleSupersededRepairAgenda(evaluation, now = new Date().toISOString()) {
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
            content: record.content || row.content || '',
            sourceSignal: record.sourceSignal || row.sourceSignal || null,
            topicTags: Array.isArray(record.topicTags) ? record.topicTags : [],
            temporalContext: record.temporalContext || row.temporalContext || null,
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
        if (!active.has(item.status)) continue;
        if (!this._isSupersededRepairAgenda(item, evaluation)) continue;
        staleRows.push({
          type: 'status',
          id: item.id,
          status: 'stale',
          at: now,
          note: 'superseded by current Good Life state with no open live problems',
          actor: 'good-life-regulator',
        });
      }
      if (staleRows.length > 0) {
        fs.appendFileSync(this.agendaPath, staleRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
      }
      return staleRows.length;
    } catch (err) {
      this.logger.warn?.('[good-life] superseded repair agenda stale sweep failed:', err?.message || err);
      return 0;
    }
  }

  _staleSupersededDriftAgenda(evaluation, now = new Date().toISOString()) {
    try {
      if (!fs.existsSync(this.agendaPath)) return 0;
      const items = this._readGoodLifeAgendaItemsFromFile();
      const staleRows = [];
      for (const item of items.values()) {
        if (!this._isSupersededDriftAgenda(item, evaluation)) continue;
        staleRows.push({
          type: 'status',
          id: item.id,
          status: 'stale',
          at: now,
          note: 'superseded by current Good Life state with cleared drift lanes',
          actor: 'good-life-regulator',
        });
      }
      if (staleRows.length > 0) {
        fs.appendFileSync(this.agendaPath, staleRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
      }
      return staleRows.length;
    } catch (err) {
      this.logger.warn?.('[good-life] superseded drift agenda stale sweep failed:', err?.message || err);
      return 0;
    }
  }

  _stalePriorGoodLifeAgendaStore(agendaStore, now = new Date().toISOString()) {
    try {
      if (!agendaStore?.list || !agendaStore?.updateStatus) return 0;
      const rows = agendaStore.list({ status: ['candidate', 'surfaced', 'acknowledged'], limit: 200 }) || [];
      let staled = 0;
      for (const row of rows) {
        const tags = Array.isArray(row.topicTags) ? row.topicTags : [];
        const isGoodLife = row.sourceSignal === 'good-life' || tags.includes('good-life');
        if (!isGoodLife || !row.id) continue;
        const updated = agendaStore.updateStatus(row.id, 'stale', {
          actor: 'good-life-regulator',
          note: 'superseded by newer Good Life regulator action',
          at: now,
          skipReconcile: true,
        });
        if (updated) staled += 1;
      }
      return staled;
    } catch (err) {
      this.logger.warn?.('[good-life] agenda-store stale sweep failed:', err?.message || err);
      return 0;
    }
  }

  _staleSupersededRepairAgendaStore(agendaStore, evaluation, now = new Date().toISOString()) {
    try {
      if (!agendaStore?.list || !agendaStore?.updateStatus) return 0;
      const rows = agendaStore.list({ status: ['candidate', 'surfaced', 'acknowledged'], limit: 200 }) || [];
      let staled = 0;
      for (const row of rows) {
        if (!row?.id || !this._isSupersededRepairAgenda(row, evaluation)) continue;
        const updated = agendaStore.updateStatus(row.id, 'stale', {
          actor: 'good-life-regulator',
          note: 'superseded by current Good Life state with no open live problems',
          at: now,
          skipReconcile: true,
        });
        if (updated) staled += 1;
      }
      return staled;
    } catch (err) {
      this.logger.warn?.('[good-life] superseded repair agenda-store stale sweep failed:', err?.message || err);
      return 0;
    }
  }

  _staleSupersededDriftAgendaStore(agendaStore, evaluation, now = new Date().toISOString()) {
    try {
      if (!agendaStore?.list || !agendaStore?.updateStatus) return 0;
      const rows = agendaStore.list({ status: ['candidate', 'surfaced', 'acknowledged'], limit: 200 }) || [];
      let staled = 0;
      for (const row of rows) {
        if (!row?.id || !this._isSupersededDriftAgenda(row, evaluation)) continue;
        const updated = agendaStore.updateStatus(row.id, 'stale', {
          actor: 'good-life-regulator',
          note: 'superseded by current Good Life state with cleared drift lanes',
          at: now,
          skipReconcile: true,
        });
        if (updated) staled += 1;
      }
      return staled;
    } catch (err) {
      this.logger.warn?.('[good-life] superseded drift agenda-store stale sweep failed:', err?.message || err);
      return 0;
    }
  }

  _readGoodLifeAgendaItemsFromFile() {
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
          content: record.content || row.content || '',
          sourceSignal: record.sourceSignal || row.sourceSignal || null,
          topicTags: Array.isArray(record.topicTags) ? record.topicTags : [],
          temporalContext: record.temporalContext || row.temporalContext || null,
        });
      } else if (row.type === 'status' && row.id) {
        const rec = items.get(row.id) || { id: row.id };
        rec.status = row.status || rec.status || 'candidate';
        rec.updatedAt = row.at || rec.updatedAt || null;
        items.set(row.id, rec);
      }
    }
    return items;
  }

  _isSupersededRepairAgenda(row = {}, evaluation = {}) {
    const mode = String(evaluation?.policy?.mode || '').toLowerCase();
    if (mode === 'repair' || mode === 'recover') return false;
    const live = evaluation?.evidence?.liveProblems || {};
    const activeProblems = Number(live.open || 0) + Number(live.chronic || 0);
    if (activeProblems > 0) return false;

    const tags = Array.isArray(row.topicTags) ? row.topicTags.map((tag) => String(tag || '').toLowerCase()) : [];
    const sourceSignal = String(row.sourceSignal || '').toLowerCase();
    const isGoodLife = sourceSignal === 'good-life' || tags.some((tag) => tag === 'good-life' || tag.startsWith('good-life:'));
    if (!isGoodLife) return false;

    const rowPolicy = String(row.temporalContext?.policy || row.policy || '').toLowerCase();
    if (rowPolicy === 'repair' || rowPolicy === 'recover') return true;
    return tags.includes('good-life:repair') || tags.includes('good-life:recover')
      || /\bGood Life (repair|recovery) drift\b/i.test(String(row.content || ''));
  }

  _isSupersededDriftAgenda(row = {}, evaluation = {}) {
    const mode = String(evaluation?.policy?.mode || '').toLowerCase();
    if (mode !== 'learn' && mode !== 'observe') return false;
    const live = evaluation?.evidence?.liveProblems || {};
    const activeProblems = Number(live.open || 0) + Number(live.chronic || 0);
    if (activeProblems > 0) return false;

    const active = new Set(['candidate', 'surfaced', 'acknowledged']);
    if (!active.has(String(row.status || 'candidate').toLowerCase())) return false;

    const unhealthyLanes = new Set(Object.entries(evaluation?.lanes || {})
      .filter(([, lane]) => lane?.status && lane.status !== 'healthy')
      .map(([name]) => name));
    const tags = Array.isArray(row.topicTags) ? row.topicTags.map((tag) => String(tag || '').toLowerCase()) : [];
    const sourceSignal = String(row.sourceSignal || '').toLowerCase();
    const isGoodLife = sourceSignal === 'good-life' || tags.some((tag) => tag === 'good-life' || tag.startsWith('good-life:'));
    if (!isGoodLife) return false;

    const rowPolicy = String(row.temporalContext?.policy || row.policy || '').toLowerCase();
    if (!['help', 'rest'].includes(rowPolicy)) return false;

    const rowLanes = Array.isArray(row.temporalContext?.lanes) ? row.temporalContext.lanes : [];
    const driftLanes = rowLanes
      .map((lane) => String(lane || '').split(':')[0])
      .filter((lane) => lane && lane !== 'usefulness' && lane !== 'recovery');
    if (driftLanes.length === 0) return rowPolicy === 'rest';
    return driftLanes.every((lane) => !unhealthyLanes.has(lane));
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

  _actionCountsAgainstSelfMaintenanceBudget(action = {}) {
    const mode = String(action.mode || '').toLowerCase();
    const category = String(action.category || '').toLowerCase();
    if (mode === 'repair' || category === 'resolves-drift') return false;
    if (mode === 'help' || category === 'visible-progress') return false;
    return true;
  }

  _nextDailyState(existing, evaluation, usefulness, agendaId) {
    const daily = this._currentDailyState(existing);
    const action = {
      at: new Date().toISOString(),
      agendaId,
      mode: evaluation.policy?.mode || 'observe',
      category: usefulness?.category || 'unknown',
    };
    action.budgetedSelfMaintenance = this._actionCountsAgainstSelfMaintenanceBudget(action);
    if (action.budgetedSelfMaintenance) daily.selfMaintenanceActions++;
    daily.actions.push(action);
    daily.actions = daily.actions.slice(-50);
    return daily;
  }

  _currentDailyState(existing) {
    const today = new Date().toISOString().slice(0, 10);
    if (!existing || existing.date !== today) {
      return { date: today, selfMaintenanceActions: 0, actions: [] };
    }
    const actions = Array.isArray(existing.actions) ? existing.actions : [];
    const todayActions = actions.filter((action) => {
      const at = String(action?.at || '');
      return !at || at.slice(0, 10) === today;
    });
    const derivedSelfMaintenanceActions = todayActions.filter((action) => (
      action.budgetedSelfMaintenance === false
        ? false
        : this._actionCountsAgainstSelfMaintenanceBudget(action)
    )).length;
    return {
      date: existing.date,
      selfMaintenanceActions: actions.length ? derivedSelfMaintenanceActions : Number(existing.selfMaintenanceActions || 0),
      actions,
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

module.exports = { GoodLifeRegulator, SELF_MAINTENANCE_DAILY_LIMIT };
