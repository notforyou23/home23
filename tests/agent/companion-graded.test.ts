/**
 * Piece 4 (Step 30) — model-graded conduct fixtures.
 *
 * The scenarios in fixtures/companion-conduct-scenarios.json express conduct
 * that only a real turn can demonstrate (dissent, repair, person-first framing).
 * Fixture INTEGRITY is checked always (well-formedness is a real regression
 * guard). The model-graded run is OFF by default and turns on with
 * HOME23_LIVE_GRADED=1, mirroring the repo's HOME23_LIVE_* live-test idiom — it
 * needs a configured model + a live agent, so it never runs in plain CI.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'companion-conduct-scenarios.json');
const AGENTS = new Set(['jerry', 'forrest']);

interface Scenario {
  id: string; agent: string; input: string; situation?: string;
  must: string[]; mustNot: string[];
}

function loadScenarios(): Scenario[] {
  const doc = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { schema: string; scenarios: Scenario[] };
  assert.equal(doc.schema, 'home23.companion-conduct-scenarios.v1');
  return doc.scenarios;
}

test('conduct fixtures are well-formed (ids unique, agents valid, rubrics present)', () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length >= 8, 'covers the core conduct scenarios');
  const ids = new Set<string>();
  for (const s of scenarios) {
    assert.ok(s.id && !ids.has(s.id), `unique id: ${s.id}`);
    ids.add(s.id);
    assert.ok(AGENTS.has(s.agent), `agent is jerry or forrest: ${s.id}`);
    assert.ok(typeof s.input === 'string' && s.input.length > 0, `has input: ${s.id}`);
    assert.ok(Array.isArray(s.must) && s.must.length > 0, `has must[]: ${s.id}`);
    assert.ok(Array.isArray(s.mustNot) && s.mustNot.length > 0, `has mustNot[]: ${s.id}`);
  }
});

test('the scenario set covers the required conduct dimensions', () => {
  const ids = new Set(loadScenarios().map(s => s.id));
  for (const required of [
    'recall-shared-history', 'no-state-recital', 'reversible-move-no-theater',
    'loyal-dissent-then-help', 'accept-informed-decision', 'repair-without-apology-performance',
    'change-vs-telemetry', 'no-manufactured-emotion', 'recognizable-under-tool-failure',
  ]) {
    assert.ok(ids.has(required), `scenario present: ${required}`);
  }
});

// Model-graded run — opt-in. Needs a configured model + live agent turn + judge.
test('model-graded conduct run', { skip: !process.env.HOME23_LIVE_GRADED }, async (t) => {
  // Intentionally not wired to a live model in this environment: grading prose
  // conduct requires a real turn and a judge model, which are not available in
  // plain test runs. When HOME23_LIVE_GRADED=1 is set in an environment with a
  // running agent + provider, this is where each scenario is played through the
  // agent loop and graded against must/mustNot. Until then, this documents the
  // path and stays skipped rather than pretending to grade.
  t.skip('model-graded execution requires a live agent + judge model (see docs/design/STEP30-COMPANION-LAYER-DESIGN.md)');
});
