// An agent that analysed 0 documents did not find anything. A loop ticked.
// An agent with a real finding recorded something that happened.
// A synthesis report generated over zero evidence nodes is GPT
// free-associating from mission text alone -- also a loop ticking.
// A janitor (the composter) does not file a receipt into what it cleans.
//
// This file tests the "no event" gates added to:
//   base-agent.js       -- describesNoEvent(), BaseAgent#addFinding(), BaseAgent#addInsight()
//   synthesis-agent.js  -- shouldPersistSynthesisReport()
//   composter.js        -- addNode() call removed entirely
//
// Harness style matches tests/engine/core/thought-persistence.test.js:
// Object.create(Prototype) + Object.assign minimal collaborators, exercise
// real instance methods -- no reinvented mock framework.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BaseAgent, describesNoEvent } = require('../../../engine/src/agents/base-agent.js');
const { shouldPersistSynthesisReport } = require('../../../engine/src/agents/synthesis-agent.js');
const { Composter } = require('../../../engine/src/circulatory/composter.js');

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, data) { entries.push({ level: 'info', message, data }); },
    warn(message, data) { entries.push({ level: 'warn', message, data }); },
    error(message, data) { entries.push({ level: 'error', message, data }); },
    debug(message, data) { entries.push({ level: 'debug', message, data }); },
  };
}

// A memory stub that mimics the real network-memory contract closely enough
// for BaseAgent#addFinding()/addInsight(): addNode() returns a created node,
// query() returns related nodes for cooccurrence reinforcement (empty here,
// which is realistic and keeps these tests focused on the event gate).
function makeAgent() {
  const logger = makeLogger();
  const addedNodes = [];
  const memory = {
    async addNode(content, tag) {
      const node = { id: `node_${addedNodes.length + 1}`, content, tag };
      addedNodes.push(node);
      return node;
    },
    async query() { return []; },
    reinforceCooccurrence() {},
  };
  const agent = Object.create(BaseAgent.prototype);
  Object.assign(agent, {
    agentId: 'agent_1783691902660',
    logger,
    memory,
    results: [],
    // Journaling is a crash-safety side effect unrelated to the event gate
    // under test; stub it out rather than touching the real filesystem.
    appendToJournal: async () => {},
  });
  return { agent, logger, addedNodes, memory };
}

// ---------------------------------------------------------------------------
// describesNoEvent() -- the pure decision function
// ---------------------------------------------------------------------------

test('describesNoEvent: a JSON payload reporting documentCount: 0 is a no-event', () => {
  assert.equal(
    describesNoEvent(JSON.stringify({ source: 'document_analysis_agent', timestamp: new Date().toISOString(), documentCount: 0, documents: [] })),
    true
  );
});

test('describesNoEvent: the exact "0 words across 0 documents" prose is a no-event', () => {
  assert.equal(
    describesNoEvent('Total content analyzed: 0 words across 0 documents'),
    true
  );
});

test('describesNoEvent: a real documentCount is NOT a no-event', () => {
  assert.equal(
    describesNoEvent(JSON.stringify({ documentCount: 47, documents: [{ filename: 'a.md' }] })),
    false
  );
});

test('describesNoEvent: a real word/document count in the same prose shape is NOT a no-event', () => {
  assert.equal(
    describesNoEvent('Total content analyzed: 12,480 words across 47 documents'),
    false
  );
});

test('describesNoEvent: ordinary content that merely mentions the digit 0 is NOT a no-event', () => {
  // Guards against an overbroad "any zero anywhere" gate eating a real finding.
  assert.equal(
    describesNoEvent('Found a 0-day vulnerability (CVE-2026-1234) in the parser, exploitable via crafted input.'),
    false
  );
  assert.equal(
    describesNoEvent('Document collection shrunk by 0 words from earliest to latest version.'),
    false
  );
});

test('describesNoEvent: non-string / empty input is NOT a no-event (nothing to gate on)', () => {
  assert.equal(describesNoEvent(''), false);
  assert.equal(describesNoEvent(null), false);
  assert.equal(describesNoEvent(undefined), false);
  assert.equal(describesNoEvent(42), false);
});

test('describesNoEvent: malformed JSON-looking text falls through to the prose check, not a crash', () => {
  assert.equal(describesNoEvent('{not valid json, documentCount: 0'), false);
});

// ---------------------------------------------------------------------------
// BaseAgent#addFinding() -- gated write
// ---------------------------------------------------------------------------

test('addFinding: an agent analysing 0 documents writes no node', async () => {
  const { agent, addedNodes } = makeAgent();
  const node = await agent.addFinding(
    JSON.stringify({ source: 'document_analysis_agent', timestamp: new Date().toISOString(), documentCount: 0, documents: [] }),
    'document_contents_for_analysis'
  );
  assert.equal(node, null);
  assert.equal(addedNodes.length, 0);
});

test('addFinding: an agent with a real finding still persists it', async () => {
  const { agent, addedNodes } = makeAgent();
  const node = await agent.addFinding(
    JSON.stringify({ source: 'document_analysis_agent', documentCount: 47, documents: [{ filename: 'a.md' }] }),
    'document_contents_for_analysis'
  );
  assert.ok(node, 'expected a memory node to be created');
  assert.equal(addedNodes.length, 1);
  assert.equal(addedNodes[0].tag, 'document_contents_for_analysis');
  assert.ok(addedNodes[0].content.includes('[AGENT: agent_1783691902660]'));
});

test('addFinding: no memory injected is unaffected by the event gate (returns null, warns, does not throw)', async () => {
  const agent = Object.create(BaseAgent.prototype);
  Object.assign(agent, { agentId: 'agent_x', logger: makeLogger(), memory: null, results: [] });
  const node = await agent.addFinding('a perfectly real finding about something that happened', 'agent_finding');
  assert.equal(node, null);
});

// ---------------------------------------------------------------------------
// BaseAgent#addInsight() -- gated write
// ---------------------------------------------------------------------------

test('addInsight: an insight of 0 words across 0 documents writes no node', async () => {
  const { agent, addedNodes } = makeAgent();
  const node = await agent.addInsight(
    'Total content analyzed: 0 words across 0 documents',
    'document_ingestion_insight'
  );
  assert.equal(node, null);
  assert.equal(addedNodes.length, 0);
});

test('addInsight: an insight with real word/document counts still persists', async () => {
  const { agent, addedNodes } = makeAgent();
  const node = await agent.addInsight(
    'Total content analyzed: 12,480 words across 47 documents',
    'document_ingestion_insight'
  );
  assert.ok(node, 'expected a memory node to be created');
  assert.equal(addedNodes.length, 1);
});

test('addInsight: a genuine analytical insight with no zero-count shape at all still persists', async () => {
  const { agent, addedNodes } = makeAgent();
  const node = await agent.addInsight(
    'The document collection shows a consistent architectural layering: feeder -> compiler -> brain.',
    'analysis_insight'
  );
  assert.ok(node);
  assert.equal(addedNodes.length, 1);
  assert.equal(addedNodes[0].tag, 'analysis_insight');
});

// ---------------------------------------------------------------------------
// synthesis-agent.js -- shouldPersistSynthesisReport()
// ---------------------------------------------------------------------------

test('shouldPersistSynthesisReport: zero evidence nodes -> do not persist', () => {
  assert.equal(shouldPersistSynthesisReport(0), false);
});

test('shouldPersistSynthesisReport: real evidence nodes -> persist', () => {
  assert.equal(shouldPersistSynthesisReport(1), true);
  assert.equal(shouldPersistSynthesisReport(47), true);
});

// ---------------------------------------------------------------------------
// Composter -- files no node at all
// ---------------------------------------------------------------------------

async function writeDiscardedThoughts(filePath, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      reason: i % 2 === 0 ? 'low_signal' : 'duplicate',
      candidate: { signal: 'weak' },
      ts: new Date(Date.now() - i * 1000).toISOString(),
      finalVerdict: { model: 'gpt-5.5' },
    }));
  }
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
}

test('the composter files no node at all -- a janitor does not receipt into what it cleans', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-composter-'));
  const filePath = path.join(tmp, 'discarded-thoughts.jsonl');
  await writeDiscardedThoughts(filePath, 600); // above DISCARDED_THRESHOLD (500)

  const addNodeCalls = [];
  const logger = makeLogger();
  const composter = new Composter({
    brainDir: tmp,
    memory: {
      async addNode(content, tag) {
        addNodeCalls.push({ content, tag });
        return { id: 'should_not_exist' };
      },
    },
    logger,
  });

  const result = await composter.tick(Date.now());

  assert.equal(addNodeCalls.length, 0, 'composter must not write any brain node, ever');
  assert.ok(result, 'composting should still have run and returned a result');
  assert.equal(result.entriesProcessed, 600);
  assert.ok(typeof result.summary === 'string' && result.summary.length > 0);

  // Logging is kept -- composting activity must still be visible in logs.
  const completionLog = logger.entries.find((e) => e.level === 'info' && e.message.includes('composting complete'));
  assert.ok(completionLog, 'expected composting-complete log entry to remain');

  // File truncation still happens -- that part of composting is unaffected.
  const afterContent = await fs.readFile(filePath, 'utf8');
  assert.equal(afterContent, '');
});

test('the composter does nothing below the discard threshold (unrelated to the event gate, sanity check)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-composter-'));
  const filePath = path.join(tmp, 'discarded-thoughts.jsonl');
  await writeDiscardedThoughts(filePath, 10);

  const addNodeCalls = [];
  const composter = new Composter({
    brainDir: tmp,
    memory: { async addNode(content, tag) { addNodeCalls.push({ content, tag }); return { id: 'x' }; } },
    logger: makeLogger(),
  });

  const result = await composter.tick(Date.now());

  assert.equal(result, null);
  assert.equal(addNodeCalls.length, 0);
});
