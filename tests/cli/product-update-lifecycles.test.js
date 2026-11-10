import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  UPDATE_LIFECYCLES, guardUpdateMove, guardUpdateStart, isFinalUpdateState,
} from '../../cli/lib/product-update-lifecycles.js';

const require = createRequire(import.meta.url);
const { LIFECYCLES, guardTransition } = require('../../shared/lifecycles.cjs');
const library = resolve(dirname(fileURLToPath(import.meta.url)), '../../cli/lib');
const names = ['home-update', 'update-journal'];

test('the updater\'s own tables are identical to the catalog', () => {
  assert.deepEqual(Object.keys(UPDATE_LIFECYCLES), names);
  for (const name of names) {
    const own = UPDATE_LIFECYCLES[name], catalog = LIFECYCLES[name];
    assert.deepEqual([...own.states], [...catalog.states], `${name} states`);
    assert.equal(own.initial, catalog.initial, `${name} initial`);
    assert.deepEqual([...own.terminal], [...catalog.terminal], `${name} terminal`);
    assert.deepEqual([...own.resting], [...catalog.resting], `${name} resting`);
    assert.deepEqual([...own.settled], [...catalog.settled], `${name} settled`);
    assert.deepEqual(own.transitions.map(pair => pair.join('>')), catalog.transitions.map(pair => pair.join('>')), `${name} transitions`);
    assert.ok(Object.isFrozen(own) && Object.isFrozen(own.states) && Object.isFrozen(own.transitions));
  }
});

test('the updater\'s guard decides every move exactly as the catalog guard does', () => {
  const verdict = (guard) => {
    try { return guard() ? 'listed' : 'reported'; }
    catch (error) { return error.code; }
  };
  for (const name of names) {
    const candidates = [...LIFECYCLES[name].states, ...LIFECYCLES[name].views, 'not_a_state', undefined];
    for (const strict of [true, false]) {
      for (const from of candidates) {
        for (const to of candidates) {
          const options = { strict, report() {} };
          assert.equal(
            verdict(() => guardUpdateMove(name, from, to, options)),
            verdict(() => guardTransition(name, from, to, options)),
            `${name} ${String(from)} -> ${String(to)} (strict ${strict})`,
          );
        }
      }
    }
  }
});

test('a finished update is never rewritten, in any mode', () => {
  for (const strict of [true, false]) {
    for (const from of ['committed', 'rolled_back', 'aborted']) {
      for (const to of UPDATE_LIFECYCLES['update-journal'].states) {
        if (to === from) assert.equal(guardUpdateMove('update-journal', from, to, { strict }), true);
        else assert.throws(() => guardUpdateMove('update-journal', from, to, { strict }), { code: 'lifecycle_terminal' });
      }
    }
    assert.throws(() => guardUpdateMove('home-update', 'completed', 'queued', { strict }), { code: 'lifecycle_terminal' });
    assert.throws(() => guardUpdateMove('home-update', 'updating', 'finished', { strict }), { code: 'lifecycle_state_unknown' });
  }
  assert.equal(isFinalUpdateState('update-journal', 'committed'), true);
  assert.equal(isFinalUpdateState('update-journal', 'recovery_required'), false);
  assert.equal(isFinalUpdateState('home-update', 'failed'), false);
  assert.equal(isFinalUpdateState('home-update', undefined), false);
});

test('an unlisted move is refused in tests and reported, not refused, in production', () => {
  // Skipping the checkpoint is not a declared move.
  assert.throws(() => guardUpdateMove('update-journal', 'quiesced', 'applying', { strict: true }),
    { code: 'lifecycle_transition_invalid' });
  const reported = [];
  assert.equal(guardUpdateMove('update-journal', 'quiesced', 'applying', { strict: false, report: error => reported.push(error) }), false);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, 'lifecycle_transition_invalid');
  assert.deepEqual([reported[0].from, reported[0].to], ['quiesced', 'applying']);

  // Strictness follows the environment: every `node --test` process, or the explicit switch.
  const quiet = { report() {} };
  assert.throws(() => guardUpdateMove('home-update', 'checking', 'updating', { env: { NODE_TEST_CONTEXT: 'child-v8' } }));
  assert.throws(() => guardUpdateMove('home-update', 'checking', 'updating', { env: { HOME23_LIFECYCLE_STRICT: '1' } }));
  assert.equal(guardUpdateMove('home-update', 'checking', 'updating', { env: {}, ...quiet }), false);
  assert.equal(guardUpdateMove('home-update', 'checking', 'updating', { env: { NODE_TEST_CONTEXT: 'child-v8', HOME23_LIFECYCLE_STRICT: '0' }, ...quiet }), false);
  // This process is a test process, so the default is strict.
  assert.throws(() => guardUpdateMove('home-update', 'checking', 'updating'), { code: 'lifecycle_transition_invalid' });
});

test('resume, recovery and legacy records keep working', () => {
  const strict = { strict: true };
  // A failed or dead run goes back to queued; the resumed worker skips finished stages.
  for (const from of ['failed', 'checking', 'downloading', 'preparing', 'updating', 'reconnecting']) {
    assert.equal(guardUpdateMove('home-update', from, 'queued', strict), true);
  }
  for (const to of ['checking', 'downloading', 'updating', 'reconnecting', 'failed']) {
    assert.equal(guardUpdateMove('home-update', 'queued', to, strict), true);
  }
  // A fenced journal is reopened, resumed where it failed, or closed.
  for (const to of ['claimed', 'selected', 'verifying', 'writers_admitted', 'accepted', 'committed', 'rolled_back', 'aborted']) {
    assert.equal(guardUpdateMove('update-journal', 'recovery_required', to, strict), true);
  }
  // A record saved in a phase this build does not declare can still be moved on.
  assert.equal(guardUpdateMove('home-update', 'interrupted', 'failed', strict), true);
  assert.equal(guardUpdateMove('update-journal', 'staging', 'recovery_required', strict), true);
  // New records start at the beginning.
  assert.doesNotThrow(() => guardUpdateStart('home-update', 'queued'));
  assert.doesNotThrow(() => guardUpdateStart('update-journal', 'claimed'));
  assert.throws(() => guardUpdateStart('update-journal', 'selected'), { code: 'lifecycle_transition_invalid' });
});

test('the lifecycle module stays inside what the retained update executor copies', () => {
  // The executor copies cli/lib modules reached through `./` imports only.
  const local = /(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  const own = readFileSync(join(library, 'product-update-lifecycles.js'), 'utf8');
  assert.doesNotMatch(own, /^\s*import\s/m, 'product-update-lifecycles.js must not import anything');
  assert.doesNotMatch(own, /\brequire\s*\(/);
  for (const file of ['product-home-update.js', 'product-update-apply.js']) {
    const source = readFileSync(join(library, file), 'utf8');
    assert.match(source, /from '\.\/product-update-lifecycles\.js'/, `${file} must use the updater's own tables`);
    assert.doesNotMatch(source, /shared\/lifecycles/, `${file} must not reach outside cli/lib for its lifecycle`);
    for (const match of source.matchAll(local)) {
      assert.ok(match[1].startsWith('./'), `${file} imports ${match[1]}, which the retained executor would not copy`);
    }
  }
});

test('the recovery controller copy includes every module its files import', () => {
  // installController copies an explicit list. A module missing from it leaves
  // a home's recovery controller unable to start, mid-update.
  const apply = readFileSync(join(library, 'product-update-apply.js'), 'utf8');
  const list = /const LIB_FILES = \[([^\]]+)\];/.exec(apply);
  assert.ok(list, 'LIB_FILES not found');
  const files = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(files.includes('product-update-lifecycles.js'));
  for (const file of files) {
    const source = readFileSync(join(library, file), 'utf8');
    // Static imports only; a lazy import('./x') is the caller's own decision.
    for (const match of source.matchAll(/\bfrom\s*['"]\.\/([^'"]+)['"]/g)) {
      assert.ok(files.includes(match[1]), `${file} imports ./${match[1]}, which the recovery controller does not copy`);
    }
  }
});
