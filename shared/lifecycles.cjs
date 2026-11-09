'use strict';

/**
 * Lifecycle catalog — the one place a Home23 lifecycle's vocabulary and legal
 * moves are written down.
 *
 * Every entry is plain data: the states a record may be stored in, where it
 * starts, which states are final, and which moves between them are legal.
 * Stores enforce the table at their write boundary; readers ask the table
 * instead of keeping a private copy of "which statuses mean done".
 *
 * Adding a state means editing the table here (and the matching union in
 * lifecycles.d.cts). The table is checked when this module loads, so an
 * inconsistent edit fails every process and every test at startup rather than
 * surfacing later as a record stuck in a state nothing handles.
 *
 * Human reference: docs/reference/LIFECYCLES.md (generated from this file).
 * Machine reference: `node cli/home23.js lifecycles --json`.
 */

const TERMINAL_ERROR_CODE = 'lifecycle_terminal';
const TRANSITION_ERROR_CODE = 'lifecycle_transition_invalid';
const UNKNOWN_STATE_ERROR_CODE = 'lifecycle_state_unknown';
const UNKNOWN_LIFECYCLE_ERROR_CODE = 'lifecycle_unknown';

function lifecycleError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function fanOut(from, targets) {
  return targets.map(to => [from, to]);
}

/**
 * Validate and freeze one lifecycle table.
 *
 * Checked here, once, at load:
 *   - every state named anywhere is declared, and declared once
 *   - a terminal state has no way out
 *   - every non-terminal state can still reach a terminal one (no dead ends)
 *   - every state is reachable from the initial state, or is explicitly
 *     `reserved` (declared in the public type, read tolerantly, never written)
 *   - a view (read-time projection) is never also a stored state
 */
function defineLifecycle(spec) {
  const name = String(spec.name || '');
  const fail = message => { throw new Error(`lifecycle "${name}": ${message}`); };
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail('name must be kebab-case');

  const states = [...spec.states];
  const terminal = [...spec.terminal];
  const reserved = [...(spec.reserved || [])];
  const views = [...(spec.views || [])];
  const transitions = spec.transitions.map(([from, to]) => [from, to]);
  const labels = { ...(spec.labels || {}) };

  if (new Set(states).size !== states.length) fail('duplicate state');
  const known = new Set(states);
  if (!known.has(spec.initial)) fail(`initial state "${spec.initial}" is not declared`);
  for (const state of terminal) if (!known.has(state)) fail(`terminal state "${state}" is not declared`);
  for (const state of reserved) if (!known.has(state)) fail(`reserved state "${state}" is not declared`);
  if (terminal.length === 0) fail('at least one terminal state is required');
  for (const view of views) if (known.has(view)) fail(`view "${view}" is also a stored state`);
  if (new Set(views).size !== views.length) fail('duplicate view');

  const terminalSet = new Set(terminal);
  const edges = new Map(states.map(state => [state, new Set()]));
  for (const [from, to] of transitions) {
    if (!known.has(from)) fail(`transition from undeclared state "${from}"`);
    if (!known.has(to)) fail(`transition to undeclared state "${to}"`);
    if (from === to) fail(`self transition on "${from}" (re-writing the same state is always a no-op)`);
    if (terminalSet.has(from)) fail(`terminal state "${from}" has an outgoing transition`);
    if (edges.get(from).has(to)) fail(`duplicate transition ${from} -> ${to}`);
    edges.get(from).add(to);
  }

  const reachable = new Set([spec.initial, ...reserved]);
  const frontier = [...reachable];
  while (frontier.length) {
    for (const next of edges.get(frontier.pop())) {
      if (!reachable.has(next)) { reachable.add(next); frontier.push(next); }
    }
  }
  for (const state of states) if (!reachable.has(state)) fail(`state "${state}" is unreachable`);

  const canFinish = new Set(terminal);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [from, targets] of edges) {
      if (canFinish.has(from)) continue;
      if ([...targets].some(to => canFinish.has(to))) { canFinish.add(from); grew = true; }
    }
  }
  for (const state of states) if (!canFinish.has(state)) fail(`state "${state}" can never reach a terminal state`);

  for (const key of Object.keys(labels)) {
    if (!known.has(key) && !views.includes(key)) fail(`label for undeclared state "${key}"`);
  }
  for (const state of [...states, ...views]) {
    if (typeof labels[state] !== 'string' || !labels[state]) fail(`state "${state}" has no label`);
  }

  return Object.freeze({
    name,
    summary: String(spec.summary || ''),
    record: String(spec.record || ''),
    authority: String(spec.authority || ''),
    states: Object.freeze(states),
    initial: spec.initial,
    terminal: Object.freeze(terminal),
    active: Object.freeze(states.filter(state => !terminalSet.has(state))),
    reserved: Object.freeze(reserved),
    views: Object.freeze(views),
    transitions: Object.freeze(transitions.map(pair => Object.freeze(pair))),
    labels: Object.freeze(labels),
    notes: Object.freeze([...(spec.notes || [])]),
  });
}

const CHAT_TURN_TERMINAL = ['complete', 'stopped', 'error', 'timeout', 'orphaned'];
const ASYNC_WORK_TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const CODING_JOB_TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const BRAIN_OPERATION_TERMINAL = ['complete', 'partial', 'failed', 'cancelled', 'interrupted'];

const LIFECYCLES = Object.freeze({
  'chat-turn': defineLifecycle({
    name: 'chat-turn',
    summary: 'One assistant turn in a conversation journal.',
    record: 'TurnEnvelope (type "turn") in the conversation JSONL',
    authority: 'src/chat/turn-store.ts',
    states: ['pending', ...CHAT_TURN_TERMINAL],
    initial: 'pending',
    terminal: CHAT_TURN_TERMINAL,
    transitions: fanOut('pending', CHAT_TURN_TERMINAL),
    views: ['accepted', 'running', 'awaiting_model', 'streaming', 'tool_running', 'stopping'],
    labels: {
      pending: 'Started',
      complete: 'Complete',
      stopped: 'Stopped',
      error: 'Failed',
      timeout: 'Timed out',
      orphaned: 'Interrupted',
      accepted: 'Accepted',
      running: 'Working',
      awaiting_model: 'Thinking',
      streaming: 'Responding',
      tool_running: 'Using a tool',
      stopping: 'Stopping',
    },
    notes: [
      'The journal only ever stores "pending" (the start record) and one terminal status (the end record).',
      'The views are what a still-pending turn is reported as, derived at read time from its latest event. They are never written and must never be treated as stored states.',
      '"stopping" is declared for clients but no harness code currently reports it.',
    ],
  }),

  'async-work': defineLifecycle({
    name: 'async-work',
    summary: 'Detached or inline work a turn launched: a coding job, a sub-agent, or a scheduled agent turn.',
    record: 'AsyncWorkRecord (home23.async-work.v1)',
    authority: 'src/work/registry.ts',
    states: ['queued', 'running', 'blocked', ...ASYNC_WORK_TERMINAL],
    initial: 'running',
    terminal: ASYNC_WORK_TERMINAL,
    reserved: ['queued', 'blocked'],
    transitions: [
      ['queued', 'running'],
      ['running', 'blocked'],
      ['blocked', 'running'],
      ...fanOut('queued', ASYNC_WORK_TERMINAL),
      ...fanOut('running', ASYNC_WORK_TERMINAL),
      ...fanOut('blocked', ASYNC_WORK_TERMINAL),
    ],
    labels: {
      queued: 'Queued',
      running: 'Working',
      blocked: 'Waiting',
      completed: 'Complete',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
    },
    notes: [
      'Work is created "running". "queued" and "blocked" are part of the published type and readers accept them, but nothing writes them today.',
      'The terminal move happens exactly once; a second attempt returns the record unchanged.',
      'Delivery (deliveredAt) and review (work-verification) are separate facts recorded after the terminal move, not states of this lifecycle.',
    ],
  }),

  'coding-job': defineLifecycle({
    name: 'coding-job',
    summary: 'One run of an external coding backend (Codex, Cursor) as a child process.',
    record: 'CodingJobRecord (home23.coding-job.v1), coding-jobs/<jobId>/job.json',
    authority: 'src/acp/bridge.ts through src/acp/job-store.ts',
    states: ['starting', 'running', ...CODING_JOB_TERMINAL],
    initial: 'starting',
    terminal: CODING_JOB_TERMINAL,
    transitions: [
      ['starting', 'running'],
      ...fanOut('starting', CODING_JOB_TERMINAL),
      ...fanOut('running', CODING_JOB_TERMINAL),
    ],
    labels: {
      starting: 'Starting',
      running: 'Working',
      completed: 'Complete',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
    },
    notes: [
      'A job can end straight from "starting" when the child never spawns or is finalized during recovery.',
      'A finished coding job maps onto async-work by name: the four terminal statuses are identical.',
    ],
  }),

  'work-verification': defineLifecycle({
    name: 'work-verification',
    summary: 'Whether a finished piece of async work was reviewed before its result was delivered.',
    record: 'AsyncWorkRecord.verification',
    authority: 'src/work/completion.ts',
    states: ['none', 'pending', 'reviewed', 'skipped'],
    initial: 'none',
    terminal: ['reviewed', 'skipped'],
    transitions: [
      ['none', 'pending'],
      ['pending', 'reviewed'],
      ['pending', 'skipped'],
    ],
    labels: {
      none: 'Not reviewed',
      pending: 'Review in progress',
      reviewed: 'Reviewed',
      skipped: 'Review skipped',
    },
    notes: [
      '"none" is where most work stays: review does not apply to failures, disabled kinds, or non-human origins.',
      '"reviewed" attests that the review turn ran and its report was delivered, not that the work is correct.',
    ],
  }),

  'brain-operation': defineLifecycle({
    name: 'brain-operation',
    summary: 'A long-running brain query, synthesis or research operation.',
    record: 'Brain operation record (engine operation store)',
    authority: 'engine/src/dashboard/brain-operations/operation-contract.js',
    states: ['queued', 'running', ...BRAIN_OPERATION_TERMINAL],
    initial: 'queued',
    terminal: BRAIN_OPERATION_TERMINAL,
    transitions: [
      ['queued', 'running'],
      ...fanOut('queued', BRAIN_OPERATION_TERMINAL),
      ...fanOut('running', BRAIN_OPERATION_TERMINAL),
    ],
    labels: {
      queued: 'Queued',
      running: 'Working',
      complete: 'Complete',
      partial: 'Partly complete',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
    },
    notes: [
      'The engine operation store is the writer and enforces these moves itself; this entry mirrors it so the harness and tools share one vocabulary. A test keeps the two tables identical.',
      '"partial" is a successful terminal result with incomplete coverage, not a failure.',
    ],
  }),
});

const LIFECYCLE_NAMES = Object.freeze(Object.keys(LIFECYCLES));

function getLifecycle(name) {
  const machine = Object.hasOwn(LIFECYCLES, name) ? LIFECYCLES[name] : undefined;
  if (!machine) {
    throw lifecycleError(UNKNOWN_LIFECYCLE_ERROR_CODE, `unknown lifecycle: ${String(name)}`, { lifecycle: String(name) });
  }
  return machine;
}

/** True for a state a record of this lifecycle may be stored in. */
function isState(name, state) {
  return typeof state === 'string' && getLifecycle(name).states.includes(state);
}

/** True for a stored state or a read-time view of this lifecycle. */
function isReportedState(name, state) {
  const machine = getLifecycle(name);
  return typeof state === 'string' && (machine.states.includes(state) || machine.views.includes(state));
}

function isTerminal(name, state) {
  return typeof state === 'string' && getLifecycle(name).terminal.includes(state);
}

/** True while a record can still change: a known stored state that is not terminal. */
function isActive(name, state) {
  return typeof state === 'string' && getLifecycle(name).active.includes(state);
}

function terminalStates(name) {
  return getLifecycle(name).terminal;
}

function canTransition(name, from, to) {
  return getLifecycle(name).transitions.some(([source, target]) => source === from && target === to);
}

/**
 * Throw unless `from -> to` is a legal move. Re-writing the current state is
 * not a move and always passes, so patches that restate the status are safe.
 */
function assertTransition(name, from, to) {
  const machine = getLifecycle(name);
  if (!machine.states.includes(to)) {
    throw lifecycleError(UNKNOWN_STATE_ERROR_CODE, `${name}: "${String(to)}" is not a state`, { lifecycle: name, from, to });
  }
  if (from === to) return;
  if (machine.terminal.includes(from)) {
    throw lifecycleError(TERMINAL_ERROR_CODE, `${name}: "${from}" is final and cannot become "${to}"`, { lifecycle: name, from, to });
  }
  if (!canTransition(name, from, to)) {
    throw lifecycleError(TRANSITION_ERROR_CODE, `${name}: "${String(from)}" cannot become "${to}"`, { lifecycle: name, from, to });
  }
}

/** Throw unless `state` is one of this lifecycle's terminal states. */
function assertTerminal(name, state) {
  if (!isTerminal(name, state)) {
    throw lifecycleError(TRANSITION_ERROR_CODE, `${name}: "${String(state)}" is not a terminal state`, { lifecycle: name, to: state });
  }
}

function labelFor(name, state) {
  const label = getLifecycle(name).labels[state];
  return typeof label === 'string' ? label : null;
}

/** JSON-serializable catalog for tools and agents. */
function describeLifecycles() {
  return {
    schema: 'home23.lifecycles.v1',
    lifecycles: LIFECYCLE_NAMES.map((name) => {
      const machine = LIFECYCLES[name];
      return {
        name: machine.name,
        summary: machine.summary,
        record: machine.record,
        authority: machine.authority,
        initial: machine.initial,
        states: machine.states.map(state => ({
          state,
          label: machine.labels[state],
          terminal: machine.terminal.includes(state),
          reserved: machine.reserved.includes(state),
          next: machine.transitions.filter(([from]) => from === state).map(([, to]) => to),
        })),
        views: machine.views.map(view => ({ state: view, label: machine.labels[view] })),
        notes: [...machine.notes],
      };
    }),
  };
}

function renderLifecycleReference() {
  const lines = [
    '# Lifecycles',
    '',
    '<!-- Generated from shared/lifecycles.cjs by `node cli/home23.js lifecycles --markdown`. Do not edit by hand. -->',
    '',
    'Each lifecycle below is declared once, in `shared/lifecycles.cjs`. The store named as its authority',
    'refuses any move the table does not list, and readers ask the catalog which states are final.',
    'To change a lifecycle, edit the table, regenerate this page, and update the matching union in',
    '`shared/lifecycles.d.cts`. For lifecycles that are not in the catalog yet, see',
    '[the state machine inventory](STATE-MACHINE-INVENTORY.md).',
    '',
  ];
  for (const entry of describeLifecycles().lifecycles) {
    lines.push(`## ${entry.name}`, '', entry.summary, '');
    lines.push(`- Record: ${entry.record}`);
    lines.push(`- Authority: \`${entry.authority}\``);
    lines.push(`- Starts as: \`${entry.initial}\``, '');
    lines.push('| State | Shown as | Kind | Can become |', '| --- | --- | --- | --- |');
    for (const state of entry.states) {
      const kind = state.terminal ? 'final' : state.reserved ? 'reserved' : 'active';
      const next = state.next.length ? state.next.map(to => `\`${to}\``).join(', ') : '—';
      lines.push(`| \`${state.state}\` | ${state.label} | ${kind} | ${next} |`);
    }
    lines.push('');
    if (entry.views.length) {
      lines.push('Reported while still active, never stored:', '');
      lines.push('| View | Shown as |', '| --- | --- |');
      for (const view of entry.views) lines.push(`| \`${view.state}\` | ${view.label} |`);
      lines.push('');
    }
    for (const note of entry.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = {
  LIFECYCLES,
  LIFECYCLE_NAMES,
  TERMINAL_ERROR_CODE,
  TRANSITION_ERROR_CODE,
  UNKNOWN_LIFECYCLE_ERROR_CODE,
  UNKNOWN_STATE_ERROR_CODE,
  assertTerminal,
  assertTransition,
  canTransition,
  defineLifecycle,
  describeLifecycles,
  getLifecycle,
  isActive,
  isReportedState,
  isState,
  isTerminal,
  labelFor,
  renderLifecycleReference,
  terminalStates,
};
