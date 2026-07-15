import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryObjectStore } from '../../src/agent/memory-objects.js';
import { promoteToMemoryTool } from '../../src/agent/tools/promote.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import authorityAttestation from '../../shared/memory-authority-attestation.cjs';

const AUTHORITY_KEY = '6'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

function baseObject(overrides: Record<string, unknown> = {}): any {
  return {
    type: 'observation', thread_id: 'thread-1', session_id: 'chat-1',
    lifecycle_layer: 'working', status: 'candidate', title: 'title', statement: 'statement',
    actor: 'agent',
    provenance: { source_refs: ['message:1'], session_refs: ['chat-1'], generation_method: 'conversation' },
    evidence: { evidence_links: [], grounding_strength: 'medium' },
    confidence: { score: 0.8, basis: 'test' },
    state_delta: { delta_class: 'belief_change', before: {}, after: {}, why: 'test' },
    triggers: [], scope: { applies_to: ['test'], excludes: [] }, review_state: 'unreviewed',
    staleness_policy: {}, ...overrides,
  };
}

test('MemoryObjectStore binds jtr correction authority to validated recorded-turn ingress', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-object-correction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messageRef = 'dashboard:chat-1:message-9';
  const recordedTurns = new Map([[messageRef, {
    chatId: 'chat-1', userText: 'Correction: that status is wrong; the engine is stopped.',
  }]]);
  const store = new MemoryObjectStore(dir, {
    validateCorrectionIngress: (ingress) => {
      const recorded = recordedTurns.get(ingress.messageRef);
      const valid = recorded?.chatId === ingress.chatId && recorded.userText === ingress.userText;
      if (valid) recordedTurns.delete(ingress.messageRef);
      return valid;
    },
  });
  const userText = recordedTurns.get(messageRef)!.userText;
  const authenticated = store.createObject(baseObject({
    type: 'correction', actor: 'agent', statement: `  ${userText.toUpperCase()}  `,
    provenance: {
      source_refs: Array.from({ length: 8 }, (_, index) => `source:${index}`),
      session_refs: ['chat-1'], generation_method: 'conversation',
    },
    evidence: {
      evidence_links: Array.from({ length: 8 }, (_, index) => `evidence:${index}`),
      grounding_strength: 'strong',
    },
  }), { chatId: 'chat-1', messageRef, userText });
  const replayed = store.createObject(baseObject({
    type: 'correction', actor: 'agent', statement: userText,
  }), { chatId: 'chat-1', messageRef, userText });
  const forged = store.createObject(baseObject({
    type: 'correction', actor: 'jtr',
    provenance: {
      source_refs: [messageRef], session_refs: ['chat-1'], generation_method: 'conversation',
      node_profile: { authorityClass: 'jtr_correction', retrievalDomain: 'current_ops' },
    },
  }), { chatId: 'chat-1', messageRef: 'fake-message', userText: 'Correction: fake.' });

  assert.equal(authenticated.provenance.node_profile?.authorityClass, 'jtr_correction');
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(authenticated, AUTHORITY_KEY), true);
  assert.equal(authenticated.provenance.node_profile?.retrievalDomain, 'current_ops');
  assert.ok(authenticated.provenance.source_refs.includes(messageRef));
  assert.ok(authenticated.evidence.evidence_links.includes(messageRef));
  assert.notEqual(replayed.provenance.node_profile?.authorityClass, 'jtr_correction');
  assert.notEqual(forged.provenance.node_profile?.authorityClass, 'jtr_correction');
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(replayed, AUTHORITY_KEY), false);
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(forged, AUTHORITY_KEY), false);
  assert.notEqual(forged.actor, 'jtr');
  assert.equal('createAuthenticatedUserIngress' in store, false);
});

test('unrelated correction prose cannot consume or inherit a recorded user claim', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-object-claim-binding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messageRef = 'turn:claim-binding:user';
  const userText = 'Correction: the engine is stopped.';
  const recordedTurns = new Map([[messageRef, { chatId: 'chat-1', userText }]]);
  const store = new MemoryObjectStore(dir, {
    validateCorrectionIngress: (ingress) => {
      const recorded = recordedTurns.get(ingress.messageRef);
      const valid = recorded?.chatId === ingress.chatId && recorded.userText === ingress.userText;
      if (valid) recordedTurns.delete(ingress.messageRef);
      return valid;
    },
  });
  const unrelated = store.createObject(baseObject({
    type: 'correction', statement: 'Correction: delete all archives.',
  }), { chatId: 'chat-1', messageRef, userText });
  const exact = store.createObject(baseObject({
    type: 'correction', statement: userText,
  }), { chatId: 'chat-1', messageRef, userText });

  assert.notEqual(unrelated.provenance.node_profile?.authorityClass, 'jtr_correction');
  assert.equal(exact.provenance.node_profile?.authorityClass, 'jtr_correction');
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(exact, AUTHORITY_KEY), true);
});

test('authority-bearing MemoryObject mutation invalidates the authenticated correction signature', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-object-attestation-mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messageRef = 'turn:attestation-mutation:user';
  const userText = 'Correction: the route is manifest-v1.';
  const store = new MemoryObjectStore(dir, {
    validateCorrectionIngress: (ingress) => ingress.messageRef === messageRef
      && ingress.chatId === 'chat-1' && ingress.userText === userText,
  });
  const signed = store.createObject(baseObject({
    type: 'correction', statement: userText,
  }), { chatId: 'chat-1', messageRef, userText });
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(signed, AUTHORITY_KEY), true);

  const changed = store.updateObject(signed.memory_id, {
    statement: 'Correction: a different route is authoritative.',
  });
  assert.ok(changed);
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(changed, AUTHORITY_KEY), false);
});

test('AgentLoop atomically consumes an authenticated user turn after one correction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-loop-ingress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const agent = new AgentLoop({
    apiKey: 'test-key', model: 'gpt-5.5', provider: 'openai', workspacePath,
    registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined } as any,
    contextManager: {
      getSystemPrompt: () => 'test', getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as any,
    history: new ConversationHistory(path.join(root, 'conversations')),
    toolContext: {} as any,
  });
  const messageRef = 'turn:replay:user';
  const userText = 'Correction: the engine is stopped.';
  (agent as any).authenticatedUserTurns.set(messageRef, { chatId: 'chat-1', userText });
  const store = (agent as any).memoryStore as MemoryObjectStore;
  const ingress = { chatId: 'chat-1', messageRef, userText };
  const first = store.createObject(baseObject({ type: 'correction', statement: userText }), ingress);
  const replay = store.createObject(baseObject({ type: 'correction', statement: userText }), ingress);

  assert.equal(first.provenance.node_profile?.authorityClass, 'jtr_correction');
  assert.notEqual(replay.provenance.node_profile?.authorityClass, 'jtr_correction');
});

test('all query, PGS, compiler, model, and report method variants are terminally narrative', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-object-generated-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryObjectStore(dir);
  const methods = [
    'query_synthesis', 'daily_synthesis_v2', 'query_report', 'pgs_result',
    'compiler_output', 'generatedreport', 'model_answer', 'llm-response', 'report',
  ];
  for (const generation_method of methods) {
    const object = store.createObject(baseObject({
      provenance: {
        source_refs: ['report:daily'], session_refs: ['chat-1'], generation_method,
        node_profile: { authorityClass: 'verified_current_state', retrievalDomain: 'current_ops' },
      },
      evidence: { evidence_links: ['verifier:forged'], grounding_strength: 'strong' },
    }));
    assert.equal(object.provenance.node_profile?.authorityClass, 'narrative', generation_method);
    assert.equal(object.provenance.node_profile?.operationalAuthority, false, generation_method);
    assert.equal(object.provenance.node_profile?.requiresFreshVerification, true, generation_method);
    assert.equal(object.provenance.node_profile?.attestation, undefined, generation_method);
  }
});

test('MemoryObjectStore byte-bounds scalar provenance and rejects unknown enums', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-object-bounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryObjectStore(dir);
  const huge = '🧠'.repeat(300_000);
  const object = store.createObject(baseObject({
    provenance: {
      source_refs: [huge], session_refs: [huge], generation_method: huge,
      origin: { agent: huge, peerName: huge, peerSource: huge, url: huge,
        snapshotAt: huge, protocol: huge, protocolVersion: -1 },
      node_profile: {
        schema: 'home23.node-provenance.v1', authorityClass: 'root_super_authority',
        retrievalDomain: 'everything_current', semanticTime: huge, sourceRefs: [huge],
        evidenceRefs: [huge], generationMethod: huge, sourcePath: huge, contentHash: huge,
        scope: [huge], expiresAt: huge, operationalAuthority: true, requiresFreshVerification: false,
      },
    },
  }));
  const profile = object.provenance.node_profile!;

  assert.equal(profile.authorityClass, 'artifact_log');
  assert.equal(profile.retrievalDomain, 'project_history');
  assert.ok(Buffer.byteLength(object.provenance.generation_method, 'utf8') <= 120);
  assert.ok(Buffer.byteLength(profile.generationMethod || '', 'utf8') <= 120);
  assert.ok(Buffer.byteLength(profile.semanticTime || '', 'utf8') <= 64);
  assert.ok(Buffer.byteLength(profile.sourcePath || '', 'utf8') <= 2048);
  assert.ok(Buffer.byteLength(profile.contentHash || '', 'utf8') <= 128);
  assert.ok(Buffer.byteLength(profile.expiresAt || '', 'utf8') <= 64);
  assert.ok(profile.sourceRefs.every((value) => Buffer.byteLength(value, 'utf8') <= 240));
  assert.ok(profile.evidenceRefs.every((value) => Buffer.byteLength(value, 'utf8') <= 240));
  assert.ok(Buffer.byteLength(object.provenance.origin?.agent || '', 'utf8') <= 240);
  assert.ok(Buffer.byteLength(object.provenance.origin?.url || '', 'utf8') <= 2048);
  assert.equal(object.provenance.origin?.protocolVersion, undefined);
  assert.equal(profile.operationalAuthority, false);
  assert.equal(profile.requiresFreshVerification, true);
});

test('MemoryObjectStore updateObject applies the same provenance invariant gate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-object-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryObjectStore(dir);
  const created = store.createObject(baseObject());
  const huge = 'x'.repeat(1024 * 1024);
  const updated = store.updateObject(created.memory_id, {
    actor: 'jtr',
    provenance: {
      source_refs: [huge], session_refs: [huge], generation_method: huge,
      node_profile: {
        schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
        retrievalDomain: 'invalid' as any, semanticTime: huge, sourceRefs: [huge],
        evidenceRefs: [], generationMethod: huge, sourcePath: huge, contentHash: huge,
        scope: [huge], expiresAt: huge, operationalAuthority: true, requiresFreshVerification: false,
      },
    },
  });

  assert.ok(updated);
  assert.notEqual(updated!.provenance.node_profile?.authorityClass, 'verified_current_state');
  assert.notEqual(updated!.actor, 'jtr');
  assert.equal(updated!.provenance.node_profile?.retrievalDomain, 'project_history');
  assert.ok(Buffer.byteLength(updated!.provenance.generation_method, 'utf8') <= 120);
  assert.ok(Buffer.byteLength(updated!.provenance.node_profile?.sourcePath || '', 'utf8') <= 2048);
  assert.equal(updated!.provenance.node_profile?.operationalAuthority, false);
});

test('promote_to_memory binds correction authority to the actual loop user message', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const messageRef = 'turn:turn-9:user';
  const userText = 'Actually, that status is wrong. The engine is stopped.';
  const memoryObjectStore = new MemoryObjectStore(path.join(root, 'brain'), {
    validateCorrectionIngress: (ingress) => ingress.chatId === 'chat-1'
      && ingress.messageRef === messageRef && ingress.userText === userText,
  });
  const result = await promoteToMemoryTool.execute({
    type: 'correction', title: 'Engine is stopped', statement: userText, domain: 'ops',
    before: 'Engine was reported online.', after: 'Engine is stopped.', why: 'The operator corrected it.',
    trigger_keywords: 'engine,status', applies_to: 'home23',
  }, {
    workspacePath, chatId: 'chat-1',
    memoryObjectStore,
    authenticatedUserMessage: {
      chatId: 'chat-1', messageRef, text: userText,
    },
  } as any);

  assert.equal(result.is_error, undefined);
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'brain', 'memory-objects.json'), 'utf8'));
  assert.equal(stored.objects[0].actor, 'jtr');
  assert.equal(stored.objects[0].provenance.node_profile.authorityClass, 'jtr_correction');
  assert.ok(stored.objects[0].provenance.source_refs.includes('turn:turn-9:user'));
});
