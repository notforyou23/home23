import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { EchoLobe, ModelLobe, validateLobeResult, buildLobePrompt, parseLobeResponse } from '../src/lobe.js';
import type { LobeAdapter } from '../src/lobe.js';
import type { SourceEvent, WorkspacePacket, LobeResult, ModelReceipt } from '../src/types.js';

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
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 51 });
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
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 52 });
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
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 53 });
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

test('lobe receipt carries the FULL applied deltas — replayable without a model', async (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 54 });
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
