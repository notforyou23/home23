import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildForegroundWorkView,
  collectForegroundTurnContext,
} from '../../src/agent/foreground-work-view.js';

test('compact view uses existing Work and commitment projections', () => {
  const view = buildForegroundWorkView({
    work: [{
      workId: 'aw_w1',
      kind: 'coding',
      status: 'running',
      label: 'Refactor the sauna tile',
      progressSummary: 'editing files',
    }],
    commitments: [
      { id: 'rel_1', type: 'promise', title: 'Send the receipt', statement: 'Jerry owes jtr the coding result', status: 'active' },
      { id: 'rel_2', type: 'preference', title: 'Quiet nights', statement: 'ignored', status: 'active' },
    ],
  });
  assert.match(view, /aw_w1/);
  assert.match(view, /same resident/);
  assert.match(view, /Send the receipt/);
  assert.doesNotMatch(view, /Quiet nights/);
});

test('collectForegroundTurnContext reads the existing registries for a chat', () => {
  const listed: unknown[] = [];
  const view = collectForegroundTurnContext({
    chatId: 'ios_chat',
    workRegistry: {
      list(filter) {
        listed.push(filter);
        return [{ workId: 'aw_w1', label: 'W1', status: 'running', kind: 'subagent' }];
      },
    },
    relationshipLedger: {
      listEntries(filter) {
        if (filter.type === 'promise') {
          return [{ id: 'p1', type: 'promise', title: 'Keep talking', statement: 'stay in the room', status: 'active' }];
        }
        return [];
      },
    },
  });
  assert.deepEqual(listed, [{ originChatId: 'ios_chat', active: true, limit: 8 }]);
  assert.match(view, /aw_w1/);
  assert.match(view, /Keep talking/);
});
