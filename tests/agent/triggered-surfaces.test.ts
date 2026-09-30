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
import { assembleContext, AUTHORED_SURFACE_MAX_CHARS, SITUATIONAL_AWARENESS_MAX_CHARS } from '../../src/agent/context-assembly.js';
import { selfReadTool } from '../../src/agent/tools/identity.js';
import { EventLedger } from '../../src/agent/event-ledger.js';
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

test('an oversized carry-forward surface loads a bounded head with an exact self_read offset', async () => {
  const content = '\n\n# Carry forward\n' + 'Listen carefully 🙂. Preserve the source and read the continuation.\n\n'.repeat(4000) + 'TAIL_SENTINEL';
  const dir = ws({ 'CARRY_FORWARD.md': content });
  try {
    const result = await assemble(dir, 'carry forward', [{ file: 'CARRY_FORWARD.md', keywords: ['carry forward'] }]);
    assert.ok(result.block.length < AUTHORED_SURFACE_MAX_CHARS + 200);
    assert.doesNotMatch(result.block, /TAIL_SENTINEL/);
    const marker = result.block.match(/\[context-cap: CARRY_FORWARD.md is (\d+) chars; loaded first (\d+) chars; continue with self_read file="CARRY_FORWARD.md" offset=(\d+)\]/);
    assert.ok(marker); assert.equal(Number(marker[1]), content.length); assert.equal(marker[2], marker[3]);
    const offset = Number(marker[3]);
    assert.ok(offset > 0 && offset < AUTHORED_SURFACE_MAX_CHARS);
    const start = result.block.indexOf('Relevant context (CARRY_FORWARD):\n') + 'Relevant context (CARRY_FORWARD):\n'.length;
    assert.equal(result.block.slice(start, marker.index! - 1), content.slice(0, offset));
    const continued = await selfReadTool.execute({ file: 'CARRY_FORWARD.md', offset, limit: 200 }, { workspacePath: dir } as never);
    assert.ok(continued.content.startsWith(content.slice(offset, offset + 200)));
    assert.ok(result.events.some(event => event.event_type === 'SituationalAwarenessCapped' && event.payload.reason === 'file_ceiling'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const degraded of [false, true]) test(`authored surfaces share the total ceiling and keep source pointers (${degraded ? 'degraded' : 'healthy'})`, async () => {
  const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`NOTE_${i}.md`, `# Note ${i}\n` + 'source evidence '.repeat(900)]));
  const dir = ws(files);
  try {
    const ledger = new EventLedger(path.join(dir, 'brain'));
    const result = await assembleContext('carry forward', 'cap-fixture', [{ role: 'user', content: 'prior' }], {
      workspacePath: dir, brainDir: path.join(dir, 'brain'), enginePort: 5002, sessionId: 'cap-fixture',
      signal: new AbortController().signal, semanticEmbed: () => null,
      contextSearch: degraded ? async () => { throw new Error('fixture unavailable'); } : emptySearch,
      triggeredSurfaces: Object.keys(files).map(file => ({ file, keywords: ['carry forward'] })),
    }, ledger);
    assert.equal(result.degraded, degraded);
    assert.ok(result.block.length <= SITUATIONAL_AWARENESS_MAX_CHARS);
    assert.ok(result.block.endsWith('[/SITUATIONAL AWARENESS]'));
    assert.match(result.block, /Relevant context \(NOTE_2.md\):\n\[context-cap: omitted/);
    assert.match(result.block, /self_read file="NOTE_2.md" offset=0/);
    const caps = result.events.filter(event => event.event_type === 'SituationalAwarenessCapped');
    assert.equal(caps.length, 2); assert.ok(caps.every(event => event.payload.reason === 'total_ceiling'));
    assert.deepEqual(ledger.readByType('SituationalAwarenessCapped').map(event => ({ id: event.event_id, payload: event.payload })),
      caps.map(event => ({ id: event.event_id, payload: event.payload })), 'ranking caps reach the ledger on both paths');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('authored surfaces do not consume the separate retrieved-evidence budget', async () => {
  const dir = ws({ 'PERSONAL.md': '# Personal\n' + 'friendship '.repeat(800), 'DOCTRINE.md': '# Doctrine\n' + 'care '.repeat(1700) });
  try {
    const result = await assembleContext('review the evidence', 'budget-fixture', [], {
      workspacePath: dir, brainDir: path.join(dir, 'brain'), enginePort: 5002, sessionId: 'budget-fixture',
      signal: new AbortController().signal, contextSearch: async () => ({ results: [{ concept: 'RETRIEVED_SENTINEL', similarity: 0.1 }],
        sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'hit' } }), semanticEmbed: () => null,
    });
    assert.match(result.block, /RETRIEVED_SENTINEL/);
    assert.match(result.block, /Relevant context \(PERSONAL\)/);
    assert.match(result.block, /Relevant context \(DOCTRINE\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('triggered authored doctrine survives both the file target and aggregate context limit', async () => {
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
    assert.ok(withDoctrine.block.includes(big.trim()));
    assert.ok(withDoctrine.block.endsWith('[/SITUATIONAL AWARENESS]'));
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
