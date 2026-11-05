/** Actual exclusive coordinator DB owner + separate resident processes; deterministic local model and held external-effect tool. */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapJerry } from '../../../src/coordination/operations/index.js';
import { openCoordinationDatabase } from '../../../src/coordination/db/index.js';
import { createBotDirectory, SqliteBotDirectoryRepository } from '../../../src/coordination/bots/index.js';
import { createChannelService, SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from '../../../src/coordination/channels/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { createWorkService, createProductWorkControl, M11MessageProvenanceAuthority } from '../../../src/coordination/work/index.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { SqliteCommunicationEventRepository } from '../../../src/coordination/communications/index.js';
import { generateCoordinationId } from '../../../src/coordination/ids/index.js';
import { ResidentCoordinationAdapter, ResidentUdsAgentPort, createM11ResidentCoordinationPort } from '../../../src/coordination-adapter/index.js';
import { createResidentCredential, ResidentProtocolError, type JsonValue } from '../../../src/coordination/resident-protocol/index.js';
import { ResidentUdsClient, ResidentUdsServer } from '../../../src/coordination/transport/uds/index.js';
import { createDirectMessageSubmissionService, SqliteDirectMessageContext } from '../../../src/coordination/app/index.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkingThreadStop } from '../../../src/coordination/app/working-thread-stop.js';
import { residentFence } from '../../../src/coordination-adapter/resident-uds.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';

const ids = () => ({ requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') });
const authority = { capability: 'messages' as const, epoch: 2, mode: 'canonical' as const, writer: 'home23-coordination', effectiveAtEventSequence: 1, rollbackEpoch: 1 };
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 1200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail(label);
}

test('exclusive coordinator admits and executes exact Working Threads across separate Jerry and Forrest harnesses', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wt-mp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'coord.sqlite');
  const seeded = await bootstrapJerry({ databasePath: dbPath, apply: true, serverInstanceId: 'resident-jerry', keyVersion: 1,
    authority: { approved: true, kind: 'm14-bootstrap', operator: 'user_owner', resident: 'jerry', legacyWriterAuthoritative: true, coordinationFlagsAllFalse: true } });
  let database = openCoordinationDatabase({ path: dbPath });
  t.after(() => database.close());
  assert.equal(database.pragmaEvidence().lockingMode, 'exclusive');
  const botRepo = new SqliteBotDirectoryRepository(database);
  const directory = createBotDirectory({ repository: botRepo, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 } });
  const forrest = await directory.ensurePersistentBinding({ residentBinding: 'forrest', name: 'Forrest', purpose: 'Distinct resident', continuingIdentity: true, durableMailbox: true, requiredCapabilities: ['messages'], aliases: [{ namespace: 'name', value: 'Forrest' }] }, { principalId: 'user_owner', ...ids() });
  await directory.registerResident({ context: { ...ids(), credential: { residentSlug: 'forrest', role: 'resident', instanceId: 'resident-forrest', keyVersion: 1 } }, botBinding: 'forrest', protocolVersion: 1, capabilities: ['messages'] });
  const participants = { listVisibleBots: directory.listVisibleBots, resolveAlias: directory.resolveAlias, getBotByResidentBinding: (slug: string) => botRepo.getBotByResidentBinding(slug) };
  const messaging = new SqliteMessagingRepository(database, { botConversationBinding: new SqliteBotConversationBindingAdapter(), messageProvenanceAuthorization: new M11MessageProvenanceAuthority() });
  let messages = createMessageService({ repository: messaging, participantDirectory: participants });
  const channels = createChannelService({ repository: messaging, participantDirectory: participants, cursorSigningKey: Buffer.alloc(32, 1) });
  const owner = () => ({ principalId: 'user_owner', ...ids(), identity: { kind: 'owner' as const, auth: { principalId: 'user_owner' as const, deviceId: generateCoordinationId('device'), sessionId: generateCoordinationId('clientSession'), scopes: ['product:read', 'message:send'] as const } } });
  const fd = await channels.createDirectConversation({ context: owner(), memberBotIds: [forrest.id], pinned: false, idempotencyKey: 'multiprocess-forrest-direct' });
  let work = createWorkService({ database, generateId: generateCoordinationId });
  let leases = createLeaseService({ database, generateId: generateCoordinationId, leaseTtlMs: 60_000 });
  let communications = new SqliteCommunicationEventRepository(database);
  const credentials = ['jerry','forrest'].map((slug, i) => createResidentCredential({ rootKey: Buffer.alloc(32, 0x51 + i), residentSlug: slug, role: 'resident', instanceId: `coordinator-${slug}`, keyVersion: 1 }));
  const children: Array<{ slug: string; child: ChildProcess; events: any[]; output: string }> = [];
  const targets = new Map<string, any>();
  const clients: ResidentUdsClient[] = [];
  for (const [i, slug] of ['jerry','forrest'].entries()) {
    const residentRoot = join(root, slug); mkdirSync(residentRoot);
    const env = { ...process.env, HOME23_AGENT: slug, TEST_RESIDENT_ROOT: residentRoot,
      HOME23_COORDINATION_RESIDENT_ENABLED: 'true', HOME23_COORDINATION_RESIDENT_SOCKET_PATH: join(root, `${slug}.sock`),
      HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID: `resident-${slug}`, HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID: `coordinator-${slug}`,
      HOME23_COORDINATION_RESIDENT_KEY_VERSION: '1', HOME23_COORDINATION_RESIDENT_KEY: Buffer.alloc(32, 0x51 + i).toString('hex'),
      HOME23_COORDINATION_SOCKET_PATH: join(root, 'coord.sock'), HOME23_COORDINATION_SERVER_INSTANCE_ID: 'home23-coordination' };
    delete env.HOME23_COORDINATION_DB_PATH; delete env.HOME23_COORDINATION_CAPABILITY_TOKEN;
    const child = fork(new URL('./fixtures/foreground-detachment-resident.ts', import.meta.url), [], { env, execArgv: ['--import','tsx'], stdio: ['ignore','pipe','pipe','ipc'] });
    const row = { slug, child, events: [] as any[], output: '' }; children.push(row);
    t.after(() => { if (row.output.includes("threw:")) t.diagnostic(`${slug} resident: ${row.output} events=${JSON.stringify(row.events)}`); });
    child.on('message', event => row.events.push(event));
    child.stdout!.on('data', data => { row.output += data; }); child.stderr!.on('data', data => { row.output += data; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.send({ type: 'close' }); await Promise.race([new Promise(r => child.once('exit',r)), new Promise(r => setTimeout(r, 2000))]); if (child.exitCode === null) child.kill('SIGKILL'); } });
    await until(() => row.events.some(e => e.type === 'ready') || child.exitCode !== null, `${slug} ready: ${row.output}`);
    assert.equal(child.exitCode, null, row.output); assert.notEqual(child.pid, process.pid);
    const client = new ResidentUdsClient({ socketPath: join(root, `${slug}.sock`), serverInstanceId: `resident-${slug}`, credential: credentials[i]! });
    clients.push(client); t.after(() => client.close());
    const port = new ResidentUdsAgentPort({ client, residentSlug: slug });
    const resident = new ResidentCoordinationAdapter(port, createM11ResidentCoordinationPort(leases), () => new Date(), communications);
    targets.set(slug, { resident, holderInstanceId: `resident-${slug}`, models: port,
      context: ({ principalId, requestId, correlationId }: any) => ({ principalId, requestId, correlationId, identity: { kind: 'resident', resident: { requestId, correlationId, credential: { residentSlug: slug, role: 'resident', instanceId: `resident-${slug}`, keyVersion: 1 } } } }) });
  }
  const makeService = () => createDirectMessageSubmissionService({ messages, context: new SqliteDirectMessageContext(database, messages), work, leases, communications,
    resolveResident: slug => targets.get(slug), authority: { current: () => authority }, beginWork: () => () => {}, recoveryIdentity: ids });
  let service = makeService();
  let holdScheduling = false;
  const scheduledErrors: unknown[] = [];
  const makeAdmission = () => createForegroundDetachmentConsumer({ database, work, resolveResident: slug => ({clientInstanceId:`coordinator-${slug}`,serverInstanceId:`resident-${slug}`,keyVersion:1}), schedule: workId => { if (holdScheduling) return; void service.dispatchWorkingThread(workId).catch(error => scheduledErrors.push(error)); } });
  let admission = makeAdmission();
  let firstRequest: unknown;
  let dropResponse = true;
  const makeIngress = () => new ResidentUdsServer({ socketPath: join(root, 'coord.sock'), serverInstanceId: 'home23-coordination', credentials,
    validateFence: (fence, request) => { const payload = request.payload as any; return fence === residentFence(payload.parentOrigin ?? payload.origin); },
    handleRequest: (request, context) => {
      if (request.path.endsWith('/start')) {
        const payload = request.payload as unknown as { origin: CoordinationTurnOrigin; invocationId: string };
        const started = admission.start({ credential: context.credential, ...payload });
        return { accepted: started.started, workId: payload.origin.workId, invocationId: payload.invocationId };
      }
      firstRequest ??= request.payload;
      let ack; try { ack = admission.admit({ credential: context.credential, request: request.payload }); } catch(error) { scheduledErrors.push(error); throw error; }
      // Committed admission with a response lost before delivery; the real client retries the signed operation.
      if (dropResponse) { dropResponse = false; throw new ResidentProtocolError('connection_lost', 'simulated lost response after commit', { retryable: true }); }
      return ack as unknown as JsonValue;
    } });
  let ingress = makeIngress();
  await ingress.start(); t.after(() => ingress.close());
  const submit = (channelId: string, text: string) => service.submitMessage({ context: owner(), channelId, idempotencyKey: `multi-${generateCoordinationId('message')}`,
    body: { messageId: generateCoordinationId('message'), clientMessageId: generateCoordinationId('message'), text, attachmentIds: [], mentions: [], replyToMessageId: null, modelAlias: null, reasoningEffort: null } });
  const resultCount = (workId: string) => database.readOne<{count:number}>("SELECT count(*) AS count FROM messages WHERE kind='result' AND work_id=?", workId)?.count ?? 0;
  for (const [slug, channelId] of [['jerry', seeded.channelId!], ['forrest', fd.channel.id]]) {
    const row = children.find(c => c.slug === slug)!;
    const speaking = await submit(channelId!, 'Run substantial-one in a separate Working Thread.');
    await until(() => row.events.some(e => e.type === 'executed') || scheduledErrors.length > 0, `${slug} exact invocation: ${row.output}`);
    assert.deepEqual(scheduledErrors, [], row.output);
    const execution = row.events.find(e => e.type === 'executed'); assert.ok(execution, row.output);
    const childWorkId = execution.destination.parentWorkId;
    assert.deepEqual(execution.args, { task: 'substantial-one', sentinel: `${slug}-exact-arguments` });
    const assignment = work.getPlannedInvocation(childWorkId)!;
    assert.equal(assignment.parentOrigin.workId, speaking.work.id);
    assert.equal(assignment.residentSlug, slug);
    assert.equal(work.get(childWorkId)?.state, 'running');
    assert.ok(work.getInvocationExecution(childWorkId)?.startedAt);
    const second = await submit(channelId!, 'What day is it?');
    await until(() => resultCount(second.work.id) === 1, `${slug} independent conversation answer: ${row.output}`);
    assert.equal(work.get(childWorkId)?.state, 'running');
    assert.equal(resultCount(childWorkId), 0);
    if (slug === 'jerry') {
      const replay = admission.admit({ credential: credentials[0]!, request: firstRequest });
      assert.equal(replay.workId, childWorkId);
      assert.throws(() => admission.admit({ credential: credentials[0]!, request: { ...(firstRequest as any), canonicalArgs: { task: 'changed' } } }), /replay changed/);
    }
    const secondAssignment = await submit(channelId!, 'Run substantial-two in a separate Working Thread.');
    await until(() => row.events.filter(e => e.type === 'executed').length === 2, `${slug} second parallel assignment`);
    const secondExecution = row.events.filter(e => e.type === 'executed')[1];
    const cancelWorkId = secondExecution.destination.parentWorkId;
    assert.notEqual(cancelWorkId, childWorkId);
    assert.equal(work.getPlannedInvocation(cancelWorkId)?.parentOrigin.workId, secondAssignment.work.id);
    assert.equal(work.get(childWorkId)?.state, 'running');
    const control = createProductWorkControl({ database, work, leases });
    const cancelInput = { context: owner(), workId: cancelWorkId, idempotencyKey: `cancel-${cancelWorkId}` };
    assert.equal(control.cancel(cancelInput).outcome, 'cancellation_requested');
    const stop = createWorkingThreadStop({ database, work, leases,
      // Forrest exercises restart-style recovery with no process-local active adapter map.
      residentAdapters: slug === 'forrest' ? new Map() : new Map([[slug, targets.get(slug).resident]]),
      residentAgents: new Map([[slug, targets.get(slug).models]]), awaitSettlement: service.awaitSettlement });
    await stop(cancelWorkId, ids());
    await service.awaitSettlement(cancelWorkId);
    await until(() => work.get(cancelWorkId)?.state === 'cancelled', `${slug} actual executor cancellation`);
    await until(() => row.events.some(e => e.type === 'aborted' && e.task === 'substantial-two'), `${slug} remote abort receipt`);
    assert.equal(control.cancel(cancelInput).replayed, true);
    assert.equal(resultCount(cancelWorkId), 0, 'cancellation machinery does not become a Chat message');
    row.child.send({ type: 'release', task: 'substantial-one' });
    await until(() => resultCount(childWorkId) === 1 || work.get(childWorkId)?.state === 'failed', `${slug} terminal result: ${row.output}`);
    assert.equal(work.get(childWorkId)?.state, 'succeeded', row.output);
    assert.equal(resultCount(childWorkId), 1);
    const activityKinds = database.readAll<{kind:string}>(`SELECT json_extract(payload_json, '$.communication.kind') AS kind FROM events
      WHERE type='communication.recorded' AND json_extract(payload_json, '$.communication.workId')=?`, childWorkId).map(event => event.kind);
    for (const kind of ['reasoning', 'tool_call_started', 'tool_call_completed', 'subagent_started', 'subagent_completed']) {
      assert.ok(activityKinds.includes(kind), `${slug} durable Work activity missing ${kind}: ${activityKinds.join(',')}`);
    }
    await service.dispatchWorkingThread(childWorkId); await service.awaitSettlement(childWorkId);
    assert.equal(resultCount(childWorkId), 1);
    assert.equal(row.events.filter(e => e.type === 'executed' && e.args.task === 'substantial-one').length, 1, 'selected invocation executes once despite admission/result replay');
  }
  // A full coordinator-owner generation closes and reopens its real database;
  // resident processes survive and receive no authority/database path.
  const rebuildCoordinatorServices = () => {
    const repo = new SqliteBotDirectoryRepository(database);
    const dir = createBotDirectory({ repository: repo, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 } });
    messages = createMessageService({ repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(), messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    }), participantDirectory: { listVisibleBots: dir.listVisibleBots, resolveAlias: dir.resolveAlias, getBotByResidentBinding: slug => repo.getBotByResidentBinding(slug) } });
    work = createWorkService({ database, generateId: generateCoordinationId });
    leases = createLeaseService({ database, generateId: generateCoordinationId, leaseTtlMs: 60_000 });
    communications = new SqliteCommunicationEventRepository(database);
    for (const target of targets.values()) target.resident = new ResidentCoordinationAdapter(target.models, createM11ResidentCoordinationPort(leases), () => new Date(), communications);
    service = makeService(); admission = makeAdmission(); ingress = makeIngress();
  };
  const jerry = children.find(c => c.slug === 'jerry')!;
  holdScheduling = true;
  const queuedSpeaking = await submit(seeded.channelId!, 'Run substantial-queued in a separate Working Thread.');
  await until(() => resultCount(queuedSpeaking.work.id) === 1, 'speaking acknowledgment completes while child remains queued');
  const queuedRow = database.readOne<{id:string}>("SELECT id FROM works WHERE kind='resident_work_thread' AND origin_message_id=?", queuedSpeaking.message.id)!;
  const queued = work.get(queuedRow.id)!;
  assert.ok(queued); assert.equal(work.getInvocationExecution(queued.id), null);
  assert.equal(jerry.events.filter(e => e.type === 'executed' && e.args.task === 'substantial-queued').length, 0);
  await service.awaitSettlement(queuedSpeaking.work.id);
  await ingress.close(); database.close();
  database = openCoordinationDatabase({ path: dbPath });
  assert.equal(database.pragmaEvidence().lockingMode, 'exclusive');
  rebuildCoordinatorServices(); holdScheduling = false;
  await ingress.start();
  const recovered = await service.recoverResidentWork();
  assert.ok(recovered.scheduled >= 1);
  await until(() => jerry.events.some(e => e.type === 'executed' && e.args.task === 'substantial-queued'), 'closed-owner restart executes queued invocation');
  jerry.child.send({ type: 'release', task: 'substantial-queued' });
  await until(() => resultCount(queued.id) === 1, 'recovered queued invocation settles once');
  assert.equal(jerry.events.filter(e => e.type === 'executed' && e.args.task === 'substantial-queued').length, 1);

  const uncertainSpeaking = await submit(seeded.channelId!, 'Run substantial-uncertain in a separate Working Thread.');
  await until(() => jerry.events.some(e => e.type === 'executed' && e.args.task === 'substantial-uncertain'), 'uncertain invocation durably starts');
  const uncertainExecution = jerry.events.find(e => e.type === 'executed' && e.args.task === 'substantial-uncertain');
  const uncertainId = uncertainExecution.destination.parentWorkId;
  assert.ok(work.getInvocationExecution(uncertainId));
  await until(() => resultCount(uncertainSpeaking.work.id) === 1, 'uncertain assignment speaking acknowledgment settles');
  await service.awaitSettlement(uncertainSpeaking.work.id);
  // Simulate abrupt coordinator loss: database closes before transports, so old
  // async callbacks cannot certify or mutate an uncertain external-effect receipt.
  await ingress.close(); database.close();
  await Promise.all(clients.map(client => client.close()));
  await service.awaitSettlement(uncertainId);
  jerry.child.kill('SIGKILL');
  await new Promise<void>(resolve => jerry.child.once('exit', () => resolve()));
  database = openCoordinationDatabase({ path: dbPath });
  assert.equal(database.readOne<{state:string}>('SELECT state FROM works WHERE id=?', uncertainId)?.state, 'running');
  rebuildCoordinatorServices();
  await ingress.start();
  await service.recoverResidentWork();
  await until(() => work.get(uncertainId)?.state === 'failed', 'started uncertain invocation is interrupted, never automatically replayed');
  assert.equal(resultCount(uncertainId), 0);
  assert.equal(jerry.events.filter(e => e.type === 'executed' && e.args.task === 'substantial-uncertain').length, 1);

});
