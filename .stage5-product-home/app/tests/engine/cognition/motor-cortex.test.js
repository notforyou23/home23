import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MotorCortex } = require('../../../engine/src/cognition/motor-cortex.js');

const logger = { info() {}, warn() {}, error() {} };

test('motor cortex routes bounded agenda through executor and marks acted_on', async () => {
  const statusUpdates = [];
  const calls = [];
  const motor = new MotorCortex({
    logger,
    agendaStore: {
      updateStatus(id, status, opts) {
        statusUpdates.push({ id, status, opts });
      },
    },
    canAct: () => true,
    executeAgendaItem: async (item, opts) => {
      calls.push({ item, opts });
      return {
        directAction: true,
        action: 'diagnose_agenda',
        problemId: `agenda_${item.id}`,
        status: 'open',
        detail: 'queued for diagnostic dispatch',
      };
    },
  });

  const result = await motor.actOnAgendaItem({
    id: 'ag-test',
    content: 'Investigate why RECENT.md has not regenerated in 9 days.',
  }, { cycleSessionId: 'tm-cycle-test' });

  assert.equal(result.status, 'acted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.actor, 'motor-cortex');
  assert.equal(calls[0].opts.origin, 'thinking-machine');
  assert.deepEqual(statusUpdates.map(u => [u.id, u.status]), [['ag-test', 'acted_on']]);
  assert.match(statusUpdates[0].opts.note, /queued/);
});

test('motor cortex rejects agenda items that fail policy without executing', async () => {
  let executed = false;
  const motor = new MotorCortex({
    logger,
    canAct: () => false,
    executeAgendaItem: async () => {
      executed = true;
      return { directAction: true };
    },
  });

  const result = await motor.actOnAgendaItem({
    id: 'ag-nope',
    content: 'Ask jtr whether Home23 is really a narrative framework.',
  });

  assert.equal(result.status, 'rejected');
  assert.equal(executed, false);
  assert.match(result.detail, /policy/);
});

test('motor compiler records filtered critique candidates instead of silently dropping them', () => {
  const motor = new MotorCortex({
    logger,
    canAct: () => false,
  });

  const plan = motor.compileMotorIntents({
    thoughtText: 'The thought is useful but has no directly executable engine repair.',
    finalVerdict: {
      agendaCandidates: [],
      raw: '```json\n{"verdict":"keep","agendaCandidates":[{"content":"Compare the April 17 run HR/elevation profile to historical Huber Woods runs.","kind":"idea","topicTags":["health"]}]}\n```',
    },
  });

  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0].status, 'rejected');
  assert.equal(plan.decisions[0].source, 'critique_raw_agenda');
  assert.match(plan.decisions[0].detail, /filter rejected/);
});

test('motor compiler emits no_action when a kept thought has no bounded intent', () => {
  const motor = new MotorCortex({
    logger,
    canAct: () => true,
  });

  const plan = motor.compileMotorIntents({
    thoughtText: 'This is interpretive framing about jtr and contains no concrete operational task.',
    finalVerdict: { agendaCandidates: [], raw: '```json\n{"verdict":"keep","agendaCandidates":[]}\n```' },
  });

  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.decisions[0].status, 'no_action');
  assert.match(plan.decisions[0].detail, /no bounded motor intent/);
});
