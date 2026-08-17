'use strict';

/**
 * ResearchEcology — the product behind Launch.
 *
 * COSMO is an autonomous research mind whose enduring product is a living,
 * evidence-grounded, queryable Brain. Launch starts this ecology, not one
 * agent that writes a doc and stops:
 *
 * - Four lanes (Directed, Adjacent, Wildcard, Incubation) are allocations of
 *   the run's cognitive budget and sum to 100. Active autonomy is
 *   Adjacent + Wildcard; Incubation is reported separately and never
 *   satisfies the autonomy floor. Autonomous exploration cannot silently
 *   decay to zero (Inv 13) — only an explicit human directed-override can
 *   suspend the reserve, and it restores at expiry.
 * - Questions are not tasks. The first question is given (origin=human);
 *   the ecology writes the next ones (specialist, default-mode, and dream
 *   cognition — Pure Mode provenance).
 * - Workers are the proven one-agent tool loop (model sees tools, decides,
 *   executes, loops). They emit candidates; they never write the Brain
 *   (Inv 4) and their finish never settles the run.
 * - Sleep/dream is a real transaction over the run's cognition (Inv 10).
 * - The Principal organizes; promotion is the only Brain change (Inv 14).
 * - Modes: awake -> sleep_dream -> awake ... -> settled. Rhythm shifts on
 *   cognitive signals (stagnation, saturation, fatigue), not a fixed cycle
 *   count alone. Settled means the Brain stays queryable and no research
 *   process keeps running.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { LaunchLoop } = require('../agent/loop');
const { EcologyJournal } = require('./journal');
const { QuestionEcology, countsTowardAutonomy } = require('./questions');
const { PromotionGate } = require('./promotion');
const { Principal, extractJson } = require('./principal');
const { Metabolism } = require('./metabolism');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const LANE_NAMES = ['directed', 'adjacent', 'wildcard', 'incubation'];

const LANE_DEFAULTS = {
  directed: 50,
  adjacent: 20,
  wildcard: 15,
  incubation: 15
};

const DEFAULT_AUTONOMY_FLOOR = 25; // percent of budget: Adjacent + Wildcard
const DEFAULT_BUDGET_TURNS = 120;
const DEFAULT_SLEEP_AFTER_EXPEDITIONS = 2;
const DEFAULT_WORKER_MAX_TURNS = 30;
const MIN_WORKER_TURNS = 4;

/**
 * Normalize lane allocations to sum to 100 and enforce the autonomy floor.
 * Returns { lanes, enforced, override } — enforcement is journaled by the
 * caller so autonomy can never silently decay to zero.
 */
function normalizeLanes(rawLanes = {}, options = {}) {
  const floor = Number.isFinite(Number(options.autonomyFloor))
    ? Math.max(0, Number(options.autonomyFloor))
    : DEFAULT_AUTONOMY_FLOOR;
  const override = options.directedOverride && options.directedOverride.reason
    ? {
      reason: String(options.directedOverride.reason),
      mission: options.directedOverride.mission || null,
      expiresAtTurns: Number(options.directedOverride.expiresAtTurns) || null
    }
    : null;

  const lanes = {};
  let anyProvided = false;
  for (const lane of LANE_NAMES) {
    const value = Number(rawLanes[lane]);
    if (Number.isFinite(value) && value >= 0) {
      lanes[lane] = value;
      anyProvided = true;
    } else {
      lanes[lane] = LANE_DEFAULTS[lane];
    }
  }
  if (!anyProvided) {
    return { lanes: { ...LANE_DEFAULTS }, enforced: false, override, autonomyFloor: floor };
  }

  // Scale to 100.
  const total = LANE_NAMES.reduce((sum, lane) => sum + lanes[lane], 0);
  if (total <= 0) {
    return { lanes: { ...LANE_DEFAULTS }, enforced: true, override, autonomyFloor: floor };
  }
  for (const lane of LANE_NAMES) {
    lanes[lane] = (lanes[lane] / total) * 100;
  }

  let enforced = false;
  const activeAutonomy = lanes.adjacent + lanes.wildcard;
  if (activeAutonomy < floor && !override) {
    // Autonomy cannot silently decay to zero (or below the floor). Restore
    // the reserve by taking the shortfall from Directed.
    const shortfall = floor - activeAutonomy;
    const takeable = Math.max(0, lanes.directed - 10);
    const taken = Math.min(shortfall, takeable);
    lanes.directed -= taken;
    const half = taken / 2;
    lanes.adjacent += half;
    lanes.wildcard += half;
    enforced = true;
  }

  for (const lane of LANE_NAMES) {
    lanes[lane] = Math.round(lanes[lane] * 100) / 100;
  }
  const rounded = LANE_NAMES.reduce((sum, lane) => sum + lanes[lane], 0);
  lanes.directed = Math.round((lanes.directed + (100 - rounded)) * 100) / 100;

  return { lanes, enforced, override, autonomyFloor: floor };
}

function expeditionId() {
  return `exp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

class ResearchEcology {
  constructor(options = {}) {
    this.config = options.config || {};
    this.orchestrator = options.orchestrator || null;
    this.logger = options.logger || console;
    this.client = options.client || null;
    this.plan = options.plan || null;

    const ecologyConfig = this.config.ecology || {};
    const normalized = normalizeLanes(ecologyConfig.lanes, {
      autonomyFloor: ecologyConfig.autonomyFloor,
      directedOverride: ecologyConfig.directedOverride
    });
    this.lanes = normalized.lanes;
    this.laneEnforcement = normalized;
    this.autonomyFloor = normalized.autonomyFloor;
    this.directedOverride = normalized.override;

    this.budgetTurns = Number(ecologyConfig.budgetTurns) > 0
      ? Number(ecologyConfig.budgetTurns)
      : (Number(options.budgetTurns) > 0 ? Number(options.budgetTurns) : DEFAULT_BUDGET_TURNS);
    this.sleepAfterExpeditions = Number(ecologyConfig.sleepAfterExpeditions) > 0
      ? Number(ecologyConfig.sleepAfterExpeditions)
      : (Number(options.sleepAfterExpeditions) > 0 ? Number(options.sleepAfterExpeditions) : DEFAULT_SLEEP_AFTER_EXPEDITIONS);
    this.workerMaxTurns = Number(ecologyConfig.workerMaxTurns) > 0
      ? Number(ecologyConfig.workerMaxTurns)
      : DEFAULT_WORKER_MAX_TURNS;

    this.createWorker = options.createWorker || ((args) => new LaunchLoop(args));

    // LaunchLoop-compatible surface: Watch and the planner read these.
    this.running = false;
    this.started = false;
    this.finished = false;
    this.finishSummary = null;
    this.turns = 0;
    this.fatalError = null;
    this.productLoop = RESEARCH_PRODUCT_LOOP;
    this._promise = null;

    this.mode = 'awake';
    this.settledReason = null;
    this.seedQuestionId = null;
    this.currentWorker = null;
    this.laneSpend = { directed: 0, adjacent: 0, wildcard: 0, incubation: 0 };
    this.expeditions = [];
    this.expeditionsSinceSleep = 0;
    this.sleepCount = 0;
    this.lastWakeBriefing = null;
    this.lastExpeditionCandidates = null;

    const runtimePath = this.runtimePath;
    this.journal = options.journal || new EcologyJournal(runtimePath, this.logger);
    this.questions = options.questions || new QuestionEcology(runtimePath, this.logger);
    this.promotionGate = options.promotionGate || new PromotionGate(runtimePath, this.logger);
    this.principal = options.principal || new Principal({
      client: this.client,
      config: this.config,
      logger: this.logger
    });
    this.metabolism = options.metabolism || new Metabolism({
      runtimePath,
      questions: this.questions,
      promotionGate: this.promotionGate,
      principal: this.principal,
      journal: this.journal,
      client: this.client,
      config: this.config,
      logger: this.logger
    });
  }

  get runtimePath() {
    return this.orchestrator?.logsDir
      || this.orchestrator?.runtimePath
      || this.config?.logsDir
      || process.env.COSMO_RUNTIME_PATH
      || process.cwd();
  }

  get memory() {
    return this.orchestrator?.memory || null;
  }

  // ── LaunchLoop-compatible lifecycle ────────────────────────────────────

  start() {
    if (this.running) {
      return { started: true, reused: true, productLoop: RESEARCH_PRODUCT_LOOP };
    }
    this.running = true;
    this.started = true;
    this.finished = false;
    this.mode = 'awake';
    this.logger?.info?.('Research ecology starting', {
      productLoop: RESEARCH_PRODUCT_LOOP,
      lanes: this.lanes,
      budgetTurns: this.budgetTurns,
      goal: this.plan?.shortPlan?.goal || this.plan?.goal || this.plan?.title || null
    });
    this._promise = this.run().catch(async (err) => {
      if (isFatalAuthError(err)) {
        await this.stopFatalAuth(err);
        return;
      }
      this.logger?.error?.('Research ecology failed', { error: err.message, stack: err.stack });
      this.running = false;
      this.mode = 'error';
      await this.persistState().catch(() => {});
    });
    return { started: true, reused: false, productLoop: RESEARCH_PRODUCT_LOOP };
  }

  stop() {
    this.running = false;
    if (this.currentWorker && typeof this.currentWorker.stop === 'function') {
      this.currentWorker.stop();
    }
    this.logger?.info?.('Research ecology stopped', { turns: this.turns, mode: this.mode });
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
      turns: this.turns
    });
    this.emitEvent('launch_loop_error', {
      fatal: true,
      errorType: 'authentication_error',
      message: AUTH_REVOKED_WATCH_MESSAGE
    });
    await this.journal.append('ecology_fatal_auth', { detail: detailText }).catch(() => {});
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
        : (this.mode === 'settled' ? 'settled' : (this.running ? 'running' : 'stopped')),
      ecology: this.snapshot()
    };
  }

  snapshot() {
    const questionSummary = this.questions?.questions
      ? this.questions.summary()
      : { total: 0, byStatus: {}, byOrigin: {}, autonomous: 0 };
    return {
      mode: this.mode,
      lanes: LANE_NAMES.map((lane) => ({
        lane,
        allocation: this.lanes[lane],
        spentTurns: this.laneSpend[lane],
        spentPct: this.budgetTurns > 0
          ? Math.round((this.laneSpend[lane] / this.budgetTurns) * 10000) / 100
          : 0
      })),
      autonomyFloor: this.autonomyFloor,
      autonomyEnforced: this.laneEnforcement?.enforced === true,
      directedOverride: this.directedOverride,
      budget: { totalTurns: this.budgetTurns, spentTurns: this.turns },
      questions: questionSummary,
      seedQuestionId: this.seedQuestionId,
      expeditions: this.expeditions.slice(-20),
      sleep: {
        count: this.sleepCount,
        expeditionsSinceSleep: this.expeditionsSinceSleep,
        lastWakeBriefing: this.lastWakeBriefing
      },
      settledReason: this.settledReason,
      fatalError: this.fatalError,
      updatedAt: Date.now()
    };
  }

  emitEvent(type, payload = {}) {
    try {
      const emitter = this.orchestrator?._getEvents?.();
      if (emitter && typeof emitter.emitEvent === 'function') {
        emitter.emitEvent(type, { type, ...payload });
      }
    } catch { /* Watch still has engine logs */ }
  }

  async persistState() {
    const file = path.join(this.runtimePath, 'ecology', 'state.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.snapshot(), null, 2));
    await fsp.rename(tmp, file);
  }

  // ── The ecology run ────────────────────────────────────────────────────

  async run() {
    await this.journal.load();
    await this.questions.load();

    await this.seedEcology();
    await this.journal.append('ecology_started', {
      lanes: this.lanes,
      autonomyFloor: this.autonomyFloor,
      budgetTurns: this.budgetTurns,
      seedQuestionId: this.seedQuestionId
    });
    if (this.laneEnforcement?.enforced) {
      await this.journal.append('autonomy_floor_enforced', {
        lanes: this.lanes,
        autonomyFloor: this.autonomyFloor,
        note: 'Autonomous exploration cannot silently decay to zero.'
      });
    }
    if (this.directedOverride) {
      await this.journal.append('directed_override_active', this.directedOverride);
    }
    this.emitEvent('ecology_mode', { mode: this.mode, lanes: this.lanes });
    await this.persistState();

    while (this.running) {
      if (this.turns >= this.budgetTurns) {
        await this.settle('budget_exhausted');
        break;
      }

      const sleepSignals = this.sleepSignals();
      if (sleepSignals.due) {
        await this.sleep(sleepSignals);
        continue;
      }

      const expedition = await this.nextExpedition();
      if (!expedition) {
        const decided = await this.considerSettle();
        if (decided) break;
        if (this.expeditionsSinceSleep > 0) {
          await this.sleep({ due: true, reasons: ['no_eligible_expedition'] });
          continue;
        }
        await this.settle('no_eligible_work');
        break;
      }

      await this.runExpedition(expedition);
      if (this.fatalError) break;
      await this.reflect(expedition);
      if (this.fatalError) break;
      await this.persistState();
    }

    if (this.running && !this.fatalError && this.mode !== 'settled') {
      await this.settle('run_loop_exited');
    }
    this.running = false;
  }

  async seedEcology() {
    // The first question is given (origin=human, preauthored). Pure Mode:
    // everything after it is written by the ecology's own cognition.
    const existing = this.questions.list().find((question) => question.origin === 'human');
    if (existing) {
      this.seedQuestionId = existing.id;
      return existing;
    }
    const short = this.plan?.shortPlan || this.plan || {};
    const text = short.goal
      || this.config?.architecture?.roleSystem?.guidedFocus?.domain
      || 'Research the stated topic';
    const why = Array.isArray(short.constraints) && short.constraints.length
      ? short.constraints.join(' | ')
      : (this.config?.architecture?.roleSystem?.guidedFocus?.context || null);
    const seed = await this.questions.create({
      text,
      origin: 'human',
      lane: 'directed',
      why,
      provenance: { originatedBy: 'human', preauthored: true },
      status: 'new'
    });
    this.seedQuestionId = seed.id;
    await this.journal.append('question_created', {
      questionId: seed.id, origin: 'human', lane: 'directed', preauthored: true
    });
    this.emitEvent('question_created', { questionId: seed.id, origin: 'human', text: seed.text });
    return seed;
  }

  laneDeficit(lane) {
    const allocationTurns = (this.lanes[lane] / 100) * this.budgetTurns;
    return allocationTurns - this.laneSpend[lane];
  }

  eligibleQuestion(lane) {
    const openStatuses = new Set(['new', 'active', 'revived', 'partially_answered']);
    const candidates = this.questions.list().filter((question) => openStatuses.has(question.status));
    if (lane === 'directed') {
      return candidates.find((question) =>
        question.lane === 'directed' || question.origin === 'human' || question.origin === 'principal') || null;
    }
    // Adjacent/Wildcard require autonomy provenance: originated by
    // specialist, default-mode, or dream cognition, not preauthored.
    return candidates.find((question) => question.lane === lane && countsTowardAutonomy(question)) || null;
  }

  async nextExpedition() {
    const workerLanes = ['directed', 'adjacent', 'wildcard'];
    const ranked = workerLanes
      .map((lane) => ({ lane, deficit: this.laneDeficit(lane) }))
      .filter((entry) => entry.deficit >= MIN_WORKER_TURNS)
      .sort((a, b) => b.deficit - a.deficit);

    for (const { lane, deficit } of ranked) {
      const question = this.eligibleQuestion(lane);
      if (!question) continue;
      const maxTurns = Math.max(MIN_WORKER_TURNS, Math.min(
        Math.floor(deficit),
        this.workerMaxTurns,
        this.budgetTurns - this.turns
      ));
      if (maxTurns < MIN_WORKER_TURNS) continue;
      return { id: expeditionId(), lane, question, maxTurns };
    }
    return null;
  }

  buildWorkerPlan(expedition) {
    const short = this.plan?.shortPlan || this.plan || {};
    const constraints = [];
    if (Array.isArray(short.constraints)) constraints.push(...short.constraints);
    if (expedition.lane === 'adjacent') {
      constraints.push('This is an ADJACENT-lane inquiry: a nearby question the ecology raised itself. Challenge or improve the main answer.');
    } else if (expedition.lane === 'wildcard') {
      constraints.push('This is a WILDCARD-lane inquiry: bounded exploration for novelty, weak signals, or cross-domain potential.');
    }
    const deliverable = expedition.lane === 'directed'
      ? (short.deliverable || 'Write the research into this run. Leave a concrete artifact in outputs/.')
      : 'Journal findings with remember (candidates, not truth). Leave any artifact in outputs/.';
    return {
      shortPlan: {
        goal: expedition.question.text,
        constraints,
        deliverable,
        executionKind: 'tool_loop',
        claimedBy: 'launch_loop'
      }
    };
  }

  async runExpedition(expedition) {
    await this.questions.activate(expedition.question.id, { by: 'ecology', reason: 'expedition_started' });
    await this.journal.append('expedition_started', {
      expeditionId: expedition.id,
      lane: expedition.lane,
      questionId: expedition.question.id,
      questionOrigin: expedition.question.origin,
      countsTowardAutonomy: countsTowardAutonomy(expedition.question),
      maxTurns: expedition.maxTurns
    });
    this.emitEvent('expedition_started', {
      expeditionId: expedition.id,
      lane: expedition.lane,
      question: expedition.question.text
    });

    const candidatesBefore = await this.metabolism.candidatesLength();

    const worker = this.createWorker({
      orchestrator: this.orchestrator,
      config: this.config,
      logger: this.logger,
      client: this.client,
      plan: this.buildWorkerPlan(expedition),
      maxTurns: expedition.maxTurns,
      expedition: {
        id: expedition.id,
        lane: expedition.lane,
        questionId: expedition.question.id
      }
    });
    this.currentWorker = worker;
    worker.start();
    if (worker._promise) {
      await worker._promise;
    }
    this.currentWorker = null;

    // A worker that errored before its first turn still spends one budget
    // turn — a lane can never spin free forever on a broken worker.
    const turnsUsed = Math.max(1, Number(worker.turns) || 0);
    this.turns += turnsUsed;
    this.laneSpend[expedition.lane] += turnsUsed;

    const candidatesAfter = await this.metabolism.candidatesLength();
    this.lastExpeditionCandidates = candidatesAfter > candidatesBefore ? 1 : 0;

    const record = {
      expeditionId: expedition.id,
      lane: expedition.lane,
      questionId: expedition.question.id,
      turnsUsed,
      workerFinished: worker.finished === true,
      workerSummary: worker.finishSummary || null,
      emittedCandidates: candidatesAfter > candidatesBefore
    };
    this.expeditions.push(record);
    this.expeditionsSinceSleep += 1;

    if (worker.fatalError) {
      await this.stopFatalAuth(worker.fatalError);
      return record;
    }

    // A worker's finish is a completion PROPOSAL for its own mission. It
    // does not close the question and it does not settle the run.
    await this.journal.append('worker_completion_proposal', record);
    this.emitEvent('expedition_completed', record);
    this.logger?.info?.('Expedition completed — run continues while lanes and questions remain', record);
    return record;
  }

  /**
   * Default-mode/specialist reflection after an expedition: the ecology
   * writes its own next questions (Pure Mode). These carry autonomy
   * provenance — originated by specialist cognition, not preauthored.
   */
  async reflect(expedition) {
    if (!this.client || typeof this.client.createCompletion !== 'function') return;
    const recent = this.expeditions[this.expeditions.length - 1];
    const system = [
      'You are a specialist researcher reflecting after an expedition (default-mode cognition).',
      'Given the expedition question, propose up to 3 NEW research questions this ecology',
      'should pursue on its own: nearby questions that challenge or deepen the answer',
      '(adjacent), bounded novelty or cross-domain probes (wildcard), or slow questions',
      'worth incubating (incubation). Do not restate the original question.',
      'Reply as JSON only: {"questions":[{"text":"...","lane":"adjacent|wildcard|incubation","why":"..."}]}'
    ].join('\n');
    const user = [
      `Expedition question (${expedition.lane}): ${expedition.question.text}`,
      recent?.workerSummary ? `Worker summary: ${String(recent.workerSummary).slice(0, 400)}` : null,
      `Open questions so far: ${this.questions.list().length}`
    ].filter(Boolean).join('\n');

    let parsed = null;
    try {
      const response = await this.client.createCompletion({
        model: this.config.models?.fast || this.config.models?.primary,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.7,
        maxTokens: 600
      });
      if (isFatalAuthError(response)) {
        await this.stopFatalAuth(response);
        return;
      }
      parsed = extractJson(response?.choices?.[0]?.message?.content);
    } catch (err) {
      if (isFatalAuthError(err)) {
        await this.stopFatalAuth(err);
        return;
      }
      await this.journal.append('reflection_unavailable', { error: err.message });
      return;
    }
    if (!parsed || !Array.isArray(parsed.questions)) return;

    for (const proposal of parsed.questions.slice(0, 3)) {
      if (!proposal?.text) continue;
      const lane = ['adjacent', 'wildcard', 'incubation'].includes(proposal.lane) ? proposal.lane : 'adjacent';
      const question = await this.questions.create({
        text: proposal.text,
        origin: 'specialist',
        lane,
        why: proposal.why || null,
        parents: [expedition.question.id],
        provenance: {
          originatedBy: 'specialist',
          preauthored: false,
          expeditionId: expedition.id
        },
        status: lane === 'incubation' ? 'incubating' : 'new'
      });
      await this.journal.append('question_created', {
        questionId: question.id,
        origin: 'specialist',
        lane,
        parents: question.parents,
        countsTowardAutonomy: countsTowardAutonomy(question)
      });
      this.emitEvent('question_created', {
        questionId: question.id, origin: 'specialist', lane, text: question.text
      });
    }
  }

  sleepSignals() {
    const reasons = [];
    if (this.expeditionsSinceSleep >= this.sleepAfterExpeditions) {
      reasons.push('expedition_fatigue');
    }
    if (this.expeditionsSinceSleep > 0 && this.lastExpeditionCandidates === 0) {
      reasons.push('stagnation');
    }
    return { due: reasons.length > 0, reasons };
  }

  async sleep(signals = { reasons: [] }) {
    this.mode = 'sleep_dream';
    await this.journal.append('sleep_started', { signals: signals.reasons, turns: this.turns });
    this.emitEvent('sleep_started', { signals: signals.reasons });
    await this.persistState();

    const seedQuestion = this.seedQuestionId ? this.questions.get(this.seedQuestionId) : null;
    let result;
    try {
      result = await this.metabolism.run({ memory: this.memory, seedQuestion });
    } catch (err) {
      if (isFatalAuthError(err)) {
        await this.stopFatalAuth(err);
        return;
      }
      throw err;
    }

    this.sleepCount += 1;
    this.expeditionsSinceSleep = 0;
    const turnsUsed = Number(result?.turnsUsed) || 0;
    this.turns += turnsUsed;
    this.laneSpend.incubation += turnsUsed;
    if (result?.briefingPath) this.lastWakeBriefing = path.basename(result.briefingPath);

    await this.journal.append('wake', {
      committed: result?.committed === true,
      commitId: result?.commit?.commitId || null,
      promotions: result?.commit?.promotionsApplied || 0,
      dreamQuestions: result?.dreamQuestions?.length || 0,
      reason: result?.reason || null
    });
    this.emitEvent('wake', {
      committed: result?.committed === true,
      promotions: result?.commit?.promotionsApplied || 0,
      dreamCandidates: result?.commit?.dreamCandidateIds?.length || 0
    });

    this.mode = 'awake';
    await this.persistState();
  }

  async considerSettle() {
    const seedQuestion = this.seedQuestionId ? this.questions.get(this.seedQuestionId) : null;
    let proposal = null;
    try {
      proposal = await this.principal.assessSettle({
        seedQuestion,
        questions: this.questions.list(),
        budget: { spentTurns: this.turns, totalTurns: this.budgetTurns }
      });
    } catch (err) {
      if (isFatalAuthError(err)) {
        await this.stopFatalAuth(err);
        return true;
      }
    }
    if (!proposal) return false;
    await this.journal.append('principal_decision', proposal);
    await this.settle('principal_settle_proposal', proposal);
    return true;
  }

  /**
   * Settled/Dormant: the Brain stays queryable; no research process must
   * stay alive. Questions and incubations remain resumable state.
   */
  async settle(reason, decision = null) {
    if (this.mode === 'settled') return;

    // One final sleep transaction so unconsolidated candidates get their
    // metabolism treatment before dormancy (bounded: skipped when nothing
    // new was journaled since the last commit).
    try {
      const last = await this.metabolism.lastCommit();
      const pending = (await this.metabolism.candidatesLength()) > (last?.candidatesHighWaterMark || 0);
      if (pending && !this.fatalError) {
        await this.sleep({ due: true, reasons: ['settle_consolidation'] });
      }
    } catch { /* settle proceeds; evidence stays journaled */ }
    if (this.fatalError) return;

    this.mode = 'settled';
    this.settledReason = reason;
    this.finished = true;
    this.finishSummary = `Settled: ${reason}`;
    this.running = false;

    await this.journal.append('settled', {
      reason,
      decisionId: decision?.id || null,
      turns: this.turns,
      laneSpend: this.laneSpend,
      questions: this.questions.summary(),
      sleepCount: this.sleepCount
    });
    this.emitEvent('ecology_settled', { reason, turns: this.turns });
    await this.persistState();
    this.logger?.info?.('Research ecology settled — Brain stays queryable, no research process keeps running', {
      reason,
      turns: this.turns,
      sleepCount: this.sleepCount
    });

    // Ask the orchestrator to close out the run so the process can exit.
    // The saved Brain remains queryable from the server.
    if (this.orchestrator && typeof this.orchestrator.requestRunCompletion === 'function') {
      try {
        this.orchestrator.requestRunCompletion('ecology_settled', { id: 'plan:main', title: this.plan?.shortPlan?.goal }, 'ecology');
      } catch (err) {
        this.logger?.warn?.('Run completion request failed after settle', { error: err.message });
      }
    }
  }
}

module.exports = {
  ResearchEcology,
  normalizeLanes,
  LANE_NAMES,
  LANE_DEFAULTS,
  DEFAULT_AUTONOMY_FLOOR,
  DEFAULT_BUDGET_TURNS
};
