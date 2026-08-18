import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { EchoLobe, ModelLobe, validateLobeResult, buildLobePrompt, parseLobeResponse } from '../src/lobe.js';
import type { LobeAdapter } from '../src/lobe.js';
import type { SourceEvent, WorkspacePacket, LobeResult, ModelReceipt } from '../src/types.js';
import { TEST_ANATOMY } from './named-anatomy.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-lobe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedEvent(ref: string, category: SourceEvent['category'], producedAt: string): SourceEvent {
  return { eventId: `evt_${ref}`, category, sourceAuthority: 'seed.adapter', sourceRef: ref, payload: {}, producedAt };
}

function receipt(): ModelReceipt {
  return { modelId: 'test', provider: 'test', invokedAt: '1970-01-01T00:00:00.000Z', durationMs: 1, tokensIn: 10, tokensOut: 10 };
}

/** Drive a seed to a workspace admission so lobes have a packet to work on. */
function admittedPacket(seed: SeedProcess): WorkspacePacket {
  for (let i = 0; i < 8; i++) {
    seed.transition(fixedEvent(`c-${i}`, 'correction', `2026-08-07T10:0${i}:00.000Z`));
  }
  const outcome = seed.workspaceCycle('2026-08-07T10:10:00.000Z');
  assert.equal(outcome.kind, 'workspace');
  if (outcome.kind !== 'workspace') throw new Error('unreachable');
  return outcome.packet;
}

test('echo lobe end-to-end: recruit → validate → staged deltas → receipted commit', async (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 51 });
  const packet = admittedPacket(seed);
  const hashBefore = seed.getState().stateHash;

  const outcome = await seed.recruitLobe(new EchoLobe(), packet, '2026-08-07T10:11:00.000Z');

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.applied.length, 1, 'echo lobe proposes exactly one estimates.append');
  assert.notEqual(seed.getState().stateHash, hashBefore, 'accepted delta must move the state hash');

  const cell = seed.getCell(packet.activeCellIds[0] ?? '');
  assert.ok(cell !== undefined);
  assert.equal(cell.estimates.length, 1, 'estimate landed on the admitted cell');
  assert.match(cell.estimates[0]?.claim ?? '', /^echo estimate/);

  // Forms/actions were receipted as rejected (Cut 4 authority), zero granted.
  assert.ok(outcome.rejected.every((r) => r.kind !== 'stateDelta' || !r.reason.includes('allowlist')));
});

test('lobe deltas targeting non-admitted cells are rejected with reasons', (t) => {
  const packet: WorkspacePacket = {
    activeCellIds: ['contact.jtr-jerry'],
    eventRefs: [],
    tensions: [],
    predictions: [],
    uncertainty: 0.5,
    requestedCapability: 'lobe.recruit.model',
    authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'], maxTokenBudget: 2000 },
  };
  const result: LobeResult = {
    observations: [{ cellId: 'world.home23', claim: 'not admitted', confidence: 0.5, evidenceRef: 'x' }],
    interpretations: [],
    predictions: [],
    stateDeltas: [
      { cellId: 'world.home23', field: 'estimates.append', delta: { claim: 'sneak', confidence: 0.5 }, authority: 'propose' },
      { cellId: 'contact.jtr-jerry', field: 'dispositions.wakeThreshold', delta: { value: 0 }, authority: 'propose' },
      { cellId: 'contact.jtr-jerry', field: 'uncertainty.adjust', delta: { value: 0.9 }, authority: 'propose' },
    ],
    candidateForms: [],
    candidateActions: [],
    uncertainty: 0.5,
    evidenceRefs: [],
    modelReceipt: receipt(),
  };
  const validated = validateLobeResult(result, packet);
  assert.equal(validated.accepted.observations.length, 0, 'observation on non-admitted cell rejected');
  assert.equal(validated.accepted.stateDeltas.length, 0, 'all three deltas rejected');
  const reasons = validated.rejected.map((r) => r.reason).join(' | ');
  assert.match(reasons, /not admitted/);
  assert.match(reasons, /not in allowlist/, 'dispositions can NEVER be written by a lobe');
  assert.match(reasons, /out of bounds/, 'uncertainty.adjust magnitude capped');
});

test('observe-ceiling packet rejects ALL state deltas', (t) => {
  const packet: WorkspacePacket = {
    activeCellIds: ['contact.jtr-jerry'],
    eventRefs: [],
    tensions: [],
    predictions: [],
    uncertainty: 0.5,
    requestedCapability: 'local.state.read',
    authorityCeiling: 'observe',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations'], maxTokenBudget: 2000 },
  };
  const result: LobeResult = {
    observations: [],
    interpretations: [],
    predictions: [],
    stateDeltas: [{ cellId: 'contact.jtr-jerry', field: 'uncertainty.adjust', delta: { value: 0.1 }, authority: 'propose' }],
    candidateForms: [],
    candidateActions: [],
    uncertainty: 0.5,
    evidenceRefs: [],
    modelReceipt: receipt(),
  };
  const validated = validateLobeResult(result, packet);
  assert.equal(validated.accepted.stateDeltas.length, 0);
  assert.match(validated.rejected[0]?.reason ?? '', /observe/);
});

test('a failing lobe is receipted with zero mutation', async (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 52 });
  const packet = admittedPacket(seed);
  const hashBefore = seed.getState().stateHash;
  const seqBefore = seed.getState().ledgerSeq;

  const failing: LobeAdapter = {
    id: 'lobe.broken',
    modelId: 'broken',
    provider: 'test',
    invoke: () => Promise.reject(new Error('provider exploded')),
  };
  const outcome = await seed.recruitLobe(failing, packet, '2026-08-07T10:12:00.000Z');

  assert.match(outcome.error ?? '', /provider exploded/);
  assert.equal(outcome.applied.length, 0);
  assert.equal(seed.getState().stateHash, hashBefore, 'failed lobe must not move state');
  assert.ok(seed.getState().ledgerSeq > seqBefore, 'the failure itself must be receipted');
});

test('a hanging lobe times out and is receipted with zero mutation', async (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 53 });
  const packet = admittedPacket(seed);
  const hashBefore = seed.getState().stateHash;

  const hanging: LobeAdapter = {
    id: 'lobe.hang',
    modelId: 'hang',
    provider: 'test',
    invoke: () => new Promise(() => { /* never settles */ }),
  };
  const outcome = await seed.recruitLobe(hanging, packet, '2026-08-07T10:13:00.000Z', 50);
  assert.match(outcome.error ?? '', /timed out/);
  assert.equal(seed.getState().stateHash, hashBefore);
});

test('a slow lobe succeeds under a raised timeout — the cap must fit the transport', async (t) => {
  // The live failure mode: a broker-mediated transport (poll + model) took
  // ~35s while the default cap was 30s — the thought arrived and was thrown
  // away. The cap is a parameter of the transport's real latency, not a law.
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 57 });
  const packet = admittedPacket(seed);

  const echo = new EchoLobe();
  const slow: LobeAdapter = {
    id: 'lobe.slow',
    modelId: 'slow',
    provider: 'test',
    invoke: async (p) => {
      await new Promise((r) => setTimeout(r, 120));
      return echo.invoke(p);
    },
  };
  const timedOut = await seed.recruitLobe(slow, packet, '2026-08-07T10:14:00.000Z', 40);
  assert.match(timedOut.error ?? '', /timed out/, 'under-sized cap wastes the thought');
  const landed = await seed.recruitLobe(slow, packet, '2026-08-07T10:15:00.000Z', 5000);
  assert.equal(landed.error, undefined);
  assert.ok(landed.applied.length > 0, 'same lobe, adequate cap — deltas land');
});

test('lobe receipt carries the FULL applied deltas — replayable without a model', async (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 54 });
  const packet = admittedPacket(seed);
  await seed.recruitLobe(new EchoLobe(), packet, '2026-08-07T10:11:00.000Z');
  seed.stop();

  const restored = SeedProcess.restore(dir);
  const cell = restored.getCell(packet.activeCellIds[0] ?? '');
  assert.ok(cell !== undefined);
  assert.equal(cell.estimates.length, 1, 'lobe-applied estimate survives restart via checkpoint');
});

test('ModelLobe parses a JSON-bearing response and rejects a prose-only one', async () => {
  const packet: WorkspacePacket = {
    activeCellIds: ['contact.jtr-jerry'],
    eventRefs: [],
    tensions: [],
    predictions: [],
    uncertainty: 0.4,
    requestedCapability: 'lobe.recruit.model',
    authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'], maxTokenBudget: 2000 },
  };

  const good = new ModelLobe('lobe.m', 'm-1', 'test', () => Promise.resolve({
    text: 'Sure! Here is the JSON:\n{"interpretations":[{"cellId":"contact.jtr-jerry","interpretation":"ok","confidence":0.6}],"uncertainty":0.4}',
    modelReceipt: receipt(),
  }));
  const result = await good.invoke(packet);
  assert.equal(result.interpretations.length, 1);

  const bad = new ModelLobe('lobe.b', 'm-1', 'test', () => Promise.resolve({
    text: 'I feel that the situation is deeply meaningful and evolving.',
    modelReceipt: receipt(),
  }));
  await assert.rejects(bad.invoke(packet), /no JSON object/, 'prose without JSON is a protocol failure, not a state change');

  const prompt = buildLobePrompt(packet);
  assert.match(prompt, /typed state changes/);
  assert.match(prompt, /uncertainty\.adjust/);

  const parsed = parseLobeResponse('{"stateDeltas":[]}', receipt());
  assert.deepEqual(parsed.stateDeltas, []);
});

test('parseLobeResponse recovers a valid prefix from token-cap truncation', () => {
  // The live failure signature (bobby, 21 receipts): the model hits the
  // response-token cap mid-array; the raw slice dies with "Expected ',' or ']'
  // after array element". Recovery trims to the last complete element and the
  // receipt carries the truncation fact — never silent completeness.

  // Truncated mid-element: the complete first observation survives.
  const midElement =
    '{"observations":[{"cellId":"world.pi","claim":"baro stable","confidence":0.7,"evidenceRef":"r1"},{"cellId":"world.pi","claim":"temp risi';
  const recovered = parseLobeResponse(midElement, receipt());
  assert.equal(recovered.observations.length, 1);
  assert.equal(recovered.observations[0]?.claim, 'baro stable');
  assert.equal(recovered.uncertainty, 0.5, 'lost uncertainty falls back to the default');
  assert.ok((recovered.modelReceipt.truncatedResponse?.droppedChars ?? 0) > 0, 'receipt must carry the truncation fact');

  // Truncated deep inside stateDeltas: everything complete before the cut
  // survives — including the first, complete delta.
  const midDelta =
    '{"observations":[{"cellId":"world.pi","claim":"a","confidence":0.6,"evidenceRef":"r1"}],'
    + '"interpretations":[{"cellId":"world.pi","interpretation":"steady","confidence":0.6}],'
    + '"predictions":[],'
    + '"stateDeltas":[{"cellId":"world.pi","field":"estimates.append","delta":{"claim":"baseline 1011","confidence":0.6,"evidenceRefs":[]},"authority":"propose"},'
    + '{"cellId":"world.pi","field":"estim';
  const deep = parseLobeResponse(midDelta, receipt());
  assert.equal(deep.observations.length, 1);
  assert.equal(deep.interpretations.length, 1);
  assert.equal(deep.predictions.length, 0);
  assert.equal(deep.stateDeltas.length, 1);
  assert.equal((deep.stateDeltas[0]?.delta as { claim?: string }).claim, 'baseline 1011');
  assert.ok((deep.modelReceipt.truncatedResponse?.droppedChars ?? 0) > 0);

  // Truncated right after a comma: the dangling comma is dropped with the tail.
  const afterComma = '{"observations":[{"cellId":"world.pi","claim":"x","confidence":0.5},';
  assert.equal(parseLobeResponse(afterComma, receipt()).observations.length, 1);

  // Escaped quotes inside claims must not confuse the scanner.
  const withEscapes =
    '{"observations":[{"cellId":"world.pi","claim":"said \\"hi\\" loud","confidence":0.5},{"cellId":"world.pi","claim":"unfinished \\"qu';
  const escaped = parseLobeResponse(withEscapes, receipt());
  assert.equal(escaped.observations.length, 1);
  assert.equal(escaped.observations[0]?.claim, 'said "hi" loud');

  // No '}' anywhere (cut before any object closed) but a complete empty array
  // exists — still recoverable.
  const noBrace = '{"observations":[],"interpretations":[{"cellId":"world.pi","interp';
  const empties = parseLobeResponse(noBrace, receipt());
  assert.deepEqual(empties.observations, []);
  assert.deepEqual(empties.interpretations, []);
  assert.ok((empties.modelReceipt.truncatedResponse?.droppedChars ?? 0) > 0);
});

test('parseLobeResponse stays honest: complete responses carry no truncation marker, hopeless ones still throw', () => {
  // Complete JSON — untouched, no marker.
  const whole = parseLobeResponse(
    '{"observations":[{"cellId":"world.pi","claim":"x","confidence":0.5,"evidenceRef":"r1"}],"uncertainty":0.4}',
    receipt(),
  );
  assert.equal(whole.observations.length, 1);
  assert.equal(whole.uncertainty, 0.4);
  assert.equal(whole.modelReceipt.truncatedResponse, undefined, 'whole responses must not claim truncation');

  // Prose-wrapped complete JSON — existing behavior preserved, no marker.
  const wrapped = parseLobeResponse(
    'Sure! Here you go:\n{"interpretations":[{"cellId":"world.pi","interpretation":"ok","confidence":0.6}],"uncertainty":0.4}\nHope this helps.',
    receipt(),
  );
  assert.equal(wrapped.interpretations.length, 1);
  assert.equal(wrapped.modelReceipt.truncatedResponse, undefined);

  // No JSON at all — unchanged honest failure.
  assert.throws(() => parseLobeResponse('deeply meaningful prose', receipt()), /no JSON object/);

  // Truncated before ANY element completed — nothing recoverable, honest throw.
  assert.throws(() => parseLobeResponse('{"observations":[{"cellId":"world.pi","claim":"the baro', receipt()), /truncated/);

  // Balanced but invalid JSON is NOT truncation — the original parse error
  // surfaces (a SyntaxError), never a fabricated recovery.
  assert.throws(
    () => parseLobeResponse('{"observations": [oops]}', receipt()),
    (e: unknown) => e instanceof SyntaxError,
    'non-truncation malformation must rethrow the real parse error',
  );
});

test('single-admitted-cell attribution: missing cellId defaults to the sole admitted cell; ambiguous stays rejected', () => {
  const onePacket: WorkspacePacket = {
    activeCellIds: ['world.home23'],
    eventRefs: [],
    tensions: [],
    predictions: [],
    uncertainty: 0.5,
    requestedCapability: 'lobe.recruit.model',
    authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'], maxTokenBudget: 2000 },
  };
  const noCellIds = {
    observations: [],
    interpretations: [{ interpretation: 'model forgot the cellId', confidence: 0.6 }],
    predictions: [],
    stateDeltas: [{ field: 'estimates.append', delta: { claim: 'attributed estimate', confidence: 0.5, evidenceRefs: [] }, authority: 'propose' }],
    candidateForms: [],
    candidateActions: [],
    uncertainty: 0.5,
    evidenceRefs: [],
    modelReceipt: receipt(),
  } as unknown as LobeResult;

  const one = validateLobeResult(noCellIds, onePacket);
  assert.equal(one.accepted.interpretations.length, 1, 'sole-cell attribution accepts the interpretation');
  assert.equal(one.accepted.interpretations[0]?.cellId, 'world.home23');
  assert.equal(one.accepted.stateDeltas.length, 1, 'sole-cell attribution accepts the delta');

  const twoPacket: WorkspacePacket = { ...onePacket, activeCellIds: ['world.home23', 'contact.jtr-jerry'] };
  const two = validateLobeResult(noCellIds, twoPacket);
  assert.equal(two.accepted.interpretations.length, 0, 'ambiguous attribution stays rejected');
  assert.equal(two.accepted.stateDeltas.length, 0);
});

test('prompt shows the exact response shape with the admitted cellId inline', () => {
  const packet: WorkspacePacket = {
    activeCellIds: ['world.home23'],
    eventRefs: [],
    tensions: [],
    predictions: [],
    uncertainty: 0.5,
    requestedCapability: 'lobe.recruit.model',
    authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'], maxTokenBudget: 2000 },
  };
  const prompt = buildLobePrompt(packet);
  assert.match(prompt, /"cellId": "world\.home23"/, 'the example must carry the real admitted cellId');
  assert.match(prompt, /rejected unread/);
});

/**
 * The prompt must ASK. Audit 2026-08-13: across jerry's and forrest's entire
 * lives — 148 estimates.append, 199 uncertainty.adjust, 28 predictions.append,
 * 24 predictions.resolve — `intentions.append` was proposed ZERO times. Never
 * refused; never asked. Usage tracked prompt real estate almost exactly, and
 * intentions.append had one mid-sentence mention in a list of shapes and no
 * worked example. It is the only lobe-writable term that can RAISE a cell's
 * claim (uncertainty.adjust also reaches admissionScore via modulation, but 170
 * of its 208 applications across both lives were NEGATIVE — they could settle
 * themselves and never speak up). It is the
 * one delta by which thinking changes what the individual attends to next.
 *
 * These pin the ask, because a capability nobody is invited to use is
 * indistinguishable from one that does not exist.
 */
test('the lobe prompt demonstrates intentions.append, not only estimates.append', () => {
  const prompt = buildLobePrompt({
    activeCellIds: ['c1'], eventRefs: [], tensions: [], predictions: [],
    uncertainty: 0.5, requestedCapability: 'lobe.recruit.model', authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'], maxTokenBudget: 2000 },
  });
  const lines = prompt.split('\n');
  const start = lines.findIndex((l) => l.includes('Exact response shape'));
  assert.ok(start >= 0, 'response shape block must exist');
  const block = lines.slice(start + 1, lines.indexOf('}', start) + 1).join('\n');
  const example = JSON.parse(block) as { stateDeltas: Array<{ field: string }> };
  const fields = new Set(example.stateDeltas.map((d) => d.field));
  assert.ok(fields.has('intentions.append'), 'intentions.append must be WORKED, not merely listed');
  assert.ok(fields.has('estimates.append'));
});

test('the prompt names "tensions" — the packet key the lobe is shown', () => {
  const prompt = buildLobePrompt({
    activeCellIds: ['c1'], eventRefs: [], tensions: [], predictions: [],
    uncertainty: 0.5, requestedCapability: 'lobe.recruit.model', authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'], maxTokenBudget: 2000 },
  });
  // The packet shows `tensions`; before this the prose never used the word, so
  // an always-empty array had no vocabulary connecting it to the field that
  // fills it. Shown a hole he was never told he could fill.
  assert.match(prompt, /tensions/, 'the prose must name the packet key');
  assert.match(prompt, /EARNED/, 'the prompt must say WHEN an intention is warranted');
});
