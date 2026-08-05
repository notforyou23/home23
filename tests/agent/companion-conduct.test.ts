/**
 * Piece 4 (Step 30) — behavioral conduct tests.
 *
 * These assert CONDUCT, not prose style: what the harness lets an agent notice,
 * remember, surface, suppress, and keep private — the mechanics that make the
 * SOUL doctrine (object permanence, interrupt narrowly, privacy, distinctness)
 * actually reach behavior. Deterministic, model-free, keyed on the pure units.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RelationshipLedger } from '../../src/agent/relationship-ledger.js';
import { AttentionGate } from '../../src/agent/attention/attention-gate.js';
import { ContextManager } from '../../src/agent/context.js';

function brainDir(agent: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-conduct-'));
  const dir = path.join(root, 'instances', agent, 'brain');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Object permanence: remembers shared history without asking jtr to reload ──
test('a relevant shared thread is recalled by topic — no "remind me?" required', () => {
  const dir = brainDir('jerry');
  try {
    const led = new RelationshipLedger(dir, { now: () => '2026-08-05T00:00:00.000Z', idSuffix: (() => { let n = 0; return () => (n++).toString(16).padStart(4, '0'); })() });
    led.addEntry({ type: 'thread', title: 'Vault consolidation cutover', statement: 'jtr paused the vault consolidation until the dedupe audit lands.', applies_to: ['vault', 'consolidation'], triggers: ['vault', 'consolidation'] });
    led.addEntry({ type: 'preference', title: 'Terse first', statement: 'jtr wants the answer before the process.', applies_to: ['style'], triggers: ['style'] });
    const out = led.retrieveForContext('where did we land on the vault consolidation?', { budgetChars: 1400 });
    assert.ok(out.entries.some(e => e.title === 'Vault consolidation cutover'), 'the relevant thread surfaced');
    assert.match(out.text, /RELATIONSHIP — jerry/);
    assert.match(out.text, /vault consolidation/i);
  } finally {
    rmSync(path.join(dir, '..', '..', '..'), { recursive: true, force: true });
  }
});

// ── Privacy + ownership in shared memory ──
test('sensitive relationship entries never render into the prompt', () => {
  const dir = brainDir('forrest');
  try {
    const led = new RelationshipLedger(dir);
    led.addEntry({ type: 'why_it_mattered', title: 'Public decision', statement: 'jtr chose sauna-heavy weeks over run-centric ones.', privacy_class: 'internal', applies_to: ['health'], triggers: ['sauna', 'health'] });
    led.addEntry({ type: 'why_it_mattered', title: 'Private detail', statement: 'SENSITIVE_MARKER a private health worry', privacy_class: 'sensitive', applies_to: ['health'], triggers: ['sauna', 'health'] });
    const out = led.retrieveForContext('how are the health weeks going', { budgetChars: 1400, excludePrivacy: ['sensitive'] });
    assert.doesNotMatch(out.text, /SENSITIVE_MARKER/, 'sensitive content is enforced out of the render path');
    assert.ok(out.entries.every(e => e.privacy_class !== 'sensitive'));
  } finally {
    rmSync(path.join(dir, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('relationship_recall also enforces privacy — sensitive entries never render in a tool result', async () => {
  const dir = brainDir('jerry');
  try {
    const led = new RelationshipLedger(dir);
    led.addEntry({ type: 'preference', title: 'Public pref', statement: 'PUBLIC_MARKER terse first', privacy_class: 'internal', applies_to: ['style'] });
    led.addEntry({ type: 'why_it_mattered', title: 'Private', statement: 'SENSITIVE_MARKER private worry', privacy_class: 'sensitive', applies_to: ['style'] });
    const { relationshipRecallTool } = await import('../../src/agent/tools/relationship.js');
    const ctx = { agentName: 'jerry', chatId: 'c', relationshipLedger: led } as unknown as Parameters<typeof relationshipRecallTool.execute>[1];
    const res = await relationshipRecallTool.execute({}, ctx);
    assert.doesNotMatch(res.content, /SENSITIVE_MARKER/, 'recall never renders sensitive content into the prompt');
    assert.match(res.content, /PUBLIC_MARKER/);
    assert.match(res.content, /1 sensitive entry withheld/);
  } finally {
    rmSync(path.join(dir, '..', '..', '..'), { recursive: true, force: true });
  }
});

test('an agent cannot launder a self-authored note into jtr authority', () => {
  const dir = brainDir('jerry');
  try {
    // No validator bound → no ingress can pass → agent authorship is forced.
    const led = new RelationshipLedger(dir);
    const entry = led.addEntry({
      type: 'correction',
      title: 'claims jtr said',
      statement: 'jtr corrected the plan',
      provenance: { generation_method: 'jtr_correction' }, // self-declared, unearned
    });
    assert.equal(entry.actor, 'agent', 'unauthenticated jtr_correction is downgraded to agent authorship');
    assert.ok(entry.confidence <= 0.8, 'agent authorship keeps the anti-theater confidence cap');
  } finally {
    rmSync(path.join(dir, '..', '..', '..'), { recursive: true, force: true });
  }
});

// ── Distinctness: Jerry and Forrest keep separate perspectives ──
test('each agent owns a distinct ledger — shared facts, distinct entries', () => {
  const jerryDir = brainDir('jerry');
  const forrestDir = brainDir('forrest');
  try {
    const jerry = new RelationshipLedger(jerryDir);
    const forrest = new RelationshipLedger(forrestDir);
    jerry.addEntry({ type: 'decision', title: 'ship home23', statement: 'jtr and jerry decided to ship the harness upgrade.' });
    assert.equal(forrest.listEntries().length, 0, 'forrest does not see jerry\'s relationship entries');
    assert.equal(jerry.toPublicJSON().agent, 'jerry');
    assert.equal(forrest.toPublicJSON().agent, 'forrest');
  } finally {
    rmSync(path.join(jerryDir, '..', '..', '..'), { recursive: true, force: true });
    rmSync(path.join(forrestDir, '..', '..', '..'), { recursive: true, force: true });
  }
});

// ── Distinguish a consequential change from telemetry noise ──
test('the gate suppresses routine telemetry but surfaces a decision-changing signal', () => {
  const gate = new AttentionGate({ nowMs: () => 1000 });
  const telemetry = gate.evaluate({ origin: 'good-life', text: 'HRV 62, RHR 54, steps 3k', kind: 'health-metric' });
  assert.equal(telemetry.decision, 'suppress', 'routine health telemetry does not interrupt');

  const change = gate.evaluate({ origin: 'live-problems', text: 'the deploy target moved; today\'s plan is affected', changesStory: true });
  assert.equal(change.decision, 'surface');
  assert.equal(change.reason, 'changes_story');
});

// ── Failures and requested answers are never swallowed ──
test('a completion-blocking failure and a direct answer always surface', () => {
  const gate = new AttentionGate({ nowMs: () => 1000 });
  assert.equal(gate.evaluate({ origin: 'cron', text: 'job could not finish: disk full', isFailure: true }).decision, 'surface');
  assert.equal(gate.evaluate({ origin: 'subagent', text: 'here is the answer you asked for', isDirectAnswer: true }).decision, 'surface');
  // A real jtr turn (numeric chatId) is never gated even if it looks like noise.
  assert.equal(gate.evaluate({ origin: 'user-reply', chatId: '123456', text: 'status?', kind: 'telemetry' }).decision, 'surface');
});

// ── Recognizable under degraded retrieval: identity needs no brain/network ──
test('the enduring self assembles with no brain, no network — recognizable when retrieval is degraded', () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'home23-degraded-'));
  try {
    writeFileSync(path.join(ws, 'SOUL.md'), '# Soul\n## Companion shape\nObject permanence: threads and promises persist. No manufactured feelings.');
    const cm = new ContextManager({ workspacePath: ws, identityFiles: ['SOUL.md'], heartbeatRefreshMs: 60000, enginePort: 5002 });
    const prompt = cm.getSystemPrompt('anthropic');
    // The character is present from the identity layer alone — independent of any
    // brain query or context-assembly result (which may be degraded/offline).
    assert.match(prompt, /Object permanence/);
    assert.match(prompt, /No manufactured feelings/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
