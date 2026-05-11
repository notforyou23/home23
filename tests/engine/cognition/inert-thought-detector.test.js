import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyInertThought,
  hasHallucinatedToolCall,
  isBareActionOnlyThought,
  isBareToolCommandText,
  isRestlessStimulationLoop,
  isToolPlanWithoutResult,
} = require('../../../engine/src/cognition/hallucinated-tool-call-detector.js');

test('classifyInertThought rejects bare action tags', () => {
  assert.equal(isBareActionOnlyThought('INVESTIGATE'), true);
  assert.equal(isBareActionOnlyThought('  **OBSERVE**  '), true);
  assert.equal(classifyInertThought('INVESTIGATE'), 'bare_action_tag');
});

test('classifyInertThought rejects bare cycle tool command text', () => {
  assert.equal(isBareToolCommandText('get_live_problems get_system_state'), true);
  assert.equal(isBareToolCommandText('read_surface("RECENT.md")'), true);
  assert.equal(classifyInertThought('get_live_problems get_system_state'), 'bare_tool_command');
});

test('classifyInertThought rejects tool plans without fresh results', () => {
  const text = 'I will ground operational claims by calling fresh tools.\nTool calls:\n- get_live_problems()\n- get_system_state()\nAfter receiving tool results, I will synthesize one insight.';
  assert.equal(isToolPlanWithoutResult(text), true);
  assert.equal(classifyInertThought(text), 'tool_plan_without_result');
});

test('classifyInertThought keeps grounded tool-result summaries', () => {
  const text = 'get_live_problems reports no active problems, and get_system_state shows cycle 6261 with the loop awake. NO_ACTION';
  assert.equal(classifyInertThought(text), null);
  assert.equal(hasHallucinatedToolCall(text), false);
});

test('classifyInertThought keeps real action payloads', () => {
  assert.equal(classifyInertThought('INVESTIGATE The transport sampler has failed five times; inspect the collector logs and compare the last successful timestamp.'), null);
});

test('classifyInertThought rejects restless stimulation loops', () => {
  const text = 'The query returned thin results, so I should run the same query again and generate another check. It feels like action even though nothing is landing.';
  assert.equal(isRestlessStimulationLoop(text), true);
  assert.equal(classifyInertThought(text), 'restless_stimulation_loop');
});

test('classifyInertThought keeps boredom signals that choose rest or target acquisition', () => {
  const text = 'The current thread has thin results, so the better target is genuine rest and fresh context before querying again.';
  assert.equal(isRestlessStimulationLoop(text), false);
  assert.equal(classifyInertThought(text), null);
});
