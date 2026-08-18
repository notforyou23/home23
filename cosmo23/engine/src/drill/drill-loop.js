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
const {
  writeBrainStream,
  replayJournaledBrainStream,
  STREAM_BRAIN_ACK_FILE
} = require('../agent/brain-stream');
const { DrillCoordinator } = require('./coordinator');
const {
  assessPhaseReceipt,
  buildHarvestDigest,
  expectedOutputPaths,
  listWriteups,
  phaseHasTape,
  readPersistedNotes
} = require('./writeup-gate');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const DEFAULT_CYCLES = 80;
const DEFAULT_WORKER_TURNS_PER_CYCLE = 24;
const DEFAULT_MAX_CONCURRENT = 3;

function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function fileSlug(value) {
  return String(value || 'phase')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'phase';
}

function normalizePhaseOutputs(runtimePath, phases, goalNumber) {
  const used = new Set();
  return phases.map((phase, index) => {
    const phaseNumber = index + 1;
    const requested = expectedOutputPaths(runtimePath, phase.expectedOutput);
    const collides = requested.some(output => used.has(output));
    const expectedOutput = requested.length > 0 && !collides
      ? (requested.length === 1 ? requested[0] : requested)
      : `outputs/drill/goal-${goalNumber}/phase-${phaseNumber}-${fileSlug(phase.title)}.md`;
    for (const output of Array.isArray(expectedOutput) ? expectedOutput : [expectedOutput]) {
      used.add(output);
    }
    return {
      ...phase,
      requestedOutput: collides ? (phase.expectedOutput || null) : null,
      expectedOutput
    };
  });
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
    this._persistTail = Promise.resolve();
    this._stopPromise = null;

    this.mode = 'idle'; // idle | drilling | done | stopped | error
    this.doneReason = null;
    this.cyclesUsed = 0;
    this.startedAtMs = null;
    this.currentGoal = null;
    this.goalHistory = [];
    this.lastMerge = null;
    this.activeWorkers = new Map(); // workerId -> { workerId, worker, phase, goal, cycle, startedAt, settled, done }
    this.candidatesHarvestedBytes = 0;
    this.brainWrites = 0;
    this.degradedGoalGeneration = false;
    this.goalChainDoneReason = null;
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
      await this.failDrill(err);
    });
    return { started: true, reused: false, productLoop: RESEARCH_PRODUCT_LOOP };
  }

  normalizeActiveWorkForTerminal() {
    const interruptedWorkers = [...this.activeWorkers.values()].map((entry) => ({
      workerId: entry.workerId,
      cycle: entry.cycle,
      goalNumber: entry.goal?.number ?? null,
      phaseNumber: entry.phase?.number ?? null,
      phaseTitle: entry.phase?.title || null
    }));
    for (const entry of this.activeWorkers.values()) {
      try {
        if (typeof entry.worker.stop === 'function') entry.worker.stop();
      } catch (error) {
        this.logger?.warn?.('Drill worker stop failed; terminal state will still be persisted', {
          workerId: entry.workerId,
          error: error.message
        });
      }
    }
    const interruptedPhases = [];
    for (const phase of this.currentGoal?.phases || []) {
      if (phase.status !== 'active') continue;
      interruptedPhases.push({
        number: phase.number,
        title: phase.title
      });
      phase.status = 'pending';
    }
    this.activeWorkers.clear();
    return { interruptedWorkers, interruptedPhases };
  }

  stop() {
    if (this._stopPromise) return this._stopPromise;
    const wasDrilling = this.mode === 'drilling';
    this.running = false;
    if (wasDrilling) this.mode = 'stopped';
    const { interruptedWorkers, interruptedPhases } = this.normalizeActiveWorkForTerminal();
    const shouldPersist = wasDrilling
      || interruptedWorkers.length > 0
      || interruptedPhases.length > 0;
    this._stopPromise = (async () => {
      if (shouldPersist) {
        await this.journal('drill_stopped', {
          cyclesUsed: this.cyclesUsed,
          interruptedWorkers,
          interruptedPhases
        });
        await this.persistState();
      }
      return {
        stopped: true,
        mode: this.mode,
        workersNormalized: interruptedWorkers.length,
        phasesNormalized: interruptedPhases.length
      };
    })().catch((error) => {
      this._stopPromise = null;
      throw error;
    });
    this.logger?.info?.('Drill stopped', { cyclesUsed: this.cyclesUsed, mode: this.mode });
    return this._stopPromise;
  }

  async failDrill(error) {
    this.running = false;
    this.mode = 'error';
    const { interruptedWorkers, interruptedPhases } = this.normalizeActiveWorkForTerminal();
    await this.journal('drill_error', {
      cyclesUsed: this.cyclesUsed,
      message: error?.message || String(error),
      interruptedWorkers,
      interruptedPhases
    }).catch(() => {});
    await this.persistState().catch(() => {});
  }

  async stopFatalAuth(detail) {
    this.running = false;
    this.mode = 'error';
    this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
    // One fatal auth error stops every bit — siblings included.
    const { interruptedWorkers, interruptedPhases } = this.normalizeActiveWorkForTerminal();
    const detailText = typeof detail === 'string'
      ? detail
      : (detail?.message || detail?.errorType || detail?.error?.message || null);
    this.logger?.error?.(AUTH_REVOKED_WATCH_MESSAGE, {
      productLoop: RESEARCH_PRODUCT_LOOP,
      errorType: 'authentication_error',
      detail: detailText,
      cyclesUsed: this.cyclesUsed
    });
    await this.journal('drill_error', {
      cyclesUsed: this.cyclesUsed,
      errorType: 'authentication_error',
      message: AUTH_REVOKED_WATCH_MESSAGE,
      detail: detailText,
      interruptedWorkers,
      interruptedPhases
    }).catch(() => {});
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
          id: phase.id,
          number: phase.number,
          title: phase.title,
          mission: phase.mission,
          expectedOutput: phase.expectedOutput || null,
          status: phase.status,
          cyclesUsed: phase.cyclesUsed,
          summary: phase.summary || null,
          writeups: Array.isArray(phase.writeups) ? phase.writeups : [],
          clearance: phase.clearance || null,
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
        mergedSummary: goal.mergedSummary ? String(goal.mergedSummary).slice(0, 240) : null,
        phases: Array.isArray(goal.phases) ? goal.phases.map(phase => ({
          number: phase.number,
          title: phase.title,
          expectedOutput: phase.expectedOutput || null,
          clearance: phase.clearance || null
        })) : []
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

  persistState() {
    const persist = async () => {
      const file = path.join(this.drillDir, 'state.json');
      await fsp.mkdir(this.drillDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.snapshot(), null, 2));
      await fsp.rename(tmp, file);
    };
    const queued = this._persistTail.catch(() => {}).then(persist);
    this._persistTail = queued;
    return queued;
  }

  async checkpointBrain() {
    if (!this.orchestrator || typeof this.orchestrator.saveState !== 'function') return;
    try {
      await this.orchestrator.saveState();
    } catch (error) {
      this.logger?.warn?.('Drill brain checkpoint failed; disk tape remains intact', {
        error: error.message
      });
    }
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
    const replay = await replayJournaledBrainStream({
      runtimePath: this.runtimePath,
      memory: this.orchestrator?.memory || null,
      logger: this.logger
    });
    if (replay.replayed > 0) {
      this.brainWrites += replay.replayed;
      await this.journal('brain_tape_replayed', replay);
    }
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

      // A spent budget stops new descents, not closeout. If the last in-flight
      // wave completed every phase, merge that goal before settling the run.
      if (this.currentGoal
          && this.currentGoal.status !== 'completed'
          && this.activeWorkers.size === 0
          && this.currentGoal.phases.length > 0
          && this.currentGoal.phases.every(phase => phase.status === 'done')) {
        await this.mergeAndCompleteGoal(this.currentGoal);
        continue;
      }

      if (exhausted && this.activeWorkers.size === 0) {
        await this.finishDrill(exhausted);
        return;
      }

      if (!exhausted && (!this.currentGoal || this.currentGoal.status === 'completed')) {
        const previous = this.currentGoal;
        const goal = await this.nextGoal(previous);
        if (!goal) {
          await this.finishDrill(this.goalChainDoneReason || 'goal_generation_failed');
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
      await this.checkpointBrain();
    }

    if (this.mode === 'stopped') {
      if (this._stopPromise) {
        await this._stopPromise;
      } else {
        await this.journal('drill_stopped', { cyclesUsed: this.cyclesUsed });
        await this.persistState();
      }
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
            id: phase.id || shortId('phase'),
            number: phase.number || index + 1,
            title: phase.title,
            mission: phase.mission || phase.title,
            expectedOutput: phase.expectedOutput || null,
            status: phase.status === 'done' ? 'done' : 'pending',
            summary: phase.summary || null,
            writeups: Array.isArray(phase.writeups) ? phase.writeups : [],
            clearance: phase.clearance || null,
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
          completedAt: goal.completedAt || null, mergedSummary: goal.mergedSummary || null,
          phases: Array.isArray(goal.phases) ? goal.phases : []
        }));
      }
    } catch { /* fresh run */ }
  }

  // ── Goals: the coordinator composes, merges, and chains ───────────────

  async nextGoal(previousGoal) {
    this.goalChainDoneReason = null;
    const number = previousGoal ? previousGoal.number + 1 : (this.goalHistory.length + 1);
    const origin = previousGoal || this.goalHistory.length > 0 ? 'chain' : 'seed';

    const requestedPhases = !previousGoal && this.goalHistory.length === 0
      ? this.plan?.shortPlan?.seedPhases
      : null;
    const composed = Array.isArray(requestedPhases) && requestedPhases.length > 0
      ? {
        degraded: false,
        spec: {
          title: this.question,
          why: 'First goal preserves the phases supplied at Launch.',
          phases: requestedPhases.map(phase => ({
            title: phase.title,
            mission: phase.mission || phase.title,
            expectedOutput: phase.expectedOutput || null
          }))
        }
      }
      : await this.coordinator.composeGoal({
        question: this.question,
        questionContext: this.questionContext,
        previousGoal,
        goalHistory: this.goalHistory,
        number,
        origin,
        mergedSummary: this.lastMerge?.summary || null,
        deadlineAt: this.timeBudgetMs === null ? null : this.startedAtMs + this.timeBudgetMs
      });
    const { spec, degraded, done, doneReason, rejections = [] } = composed;
    for (const rejection of rejections) {
      await this.journal('goal_generation_rejected', {
        goalNumber: number,
        attempt: rejection.attempt,
        reason: rejection.reason,
        payload: rejection.payload
      });
    }
    if (degraded) this.degradedGoalGeneration = true;
    if (!spec) {
      this.goalChainDoneReason = done
        ? (doneReason || 'research_complete')
        : (doneReason || 'goal_generation_failed');
      return null;
    }

    const phases = normalizePhaseOutputs(this.runtimePath, spec.phases, number);
    return {
      id: shortId('goal'),
      number,
      title: spec.title,
      why: spec.why || null,
      origin,
      status: 'active',
      previousGoalId: previousGoal?.id || null,
      phases: phases.map((phase, index) => ({
        id: shortId('phase'),
        number: index + 1,
        title: phase.title,
        mission: phase.mission || phase.title,
        expectedOutput: phase.expectedOutput || null,
        requestedOutput: phase.requestedOutput || null,
        status: 'pending',
        summary: null,
        writeups: [],
        clearance: null,
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
      merge = await this.coordinator.mergeGoal(goal, {
        findings,
        deadlineAt: this.timeBudgetMs === null ? null : this.startedAtMs + this.timeBudgetMs
      });
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
      phases: goal.phases.map((phase) => ({
        number: phase.number,
        title: phase.title,
        summary: phase.summary,
        expectedOutput: phase.expectedOutput,
        clearance: phase.clearance || null
      }))
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
      message: `Goal ${goal.number} complete: ${goal.title} — merged ${goal.phases.length} phases, deciding what remains`
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

    const notes = await this.readNotes();
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
      drill: {
        cycle,
        workerId,
        goalId: goal.id,
        goalNumber: goal.number,
        phaseNumber: phase.number,
        deadlineAt: this.timeBudgetMs === null ? null : this.startedAtMs + this.timeBudgetMs
      },
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
      const phaseProvenance = {
        goalNumber: goal.number,
        phaseNumber: phase.number
      };
      const receipt = assessPhaseReceipt(
        this.runtimePath,
        phase.expectedOutput,
        phaseProvenance
      );
      const rejectedReason = !worker.finished
        ? null
        : (!phaseOnRecord && !receipt.accepted
          ? 'hidden_work'
          : (receipt.accepted ? null : receipt.reason));

      if (worker.finished && receipt.accepted) {
        // The worker finished ITS hole and the phase's named receipt is
        // complete on disk. Another artifact or a progress note cannot
        // move the phase.
        phase.status = 'done';
        phase.summary = worker.finishSummary || 'done';
        phase.writeups = [receipt.path];
        phase.clearance = {
          at: this.now(),
          reason: receipt.reason,
          expectedOutput: receipt.expectedOutput,
          path: receipt.path,
          bytes: receipt.bytes,
          sha256: receipt.sha256
        };
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
        // Failed close: hidden work, the wrong file, or an unfinished
        // receipt. The phase stays open.
        phase.status = 'pending';
        phase.clearance = null;
        phase.rejections = (Number(phase.rejections) || 0) + 1;
        const why = rejectedReason === 'hidden_work'
          ? 'finished with nothing on the record'
          : `did not finish the named receipt ${Array.isArray(phase.expectedOutput) ? phase.expectedOutput.join(', ') : phase.expectedOutput} (${rejectedReason})`;
        this.emitEvent('drill_phase_rejected', {
          cycle,
          workerId,
          goalNumber: goal.number,
          phaseNumber: phase.number,
          reason: rejectedReason,
          message: `${workerId} ${why} — phase ${phase.number} of goal ${goal.number} stays open`
        });
        await this.streamEvent('phase',
          `Phase ${phase.number} of goal ${goal.number} NOT accepted (cycle ${cycle}, ${workerId}): ${why}`,
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
        rejectedReason,
        workerTurns: worker.turns,
        workerSummary: worker.finishSummary || null,
        expectedOutput: phase.expectedOutput,
        clearance: phase.clearance,
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
    if (phase.expectedOutput) {
      constraints.push(`THIS phase clears only when this named receipt is finished on disk: ${Array.isArray(phase.expectedOutput) ? phase.expectedOutput.join(', ') : phase.expectedOutput}`);
    }
    if ((Number(phase.rejections) || 0) > 0) {
      constraints.push('An earlier worker claimed done without finishing this phase\'s named receipt. Complete that exact file, remember() the findings, then finish. Progress notes, another file, and /tmp dumps cannot close this phase.');
    }
    const alreadyHasTape = phaseHasTape(phase, this.runtimePath, {
      goalNumber: goal.number,
      phaseNumber: phase.number
    });
    if (alreadyHasTape) {
      constraints.push(`WRITE FIRST: this phase already has tape. write_file the finished receipt at ${Array.isArray(phase.expectedOutput) ? phase.expectedOutput.join(', ') : phase.expectedOutput} and remember() the findings BEFORE any more fetching. More harvest cannot close this phase.`);
      const digest = buildHarvestDigest(this.runtimePath, {
        goalNumber: goal.number,
        phaseNumber: phase.number
      });
      if (digest) {
        constraints.push(`Harvest digest from this phase's stream:\n${digest}`);
      }
    }
    for (const note of notes) {
      constraints.push(`Operator note: ${note.text}`);
    }
    const operatorRequestsWrite = notes.some(note =>
      /\b(write|persist|land)\b[\s\S]{0,80}\b(file|writeup|output)\b/i.test(String(note.text || ''))
    );
    const expectedOutputs = Array.isArray(phase.expectedOutput)
      ? phase.expectedOutput
      : [phase.expectedOutput];
    const markdownOutput = expectedOutputs.length === 1
      && /\.(?:md|markdown)$/i.test(expectedOutputs[0])
      ? expectedOutputs[0].replace(/^@?outputs\//, '')
      : null;
    return {
      goal: phase.mission,
      constraints,
      deliverable: `Research however works — search, curl known URLs, archives, forums, coding_run, scripts — every fetch leaves a receipt and your work streams to the Brain as it happens. Journal findings with remember and write_file the FINISHED phase receipt at ${expectedOutputs.join(', ')}. Call finish only when that exact receipt contains completed work — the drill continues after you. Progress notes, empty findings, another phase's file, and hidden /tmp dumps cannot close this phase.`,
      expectedOutput: phase.expectedOutput,
      writeupPath: markdownOutput,
      writeFirst: alreadyHasTape || operatorRequestsWrite,
      executionKind: 'tool_loop',
      claimedBy: 'launch_loop'
    };
  }

  // ── Steering notes ─────────────────────────────────────────────────────

  /**
   * Operator notes persist on disk. Every new worker reads the whole
   * notes.jsonl — they are not one-shot consume. Later bits still see
   * the operator's steering.
   */
  async readNotes() {
    const notes = await readPersistedNotes(path.join(this.drillDir, 'notes.jsonl'));
    for (const note of notes) {
      await this.journal('note_delivered', {
        noteId: note.id || null,
        text: note.text
      });
      this.emitEvent('drill_note_delivered', {
        message: `Operator note delivered: ${String(note.text).slice(0, 160)}`
      });
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
    let liveStreamIds = new Set();
    try {
      const acknowledgements = await fsp.readFile(
        path.join(this.runtimePath, 'outputs', STREAM_BRAIN_ACK_FILE),
        'utf8'
      );
      liveStreamIds = new Set(acknowledgements.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(row => row?.brain === 'live' && row.id).map(row => row.id));
    } catch { /* pre-ack run */ }
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
      if (row.brain === 'live' || (row.streamId && liveStreamIds.has(row.streamId))) {
        continue; // already in the Brain via the live stream or crash replay
      }
      if (memory && typeof memory.addNode === 'function') {
        try {
          await memory.addNode(row.content, 'drill_finding', null, {
            source: 'drill',
            streamId: row.streamId || null,
            cycle: row.cycle ?? null,
            workerId: row.workerId ?? null,
            goalNumber: row.goalNumber ?? null,
            phaseNumber: row.phaseNumber ?? null
          });
          if (row.streamId) {
            await fsp.appendFile(
              path.join(this.runtimePath, 'outputs', STREAM_BRAIN_ACK_FILE),
              `${JSON.stringify({
                id: row.streamId,
                at: this.now(),
                brain: 'live',
                replayed: 'candidate_harvest'
              })}\n`
            );
            liveStreamIds.add(row.streamId);
          }
          this.brainWrites += 1;
        } catch (err) {
          this.logger?.warn?.('Drill brain write failed — candidate stays journaled', { error: err.message });
        }
      }
    }
    return harvested;
  }

  // ── End of the drill ───────────────────────────────────────────────────

  async completePlanState(reason) {
    const stateStore = this.orchestrator?.clusterStateStore;
    if (!stateStore) return;
    const completedAt = this.now();
    const artifacts = listWriteups(this.runtimePath);
    try {
      if (typeof stateStore.completeTask === 'function') {
        await stateStore.completeTask('task:research', {
          completedAt,
          artifacts,
          producedArtifacts: artifacts,
          completionReason: reason
        });
      }
      if (typeof stateStore.upsertMilestone === 'function') {
        const existing = typeof stateStore.getMilestone === 'function'
          ? await stateStore.getMilestone('ms:research')
          : null;
        await stateStore.upsertMilestone({
          ...(existing || {}),
          id: 'ms:research',
          planId: 'plan:main',
          title: existing?.title || this.question,
          order: existing?.order || 1,
          status: 'COMPLETED',
          completedAt,
          updatedAt: completedAt
        });
      }
      if (typeof stateStore.updatePlan === 'function') {
        await stateStore.updatePlan('plan:main', {
          status: 'COMPLETED',
          completedAt,
          updatedAt: completedAt,
          completionReason: reason,
          producedArtifacts: artifacts
        });
      }
    } catch (error) {
      this.logger?.warn?.('Drill settled but plan-state closeout failed', {
        reason,
        error: error.message
      });
    }
  }

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
    await this.completePlanState(reason);
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

module.exports = {
  DrillLoop,
  DEFAULT_CYCLES,
  DEFAULT_WORKER_TURNS_PER_CYCLE,
  DEFAULT_MAX_CONCURRENT,
  fileSlug
};
