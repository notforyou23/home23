import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBrainOperationsCommand } from '../../cli/lib/brain-operations-command.js';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-operations-list-'));
  for (const agent of ['zeta', 'ada']) {
    fs.mkdirSync(path.join(root, 'instances', agent, 'runtime', 'brain-operations'), {
      recursive: true,
    });
  }
  return root;
}

function operation(requesterAgent, operationId, overrides = {}) {
  return {
    operationId,
    requestId: `request-${operationId}`,
    operationType: 'query',
    requesterAgent,
    target: { domain: 'requester', requesterAgent },
    state: 'running',
    phase: 'provider',
    recordVersion: 3,
    eventSequence: 4,
    startedAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-10T12:01:00.000Z',
    completedAt: null,
    lastProviderActivityAt: '2026-07-10T12:00:59.000Z',
    lastProgressAt: '2026-07-10T12:00:58.000Z',
    error: null,
    result: { secret: 'must not print' },
    resultHandle: 'brres_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    resultArtifact: { sha256: 'secret' },
    sourceEvidence: { private: true },
    sourcePinDescriptor: { private: true },
    sourcePinDigest: 'sha256:' + 'a'.repeat(64),
    parameters: { query: 'private caller text' },
    requestParameters: { query: 'private caller text' },
    ...overrides,
  };
}

test('operator list binds each canonical instance reader and emits one safe stable object', async () => {
  const root = makeRoot();
  const calls = [];
  const byRequester = {
    ada: [operation('ada', 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')],
    zeta: [operation('zeta', 'brop_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')],
  };
  try {
    const receipt = await runBrainOperationsCommand(
      root,
      ['list', '--state', 'nonterminal', '--all-requesters'],
      {
        now: () => new Date('2026-07-10T12:02:00.000Z'),
        createStoreReader(input) {
          calls.push(input);
          return {
            listNonterminalAuthorized: async () => byRequester[input.expectedRequester],
          };
        },
      },
    );

    assert.deepEqual(calls.map(({ expectedRequester }) => expectedRequester), ['ada', 'zeta']);
    assert.ok(calls.every(({ operationsRoot, liveStore }) =>
      operationsRoot.endsWith(path.join('runtime', 'brain-operations'))
      && liveStore === undefined));
    assert.equal(receipt.checkedAt, '2026-07-10T12:02:00.000Z');
    assert.deepEqual(receipt.requesters, ['ada', 'zeta']);
    assert.equal(receipt.count, 2);
    assert.deepEqual(receipt.operations.map(({ requesterAgent, operationId }) =>
      [requesterAgent, operationId]), [
      ['ada', 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      ['zeta', 'brop_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
    ]);
    const encoded = JSON.stringify(receipt);
    for (const forbidden of [
      'resultHandle', 'resultArtifact', 'sourceEvidence', 'sourcePinDescriptor',
      'sourcePinDigest', 'private caller text', 'must not print',
    ]) assert.equal(encoded.includes(forbidden), false, forbidden);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('operator list is exact, all-requesters-only, and fails closed on unsafe instance roots', async () => {
  const root = makeRoot();
  try {
    for (const args of [
      ['list'],
      ['list', '--state', 'nonterminal'],
      ['list', '--state', 'all', '--all-requesters'],
      ['list', '--state', 'nonterminal', '--all-requesters', '--extra'],
    ]) {
      await assert.rejects(
        runBrainOperationsCommand(root, args, { createStoreReader() { throw new Error('called'); } }),
        (error) => error.code === 'brain_operations_usage',
      );
    }

    fs.symlinkSync(
      path.join(root, 'instances', 'ada'),
      path.join(root, 'instances', 'linked-agent'),
      'dir',
    );
    await assert.rejects(
      runBrainOperationsCommand(root, ['list', '--state', 'nonterminal', '--all-requesters'], {
        createStoreReader() { return { listNonterminalAuthorized: async () => [] }; },
      }),
      (error) => error.code === 'brain_operations_store_invalid',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('operator list fails closed when a requester-bound reader exposes a mismatched record', async () => {
  const root = makeRoot();
  try {
    await assert.rejects(
      runBrainOperationsCommand(root, ['list', '--state', 'nonterminal', '--all-requesters'], {
        createStoreReader({ expectedRequester }) {
          return {
            listNonterminalAuthorized: async () => [
              operation(expectedRequester === 'ada' ? 'zeta' : expectedRequester, 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
            ],
          };
        },
      }),
      (error) => error.code === 'brain_operations_store_invalid',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
