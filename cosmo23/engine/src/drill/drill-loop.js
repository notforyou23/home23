'use strict';

/**
 * The Cosmo research drill.
 *
 * Cosmo at heart is a drill that keeps drilling for the cycles or the time
 * specified. Cycles and time are how long the drill is allowed to run — they
 * are not the work. The work is:
 *
 *   take / invent a GOAL
 *     -> work its PHASES — open phases run IN PARALLEL, one worker per phase
 *        (the proven tool loop is the bit)
 *     -> the coordinator merges the phase results and, when the goal is
 *        done, CREATES THE NEXT GOAL
 *     -> keep going until cycles or time are spent, or the human stops it
 *
 * One drill cycle = one descent of one bit: a worker tool loop on one phase.
 * Cycles and time bound the WHOLE drill, not each worker. A worker finishing
 * a writeup completes a phase or a hole — never the goal chain, never the
 * drill. A slow worker never starves its siblings: the pool tops up as each
 * bit settles. Interactive is chat only. Query asks the Brain afterwards.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { LaunchLoop } = require('../agent/loop');
const { writeBrainStream } = require('../agent/brain-stream');
const { DrillCoordinator } = require('./coordinator');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const DEFAULT_CYCLES = 80;
const DEFAULT_WORKER_TURNS_PER_CYCLE = 24;
const DEFAULT_MAX_CONCURRENT = 3;

function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

class DrillLoop {
  constructor(options = {}) {
    this.config = options.config || {};
    this.orchestrator = options.orchestrator || null;
    this.logger = options.logger || console;
    this.client = options.client || null;
    this.plan = options.plan || null;
    this.createWorker = options.createWorker || ((args) => new LaunchLoop(args));
    this.now = options.now || (() => Date.now());
    this.coordinator = options.coordinator || new DrillCoordinator({
      client: this.client,
      config: this.config,
      logger: this.logger
    });

    const drillConfig = this.config.drill || {};
    const cycles = Number(drillConfig.cycles ?? this.config.execution?.maxCycles);
    const minutes = Number(drillConfig.maxRuntimeMinutes ?? this.config.execution?.maxRuntimeMinutes);
    this.cyclesTotal = Number.isFinite(cycles) && cycles > 0 ? Math.floor(cycles) : null;
    this.timeBudgetMs = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes * 60000) : null;
    if (!this.cyclesTotal && !this.timeBudgetMs) {
      // Budgets are real: a drill always has at least one.
      this.cyclesTotal = DEFAULT_CYCLES;
    }
    this.workerTurnsPerCycle = Number(drillConfig.workerTurnsPerCycle) > 0
      ? Math.floor(Number(drillConfig.workerTurnsPerCycle))
      : DEFAULT_WORKER_TURNS_PER_CYCLE;
    this.maxConcurrent = Number(drillConfig.maxConcurrent) > 0
      ? Math.floor(Number(drillConfig.maxConcurrent))
      : DEFAULT_MAX_CONCURRENT;

    // LaunchLoop-compatible surface (planner + status consumers read these).
    this.running = false;
    this.started = false;
    this.finished = false;
    this.finishSummary = null;
    this.turns = 0;
    this.fatalError = null;
    this.productLoop = RESEARCH_PRODUCT_LOOP;
    this._promise = null;

    this.mode = 'idle'; // idle | drilling | done | stopped | error
    this.doneReason = null;
    this.cyclesUsed = 0;
    this.startedAtMs = null;
    this.currentGoal = null;
    this.goalHistory = [];
    this.lastMerge = null;
    this.activeWorkers = new Map(); // workerId -> { workerId, worker, phase, goal, cycle, startedAt, settled, done }
    this.notesConsumedBytes = 0;
    this.candidatesHarvestedBytes = 0;
    this.brainWrites = 0;
    this.degradedGoalGeneration = false;
  }

  get runtimePath() {
    return this.orchestrator?.logsDir
      || this.orchestrator?.runtimePath
      || this.config?.logsDir
      || process.env.COSMO_RUNTIME_PATH
      || process.cwd();
  }

  get drillDir() {
    return path.join(this.runtimePath, 'drill');
  }

  get question() {
    const short = this.plan?.shortPlan || this.plan || {};
    return short.goal
      || this.config?.architecture?.roleSystem?.guidedFocus?.domain
      || this.plan?.title
      || 'Research the stated topic';
  }

  get questionContext() {
    const short = this.plan?.shortPlan || this.plan || {};
    if (Array.isArray(short.constraints) && short.constraints.length) {
      return short.constraints.join(' | ');
    }
    return this.config?.architecture?.roleSystem?.guidedFocus?.context || '';
  }

  // ── Lifecycle (LaunchLoop-compatible) ─────────────────────────────────

  start() {
    if (this.running) {
      return { started: true, reused: true, productLoop: RESEARCH_PRODUCT_LOOP };
    }
    this.running = true;
    this.started = true;
    this.mode = 'drilling';
    this.startedAtMs = this.now();
    this.logger?.info?.('Drill starting', {
      productLoop: RESEARCH_PRODUCT_LOOP,
      question: this.question,
      cycles: this.cyclesTotal,
      timeBudgetMinutes: this.timeBudgetMs ? this.timeBudgetMs / 60000 : null,
      maxConcurrent: this.maxConcurrent
    });
    this._promise = this.run().catch(async (err) => {
      if (isFatalAuthError(err)) {
        await this.stopFatalAuth(err);
        return;
      }
      this.logger?.error?.('Drill failed', { error: err.message, stack: err.stack });
      this.running = false;
      this.mode = 'error';
      await this.persistState().catch(() => {});
    });
    return { started: true, reused: false, productLoop: RESEARCH_PRODUCT_LOOP };
  }

  stop() {
    this.running = false;
    if (this.mode === 'drilling') this.mode = 'stopped';
    for (const entry of this.activeWorkers.values()) {
      if (typeof entry.worker.stop === 'function') entry.worker.stop();
    }
    this.logger?.info?.('Drill stopped', { cyclesUsed: this.cyclesUsed, mode: this.mode });
  }

  async stopFatalAuth(detail) {
    this.running = false;
    this.mode = 'error';
    this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
    // One fatal auth error stops every bit — siblings included.
    for (const entry of this.activeWorkers.values()) {
      if (typeof entry.worker.stop === 'function') entry.worker.stop();
    }
    const detailText = typeof detail === 'string'
      ? detail
      : (detail?.message || detail?.errorType || detail?.error?.message || null);
    this.logger?.error?.(AUTH_REVOKED_WATCH_MESSAGE, {
      productLoop: RESEARCH_PRODUCT_LOOP,
      errorType: 'authentication_error',
      detail: detailText,
      cyclesUsed: this.cyclesUsed
    });
    this.emitEvent('launch_loop_error', {
      fatal: true,
      errorType: 'authentication_error',
      message: AUTH_REVOKED_WATCH_MESSAGE
    });
    await this.persistState().catch(() => {});
  }

  getStatus() {
    return {
      running: this.running,
      started: this.started,
      finished: this.finished,
      turns: this.turns,
      productLoop: RESEARCH_PRODUCT_LOOP,
      summary: this.finishSummary,
      fatalError: this.fatalError || null,
      status: this.fatalError
        ? 'error'
        : (this.mode === 'done' ? 'done' : (this.running ? 'running' : 'stopped')),
      drill: this.snapshot()
    };
  }

  // ── Budgets: they bound the WHOLE drill, not each worker ─────────────

  elapsedMs() {
    return this.startedAtMs === null ? 0 : Math.max(0, this.now() - this.startedAtMs);
  }

  remainingCycles() {
    return this.cyclesTotal === null ? null : Math.max(0, this.cyclesTotal - this.cyclesUsed);
  }

  remainingMs() {
    return this.timeBudgetMs === null ? null : Math.max(0, this.timeBudgetMs - this.elapsedMs());
  }

  budgetExhaustedReason() {
    if (this.cyclesTotal !== null && this.cyclesUsed >= this.cyclesTotal) return 'cycles_exhausted';
    if (this.timeBudgetMs !== null && this.elapsedMs() >= this.timeBudgetMs) return 'time_exhausted';
    return null;
  }

  // ── Snapshot for the control center ────────────────────────────────────

  snapshot() {
    return {
      question: this.question,
      mode: this.mode,
      doneReason: this.doneReason,
      fatalError: this.fatalError,
      maxConcurrent: this.maxConcurrent,
      budgets: {
        cyclesTotal: this.cyclesTotal,
        cyclesUsed: this.cyclesUsed,
        cyclesRemaining: this.remainingCycles(),
        timeBudgetMs: this.timeBudgetMs,
        elapsedMs: this.elapsedMs(),
        timeRemainingMs: this.remainingMs(),
        workerTurns: this.turns
      },
      goal: this.currentGoal ? {
        id: this.currentGoal.id,
        number: this.currentGoal.number,
        title: this.currentGoal.title,
        why: this.currentGoal.why,
        origin: this.currentGoal.origin,
        status: this.currentGoal.status,
        phases: this.currentGoal.phases.map((phase) => ({
          number: phase.number,
          title: phase.title,
          status: phase.status,
          cyclesUsed: phase.cyclesUsed,
          summary: phase.summary || null,
          evidence: { streamed: phase.evidence?.streamed || 0 },
          rejections: phase.rejections || 0,
          workerId: this.workerOnPhase(phase)?.workerId || null
        }))
      } : null,
      goalHistory: this.goalHistory.slice(-10).map((goal) => ({
        number: goal.number,
        title: goal.title,
        status: goal.status,
        completedAt: goal.completedAt || null,
        mergedSummary: goal.mergedSummary ? String(goal.mergedSummary).slice(0, 240) : null
      })),
      activeWorkers: [...this.activeWorkers.values()].map((entry) => ({
        workerId: entry.workerId,
        cycle: entry.cycle,
        goalNumber: entry.goal.number,
        phaseNumber: entry.phase.number,
        phaseTitle: entry.phase.title,
        startedAt: entry.startedAt,
        turns: Number(entry.worker.turns) || 0
      })),
      counts: {
        goalsCompleted: this.goalHistory.filter((goal) => goal.status === 'completed').length,
        brainWrites: this.brainWrites
      },
      degradedGoalGeneration: this.degradedGoalGeneration,
      startedAt: this.startedAtMs,
      updatedAt: this.now()
    };
  }

  workerOnPhase(phase) {
    for (const entry of this.activeWorkers.values()) {
      if (entry.phase === phase) return entry;
    }
    return null;
  }

  emitEvent(type, payload = {}) {
    try {
      const emitter = this.orchestrator?._getEvents?.();
      if (emitter && typeof emitter.emitEvent === 'function') {
        emitter.emitEvent(type, { type, ...payload });
      }
    } catch { /* the control center still has state.json and logs */ }
  }

  async persistState() {
    const file = path.join(this.drillDir, 'state.json');
    await fsp.mkdir(this.drillDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.snapshot(), null, 2));
    await fsp.rename(tmp, file);
  }

  async journal(type, data = {}) {
    try {
      await fsp.mkdir(this.drillDir, { recursive: true });
      await fsp.appendFile(
        path.join(this.drillDir, 'progress.jsonl'),
        `${JSON.stringify({ at: this.now(), type, ...data })}\n`
      );
    } catch (err) {
      this.logger?.warn?.('Drill journal write failed', { error: err.message });
    }
  }

  /**
   * The drill's own life — goals, phase starts/closes, offshoots — is part
   * of the working stream: onto the tape (outputs/stream.jsonl) and into
   * the Brain as it happens, same as worker thoughts and harvests.
   */
  async streamEvent(kind, content, provenance = {}) {
    const result = await writeBrainStream({
      runtimePath: this.runtimePath,
      memory: this.orchestrator?.memory || null,
      logger: this.logger
    }, { kind, content, ...provenance });
    if (result.brain === 'live') this.brainWrites += 1;
    return result;
  }

  // ── The drill run: a rolling pool of bits ──────────────────────────────

  async run() {
    await this.loadResumableState();
    await this.journal('drill_started', {
      question: this.question,
      cyclesTotal: this.cyclesTotal,
      timeBudgetMs: this.timeBudgetMs,
      maxConcurrent: this.maxConcurrent,
      resumedGoal: this.currentGoal ? this.currentGoal.number : null
    });
    this.emitEvent('drill_started', {
      question: this.question,
      cycles: this.cyclesTotal,
      timeBudgetMs: this.timeBudgetMs,
      maxConcurrent: this.maxConcurrent,
      message: `Drill started: up to ${this.maxConcurrent} workers in parallel`
    });
    await this.persistState();

    while (this.running) {
      const exhausted = this.budgetExhaustedReason();

      if (exhausted && this.activeWorkers.size === 0) {
        await this.finishDrill(exhausted);
        return;
      }

      if (!exhausted && (!this.currentGoal || this.currentGoal.status === 'completed')) {
        const previous = this.currentGoal;
        const goal = await this.nextGoal(previous);
        if (!goal) {
          await this.finishDrill('goal_generation_failed');
          return;
        }
        this.currentGoal = goal;
        await this.journal('goal_created', {
          goalId: goal.id, number: goal.number, title: goal.title,
          origin: goal.origin, phases: goal.phases.map((phase) => phase.title)
        });
        await this.streamEvent('goal',
          `Goal ${goal.number}: ${goal.title}${goal.why ? ` — ${goal.why}` : ''} (${goal.phases.length} phases: ${goal.phases.map((phase) => phase.title).join('; ')})`,
          { goalNumber: goal.number });
        this.emitEvent('drill_goal_created', {
          number: goal.number, title: goal.title, phases: goal.phases.length,
          message: `Goal ${goal.number}: ${goal.title} (${goal.phases.length} phases)`
        });
        await this.persistState();
        continue;
      }

      if (this.currentGoal && this.currentGoal.status !== 'completed') {
        const openPhases = this.currentGoal.phases.filter(
          (phase) => phase.status !== 'done' && !this.workerOnPhase(phase)
        );

        if (openPhases.length === 0 && this.activeWorkers.size === 0) {
          await this.mergeAndCompleteGoal(this.currentGoal);
          continue;
        }

        // Top up the pool: the coordinator assigns open phases to free
        // slots. A slow worker never starves its siblings — every settle
        // reopens this top-up.
        if (!exhausted) {
          const slots = this.maxConcurrent - this.activeWorkers.size;
          const assigned = this.coordinator.assignPhases(openPhases, slots);
          for (const phase of assigned) {
            if (this.budgetExhaustedReason()) break;
            await this.launchWorker(this.currentGoal, phase);
          }
        }
      }

      if (this.activeWorkers.size === 0) {
        await this.finishDrill(this.budgetExhaustedReason() || 'no_launchable_work');
        return;
      }

      // Wait for the FIRST bit to settle, then loop: settle, harvest,
      // top up. Never wait for the slowest.
      await Promise.race([...this.activeWorkers.values()].map((entry) => entry.settled));
      const fatal = await this.settleFinishedWorkers();
      if (fatal) return;
      await this.persistState();
    }

    if (this.mode === 'stopped') {
      await this.journal('drill_stopped', { cyclesUsed: this.cyclesUsed });
      await this.persistState();
    }
  }

  async loadResumableState() {
    // A continuation relaunch gives the drill a fresh budget; the goal chain
    // resumes where it stopped.
    try {
      const saved = JSON.parse(await fsp.readFile(path.join(this.drillDir, 'state.json'), 'utf8'));
      if (saved?.goal && saved.goal.phases) {
        this.currentGoal = {
          id: saved.goal.id || shortId('goal'),
          number: saved.goal.number || 1,
          title: saved.goal.title,
          why: saved.goal.why || null,
          origin: saved.goal.origin || 'seed',
          status: saved.goal.status === 'completed' ? 'completed' : 'active',
          previousGoalId: null,
          phases: saved.goal.phases.map((phase, index) => ({
            id: shortId('phase'),
            number: phase.number || index + 1,
            title: phase.title,
            mission: phase.mission || phase.title,
            status: phase.status === 'done' ? 'done' : 'pending',
            summary: phase.summary || null,
            cyclesUsed: phase.cyclesUsed || 0,
            evidence: { streamed: Number(phase.evidence?.streamed) || 0 },
            rejections: Number(phase.rejections) || 0
          })),
          createdAt: this.now()
        };
      }
      if (Array.isArray(saved?.goalHistory)) {
        this.goalHistory = saved.goalHistory.map((goal) => ({
          number: goal.number, title: goal.title, status: goal.status || 'completed',
          completedAt: goal.completedAt || null, mergedSummary: goal.mergedSummary || null
        }));
      }
    } catch { /* fresh run */ }
  }

  // ── Goals: the coordinator composes, merges, and chains ───────────────

  async nextGoal(previousGoal) {
    const number = previousGoal ? previousGoal.number + 1 : (this.goalHistory.length + 1);
    const origin = previousGoal || this.goalHistory.length > 0 ? 'chain' : 'seed';

    const { spec, degraded } = await this.coordinator.composeGoal({
      question: this.question,
      questionContext: this.questionContext,
      previousGoal,
      goalHistory: this.goalHistory,
      number,
      origin,
      mergedSummary: this.lastMerge?.summary || null
    });
    if (degraded) this.degradedGoalGeneration = true;
    if (!spec) return null;

    return {
      id: shortId('goal'),
      number,
      title: spec.title,
      why: spec.why || null,
      origin,
      status: 'active',
      previousGoalId: previousGoal?.id || null,
      phases: spec.phases.map((phase, index) => ({
        id: shortId('phase'),
        number: index + 1,
        title: phase.title,
        mission: phase.mission || phase.title,
        status: 'pending',
        summary: null,
        cyclesUsed: 0,
        evidence: { streamed: 0 },
        rejections: 0
      })),
      createdAt: this.now()
    };
  }

  async mergeAndCompleteGoal(goal) {
    const findings = await this.recentFindings(12);
    let merge;
    try {
      merge = await this.coordinator.mergeGoal(goal, { findings });
    } catch (err) {
      if (isFatalAuthError(err)) {
        await this.stopFatalAuth(err);
        return;
      }
      merge = { summary: goal.phases.map((phase) => phase.summary || phase.title).join('\n'), gaps: [], degraded: true };
    }
    this.lastMerge = merge;
    goal.mergedSummary = merge.summary;
    goal.status = 'completed';
    goal.completedAt = this.now();
    this.goalHistory.push({
      number: goal.number,
      title: goal.title,
      status: 'completed',
      completedAt: goal.completedAt,
      mergedSummary: merge.summary,
      phases: goal.phases.map((phase) => ({ title: phase.title, summary: phase.summary }))
    });
    await this.journal('goal_merged', {
      goalId: goal.id,
      number: goal.number,
      summary: String(merge.summary).slice(0, 600),
      gaps: merge.gaps,
      degraded: merge.degraded === true
    });
    await this.streamEvent('goal',
      `Goal ${goal.number} complete: ${goal.title} — ${String(merge.summary).slice(0, 400)}`,
      { goalNumber: goal.number });
    // The merge's open gaps are offshoots — branches the next goal can take.
    for (const gap of merge.gaps || []) {
      await this.streamEvent('offshoot',
        `Offshoot from goal ${goal.number}: ${String(gap).slice(0, 300)}`,
        { goalNumber: goal.number });
    }
    await this.journal('goal_completed', {
      goalId: goal.id, number: goal.number, title: goal.title,
      cyclesUsed: goal.phases.reduce((sum, phase) => sum + phase.cyclesUsed, 0)
    });
    this.emitEvent('drill_goal_complete', {
      number: goal.number,
      title: goal.title,
      message: `Goal ${goal.number} complete: ${goal.title} — merged ${goal.phases.length} phases, creating the next goal`
    });
    await this.persistState();
  }

  async recentFindings(limit) {
    try {
      const raw = await fsp.readFile(path.join(this.runtimePath, 'outputs', 'candidates', 'findings.jsonl'), 'utf8');
      return raw.trim().split('\n').filter(Boolean).slice(-limit).map((line) => {
        try { return JSON.parse(line).content || null; } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── Cycles: bits descend in parallel ───────────────────────────────────

  async launchWorker(goal, phase) {
    this.cyclesUsed += 1;
    const cycle = this.cyclesUsed;
    const workerId = `w${cycle}`;
    phase.status = 'active';
    phase.cyclesUsed += 1;

    const notes = await this.consumeNotes();
    const siblings = this.currentGoal.phases
      .filter((entry) => entry !== phase && this.workerOnPhase(entry))
      .map((entry) => entry.title);

    await this.journal('cycle_started', {
      cycle,
      workerId,
      goalId: goal.id,
      goalNumber: goal.number,
      phaseNumber: phase.number,
      phaseTitle: phase.title,
      parallelWith: siblings,
      notes: notes.map((note) => note.text)
    });
    this.emitEvent('drill_cycle_start', {
      cycle,
      workerId,
      remainingCycles: this.remainingCycles(),
      remainingMs: this.remainingMs(),
      message: `Cycle ${cycle} (${workerId}): goal ${goal.number} phase ${phase.number} — ${phase.title}${siblings.length ? ` (parallel with ${siblings.length} other phase${siblings.length > 1 ? 's' : ''})` : ''}`
    });
    await this.streamEvent('phase',
      `Phase ${phase.number} of goal ${goal.number} started (cycle ${cycle}, ${workerId}): ${phase.title}`,
      { cycle, workerId, goalNumber: goal.number, phaseNumber: phase.number });

    const worker = this.createWorker({
      orchestrator: this.orchestrator,
      config: this.config,
      logger: this.logger,
      client: this.client,
      maxTurns: this.workerTurnsPerCycle,
      plan: { shortPlan: this.buildPhaseMission(goal, phase, notes, siblings) },
      drill: { cycle, workerId, goalId: goal.id, goalNumber: goal.number, phaseNumber: phase.number },
      // Evidence from earlier cycles on this phase: a phase that already
      // put work on the record may close without repeating it.
      evidence: { streamed: phase.evidence?.streamed || 0 }
    });

    const entry = {
      workerId,
      worker,
      phase,
      goal,
      cycle,
      startedAt: this.now(),
      done: false,
      settled: null
    };
    worker.start();
    entry.settled = Promise.resolve(worker._promise)
      .catch(() => {})
      .then(() => { entry.done = true; });
    this.activeWorkers.set(workerId, entry);
    await this.persistState();
    return entry;
  }

  async settleFinishedWorkers() {
    for (const [workerId, entry] of [...this.activeWorkers.entries()]) {
      if (!entry.done) continue;
      this.activeWorkers.delete(workerId);

      const { worker, phase, goal, cycle } = entry;
      this.turns += Math.max(1, Number(worker.turns) || 0);

      if (worker.fatalError) {
        await this.stopFatalAuth(worker.fatalError);
        return true;
      }

      const harvested = await this.harvestCandidates();

      // What this descent left on the record. The worker was seeded with
      // the phase's prior evidence, so a plain copy-forward is correct; the
      // max() covers scripted workers that ignore the seed.
      phase.evidence = phase.evidence || { streamed: 0 };
      phase.evidence.streamed = Math.max(
        Number(phase.evidence.streamed) || 0,
        Number(worker.evidence?.streamed) || 0
      );
      const phaseOnRecord = phase.evidence.streamed > 0;

      if (worker.finished && phaseOnRecord) {
        // The worker finished ITS hole: the phase is done. The drill and
        // its sibling bits keep going.
        phase.status = 'done';
        phase.summary = worker.finishSummary || 'done';
        this.emitEvent('drill_phase_complete', {
          cycle,
          workerId,
          goalNumber: goal.number,
          phaseNumber: phase.number,
          message: `${workerId} done — phase ${phase.number} of goal ${goal.number}: ${String(worker.finishSummary || '').slice(0, 140)}`
        });
        await this.streamEvent('phase',
          `Phase ${phase.number} of goal ${goal.number} done (cycle ${cycle}, ${workerId}): ${String(worker.finishSummary || 'done').slice(0, 300)}`,
          { cycle, workerId, goalNumber: goal.number, phaseNumber: phase.number });
      } else if (worker.finished) {
        // Hidden work is a failed close: the worker claims done but its
        // whole descent left nothing on the tape — no receipt, no stream
        // entry, no journaled finding. The phase stays open.
        phase.status = 'pending';
        phase.rejections = (Number(phase.rejections) || 0) + 1;
        this.emitEvent('drill_phase_rejected', {
          cycle,
          workerId,
          goalNumber: goal.number,
          phaseNumber: phase.number,
          message: `${workerId} finished with nothing on the record — phase ${phase.number} of goal ${goal.number} stays open`
        });
        await this.streamEvent('phase',
          `Phase ${phase.number} of goal ${goal.number} NOT accepted (cycle ${cycle}, ${workerId}): finished with nothing on the record`,
          { cycle, workerId, goalNumber: goal.number, phaseNumber: phase.number });
      } else {
        phase.status = 'pending';
        this.emitEvent('drill_phase_continues', {
          cycle,
          workerId,
          goalNumber: goal.number,
          phaseNumber: phase.number,
          message: `${workerId} paused — phase ${phase.number} of goal ${goal.number} continues in a later cycle`
        });
      }

      await this.journal('cycle_completed', {
        cycle,
        workerId,
        goalNumber: goal.number,
        phaseNumber: phase.number,
        workerFinished: worker.finished === true,
        phaseDone: phase.status === 'done',
        rejectedReason: worker.finished && !phaseOnRecord ? 'hidden_work' : null,
        workerTurns: worker.turns,
        workerSummary: worker.finishSummary || null,
        streamedEvidence: phase.evidence.streamed,
        candidatesHarvested: harvested
      });
    }
    return false;
  }

  buildPhaseMission(goal, phase, notes, siblings = []) {
    const constraints = [];
    if (this.questionContext) constraints.push(this.questionContext);
    constraints.push(`Goal ${goal.number}: ${goal.title}${goal.why ? ` — ${goal.why}` : ''}`);
    if (goal.phases.length > 1) {
      constraints.push(`This is phase ${phase.number} of ${goal.phases.length}: ${phase.title}`);
    }
    if (siblings.length > 0) {
      constraints.push(`Phases running in parallel right now: ${siblings.join('; ')}. Stay in YOUR phase's lane — do not duplicate their work.`);
    }
    const doneSummaries = goal.phases
      .filter((entry) => entry.status === 'done' && entry.summary)
      .map((entry) => `Phase ${entry.number} already done: ${String(entry.summary).slice(0, 120)}`);
    constraints.push(...doneSummaries);
    if (phase.cyclesUsed > 1) {
      constraints.push('This phase was started in an earlier cycle. Continue it; do not start over.');
    }
    if ((Number(phase.rejections) || 0) > 0) {
      constraints.push('An earlier worker on this phase claimed done with nothing on the record. Everything you do must land in files: fetches leave receipts, thoughts and harvests stream, findings go through remember, writeups through write_file.');
    }
    for (const note of notes) {
      constraints.push(`Operator note: ${note.text}`);
    }
    return {
      goal: phase.mission,
      constraints,
      deliverable: 'Research however works — search, curl known URLs, archives, forums, coding_run, scripts — every fetch leaves a receipt and your work streams to the Brain as it happens. Journal findings with remember and leave concrete artifacts in outputs/. Call finish when THIS phase\'s deliverable is done — the drill continues after you. A phase with nothing on the record cannot close.',
      executionKind: 'tool_loop',
      claimedBy: 'launch_loop'
    };
  }

  // ── Steering notes ─────────────────────────────────────────────────────

  async consumeNotes() {
    const file = path.join(this.drillDir, 'notes.jsonl');
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      return [];
    }
    const fresh = raw.slice(this.notesConsumedBytes);
    if (!fresh.trim()) return [];
    this.notesConsumedBytes = raw.length;
    const notes = fresh.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((note) => note?.text);
    for (const note of notes) {
      await this.journal('note_consumed', { noteId: note.id || null, text: note.text });
      this.emitEvent('drill_note_consumed', { message: `Operator note picked up: ${String(note.text).slice(0, 160)}` });
    }
    return notes;
  }

  // ── Brain harvest ──────────────────────────────────────────────────────

  async candidatesLength() {
    try {
      const stat = await fsp.stat(path.join(this.runtimePath, 'outputs', 'candidates', 'findings.jsonl'));
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * On every settle, journaled candidates are written into the run's Brain.
   * Most findings reach the Brain LIVE through the stream at remember()
   * time; this settle pass is the degraded-honest catch-up for rows the
   * live write missed (marked brain:'journaled'). Parallel bits interleave
   * in the journal, so each row's OWN provenance (cycle / goal / phase /
   * worker) is what reaches the Brain — never the provenance of whichever
   * worker happened to settle last.
   */
  async harvestCandidates() {
    const memory = this.orchestrator?.memory;
    let raw;
    try {
      raw = await fsp.readFile(path.join(this.runtimePath, 'outputs', 'candidates', 'findings.jsonl'), 'utf8');
    } catch {
      return 0;
    }
    const fresh = raw.slice(this.candidatesHarvestedBytes);
    this.candidatesHarvestedBytes = raw.length;
    if (!fresh.trim()) return 0;

    let harvested = 0;
    for (const line of fresh.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row?.content) continue;
      harvested += 1;
      if (row.brain === 'live') continue; // already in the Brain via the stream
      if (memory && typeof memory.addNode === 'function') {
        try {
          await memory.addNode(row.content, 'drill_finding', null, {
            source: 'drill',
            cycle: row.cycle ?? null,
            workerId: row.workerId ?? null,
            goalNumber: row.goalNumber ?? null,
            phaseNumber: row.phaseNumber ?? null
          });
          this.brainWrites += 1;
        } catch (err) {
          this.logger?.warn?.('Drill brain write failed — candidate stays journaled', { error: err.message });
        }
      }
    }
    return harvested;
  }

  // ── End of the drill ───────────────────────────────────────────────────

  async finishDrill(reason) {
    this.running = false;
    this.mode = 'done';
    this.doneReason = reason;
    this.finished = true;
    this.finishSummary = `Drill done: ${reason} after ${this.cyclesUsed} cycles, ${this.goalHistory.filter((goal) => goal.status === 'completed').length} goals completed`;

    await this.journal('drill_done', {
      reason,
      cyclesUsed: this.cyclesUsed,
      elapsedMs: this.elapsedMs(),
      goalsCompleted: this.goalHistory.filter((goal) => goal.status === 'completed').length,
      brainWrites: this.brainWrites
    });
    this.emitEvent('drill_done', {
      reason,
      cycles: this.cyclesUsed,
      message: this.finishSummary
    });
    await this.persistState();
    this.logger?.info?.(this.finishSummary, { reason });

    // Budget spent: close the run out so the process can exit. The Brain
    // stays queryable from the saved run.
    if (this.orchestrator && typeof this.orchestrator.requestRunCompletion === 'function') {
      try {
        this.orchestrator.requestRunCompletion(`drill_${reason}`, { id: 'plan:main', title: this.question }, 'drill');
      } catch (err) {
        this.logger?.warn?.('Run completion request failed after drill finished', { error: err.message });
      }
    }
  }
}

module.exports = { DrillLoop, DEFAULT_CYCLES, DEFAULT_WORKER_TURNS_PER_CYCLE, DEFAULT_MAX_CONCURRENT };
