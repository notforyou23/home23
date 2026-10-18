import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext, SITUATIONAL_AWARENESS_MAX_CHARS } from '../../src/agent/context-assembly.js';
import { composeSeedSituation } from '../../src/substrate/seed-context.js';
import { cachedEmbedRaw, resetSemanticMatchCache } from '../../src/substrate/semantic-match.js';

const turn = 'Remember my decision about preserving the seed cells and their meaning';
const ownerReason = 'PRESERVE_SEED_SENTINEL: feed the cells instead of shrinking their meaning';
const matchText = `seed growth: operator decision on merge of situation cells cell.a + cell.b ${ownerReason}`;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'context-seed-delivery-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); resetSemanticMatchCache(); });
  const workspacePath = join(root, 'instances', 'jerry', 'workspace');
  const substrateStateDir = join(root, 'seed');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(substrateStateDir, 'checkpoints'), { recursive: true });
  writeFileSync(join(substrateStateDir, 'checkpoints', 'ckpt_0001.json'), JSON.stringify({ version: 2, ledgerSeq: 5, cells: [] }));
  writeFileSync(join(substrateStateDir, 'seed-ledger.jsonl'), [
    { seq: 1, category: 'act', sourceRef: 'growth.operator-decision', payload: {
      operatorDecision: 'declined', op: 'merge', targetCellIds: ['cell.a', 'cell.b'], authorizedBy: 'jtr', reason: ownerReason,
    } },
    { seq: 2, category: 'act', sourceRef: 'growth', payload: { growthApplication: true, op: 'split', resultingAnatomy: [{ id: 'weather' }] } },
    { seq: 3, category: 'act', sourceRef: 'growth', payload: { growthApplication: true, op: 'split', resultingAnatomy: [{ id: 'music' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  // Prime the existing shared semantic cache, so the exact production Seed
  // composition runs without invoking an encoder or requiring an ESM mock.
  resetSemanticMatchCache();
  const embed = (text: string) => text === turn || text === matchText ? [1, 0] : [0, 1];
  for (const text of [turn, matchText, 'split weather', 'split music']) cachedEmbedRaw(text, embed);
  assert.match(composeSeedSituation(substrateStateDir, { turnText: turn }) ?? '', /PRESERVE_SEED_SENTINEL/);
  const config = {
    workspacePath, substrateStateDir, brainDir: join(root, 'brain'), enginePort: 5002, sessionId: 'delivery',
    signal: new AbortController().signal, semanticEmbed: () => null,
    contextSearch: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }),
  };
  return { root, workspacePath, substrateStateDir, config };
}

test('selected Seed context reaches the final healthy prompt with zero brain cues', async t => {
  const { config } = fixture(t);
  const result = await assembleContext(turn, 'delivery', [{ role: 'assistant', content: 'earlier' }], config);
  assert.equal(result.brainCueCount, 0);
  assert.ok(result.surfacesLoaded.includes('SUBSTRATE'));
  assert.match(result.block, /PRESERVE_SEED_SENTINEL/);
  assert.match(result.block, /never recite or summarize this block/);
});

test('local trigger memory reaches the final healthy prompt without remote brain cues', async t => {
  const { config } = fixture(t);
  const result = await assembleContext('local trigger', 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config, substrateStateDir: join(config.workspacePath, 'missing-seed'),
    triggerIndex: { evaluate: () => [{ memoryId: 'm1', memory: { title: 'Owner continuity', statement: 'LOCAL_TRIGGER_SENTINEL', confidence: { score: 0.95 } },
      trigger: { trigger_type: 'keyword', condition: 'local trigger' } }] } as never,
  });
  assert.equal(result.brainCueCount, 0);
  assert.equal(result.triggerCount, 1);
  assert.match(result.block, /LOCAL_TRIGGER_SENTINEL/);
});

for (const degraded of [false, true]) test(`oversized selected Seed is explicitly omitted and recoverable from its authoritative source (${degraded ? 'degraded' : 'healthy'})`, async t => {
  const { config, substrateStateDir } = fixture(t);
  const path = join(substrateStateDir, 'seed-ledger.jsonl');
  const longReason = ownerReason + ' Preserve this complete owner qualification 🌱. '.repeat(1200);
  writeFileSync(path, readFileSync(path, 'utf8').replace(ownerReason, longReason));
  const longMatch = matchText.replace(ownerReason, longReason).trim();
  cachedEmbedRaw(longMatch, () => [1, 0]);
  const result = await assembleContext(turn, 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config, contextSearch: degraded ? async () => { throw new Error('fixture unavailable'); } : config.contextSearch,
  });
  assert.equal(result.degraded, degraded);
  assert.ok(result.block.length <= SITUATIONAL_AWARENESS_MAX_CHARS);
  assert.ok(result.block.endsWith('[/SITUATIONAL AWARENESS]'));
  assert.match(result.block, /CONTEXT OMISSIONS: \d+ selected item\(s\) did not reach this prompt; not loaded knowledge/);
  assert.match(result.block, /SUBSTRATE \(total_ceiling\)/);
  assert.ok(result.block.includes(`read_file path=${JSON.stringify(path)} offset_chars=0`));
  assert.ok(result.block.includes(`list_files cwd=${JSON.stringify(join(substrateStateDir, 'checkpoints'))}`));
  assert.ok(!result.surfacesLoaded.includes('SUBSTRATE'));
  const receipt = result.events.find(event => event.event_type === 'RetrievalExecuted')!;
  assert.ok((receipt.payload.surfaces_selected as string[]).includes('SUBSTRATE'));
  assert.deepEqual(receipt.payload.surfaces_loaded, []);
  assert.ok((receipt.payload.surfaces_omitted as string[]).includes('SUBSTRATE'));
  assert.match(JSON.stringify(receipt.payload.delivery_omissions), /seed-ledger.jsonl/);
  assert.match(readFileSync(path, 'utf8'), /PRESERVE_SEED_SENTINEL/);
  assert.ok(readFileSync(path, 'utf8').includes(longReason), 'the complete owner statement remains unchanged on disk');
});

test('the retrieved-evidence budget emits a visible recovery pointer instead of silently dropping a local trigger', async t => {
  const { config } = fixture(t);
  const statement = 'TRIGGER_START ' + 'complete meaning '.repeat(500) + ' TRIGGER_END';
  const result = await assembleContext('memory question', 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config,
    triggerIndex: { evaluate: () => [{ memoryId: 'memory-original', memory: { title: 'Owner continuity', statement, confidence: { score: 0.95 } },
      trigger: { trigger_type: 'keyword', condition: 'memory question' } }] } as never,
  });
  assert.match(result.block, /trigger \(evidence_budget\)/);
  assert.ok(result.block.includes(join(config.brainDir, 'memory-objects.json')));
  assert.match(result.block, /memoryId="memory-original"/);
  assert.doesNotMatch(result.block, /TRIGGER_START/);
  const omissions = result.events.find(event => event.event_type === 'RetrievalExecuted')!.payload.delivery_omissions as Array<Record<string, unknown>>;
  assert.equal(omissions[0]?.reason, 'evidence_budget');
  assert.equal(omissions[0]?.delivered_chars, 0);
});

test('a selected brain cue keeps its complete requested claim beyond the old 300-character preview', async t => {
  const { config } = fixture(t);
  const concept = 'Original premise. '.repeat(35) + ' QUALIFICATION_AT_THE_END';
  const result = await assembleContext('recall my qualification', 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config, contextSearch: async () => ({ results: [{ concept, similarity: 0.9 }], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } }),
  });
  assert.ok(result.block.includes(concept));
  assert.match(result.block, /QUALIFICATION_AT_THE_END/);
});

test('a zero preview budget delivers only recovery and is not reported as loaded source knowledge', async t => {
  const { config, workspacePath } = fixture(t);
  writeFileSync(join(workspacePath, 'LARGE.md'), 'ORIGINAL_UNLOADED_TEXT');
  const result = await assembleContext('large note', 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config, triggeredSurfaces: [{ file: 'LARGE.md', keywords: ['large note'], budget: 0 }],
  });
  assert.match(result.block, /loaded first 0 chars; continue with self_read file="LARGE.md" offset=0/);
  assert.doesNotMatch(result.block, /ORIGINAL_UNLOADED_TEXT/);
  assert.ok(!result.surfacesLoaded.includes('LARGE'));
  const receipt = result.events.find(event => event.event_type === 'RetrievalExecuted')!;
  assert.deepEqual(receipt.payload.surfaces_omitted, ['LARGE']);
  assert.deepEqual(receipt.payload.surface_delivery, [{ surface: 'LARGE', source: 'trigger-surface:LARGE', file: 'LARGE.md', delivered_chars: 0, pointer_only: true, complete: false }]);
});

test('an overfull recovery index remains bounded and discloses its own omissions', async t => {
  const { config, workspacePath } = fixture(t);
  const files = Array.from({ length: 300 }, (_, index) => `NOTE_${index}_${'x'.repeat(90)}.md`);
  for (const file of files) writeFileSync(join(workspacePath, file), '# Note\n' + 'evidence '.repeat(2000));
  const result = await assembleContext('many notes', 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config, triggeredSurfaces: files.map(file => ({ file, keywords: ['many notes'], budget: 16000 })),
  });
  assert.ok(result.block.length <= SITUATIONAL_AWARENESS_MAX_CHARS);
  assert.ok(result.block.endsWith('[/SITUATIONAL AWARENESS]'));
  assert.match(result.block, /Additional source pointers omitted from this index/);
  assert.match(result.block, /complete source index/);
  const receipt = result.events.find(event => event.event_type === 'RetrievalExecuted')!;
  assert.equal((receipt.payload.delivery_omissions as unknown[]).length, 300);
  assert.deepEqual(result.surfacesLoaded, []);
});

test('oversized provider diagnostics cannot consume the bounded context or hide its recovery index', async t => {
  const { config } = fixture(t);
  const fullError = 'Original provider diagnostic. '.repeat(2500) + ' ERROR_TAIL';
  const result = await assembleContext('local memory question', 'delivery', [{ role: 'assistant', content: 'earlier' }], {
    ...config, contextSearch: async () => { throw new Error(fullError); },
    triggerIndex: { evaluate: () => [{ memoryId: 'm-original', memory: { title: 'Original', statement: 'full original '.repeat(800), confidence: { score: 0.95 } },
      trigger: { trigger_type: 'keyword', condition: 'local memory question' } }] } as never,
  });
  assert.ok(result.block.length <= SITUATIONAL_AWARENESS_MAX_CHARS);
  assert.ok(result.block.endsWith('[/SITUATIONAL AWARENESS]'));
  assert.match(result.block, /diagnostic preview; full value recorded in RetrievalExecuted/);
  assert.match(result.block, /CONTEXT OMISSIONS/);
  assert.match(result.block, /memory-objects.json/);
  const receipt = result.events.find(event => event.event_type === 'RetrievalExecuted')!;
  assert.ok(String(receipt.payload.retrievalError).endsWith(' ERROR_TAIL'));
});
