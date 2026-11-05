'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  GOAL_STATUSES,
  DEFAULT_WIP_ACTIVE_MAX,
  SCHEMA_GOAL,
  SCHEMA_ACTION,
  SCHEMA_OPERATOR_INTENT,
  SCHEMA_EVENT,
  SCHEMA_BELIEF_DELTA,
} = require('./schemas');

class OsKernelStore {
  constructor({ brainDir, wipActiveMax = DEFAULT_WIP_ACTIVE_MAX }) {
    this.brainDir = brainDir;
    this.wipActiveMax = wipActiveMax;
    this.kernelDir = path.join(brainDir, 'os-kernel');
    this.paths = {
      goals: path.join(this.kernelDir, 'goals.json'),
      actions: path.join(this.kernelDir, 'actions.json'),
      intents: path.join(this.kernelDir, 'operator-intents.json'),
      events: path.join(this.kernelDir, 'events.jsonl'),
      beliefDeltas: path.join(this.kernelDir, 'belief-deltas.jsonl'),
    };
    this._mtimes = { goals: 0, actions: 0, intents: 0 };
    this._goals = [];
    this._actions = [];
    this._intents = [];
    this._ensureDir();
    this._loadJson('goals', 'goals', this._goals, { failClosed: true });
    this._loadJson('actions', 'actions', this._actions);
    this._loadJson('intents', 'intents', this._intents);
  }

  _ensureDir() {
    fs.mkdirSync(this.kernelDir, { recursive: true });
  }

  _fileMtimeMs(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  _loadJson(key, arrayKey, target, { failClosed = false } = {}) {
    const filePath = this.paths[key];
    this._mtimes[key] = this._fileMtimeMs(filePath);
    if (!fs.existsSync(filePath)) return;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if (failClosed) {
        throw new Error(`[os-kernel] corrupt ${path.basename(filePath)}: ${err.message}`);
      }
      const quarantined = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, quarantined);
      console.warn(`[os-kernel] quarantined corrupt ${path.basename(filePath)} → ${quarantined}`);
      return;
    }

    target.splice(0, target.length, ...(raw[arrayKey] || []));
  }

  /**
   * Reload goals/actions/intents from disk if any file's mtime has moved
   * since our last load or save. Guards against cross-process drift when
   * a long-lived store instance (engine) and short-lived instances
   * (dashboard API reads) both touch the same brainDir. Cheap (a stat per
   * file) so it's safe to call at the top of every public method.
   */
  reloadIfChanged() {
    const specs = [
      ['goals', 'goals', this._goals, { failClosed: true }],
      ['actions', 'actions', this._actions, {}],
      ['intents', 'intents', this._intents, {}],
    ];
    let changed = false;
    for (const [key, arrayKey, target, opts] of specs) {
      const current = this._fileMtimeMs(this.paths[key]);
      if (current !== this._mtimes[key]) {
        this._loadJson(key, arrayKey, target, opts);
        changed = true;
      }
    }
    return changed;
  }

  _writeJson(key, payload) {
    const filePath = this.paths[key];
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
    this._mtimes[key] = this._fileMtimeMs(filePath);
  }

  _saveGoals() {
    this._writeJson('goals', { goals: this._goals });
  }

  _saveActions() {
    this._writeJson('actions', { actions: this._actions });
  }

  _saveIntents() {
    this._writeJson('intents', { intents: this._intents });
  }

  _now() {
    return new Date().toISOString();
  }

  createGoal({
    title,
    owner,
    deliverable,
    acceptanceTest,
    status,
    ...rest
  }) {
    this.reloadIfChanged();
    const now = this._now();
    const goal = {
      ...rest,
      title,
      owner,
      deliverable,
      acceptanceTest,
      schema: SCHEMA_GOAL,
      id: randomUUID(),
      // Default to 'queued', not 'active' — callers that actually want a
      // goal counted against the WIP-active cap must say so explicitly
      // (status: 'active') or call activateGoal() after creation.
      status: status === GOAL_STATUSES.ACTIVE ? GOAL_STATUSES.ACTIVE : GOAL_STATUSES.QUEUED,
      createdAt: now,
      updatedAt: now,
    };
    this._goals.push(goal);
    this._saveGoals();
    return goal;
  }

  getGoal(id) {
    this.reloadIfChanged();
    return this._goals.find((g) => g.id === id) || null;
  }

  listGoals() {
    this.reloadIfChanged();
    return [...this._goals];
  }

  setGoalStatus(id, status) {
    this.reloadIfChanged();
    const goal = this.getGoal(id);
    if (!goal) {
      throw new Error(`Goal not found: ${id}`);
    }
    goal.status = status;
    goal.updatedAt = this._now();
    this._saveGoals();
    return goal;
  }

  completeGoal(id, options = {}) {
    this.reloadIfChanged();
    if (options.proseOnly) {
      throw new Error('Goal completion requires a receipt; prose-only completion is not allowed');
    }
    if (!options.receiptId) {
      throw new Error('Goal completion requires receiptId');
    }
    const goal = this.getGoal(id);
    if (!goal) {
      throw new Error(`Goal not found: ${id}`);
    }
    goal.status = GOAL_STATUSES.COMPLETE;
    goal.receiptId = options.receiptId;
    if (options.receipt !== undefined) {
      goal.receipt = options.receipt;
    }
    goal.completedAt = this._now();
    goal.updatedAt = goal.completedAt;
    this._saveGoals();
    return goal;
  }

  listActions() {
    this.reloadIfChanged();
    return [...this._actions];
  }

  getAction(id) {
    this.reloadIfChanged();
    return this._actions.find((a) => a.id === id) || null;
  }

  /**
   * Minimal "In Flight" producer — appends an action record. Defaults to
   * status 'running' so callers can create-then-complete around a unit of
   * work (a safe-action run, a receipt-producing draft, etc).
   */
  createAction({ id, goalId = null, intentId = null, kind, detail, status, ...rest } = {}) {
    this.reloadIfChanged();
    const now = this._now();
    const record = {
      schema: SCHEMA_ACTION,
      id: id || randomUUID(),
      goalId,
      intentId,
      kind: kind || 'action',
      detail: detail || null,
      status: status || 'running',
      createdAt: now,
      updatedAt: now,
      ...rest,
    };
    this._actions.push(record);
    this._saveActions();
    return record;
  }

  /** Convenience alias — explicit name for the common "start of work" call. */
  recordActionRunning(payload = {}) {
    return this.createAction({ ...payload, status: 'running' });
  }

  completeAction(id, { status = 'complete', ...extra } = {}) {
    this.reloadIfChanged();
    const action = this._actions.find((a) => a.id === id);
    if (!action) {
      throw new Error(`Action not found: ${id}`);
    }
    Object.assign(action, extra, { status, updatedAt: this._now() });
    this._saveActions();
    return action;
  }

  listOperatorIntents() {
    this.reloadIfChanged();
    return [...this._intents];
  }

  upsertOperatorIntent(intent) {
    this.reloadIfChanged();
    const now = this._now();
    const record = {
      schema: SCHEMA_OPERATOR_INTENT,
      id: intent.id || randomUUID(),
      createdAt: intent.createdAt || now,
      updatedAt: now,
      ...intent,
    };
    const idx = this._intents.findIndex((i) => i.id === record.id);
    if (idx >= 0) {
      this._intents[idx] = { ...this._intents[idx], ...record, updatedAt: now };
    } else {
      this._intents.push(record);
    }
    this._saveIntents();
    return idx >= 0 ? this._intents[idx] : record;
  }

  appendEvent(event) {
    this.reloadIfChanged();
    const record = {
      schema: SCHEMA_EVENT,
      id: event.id || randomUUID(),
      at: event.at || this._now(),
      ...event,
    };
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(this.paths.events, line, 'utf8');
    return record;
  }

  appendBeliefDelta(delta) {
    this.reloadIfChanged();
    const record = {
      schema: SCHEMA_BELIEF_DELTA,
      id: delta.id || randomUUID(),
      at: delta.at || this._now(),
      ...delta,
    };
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(this.paths.beliefDeltas, line, 'utf8');
    return record;
  }
}

module.exports = { OsKernelStore };
