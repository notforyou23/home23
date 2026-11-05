import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildForegroundWorkView,
  collectForegroundTurnContext,
  collectCanonicalWorkContext,
} from '../../src/agent/foreground-work-view.js';

test('connected turns see assignment meaning and owner direction independently of legacy foreground classification', async () => {
 const view=await collectCanonicalWorkContext(async()=>({registry:'canonical',work:[{id:'wrk_a',state:'running',title:'Fix resume',summary:'Activate and verify the running launcher'}],ownerMessageSequence:12,unseenOwnerMessages:[{text:'Just respond. Stop launching repairs.'}]}));
 assert.match(view,/Fix resume/);assert.match(view,/Activate and verify/);assert.match(view,/Stop launching repairs/);
 assert.match(view,/blocked without a revisit for a pause/); assert.match(view,/owner_message_sequence=12/);
 const unavailable=await collectCanonicalWorkContext(async()=>{throw new Error('offline');});
 assert.match(unavailable,/UNAVAILABLE/);assert.doesNotMatch(unavailable,/Active Work:\n- none/);
});

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
