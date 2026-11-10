/**
 * The two update lifecycles, as the updater itself carries them.
 *
 * The update worker runs from a retained copy of this directory so it
 * survives the software being replaced underneath it. That copy follows only
 * `./` imports, so this module must stay self-contained: no imports at all.
 *
 * shared/lifecycles.cjs declares the same two lifecycles ("home-update" and
 * "update-journal") for everything else that reads them. The tables here and
 * there must be identical; tests/cli/product-update-lifecycles.test.js fails
 * when they are not, and checks that this guard decides every move the same
 * way as the catalog's guardTransition.
 */

const HOME_UPDATE_WORKING = ['checking', 'downloading', 'preparing', 'updating', 'reconnecting'];
const JOURNAL_BEFORE_SWITCH = ['claimed', 'quiesced', 'checkpointed', 'retained', 'applying'];
const JOURNAL_AFTER_SWITCH = ['selected', 'verifying', 'writers_admitted', 'accepted'];
const JOURNAL_TERMINAL = ['committed', 'rolled_back', 'aborted'];

function table(spec) {
  return Object.freeze({
    ...spec,
    states: Object.freeze(spec.states),
    terminal: Object.freeze(spec.terminal),
    resting: Object.freeze(spec.resting),
    settled: Object.freeze([...spec.terminal, ...spec.resting]),
    transitions: Object.freeze(spec.transitions.map(pair => Object.freeze(pair))),
  });
}

export const UPDATE_LIFECYCLES = Object.freeze({
  'home-update': table({
    states: ['queued', ...HOME_UPDATE_WORKING, 'failed', 'completed'],
    initial: 'queued',
    terminal: ['completed'],
    // "interrupted" is reported for a working record whose worker is gone; it is never stored.
    resting: ['failed', 'interrupted'],
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
  }),
  'update-journal': table({
    states: [...JOURNAL_BEFORE_SWITCH, ...JOURNAL_AFTER_SWITCH, 'recovery_required', ...JOURNAL_TERMINAL],
    initial: 'claimed',
    terminal: JOURNAL_TERMINAL,
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
      ...JOURNAL_BEFORE_SWITCH.flatMap(from => [[from, 'aborted'], [from, 'recovery_required']]),
      // A partly switched tree is finished or undone by the same verification as a selected one.
      ['applying', 'writers_admitted'],
      ['applying', 'accepted'],
      // After selection, an unhealthy candidate is rolled back or fenced.
      ...['applying', 'selected', 'verifying', 'writers_admitted'].map(from => [from, 'rolled_back']),
      ...JOURNAL_AFTER_SWITCH.map(from => [from, 'recovery_required']),
      // A fenced journal is reopened, resumed where it failed, or closed.
      ['recovery_required', 'claimed'],
      ['recovery_required', 'selected'],
      ['recovery_required', 'verifying'],
      ['recovery_required', 'writers_admitted'],
      ['recovery_required', 'accepted'],
      ...JOURNAL_TERMINAL.map(to => ['recovery_required', to]),
    ],
  }),
});

function moveError(code, message, detail) {
  return Object.assign(new Error(message), { code, ...detail });
}

function strictMoves(env) {
  if (env.HOME23_LIFECYCLE_STRICT === '1') return true;
  if (env.HOME23_LIFECYCLE_STRICT === '0') return false;
  // `node --test` marks its test processes. Every test run enforces the table.
  return Boolean(env.NODE_TEST_CONTEXT);
}

/** True for a final state of the named update lifecycle. */
export function isFinalUpdateState(name, state) {
  return UPDATE_LIFECYCLES[name].terminal.includes(state);
}

/**
 * Check one write of a phase.
 *
 * Always throws when `to` is not a declared state, and when `from` is final
 * and differs from `to`: a finished update is never rewritten. Restating the
 * current phase is not a move. A record saved by another build in a phase
 * this table does not know may be moved to any declared one.
 *
 * Any other unlisted move throws under strict mode (every test run, or
 * HOME23_LIFECYCLE_STRICT=1). Outside it the move is reported and allowed:
 * refusing a durable write in the middle of a cutover or a recovery could
 * leave a home worse off than making it. Returns true when the move is listed.
 */
export function guardUpdateMove(name, from, to, options = {}) {
  const machine = UPDATE_LIFECYCLES[name];
  if (!machine.states.includes(to)) {
    throw moveError('lifecycle_state_unknown', `${name}: "${String(to)}" is not a state`, { lifecycle: name, from, to });
  }
  if (from === to || !machine.states.includes(from)) return true;
  if (machine.terminal.includes(from)) {
    throw moveError('lifecycle_terminal', `${name}: "${from}" is final and cannot become "${to}"`, { lifecycle: name, from, to });
  }
  if (machine.transitions.some(([source, target]) => source === from && target === to)) return true;
  const error = moveError('lifecycle_transition_invalid', `${name}: "${from}" cannot become "${to}"`, { lifecycle: name, from, to });
  const strict = options.strict === undefined ? strictMoves(options.env || process.env) : options.strict;
  if (strict) throw error;
  (options.report || (problem => process.emitWarning(`${problem.message}; the move is not declared`, { code: 'HOME23_LIFECYCLE' })))(error);
  return false;
}

/** A newly created record must start in the lifecycle's initial state. */
export function guardUpdateStart(name, state) {
  const machine = UPDATE_LIFECYCLES[name];
  if (state !== machine.initial) {
    throw moveError('lifecycle_transition_invalid', `${name}: a new record starts as "${machine.initial}", not "${String(state)}"`, { lifecycle: name, to: state });
  }
}
