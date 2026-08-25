import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  relationshipNoteTool,
  relationshipRecallTool,
  relationshipUpdateTool,
} from '../../../src/agent/tools/relationship.js';
import {
  RelationshipLedger,
  type AuthenticatedCorrectionIngress,
} from '../../../src/agent/relationship-ledger.js';
import type { ToolContext } from '../../../src/agent/types.js';

type RelCtx = ToolContext & { relationshipLedger?: RelationshipLedger | null };

function tmpBrain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-rel-tool-'));
  return path.join(dir, 'jerry', 'brain');
}

function clock(startIso = '2026-08-05T12:00:00.000Z', stepMs = 1000): () => string {
  let t = Date.parse(startIso);
  return () => { const iso = new Date(t).toISOString(); t += stepMs; return iso; };
}
function counterSuffix(): () => string {
  let n = 0;
  return () => (n++).toString(16).padStart(4, '0');
}

function ctx(overrides: Partial<RelCtx> = {}): RelCtx {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23',
    enginePort: 5001,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/tmp/home23/instances/jerry/workspace',
    tempDir: '/tmp/home23/.tmp',
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined,
    },
    subAgentTracker: { active: 0, maxConcurrent: 1, queue: [] },
    chatId: 'chat-1',
    telegramAdapter: null,
    runAgentLoop: null,
    relationshipLedger: null,
    ...overrides,
  } as RelCtx;
}

function freshLedger(opts: Partial<ConstructorParameters<typeof RelationshipLedger>[1]> = {}): RelationshipLedger {
  return new RelationshipLedger(tmpBrain(), {
    now: clock(), idSuffix: counterSuffix(), agent: 'jerry', ...opts,
  });
}

test('relationship_note records an entry as agent-owned', async () => {
  const ledger = freshLedger();
  const result = await relationshipNoteTool.execute({
    type: 'preference',
    title: 'concise replies',
    statement: 'jtr prefers short, direct answers',
    applies_to: 'chat, telegram',
    triggers: 'verbose, long',
  }, ctx({ relationshipLedger: ledger }));

  assert.equal(result.is_error, undefined);
  assert.match(result.content, /Recorded relationship preference/);
  const entries = ledger.listEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.actor, 'agent');
  assert.deepEqual(entries[0]?.applies_to, ['chat', 'telegram']);
});

test('relationship_note earns jtr authority for a correction in a real jtr turn', async () => {
  const messageRef = 'dashboard:chat-1:m-7';
  const userText = 'Correction: never deploy without a load test.';
  const recorded = new Map([[messageRef, { chatId: 'chat-1', userText }]]);
  const ledger = freshLedger({
    validateCorrectionIngress: (ingress: AuthenticatedCorrectionIngress) => {
      const rec = recorded.get(ingress.messageRef);
      return rec?.chatId === ingress.chatId && rec.userText === ingress.userText;
    },
  });
  const result = await relationshipNoteTool.execute({
    type: 'correction',
    title: 'deploy rule',
    statement: userText, // agent records jtr's own claim verbatim
  }, ctx({
    relationshipLedger: ledger,
    authenticatedUserMessage: { chatId: 'chat-1', messageRef, text: userText },
  }));

  assert.equal(result.is_error, undefined);
  const entry = ledger.listEntries()[0]!;
  assert.equal(entry.actor, 'jtr');
  assert.equal(entry.provenance.generation_method, 'jtr_correction');
});

test('relationship_recall lists active entries, filterable by query', async () => {
  const ledger = freshLedger();
  const c = ctx({ relationshipLedger: ledger });
  await relationshipNoteTool.execute({ type: 'promise', title: 'send recap', statement: 'owe jtr the weekly recap', triggers: 'recap' }, c);
  await relationshipNoteTool.execute({ type: 'thread', title: 'migration', statement: 'finish the brain migration', triggers: 'migration' }, c);

  const all = await relationshipRecallTool.execute({}, c);
  assert.match(all.content, /2 relationship entries/);

  const filtered = await relationshipRecallTool.execute({ query: 'recap' }, c);
  assert.match(filtered.content, /send recap/);
  assert.doesNotMatch(filtered.content, /migration/);
});

test('relationship_recall matches a phrase fragment and does not treat internal as withheld', async () => {
  const ledger = freshLedger();
  const c = ctx({ relationshipLedger: ledger });
  await relationshipNoteTool.execute({
    type: 'correction',
    title: 'There is no he. I am Jerry.',
    statement: 'There is no he. I am Jerry. The seed, the lobe, this room—I am them.',
    privacy: 'internal',
  }, c);
  await relationshipNoteTool.execute({
    type: 'preference',
    title: 'private health',
    statement: 'a sensitive medical detail',
    privacy: 'sensitive',
  }, c);

  const recalled = await relationshipRecallTool.execute({
    query: 'There is no he. I am Jerry. The seed, the lobe, this room—I am them.',
  }, c);
  assert.match(recalled.content, /There is no he/);
  assert.doesNotMatch(recalled.content, /sensitive medical/);
  assert.doesNotMatch(recalled.content, /withheld/);
});

test('relationship_update supersede / resolve / remove all work', async () => {
  const ledger = freshLedger();
  const c = ctx({ relationshipLedger: ledger });

  const noteRes = await relationshipNoteTool.execute({ type: 'decision', title: 'approach', statement: 'old approach' }, c);
  const id = /\((rel_[^)]+)\)/.exec(noteRes.content)![1]!;

  const superseded = await relationshipUpdateTool.execute({ id, action: 'supersede', statement: 'new approach' }, c);
  assert.match(superseded.content, /Superseded/);
  assert.equal(ledger.getEntry(id)?.status, 'superseded');

  const newId = /with (rel_\S+)/.exec(superseded.content)![1]!;
  const resolved = await relationshipUpdateTool.execute({ id: newId, action: 'resolve' }, c);
  assert.match(resolved.content, /Resolved/);
  assert.equal(ledger.getEntry(newId)?.status, 'resolved');

  const removed = await relationshipUpdateTool.execute({ id: newId, action: 'remove', reason: 'obsolete' }, c);
  assert.match(removed.content, /Removed/);
  assert.equal(ledger.getEntry(newId)?.status, 'removed');
});

test('every tool returns a clear error when the ledger is null (never throws)', async () => {
  const c = ctx({ relationshipLedger: null });
  const note = await relationshipNoteTool.execute({ type: 'preference', title: 't', statement: 's' }, c);
  const recall = await relationshipRecallTool.execute({}, c);
  const update = await relationshipUpdateTool.execute({ id: 'rel_x', action: 'resolve' }, c);
  for (const r of [note, recall, update]) {
    assert.equal(r.is_error, true);
    assert.match(r.content, /Relationship ledger unavailable/);
  }
});

test('relationship_update rejects an unknown id and a missing supersede statement', async () => {
  const ledger = freshLedger();
  const c = ctx({ relationshipLedger: ledger });
  const missing = await relationshipUpdateTool.execute({ id: 'rel_nope', action: 'resolve' }, c);
  assert.equal(missing.is_error, true);

  const note = await relationshipNoteTool.execute({ type: 'thread', title: 't', statement: 's' }, c);
  const id = /\((rel_[^)]+)\)/.exec(note.content)![1]!;
  const noStatement = await relationshipUpdateTool.execute({ id, action: 'supersede' }, c);
  assert.equal(noStatement.is_error, true);
  assert.match(noStatement.content, /requires a new statement/);
});
