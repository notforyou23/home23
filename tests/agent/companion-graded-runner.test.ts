/**
 * Model-free integrity test for the Companion conduct grader's PURE helpers.
 *
 * The live, model-graded pass lives in scripts/companion-conduct-grader.mjs and
 * is off by default (it needs a real provider). This test exercises only the
 * deterministic seams — verdict computation, judge-JSON parsing, and scenario
 * schema validation — so it runs in plain CI with no model, no network, and no
 * credentials. It imports the .mjs directly; those exports must stay pure (no
 * dist/model access at module load).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  computeVerdict,
  parseJudgeJSON,
  loadScenarios,
  validateScenarios,
  shortWhy,
} from '../../scripts/companion-conduct-grader.mjs';

const okItem = (pass: boolean) => ({ item: 'x', pass, why: pass ? 'good' : 'bad' });

test('computeVerdict: pass only when every must AND every mustNot passes', () => {
  assert.equal(
    computeVerdict({ must: [okItem(true), okItem(true)], mustNot: [okItem(true)] }),
    'pass',
  );
});

test('computeVerdict: a failed must item → fail', () => {
  assert.equal(
    computeVerdict({ must: [okItem(true), okItem(false)], mustNot: [okItem(true)] }),
    'fail',
  );
});

test('computeVerdict: a violated mustNot (pass=false) → fail even if all must pass', () => {
  assert.equal(
    computeVerdict({ must: [okItem(true)], mustNot: [okItem(false)] }),
    'fail',
  );
});

test('computeVerdict: empty/missing rubric arrays and non-objects → fail', () => {
  assert.equal(computeVerdict({ must: [], mustNot: [okItem(true)] }), 'fail');
  assert.equal(computeVerdict({ must: [okItem(true)] } as any), 'fail'); // mustNot key missing
  assert.equal(computeVerdict(null as any), 'fail');
  assert.equal(computeVerdict('nope' as any), 'fail');
});

test('computeVerdict: an empty mustNot[] is vacuously satisfied', () => {
  assert.equal(computeVerdict({ must: [okItem(true)], mustNot: [] }), 'pass');
});

test('computeVerdict: pass must be strictly boolean true (truthy strings do not pass)', () => {
  assert.equal(computeVerdict({ must: [{ item: 'x', pass: 'true' }], mustNot: [] } as any), 'fail');
});

test('parseJudgeJSON: strips ```json fences', () => {
  const raw = '```json\n{"must":[{"item":"a","pass":true}],"mustNot":[],"verdict":"pass"}\n```';
  const parsed = parseJudgeJSON(raw);
  assert.equal(parsed.verdict, 'pass');
  assert.equal(parsed.must[0].pass, true);
});

test('parseJudgeJSON: strips bare ``` fences', () => {
  const raw = '```\n{"must":[],"mustNot":[]}\n```';
  assert.deepEqual(parseJudgeJSON(raw), { must: [], mustNot: [] });
});

test('parseJudgeJSON: tolerates surrounding prose and extracts the object', () => {
  const raw = 'Sure! Here is my grade:\n{"must":[{"item":"a","pass":false,"why":"missed"}],"mustNot":[]}\nHope that helps.';
  const parsed = parseJudgeJSON(raw);
  assert.equal(parsed.must[0].pass, false);
  assert.equal(parsed.must[0].why, 'missed');
});

test('parseJudgeJSON: throws when no JSON object is present', () => {
  assert.throws(() => parseJudgeJSON('no json here at all'), /no JSON object/);
  assert.throws(() => parseJudgeJSON(42 as any), /not a string/);
});

test('loadScenarios: the real fixture validates and returns the scenario set', () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length >= 8);
  for (const s of scenarios) {
    assert.ok(typeof s.id === 'string' && s.id);
    assert.ok(Array.isArray(s.must) && s.must.length > 0);
    assert.ok(Array.isArray(s.mustNot) && s.mustNot.length > 0);
  }
});

test('loadScenarios: throws on a missing file', () => {
  assert.throws(() => loadScenarios('/no/such/scenarios.json'), /not found/);
});

test('loadScenarios: reads and validates a temp fixture', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'grader-scn-'));
  try {
    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({
      schema: 'home23.companion-conduct-scenarios.v1',
      scenarios: [{ id: 'a', agent: 'jerry', input: 'hi', must: ['do x'], mustNot: ['do y'] }],
    }));
    assert.equal(loadScenarios(good).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateScenarios: rejects wrong schema, dup ids, and empty rubrics', () => {
  const base = { id: 'a', agent: 'jerry', input: 'hi', must: ['x'], mustNot: ['y'] };
  assert.throws(() => validateScenarios({ schema: 'other', scenarios: [base] }), /unexpected schema/);
  assert.throws(() => validateScenarios({ schema: 'home23.companion-conduct-scenarios.v1', scenarios: [] }), /missing or empty/);
  assert.throws(
    () => validateScenarios({ schema: 'home23.companion-conduct-scenarios.v1', scenarios: [base, { ...base }] }),
    /duplicate scenario id/,
  );
  assert.throws(
    () => validateScenarios({ schema: 'home23.companion-conduct-scenarios.v1', scenarios: [{ ...base, must: [] }] }),
    /must\[\] must be a non-empty array/,
  );
  assert.throws(
    () => validateScenarios({ schema: 'home23.companion-conduct-scenarios.v1', scenarios: [{ ...base, mustNot: 'nope' }] }),
    /mustNot\[\] must be a non-empty array/,
  );
});

test('shortWhy: surfaces the first failing item on a fail, notes otherwise', () => {
  const judge = {
    must: [{ item: 'a', pass: true, why: 'ok' }, { item: 'b', pass: false, why: 'the specific miss' }],
    mustNot: [{ item: 'c', pass: true, why: 'clean' }],
    notes: 'overall fine',
  };
  assert.match(shortWhy(judge, 'fail'), /specific miss/);
  assert.equal(shortWhy(judge, 'pass'), 'overall fine');
});
