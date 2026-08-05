/**
 * Piece 1 (Step 30) — ContextManager identity assembly.
 *
 * End-to-end over a temp workspace: SOUL loads whole (no silent clip), the
 * identity region is grouped by the six-layer scheme, and PromptSourceInfo
 * carries the sizes + omission diagnostics that make composition inspectable.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContextManager } from '../../src/agent/context.js';

function workspace(files: Record<string, string>): string {
  const ws = mkdtempSync(path.join(tmpdir(), 'home23-identity-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(ws, name), content);
  }
  return ws;
}

const SOUL = [
  '# SOUL.md — jerry',
  '🦞 jerry.',
  '## Companion shape',
  'R2-D2 nerve with C-3PO language. Object permanence: threads and promises persist.',
  '## Loyal dissent',
  'Say the real thing, then help fully once he decides.',
].join('\n');

test('SOUL.md that fits the budget reaches the prompt whole (companion doctrine survives)', () => {
  const ws = workspace({ 'SOUL.md': SOUL });
  try {
    const cm = new ContextManager({
      workspacePath: ws, identityFiles: ['SOUL.md'], heartbeatRefreshMs: 60000, enginePort: 5002,
    });
    const prompt = cm.getSystemPrompt('anthropic');
    assert.ok(prompt.includes('Companion shape'), 'companion-shape section present');
    assert.ok(prompt.includes('Loyal dissent'), 'the tail section that the old 3000 slice would drop is present');
    const info = cm.getPromptSourceInfo();
    const soul = info.loadedFiles.find(f => f.filename === 'SOUL.md')!;
    assert.equal(soul.included, true);
    assert.equal(soul.truncated, false);
    assert.equal(soul.layer, 'enduring_self');
    assert.equal(soul.rawBytes, SOUL.length);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('an over-budget file emits a visible omission diagnostic and records it', () => {
  const big = '# Mission\n' + Array.from({ length: 40 }, (_, i) => `## Section ${i}\n${'detail '.repeat(30)}`).join('\n');
  const ws = workspace({ 'MISSION.md': big });
  try {
    const cm = new ContextManager({
      workspacePath: ws, identityFiles: ['MISSION.md'], heartbeatRefreshMs: 60000, enginePort: 5002,
      identityBudgets: { 'MISSION.md': 500 },
    });
    const prompt = cm.getSystemPrompt('anthropic');
    assert.match(prompt, /identity-budget: kept \d+\/\d+ chars of MISSION\.md; omitted \d+ section/);
    const info = cm.getPromptSourceInfo();
    assert.equal(info.anyTruncated, true);
    const m = info.loadedFiles.find(f => f.filename === 'MISSION.md')!;
    assert.equal(m.truncated, true);
    assert.ok((m.omittedSections?.length ?? 0) > 0);
    assert.ok(m.includedBytes! < m.rawBytes!);
    assert.equal(m.budget, 500);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('identity region is grouped and ordered by the six-layer scheme', () => {
  const ws = workspace({
    'SOUL.md': '# Soul\nenduring self content',
    'MISSION.md': '# Mission\nrole content',
    'NOW.md': '# Now\nworld state content',
    'SKILL_ROUTING.md': '# Skills\noperational content',
  });
  try {
    const cm = new ContextManager({
      workspacePath: ws,
      identityFiles: ['SKILL_ROUTING.md', 'NOW.md', 'MISSION.md', 'SOUL.md'], // deliberately scrambled
      heartbeatRefreshMs: 60000, enginePort: 5002,
    });
    const prompt = cm.getSystemPrompt('anthropic');
    const iSelf = prompt.indexOf('LAYER 1 · ENDURING SELF');
    const iRole = prompt.indexOf('LAYER 3 · ROLE');
    const iWorld = prompt.indexOf('LAYER 4 · CURRENT WORLD');
    const iOps = prompt.indexOf('LAYER 5 · OPERATIONAL');
    assert.ok(iSelf >= 0 && iRole >= 0 && iWorld >= 0 && iOps >= 0, 'all layer headers present');
    assert.ok(iSelf < iRole && iRole < iWorld && iWorld < iOps,
      'layers appear in enduring→role→world→operational order regardless of config order');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a missing identity file is recorded as not-included, not silently absent', () => {
  const ws = workspace({ 'SOUL.md': SOUL });
  try {
    const cm = new ContextManager({
      workspacePath: ws, identityFiles: ['SOUL.md', 'MISSION.md'], heartbeatRefreshMs: 60000, enginePort: 5002,
    });
    cm.getSystemPrompt('anthropic');
    const info = cm.getPromptSourceInfo();
    const missing = info.loadedFiles.find(f => f.filename === 'MISSION.md')!;
    assert.equal(missing.exists, false);
    assert.equal(missing.included, false);
    assert.equal(missing.layer, 'role');
    assert.ok(typeof info.systemPromptBytes === 'number' && info.systemPromptBytes > 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
