import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_REASONING_EFFORTS,
  effectiveChatReasoningEffort,
  encodeChatEffortKey,
  effortLabel,
  parseChatReasoningEffort,
} from '../../engine/src/dashboard/home23-chat-effort.mjs';

describe('chat reasoning effort', () => {
  it('accepts the six effort values and treats empty as no override', () => {
    assert.deepEqual([...CHAT_REASONING_EFFORTS], ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const value of CHAT_REASONING_EFFORTS) {
      assert.equal(parseChatReasoningEffort(value), value);
    }
    assert.equal(parseChatReasoningEffort('', { allowDefault: true }), null);
    assert.equal(parseChatReasoningEffort(null, { allowDefault: true }), null);
    assert.throws(() => parseChatReasoningEffort('ultra'), /none, low, medium, high, xhigh, max/);
  });

  it('uses a per-chat override when present and the configured default otherwise', () => {
    assert.equal(effectiveChatReasoningEffort(null, 'medium'), 'medium');
    assert.equal(effectiveChatReasoningEffort('xhigh', 'medium'), 'xhigh');
    assert.equal(effortLabel('xhigh'), 'Extra high');
  });

  it('scopes stored overrides to agent plus conversation', () => {
    assert.equal(
      encodeChatEffortKey('jerry', 'dashboard-jerry-1'),
      'home23:chat:effort:jerry:dashboard-jerry-1',
    );
  });
});
