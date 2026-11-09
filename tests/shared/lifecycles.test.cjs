'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const lifecycles = require('../../shared/lifecycles.cjs');
const {
  LIFECYCLES, LIFECYCLE_NAMES, assertTerminal, assertTransition, canTransition, defineLifecycle,
  describeLifecycles, isActive, isReportedState, isState, isTerminal, labelFor,
  renderLifecycleReference, terminalStates,
} = lifecycles;

const root = path.resolve(__dirname, '../..');
const base = {
  name: 'sample',
  states: ['open', 'held', 'done'],
  initial: 'open',
  terminal: ['done'],
  transitions: [['open', 'held'], ['held', 'open'], ['open', 'done'], ['held', 'done']],
  labels: { open: 'Open', held: 'Held', done: 'Done' },
};

test('a lifecycle table is rejected at load when it is inconsistent', () => {
  assert.equal(defineLifecycle(base).name, 'sample');
  const broken = {
    'undeclared initial': { initial: 'missing' },
    'undeclared terminal': { terminal: ['gone'] },
    'no terminal': { terminal: [] },
    'transition to undeclared state': { transitions: [...base.transitions, ['open', 'gone']] },
    'way out of a terminal state': { transitions: [...base.transitions, ['done', 'open']] },
    'self transition': { transitions: [...base.transitions, ['open', 'open']] },
    'duplicate transition': { transitions: [...base.transitions, ['open', 'held']] },
    'unreachable state': { states: [...base.states, 'lost'], labels: { ...base.labels, lost: 'Lost' },
      transitions: [...base.transitions, ['lost', 'done']] },
    'dead end': { states: [...base.states, 'stuck'], labels: { ...base.labels, stuck: 'Stuck' },
      transitions: [...base.transitions, ['open', 'stuck']] },
    'view that is also stored': { views: ['held'] },
    'missing label': { labels: { open: 'Open', held: 'Held' } },
    'duplicate state': { states: ['open', 'held', 'done', 'open'] },
  };
  for (const [reason, patch] of Object.entries(broken)) {
    assert.throws(() => defineLifecycle({ ...base, ...patch }), /lifecycle "sample"/, reason);
  }
  // A reserved state is declared but unwritten; it does not need to be reachable.
  assert.deepEqual(defineLifecycle({
    ...base, states: [...base.states, 'parked'], reserved: ['parked'],
    labels: { ...base.labels, parked: 'Parked' }, transitions: [...base.transitions, ['parked', 'open']],
  }).reserved, ['parked']);
});

test('every catalog entry is frozen and answers the same questions', () => {
  assert.ok(Object.isFrozen(LIFECYCLES));
  for (const name of LIFECYCLE_NAMES) {
    const machine = LIFECYCLES[name];
    assert.ok(Object.isFrozen(machine) && Object.isFrozen(machine.states) && Object.isFrozen(machine.transitions), name);
    assert.deepEqual(terminalStates(name), machine.terminal);
    assert.deepEqual([...machine.active, ...machine.terminal].sort(), [...machine.states].sort(), name);
    for (const state of machine.states) {
      assert.equal(isState(name, state), true);
      assert.equal(isTerminal(name, state), machine.terminal.includes(state));
      assert.equal(isActive(name, state), !machine.terminal.includes(state));
      assert.equal(typeof labelFor(name, state), 'string');
      // Restating the current state is never a move.
      assert.doesNotThrow(() => assertTransition(name, state, state));
    }
    for (const view of machine.views) {
      assert.equal(isState(name, view), false, `${name}: view ${view} must not be storable`);
      assert.equal(isReportedState(name, view), true);
      assert.equal(isTerminal(name, view), false);
    }
    for (const from of machine.terminal) {
      for (const to of machine.states) {
        if (from === to) continue;
        assert.throws(() => assertTransition(name, from, to), { code: 'lifecycle_terminal' }, `${name}: ${from} -> ${to}`);
      }
    }
    for (const value of [undefined, null, 7, '', 'constructor', '__proto__', 'toString']) {
      assert.equal(isState(name, value), false);
      assert.equal(isTerminal(name, value), false);
      assert.equal(isReportedState(name, value), false);
      assert.equal(labelFor(name, value), null);
    }
  }
  assert.throws(() => isTerminal('no-such-lifecycle', 'done'), { code: 'lifecycle_unknown' });
  assert.throws(() => isTerminal('constructor', 'done'), { code: 'lifecycle_unknown' });
});

test('the adopted lifecycles keep their published vocabularies', () => {
  // These strings are stored on disk and sent to clients. Changing one is a
  // data migration, not a refactor; this test is the reminder.
  assert.deepEqual(LIFECYCLES['chat-turn'].states, ['pending', 'complete', 'stopped', 'error', 'timeout', 'orphaned']);
  assert.deepEqual(LIFECYCLES['chat-turn'].views,
    ['accepted', 'running', 'awaiting_model', 'streaming', 'tool_running', 'stopping']);
  assert.deepEqual(LIFECYCLES['async-work'].states,
    ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted']);
  assert.deepEqual(LIFECYCLES['coding-job'].states,
    ['starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
  assert.deepEqual(LIFECYCLES['work-verification'].states, ['none', 'pending', 'reviewed', 'skipped']);
  assert.deepEqual(LIFECYCLES['brain-operation'].states,
    ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted']);
});

test('moves follow the table', () => {
  assert.equal(canTransition('chat-turn', 'pending', 'complete'), true);
  assert.equal(canTransition('chat-turn', 'pending', 'streaming'), false);
  assert.throws(() => assertTransition('chat-turn', 'pending', 'streaming'), { code: 'lifecycle_state_unknown' });
  assert.throws(() => assertTransition('coding-job', 'running', 'starting'), { code: 'lifecycle_transition_invalid' });
  assert.throws(() => assertTransition('coding-job', 'completed', 'running'), { code: 'lifecycle_terminal' });
  assert.doesNotThrow(() => assertTransition('coding-job', 'starting', 'failed'));
  assert.doesNotThrow(() => assertTransition('async-work', 'running', 'blocked'));
  assert.throws(() => assertTransition('work-verification', 'none', 'reviewed'), { code: 'lifecycle_transition_invalid' });
  assert.doesNotThrow(() => assertTerminal('async-work', 'interrupted'));
  assert.throws(() => assertTerminal('async-work', 'running'), { code: 'lifecycle_transition_invalid' });
  // A finished coding job is finished work under the same name.
  assert.deepEqual(terminalStates('coding-job'), terminalStates('async-work'));
});

test('brain-operation mirrors the engine operation contract exactly', () => {
  const contract = require('../../engine/src/dashboard/brain-operations/operation-contract.js');
  const machine = LIFECYCLES['brain-operation'];
  assert.deepEqual(machine.states, [...contract.EXECUTION_STATES]);
  assert.deepEqual([...machine.terminal].sort(), [...contract.TERMINAL_STATES].sort());
  for (const from of machine.states) {
    for (const to of machine.states) {
      let engineAllows = true;
      try { contract.assertTransition(from, to); } catch { engineAllows = false; }
      assert.equal(canTransition('brain-operation', from, to), engineAllows, `${from} -> ${to}`);
    }
  }
});

test('the type declarations list exactly the catalog states', () => {
  const declarations = fs.readFileSync(path.join(root, 'shared/lifecycles.d.cts'), 'utf8');
  const aliases = new Map();
  for (const match of declarations.matchAll(/export type (\w+) =([^;]+);/g)) aliases.set(match[1], match[2]);
  const members = (alias) => {
    const body = aliases.get(alias);
    assert.ok(body, `missing type ${alias}`);
    return body.split('|').map(part => part.trim()).filter(Boolean).flatMap((part) => {
      const literal = /^'([^']+)'$/.exec(part);
      return literal ? [literal[1]] : members(part);
    });
  };
  const expected = {
    'chat-turn': ['ChatTurnStoredStatus', 'ChatTurnTerminalStatus', 'ChatTurnViewStatus'],
    'async-work': ['AsyncWorkLifecycleStatus', 'AsyncWorkTerminalStatus'],
    'coding-job': ['CodingJobLifecycleStatus', 'CodingJobTerminalStatus'],
    'work-verification': ['WorkVerificationLifecycleStatus', 'WorkVerificationTerminalStatus'],
    'brain-operation': ['BrainOperationLifecycleState', 'BrainOperationTerminalState'],
  };
  assert.deepEqual(Object.keys(expected).sort(), [...LIFECYCLE_NAMES].sort());
  for (const [name, [stateType, terminalType, viewType]] of Object.entries(expected)) {
    const machine = LIFECYCLES[name];
    assert.deepEqual(members(stateType).sort(), [...machine.states].sort(), stateType);
    assert.deepEqual(members(terminalType).sort(), [...machine.terminal].sort(), terminalType);
    if (viewType) assert.deepEqual(members(viewType).sort(), [...machine.views].sort(), viewType);
    else assert.deepEqual(machine.views, []);
    assert.match(declarations, new RegExp(`'${name}': \\{`), `${name} missing from LifecycleStates`);
  }
});

test('the description is plain JSON and the reference page is current', () => {
  const description = describeLifecycles();
  assert.deepEqual(JSON.parse(JSON.stringify(description)), description);
  assert.equal(description.schema, 'home23.lifecycles.v1');
  assert.deepEqual(description.lifecycles.map(entry => entry.name), [...LIFECYCLE_NAMES]);
  const turn = description.lifecycles.find(entry => entry.name === 'chat-turn');
  assert.deepEqual(turn.states.find(entry => entry.state === 'pending').next,
    ['complete', 'stopped', 'error', 'timeout', 'orphaned']);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs/reference/LIFECYCLES.md'), 'utf8'),
    renderLifecycleReference(),
    'docs/reference/LIFECYCLES.md is stale; run: node cli/home23.js lifecycles --markdown > docs/reference/LIFECYCLES.md',
  );
});

test('the CLI prints the same catalog', () => {
  const cli = path.join(root, 'cli/home23.js');
  const run = (...args) => execFileSync(process.execPath, [cli, 'lifecycles', ...args], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run('--json')), describeLifecycles());
  assert.equal(run('--markdown'), renderLifecycleReference());
  assert.deepEqual(JSON.parse(run('coding-job', '--json')).lifecycles.map(entry => entry.name), ['coding-job']);
  const text = run();
  for (const name of LIFECYCLE_NAMES) assert.match(text, new RegExp(`^${name}\\b`, 'm'));
  assert.throws(() => run('no-such-lifecycle'), /unknown lifecycle/i);
});

// Copies of a catalog terminal set written out by hand. Each entry is a file
// that predates the catalog and the number of copies it holds. The numbers may
// only go down: replace a copy with terminalStates()/isTerminal() and lower it.
const HAND_WRITTEN_COPIES = {
  // Engine and dashboard server modules: same lifecycles, not yet reading the catalog.
  'engine/src/dashboard/brain-operations/compatibility-adapter.js': 1,
  'engine/src/dashboard/brain-operations/coordinator.js': 2,
  'engine/src/dashboard/brain-operations/cosmo-worker-client.js': 1,
  'engine/src/dashboard/brain-operations/operation-contract.js': 1,
  'engine/src/dashboard/brain-operations/worker-adapter.js': 2,
  'engine/src/dashboard/home23-query-api.js': 1,
  'engine/src/dashboard/home23-query-notebook-api.js': 1,
  'engine/src/dashboard/query-notebook-service.js': 1,
  'engine/src/dashboard/query-notebook-subscriptions.js': 1,
  'engine/src/dashboard/server.js': 1,
  'shared/memory-source/pins.cjs': 1,
  // Browser-delivered dashboard script: cannot require the catalog.
  'engine/src/dashboard/home23-chat.js': 2,
  // Operator verification and release scripts.
  'scripts/live-brain-tools-smoke.mjs': 1,
  'scripts/release/rebind.mjs': 1,
  'scripts/verify-query-follow-up-live.mjs': 1,
  'scripts/verify-query-notebook-live.mjs': 2,
  // The Inspector console's own state vocabulary; its final states happen to
  // match async-work but it is a separate read-side lifecycle.
  'src/coordination/console/types.ts': 1,
};

test('terminal sets are not copied by hand into new files', () => {
  const sets = LIFECYCLE_NAMES.map(name => [...LIFECYCLES[name].terminal].sort().join('|'));
  const tracked = execFileSync('git', ['ls-files', 'src', 'engine/src', 'cli', 'shared', 'scripts', 'substrate/src'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
    .filter(file => /\.(ts|js|cjs|mjs)$/.test(file) && !/\.d\.c?ts$/.test(file)
      && file !== 'shared/lifecycles.cjs' && !/(^|\/)(vendor|node_modules)\//.test(file));
  const found = {};
  for (const file of tracked) {
    let source;
    try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const match of source.matchAll(/\[\s*((?:['"][a-z_]+['"]\s*,\s*){3,}['"][a-z_]+['"])\s*,?\s*\]/g)) {
      const literal = match[1].split(',').map(part => part.trim().replace(/['"]/g, '')).sort().join('|');
      if (sets.includes(literal)) found[file] = (found[file] || 0) + 1;
    }
  }
  for (const [file, count] of Object.entries(found)) {
    assert.ok(count <= (HAND_WRITTEN_COPIES[file] || 0),
      `${file} writes out a lifecycle's terminal states by hand (${count} found, ${HAND_WRITTEN_COPIES[file] || 0} allowed). `
      + 'Use terminalStates()/isTerminal() from shared/lifecycles.cjs instead.');
  }
  for (const [file, allowed] of Object.entries(HAND_WRITTEN_COPIES)) {
    assert.equal(found[file] || 0, allowed,
      `${file} now has ${found[file] || 0} hand-written copies; lower its entry in HAND_WRITTEN_COPIES from ${allowed}.`);
  }
});
