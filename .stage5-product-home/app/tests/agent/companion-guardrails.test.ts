/**
 * Piece 4 (Step 30) — companion guardrail tests.
 *
 * Static-source + invariant checks that lock in the safety properties: the
 * attention gate never discriminates by user identity, SOUL is delivered whole
 * (not the old 3000-char clip), and Jerry and Forrest stay distinct agents.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AttentionGate } from '../../src/agent/attention/attention-gate.js';
import { DEFAULT_IDENTITY_BUDGETS, classifyIdentityLayer } from '../../src/agent/identity-budget.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

// The live per-agent instances live in the MAIN checkout, not the worktree.
function mainCheckoutRoot(): string {
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = REPO_ROOT.indexOf(marker);
  return idx >= 0 ? REPO_ROOT.slice(0, idx) : REPO_ROOT;
}

test('attention gate materiality never keys on user/chat identity (static source)', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'src/agent/attention/attention-gate.ts'), 'utf8');
  // The one place chatId is read is the user-reply SAFETY guard (surface-always),
  // never a materiality/suppression decision. Assert materialReason() is clean.
  const materialFn = src.slice(src.indexOf('private materialReason'), src.indexOf('private maxAgeFor'));
  assert.doesNotMatch(materialFn, /chatId|user_?id|userId|telegram/i,
    'materiality must not depend on who the message is about/for');
  // And the hard user-reply guard must exist.
  assert.match(src, /user_reply_never_gated/);
  assert.match(src, /isNumericChatId/);
});

test('same non-user payload yields the same verdict regardless of chatId', () => {
  const gate = new AttentionGate({ nowMs: () => 1000 });
  const base = { origin: 'cron' as const, text: 'routine status', kind: 'status' };
  const a = gate.evaluate({ ...base, chatId: 'cron-aaa' });
  const b = gate.evaluate({ ...base, chatId: 'cron-bbb' });
  assert.deepEqual({ d: a.decision, r: a.reason }, { d: b.decision, r: b.reason },
    'the gate does not discriminate resident messages by their origin id');
});

test('a numeric (real jtr) chatId always surfaces, even for telemetry', () => {
  const gate = new AttentionGate({ nowMs: () => 1000 });
  const v = gate.evaluate({ origin: 'unknown', chatId: '987654', text: 'metrics', kind: 'telemetry' });
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'user_reply_never_gated');
});

test('SOUL budget regression: the enduring self is no longer clipped at 3000 chars', () => {
  assert.ok(DEFAULT_IDENTITY_BUDGETS['SOUL.md'].budget >= 8000,
    'SOUL must have room for the whole companion doctrine');
  assert.equal(classifyIdentityLayer('SOUL.md'), 'enduring_self');
});

test('Jerry and Forrest are distinct agents with distinct souls carrying the companion shape', (t) => {
  const root = mainCheckoutRoot();
  const jerrySoul = path.join(root, 'instances/jerry/workspace/SOUL.md');
  const forrestSoul = path.join(root, 'instances/forrest/workspace/SOUL.md');
  if (!existsSync(jerrySoul) || !existsSync(forrestSoul)) {
    return t.skip('live jerry/forrest instances not present in this checkout');
  }
  const jerry = readFileSync(jerrySoul, 'utf8');
  const forrest = readFileSync(forrestSoul, 'utf8');
  assert.notEqual(jerry, forrest, 'the two souls are not the same text');
  // Both carry the R2/3PO companion shape, in their own voice.
  assert.match(jerry, /Companion shape/);
  assert.match(forrest, /Companion shape/);
  // Distinct roles are visible in the text.
  assert.match(jerry.toLowerCase(), /sidekick|gets shit done|2am/);
  assert.match(forrest.toLowerCase(), /health/);
  // Both fit the 8000 SOUL budget whole (the whole doctrine reaches the model).
  assert.ok(jerry.trim().length <= DEFAULT_IDENTITY_BUDGETS['SOUL.md'].budget);
  assert.ok(forrest.trim().length <= DEFAULT_IDENTITY_BUDGETS['SOUL.md'].budget);
});
