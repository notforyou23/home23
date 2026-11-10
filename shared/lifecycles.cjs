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
 *   - a resting state (nothing is running, the record waits to be resumed) is a
 *     declared state or view, and never a terminal state
 */
function defineLifecycle(spec) {
  const name = String(spec.name || '');
  const fail = message => { throw new Error(`lifecycle "${name}": ${message}`); };
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail('name must be kebab-case');

  const states = [...spec.states];
  const terminal = [...spec.terminal];
  const reserved = [...(spec.reserved || [])];
  const views = [...(spec.views || [])];
  const resting = [...(spec.resting || [])];
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
  for (const state of resting) {
    if (!known.has(state) && !views.includes(state)) fail(`resting state "${state}" is not declared`);
    if (terminal.includes(state)) fail(`resting state "${state}" is also terminal`);
  }

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
    resting: Object.freeze(resting),
    settled: Object.freeze([...terminal, ...resting]),
    transitions: Object.freeze(transitions.map(pair => Object.freeze(pair))),
    labels: Object.freeze(labels),
    notes: Object.freeze([...(spec.notes || [])]),
  });
}

const CHAT_TURN_TERMINAL = ['complete', 'stopped', 'error', 'timeout', 'orphaned'];
const ASYNC_WORK_TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const CODING_JOB_TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const BRAIN_OPERATION_TERMINAL = ['complete', 'partial', 'failed', 'cancelled', 'interrupted'];
const HOME_UPDATE_WORKING = ['checking', 'downloading', 'preparing', 'updating', 'reconnecting'];
const UPDATE_JOURNAL_BEFORE_SWITCH = ['claimed', 'quiesced', 'checkpointed', 'retained', 'applying'];
const UPDATE_JOURNAL_AFTER_SWITCH = ['selected', 'verifying', 'writers_admitted', 'accepted'];
const UPDATE_JOURNAL_TERMINAL = ['committed', 'rolled_back', 'aborted'];

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

  'home-update': defineLifecycle({
    name: 'home-update',
    summary: 'One owner-requested check, update, resume or recovery of the whole product.',
    record: 'Home update operation (home23.home-update.v1), one JSON file per operation',
    authority: 'cli/lib/product-home-update.js',
    states: ['queued', ...HOME_UPDATE_WORKING, 'failed', 'completed'],
    initial: 'queued',
    terminal: ['completed'],
    resting: ['failed', 'interrupted'],
    views: ['interrupted'],
    transitions: [
      // The worker picks up wherever the saved record lets it start.
      ['queued', 'checking'],
      ['queued', 'downloading'],
      ['queued', 'updating'],
      ['queued', 'reconnecting'],
      ['checking', 'completed'],
      ['downloading', 'preparing'],
      ['preparing', 'updating'],
      ['updating', 'reconnecting'],
      ['reconnecting', 'completed'],
      // Anything in flight can fail, and a failed or abandoned run can be resumed.
      ...['queued', ...HOME_UPDATE_WORKING].map(from => [from, 'failed']),
      ...[...HOME_UPDATE_WORKING, 'failed'].map(from => [from, 'queued']),
    ],
    labels: {
      queued: 'Queued',
      checking: 'Checking for updates',
      downloading: 'Downloading',
      preparing: 'Preparing',
      updating: 'Updating',
      reconnecting: 'Reconnecting',
      failed: 'Needs attention',
      completed: 'Complete',
      interrupted: 'Interrupted',
    },
    notes: [
      'Only "completed" is final. "failed" rests until the owner resumes or recovers, which moves the same record back to "queued" with its attempt count raised.',
      '"interrupted" is never stored: it is what a record still in a working state is reported as once its worker process is gone. Resuming it also returns the record to "queued".',
      'A resumed worker skips the stages the record shows are done, which is why "queued" can lead straight to "updating" or "reconnecting".',
      'Flags such as runtimeCompleted, applicationCompleted and requiresLocalRecovery are facts on the record, not states.',
      'An unlisted move between two known, non-final states is reported rather than refused outside tests, for the same reason as update-journal.',
      'The updater carries its own copy of this table in cli/lib/product-update-lifecycles.js, because the update worker and the recovery controller run from retained copies of cli/lib that cannot import shared/. A test keeps the two identical.',
    ],
  }),

  'update-journal': defineLifecycle({
    name: 'update-journal',
    summary: 'The crash-resumable cutover of an installed home from one software package to the next.',
    record: 'Update journal (journal.json in the home\'s update directory)',
    authority: 'cli/lib/product-update-apply.js',
    states: [...UPDATE_JOURNAL_BEFORE_SWITCH, ...UPDATE_JOURNAL_AFTER_SWITCH, 'recovery_required', ...UPDATE_JOURNAL_TERMINAL],
    initial: 'claimed',
    terminal: UPDATE_JOURNAL_TERMINAL,
    reserved: ['verifying'],
    resting: ['recovery_required'],
    transitions: [
      // The forward path.
      ['claimed', 'quiesced'],
      ['quiesced', 'checkpointed'],
      ['checkpointed', 'retained'],
      ['retained', 'applying'],
      ['applying', 'selected'],
      ['selected', 'verifying'],
      ['selected', 'writers_admitted'],
      ['selected', 'accepted'],
      ['verifying', 'writers_admitted'],
      ['verifying', 'accepted'],
      ['writers_admitted', 'accepted'],
      ['accepted', 'committed'],
      // Before the new software is selected, a refusal ends the update or fences it.
      ...UPDATE_JOURNAL_BEFORE_SWITCH.flatMap(from => [[from, 'aborted'], [from, 'recovery_required']]),
      // A partly switched tree is finished or undone by the same verification as a selected one.
      ['applying', 'writers_admitted'],
      ['applying', 'accepted'],
      // After selection, an unhealthy candidate is rolled back or fenced.
      ...['applying', 'selected', 'verifying', 'writers_admitted'].map(from => [from, 'rolled_back']),
      ...UPDATE_JOURNAL_AFTER_SWITCH.map(from => [from, 'recovery_required']),
      // A fenced journal is reopened, resumed where it failed, or closed.
      ['recovery_required', 'claimed'],
      ['recovery_required', 'selected'],
      ['recovery_required', 'verifying'],
      ['recovery_required', 'writers_admitted'],
      ['recovery_required', 'accepted'],
      ...UPDATE_JOURNAL_TERMINAL.map(to => ['recovery_required', to]),
    ],
    labels: {
      claimed: 'Claimed',
      quiesced: 'Home stopped for update',
      checkpointed: 'State checkpointed',
      retained: 'Previous software retained',
      applying: 'Switching software',
      selected: 'New software selected',
      verifying: 'Verifying',
      writers_admitted: 'Home restarted',
      accepted: 'Accepted',
      recovery_required: 'Needs recovery',
      committed: 'Updated',
      rolled_back: 'Rolled back',
      aborted: 'Not updated',
    },
    notes: [
      'A final journal is archived and a new update starts a new journal; a final journal is never written again.',
      '"recovery_required" records the state it was fenced from in recoveryFrom. It rests until a resume, an owner recovery or a workspace reconciliation moves it on.',
      '"verifying" is accepted from journals written by earlier builds; the current updater never writes it.',
      'Unlike the other lifecycles, an unlisted move between two known, non-final states is reported rather than refused outside tests: refusing a durable write in the middle of a cutover could strand a home. Unknown states and moves out of a final state are always refused.',
      'The updater carries its own copy of this table in cli/lib/product-update-lifecycles.js, because the update worker and the recovery controller run from retained copies of cli/lib that cannot import shared/. A test keeps the two identical.',
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

/**
 * True when nothing is running for the record: it is final, or it rests until
 * someone resumes it. Accepts stored states and views.
 */
function isSettled(name, state) {
  return typeof state === 'string' && getLifecycle(name).settled.includes(state);
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

/**
 * True when an unlisted move should be refused rather than reported. Always
 * true unless a caller opts into reporting; see guardTransition.
 */
function strictTransitions(env = process.env) {
  if (env.HOME23_LIFECYCLE_STRICT === '1') return true;
  if (env.HOME23_LIFECYCLE_STRICT === '0') return false;
  // `node --test` marks its test processes. Every test run enforces the table.
  return Boolean(env.NODE_TEST_CONTEXT);
}

/**
 * The guard for crash-resumable procedures, where refusing a durable write
 * can leave an installation worse off than making it.
 *
 * Always throws for a state the table does not declare and for a move out of
 * a final state. Any other unlisted move throws under strict mode (every test
 * run, or HOME23_LIFECYCLE_STRICT=1) and is otherwise passed to `report` and
 * allowed. Returns true when the move is listed.
 *
 * cli/lib/product-update-lifecycles.js carries its own copy of this rule for
 * the two update lifecycles, because the update worker cannot import this
 * file. A test keeps the two deciding every move identically.
 *
 * Prefer assertTransition. Use this only where a mistake in the table must
 * not be able to stop a recovery.
 */
function guardTransition(name, from, to, options = {}) {
  try {
    // A record saved by another build in a state this table does not know may
    // be moved to any declared one.
    assertTransition(name, isState(name, from) ? from : to, to);
    return true;
  } catch (error) {
    if (error.code !== TRANSITION_ERROR_CODE) throw error;
    const strict = options.strict === undefined ? strictTransitions() : options.strict;
    if (strict) throw error;
    (options.report || defaultTransitionReport)(error);
    return false;
  }
}

function defaultTransitionReport(error) {
  process.emitWarning(`${error.message}; the move is not in shared/lifecycles.cjs`, { code: 'HOME23_LIFECYCLE' });
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
          resting: machine.resting.includes(state),
          reserved: machine.reserved.includes(state),
          next: machine.transitions.filter(([from]) => from === state).map(([, to]) => to),
        })),
        views: machine.views.map(view => ({
          state: view, label: machine.labels[view], resting: machine.resting.includes(view),
        })),
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
    'refuses any move the table does not list (an entry\'s notes say so where it only reports one), and readers',
    'ask the catalog which states are final.',
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
      const kind = state.terminal ? 'final' : state.resting ? 'resting' : state.reserved ? 'reserved' : 'active';
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
  guardTransition,
  isSettled,
  strictTransitions,
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
