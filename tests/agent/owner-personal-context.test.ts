import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleContext, composeLearnedOwnerFacts } from '../../src/agent/context-assembly.js';
import type { OwnerDistillConfig } from '../../src/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'home23-owner-personal-'));
  const workspace = join(root, 'workspace');
  const brain = join(root, 'brain');
  mkdirSync(workspace);
  mkdirSync(brain);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { workspace, brain, file: join(brain, 'memory-objects.json') };
}

function fact(id: string, statement: string, overrides: Record<string, unknown> = {}) {
  return {
    memory_id: id, lifecycle_layer: 'durable', status: 'approved', title: statement,
    statement, updated_at: '2026-10-12T12:00:00.000Z', privacy_class: 'personal',
    provenance: { generation_method: 'owner_conversation' },
    evidence: { grounding_note: statement, evidence_links: [`message:${id}`] },
    scope: { applies_to: [], excludes: [] }, ...overrides,
  };
}

async function assemble(workspace: string, brain: string, ownerDistill?: OwnerDistillConfig) {
  return assembleContext('How is my health?', 'owner-chat', [{ role: 'user', content: 'prior' }], {
    workspacePath: workspace, brainDir: brain, enginePort: 5002, sessionId: 'owner-chat',
    signal: new AbortController().signal, ownerDistill, semanticEmbed: () => null,
    contextSearch: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'hit' } }),
  });
}

test('PERSONAL appends dated owner facts and sensitive facts by default without rewriting sources', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'PERSONAL.md'), '# Personal\nAuthored owner identity.');
  writeFileSync(f.file, JSON.stringify({ objects: [
    fact('health', 'I have a health condition.', { privacy_class: 'sensitive' }),
    fact('ordinary', 'My dog is named Sam.'),
    fact('working', 'WORKING_SENTINEL', { lifecycle_layer: 'working' }),
    fact('legacy', 'LEGACY_SENTINEL', { provenance: { generation_method: 'conversation' } }),
    fact('superseded', 'SUPERSEDED_SENTINEL', { status: 'superseded' }),
    fact('linked-superseded', 'LINKED_SENTINEL', { superseded_by: ['ordinary'] }),
    fact('ungrounded', 'UNGROUNDED_SENTINEL', { evidence: { evidence_links: [] } }),
  ] }));
  const storedBefore = readFileSync(f.file, 'utf8');
  const result = await assemble(f.workspace, f.brain);
  assert.match(result.block, /Relevant context \(PERSONAL\):\n# Personal\nAuthored owner identity\.\n\nLearned from conversations/);
  assert.match(result.block, /You told me on 2026-10-12: I have a health condition\./);
  assert.match(result.block, /My dog is named Sam\./);
  assert.doesNotMatch(result.block, /WORKING_SENTINEL|LEGACY_SENTINEL|SUPERSEDED_SENTINEL|LINKED_SENTINEL|UNGROUNDED_SENTINEL/);
  assert.ok(result.surfacesLoaded.includes('PERSONAL'));
  assert.equal(readFileSync(f.file, 'utf8'), storedBefore);
  assert.equal(readFileSync(join(f.workspace, 'PERSONAL.md'), 'utf8'), '# Personal\nAuthored owner identity.');
});

test('renderSensitive false changes rendering only; disabled learning still renders prior owner facts', async t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ objects: [
    fact('sensitive', 'Sensitive health statement.', { privacy_class: 'sensitive' }),
    fact('public', 'My dog is named Sam.'),
  ] }));
  const before = readFileSync(f.file, 'utf8');
  const filtered = await assemble(f.workspace, f.brain, { enabled: false, renderSensitive: false });
  assert.match(filtered.block, /My dog is named Sam/);
  assert.doesNotMatch(filtered.block, /Sensitive health statement/);
  const defaultPolicy = await assemble(f.workspace, f.brain, { enabled: false });
  assert.match(defaultPolicy.block, /Sensitive health statement/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('learned tail ranks relevance and recency and preserves whole statements within its budget', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ objects: [
    fact('recent', 'My dog is named Sam.'),
    fact('old-health', 'My health concern is recovery.', { updated_at: '2026-09-01T12:00:00.000Z' }),
    fact('older', 'My dog was named Spot.', { updated_at: '2026-08-01T12:00:00.000Z' }),
  ] }));
  const now = Date.parse('2026-10-13T12:00:00Z');
  const relevant = composeLearnedOwnerFacts(f.brain, 'health recovery', { personalBudgetChars: 100 }, now)!;
  assert.match(relevant, /You told me on 2026-09-01: My health concern is recovery\./);
  assert.doesNotMatch(relevant, /named Sam|named Spot/);
  assert.ok(relevant.length <= 100);
  const recent = composeLearnedOwnerFacts(f.brain, '', { personalBudgetChars: 100 }, now)!;
  assert.match(recent, /named Sam/);
  assert.doesNotMatch(recent, /named Spot|health concern/);
  assert.equal(composeLearnedOwnerFacts(f.brain, 'health', { personalBudgetChars: 20 }, now), null);
});

test('the default learned tail has a 2000-character budget', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ objects: Array.from({ length: 60 }, (_, index) =>
    fact(`fact-${index}`, `Owner statement number ${index}: ${'grounded detail '.repeat(8)}`)) }));
  const learned = composeLearnedOwnerFacts(f.brain, '')!;
  assert.ok(learned.length <= 2000 && learned.length > 1500);
  assert.ok(learned.split('\n').slice(1).every(line => line.endsWith('grounded detail')));
});

test('a missing, malformed or unreadable shared store degrades to authored PERSONAL alone', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'PERSONAL.md'), 'Authored identity survives.');
  const missing = await assemble(f.workspace, f.brain);
  assert.match(missing.block, /Authored identity survives/);
  assert.doesNotMatch(missing.block, /Learned from conversations/);
  writeFileSync(f.file, '{"objects":');
  const malformed = await assemble(f.workspace, f.brain);
  assert.match(malformed.block, /Authored identity survives/);
  assert.doesNotMatch(malformed.block, /Learned from conversations/);
  rmSync(f.file);
  mkdirSync(f.file); // Reading a directory as the JSON store fails on this platform.
  const unreadable = await assemble(f.workspace, f.brain);
  assert.match(unreadable.block, /Authored identity survives/);
  assert.doesNotMatch(unreadable.block, /Learned from conversations/);
});

test('learned facts occupy the PERSONAL slot when the authored file is absent', async t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ objects: [fact('owner', 'My dog is named Sam.')] }));
  const result = await assemble(f.workspace, f.brain);
  assert.match(result.block, /Relevant context \(PERSONAL\):\nLearned from conversations/);
  assert.ok(result.surfacesLoaded.includes('PERSONAL'));
});

test('each PERSONAL read uses current store contents, including later supersession', t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ objects: [fact('old', 'My dog is named Sam.')] }));
  assert.match(composeLearnedOwnerFacts(f.brain, '')!, /named Sam/);
  writeFileSync(f.file, JSON.stringify({ objects: [
    fact('old', 'My dog is named Sam.', { status: 'superseded', superseded_by: ['new'] }),
    fact('new', 'My dog is named Bob.', { updated_at: '2026-10-13T12:00:00.000Z' }),
  ] }));
  const learned = composeLearnedOwnerFacts(f.brain, '')!;
  assert.match(learned, /You told me on 2026-10-13: My dog is named Bob/);
  assert.doesNotMatch(learned, /named Sam/);
});
