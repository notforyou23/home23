import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentLoop } from '../../../src/agent/loop.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { startResidentCoordinationHarness } from '../../../src/coordination-adapter/index.js';
import { createCoordinationProcess, disabledCoordinationFeatureFlags } from '../../../src/coordination/app/index.js';
import { provisionFreshHouse } from '../../../src/coordination/operations/index.js';
import { openCoordinationDatabase } from '../../../src/coordination/db/index.js';
import { createResidentCredential } from '../../../src/coordination/resident-protocol/index.js';
import { ResidentUdsClient } from '../../../src/coordination/transport/uds/index.js';
import type { ResidentInitiation } from '../../../src/coordination/app/resident-initiations.js';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const until = async (predicate: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(label);
};

/** Real signed ingress, exclusive Core writer, durable AgentLoop turn, ordinary
 * Work/Stop routes and restart. All provider traffic stays on local fixture. */
for (const crashDuringRun of [false, true]) test(`primary resident initiative survives ${crashDuringRun ? 'a killed Core during execution' : 'lost acknowledgement and completed restart'} and obeys ordinary owner Stop`, { timeout: 25_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'h23-initiate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'coordination'); const workspacePath = join(root, 'workspace'); mkdirSync(runtime); mkdirSync(workspacePath);
  const held: Array<import('node:http').ServerResponse> = [];
  let calls = 0; let lastInput = '';
  const model = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    lastInput = body; calls++; held.push(response);
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => { model.closeAllConnections(); return new Promise<void>(resolve => model.close(() => resolve())); });
  const prior = { HOME23_ROOT: process.env.HOME23_ROOT, HOME23_AGENT: process.env.HOME23_AGENT, LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL };
  process.env.HOME23_ROOT = root; process.env.HOME23_AGENT = 'milo'; process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  t.after(() => { for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const databasePath = join(runtime, 'house.sqlite3'); const coordinatorSocket = join(runtime, 'c.sock'); const residentSocket = join(root, 'm.sock');
  const home = { id: 'home_0198d95f-6c00-7000-8000-000000000001', name: 'Fixture Home' };
  const birth = await provisionFreshHouse({ databasePath, home, resident: { slug: 'milo', name: 'Milo', purpose: 'Carry useful interests forward.' } });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'milo');
  const agent = new AgentLoop({ apiKey: 'fixture', model: 'fixture-local-model', provider: 'ollama-local',
    registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined, execute: async () => ({ content: '' }) } as never,
    contextManager: { getSystemPrompt: () => 'You are Milo.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: { brainOperations: { searchContext: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }) } } as never, workspacePath });
  const key = 'b'.repeat(64);
  const harness = await startResidentCoordinationHarness({ agent, history, environment: { HOME23_ROOT: root, HOME23_AGENT: 'milo',
    HOME23_COORDINATION_RESIDENT_ENABLED: 'true', HOME23_COORDINATION_RESIDENT_SOCKET_PATH: residentSocket,
    HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID: 'home23-milo-harness', HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID: 'home23-milo-harness',
    HOME23_COORDINATION_RESIDENT_KEY_VERSION: '1', HOME23_COORDINATION_RESIDENT_KEY: key, HOME23_COORDINATION_SOCKET_PATH: coordinatorSocket } });
  assert.ok(harness); t.after(() => harness.close());
  const config = { enabled: true, host: '127.0.0.1' as const, port: 0, databasePath, socketPath: coordinatorSocket,
    botRootDirectory: join(root, 'bots'), capabilityToken: 'c'.repeat(64), home: { ...home, primaryResident: 'milo' },
    flags: { ...disabledCoordinationFeatureFlags(), 'coordination.process.enabled': true, 'coordination.public_api.enabled': true },
    residents: { milo: { enabled: true, socketPath: residentSocket, serverInstanceId: 'home23-milo-harness', clientInstanceId: 'home23-milo-harness', keyVersion: 1, key } } };
  const makeCore = () => {
    if (!crashDuringRun) return { ...createCoordinationProcess(config), crash: async () => assert.fail('in-process fixture cannot crash'), diagnostics: () => '' };
    let child: ChildProcess | undefined; let output = '';
    return {
      start: () => new Promise<{ host: string; port: number; origin: string }>((resolve, reject) => {
        child = fork(fileURLToPath(new URL('./fixtures/resident-initiations-core.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.stdout?.on('data', data => { output += data; }); child.stderr?.on('data', data => { output += data; });
        child.on('message', (message: any) => { if (message.type === 'ready') resolve(message.address); if (message.type === 'error') reject(new Error(message.error)); });
        child.on('exit', code => { if (code !== 0 && code !== null) reject(new Error(`Core fixture exited ${code}: ${output}`)); });
        child.send({ operation: 'start', config });
      }),
      drain: () => !child || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => { child!.once('exit', () => resolve()); child!.send({ operation: 'drain' }); }),
      crash: () => new Promise<void>(resolve => { child!.once('exit', () => resolve()); child!.kill('SIGKILL'); }),
      diagnostics: () => `Core exit=${child?.exitCode} signal=${child?.signalCode}: ${output}`,
    };
  };
  let core = makeCore(); t.after(() => core.drain()); let address = await core.start();
  const post = async (path: string, body: unknown, idempotencyKey: string, token?: string) => {
    const response = await fetch(`${address.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const value = await response.json() as any; assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value;
  };
  const pairing = await post('/api/v1/pairing/sessions', { deviceName: 'Fixture phone' }, 'initiative-pairing-session');
  const paired = await post(`/api/v1/pairing/sessions/${pairing.pairingSession.id}/redeem`, { pairingCode: pairing.pairingCode,
    device: { name: 'Fixture phone', platform: 'ios', appBuild: '196' } }, 'initiative-redeem-session');
  const read = async (path: string) => {
    try { const response = await fetch(`${address.origin}${path}`, { headers: { authorization: `Bearer ${paired.accessToken}`, connection: 'close' } }); assert.equal(response.status, 200); return response.json() as Promise<any>; }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; ${core.diagnostics()}`, { cause: error }); }
  };
  const input: ResidentInitiation = { initiationId: 'fixture-move', pursuitId: 'fixture-interest', snapshotDigest: 'a'.repeat(64), purpose: 'exploration',
    nextMove: 'Find a useful connection in the saved guitar notes.', stopCondition: 'Stop after one supported connection.', evidenceRefs: ['conversation:guitar'], timeoutMs: 120_000 };
  assert.deepEqual(await harness.residentInitiationStatus({ initiationId: input.initiationId }), { initiationId: input.initiationId, state: 'not_admitted' });
  assert.equal((await read('/api/v1/work')).works.length, 0); assert.equal(calls, 0);
  const first = await harness.initiateResidentTurn(input) as { workId: string; state: string };
  assert.ok(first.workId); await until(async () => calls === 1, 'local provider received the initiative');
  const observed = await harness.residentInitiationStatus({ initiationId: input.initiationId }) as any;
  assert.equal(observed.workId, first.workId); assert.equal(observed.state, 'running'); assert.equal(calls, 1);
  assert.match(lastInput, /INTERNAL RESIDENT INITIATIVE/);
  const busy = await harness.initiateResidentTurn({ ...input, initiationId: 'another' }) as any; assert.equal(busy.state, 'deferred');
  const projected = (await read('/api/v1/work')).works[0]; assert.equal(projected.id, first.workId); assert.equal(projected.origin, 'resident_initiative');
  assert.equal(projected.assignmentState, undefined); assert.equal(projected.cancelAvailable, true);
  const conversations = (await read(`/api/v1/channels/${birth.channelId}/messages`)).messages;
  const origin = conversations.find((message: any) => message.id === projected.originMessageId); assert.equal(origin.author.principalId, birth.botId); assert.equal(origin.text, input.nextMove);
  const wrong = new ResidentUdsClient({ socketPath: coordinatorSocket, serverInstanceId: 'home23-coordination', credential: createResidentCredential({ residentSlug: 'milo', role: 'resident', instanceId: 'stale', keyVersion: 1, rootKey: Buffer.from(key, 'hex') }) });
  t.after(() => wrong.close());
  await assert.rejects(wrong.request({ method: 'POST', path: '/internal/v1/resident-initiations', payload: JSON.parse(JSON.stringify(input)), fence: null, deadlineAtMs: Date.now() + 1000 }));
  if (crashDuringRun) {
    await core.crash(); core = makeCore(); address = await core.start();
    const reattached = await harness.initiateResidentTurn(input) as any;
    assert.equal(reattached.workId, first.workId); assert.equal(calls, 1);
  }
  held[0]!.writeHead(200, { 'content-type': 'application/json' }); held[0]!.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The guitar notes support a useful connection.' } }] }));
  await until(async () => (await read(`/api/v1/work/${first.workId}`)).work.state === 'succeeded', 'initiative completed with durable result');
  assert.equal(calls, 1); await core.drain(); core = makeCore(); address = await core.start();
  const replay = await harness.initiateResidentTurn(input) as any; assert.equal(replay.workId, first.workId); assert.equal(replay.state, 'succeeded'); assert.equal(calls, 1);
  assert.equal((await harness.initiateResidentTurn({ ...input, initiationId: 'stopped' }) as any).state, 'deferred');
  await until(async () => calls === 2, 'saved initiative outcome reached its separate canonical review');
  assert.match(lastInput, /INTERNAL RESIDENT INITIATIVE OUTCOME/);
  const messagesBeforeReview = (await read(`/api/v1/channels/${birth.channelId}/messages`)).messages.length;
  held[1]!.writeHead(200, { 'content-type': 'application/json' }); held[1]!.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: crashDuringRun ? '' : 'I checked the useful connection.' } }] }));
  if (!crashDuringRun) await until(async () => (await read(`/api/v1/channels/${birth.channelId}/messages`)).messages.some((message: any) => message.text === 'I checked the useful connection.'), 'review delivered its separate result');
  await new Promise(resolve => setTimeout(resolve, 2100)); // Core's ordinary outcome tick settles the delivered review.
  if (crashDuringRun) {
    assert.equal((await read(`/api/v1/channels/${birth.channelId}/messages`)).messages.length, messagesBeforeReview, 'actual AgentLoop empty normalization produces a private disposition and no second DM');
    await core.drain(); core = makeCore(); address = await core.start();
    assert.equal((await harness.initiateResidentTurn(input) as any).workId, first.workId); assert.equal(calls, 2);
  }
  const stopped = await harness.initiateResidentTurn({ ...input, initiationId: 'stopped' }) as any;
  await until(async () => calls === 3, 'second bounded initiative started');
  await post(`/api/v1/work/${stopped.workId}/cancel`, {}, 'initiative-owner-stop', paired.accessToken);
  await until(async () => (await read(`/api/v1/work/${stopped.workId}`)).work.state === 'cancelled', 'ordinary owner Stop became terminal');
  assert.equal((await harness.initiateResidentTurn({ ...input, initiationId: 'stopped' }) as any).state, 'cancelled'); assert.equal(calls, 3);
  assert.equal((await harness.residentInitiationStatus({ initiationId: 'stopped' }) as any).state, 'cancelled'); assert.equal(calls, 3);
  await core.drain();
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works WHERE kind='resident_turn'")!.count, 3);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE aggregate_kind='resident_initiation_work' AND aggregate_version=1")!.count, 2);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE aggregate_kind='resident_outcome' AND json_extract(payload_json,'$.ownerContactDisposition')='no_owner_update'")!.count, crashDuringRun ? 1 : 0);
    if (crashDuringRun) {
      assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE aggregate_kind='communication' AND json_extract(payload_json,'$.communication.kind')='assistant_response_delta' AND json_extract(payload_json,'$.communication.payload.delta')='(no response)'")!.count, 0);
      assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE aggregate_kind='communication' AND json_extract(payload_json,'$.communication.payload.syntheticEmptyAnswerSuppressed')=1 AND json_extract(payload_json,'$.communication.kind')='receipt'")!.count, 1);
    }
  } finally { database.close(); }
});
