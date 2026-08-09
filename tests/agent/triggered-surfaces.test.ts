/**
 * Step 30 cleanup #4 — triggered surfaces + surface-loader truncation fix.
 *
 * Triggered surfaces load a workspace file into situational awareness ONLY when
 * its keyword cues fire, so large intermittently-relevant doctrine (attention
 * allocation, social maintenance, carry-forward) reaches the agent when relevant
 * without bloating every turn. And the surface loader now budgets section-aware
 * (whole sections), not a blind mid-sentence slice.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assembleContext } from '../../src/agent/context-assembly.js';
import type { TriggeredSurfaceConfig } from '../../src/agent/context-assembly.js';

function ws(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-trigsurf-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

// A healthy no-op brain search so assembly runs the surface path deterministically.
const emptySearch = async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'hit' } });

async function assemble(
  workspacePath: string,
  userText: string,
  triggeredSurfaces: TriggeredSurfaceConfig[],
  semanticEmbed: (t: string) => number[] | null = () => null, // default: degraded → substring fallback (hermetic)
) {
  return assembleContext(
    userText,
    'chat-1',
    [{ role: 'user', content: 'prior' }], // non-empty → not first turn, isolates the trigger path
    {
      workspacePath,
      brainDir: path.join(workspacePath, 'brain'),
      enginePort: 5002,
      sessionId: 'chat-1',
      signal: new AbortController().signal,
      brainSearchTimeoutMs: 1000,
      contextSearch: emptySearch,
      triggeredSurfaces,
      semanticEmbed,
    },
  );
}

const SURFACES: TriggeredSurfaceConfig[] = [
  { file: 'ATTENTION_DECISION_CARD.md', label: 'ATTENTION', keywords: ['pursuit', 'cron_schedule', 'attention'], budget: 2200 },
  { file: 'FRIENDSHIP_LEDGER.md', label: 'FRIENDSHIP', keywords: ['friend', 'reach out'], budget: 1600 },
];

test('a triggered surface loads only when its keyword fires', async () => {
  const dir = ws({
    'ATTENTION_DECISION_CARD.md': '# Attention Decision Card\nG1 name the pool.',
    'FRIENDSHIP_LEDGER.md': '# Friendship\nCall your brother.',
  });
  try {
    const hit = await assemble(dir, 'should I open a new pursuit for this?', SURFACES);
    assert.match(hit.block, /Relevant context \(ATTENTION\)/);
    assert.match(hit.block, /name the pool/);
    assert.doesNotMatch(hit.block, /FRIENDSHIP/, 'unrelated surface stays silent');
    assert.ok(hit.surfacesLoaded.includes('ATTENTION'));

    const miss = await assemble(dir, 'what is the weather today?', SURFACES);
    assert.doesNotMatch(miss.block, /ATTENTION|FRIENDSHIP/, 'no trigger → neither surface loads (no bloat)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a different keyword fires a different surface', async () => {
  const dir = ws({
    'ATTENTION_DECISION_CARD.md': '# Attention\nx',
    'FRIENDSHIP_LEDGER.md': '# Friendship\nUNIQUE_FRIEND_MARKER reach out to Sam.',
  });
  try {
    const r = await assemble(dir, "I should reach out to some friends I've lost touch with", SURFACES);
    assert.match(r.block, /Relevant context \(FRIENDSHIP\)/);
    assert.match(r.block, /UNIQUE_FRIEND_MARKER/);
    assert.doesNotMatch(r.block, /ATTENTION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing triggered-surface file is a silent no-op', async () => {
  const dir = ws({ 'ATTENTION_DECISION_CARD.md': '# A\nx' });
  try {
    const r = await assemble(dir, 'reach out', SURFACES); // FRIENDSHIP file absent
    assert.doesNotMatch(r.block, /FRIENDSHIP/);
    assert.ok(!r.surfacesLoaded.includes('FRIENDSHIP'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('surface loader budgets section-aware — no blind mid-sentence slice (DOCTRINE bug)', async () => {
  // DOCTRINE.md is a DOMAIN_SURFACE with a 2500 budget. A >2500 file used to be
  // sliced mid-content; now whole sections are kept and an omission is marked.
  const big = '# Doctrine\n' + Array.from({ length: 30 }, (_, i) => `## Rule ${i}\n${'principle '.repeat(30)}`).join('\n');
  const dir = ws({ 'DOCTRINE.md': big });
  try {
    const r = await assemble(dir, 'what is our doctrine on pursuit', SURFACES);
    // DOCTRINE loads because brainCues>0? No — emptySearch returns no cues; DOCTRINE
    // is not alwaysBoost, so it only loads on first-turn/cues/triggers. Force it via
    // a triggered surface pointing at DOCTRINE to exercise the budgeter path.
    const withDoctrine = await assemble(dir, 'pursuit', [
      { file: 'DOCTRINE.md', label: 'DOCTRINE', keywords: ['pursuit'], budget: 500 },
    ]);
    assert.match(withDoctrine.block, /Relevant context \(DOCTRINE\)/);
    // Budgeted output carries the honest omission diagnostic, not a mid-word cut.
    assert.match(withDoctrine.block, /identity-budget: kept \d+\/\d+ chars of DOCTRINE\.md/);
    void r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── v2 cut 3: the gate is MEANING, keywords are anchors (substring = fallback) ──

const DIM = 16;
function axis(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}
/** Attention-flavored language and the ATTENTION anchor share an axis;
 * sunset-flavored language sits elsewhere despite containing 'watch'. */
function fakeEmbed(text: string): number[] | null {
  if (/ATTENTION:|inquiry|prioritize/i.test(text)) return axis(0);
  if (/sunset|evening/i.test(text)) return axis(7);
  return null;
}

test('meaning fires the surface — no keyword substring required', async () => {
  const dir = ws({ 'ATTENTION_DECISION_CARD.md': '# Attention\nAllocate deliberately.' });
  try {
    const surfaces: TriggeredSurfaceConfig[] = [
      { file: 'ATTENTION_DECISION_CARD.md', label: 'ATTENTION', keywords: ['pursuit'], budget: 2200 },
    ];
    const r = await assemble(dir, 'should we spin up a new line of inquiry and prioritize it?', surfaces, fakeEmbed);
    assert.match(r.block, /Allocate deliberately/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tripwire is dead: a lexical accident no longer fires the surface', async () => {
  const dir = ws({ 'ATTENTION_DECISION_CARD.md': '# Attention\nAllocate deliberately.' });
  try {
    const surfaces: TriggeredSurfaceConfig[] = [
      { file: 'ATTENTION_DECISION_CARD.md', label: 'ATTENTION', keywords: ['watch', 'pursuit'], budget: 2200 },
    ];
    const r = await assemble(dir, 'lets watch the sunset together this evening please', surfaces, fakeEmbed);
    assert.doesNotMatch(r.block, /Allocate deliberately/, 'meaning distant despite keyword hit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
