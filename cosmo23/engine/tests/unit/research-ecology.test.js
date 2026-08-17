'use strict';

/**
 * Research ecology contract (July 30 law book).
 *
 * Locks:
 * - Launch starts the ecology, not one finish-and-done loop.
 * - Four lanes are allocations of the cognitive budget and sum to 100;
 *   autonomous exploration cannot silently decay to zero (Inv 13).
 * - Questions are not tasks; a worker's finish does not close a question
 *   and does not settle the run.
 * - Pure Mode provenance: the first question is given; the ecology writes
 *   the next ones (specialist / default-mode / dream cognition).
 * - Sleep/dream is a transaction (Inv 10): pin parent, lease, replay,
 *   staged child, CAS commit or full rollback, wake briefing.
 * - Dreams cannot directly create sourced facts.
 * - Promotion is the only Brain change (Inv 4, Inv 14); workers may not
 *   promote their own output.
 * - Settled: Brain still queryable, no research process required alive.
 * - 401 / revoked OAuth is fatal after one error and tells Watch.
 */

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ResearchEcology,
  normalizeLanes,
  LANE_NAMES,
  LANE_DEFAULTS
} = require('../../src/ecology/ecology');
const { QuestionEcology, countsTowardAutonomy } = require('../../src/ecology/questions');
const { PromotionGate } = require('../../src/ecology/promotion');
const { Metabolism } = require('../../src/ecology/metabolism');
const { Principal } = require('../../src/ecology/principal');
const { EcologyJournal } = require('../../src/ecology/journal');
const { GuidedModePlanner } = require('../../src/core/guided-mode-planner');
const { executeTool } = require('../../src/agent/tools');
const { AUTH_REVOKED_WATCH_MESSAGE } = require('../../../lib/auth-error');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempRuntime(prefix = 'cosmo-ecology-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Scripted LLM client. Routes on the system prompt so one client serves the
 * worker reflection, dream, Principal wake review, and settle assessment.
 */
function scriptedClient(overrides = {}) {
  return {
    calls: [],
    async createCompletion({ messages }) {
      const system = messages?.[0]?.content || '';
      this.calls.push(system.slice(0, 60));
      if (/specialist researcher reflecting/i.test(system)) {
        if (overrides.reflection) return overrides.reflection();
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                questions: [
                  { text: 'What contemporaries disputed the main account?', lane: 'adjacent', why: 'challenge' },
                  { text: 'Does this pattern appear in an unrelated domain?', lane: 'wildcard', why: 'novelty' }
                ]
              })
            }
          }]
        };
      }
      if (/dreaming, default-mode cognition/i.test(system)) {
        if (overrides.dream) return overrides.dream();
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                hypotheses: ['The two source families may share one origin.'],
                questions: [{ text: 'Trace the shared origin of the two source families.', why: 'incubate' }],
                contradictions: []
              })
            }
          }]
        };
      }
      if (/Principal Researcher of an autonomous research mind/i.test(system)) {
        if (overrides.wakeReview) return overrides.wakeReview();
        // Promote the first worker candidate seen in the user message.
        const user = messages?.[1]?.content || '';
        const match = user.match(/id=(cand_[a-z0-9_]+)/i);
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                promotions: match
                  ? [{ candidateId: match[1], promoteAs: 'finding', rationale: 'evidence-backed' }]
                  : [],
                questionChanges: []
              })
            }
          }]
        };
      }
      if (/Decide whether this research run should settle/i.test(system)) {
        if (overrides.settle) return overrides.settle();
        return { choices: [{ message: { role: 'assistant', content: JSON.stringify({ settle: false }) } }] };
      }
      return { choices: [{ message: { role: 'assistant', content: '{}' } }] };
    }
  };
}

/**
 * Scripted worker: the one-agent tool loop shape without a model. Emits one
 * candidate through the real remember tool (provenance included) and then
 * proposes completion — exactly the jgbfable3 worker behavior.
 */
function scriptedWorkerFactory(runtimePath, { emitCandidate = true, fatalAuth = false } = {}) {
  const spawned = [];
  const factory = (args) => {
    const worker = {
      expedition: args.expedition,
      maxTurns: args.maxTurns,
      turns: 0,
      running: false,
      started: false,
      finished: false,
      finishSummary: null,
      fatalError: null,
      _promise: null,
      start() {
        this.running = true;
        this.started = true;
        this._promise = (async () => {
          this.turns = 2;
          if (fatalAuth) {
            this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
            this.running = false;
            return;
          }
          if (emitCandidate) {
            await executeTool('remember', {
              content: `Finding from ${this.expedition.lane} lane on ${this.expedition.questionId}`
            }, { runtimePath, logger, loop: this });
          }
          // Worker proposes completion of ITS mission. Not the run.
          this.finished = true;
          this.finishSummary = 'Wrote outputs/note.md';
          this.running = false;
        })();
        return { started: true };
      },
      stop() { this.running = false; }
    };
    spawned.push(worker);
    return worker;
  };
  factory.spawned = spawned;
  return factory;
}

function makeOrchestrator(runtimePath) {
  const added = [];
  const completions = [];
  const events = [];
  return {
    logsDir: runtimePath,
    memory: {
      added,
      async addNode(concept, tag, embedding, metadata) {
        added.push({ concept, tag, metadata });
        return { id: `node_${added.length}` };
      }
    },
    _getEvents: () => ({ emitEvent: (type, payload) => events.push({ type, payload }) }),
    requestRunCompletion(reason, plan, trigger) {
      completions.push({ reason, plan, trigger });
      return true;
    },
    events,
    completions
  };
}

function makeEcology({ runtimePath, client, createWorker, ecologyConfig = {}, orchestrator } = {}) {
  const orch = orchestrator || makeOrchestrator(runtimePath);
  const ecology = new ResearchEcology({
    orchestrator: orch,
    logger,
    client,
    createWorker,
    config: {
      logsDir: runtimePath,
      models: { primary: 'test-primary', fast: 'test-fast' },
      architecture: {
        roleSystem: {
          explorationMode: 'guided',
          guidedFocus: { domain: 'Jerry Garcia anecdotes', context: 'Collect notable stories.' }
        }
      },
      ecology: {
        budgetTurns: 24,
        sleepAfterExpeditions: 2,
        workerMaxTurns: 6,
        ...ecologyConfig
      }
    },
    plan: {
      shortPlan: {
        goal: 'Jerry Garcia anecdotes',
        constraints: ['Collect notable stories.'],
        deliverable: 'Write the research into this run.',
        executionKind: 'tool_loop',
        claimedBy: 'launch_loop'
      }
    }
  });
  ecology._orchestrator = orch;
  return ecology;
}

describe('Lane allocations (Inv 13: autonomy cannot silently decay to zero)', () => {
  it('defaults keep all four lanes alive and sum to 100', () => {
    const { lanes, enforced } = normalizeLanes();
    expect(Object.keys(lanes)).to.have.members(LANE_NAMES);
    const total = LANE_NAMES.reduce((sum, lane) => sum + lanes[lane], 0);
    expect(Math.round(total)).to.equal(100);
    for (const lane of LANE_NAMES) expect(lanes[lane]).to.be.greaterThan(0);
    expect(enforced).to.equal(false);
  });

  it('refuses a silent zero-autonomy configuration — the floor is restored', () => {
    const { lanes, enforced, autonomyFloor } = normalizeLanes(
      { directed: 100, adjacent: 0, wildcard: 0, incubation: 0 },
      { autonomyFloor: 25 }
    );
    expect(enforced).to.equal(true);
    expect(lanes.adjacent + lanes.wildcard).to.be.at.least(autonomyFloor - 0.01);
    const total = LANE_NAMES.reduce((sum, lane) => sum + lanes[lane], 0);
    expect(Math.round(total)).to.equal(100);
  });

  it('incubation never satisfies the autonomy floor', () => {
    const { lanes, enforced } = normalizeLanes(
      { directed: 50, adjacent: 0, wildcard: 0, incubation: 50 },
      { autonomyFloor: 25 }
    );
    expect(enforced).to.equal(true);
    expect(lanes.adjacent + lanes.wildcard).to.be.at.least(24.99);
  });

  it('only an explicit human directed-override may suspend the reserve', () => {
    const { enforced, override, lanes } = normalizeLanes(
      { directed: 95, adjacent: 0, wildcard: 5, incubation: 0 },
      {
        autonomyFloor: 25,
        directedOverride: { reason: 'human: named mission crunch', expiresAtTurns: 40 }
      }
    );
    expect(enforced).to.equal(false);
    expect(override.reason).to.include('human');
    expect(lanes.adjacent + lanes.wildcard).to.be.lessThan(25);
  });
});

describe('The ecology is the product behind Launch', () => {
  let runtimePath;

  beforeEach(() => {
    runtimePath = tempRuntime();
  });

  it('a worker finishing its deliverable does not settle the run', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const ecology = makeEcology({ runtimePath, client: scriptedClient(), createWorker });

    ecology.start();
    await ecology._promise;

    // The first worker finished — and the run kept going.
    expect(createWorker.spawned.length).to.be.greaterThan(1);
    expect(createWorker.spawned[0].finished).to.equal(true);

    const journal = readJsonl(path.join(runtimePath, 'ecology', 'journal.jsonl'));
    const types = journal.map((entry) => entry.type);
    const firstProposal = types.indexOf('worker_completion_proposal');
    const laterExpedition = types.lastIndexOf('expedition_started');
    expect(firstProposal).to.be.greaterThan(-1);
    expect(laterExpedition).to.be.greaterThan(firstProposal);

    expect(ecology.mode).to.equal('settled');
    expect(ecology.settledReason).to.not.equal('worker_finished');
  });

  it('keeps four lanes alive across the run: directed, adjacent, wildcard get work; incubation gets sleep treatment', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const ecology = makeEcology({ runtimePath, client: scriptedClient(), createWorker });

    ecology.start();
    await ecology._promise;

    const snapshot = ecology.snapshot();
    expect(snapshot.lanes.map((lane) => lane.lane)).to.have.members(LANE_NAMES);
    for (const lane of snapshot.lanes) {
      expect(lane.allocation).to.be.greaterThan(0);
    }
    const spent = Object.fromEntries(snapshot.lanes.map((lane) => [lane.lane, lane.spentTurns]));
    expect(spent.directed).to.be.greaterThan(0);
    expect(spent.adjacent + spent.wildcard).to.be.greaterThan(0);
    expect(spent.incubation).to.be.greaterThan(0);

    const lanesWorked = new Set(createWorker.spawned.map((worker) => worker.expedition.lane));
    expect(lanesWorked.has('directed')).to.equal(true);
    expect(lanesWorked.has('adjacent') || lanesWorked.has('wildcard')).to.equal(true);
  });

  it('Pure Mode provenance: the seed is given; the ecology writes the next questions itself', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const ecology = makeEcology({ runtimePath, client: scriptedClient(), createWorker });

    ecology.start();
    await ecology._promise;

    const questions = ecology.questions.list();
    const seed = questions.find((question) => question.origin === 'human');
    expect(seed).to.exist;
    expect(seed.provenance.preauthored).to.equal(true);
    expect(countsTowardAutonomy(seed)).to.equal(false);

    const ecologyBorn = questions.filter((question) => question.origin !== 'human');
    expect(ecologyBorn.length).to.be.greaterThan(0);
    const specialist = ecologyBorn.filter((question) => question.origin === 'specialist');
    expect(specialist.length).to.be.greaterThan(0);
    for (const question of specialist) {
      expect(question.provenance.preauthored).to.equal(false);
      expect(countsTowardAutonomy(question)).to.equal(true);
    }
    // Lane labels alone never establish autonomy: a preauthored question in
    // the wildcard lane does not count.
    const preauthored = await ecology.questions.create({
      text: 'Preauthored wildcard probe',
      origin: 'principal',
      lane: 'wildcard',
      provenance: { originatedBy: 'principal', preauthored: true }
    });
    expect(countsTowardAutonomy(preauthored)).to.equal(false);
  });

  it('sleep commits a metabolism transaction and promotion is the only Brain change', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const ecology = makeEcology({ runtimePath, client: scriptedClient(), createWorker });

    ecology.start();
    await ecology._promise;

    // Workers journaled candidates without touching the Brain; every Brain
    // node came from the promotion gate.
    const memory = ecology._orchestrator.memory;
    expect(memory.added.length).to.be.greaterThan(0);
    for (const node of memory.added) {
      expect(node.metadata?.source).to.equal('ecology_promotion');
      expect(node.metadata?.decisionId).to.be.a('string');
    }

    const commits = readJsonl(path.join(runtimePath, 'ecology', 'commits.jsonl'));
    expect(commits.length).to.be.greaterThan(0);
    const commit = commits[0];
    expect(commit.parentCommitId).to.equal('commit-genesis');
    expect(commit.parentHash).to.be.a('string');
    expect(commit.candidatesHighWaterMark).to.be.greaterThan(0);
    if (commits.length > 1) {
      expect(commits[1].parentCommitId).to.equal(commits[0].commitId);
    }

    const journal = readJsonl(path.join(runtimePath, 'ecology', 'journal.jsonl'));
    const types = journal.map((entry) => entry.type);
    expect(types).to.include('sleep_started');
    expect(types).to.include('metabolism_started');
    expect(types).to.include('metabolism_committed');

    const briefings = fs.readdirSync(path.join(runtimePath, 'ecology', 'wake-briefings'));
    expect(briefings.length).to.be.greaterThan(0);

    // Dream output entered the candidate journal typed origin=dream —
    // unverified, never a fact.
    const candidates = readJsonl(path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl'));
    const dreams = candidates.filter((candidate) => candidate.origin === 'dream');
    expect(dreams.length).to.be.greaterThan(0);
    for (const dream of dreams) {
      expect(dream.epistemicStatus).to.equal('unverified');
    }
    const dreamQuestions = ecology.questions.list().filter((question) => question.origin === 'dream');
    expect(dreamQuestions.length).to.be.greaterThan(0);
  });

  it('settled means the Brain stays queryable and no research process keeps running', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const ecology = makeEcology({ runtimePath, client: scriptedClient(), createWorker });

    ecology.start();
    await ecology._promise;

    expect(ecology.mode).to.equal('settled');
    expect(ecology.running).to.equal(false);
    expect(ecology.getStatus().status).to.equal('settled');

    // The orchestrator was asked to close the run out; the engine process
    // does not have to stay alive for the Brain to be queryable.
    expect(ecology._orchestrator.completions.length).to.equal(1);
    expect(ecology._orchestrator.completions[0].reason).to.equal('ecology_settled');

    // Resumable, queryable state on disk: ecology state, questions,
    // journal, promotion ledger.
    const state = JSON.parse(fs.readFileSync(path.join(runtimePath, 'ecology', 'state.json'), 'utf8'));
    expect(state.mode).to.equal('settled');
    expect(state.lanes).to.have.length(4);
    expect(fs.existsSync(path.join(runtimePath, 'ecology', 'questions.json'))).to.equal(true);
    expect(fs.existsSync(path.join(runtimePath, 'ecology', 'journal.jsonl'))).to.equal(true);

    const journal = readJsonl(path.join(runtimePath, 'ecology', 'journal.jsonl'));
    expect(journal.map((entry) => entry.type)).to.include('settled');
  });

  it('401 / revoked OAuth is fatal: one error, the ecology stops, Watch is told to re-auth', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath, { fatalAuth: true });
    const ecology = makeEcology({ runtimePath, client: scriptedClient(), createWorker });

    ecology.start();
    await ecology._promise;

    expect(createWorker.spawned.length).to.equal(1);
    expect(ecology.running).to.equal(false);
    expect(ecology.mode).to.equal('error');
    expect(ecology.fatalError).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
    expect(ecology.getStatus().status).to.equal('error');

    const errorEvents = ecology._orchestrator.events.filter((event) => event.type === 'launch_loop_error');
    expect(errorEvents.length).to.be.greaterThan(0);
    expect(errorEvents[0].payload.message).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
    // The run did not settle — it failed honestly.
    expect(ecology.mode).to.not.equal('settled');
  });
});

describe('Sleep/dream is a transaction, not a prose genre (Inv 10)', () => {
  let runtimePath;
  let questions;
  let promotionGate;
  let journal;

  beforeEach(async () => {
    runtimePath = tempRuntime('cosmo-metabolism-');
    questions = new QuestionEcology(runtimePath, logger);
    promotionGate = new PromotionGate(runtimePath, logger);
    journal = new EcologyJournal(runtimePath, logger);
    // One journaled worker candidate to replay.
    await executeTool('remember', { content: 'Garcia played a legendary 1973 set.' }, {
      runtimePath,
      logger,
      loop: { expedition: { id: 'exp_test', lane: 'directed', questionId: 'q_seed' } }
    });
  });

  function makeMetabolism(client) {
    return new Metabolism({
      runtimePath,
      questions,
      promotionGate,
      principal: new Principal({ client, config: { models: { fast: 'test' } }, logger }),
      journal,
      client,
      config: { models: { fast: 'test' } },
      logger
    });
  }

  it('an injected failure before commit rolls back completely — the parent stays untouched', async () => {
    const metabolism = makeMetabolism(scriptedClient());
    const memory = { added: [], async addNode() { this.added.push(1); return { id: 'n' }; } };

    const result = await metabolism.run({ memory, failBeforeCommit: true });

    expect(result.committed).to.equal(false);
    expect(result.reason).to.include('injected_failure_before_commit');
    expect(fs.existsSync(path.join(runtimePath, 'ecology', 'commits.jsonl'))).to.equal(false);
    expect(memory.added).to.have.length(0);
    // No dream candidates leaked into the journal from the failed attempt.
    const candidates = readJsonl(path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl'));
    expect(candidates.filter((candidate) => candidate.origin === 'dream')).to.have.length(0);
    // The lease was released; a new attempt can run.
    expect(fs.existsSync(path.join(runtimePath, 'ecology', '.metabolism.lock'))).to.equal(false);
    const entries = readJsonl(path.join(runtimePath, 'ecology', 'journal.jsonl'));
    expect(entries.map((entry) => entry.type)).to.include('metabolism_rolled_back');
  });

  it('never runs two metabolism attempts on one lease', async () => {
    const metabolism = makeMetabolism(scriptedClient());
    fs.mkdirSync(path.join(runtimePath, 'ecology'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimePath, 'ecology', '.metabolism.lock'),
      JSON.stringify({ attemptId: 'met_other', fencingToken: 'tok', pid: 1, at: Date.now() })
    );

    const result = await metabolism.run({ memory: null });
    expect(result.committed).to.equal(false);
    expect(result.reason).to.equal('lease_held');
  });

  it('a committed run pins parent and high-water mark and applies promotions through the gate', async () => {
    const metabolism = makeMetabolism(scriptedClient());
    const memory = {
      added: [],
      async addNode(concept, tag, embedding, metadata) {
        this.added.push({ concept, tag, metadata });
        return { id: `node_${this.added.length}` };
      }
    };

    const result = await metabolism.run({ memory });

    expect(result.committed).to.equal(true);
    expect(result.commit.parentCommitId).to.equal('commit-genesis');
    expect(result.commit.candidatesHighWaterMark).to.be.greaterThan(0);
    expect(result.commit.promotionsApplied).to.be.greaterThan(0);
    expect(memory.added.length).to.equal(result.commit.promotionsApplied);
    expect(result.briefingPath).to.be.a('string');
    expect(fs.existsSync(result.briefingPath)).to.equal(true);

    // The promotion ledger is hash-chained.
    const promotions = readJsonl(path.join(runtimePath, 'ecology', 'promotions.jsonl'));
    expect(promotions.length).to.be.greaterThan(0);
    expect(promotions[0].prevHash).to.equal('promotion-genesis');
    expect(promotions[0].hash).to.be.a('string');
  });
});

describe('Promotion is the only Brain change (Inv 4, Inv 14)', () => {
  let runtimePath;
  let gate;

  beforeEach(async () => {
    runtimePath = tempRuntime('cosmo-promotion-');
    gate = new PromotionGate(runtimePath, logger);
  });

  async function journalCandidate(extra = {}) {
    const dir = path.join(runtimePath, 'outputs', 'candidates');
    fs.mkdirSync(dir, { recursive: true });
    const candidate = {
      id: `cand_${Math.random().toString(36).slice(2, 10)}`,
      type: 'candidate_finding',
      content: 'A worker-journaled candidate.',
      origin: 'worker',
      lane: 'directed',
      promoted: false,
      at: Date.now(),
      ...extra
    };
    fs.appendFileSync(path.join(dir, 'findings.jsonl'), `${JSON.stringify(candidate)}\n`);
    return candidate;
  }

  function memoryStub() {
    return {
      added: [],
      async addNode(concept, tag, embedding, metadata) {
        this.added.push({ concept, tag, metadata });
        return { id: `node_${this.added.length}` };
      }
    };
  }

  it('workers cannot promote their own output — only a Principal decision moves the gate', async () => {
    const candidate = await journalCandidate();
    const memory = memoryStub();

    const workerAttempt = await gate.promote({
      decision: { id: 'dec_w', actor: 'worker', kind: 'promotion_proposal', candidateId: candidate.id, promoteAs: 'finding' },
      memory
    });
    expect(workerAttempt.promoted).to.equal(false);
    expect(workerAttempt.reason).to.equal('promotion_requires_principal_decision');
    expect(memory.added).to.have.length(0);

    const principalAttempt = await gate.promote({
      decision: { id: 'dec_p', actor: 'principal', kind: 'promotion_proposal', candidateId: candidate.id, promoteAs: 'finding', rationale: 'good' },
      memory
    });
    expect(principalAttempt.promoted).to.equal(true);
    expect(memory.added).to.have.length(1);
    expect(memory.added[0].tag).to.equal('promoted_finding');
  });

  it('a candidate must exist in the journal — no promotion from thin air', async () => {
    const memory = memoryStub();
    const result = await gate.promote({
      decision: { id: 'dec_x', actor: 'principal', kind: 'promotion_proposal', candidateId: 'cand_missing', promoteAs: 'finding' },
      memory
    });
    expect(result.promoted).to.equal(false);
    expect(result.reason).to.equal('candidate_not_in_journal');
    expect(memory.added).to.have.length(0);
  });

  it('dreams cannot directly become sourced facts — only hypotheses or questions', async () => {
    const dream = await journalCandidate({ origin: 'dream', epistemicStatus: 'unverified' });
    const memory = memoryStub();

    const asFact = await gate.promote({
      decision: { id: 'dec_d1', actor: 'principal', kind: 'promotion_proposal', candidateId: dream.id, promoteAs: 'finding' },
      memory
    });
    expect(asFact.promoted).to.equal(false);
    expect(asFact.reason).to.equal('dream_cannot_become_fact');

    const asHypothesis = await gate.promote({
      decision: { id: 'dec_d2', actor: 'principal', kind: 'promotion_proposal', candidateId: dream.id, promoteAs: 'hypothesis' },
      memory
    });
    expect(asHypothesis.promoted).to.equal(true);
    expect(memory.added[0].tag).to.equal('hypothesis');
  });

  it('worker remember() journals a candidate with expedition provenance and no Brain write', async () => {
    let added = 0;
    const result = await executeTool('remember', { content: 'Provenance-carrying candidate.' }, {
      runtimePath,
      logger,
      orchestrator: { memory: { addNode: async () => { added += 1; return { id: 'no' }; } } },
      loop: { expedition: { id: 'exp_1', lane: 'wildcard', questionId: 'q_9' } }
    });
    expect(result).to.include('Brain changes at promotion');
    expect(added).to.equal(0);

    const candidates = readJsonl(path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl'));
    const candidate = candidates[candidates.length - 1];
    expect(candidate.id).to.be.a('string');
    expect(candidate.origin).to.equal('worker');
    expect(candidate.lane).to.equal('wildcard');
    expect(candidate.expeditionId).to.equal('exp_1');
    expect(candidate.questionId).to.equal('q_9');
    expect(candidate.promoted).to.equal(false);
  });
});

describe('Questions are not tasks', () => {
  let runtimePath;
  let questions;

  beforeEach(() => {
    runtimePath = tempRuntime('cosmo-questions-');
    questions = new QuestionEcology(runtimePath, logger);
  });

  it('a worker cannot close a question', async () => {
    const question = await questions.create({
      text: 'A durable unknown', origin: 'human', lane: 'directed'
    });
    await questions.transition(question.id, 'active', { by: 'ecology', reason: 'expedition' });

    let error = null;
    try {
      await questions.transition(question.id, 'answered', { by: 'worker', reason: 'finish called' });
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.message).to.include('worker finish does not close a question');
    expect(questions.get(question.id).status).to.equal('active');

    // A Principal decision can.
    await questions.transition(question.id, 'partially_answered', {
      by: 'principal', reason: 'evidence so far', decisionId: 'dec_1'
    });
    expect(questions.get(question.id).status).to.equal('partially_answered');
  });

  it('answered questions can revive; incubating questions can wake', async () => {
    const question = await questions.create({ text: 'Revivable unknown', origin: 'specialist', lane: 'adjacent' });
    await questions.transition(question.id, 'active', { by: 'ecology' });
    await questions.transition(question.id, 'answered', { by: 'principal' });
    await questions.transition(question.id, 'revived', { by: 'principal', reason: 'new evidence' });
    expect(questions.get(question.id).status).to.equal('revived');

    const slow = await questions.create({
      text: 'Slow question', origin: 'dream', lane: 'incubation', status: 'incubating'
    });
    await questions.transition(slow.id, 'active', { by: 'principal', reason: 'matured' });
    expect(questions.get(slow.id).status).to.equal('active');
  });
});

describe('Launch starts the ecology (planner wiring)', () => {
  it('startLaunchLoop default loop is the research ecology with four lanes, not a bare worker', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime('cosmo-planner-ecology-');
    const stored = { plan: null, milestones: [], tasks: [] };
    const config = {
      logsDir: runtimePath,
      architecture: {
        roleSystem: {
          explorationMode: 'guided',
          guidedFocus: {
            domain: 'Jerry Garcia anecdotes',
            context: 'Collect and write notable Jerry Garcia anecdotes.',
            executionMode: 'guided-exclusive'
          }
        }
      },
      models: { primary: 'test-primary', fast: 'test-fast' },
      // Tiny budget so the default ecology settles immediately in-test.
      ecology: { budgetTurns: 8, sleepAfterExpeditions: 1, workerMaxTurns: 4 },
      mcp: { client: { enabled: false, servers: [] } }
    };
    const orchestrator = makeOrchestrator(runtimePath);
    const emptyClient = {
      async createCompletion() {
        return { choices: [{ message: { role: 'assistant', content: '{}' } }] };
      }
    };
    const planner = new GuidedModePlanner(config, {
      client: emptyClient,
      orchestrator,
      clusterStateStore: {
        getPlan: async () => stored.plan,
        listTasks: async () => stored.tasks,
        listMilestones: async () => stored.milestones,
        createPlan: async (plan) => { stored.plan = plan; },
        upsertMilestone: async (milestone) => { stored.milestones.push(milestone); },
        upsertTask: async (task) => { stored.tasks.push(task); },
        updatePlan: async (id, update) => { stored.plan = { ...stored.plan, ...update }; }
      },
      agentExecutor: { registry: { getActiveCount: () => 0 } },
      memory: orchestrator.memory
    }, logger);

    await planner.planMission({ forceNew: true });
    const result = await planner.startLaunchLoop({ orchestrator, client: emptyClient });

    expect(result.started).to.equal(true);
    expect(result.productLoop).to.equal('research');

    const loop = planner._launchLoop;
    expect(loop).to.be.instanceOf(ResearchEcology);
    expect(orchestrator.launchLoop).to.equal(loop);

    const status = loop.getStatus();
    expect(status.productLoop).to.equal('research');
    expect(status.ecology.lanes.map((lane) => lane.lane)).to.have.members(LANE_NAMES);

    // Let the tiny run settle so nothing leaks between tests.
    await loop._promise;
    expect(loop.mode).to.equal('settled');
  });
});
