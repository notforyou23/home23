import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — vanilla JS module, no .d.ts
import { reconcileCanonicalAssistantElements } from '../../engine/src/dashboard/home23-chat-reconstruction.mjs';

function element(turnId: string | undefined, text: string) {
  return { dataset: { turnId }, textContent: text, innerHTML: text };
}

test('terminal canonical content replaces the last partial assistant for its turn', () => {
  const old = element('t-old', 'older answer');
  const firstPhase = element('t-live', 'tool preamble');
  const partial = element('t-live', 'Targeting:');

  const result = reconcileCanonicalAssistantElements(
    [old, firstPhase, partial],
    't-live',
    'Targeting: full canonical answer',
    (text: string) => `<p>${text}</p>`,
  );

  assert.equal(result, partial);
  assert.equal(partial.innerHTML, '<p>Targeting: full canonical answer</p>');
  assert.equal(firstPhase.innerHTML, 'tool preamble');
  assert.equal(old.innerHTML, 'older answer');
});

test('terminal reconciliation is idempotent and never creates a second assistant', () => {
  const canonical = element('t-live', 'Full answer');

  const result = reconcileCanonicalAssistantElements(
    [canonical],
    't-live',
    'Full answer',
    (text: string) => `<p>${text}</p>`,
  );

  assert.equal(result, canonical);
  assert.equal(canonical.innerHTML, 'Full answer', 'already-canonical content is not rewritten or duplicated');
});
