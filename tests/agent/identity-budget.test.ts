/**
 * Piece 1 (Step 30) — section-aware identity budgeting.
 *
 * The bug these tests lock down: SOUL.md was blindly sliced at 3000 chars,
 * silently, mid-sentence — cutting the companion doctrine off before the model
 * ever saw it. Budgeting must keep whole sections, never cut mid-word, and make
 * every omission visible.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  budgetIdentityContent,
  classifyIdentityLayer,
  resolveBudget,
  DEFAULT_IDENTITY_BUDGETS,
} from '../../src/agent/identity-budget.js';

const SOUL_LIKE = [
  '# SOUL.md — jerry',
  '',
  '🦞 jerry. jtr\'s 2am sidekick.',
  '',
  '## Core',
  '- Strong takes. Wrong > hedge.',
  '- Protect jtr\'s time.',
  '',
  '## Companion shape',
  'R2-D2 nerve with C-3PO language. Not cosplay—the useful combination.',
  '- **R2:** notice broadly, interrupt narrowly.',
  '- **Object permanence:** chats end; threads, promises, judgments do not.',
  '',
  '## How I work',
  '- inspect before theorizing',
].join('\n');

test('content within budget is returned whole and untruncated', () => {
  const out = budgetIdentityContent('SOUL.md', SOUL_LIKE, 8000, 'head');
  assert.equal(out.truncated, false);
  assert.equal(out.omittedSections.length, 0);
  assert.ok(out.text.includes('Companion shape'));
  assert.ok(out.text.includes('Object permanence'));
  assert.equal(out.includedBytes, SOUL_LIKE.trim().length);
});

test('SOUL.md default budget (8000) keeps a ~5k companion doctrine whole', () => {
  // A realistic 5k SOUL — the real Jerry/Forrest files are 4.5-5k. The old
  // 3000 cap dropped the tail; the new default must not.
  const big = SOUL_LIKE + '\n\n' + 'x'.repeat(4200);
  const { budget } = resolveBudget('SOUL.md');
  assert.equal(budget, 8000);
  const out = budgetIdentityContent('SOUL.md', big, budget, 'head');
  assert.equal(out.truncated, false, 'a 5k SOUL fits the 8000 budget whole');
  assert.ok(out.text.includes('Companion shape'));
});

test('over-budget content drops WHOLE low-priority sections and marks the omission', () => {
  const out = budgetIdentityContent('MISSION.md', SOUL_LIKE, 200, 'head');
  assert.equal(out.truncated, true);
  assert.ok(out.omittedSections.length > 0, 'named sections were dropped');
  // The diagnostic is visible in the injected text so the model knows content was withheld.
  assert.match(out.text, /identity-budget: kept \d+\/\d+ chars of MISSION\.md; kept sections:.*omitted \d+ section/);
  // Kept content ends at a section boundary, never mid-word.
  assert.ok(!/\w-$/.test(out.text.split('\n\n_[identity-budget')[0].trimEnd()));
});

test('never cuts mid-word: a single over-budget section truncates on a boundary', () => {
  const oneSection = '# Big\n' + 'alpha beta gamma delta epsilon zeta eta theta '.repeat(40);
  const out = budgetIdentityContent('NOTES.md', oneSection, 120, 'head');
  assert.equal(out.truncated, true);
  const kept = out.text.split('\n\n_[identity-budget')[0];
  // last retained token is a whole word (no trailing partial word / hyphen)
  assert.doesNotMatch(kept.trimEnd(), /\S-$/);
  assert.ok(!kept.endsWith('epsilo'));
});

test("tail strategy keeps the END of the file (LEARNINGS-style recency)", () => {
  const doc = [
    '## Old entry', 'stale detail '.repeat(20),
    '## Newer entry', 'FRESH_MARKER recent detail',
  ].join('\n');
  const out = budgetIdentityContent('LEARNINGS.md', doc, 120, 'tail');
  assert.ok(out.text.includes('FRESH_MARKER'), 'tail strategy retained the most recent section');
});

test('layer classification maps the six-layer scheme', () => {
  assert.equal(classifyIdentityLayer('SOUL.md'), 'enduring_self');
  assert.equal(classifyIdentityLayer('PERSONAL.md'), 'relationship');
  assert.equal(classifyIdentityLayer('RELATIONSHIP.md'), 'relationship');
  assert.equal(classifyIdentityLayer('MISSION.md'), 'role');
  assert.equal(classifyIdentityLayer('GOOD_LIFE.md'), 'role');
  assert.equal(classifyIdentityLayer('PLAYBOOK.md'), 'operational');
  assert.equal(classifyIdentityLayer('SKILL_ROUTING.md'), 'operational');
  assert.equal(classifyIdentityLayer('NOW.md'), 'world_state');
  assert.equal(classifyIdentityLayer('WEATHER_AWARE_SURFACING.md'), 'world_state');
});

test('config override replaces the default budget but keeps the strategy', () => {
  const r = resolveBudget('LEARNINGS.md', { 'LEARNINGS.md': 999 });
  assert.equal(r.budget, 999);
  assert.equal(r.strategy, 'head');
  // A file with no default falls back to the generic budget.
  assert.equal(resolveBudget('UNKNOWN_FILE.md').budget, 4000);
});

test('SOUL default budget is larger than the old 3000 cap (regression guard)', () => {
  assert.ok(DEFAULT_IDENTITY_BUDGETS['SOUL.md'].budget > 3000);
});

test('LEARNINGS.md default keeps the newest-first HEAD, not the oldest tail', () => {
  const resolved = resolveBudget('LEARNINGS.md');
  assert.equal(resolved.strategy, 'head');
  assert.ok(resolved.budget >= 8000);
  const doc = [
    '## 2026-07-31: Newest', 'LIVE_CORRECTION the current rule',
    '## 2026-04-09: Oldest', 'STALE_TAIL '.repeat(900),
  ].join('\n');
  const out = budgetIdentityContent('LEARNINGS.md', doc, resolved.budget, resolved.strategy);
  assert.ok(out.text.includes('LIVE_CORRECTION'), 'newest-first LEARNINGS must keep the latest entry');
  assert.equal(out.text.includes('STALE_TAIL'), false, 'oldest LEARNINGS entries must be the ones dropped');
  assert.match(out.text, /kept sections:.*2026-07-31: Newest/);
  assert.match(out.text, /omitted .*2026-04-09: Oldest/);
  assert.equal(out.omittedSections.includes('2026-07-31: Newest'), false);
});
