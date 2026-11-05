import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ThinkingMachine } = require('../../../engine/src/cognition/thinking-machine.js');

const logger = { info() {}, warn() {}, error() {} };

test('kept thinking-machine agenda candidates are routed to motor cortex before persistence hooks', async () => {
  const ledger = [];
  const motorCalls = [];
  const emitted = [];
  const logged = [];

  const agendaRecord = {
    id: 'ag-motor-1',
    content: 'Investigate the 182-second field report cycle; verify whether a cron partition is stalled.',
    kind: 'question',
    topicTags: ['ops'],
  };

  const machine = new ThinkingMachine({
    unifiedClient: {},
    memory: {},
    discoveryEngine: { pop: () => [] },
    logger,
    emitThought: (thought) => emitted.push(thought),
    logThought: async (thought) => logged.push(thought),
    config: {
      eventLedger: {
        record: (eventType, sessionId, payload, meta) => ledger.push({ eventType, sessionId, payload, meta }),
      },
      agendaStore: {
        add(params) {
          assert.match(params.content, /182-second field report/);
          return agendaRecord;
        },
      },
      motorCortex: {
        async actOnAgendaItem(item, context) {
          motorCalls.push({ item, context });
          return {
            status: 'acted',
            action: {
              directAction: true,
              action: 'diagnose_agenda',
              problemId: 'agenda_ag-motor-1',
              status: 'open',
              detail: 'queued for diagnostic dispatch',
            },
          };
        },
      },
    },
  });

  machine.deepDive = {
    async think() {
      return {
        text: 'This operational thought is long enough to pass the empty-output guard and should be kept.',
        referencedNodes: ['node-1'],
        usage: { model: 'test-model', neighborhoodSize: 1 },
        reasoning: 'test reasoning',
      };
    },
  };
  machine.pgsAdapter = {
    getStats: () => ({}),
    async connect() {
      return {
        available: false,
        note: 'pgs unavailable in test',
        perspectives: [],
        candidateEdges: [],
        connectionNotes: [],
        usage: { partitionsTouched: 0, durationMs: 1 },
      };
    },
  };
  machine.critique = {
    async evaluate() {
      return {
        verdict: 'keep',
        confidence: 0.91,
        gaps: [],
        rationale: 'bounded operational action',
        agendaCandidates: [{
          content: agendaRecord.content,
          kind: agendaRecord.kind,
          topicTags: agendaRecord.topicTags,
        }],
      };
    },
  };

  await machine._runCycle({
    signal: 'ops-anomaly',
    score: 0.88,
    clusterId: 'cluster-1',
    rationale: 'field report latency anomaly',
  });

  assert.equal(motorCalls.length, 1);
  assert.equal(motorCalls[0].item.id, 'ag-motor-1');
  assert.equal(motorCalls[0].context.actor, 'motor-cortex');
  assert.deepEqual(emitted[0].agendaIds, ['ag-motor-1']);
  assert.equal(emitted[0].motorActions[0].status, 'acted');
  assert.deepEqual(logged[0].motorActions, emitted[0].motorActions);
  assert.equal(machine.recentThoughts[0].motorActions[0].target, 'agenda_ag-motor-1');
  assert.ok(ledger.some(e => e.eventType === 'MotorActionRouted' && e.payload.agendaId === 'ag-motor-1'));
});

test('kept thoughts with filtered agenda candidates still emit a motor rejection', async () => {
  const ledger = [];
  const emitted = [];
  const machine = new ThinkingMachine({
    unifiedClient: {},
    memory: {},
    discoveryEngine: { pop: () => [] },
    logger,
    emitThought: (thought) => emitted.push(thought),
    config: {
      eventLedger: {
        record: (eventType, sessionId, payload) => ledger.push({ eventType, sessionId, payload }),
      },
      agendaStore: {
        add() {
          throw new Error('agenda store should not be called for rejected motor candidates');
        },
      },
      motorCortex: {
        compileMotorIntents() {
          return {
            accepted: [],
            decisions: [{
              status: 'rejected',
              source: 'critique_raw_agenda',
              content: 'Compare the April 17 run HR/elevation profile to historical Huber Woods runs.',
              detail: 'critique agenda filter rejected this candidate before motor routing',
            }],
          };
        },
      },
    },
  });

  machine.deepDive = {
    async think() {
      return {
        text: 'This kept thought includes a useful health synthesis but no bounded engine action.',
        referencedNodes: [],
        usage: {},
      };
    },
  };
  machine.pgsAdapter = {
    getStats: () => ({}),
    async connect() {
      return { available: false, note: 'skipped_isolated', perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} };
    },
  };
  machine.critique = {
    async evaluate() {
      return {
        verdict: 'keep',
        confidence: 0.9,
        gaps: [],
        rationale: 'useful but not executable',
        agendaCandidates: [],
        raw: 'raw critique with a filtered agenda candidate',
      };
    },
  };

  await machine._runCycle({ signal: 'health-synthesis', score: 0.8 });

  assert.equal(emitted[0].motorActions[0].status, 'rejected');
  assert.equal(emitted[0].motorActions[0].source, 'critique_raw_agenda');
  assert.equal(machine.recentThoughts[0].motorActions[0].detail, 'critique agenda filter rejected this candidate before motor routing');
  assert.ok(ledger.some(e => e.eventType === 'MotorActionRouted' && e.payload.status === 'rejected'));
});
