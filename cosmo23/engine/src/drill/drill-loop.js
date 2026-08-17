'use strict';

/**
 * The Cosmo research drill.
 *
 * Cosmo at heart is a drill that keeps drilling for the cycles or the time
 * specified. Cycles and time are how long the drill is allowed to run — they
 * are not the work. The work is:
 *
 *   invent / take a GOAL
 *     -> work it through its PHASES (each phase worked by the tool-loop bit)
 *     -> when the goal is done, CREATE THE NEXT GOAL
 *     -> keep going until cycles or time are spent, or the human stops it
 *
 * One drill cycle = one descent of the bit: a worker tool loop (model sees
 * tools, decides, executes, loops) on the current phase. A worker finishing
 * a writeup completes a phase or a hole — never the goal chain, never the
 * drill. Interactive is chat only. Query asks the Brain afterwards.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { LaunchLoop } = require('../agent/loop');
const { FORBIDDEN_PLAN_PHRASES } = require('../agent/short-plan');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const DEFAULT_CYCLES = 80;
const DEFAULT_WORKER_TURNS_PER_CYCLE = 24;
const MAX_PHASES_PER_GOAL = 4;

function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function containsForbiddenPhrase(value) {
  const blob = JSON.stringify(value || '').toLowerCase();
  return FORBIDDEN_PLAN_PHRASES.some((phrase) => blob.includes(phrase.toLowerCase()));
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
    this.currentWorker = null;
    this.currentActivity = null;
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
      timeBudgetMinutes: this.timeBudgetMs ? this.timeBudgetMs / 60000 : null
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
    if (this.currentWorker && typeof this.currentWorker.stop === 'function') {
      this.currentWorker.stop();
    }
    this.logger?.info?.('Drill stopped', { cyclesUsed: this.cyclesUsed, mode: this.mode });
  }

  async stopFatalAuth(detail) {
    this.running = false;
    this.mode = 'error';
    this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
    if (this.currentWorker && typeof this.currentWorker.stop === 'function') {
      this.currentWorker.stop();
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

  // ── Budgets ────────────────────────────────────────────────────────────

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
          summary: phase.summary || null
        }))
      } : null,
      goalHistory: this.goalHistory.slice(-10).map((goal) => ({
        number: goal.number,
        title: goal.title,
        status: goal.status,
        completedAt: goal.completedAt || null
      })),
      currentActivity: this.currentActivity,
      counts: {
        goalsCompleted: this.goalHistory.filter((goal) => goal.status === 'completed').length,
        brainWrites: this.brainWrites
      },
      degradedGoalGeneration: this.degradedGoalGeneration,
      startedAt: this.startedAtMs,
      updatedAt: this.now()
    };
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

  // ── The drill run ──────────────────────────────────────────────────────

  async run() {
    await this.loadResumableState();
    await this.journal('drill_started', {
      question: this.question,
      cyclesTotal: this.cyclesTotal,
      timeBudgetMs: this.timeBudgetMs,
      resumedGoal: this.currentGoal ? this.currentGoal.number : null
    });
    this.emitEvent('drill_started', {
      question: this.question,
      cycles: this.cyclesTotal,
      timeBudgetMs: this.timeBudgetMs
    });
    await this.persistState();

    while (this.running) {
      const exhausted = this.budgetExhaustedReason();
      if (exhausted) {
        await this.finishDrill(exhausted);
        return;
      }

      if (!this.currentGoal || this.currentGoal.status === 'completed') {
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
        this.emitEvent('drill_goal_created', {
          number: goal.number, title: goal.title, phases: goal.phases.length,
          message: `Goal ${goal.number}: ${goal.title}`
        });
        await this.persistState();
        continue;
      }

      const phase = this.currentGoal.phases.find((entry) => entry.status !== 'done');
      if (!phase) {
        await this.completeGoal(this.currentGoal);
        continue;
      }

      await this.runCycle(this.currentGoal, phase);
      if (this.fatalError) return;
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
            cyclesUsed: phase.cyclesUsed || 0
          })),
          createdAt: this.now()
        };
      }
      if (Array.isArray(saved?.goalHistory)) {
        this.goalHistory = saved.goalHistory.map((goal) => ({
          number: goal.number, title: goal.title, status: goal.status || 'completed',
          completedAt: goal.completedAt || null
        }));
      }
    } catch { /* fresh run */ }
  }

  // ── Goals ──────────────────────────────────────────────────────────────

  async nextGoal(previousGoal) {
    const number = previousGoal ? previousGoal.number + 1 : (this.goalHistory.length + 1);
    const origin = previousGoal || this.goalHistory.length > 0 ? 'chain' : 'seed';

    let spec = null;
    try {
      spec = await this.composeGoalSpec({ previousGoal, number, origin });
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      this.logger?.warn?.('Goal generation failed — using deterministic fallback', { error: err.message });
    }

    if (!spec) {
      // Degraded-honest fallback: the drill keeps drilling on the question
      // rather than dying because one planning call failed.
      this.degradedGoalGeneration = true;
      spec = {
        title: origin === 'seed'
          ? this.question
          : `Go deeper on ${this.question} (round ${number})`,
        why: origin === 'seed'
          ? 'Seed goal from the launch question.'
          : 'Continue the drill beyond completed rounds without repeating finished work.',
        phases: [{
          title: origin === 'seed' ? 'Research and write up' : `Deepen round ${number}`,
          mission: origin === 'seed'
            ? `${this.question}${this.questionContext ? ` — ${this.questionContext}` : ''}`
            : `Advance the research on "${this.question}" beyond what earlier goals covered. Do not repeat completed work. Find what is missing, verify what is weak, and write it up.`
        }]
      };
    }

    return {
      id: shortId('goal'),
      number,
      title: spec.title,
      why: spec.why || null,
      origin,
      status: 'active',
      previousGoalId: previousGoal?.id || null,
      phases: spec.phases.slice(0, MAX_PHASES_PER_GOAL).map((phase, index) => ({
        id: shortId('phase'),
        number: index + 1,
        title: phase.title,
        mission: phase.mission || phase.title,
        status: 'pending',
        summary: null,
        cyclesUsed: 0
      })),
      createdAt: this.now()
    };
  }

  async composeGoalSpec({ previousGoal, number, origin }) {
    if (!this.client || typeof this.client.createCompletion !== 'function') return null;

    const completedSummaries = this.goalHistory
      .filter((goal) => goal.status === 'completed')
      .slice(-5)
      .map((goal) => `- Goal ${goal.number}: ${goal.title}`);
    const previousPhases = previousGoal
      ? previousGoal.phases.map((phase) => `- ${phase.title}: ${String(phase.summary || 'done').slice(0, 160)}`)
      : [];

    const system = [
      'You are Cosmo, an autonomous research drill. You define research GOALS with concrete PHASES.',
      'A goal is one round of the drill; each phase is one hole the tool-loop worker drills',
      '(searching, reading, verifying, writing artifacts). Rules:',
      '- 1 to 4 phases, each a concrete executable mission, not a vague theme.',
      '- Never tell the worker to review or inventory what is already here.',
      '- Never repeat completed work; go deeper, wider, or into what is missing.',
      'Reply as JSON only: {"title":"...","why":"...","phases":[{"title":"...","mission":"..."}]}'
    ].join('\n');

    const user = [
      `Research question: ${this.question}`,
      this.questionContext ? `Context: ${this.questionContext}` : null,
      origin === 'seed'
        ? 'Define the FIRST goal of the drill.'
        : `Goal ${number - 1} is complete. Define goal ${number} — the NEXT goal that advances the research.`,
      completedSummaries.length ? `Completed goals so far:\n${completedSummaries.join('\n')}` : null,
      previousPhases.length ? `Phases just completed:\n${previousPhases.join('\n')}` : null
    ].filter(Boolean).join('\n\n');

    const response = await this.client.createCompletion({
      model: this.config.models?.fast || this.config.models?.primary,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.5,
      maxTokens: 900
    });
    if (isFatalAuthError(response)) {
      const err = new Error('Goal generation failed: authentication_error');
      err.type = 'authentication_error';
      throw err;
    }

    const parsed = extractJson(response?.choices?.[0]?.message?.content);
    if (!parsed?.title || !Array.isArray(parsed.phases) || parsed.phases.length === 0) return null;
    if (containsForbiddenPhrase(parsed)) {
      this.logger?.warn?.('Goal spec contained a forbidden review-what-is-here phrase — rejected');
      return null;
    }
    const phases = parsed.phases.filter((phase) => phase?.title || phase?.mission);
    if (phases.length === 0) return null;
    return {
      title: String(parsed.title),
      why: parsed.why ? String(parsed.why) : null,
      phases: phases.map((phase) => ({
        title: String(phase.title || phase.mission),
        mission: String(phase.mission || phase.title)
      }))
    };
  }

  async completeGoal(goal) {
    goal.status = 'completed';
    goal.completedAt = this.now();
    this.goalHistory.push({
      number: goal.number,
      title: goal.title,
      status: 'completed',
      completedAt: goal.completedAt,
      phases: goal.phases.map((phase) => ({ title: phase.title, summary: phase.summary }))
    });
    await this.journal('goal_completed', {
      goalId: goal.id, number: goal.number, title: goal.title,
      cyclesUsed: goal.phases.reduce((sum, phase) => sum + phase.cyclesUsed, 0)
    });
    this.emitEvent('drill_goal_complete', {
      number: goal.number,
      title: goal.title,
      message: `Goal ${goal.number} complete: ${goal.title} — creating the next goal`
    });
    await this.persistState();
  }

  // ── Cycles: the bit descends ───────────────────────────────────────────

  async runCycle(goal, phase) {
    this.cyclesUsed += 1;
    phase.status = 'active';
    phase.cyclesUsed += 1;
    const cycle = this.cyclesUsed;

    const notes = await this.consumeNotes();
    this.currentActivity = {
      cycle,
      goalNumber: goal.number,
      goalTitle: goal.title,
      phaseNumber: phase.number,
      phaseTitle: phase.title,
      startedAt: this.now()
    };
    await this.journal('cycle_started', {
      cycle, goalId: goal.id, goalNumber: goal.number,
      phaseNumber: phase.number, phaseTitle: phase.title,
      notes: notes.map((note) => note.text)
    });
    this.emitEvent('drill_cycle_start', {
      cycle,
      remainingCycles: this.remainingCycles(),
      remainingMs: this.remainingMs(),
      message: `Cycle ${cycle}: goal ${goal.number} phase ${phase.number} — ${phase.title}`
    });
    await this.persistState();

    const candidatesBefore = await this.candidatesLength();

    const worker = this.createWorker({
      orchestrator: this.orchestrator,
      config: this.config,
      logger: this.logger,
      client: this.client,
      maxTurns: this.workerTurnsPerCycle,
      plan: { shortPlan: this.buildPhaseMission(goal, phase, notes) },
      drill: { cycle, goalId: goal.id, goalNumber: goal.number, phaseNumber: phase.number }
    });
    this.currentWorker = worker;
    worker.start();
    if (worker._promise) await worker._promise;
    this.currentWorker = null;

    this.turns += Math.max(1, Number(worker.turns) || 0);

    if (worker.fatalError) {
      await this.stopFatalAuth(worker.fatalError);
      return;
    }

    const harvested = await this.harvestCandidates(candidatesBefore, { goal, phase, cycle });

    if (worker.finished) {
      // The worker finished ITS hole: the phase is done. The drill continues.
      phase.status = 'done';
      phase.summary = worker.finishSummary || 'done';
      this.emitEvent('drill_phase_complete', {
        cycle,
        goalNumber: goal.number,
        phaseNumber: phase.number,
        message: `Phase ${phase.number} of goal ${goal.number} done: ${String(worker.finishSummary || '').slice(0, 160)}`
      });
    } else {
      this.emitEvent('drill_phase_continues', {
        cycle,
        goalNumber: goal.number,
        phaseNumber: phase.number,
        message: `Phase ${phase.number} of goal ${goal.number} continues next cycle`
      });
    }

    await this.journal('cycle_completed', {
      cycle,
      goalNumber: goal.number,
      phaseNumber: phase.number,
      workerFinished: worker.finished === true,
      workerTurns: worker.turns,
      workerSummary: worker.finishSummary || null,
      candidatesHarvested: harvested
    });
  }

  buildPhaseMission(goal, phase, notes) {
    const constraints = [];
    if (this.questionContext) constraints.push(this.questionContext);
    constraints.push(`Goal ${goal.number}: ${goal.title}${goal.why ? ` — ${goal.why}` : ''}`);
    if (goal.phases.length > 1) {
      constraints.push(`This is phase ${phase.number} of ${goal.phases.length}: ${phase.title}`);
    }
    const doneSummaries = goal.phases
      .filter((entry) => entry.status === 'done' && entry.summary)
      .map((entry) => `Phase ${entry.number} already done: ${String(entry.summary).slice(0, 120)}`);
    constraints.push(...doneSummaries);
    if (phase.cyclesUsed > 1) {
      constraints.push('This phase was started in an earlier cycle. Continue it; do not start over.');
    }
    for (const note of notes) {
      constraints.push(`Operator note: ${note.text}`);
    }
    return {
      goal: phase.mission,
      constraints,
      deliverable: 'Journal findings with remember and leave concrete artifacts in outputs/. Call finish when THIS phase\'s deliverable is done — the drill continues after you.',
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
   * After each cycle, journaled candidates from the bit are written into the
   * run's Brain so Query has something real to ask. Degraded-honest: a
   * failed embed/write leaves the candidate journaled on disk.
   */
  async harvestCandidates(fromByte, { goal, phase, cycle }) {
    const memory = this.orchestrator?.memory;
    let raw;
    try {
      raw = await fsp.readFile(path.join(this.runtimePath, 'outputs', 'candidates', 'findings.jsonl'), 'utf8');
    } catch {
      return 0;
    }
    const fresh = raw.slice(Math.max(fromByte, this.candidatesHarvestedBytes));
    this.candidatesHarvestedBytes = raw.length;
    if (!fresh.trim()) return 0;

    let harvested = 0;
    for (const line of fresh.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row?.content) continue;
      harvested += 1;
      if (memory && typeof memory.addNode === 'function') {
        try {
          await memory.addNode(row.content, 'drill_finding', null, {
            source: 'drill',
            cycle,
            goalNumber: goal.number,
            phaseNumber: phase.number
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

module.exports = { DrillLoop, DEFAULT_CYCLES, DEFAULT_WORKER_TURNS_PER_CYCLE };
