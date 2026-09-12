import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createLiveVoiceService, LiveVoiceError,
  type LiveVoiceAccess, type LiveVoiceOptions, type LiveVoiceStart,
} from '../../../src/coordination/app/live-voice.js';
import type { CoordinationMessageSubmissionPort } from '../../../src/coordination/app/types.js';
import type { MessageProjection } from '../../../src/coordination/messages/types.js';
import type { WorkRecord } from '../../../src/coordination/work/types.js';
import type { GptLiveEvent, GptLiveSessionOptions } from '../../../src/voice/gpt-live-provider.js';
import { assertCoordinationId, generateCoordinationId } from '../../../src/coordination/ids/index.js';

const OWNER = 'user_owner' as const;
const CHANNEL = 'chn_voice';
const CONVERSATION = 'cnv_voice';
const RESIDENT = 'bot_jerry';
const ACCESS_TOKEN = 'private-test-access-token';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function ticks() { await new Promise(resolve => setTimeout(resolve, 35)); }

function access(sessionId = 'auth_1', accessToken = ACCESS_TOKEN): LiveVoiceAccess {
  return {
    context: {
      principalId: OWNER, requestId: 'req_voice', correlationId: 'cor_voice',
      identity: { kind: 'owner', auth: {
        principalId: OWNER, deviceId: 'dev_voice', sessionId, scopes: ['product:read', 'message:send'],
      } },
    },
    channelId: CHANNEL, accessToken, network: { peerAddress: '127.0.0.1' },
  };
}

function message(patch: Partial<MessageProjection> = {}): MessageProjection {
  return {
    id: 'msg_fixture', channelId: CHANNEL, conversationId: CONVERSATION, sequence: 1,
    author: { principalId: OWNER, kind: 'owner', displayName: 'Owner' }, kind: 'text', text: 'Hello',
    mentions: [], clientMessageId: null, replyToMessageId: null, tombstonesMessageId: null,
    provenance: { workId: null, roundId: null }, createdAt: '2026-09-12T12:00:00Z',
    attachments: [], visibility: 'visible', ...patch,
  };
}

function work(id: string, origin: string): WorkRecord {
  return {
    id, principalId: OWNER, targetPrincipalId: RESIDENT, channelId: CHANNEL, originMessageId: origin,
    roundId: null, contextManifestId: 'manifest_voice', kind: 'resident_turn', idempotencyKeyDigest: 'key',
    requestDigest: 'digest', state: 'running', currentAttemptId: 'attempt_voice', nextFencingToken: 2,
    automaticOfferCount: 1, maxAutomaticOffers: 1, terminalReason: null, terminalReceiptDigest: null,
    version: 1, createdAt: '2026-09-12T12:00:00Z', updatedAt: '2026-09-12T12:00:00Z', terminalAt: null,
  };
}

type Submission = Parameters<CoordinationMessageSubmissionPort['submitMessage']>[0];

async function fixture(t: TestContext, override: Partial<LiveVoiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'home23-live-voice-test-'));
  let clock = Date.parse('2026-09-12T12:00:00Z');
  let accepting = true;
  let revoked = false;
  let residentBinding = 'resident-jerry';
  let currentAuth = access().context.identity;
  assert.equal(currentAuth.kind, 'owner');
  const authCalls: string[] = [];
  const rows: MessageProjection[] = [];
  const works = new Map<string, WorkRecord>();
  const submissions: Submission[] = [];
  const responses: ReturnType<typeof deferred<unknown>>[] = [];
  const providers: Array<{ options: GptLiveSessionOptions; sent: GptLiveEvent[]; closes: number }> = [];
  let workCancellations = 0;
  const workPort = {
    get: (id: string) => works.get(id) ?? null,
    cancelQueued() { workCancellations++; throw new Error('voice must not cancel Work'); },
  };
  const options: LiveVoiceOptions = {
    journalDirectory: directory,
    isAccepting: () => accepting,
    apiKey: () => 'private-test-openai-key',
    now: () => clock,
    tickMs: 5,
    transcriptSettleMs: 100,
    heartbeatLeaseMs: 10_000,
    maximumDurationMs: 60_000,
    auth: {
      async validateAccessToken(input) {
        authCalls.push(input.accessToken);
        assert.deepEqual(input.requiredScopes, ['product:read', 'message:send']);
        if (revoked) throw new Error('credential revoked');
        assert.equal(currentAuth.kind, 'owner');
        return currentAuth.auth;
      },
    },
    targets: { async resolveTarget() {
      return { channelId: CHANNEL, conversationId: CONVERSATION, targetBotId: 'bot_jerry',
        targetBotDisplayName: 'Jerry', targetPrincipalId: RESIDENT, residentBinding };
    } },
    messages: {
      async listMessages() { return { messages: [...rows], nextBeforeSequence: null }; },
      async getMessage(input) { return rows.find(row => row.id === input.messageId) ?? null; },
    },
    work: workPort,
    submission: { async submitMessage(input) {
      assertCoordinationId('message', input.body.messageId);
      assertCoordinationId('message', input.body.clientMessageId);
      assertCoordinationId('request', input.context.requestId);
      assertCoordinationId('correlation', input.context.correlationId);
      submissions.push(input);
      const origin = message({ id: input.body.messageId, clientMessageId: input.body.clientMessageId,
        text: input.body.text, sequence: rows.length + 1 });
      rows.push(origin);
      const workId = generateCoordinationId('work');
      works.set(workId, work(workId, origin.id));
      const response = deferred<unknown>();
      responses.push(response);
      return { message: origin, response: response.promise, workId };
    } },
    connect: async input => {
      const provider = { options: input, sent: [] as GptLiveEvent[], closes: 0 };
      providers.push(provider);
      return {
        sessionId: `live_${providers.length}`, answerSdp: 'provider-answer',
        send: event => { provider.sent.push(event); },
        close: async () => { provider.closes++; return { finalized: true, reason: 'close_requested', usageSeconds: 12 }; },
      };
    },
    ...override,
  };
  const services = [createLiveVoiceService(options)];
  t.after(async () => {
    await Promise.all(services.map(service => service.drain()));
    await rm(directory, { recursive: true, force: true });
  });
  const start: LiveVoiceStart = { ...access(), idempotencyKey: 'start-1', sdp: 'offer-1', modelAlias: 'default', reasoningEffort: 'high' };
  return {
    directory, options, service: services[0]!, start, rows, works, submissions, responses, providers, authCalls,
    advance: (milliseconds: number) => { clock += milliseconds; },
    setAccepting: (value: boolean) => { accepting = value; },
    setRevoked: (value: boolean) => { revoked = value; },
    setBinding: (value: string) => { residentBinding = value; },
    setAuth: (value: LiveVoiceAccess) => { currentAuth = value.context.identity; },
    cancellations: () => workCancellations,
    restart: () => { const service = createLiveVoiceService(options); services.push(service); return service; },
    event: async (value: GptLiveEvent) => { await providers[0]!.options.onEvent(value); },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function transcript(f: Fixture, text: string, id = 't1', start = 0, end = 100) {
  await f.event({ type: 'session.input_transcript.delta', event_id: id, delta: text, start_ms: start, end_ms: end });
}
async function delegation(f: Fixture, id = 'd1', offset = 100) {
  // Public protocol supplies delegation metadata, never an authoritative user-task string.
  await f.event({ type: 'session.delegation.created', event_id: `event_${id}`, offset_ms: offset,
    delegation: { id, target: 'client', purpose: 'untrusted metadata is not the request' } });
}
async function admit(f: Fixture, text = 'What is happening at home?', id = 'd1', start = 0) {
  await transcript(f, text, `t_${id}`, start, start + 100);
  await delegation(f, id, start + 100);
  f.advance(200);
  await until(() => f.submissions.length > 0, 'canonical spoken submission');
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.thinking.append'), 'admission receipt');
}
function reply(f: Fixture, index = 0, patch: Partial<MessageProjection> = {}) {
  const origin = f.submissions[index]!;
  const workId = [...f.works.keys()][index]!;
  const targetWork = f.works.get(workId)!;
  targetWork.state = 'succeeded';
  targetWork.terminalReceiptDigest = 'verified-terminal-receipt';
  return message({ id: `msg_${workId.slice(4)}`, kind: 'result', sequence: f.rows.length + 1,
    author: { principalId: RESIDENT, kind: 'bot', displayName: 'Jerry' }, text: 'I checked; the requested task is complete.',
    replyToMessageId: origin.body.messageId, provenance: { workId, roundId: null }, ...patch });
}

test('capability and start enforce current authenticated owner and target membership', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.capability(access()), { available: true, model: 'gpt-live-1' });
  const mismatch = access('other-session');
  await assert.rejects(f.service.start({ ...f.start, ...mismatch }), /voice_owner_mismatch/);
  f.setRevoked(true);
  await assert.rejects(f.service.capability(access()), /credential revoked/);
  await assert.rejects(f.service.start(f.start), /credential revoked/);
  assert.equal(f.providers.length, 0);
  assert.equal(f.submissions.length, 0);
});

test('fragments are ordered and deduplicated; client delegation submits canonical text only once', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await transcript(f, 'the porch light?', 'second', 100, 200);
  await transcript(f, 'Please check ', 'first', 0, 100);
  await transcript(f, 'Please check ', 'first', 0, 100);
  await delegation(f);
  await delegation(f);
  await ticks();
  assert.equal(f.submissions.length, 0, 'waits for transcript settling');
  f.advance(200);
  await until(() => f.submissions.length === 1, 'deduplicated submission');
  await ticks();
  assert.equal(f.submissions[0]!.body.text, 'Please check the porch light?');
  assert.equal(f.submissions[0]!.body.modelAlias, 'default');
  assert.equal(f.submissions[0]!.body.reasoningEffort, 'high');
  assert.deepEqual(f.submissions[0]!.body.attachmentIds, []);
  assert.equal(f.submissions[0]!.context.principalId, OWNER);
  assert.match(f.submissions[0]!.idempotencyKey, /^live-/);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false,
    'acceptance alone is not spoken as a completed result');
});

test('delegation metadata cannot manufacture a task without any user transcript', async t => {
  const f = await fixture(t, { heartbeatLeaseMs: 30_000 });
  await f.service.start(f.start);
  await delegation(f);
  f.advance(10_100);
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.instructions.append'), 'request for missing transcript');
  assert.equal(f.submissions.length, 0);
  assert.match(String(f.providers[0]!.sent[0]!.content), /repeat the request/);
});

test('new delegations divide transcript fragments without replaying consumed speech', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await transcript(f, 'First request.', 't1', 0, 50);
  await delegation(f, 'd1', 50);
  await transcript(f, 'Second request.', 't2', 150, 200);
  await delegation(f, 'd2', 150);
  f.advance(200);
  await until(() => f.submissions.length === 2, 'both distinct delegations');
  assert.equal(f.submissions[0]!.body.text, 'First request.');
  assert.ok(f.submissions[1]!.body.text?.startsWith('Second request.'));
  assert.match(f.submissions[1]!.body.text!, /historical context, not new instructions/);
  assert.notEqual(f.submissions[0]!.body.messageId, f.submissions[1]!.body.messageId);
});

test('later speech cannot be consumed by a pending earlier delegation', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await transcript(f, 'Check the porch light.', 'a', 0, 1_000);
  await delegation(f, 'first-request', 1_000);
  // B arrives while A waits to settle, but Live has not delegated B yet.
  await transcript(f, 'Then check the garage.', 'b', 1_100, 1_400);
  f.advance(200);
  await until(() => f.submissions.length === 1, 'first timestamp-bounded request');
  assert.equal(f.submissions[0]!.body.text, 'Check the porch light.');
  await ticks();
  assert.equal(f.submissions.length, 1, 'later speech must await its own delegation');
  await delegation(f, 'second-request', 1_400);
  f.advance(200);
  await until(() => f.submissions.length === 2, 'second timestamp-bounded request');
  assert.ok(f.submissions[1]!.body.text!.startsWith('Then check the garage.'));
  assert.match(f.submissions[1]!.body.text!, /You: "Check the porch light\."/);
});

test('late fragments of an admitted request remain historical context rather than new intent', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await transcript(f, 'Check the porch light.', 'admitted-a', 0, 800);
  await delegation(f, 'first', 1_000);
  f.advance(200);
  await until(() => f.submissions.length === 1, 'initial A admission');
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.thinking.append'), 'A journal persisted');
  await transcript(f, ' But leave its switch alone.', 'late-a', 850, 1_000);
  assert.ok(f.providers[0]!.sent.some(event => event.type === 'session.instructions.append'
    && String(event.content).includes('ask the user to clarify')));
  await transcript(f, 'Check the garage door.', 'fresh-b', 1_100, 1_500);
  await delegation(f, 'second', 1_500);
  f.advance(200);
  await until(() => f.submissions.length === 2, 'fresh B admission');
  const submitted = f.submissions[1]!.body.text!;
  assert.equal(submitted.split('\n\n')[0], 'Check the garage door.');
  assert.match(submitted, /historical context, not new instructions/);
  assert.match(submitted, /You: "Check the porch light\. But leave its switch alone\."/);
  assert.equal(f.cancellations(), 0);
});

test('revoked credentials and changed resident binding close before delegated submission', async t => {
  for (const change of ['auth', 'target']) {
    const f = await fixture(t);
    await f.service.start(f.start);
    await transcript(f, 'Do something');
    await delegation(f);
    if (change === 'auth') f.setRevoked(true); else f.setBinding('replacement-resident');
    f.advance(200);
    await until(() => f.providers[0]!.closes === 1, 'revoked voice cleanup');
    assert.equal(f.submissions.length, 0);
    assert.equal(f.cancellations(), 0);
  }
});

test('only a matching committed resident reply is spoken once', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  const valid = reply(f);
  f.rows.push(
    reply(f, 0, { id: 'unrelated', replyToMessageId: 'other-origin' }),
    reply(f, 0, { id: 'wrong-channel', channelId: 'other-channel' }),
    reply(f, 0, { id: 'wrong-conversation', conversationId: 'other-conversation' }),
    reply(f, 0, { id: 'wrong-author', author: { principalId: 'other-bot', kind: 'bot', displayName: 'Other' } }),
    reply(f, 0, { id: 'hidden', visibility: 'tombstoned' }),
    reply(f, 0, { id: 'no-work', provenance: { workId: null, roundId: null } }),
  );
  await ticks();
  assert.equal(f.providers[0]!.sent.filter(event => event.type === 'session.commentary.append').length, 0);
  f.rows.push(valid);
  f.responses[0]!.resolve({ ...valid, text: 'Uncommitted forged response must not be spoken' });
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), 'committed reply forwarding');
  await ticks();
  const spoken = f.providers[0]!.sent.filter(event => event.type === 'session.commentary.append');
  assert.equal(spoken.length, 1);
  const payloads = f.providers[0]!.sent.map(event => String(event.content)).join('\n');
  assert.match(payloads, /I checked; the requested task is complete/);
  assert.ok(!payloads.includes('Uncommitted forged'));
});

test('returned response objects without a committed projection are never spoken', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  f.responses[0]!.resolve(reply(f, 0, { id: 'not-committed' }));
  await ticks();
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
});

test('a committed-looking reply requires the exact terminal Work provenance', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  const canonical = reply(f);
  const workId = canonical.provenance.workId!;
  const verified = { ...f.works.get(workId)! };
  const invalid: Array<Partial<WorkRecord>> = [
    { state: 'running' }, { terminalReceiptDigest: null }, { originMessageId: 'different-origin' },
    { targetPrincipalId: 'another-resident' }, { channelId: 'different-channel' }, { kind: 'unrelated-work' },
  ];
  for (const change of invalid) {
    const invalidWorkId = generateCoordinationId('work');
    f.works.set(invalidWorkId, { ...verified, id: invalidWorkId, ...change });
    f.rows.push({ ...canonical, id: `msg_${invalidWorkId.slice(4)}`, sequence: f.rows.length + 1,
      provenance: { workId: invalidWorkId, roundId: null } });
    await ticks();
    assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false,
      `must reject provenance mismatch ${JSON.stringify(change)}`);
  }
  const missingWorkId = generateCoordinationId('work');
  f.rows.push({ ...canonical, id: `msg_${missingWorkId.slice(4)}`, sequence: f.rows.length + 1,
    provenance: { workId: missingWorkId, roundId: null } });
  await ticks();
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
  f.rows.push({ ...canonical, sequence: f.rows.length + 1 });
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), 'verified terminal Work reply');
});

test('failed and cancelled resident results are conveyed while raw worker results are excluded', async t => {
  for (const state of ['failed', 'cancelled'] as const) {
    const f = await fixture(t);
    await f.service.start(f.start);
    await admit(f);
    const outcome = state === 'failed' ? 'The requested action failed. It has not been completed.'
      : 'The requested action was cancelled. It has not been completed.';
    const canonical = reply(f, 0, { text: outcome });
    const reviewedWork = f.works.get(canonical.provenance.workId!)!;
    reviewedWork.state = state;
    reviewedWork.terminalReceiptDigest = null;
    const workerId = generateCoordinationId('work');
    f.works.set(workerId, { ...reviewedWork, id: workerId, state: 'succeeded', kind: 'coding_worker',
      terminalReceiptDigest: 'raw-worker-receipt' });
    f.rows.push({ ...canonical, id: `msg_${workerId.slice(4)}`, text: 'RAW WORKER says everything succeeded.',
      sequence: 2, provenance: { workId: workerId, roundId: null } });
    await ticks();
    assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
    f.rows.push({ ...canonical, sequence: 3 });
    await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), `${state} resident result`);
    const delivered = f.providers[0]!.sent.map(event => String(event.content)).join('\n');
    assert.ok(delivered.includes(outcome));
    assert.ok(!delivered.includes('RAW WORKER'));
  }
});

test('polling catches a resident reply behind more than one hundred newer messages', async t => {
  const f = await fixture(t);
  const pages: Array<number | undefined> = [];
  f.options.messages = { ...f.options.messages, listMessages: async input => {
    const matches = [...f.rows].filter(row => input.beforeSequence === undefined || row.sequence < input.beforeSequence)
      .sort((a, b) => b.sequence - a.sequence);
    const page = matches.slice(0, input.limit);
    pages.push(input.beforeSequence);
    return { messages: page, nextBeforeSequence: matches.length > page.length ? page.at(-1)!.sequence : null };
  } };
  await f.service.start(f.start);
  await admit(f);
  const canonical = reply(f);
  f.rows.push(canonical);
  for (let i = 0; i < 135; i++) f.rows.push(message({ id: `filler_${i}`, sequence: i + 3,
    author: { principalId: 'other-bot', kind: 'bot', displayName: 'Other' }, text: `Other message ${i}` }));
  // Leave the direct response promise unresolved: recovery must come from canonical pagination.
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), 'paginated canonical result');
  assert.ok(pages.some(boundary => boundary !== undefined), 'must traverse the older page');
  assert.equal(f.providers[0]!.sent.filter(event => event.type === 'session.commentary.append').length, 1);
});

test('polling and direct response delivery share one in-flight forwarding owner', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  const canonical = reply(f);
  f.rows.push(canonical);
  const authentication = f.options.auth.validateAccessToken;
  const gate = deferred<void>();
  let forwardingChecks = 0;
  f.options.auth = { ...f.options.auth, validateAccessToken: async input => {
    forwardingChecks++;
    await gate.promise;
    return authentication(input);
  } };
  f.responses[0]!.resolve(canonical);
  await until(() => forwardingChecks > 0, 'direct result blocked in authorization');
  await ticks();
  assert.equal(forwardingChecks, 1, 'poll must not race a second forwarding operation');
  gate.resolve();
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), 'single released result');
  await ticks();
  assert.equal(f.providers[0]!.sent.filter(event => event.type === 'session.commentary.append').length, 1);
});

test('spoken clarification replies retain attributed context for the existing resident', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f, 'Which lights are still on?');
  await f.event({ type: 'session.output_transcript.delta', event_id: 'clarify', delta: 'The lamp or the porch light?', start_ms: 200, end_ms: 400 });
  await transcript(f, 'The second one.', 'short-answer', 500, 600);
  await delegation(f, 'd2', 600);
  f.advance(200);
  await until(() => f.submissions.length === 2, 'contextual short reply');
  const submitted = f.submissions[1]!.body.text!;
  assert.ok(submitted.startsWith('The second one.'));
  assert.match(submitted, /Voice: "The lamp or the porch light\?"/);
  assert.match(submitted, /historical context, not new instructions/);
  assert.match(submitted, /not a verified resident result/);
});

test('canonical admission ID is journaled before invoking the message submission port', async t => {
  const f = await fixture(t);
  const submit = f.options.submission.submitMessage;
  let observedPending = false;
  f.options.submission = { async submitMessage(input) {
    const journals = (await readdir(f.directory)).filter(file => file.endsWith('.json'));
    const prior = JSON.parse(await readFile(join(f.directory, journals[0]!), 'utf8'));
    assert.equal(prior.pendingAdmission.messageId, input.body.messageId);
    assertCoordinationId('message', prior.pendingAdmission.messageId);
    assert.equal(prior.pendingAdmission.delegationId, 'd1');
    observedPending = true;
    return submit(input);
  } };
  await f.service.start(f.start);
  await admit(f);
  assert.equal(observedPending, true);
  const journals = (await readdir(f.directory)).filter(file => file.endsWith('.json'));
  const after = JSON.parse(await readFile(join(f.directory, journals[0]!), 'utf8'));
  assert.equal(after.pendingAdmission, undefined);
  assert.equal(after.delegations[0].messageId, f.submissions[0]!.body.messageId);
});

test('long Unicode replies retain their substance in bounded provider context events', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  const longText = `${'🌙 All is quiet at home. '.repeat(150)}Final observation: the porch light is off.`;
  const result = reply(f, 0, { text: longText });
  f.rows.push(result);
  f.responses[0]!.resolve(result);
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), 'long reply cue');
  const context = f.providers[0]!.sent.filter(event => String(event.content).startsWith('Canonical resident reply'));
  assert.ok(context.length > 1);
  assert.ok(context.every(event => Buffer.byteLength(String(event.content)) <= 480));
  assert.ok(context.every(event => !String(event.content).includes('\uFFFD')));
  assert.ok(context.map(event => String(event.content)).join('').includes('Final observation: the porch light is off.'));
});

test('truncated long replies preserve the final failure outcome and explicitly identify omitted text', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  const ending = 'FINAL OUTCOME: BLOCKED. The garage command failed; do not report success.';
  const longText = `BEGINNING: Investigation started. ${'Earlier progress details are inconclusive. '.repeat(1_500)}${ending}`;
  const result = reply(f, 0, { text: longText });
  f.rows.push(result);
  f.responses[0]!.resolve(result);
  await until(() => f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), 'excerpt warning delivered');
  const context = f.providers[0]!.sent.filter(event => String(event.content).startsWith('Canonical resident reply'));
  assert.equal(context.length, 60);
  assert.ok(context.every(event => Buffer.byteLength(String(event.content)) <= 480));
  const excerpts = context.map(event => String(event.content).replace(/^Canonical resident reply [^,]+, part \d+: /, '')).join('');
  assert.ok(excerpts.startsWith('BEGINNING: Investigation started.'));
  assert.ok(excerpts.endsWith(ending));
  assert.match(excerpts, /Middle omitted: these are excerpts, not the complete reply/);
  const cue = f.providers[0]!.sent.find(event => event.type === 'session.commentary.append')!;
  assert.match(String(cue.content), /do not infer an overall outcome from excerpts/);
  assert.match(String(cue.content), /complete reply is in the conversation/);
});

test('start replay creates one session, rejects changed SDP, and expires after close', async t => {
  const f = await fixture(t);
  const [first, replay] = await Promise.all([f.service.start(f.start), f.service.start(f.start)]);
  assert.deepEqual(replay, first);
  assert.equal(f.providers.length, 1);
  await assert.rejects(f.service.start({ ...f.start, sdp: 'different offer' }), /idempotency_conflict/);
  await assert.rejects(f.service.start({ ...f.start, idempotencyKey: 'another-start' }), /voice_session_already_active/);
  const close = await f.service.close({ ...access(), sessionId: first.sessionId });
  assert.equal(close.finalized, true);
  await assert.rejects(f.service.start(f.start), /voice_start_expired/);
  assert.equal(f.providers.length, 1);
});

test('uncertain provider creation has a durable replay barrier across service restart', async t => {
  let attempts = 0;
  const f = await fixture(t, { connect: async () => { attempts++; throw new Error('creation response lost'); } });
  await assert.rejects(f.service.start(f.start), /creation response lost/);
  await assert.rejects(f.service.start(f.start), /creation response lost/);
  assert.equal(attempts, 1);
  await assert.rejects(f.restart().start(f.start), /voice_start_expired/);
  assert.equal(attempts, 1);
  const files = await readdir(f.directory);
  assert.equal(files.length, 1);
  const persisted = await readFile(join(f.directory, files[0]!), 'utf8');
  assert.equal(JSON.parse(persisted).state, 'starting');
  for (const secret of [ACCESS_TOKEN, 'private-test-openai-key', 'offer-1']) assert.ok(!persisted.includes(secret));
});

test('fresh same-device heartbeat replaces successor auth before further delegation', async t => {
  const f = await fixture(t);
  const live = await f.service.start(f.start);
  const successor = access('auth_2', 'successor-access-token');
  f.setAuth(successor);
  f.advance(5_000);
  assert.deepEqual(await f.service.heartbeat({ ...successor, sessionId: live.sessionId }), { sessionId: live.sessionId, active: true });
  await admit(f);
  assert.equal(f.authCalls.at(-1), 'successor-access-token');
  assert.equal(f.submissions[0]!.context.identity.kind, 'owner');
  if (f.submissions[0]!.context.identity.kind === 'owner') {
    assert.equal(f.submissions[0]!.context.identity.auth.sessionId, 'auth_2');
  }
});

test('wrong device cannot heartbeat or close another active voice session', async t => {
  const f = await fixture(t);
  const live = await f.service.start(f.start);
  const other = access();
  if (other.context.identity.kind === 'owner') other.context.identity.auth.deviceId = 'other-device';
  for (const operation of [f.service.heartbeat, f.service.close]) {
    await assert.rejects(operation({ ...other, sessionId: live.sessionId }), error => error instanceof LiveVoiceError && error.httpStatus === 404);
  }
  assert.equal(f.providers[0]!.closes, 0);
});

test('heartbeat expiry, maximum duration and server drain each close audio without cancelling Work', async t => {
  for (const stop of ['lease', 'duration', 'draining']) {
    const f = await fixture(t, { heartbeatLeaseMs: stop === 'duration' ? 60_000 : 10_000, maximumDurationMs: 20_000 });
    await f.service.start(f.start);
    await admit(f);
    if (stop === 'draining') f.setAccepting(false);
    else f.advance(stop === 'duration' ? 20_001 : 10_001);
    await until(() => f.providers[0]!.closes === 1, `${stop} cleanup`);
    assert.equal(f.cancellations(), 0);
    assert.equal([...f.works.values()][0]!.state, 'running');
  }
});

test('explicit close leaves Work alive and suppresses late resident speech', async t => {
  const f = await fixture(t);
  const live = await f.service.start(f.start);
  await admit(f);
  await f.service.close({ ...access(), sessionId: live.sessionId });
  assert.equal(f.cancellations(), 0);
  assert.equal([...f.works.values()][0]!.state, 'running');
  const result = reply(f);
  f.rows.push(result);
  f.responses[0]!.resolve(result);
  await ticks();
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
  assert.equal(f.providers[0]!.closes, 1);
});

test('later typed owner message keeps an older result as quiet context', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  f.rows.push(message({ id: 'typed-correction', sequence: 2, text: 'Actually leave it alone.' }));
  const result = reply(f);
  f.rows.push(result);
  f.responses[0]!.resolve(result);
  await until(() => f.providers[0]!.sent.some(event => String(event.content).startsWith('Earlier request result')), 'quiet superseded result');
  const forwarded = f.providers[0]!.sent.find(event => String(event.content).startsWith('Earlier request result'))!;
  assert.equal(forwarded.type, 'session.thinking.append');
  assert.match(String(forwarded.content), /[Dd]o not interrupt/);
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
});

test('later spoken delegation suppresses obsolete speech before its next request is admitted', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  await delegation(f, 'correction', 250);
  const result = reply(f);
  f.rows.push(result);
  f.responses[0]!.resolve(result);
  await until(() => f.providers[0]!.sent.some(event => String(event.content).startsWith('Earlier request result')), 'quiet late spoken result');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
});

test('a late rejected resident response does not interrupt a newer spoken request', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  await delegation(f, 'new-request', 500);
  f.responses[0]!.reject(new Error('old resident request failed'));
  await ticks();
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
});

test('authorization revoked before a resident response closes voice without speaking the result', async t => {
  const f = await fixture(t);
  await f.service.start(f.start);
  await admit(f);
  const result = reply(f);
  f.rows.push(result);
  f.setRevoked(true);
  f.responses[0]!.resolve(result);
  await until(() => f.providers[0]!.closes === 1, 'revoked reply cleanup');
  assert.equal(f.providers[0]!.sent.some(event => event.type === 'session.commentary.append'), false);
  assert.equal(f.cancellations(), 0);
});
