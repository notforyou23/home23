import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrainOperationsClient } from '../../src/agent/brain-operations/client.js';
import { parseOperationEvents } from '../../src/agent/brain-operations/sse.js';
import { ManualClock, deferred, flushMicrotasks } from '../helpers/manual-clock.js';
import {
  canonicalBrainTarget,
  canonicalCatalogEntry,
  canonicalOwnedRunTarget,
  canonicalResearchTarget,
  makeBrainOperationRecord,
} from '../helpers/brain-operation-record.js';
import type {
  BrainCatalogEntry, BrainOperationEvent, BrainOperationEventGap, BrainOperationNotification,
  BrainOperationRecord, BrainOperationResult,
} from '../../src/agent/brain-operations/types.js';

const OPAQUE_RESULT_HANDLE = 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const require = createRequire(import.meta.url);
const express = require('express');
const {
  createBrainOperationsPlaceholderRouter,
  createBrainOperationsRouter,
} = require('../../engine/src/dashboard/brain-operations/router.js');
const {
  BrainOperationStore,
} = require('../../engine/src/dashboard/brain-operations/operation-store.js');
const {
  BrainOperationCoordinator,
} = require('../../engine/src/dashboard/brain-operations/coordinator.js');
const {
  createBrainOperationStoreReader,
} = require('../../engine/src/dashboard/brain-operations/store-reader.js');
const {
  createBrainOperationExporter,
} = require('../../engine/src/dashboard/brain-operations/exporter.js');

function record(
  operationId: string,
  eventSequence: number,
  state: BrainOperationRecord['state'],
  result: Record<string, unknown> | null = null,
): BrainOperationRecord {
  return makeBrainOperationRecord({
    operationId,
    requestId: `request-${operationId}`,
    operationType: 'query',
    requestParameters: { query: 'fixture query' },
    parameters: { query: 'fixture query' },
    canonicalEvidence: true,
    recordVersion: eventSequence,
    eventSequence,
    requesterAgent: 'jerry',
    target: canonicalBrainTarget('jerry', 'own'),
    state,
    phase: state === 'complete' ? 'done' : 'provider',
    startedAt: '2026-07-09T12:00:00.000Z',
    updatedAt: `2026-07-09T12:00:0${eventSequence}.000Z`,
    completedAt: state === 'complete' ? `2026-07-09T12:00:0${eventSequence}.000Z` : null,
    lastProviderActivityAt: `2026-07-09T12:00:0${eventSequence}.000Z`,
    lastProgressAt: null,
    result,
    resultHandle: state === 'complete' ? OPAQUE_RESULT_HANDLE : null,
    error: null,
    sourceEvidence: null,
    resultArtifact: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourcePinReleasedAt: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    metadataExpiresAt: null,
  });
}

function notificationFromRecord(value: BrainOperationRecord): BrainOperationNotification {
  return {
    type: ['complete', 'partial', 'failed', 'cancelled', 'interrupted'].includes(value.state)
      ? 'terminal'
      : 'heartbeat',
    operationId: value.operationId,
    eventSequence: value.eventSequence,
    sequence: value.eventSequence,
    at: value.updatedAt,
    state: value.state,
    phase: value.phase,
    updatedAt: value.updatedAt,
    lastProviderActivityAt: value.lastProviderActivityAt,
    lastProgressAt: value.lastProgressAt,
  } as BrainOperationNotification;
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let latestRecord: BrainOperationRecord | null = null;
  const opened = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const encoder = new TextEncoder();
  return {
    get body() {
      opened.resolve(undefined);
      return stream;
    },
    get latestRecord() { return latestRecord; },
    opened: opened.promise,
    frame(value: BrainOperationEvent | BrainOperationRecord, terminated = true) {
      latestRecord = 'type' in value ? null : value;
      const payload = 'type' in value ? value : notificationFromRecord(value);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}${terminated ? '\n\n' : ''}`));
    },
    raw(value: string) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
  };
}

function resultEnvelope(value: BrainOperationRecord) {
  return {
    operationId: value.operationId,
    state: value.state,
    result: value.result,
    resultHandle: value.resultHandle,
    resultArtifact: value.resultArtifact,
    error: value.error,
    sourceEvidence: value.sourceEvidence,
  };
}

function realBrainTarget(home23Root: string) {
  const canonicalRoot = path.join(home23Root, 'instances', 'jerry', 'brain');
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    ownerAgent: 'jerry',
    displayName: 'Jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-client-boundary',
    route: '/api/brain/brain-jerry',
    canonicalRoot,
    accessMode: 'own',
    mutationBoundaries: [
      { kind: 'brain', path: canonicalRoot },
      { kind: 'run', path: canonicalRoot },
      { kind: 'pgs', path: path.join(canonicalRoot, 'pgs-sessions') },
      { kind: 'session', path: path.join(canonicalRoot, 'sessions') },
      { kind: 'cache', path: path.join(canonicalRoot, 'cache') },
      { kind: 'export', path: path.join(canonicalRoot, 'exports') },
      { kind: 'agency', path: path.join(canonicalRoot, 'agency') },
    ],
  };
}

async function createRealClientBoundary(t: { after(callback: () => void | Promise<void>): void }) {
  const home23Root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(tmpdir(), 'home23-brain-client-boundary-'),
  ));
  for (const relative of [
    'instances/jerry/brain',
    'instances/jerry/runtime',
    'instances/jerry/workspace',
  ]) fs.mkdirSync(path.join(home23Root, relative), { recursive: true });
  const operationsRoot = path.join(home23Root, 'instances/jerry/runtime/brain-operations');
  const store = new BrainOperationStore({ root: operationsRoot, requesterAgent: 'jerry' });
  const reader = createBrainOperationStoreReader({
    operationsRoot,
    expectedRequester: 'jerry',
    liveStore: store,
  });
  const exporter = createBrainOperationExporter({ home23Root, requesterAgent: 'jerry', reader });
  const coordinator = {
    async start(input: {
      requestId: string; operationType: string; parameters: Record<string, unknown>;
    }) {
      const created = await store.create({
        requestId: input.requestId,
        requesterAgent: 'jerry',
        target: realBrainTarget(home23Root),
        operationType: input.operationType,
        requestParameters: input.parameters,
        parameters: input.parameters,
        sourcePinDescriptor: null,
        sourcePinDigest: null,
        canonicalEvidence: true,
      });
      return created.record;
    },
    async cancel(operationId: string) {
      const current = await store.get(operationId);
      return store.transition(operationId, {
        expectedVersion: current.recordVersion,
        state: 'cancelled',
        error: { code: 'cancelled', message: 'operator stop', retryable: false },
      });
    },
    async detach(operationId: string) { return store.get(operationId); },
    async attach() {
      throw Object.assign(new Error('operation_unavailable'), { code: 'operation_unavailable' });
    },
  };
  const app = express();
  const placeholder = createBrainOperationsPlaceholderRouter();
  app.use('/home23/api/brain-operations', placeholder.router);
  app.use((req: unknown, res: unknown, next: () => void) => {
    const parsed = req as { brainOperationBodyParsed?: boolean };
    if (parsed.brainOperationBodyParsed === true) return next();
    return express.json({ limit: '10gb' })(req, res, next);
  });
  placeholder.attach(createBrainOperationsRouter({
    requesterAgent: 'jerry',
    coordinator,
    reader,
    exporter,
    buildCatalog: async () => ({
      catalogRevision: 'catalog-client-boundary',
      brains: [{ ...canonicalCatalogEntry('jerry'), canonicalRoot: realBrainTarget(home23Root).canonicalRoot }],
    }),
  }).router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cancelRequests: Array<{ contentType: string | null; body: string | null }> = [];
  const client = new BrainOperationsClient({
    baseUrl,
    callerAgent: 'jerry',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/cancel')) {
        cancelRequests.push({
          contentType: new Headers(init?.headers).get('content-type'),
          body: init?.body === undefined || init.body === null ? null : String(init.body),
        });
      }
      return fetch(url, init);
    },
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home23Root, { recursive: true, force: true });
  });
  return { client, coordinator, store, cancelRequests };
}

async function createRealReconnectBoundary(t: { after(callback: () => void | Promise<void>): void }) {
  const home23Root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(tmpdir(), 'home23-brain-reconnect-boundary-'),
  ));
  for (const relative of [
    'instances/jerry/brain',
    'instances/jerry/runtime',
    'instances/jerry/workspace',
  ]) fs.mkdirSync(path.join(home23Root, relative), { recursive: true });
  const operationsRoot = path.join(home23Root, 'instances/jerry/runtime/brain-operations');
  const store = new BrainOperationStore({
    root: operationsRoot,
    requesterAgent: 'jerry',
    eventMaxCount: 3,
  });
  const reader = createBrainOperationStoreReader({
    operationsRoot,
    expectedRequester: 'jerry',
    liveStore: store,
  });
  const exporter = createBrainOperationExporter({ home23Root, requesterAgent: 'jerry', reader });
  let timerId = 0;
  const timers = {
    setTimeout() { timerId += 1; return timerId; },
    clearTimeout() {},
  };
  const coordinator = new BrainOperationCoordinator({
    requesterAgent: 'jerry',
    store,
    buildCanonicalCatalog: async () => ({ catalogRevision: 'catalog-reconnect', brains: [] }),
    resolveCanonicalTarget: () => realBrainTarget(home23Root),
    worker: {},
    capabilityIssuer: () => 'test-capability',
    clock: { now: Date.now },
    timers,
  });
  const created = await store.create({
    requestId: 'real-gap-reconnect',
    requesterAgent: 'jerry',
    target: realBrainTarget(home23Root),
    operationType: 'query',
    requestParameters: { query: 'real gap reconnect' },
    parameters: {
      query: 'real gap reconnect',
      operationControl: {
        hardDeadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: true,
  });
  let current = await store.transition(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    state: 'running',
    phase: 'provider',
  });
  for (let index = 0; index < 10; index += 1) {
    current = await store.appendEvent(created.record.operationId, {
      type: 'progress',
      completed: index + 1,
    });
  }
  const replay = await store.readEvents(created.record.operationId, 0);
  assert.equal(replay[0]?.type, 'event_gap', 'fixture must cross the real compacted journal boundary');

  const secondAttach = deferred<{ ok: boolean; error?: unknown }>();
  let attachCalls = 0;
  const realAttach = coordinator.attach.bind(coordinator);
  coordinator.attach = async (...args: unknown[]) => {
    attachCalls += 1;
    try {
      const attached = await realAttach(...args);
      if (attachCalls === 2) secondAttach.resolve({ ok: true });
      return attached;
    } catch (error) {
      if (attachCalls === 2) secondAttach.resolve({ ok: false, error });
      throw error;
    }
  };

  const app = express();
  const placeholder = createBrainOperationsPlaceholderRouter();
  app.use('/home23/api/brain-operations', placeholder.router);
  app.use((req: unknown, res: unknown, next: () => void) => {
    const parsed = req as { brainOperationBodyParsed?: boolean };
    if (parsed.brainOperationBodyParsed === true) return next();
    return express.json({ limit: '10gb' })(req, res, next);
  });
  placeholder.attach(createBrainOperationsRouter({
    requesterAgent: 'jerry',
    coordinator,
    reader,
    exporter,
    buildCatalog: async () => ({ catalogRevision: 'catalog-reconnect', brains: [] }),
  }).router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_unavailable');
  const client = new BrainOperationsClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    callerAgent: 'jerry',
    attachmentIdFactory: () => 'real-gap-attachment',
    reconnectDelayMs: 1,
  });
  t.after(async () => {
    await coordinator.stop().catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(home23Root, { recursive: true, force: true });
  });
  return {
    client,
    store,
    initial: created.record as BrainOperationRecord,
    current: current as BrainOperationRecord,
    secondAttach: secondAttach.promise,
    get attachCalls() { return attachCalls; },
  };
}

function createTwoAttachmentFetch(options: {
  operationId: string;
  streams: ReturnType<typeof controlledStream>[];
  calls: string[];
}) {
  let streamIndex = 0;
  const running = record(options.operationId, 1, 'running');
  const terminal = record(options.operationId, 2, 'complete', { answer: 'still running' });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    options.calls.push(parsed.pathname);
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      return new Response(JSON.stringify(running));
    }
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      return new Response(JSON.stringify(record(options.operationId, 2, 'cancelled')));
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(resultEnvelope(terminal)));
    }
    if (parsed.pathname.endsWith('/events')) {
      const stream = options.streams[streamIndex++];
      assert.ok(stream, 'unexpected extra attachment stream');
      return new Response(stream.body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (parsed.pathname.endsWith(`/${options.operationId}`)) {
      const latest = [...options.streams].reverse()
        .map((stream) => stream.latestRecord)
        .find((value) => value !== null);
      return new Response(JSON.stringify(latest || running));
    }
    return new Response('', { status: 404 });
  };
  return fetchImpl;
}

function createSingleOperationFetch(options: {
  operationId: string;
  operationType: string;
  sse: ReturnType<typeof controlledStream>;
  terminalResult: Record<string, unknown>;
}) {
  const queued = makeBrainOperationRecord({
    ...record(options.operationId, 0, 'queued'),
    operationType: options.operationType,
  });
  const running = makeBrainOperationRecord({
    ...record(options.operationId, 1, 'running'),
    operationType: options.operationType,
  });
  const terminal = makeBrainOperationRecord({
    ...record(options.operationId, 2, 'complete', options.terminalResult),
    operationType: options.operationType,
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      return new Response(JSON.stringify(running));
    }
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      return new Response(JSON.stringify(makeBrainOperationRecord({
        ...terminal,
        state: 'cancelled',
        phase: 'cancelled',
        result: null,
      })));
    }
    if (init?.method === 'POST') return new Response(JSON.stringify(queued));
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(resultEnvelope(terminal)));
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(options.sse.body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (parsed.pathname.endsWith(`/${options.operationId}`)) {
      return new Response(JSON.stringify(options.sse.latestRecord || running));
    }
    return new Response('', { status: 404 });
  };
  return fetchImpl;
}

function createEventGapFetch(options: {
  operationId: string; delivery: 'sse' | 'http';
  gap: { oldestSequence: number; latestSequence: number }; terminalSequence: number;
  mutate?: (gap: BrainOperationEventGap) => void;
}) {
  const afterValues: number[] = []; const attachmentIds: string[] = [];
  const detachReasons: string[] = []; let detachCalls = 0;
  let terminalServed = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1; detachReasons.push(JSON.parse(String(init.body)).reason);
      return new Response(JSON.stringify(record(options.operationId, 20, 'running')));
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record(options.operationId, 0, 'queued')));
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify({ operationId: options.operationId, state: 'complete',
        result: { answer: 'after gap' }, resultHandle: OPAQUE_RESULT_HANDLE,
        resultArtifact: null, error: null, sourceEvidence: null }));
    }
    if (parsed.pathname.endsWith(`/${options.operationId}`)) {
      return new Response(JSON.stringify(terminalServed
        ? record(options.operationId, options.terminalSequence, 'complete', { answer: 'after gap' })
        : record(options.operationId, 20, 'running')));
    }
    if (parsed.pathname.endsWith('/events')) {
      const after = Number(parsed.searchParams.get('after')); afterValues.push(after);
      attachmentIds.push(String(parsed.searchParams.get('attachmentId')));
      if (after === 0) {
        const gap: BrainOperationEventGap = { type: 'event_gap', operationId: options.operationId,
          oldestSequence: options.gap.oldestSequence, latestSequence: options.gap.latestSequence,
          currentStatus: record(options.operationId, options.gap.latestSequence, 'running') };
        options.mutate?.(gap);
        if (options.delivery === 'http') return new Response(JSON.stringify({ error: {
          code: 'event_gap', message: 'journal compacted', retryable: true, details: gap,
        } }), { status: 409 });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(gap)}\n\n`));
          controller.close();
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const terminal = record(options.operationId, options.terminalSequence, 'complete', { answer: 'after gap' });
      terminalServed = true;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify(notificationFromRecord(terminal))}\n\n`,
        ));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, afterValues, attachmentIds, detachReasons,
    get detachCalls() { return detachCalls; } };
}

type RecoveryCycle =
  | { kind: 'inactive'; event: BrainOperationRecord; statusSequence: number }
  | { kind: 'gap'; oldestSequence: number; latestSequence: number; statusSequence: number }
  | { kind: 'eof'; statusSequence: number }
  | { kind: 'terminal'; event: BrainOperationRecord };

function createRepeatedRecoveryFetch(options: {
  operationId: string;
  clock: ManualClock;
  cycles: RecoveryCycle[];
}) {
  const eventRequests: Array<{ after: number; attachmentId: string }> = [];
  const streams: ReturnType<typeof controlledStream>[] = [];
  let eventIndex = 0;
  let currentStatusSequence = 0;
  let startCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      return new Response(JSON.stringify(record(options.operationId, currentStatusSequence, 'running')));
    }
    if (init?.method === 'POST') {
      startCalls += 1;
      return new Response(JSON.stringify(record(options.operationId, 0, 'queued')));
    }
    if (parsed.pathname.endsWith('/result')) {
      const terminal = record(options.operationId, 6, 'complete', { answer: 'after recoveries' });
      return new Response(JSON.stringify(resultEnvelope(terminal)));
    }
    if (parsed.pathname.endsWith(`/${options.operationId}`)) {
      const latestTerminal = [...streams].reverse()
        .map((stream) => stream.latestRecord)
        .find((value) => value !== null
          && ['complete', 'partial', 'failed', 'cancelled', 'interrupted'].includes(value.state));
      return new Response(JSON.stringify(latestTerminal
        || record(options.operationId, currentStatusSequence, 'running')));
    }
    if (parsed.pathname.endsWith('/events')) {
      eventRequests.push({
        after: Number(parsed.searchParams.get('after')),
        attachmentId: String(parsed.searchParams.get('attachmentId')),
      });
      const stream = controlledStream();
      streams.push(stream);
      eventIndex += 1;
      return new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('', { status: 404 });
  };
  const streamFor = async (index: number) => {
    while (!streams[index]) await flushMicrotasks();
    await streams[index]!.opened;
    return streams[index]!;
  };
  const waitForTaskAtOrBefore = async (at: number) => {
    for (let index = 0; index < 50; index += 1) {
      if ([...options.clock.tasks.values()].some((task) => task.at <= at)) return;
      await flushMicrotasks();
    }
    assert.fail(`manual clock task was not scheduled by ${at}`);
  };
  return {
    fetchImpl,
    eventRequests,
    get startCalls() { return startCalls; },
    async driveInactiveCycle() {
      const cycle = options.cycles[0];
      assert.equal(cycle?.kind, 'inactive');
      const stream = await streamFor(0);
      currentStatusSequence = cycle.statusSequence;
      stream.frame(cycle.event);
      await waitForTaskAtOrBefore(options.clock.nowMs + 10);
      options.clock.advance(11);
      await waitForTaskAtOrBefore(options.clock.nowMs + 2);
    },
    async driveGapCycle() {
      const cycle = options.cycles[1];
      assert.equal(cycle?.kind, 'gap');
      const stream = await streamFor(1);
      currentStatusSequence = cycle.statusSequence;
      stream.frame({
        type: 'event_gap', operationId: options.operationId,
        oldestSequence: cycle.oldestSequence, latestSequence: cycle.latestSequence,
        currentStatus: record(options.operationId, cycle.statusSequence, 'running'),
      });
      stream.close();
      for (let index = 0; index < 6; index += 1) await flushMicrotasks();
    },
    async driveImmediateEofCycle() {
      const cycle = options.cycles[2];
      assert.equal(cycle?.kind, 'eof');
      const stream = await streamFor(2);
      currentStatusSequence = cycle.statusSequence;
      stream.close();
      await waitForTaskAtOrBefore(options.clock.nowMs + 2);
    },
    async driveTerminalCycle() {
      const cycle = options.cycles[3];
      assert.equal(cycle?.kind, 'terminal');
      const stream = await streamFor(3);
      currentStatusSequence = cycle.event.eventSequence;
      stream.frame(cycle.event);
      stream.close();
      for (let index = 0; index < 6; index += 1) await flushMicrotasks();
    },
    get attachmentCount() { return eventIndex; },
  };
}

test('verified operation events keep a query attachment alive beyond the old fixed deadline', async () => {
  const activities: number[] = [];
  const clock = new ManualClock();
  const sse = controlledStream();
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-1', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/result')) {
      const terminal = record('op-1', 4, 'complete', { answer: 'delayed answer' });
      return new Response(JSON.stringify({ operationId: terminal.operationId, state: terminal.state,
        result: terminal.result, resultHandle: terminal.resultHandle, resultArtifact: null,
        error: null, sourceEvidence: null }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/op-1')) {
      return new Response(JSON.stringify(sse.latestRecord || record('op-1', 0, 'queued')));
    }
    assert.match(String(url), /events\?after=0&attachmentId=attachment-1$/);
    return new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    fetchImpl,
    inactivityMs: 20,
    queryWaitMs: 200,
    attachmentIdFactory: () => 'attachment-1',
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onActivity: (activity) => activities.push(activity.sequence),
  });
  const pending = client.query({ query: 'wait for it', mode: 'quick' });
  await sse.opened;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    clock.advance(12);
    sse.frame(record('op-1', sequence, 'running'));
    await flushMicrotasks();
  }
  clock.advance(12);
  sse.frame(record('op-1', 4, 'complete', { answer: 'delayed answer' }));
  sse.close();
  const result = await pending;
  assert.equal(result.state, 'complete');
  assert.equal(result.result?.answer, 'delayed answer');
  assert.equal(result.resultHandle, OPAQUE_RESULT_HANDLE);
  assert.deepEqual(activities, [1, 2, 3, 4]);
});

test('SSE parser flushes one valid final frame when EOF has no blank-line terminator', async () => {
  const sse = controlledStream();
  const clock = new ManualClock();
  const parsed: BrainOperationNotification[] = [];
  const pending = (async () => {
    for await (const event of parseOperationEvents(sse.body, 'op-final', 0, {
      inactivityMs: 20, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })) {
      if (event.type === 'event_gap') throw new Error('unexpected gap');
      parsed.push(event);
    }
  })();
  await sse.opened;
  sse.frame(record('op-final', 1, 'complete', { answer: 'final frame' }), false);
  sse.close();
  await pending;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.type, 'terminal');
  assert.equal(parsed[0]?.eventSequence, 1);
});

test('stream silence performs a bounded status read and reconnects from the last sequence', async () => {
  let starts = 0;
  let statusReads = 0;
  let secondAttachments = 0;
  const clock = new ManualClock();
  const first = controlledStream();
  const second = controlledStream();
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') {
      starts += 1;
      return new Response(JSON.stringify(record('op-reconnect', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events') && parsed.searchParams.get('after') === '0') {
      return new Response(first.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.endsWith('/op-reconnect')) {
      statusReads += 1;
      return new Response(JSON.stringify(
        second.latestRecord || first.latestRecord || record('op-reconnect', 1, 'running'),
      ), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events') && parsed.searchParams.get('after') === '1') {
      secondAttachments += 1;
      return new Response(second.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(resultEnvelope(
        record('op-reconnect', 2, 'complete', { answer: 'reattached' }),
      )));
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 10, reconnectDelayMs: 1, queryWaitMs: 200,
    attachmentIdFactory: () => 'attachment-r',
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'reconnect', mode: 'quick' });
  await first.opened;
  first.frame(record('op-reconnect', 1, 'running'));
  await flushMicrotasks();
  clock.advance(11);
  await flushMicrotasks();
  clock.advance(1);
  await flushMicrotasks();
  await second.opened;
  second.frame(record('op-reconnect', 2, 'complete', { answer: 'reattached' }));
  second.close();
  const result = await pending;
  assert.equal(result.result?.answer, 'reattached');
  assert.equal(starts, 1);
  assert.equal(statusReads, 2, 'one inactivity recovery plus one terminal authentication');
  assert.equal(secondAttachments, 1);
});

test('attachment deadline detaches while the durable operation remains running and readable', async () => {
  let statusReads = 0;
  let detachCalls = 0;
  const clock = new ManualClock();
  const streamOpened = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const running = record('op-detach', 1, 'running');
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(running), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-detach', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events') && parsed.searchParams.get('after') === '0') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify(notificationFromRecord(running))}\n\n`,
        ));
        streamOpened.resolve(controller);
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    statusReads += 1;
    return new Response(JSON.stringify(running), { status: 200 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 2, queryWaitMs: 5,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const pending = client.query({ query: 'detach', mode: 'quick' });
  await streamOpened.promise;
  clock.advance(6);
  await flushMicrotasks();
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.equal(result.state, 'running');
  assert.equal((await client.getOperation('op-detach')).state, 'running');
  assert.equal(detachCalls, 1);
  assert.ok(statusReads >= 1);
});

test('one of two attachments detaches while the other receives terminal progress', async () => {
  const clock = new ManualClock();
  const streams = [controlledStream(), controlledStream()];
  const calls: string[] = [];
  const fetchImpl = createTwoAttachmentFetch({ operationId: 'op-shared', streams, calls });
  let attachment = 0;
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    attachmentIdFactory: () => `attachment-${++attachment}`,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const initial = record('op-shared', 0, 'queued');
  const shortAttachment = client.wait('op-shared', {
    operationType: 'query', initial, waitMs: 5,
  });
  const longAttachment = client.wait('op-shared', {
    operationType: 'query', initial, waitMs: 50,
  });
  await Promise.all(streams.map(stream => stream.opened));
  streams[0]!.frame(record('op-shared', 1, 'running'));
  streams[1]!.frame(record('op-shared', 1, 'running'));
  await flushMicrotasks();
  clock.advance(6);
  await flushMicrotasks();
  const detached = await shortAttachment;
  streams[1]!.frame(record('op-shared', 2, 'complete', { answer: 'still running' }));
  streams[1]!.close();
  const completed = await longAttachment;
  assert.equal(detached.attachmentState, 'detached');
  assert.equal(completed.state, 'complete');
  assert.equal(completed.result?.answer, 'still running');
  assert.equal(calls.filter(path => path.endsWith('/detach')).length, 1);
  assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 0);
});

test('research stop remains attached beyond the old 30 second cutoff', async () => {
  const clock = new ManualClock();
  const sse = controlledStream();
  let settled = false;
  const fetchImpl = createSingleOperationFetch({
    operationId: 'op-stop', operationType: 'research_stop', sse,
    terminalResult: { stopped: true },
  });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    inactivityMs: 60_000, pgsWaitMs: 6 * 60 * 60_000,
  });
  const pending = client.stopResearch({ target: { runId: 'run-owned' } })
    .finally(() => { settled = true; });
  await sse.opened;
  sse.frame(record('op-stop', 1, 'running'));
  await flushMicrotasks();
  clock.advance(31_000);
  await flushMicrotasks();
  assert.equal(settled, false);
  sse.frame(record('op-stop', 2, 'complete', { stopped: true }));
  sse.close();
  assert.equal((await pending).state, 'complete');
});

test('explicit operator cancellation posts cancel and returns cancelled', async () => {
  let cancelCalls = 0;
  const controller = new AbortController();
  const sse = controlledStream();
  const cancelled = {
    ...record('op-cancel', 2, 'cancelled'),
    phase: 'cancelled',
    error: { code: 'cancelled', message: 'operator stop', retryable: false },
  } satisfies BrainOperationRecord;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      cancelCalls += 1;
      return new Response(JSON.stringify(cancelled), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-cancel', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(resultEnvelope(cancelled)), { status: 200 });
    }
    if (parsed.pathname.endsWith('/op-cancel')) {
      return new Response(JSON.stringify(record('op-cancel', 1, 'running')));
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const pending = client.query({ query: 'cancel', mode: 'quick' }, controller.signal);
  await sse.opened;
  sse.frame(record('op-cancel', 1, 'running'));
  await flushMicrotasks();
  controller.abort(Object.assign(new Error('operator_stop'), { code: 'operator_stop' }));
  const result = await pending;
  assert.equal(result.state, 'cancelled');
  assert.equal(cancelCalls, 1);
});

test('one SSE connect timeout status-checks and reconnects while the durable query is running', async () => {
  const clock = new ManualClock();
  const firstConnectStarted = deferred<void>();
  const neverFirstHeaders = deferred<Response>();
  const second = controlledStream();
  let connectAttempts = 0;
  let detachCalls = 0;
  let terminal = false;
  let settled: BrainOperationResult | null = null;
  const running = record('op-connect-retry', 1, 'running');
  const complete = record('op-connect-retry', 2, 'complete', { answer: 'reattached after headers' });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(running), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-connect-retry', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) {
      connectAttempts += 1;
      if (connectAttempts === 1) {
        firstConnectStarted.resolve(undefined);
        return neverFirstHeaders.promise;
      }
      return new Response(second.body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(resultEnvelope(complete)), { status: 200 });
    }
    if (parsed.pathname.endsWith('/op-connect-retry')) {
      return new Response(JSON.stringify(terminal ? complete : running), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    connectMs: 10, statusReadMs: 10, queryWaitMs: 100, reconnectDelayMs: 1,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'connect retry' }).then((value) => {
    settled = value;
    return value;
  });
  await firstConnectStarted.promise;
  clock.advance(11);
  for (let step = 0; step < 8 && connectAttempts < 2; step += 1) {
    await flushMicrotasks();
    clock.advance(2);
  }
  await flushMicrotasks();

  assert.equal(connectAttempts, 2, 'a healthy running status must reconnect instead of detach');
  assert.equal(settled, null);
  await second.opened;
  terminal = true;
  second.frame(complete);
  second.close();
  const result = await pending;
  assert.equal(result.state, 'complete');
  assert.equal(result.result?.answer, 'reattached after headers');
  assert.equal(detachCalls, 0);
});

test('SSE connect/header deadline detaches only when the bounded status read also times out', async () => {
  const clock = new ManualClock();
  const neverHeaders = deferred<Response>();
  const neverStatus = deferred<Response>();
  const connectStarted = deferred<void>();
  const statusStarted = deferred<void>();
  let detachCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(record('op-connect', 1, 'running')), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-connect', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) {
      connectStarted.resolve(undefined);
      return neverHeaders.promise;
    }
    if (parsed.pathname.endsWith('/op-connect')) {
      statusStarted.resolve(undefined);
      return neverStatus.promise;
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    connectMs: 10, statusReadMs: 10, queryWaitMs: 100,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'connect deadline' });
  await connectStarted.promise;
  clock.advance(11);
  await statusStarted.promise;
  clock.advance(11);
  await flushMicrotasks();
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.equal(result.state, 'queued');
  assert.equal(detachCalls, 1);
});

test('terminal status remains authoritative when closing the completed SSE body fails', async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let cancelCalls = 0;
  let detachCalls = 0;
  const streamOpened = deferred<void>();
  const complete = record('op-terminal-close-failure', 1, 'complete', {
    answer: 'terminal survives transport cleanup',
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() {
      cancelCalls += 1;
      throw Object.assign(new Error('stream cleanup failed'), { code: 'stream_cleanup_failed' });
    },
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(complete), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-terminal-close-failure', 0, 'queued')), {
        status: 200,
      });
    }
    if (parsed.pathname.endsWith('/events')) {
      streamOpened.resolve(undefined);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify(resultEnvelope(complete)), { status: 200 });
    }
    if (parsed.pathname.endsWith('/op-terminal-close-failure')) {
      return new Response(JSON.stringify(complete), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
  });
  const pending = client.query({ query: 'terminal cleanup failure' });
  await streamOpened.promise;
  streamController.enqueue(new TextEncoder().encode(
    `data: ${JSON.stringify(notificationFromRecord(complete))}\n\n`,
  ));

  const result = await pending;
  assert.equal(result.state, 'complete');
  assert.equal(result.result?.answer, 'terminal survives transport cleanup');
  assert.equal(cancelCalls, 1);
  assert.equal(detachCalls, 0);
});

test('status body-read deadline detaches instead of waiting forever after SSE silence', async () => {
  const clock = new ManualClock();
  const sse = controlledStream();
  const statusStarted = deferred<void>();
  const neverStatus = deferred<Response>();
  let detachCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      detachCalls += 1;
      return new Response(JSON.stringify(record('op-status-timeout', 1, 'running')), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(record('op-status-timeout', 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(sse.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    statusStarted.resolve(undefined);
    return neverStatus.promise;
  };
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 10, connectMs: 10, statusReadMs: 10, queryWaitMs: 100,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'status deadline' });
  await sse.opened;
  sse.frame(record('op-status-timeout', 1, 'running'));
  await flushMicrotasks();
  clock.advance(11);
  await statusStarted.promise;
  clock.advance(11);
  await flushMicrotasks();
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.equal(detachCalls, 1);
});

test('HTTP 200 error envelopes are rejected as operation failures', async () => {
  const client = new BrainOperationsClient({ baseUrl: 'http://unused', callerAgent: 'jerry', fetchImpl: async () =>
    new Response(JSON.stringify({ success: false, error: { code: 'provider_failed' } }), { status: 200 }) });
  await assert.rejects(client.start('query', { query: 'x' }), /brain_operation_error/);
});

test('bounded non-2xx JSON preserves the typed coordinator error', async () => {
  const client = new BrainOperationsClient({ baseUrl: 'http://unused', callerAgent: 'jerry',
    fetchImpl: async () => new Response(JSON.stringify({ error: {
      code: 'target_not_available', message: 'research run is active', retryable: true,
    } }), { status: 409, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.start('query', { query: 'x' }), (error: unknown) => {
    const typed = error as { code?: string; message?: string; retryable?: boolean; httpStatus?: number };
    assert.equal(typed.code, 'target_not_available');
    assert.equal(typed.message, 'research run is active');
    assert.equal(typed.retryable, true);
    assert.equal(typed.httpStatus, 409);
    return true;
  });
});

test('oversized, malformed, or stalled non-2xx bodies stay bounded and typed', async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const largeClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => new Response(oversized, { status: 502 }) });
  await assert.rejects(largeClient.start('query', { query: 'x' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'error_body_too_large');
    assert.equal((error as { httpStatus?: number }).httpStatus, 502);
    return true;
  });
  assert.equal(cancelled, true);

  const malformedClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => new Response('{not-json', { status: 503 }) });
  await assert.rejects(malformedClient.start('query', { query: 'x' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'source_unavailable');
    assert.equal((error as { httpStatus?: number }).httpStatus, 503);
    assert.match((error as Error).message, /\{not-json/);
    return true;
  });

  const clock = new ManualClock(); let stalledCancelled = false; let fetches = 0;
  const stalledClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    statusReadMs: 10, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { stalledCancelled = true; },
      }), { status: 503 });
    } });
  const stalled = stalledClient.start('query', { query: 'x' });
  await flushMicrotasks(); clock.advance(11); await flushMicrotasks();
  await assert.rejects(stalled, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'error_body_timeout');
    assert.equal((error as { httpStatus?: number }).httpStatus, 503);
    return true;
  });
  assert.equal(stalledCancelled, true);
  assert.equal(fetches, 1, 'a received non-2xx response is not a lost-start retry');
});

test('only exact target or untyped route-not-found errors refresh the catalog', async () => {
  for (const fixture of [
    { status: 409, code: 'target_not_found', refresh: true },
    { status: 409, code: 'target_not_available', refresh: true },
    { status: 409, code: 'target_mismatch', refresh: true },
    { status: 409, code: 'target_ambiguous', refresh: true },
    { status: 404, code: null, refresh: true },
    { status: 404, code: 'access_denied', refresh: false },
    { status: 403, code: 'access_denied', refresh: false },
    { status: 400, code: 'invalid_request', refresh: false },
    { status: 502, code: 'provider_failed', refresh: false },
  ]) {
    let catalogs = 0; let starts = 0;
    const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/catalog')) {
          catalogs += 1;
          return new Response(JSON.stringify({ catalogRevision: `c${catalogs}`,
            brains: [canonicalCatalogEntry('forrest')] }), { status: 200 });
        }
        assert.equal(init?.method, 'POST'); starts += 1;
        const body = fixture.code ? { error: { code: fixture.code, message: fixture.code } } : {};
        return new Response(JSON.stringify(body), { status: fixture.status });
      } });
    await assert.rejects(client.start('query', { target: { agent: 'forrest' }, query: 'x' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, fixture.code || 'route_not_found');
        assert.equal((error as { httpStatus?: number }).httpStatus, fixture.status);
        return true;
      });
    assert.equal(catalogs, fixture.refresh ? 2 : 1);
    assert.equal(starts, fixture.refresh ? 2 : 1);
  }
});

test('event_gap reloads canonical status and resumes from its sequence without renewing activity', async () => {
  const fixture = createEventGapFetch({ operationId: 'op-gap', delivery: 'sse',
    gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21 });
  const activities: number[] = [];
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: fixture.fetchImpl, attachmentIdFactory: () => 'attachment-gap',
    onActivity: (activity) => activities.push(activity.sequence) });
  const result = await client.query({ query: 'gap' });
  assert.equal(result.state, 'complete');
  assert.deepEqual(fixture.afterValues, [0, 20]);
  assert.deepEqual(fixture.attachmentIds, ['attachment-gap', 'attachment-gap']);
  assert.deepEqual(activities, [21]);
  assert.equal(fixture.detachCalls, 1);
  assert.deepEqual(fixture.detachReasons, ['event_gap_reconnect']);

  const httpFixture = createEventGapFetch({ operationId: 'op-gap-http', delivery: 'http',
    gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21 });
  const httpClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: httpFixture.fetchImpl, attachmentIdFactory: () => 'attachment-gap-http' });
  assert.equal((await httpClient.query({ query: 'gap-http' })).state, 'complete');
  assert.deepEqual(httpFixture.afterValues, [0, 20]);

  const descriptive = createEventGapFetch({
    operationId: 'op-gap-descriptive', delivery: 'sse',
    gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21,
    mutate: (gap) => {
      gap.currentStatus = record('op-gap-descriptive', 999, 'complete', {
        answer: 'forged descriptive status',
      });
    },
  });
  const descriptiveClient = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: descriptive.fetchImpl,
    attachmentIdFactory: () => 'attachment-gap-descriptive',
  });
  const descriptiveResult = await descriptiveClient.query({ query: 'ignore descriptive gap status' });
  assert.equal(descriptiveResult.result?.answer, 'after gap');
  assert.deepEqual(descriptive.afterValues, [0, 20],
    'only requester-authenticated status selects the reconnect cursor');
});

test('malformed or regressive event_gap detaches instead of fabricating continuity', async () => {
  for (const mutate of [
    (gap: BrainOperationEventGap) => { gap.operationId = 'wrong'; },
    (gap: BrainOperationEventGap) => { gap.oldestSequence = 1.5; },
    (gap: BrainOperationEventGap) => { gap.oldestSequence = 22; gap.latestSequence = 20; },
    (gap: BrainOperationEventGap) => { gap.currentStatus.eventSequence = 19; },
    (gap: BrainOperationEventGap) => { gap.currentStatus.eventSequence = -1; },
  ]) {
    const fixture = createEventGapFetch({ operationId: 'op-bad-gap', delivery: 'sse',
      gap: { oldestSequence: 10, latestSequence: 20 }, terminalSequence: 21, mutate });
    const activities: number[] = [];
    const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
      fetchImpl: fixture.fetchImpl, onActivity: (activity) => activities.push(activity.sequence) });
    const result = await client.query({ query: 'bad-gap' });
    assert.equal(result.attachmentState, 'detached');
    assert.equal(fixture.detachReasons.at(-1), 'operation_event_gap_invalid');
    assert.deepEqual(activities, []);
  }
});

test('repeated recoverable reconnect cycles continue until the attachment deadline without another start', async () => {
  const clock = new ManualClock();
  const fixture = createRepeatedRecoveryFetch({ operationId: 'op-many', clock, cycles: [
    { kind: 'inactive', event: record('op-many', 1, 'running'), statusSequence: 1 },
    { kind: 'gap', oldestSequence: 2, latestSequence: 5, statusSequence: 5 },
    { kind: 'eof', statusSequence: 5 },
    { kind: 'terminal', event: record('op-many', 6, 'complete', { answer: 'after recoveries' }) },
  ] });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl: fixture.fetchImpl,
    inactivityMs: 10, reconnectDelayMs: 2, queryWaitMs: 200,
    attachmentIdFactory: () => 'attachment-many',
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const pending = client.query({ query: 'survive repeated recovery' });
  await fixture.driveInactiveCycle();
  clock.advance(2); await flushMicrotasks();
  await fixture.driveGapCycle();
  await fixture.driveImmediateEofCycle();
  await flushMicrotasks();
  assert.equal(fixture.eventRequests.length, 3,
    'same-cursor EOF must wait instead of opening an immediate fourth stream');
  clock.advance(2); await flushMicrotasks();
  await fixture.driveTerminalCycle();
  assert.equal((await pending).result?.answer, 'after recoveries');
  assert.equal(fixture.startCalls, 1);
  assert.deepEqual(fixture.eventRequests.map((call) => call.after), [0, 1, 5, 5]);
  assert.deepEqual(new Set(fixture.eventRequests.map((call) => call.attachmentId)),
    new Set(['attachment-many']));
});

test('present-null, extra target fields, nonfinite limits, and partial provider pairs fail locally', async () => {
  let fetches = 0;
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => { fetches += 1; throw new Error('fetch forbidden'); } });
  const invalid = [
    { target: null, query: 'x' }, { target: {}, query: 'x' }, { target: [], query: 'x' },
    { target: { agent: 'forrest', extra: true }, query: 'x' }, { target: { agent: ' ' }, query: 'x' },
    { target: { brainId: '*' }, query: 'x' }, { target: { brainId: null }, query: 'x' },
    { target: { agent: 'forrest', brainId: false }, query: 'x' },
    { query: 'x', modelSelection: null }, { query: 'x', modelSelection: { provider: 'openai' } },
    { query: 'x', modelSelection: undefined },
    { query: 'x', modelSelection: { provider: 'x'.repeat(257), model: 'gpt' } },
    { query: 'x', modelSelection: { provider: 'openai', model: 'x'.repeat(257) } },
    { query: 'x', modelSelection: { provider: 'openai', model: 'gpt', extra: true } },
    { query: 'x', provider: 'openai' }, { query: 'x', pgsSweepModel: 'gpt' },
    { query: 'x'.repeat(12_001) },
    { query: 'x', priorContext: { query: 'q', answer: 'a'.repeat(20_001) } },
  ];
  for (const value of invalid) {
    await assert.rejects(
      client.start('query', value as never),
      (error: unknown) => (error as { code?: string }).code === 'invalid_request',
    );
  }
  for (const topK of [null, '10', false, NaN, Infinity, -1, 0, 1.5, 101]) {
    await assert.rejects(client.start('search', { query: 'x', topK } as never), /invalid/i);
  }
  await assert.rejects(
    client.start('search', { query: 'x', topK: undefined } as never), /invalid/i,
  );
  await assert.rejects(
    client.start('search', { query: 'x', tag: undefined } as never), /invalid/i,
  );
  for (const [field, value] of [
    ['nodeLimit', null], ['nodeLimit', '25'], ['nodeLimit', NaN], ['nodeLimit', Infinity],
    ['nodeLimit', 1.5], ['nodeLimit', 0], ['nodeLimit', 2_001],
    ['edgeLimit', false], ['edgeLimit', 0], ['edgeLimit', 8_001],
  ] as const) {
    await assert.rejects(client.start('graph', { [field]: value } as never), /invalid/i);
  }
  for (const pgsConfig of [null, [], { extra: true }, { sweepFraction: 0.5, extra: true }]) {
    await assert.rejects(client.start('pgs', { query: 'x', pgsConfig } as never), /invalid/i);
  }
  for (const sweepFraction of [null, '0.5', false, NaN, Infinity, 0, -0.1, 1.1]) {
    await assert.rejects(client.start('pgs', {
      query: 'x', pgsConfig: { sweepFraction },
    } as never), /invalid/i);
  }
  assert.equal(fetches, 0);
});

test('operation starts require query as an own data property', async () => {
  let fetches = 0;
  let getterReads = 0;
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('fetch forbidden');
    },
  });
  const accessorParameters: Record<string, unknown> = {};
  Object.defineProperty(accessorParameters, 'query', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'accessor query';
    },
  });
  const parameters = [
    Object.create({ query: 'inherited query' }) as Record<string, unknown>,
    accessorParameters,
    new Proxy({ query: 'proxied query' }, {}),
  ];
  for (const value of parameters) {
    await assert.rejects(
      client.start('query', value),
      (error: unknown) => (error as { code?: string }).code === 'invalid_request',
    );
  }
  assert.equal(fetches, 0);
  assert.equal(getterReads, 0);
});

test('lost start response retries once with the identical requestId and body', async () => {
  const bodies: string[] = [];
  const calls: string[] = [];
  let catalogReads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/catalog')) {
      calls.push('catalog');
      catalogReads += 1;
      if (catalogReads > 1) throw new Error('catalog drift must not precede stable POST retry');
      return new Response(JSON.stringify({ catalogRevision: 'c1',
        brains: [canonicalCatalogEntry('forrest')] }), { status: 200 });
    }
    calls.push('post');
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      throw Object.assign(new TypeError('connection reset after server commit'), { code: 'ECONNRESET' });
    }
    return new Response(JSON.stringify(record('op-idempotent', 1, 'queued')), { status: 200 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const started = await client.start('query', {
    requestId: 'request-stable', target: { agent: 'forrest' }, query: 'x',
  });
  assert.equal(started.operationId, 'op-idempotent');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
  assert.equal(JSON.parse(bodies[0]!).requestId, 'request-stable');
  assert.deepEqual(calls, ['catalog', 'post', 'post']);
});

test('owned-run operations send exactly one runId target and never consult brain catalog', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify(makeBrainOperationRecord({
      ...record('op-run', 0, 'queued'), target: canonicalOwnedRunTarget('run-owned'),
    })), { status: 200 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  await client.start('research_watch', { target: { runId: 'run-owned' }, after: 0 });
  assert.deepEqual(bodies[0]?.target, { runId: 'run-owned' });
  assert.deepEqual(bodies[0]?.parameters, { after: 0 });
  for (const target of [undefined, {}, { runId: '' }, { brainId: 'brain-r1' },
    { runId: '*' }, { runId: 'run-owned', brainId: 'brain-r1' }]) {
    await assert.rejects(
      client.start('research_watch', { ...(target ? { target } : {}), after: 0 } as never),
      /owned_run_target_requires_exact_run_id/,
    );
  }
  assert.equal(bodies.length, 1);
});

test('large canonical results are read by operation route and export uses only operation export fields', async () => {
  const answer = 'x'.repeat(1_000_000);
  let exportBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/result')) {
      return new Response(JSON.stringify({ operationId: 'op-large', state: 'complete', result: { answer },
        resultHandle: OPAQUE_RESULT_HANDLE, resultArtifact: null,
        error: null, sourceEvidence: { sourceHealth: 'healthy' } }));
    }
    if (parsed.pathname.endsWith('/export')) {
      exportBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ operationId: 'op-large', exportedTo: '/requester/export.md' }));
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const result = await client.getResult('op-large');
  assert.equal((result.result as { answer: string }).answer.length, 1_000_000);
  await client.exportResult({
    operationId: 'op-large', resultHandle: OPAQUE_RESULT_HANDLE,
    format: 'markdown', fileName: 'brain-answer.md',
  } as never);
  assert.equal('answer' in (exportBody || {}), false);
  assert.equal('resultHandle' in (exportBody || {}), false);
  assert.deepEqual(exportBody, { format: 'markdown', fileName: 'brain-answer.md' });
  await assert.rejects(
    client.exportResult({ operationId: 'op-large', format: 'markdown', answer } as never),
    /canonical_export_requires_operation_id/,
  );
  await assert.rejects(
    client.exportResult({
      operationId: 'op-large', format: 'markdown', metadata: { caller: 'unsupported' },
    } as never),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('short operation disconnect cancels work while durable query disconnect detaches', async () => {
  const calls: string[] = [];
  const streams = [controlledStream(), controlledStream()];
  let startIndex = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      return new Response(JSON.stringify(record('op-short', 2, 'cancelled')), { status: 200 });
    }
    if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
      return new Response(JSON.stringify(record('op-durable', 2, 'running')), { status: 200 });
    }
    if (init?.method === 'POST') {
      const operationId = startIndex++ === 0 ? 'op-short' : 'op-durable';
      return new Response(JSON.stringify(record(operationId, 0, 'queued')), { status: 200 });
    }
    if (parsed.pathname.includes('/op-short/events')) {
      return new Response(streams[0]!.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.includes('/op-durable/events')) {
      return new Response(streams[1]!.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (parsed.pathname.includes('/op-short/result')) {
      return new Response(JSON.stringify(resultEnvelope(record('op-short', 2, 'cancelled'))), { status: 200 });
    }
    if (parsed.pathname.includes('/op-short')) {
      return new Response(JSON.stringify(record('op-short', 1, 'running')));
    }
    if (parsed.pathname.includes('/op-durable')) {
      return new Response(JSON.stringify(record('op-durable', 1, 'running')));
    }
    return new Response('', { status: 404 });
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const searchAbort = new AbortController();
  const search = client.search({ query: 'short' }, searchAbort.signal);
  await streams[0]!.opened;
  searchAbort.abort(Object.assign(new Error('transport_disconnect'), { code: 'transport_disconnect' }));
  await assert.rejects(search, /cancelled/);
  const queryAbort = new AbortController();
  const query = client.query({ query: 'durable' }, queryAbort.signal);
  await streams[1]!.opened;
  queryAbort.abort(Object.assign(new Error('transport_disconnect'), { code: 'transport_disconnect' }));
  await query;
  assert.equal(calls.filter(path => path.endsWith('/cancel')).length, 1);
  assert.equal(calls.filter(path => path.endsWith('/detach')).length, 1);
});

test('SSE accepts CRLF and parses a terminal final frame without a trailing blank line', async () => {
  const sse = controlledStream();
  const clock = new ManualClock();
  const events: Array<[number, string]> = [];
  const pending = (async () => {
    for await (const event of parseOperationEvents(sse.body, 'op-final', 0, {
      inactivityMs: 20, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })) {
      if (event.type === 'event_gap') throw new Error('unexpected gap');
      events.push([event.eventSequence, event.state || 'unknown']);
    }
  })();
  await sse.opened;
  sse.raw(`data: ${JSON.stringify(notificationFromRecord(record('op-final', 1, 'running')))}\r\n\r\n`);
  sse.raw(`data: ${JSON.stringify(notificationFromRecord(record('op-final', 2, 'complete')))}`);
  sse.close();
  await pending;
  assert.deepEqual(events, [[1, 'running'], [2, 'complete']]);
});

test('synthesisStatus without an operation ID performs only the exact synthesis-state GET', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method || 'GET') });
      return new Response(JSON.stringify({ ready: true, requestedGenerationMarker: 'g1',
        currentGenerationMarker: 'g2', markerStatus: 'changed', latestOperation: null,
        activeOperation: null }));
    } });
  const value = await client.synthesisStatus({ generationMarker: 'g1' });
  assert.deepEqual(value, { ready: true, requestedGenerationMarker: 'g1',
    currentGenerationMarker: 'g2', markerStatus: 'changed', latestOperation: null,
    activeOperation: null });
  assert.deepEqual(calls, [{
    url: 'http://fixture/api/synthesis/state?generationMarker=g1', method: 'GET',
  }]);
  await assert.rejects(client.synthesisStatus({ generationMarker: ' '.repeat(2) }), /generationMarker_invalid/);
  assert.equal(calls.length, 1);
});

test('PGS resume derives its six-hour wait from authenticated status and survives beyond 90 minutes', async () => {
  const clock = new ManualClock(); const sse = controlledStream(); let starts = 0;
  const running = makeBrainOperationRecord({ ...record('op-resume-pgs', 1, 'running'), operationType: 'pgs' });
  const terminal = makeBrainOperationRecord({
    ...record('op-resume-pgs', 2, 'complete', { answer: 'late PGS' }), operationType: 'pgs',
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') { starts += 1; return new Response('', { status: 500 }); }
    if (parsed.pathname.endsWith('/result')) return new Response(JSON.stringify(resultEnvelope(terminal)));
    if (parsed.pathname.endsWith('/events')) return new Response(sse.body,
      { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(sse.latestRecord || running));
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
    inactivityMs: 2 * 60 * 60_000, queryWaitMs: 90 * 60_000, pgsWaitMs: 6 * 60 * 60_000,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const pending = client.resumeOperation('op-resume-pgs'); await sse.opened;
  for (let index = 0; index < 50
    && ![...clock.tasks.values()].some((task) => task.at === 2 * 60 * 60_000); index += 1) {
    await flushMicrotasks();
  }
  assert.ok([...clock.tasks.values()].some((task) => task.at === 2 * 60 * 60_000));
  clock.advance(91 * 60_000); await flushMicrotasks();
  sse.frame(terminal); sse.close();
  const resumed = await pending;
  assert.equal(resumed.result?.answer, 'late PGS');
  assert.equal(starts, 0);
});

test('catalog caching is positive-only, expires at 30 seconds, and refreshes stale target resolution', async () => {
  const clock = new ManualClock();
  let catalogReads = 0;
  let includeForrest = false;
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture', callerAgent: 'jerry', now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetchImpl: async (url) => {
      assert.match(String(url), /\/catalog$/);
      catalogReads += 1;
      return new Response(JSON.stringify({ catalogRevision: `c${catalogReads}`,
        brains: [canonicalCatalogEntry('jerry'),
          ...(includeForrest ? [canonicalCatalogEntry('forrest')] : [])] }));
    },
  });
  assert.equal((await client.getCatalog()).catalogRevision, 'c1');
  assert.equal((await client.getCatalog()).catalogRevision, 'c1');
  clock.advance(29_999);
  assert.equal((await client.getCatalog()).catalogRevision, 'c1');
  clock.advance(1);
  assert.equal((await client.getCatalog()).catalogRevision, 'c2');
  includeForrest = true;
  const target = await client.resolveTarget({ agent: 'forrest' });
  assert.equal(target.id, 'brain-forrest');
  assert.equal(target.accessMode, 'read-only');
  assert.equal(catalogReads, 3);

  let emptyReads = 0;
  const emptyClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => {
      emptyReads += 1;
      return new Response(JSON.stringify({ catalogRevision: `empty-${emptyReads}`, brains: [] }));
    } });
  await emptyClient.getCatalog();
  await emptyClient.getCatalog();
  assert.equal(emptyReads, 2, 'an empty catalog is never cached');
});

test('target resolution distinguishes mismatch, unavailable, and not found while starts preserve selectors', async () => {
  const research = canonicalResearchTarget('brain-r1');
  const researchCatalogBase = canonicalCatalogEntry('research');
  const activeResearch: BrainCatalogEntry = {
    ...researchCatalogBase,
    id: research.brainId, displayName: research.displayName, ownerAgent: research.ownerAgent,
    kind: research.kind, lifecycle: 'active', canonicalRoot: research.canonicalRoot,
    sourceType: 'cosmo', nodeCount: 10, modifiedAt: '2026-07-09T12:00:00.000Z',
    route: research.route, mutationBoundaries: research.mutationBoundaries,
  };
  const catalog = { catalogRevision: 'catalog-targets',
    brains: [canonicalCatalogEntry('jerry'), canonicalCatalogEntry('forrest'), activeResearch] };
  const makeClient = () => new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async () => new Response(JSON.stringify(catalog)) });
  await assert.rejects(
    makeClient().resolveTarget({ agent: 'forrest', brainId: 'brain-jerry' }),
    (error: unknown) => (error as { code?: string }).code === 'target_mismatch',
  );
  await assert.rejects(
    makeClient().resolveTarget({ brainId: 'brain-r1' }),
    (error: unknown) => (error as { code?: string }).code === 'target_not_available',
  );
  await assert.rejects(
    makeClient().resolveTarget({ brainId: 'brain-missing' }),
    (error: unknown) => (error as { code?: string }).code === 'target_not_found',
  );
  const own = await makeClient().resolveTarget();
  assert.equal(own.id, 'brain-jerry');
  assert.equal(own.accessMode, 'own');

  const posted: Record<string, unknown>[] = [];
  const startClient = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/catalog')) return new Response(JSON.stringify(catalog));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posted.push(body);
      const requestedTarget = body.target as { agent?: string } | undefined;
      return new Response(JSON.stringify(makeBrainOperationRecord({
        ...record('op-reresolved', 0, 'queued'),
        target: requestedTarget?.agent === 'forrest'
          ? canonicalBrainTarget('forrest', 'read-only')
          : canonicalBrainTarget('jerry', 'own'),
      })));
    } });
  const started = await startClient.start('query', { target: { agent: 'forrest' }, query: 'x' });
  assert.deepEqual(posted[0]?.target, { agent: 'forrest' });
  assert.equal(started.target.domain === 'brain' && started.target.brainId, 'brain-forrest');
  assert.equal('canonicalRoot' in (posted[0]?.target as object), false);
  const ownStarted = await startClient.start('query', { query: 'use my own brain' });
  assert.equal(Object.hasOwn(posted[1] || {}, 'target'), false);
  assert.equal(ownStarted.target.domain === 'brain' && ownStarted.target.brainId, 'brain-jerry');
  assert.equal(ownStarted.target.domain === 'brain' && ownStarted.target.accessMode, 'own');
});

test('short waits use five minutes while query and PGS attachments retain their long defaults', async () => {
  const cases = [
    { kind: 'search' as const, operationId: 'op-short-bound', expected: 5 * 60_000 },
    { kind: 'query' as const, operationId: 'op-query-bound', expected: 90 * 60_000 },
    { kind: 'pgs' as const, operationId: 'op-pgs-bound', expected: 6 * 60 * 60_000 },
  ];
  for (const fixture of cases) {
    const clock = new ManualClock();
    const sse = controlledStream();
    const scheduled: number[] = [];
    let cancelCalls = 0;
    const cancelled = record(fixture.operationId, 2, 'cancelled');
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
        cancelCalls += 1;
        return new Response(JSON.stringify(cancelled));
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify(record(fixture.operationId, 0, 'queued')));
      }
      if (parsed.pathname.endsWith('/result')) {
        return new Response(JSON.stringify(resultEnvelope(cancelled)));
      }
      if (parsed.pathname.endsWith('/events')) {
        return new Response(sse.body, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify(record(fixture.operationId, 1, 'running')));
    };
    const controller = new AbortController();
    const client = new BrainOperationsClient({
      baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl,
      inactivityMs: fixture.expected + 1_000,
      now: clock.now,
      setTimeout: (fn, ms) => { scheduled.push(ms); return clock.setTimeout(fn, ms); },
      clearTimeout: clock.clearTimeout,
    });
    const pending = fixture.kind === 'search'
      ? client.search({ query: 'bound' }, controller.signal)
      : client.query({ query: 'bound', ...(fixture.kind === 'pgs' ? { enablePGS: true } : {}) },
        controller.signal);
    await sse.opened;
    for (let index = 0; index < 50 && !scheduled.includes(fixture.expected); index += 1) {
      await flushMicrotasks();
    }
    assert.ok(scheduled.includes(fixture.expected), fixture.kind);
    if (fixture.kind === 'search') {
      clock.advance(fixture.expected + 1);
      await assert.rejects(pending, /cancelled/);
      assert.equal(cancelCalls, 1, 'the short attachment deadline cancels short work');
    } else {
      controller.abort(Object.assign(new Error('operator_stop'), { code: 'operator_stop' }));
      assert.equal((await pending).state, 'cancelled');
      assert.equal(cancelCalls, 1);
    }
  }
});

test('terminal SSE bytes are descriptive and the protected result route stays canonical', async () => {
  const sse = controlledStream();
  let resultReads = 0;
  let starts = 0;
  const operationId = 'brop_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const terminal = record(operationId, 2, 'complete', { answer: 'untrusted event bytes' });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST') {
      starts += 1;
      return new Response(JSON.stringify(record(operationId, 0, 'queued')));
    }
    if (parsed.pathname.endsWith('/result')) {
      resultReads += 1;
      return new Response(JSON.stringify({ ...resultEnvelope(terminal),
        result: { answer: 'canonical stored bytes' } }));
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(sse.body, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(sse.latestRecord || record(operationId, 1, 'running')));
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  const pending = client.query({ query: 'canonical result' });
  await sse.opened;
  sse.frame(terminal);
  sse.close();
  assert.equal((await pending).result?.answer, 'canonical stored bytes');
  assert.equal(resultReads, 1);
  assert.equal(starts, 1);
});

test('status, result, cancel, and resume stay requester-authorized without a second start', async () => {
  const operationId = 'brop_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  const resumeId = 'brop_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
  const resumeStream = controlledStream();
  let starts = 0;
  let cancels = 0;
  const cancelled = record(operationId, 2, 'cancelled');
  const resumedTerminal = record(resumeId, 2, 'complete', { answer: 'resumed result' });
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (init?.method === 'POST' && parsed.pathname.endsWith('/cancel')) {
      cancels += 1;
      return new Response(JSON.stringify(cancelled));
    }
    if (init?.method === 'POST') {
      starts += 1;
      return new Response('', { status: 500 });
    }
    if (parsed.pathname.endsWith('/result')) {
      const terminal = parsed.pathname.includes(resumeId) ? resumedTerminal : cancelled;
      return new Response(JSON.stringify(resultEnvelope(terminal)));
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response(resumeStream.body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const id = parsed.pathname.includes(resumeId) ? resumeId : operationId;
    return new Response(JSON.stringify(
      id === resumeId && resumeStream.latestRecord
        ? resumeStream.latestRecord
        : record(id, 1, 'running'),
    ));
  };
  const client = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'jerry', fetchImpl });
  assert.equal((await client.inspectOperation(operationId, 'status')).state, 'running');
  assert.equal((await client.inspectOperation(operationId, 'result')).operationId, operationId);
  assert.equal((await client.inspectOperation(operationId, 'cancel')).state, 'cancelled');
  assert.equal(cancels, 1);

  const resumed = client.resumeOperation(resumeId);
  await resumeStream.opened;
  resumeStream.frame(resumedTerminal);
  resumeStream.close();
  assert.equal((await resumed).result?.answer, 'resumed result');
  assert.equal(starts, 0);

  const foreign = new BrainOperationsClient({ baseUrl: 'http://fixture', callerAgent: 'forrest',
    fetchImpl: async () => new Response(JSON.stringify({ error: {
      code: 'access_denied', message: 'requester does not own operation', retryable: false,
    } }), { status: 403 }) });
  await assert.rejects(foreign.getOperation(operationId), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'access_denied');
    assert.equal((error as { httpStatus?: number }).httpStatus, 403);
    return true;
  });
});

test('real store, reader, router, and client preserve exact cancel and no-result terminal envelopes', async (t) => {
  const fixture = await createRealClientBoundary(t);
  const started = await fixture.client.start('query', { query: 'cancel at the real boundary' });
  assert.equal(started.target.domain, 'brain');
  assert.equal(started.target.domain === 'brain' && started.target.accessMode, 'own');

  const cancelled = await fixture.client.inspectOperation(started.operationId, 'cancel');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal('result' in cancelled && cancelled.result, null);
  assert.deepEqual(fixture.cancelRequests, [{
    contentType: 'application/json',
    body: '{}',
  }]);
  const resumedCancelled = await fixture.client.resumeOperation(started.operationId);
  assert.equal(resumedCancelled.state, 'cancelled');
  assert.equal(resumedCancelled.result, null);
  assert.equal(resumedCancelled.attachmentState, 'closed');

  for (const state of ['failed', 'interrupted'] as const) {
    const operation = await fixture.coordinator.start({
      requestId: `terminal-${state}`,
      operationType: 'query',
      parameters: { query: `terminal ${state}` },
    });
    const terminal = await fixture.store.transition(operation.operationId, {
      expectedVersion: operation.recordVersion,
      state,
      error: { code: state, message: `${state} without a result`, retryable: true },
    });
    assert.equal(terminal.result, null);
    assert.equal(terminal.resultHandle, null);
    const inspected = await fixture.client.inspectOperation(operation.operationId, 'result');
    assert.equal(inspected.state, state);
    assert.equal(inspected.result, null);
    const resumed = await fixture.client.resumeOperation(operation.operationId);
    assert.equal(resumed.state, state);
    assert.equal(resumed.result, null);
    assert.equal(resumed.attachmentState, 'closed');
  }

  const running = await fixture.coordinator.start({
    requestId: 'running-result-unavailable',
    operationType: 'query',
    parameters: { query: 'still running' },
  });
  await assert.rejects(
    fixture.client.getResult(running.operationId),
    (error: unknown) => (error as { code?: string }).code === 'result_unavailable',
  );
});

test('a protected result read failure after terminal status is never converted into detached success', async () => {
  const operationId = 'brop_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
  const clock = new ManualClock();
  const sse = controlledStream();
  let detachCalls = 0;
  const terminal = record(operationId, 2, 'complete', { answer: 'must not be trusted' });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    inactivityMs: 10,
    queryWaitMs: 100,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
        detachCalls += 1;
        return new Response(JSON.stringify(terminal));
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify(record(operationId, 0, 'running')));
      }
      if (parsed.pathname.endsWith('/events')) {
        return new Response(sse.body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (parsed.pathname.endsWith('/result')) {
        return new Response(JSON.stringify({ error: {
          code: 'result_corrupt', message: 'canonical result bytes failed verification', retryable: false,
        } }), { status: 500 });
      }
      return new Response(JSON.stringify(terminal));
    },
  });
  const pending = client.query({ query: 'protect result failure' });
  await sse.opened;
  sse.frame({
    type: 'progress', operationId, eventSequence: 1, sequence: 1,
    at: '2026-07-10T12:00:01.000Z', completed: 1,
  } as never);
  await flushMicrotasks();
  clock.advance(11);
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'result_corrupt');
    return true;
  });
  assert.equal(detachCalls, 0);
});

test('store-shaped gaps omit status, close the old body, and reuse one attachment after authenticated recovery', async () => {
  const operationId = 'brop_GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
  let oldBodyCancelled = false;
  let eventRequests = 0;
  let statusReads = 0;
  let terminalAvailable = false;
  const attachmentIds: string[] = [];
  const firstBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        type: 'event_gap', operationId, eventSequence: 5,
        oldestSequence: 2, latestSequence: 5,
      })}\n\n`));
    },
    cancel() { oldBodyCancelled = true; },
  });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    attachmentIdFactory: () => 'attachment-gap-real-shape',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (init?.method === 'POST' && parsed.pathname.endsWith('/detach')) {
        return new Response(JSON.stringify(record(operationId, 5, 'running')));
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify(record(operationId, 0, 'running')));
      }
      if (parsed.pathname.endsWith('/result')) {
        return new Response(JSON.stringify(resultEnvelope(
          record(operationId, 6, 'complete', { answer: 'gap recovered' }),
        )));
      }
      if (parsed.pathname.endsWith(`/${operationId}`)) {
        statusReads += 1;
        return new Response(JSON.stringify(terminalAvailable
          ? record(operationId, 6, 'complete', { answer: 'descriptive only' })
          : record(operationId, 5, 'running')));
      }
      if (parsed.pathname.endsWith('/events')) {
        eventRequests += 1;
        attachmentIds.push(String(parsed.searchParams.get('attachmentId')));
        if (eventRequests === 1) {
          return new Response(firstBody, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (!oldBodyCancelled) {
          return new Response(JSON.stringify({ error: {
            code: 'attachment_already_attached', message: 'old body is still attached', retryable: true,
          } }), { status: 409 });
        }
        terminalAvailable = true;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
            type: 'terminal', operationId, eventSequence: 6, sequence: 6,
            state: 'complete', at: '2026-07-10T12:00:06.000Z',
          })}\n\n`));
          controller.close();
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('', { status: 404 });
    },
  });
  const result = await client.query({ query: 'recover an actual store gap' });
  assert.equal(result.result?.answer, 'gap recovered');
  assert.equal(oldBodyCancelled, true);
  assert.equal(eventRequests, 2);
  assert.ok(statusReads >= 2);
  assert.deepEqual(new Set(attachmentIds), new Set(['attachment-gap-real-shape']));
});

test('real coordinator and router detach then reopen the same attachment ID across a compacted gap', async (t) => {
  const fixture = await createRealReconnectBoundary(t);
  const controller = new AbortController();
  const pending = fixture.client.wait(fixture.initial.operationId, {
    operationType: 'query',
    initial: fixture.initial,
    signal: controller.signal,
    waitMs: 60_000,
  });
  const secondAttach = await fixture.secondAttach;
  controller.abort(Object.assign(new Error('transport_disconnect'), {
    code: 'transport_disconnect',
  }));
  const result = await pending;
  assert.deepEqual(secondAttach, { ok: true });
  assert.equal(fixture.attachCalls, 2);
  assert.equal(result.attachmentState, 'detached');
  assert.equal(result.state, 'running');
  assert.equal((await fixture.store.getAttachment(
    fixture.initial.operationId,
    'real-gap-attachment',
  )).state, 'detached');
});

test('progress, phase, and terminal notifications never masquerade as operation records', async () => {
  const operationId = 'brop_HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH';
  const sse = controlledStream();
  const activities: Array<{
    type: string; eventSequence: number; sequence: number;
    state: string; phase: string | null; updatedAt: string;
  }> = [];
  let statusReads = 0;
  let resultReads = 0;
  let terminalAvailable = false;
  const terminal = record(operationId, 3, 'complete', { answer: 'authenticated terminal' });
  const client = new BrainOperationsClient({
    baseUrl: 'http://fixture',
    callerAgent: 'jerry',
    onActivity: (activity) => activities.push({
      type: activity.type,
      eventSequence: activity.eventSequence,
      sequence: activity.sequence,
      state: activity.state,
      phase: activity.phase,
      updatedAt: activity.updatedAt,
    }),
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (init?.method === 'POST') {
        return new Response(JSON.stringify(record(operationId, 0, 'running')));
      }
      if (parsed.pathname.endsWith('/events')) {
        return new Response(sse.body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (parsed.pathname.endsWith('/result')) {
        resultReads += 1;
        return new Response(JSON.stringify(resultEnvelope(terminal)));
      }
      statusReads += 1;
      return new Response(JSON.stringify(terminalAvailable
        ? terminal
        : record(operationId, 0, 'running')));
    },
  });
  const pending = client.query({ query: 'typed notifications' });
  await sse.opened;
  sse.frame({
    type: 'progress', operationId, eventSequence: 1, sequence: 1,
    at: '2026-07-10T12:00:01.000Z', state: 'queued', completed: 1,
  } as never);
  sse.frame({
    type: 'phase', operationId, eventSequence: 2, sequence: 2,
    at: '2026-07-10T12:00:02.000Z', phase: 'synthesizing',
  } as never);
  terminalAvailable = true;
  sse.frame({
    type: 'terminal', operationId, eventSequence: 3, sequence: 3,
    at: '2026-07-10T12:00:03.000Z', state: 'complete',
  } as never);
  sse.close();
  const result = await pending;
  assert.equal(result.result?.answer, 'authenticated terminal');
  assert.equal(statusReads, 1, 'terminal notification requires authenticated status');
  assert.equal(resultReads, 1);
  assert.deepEqual(activities, [
    { type: 'progress', eventSequence: 1, sequence: 1, state: 'queued', phase: 'provider', updatedAt: '2026-07-10T12:00:01.000Z' },
    { type: 'phase', eventSequence: 2, sequence: 2, state: 'running', phase: 'synthesizing', updatedAt: '2026-07-10T12:00:02.000Z' },
    { type: 'terminal', eventSequence: 3, sequence: 3, state: 'complete', phase: 'done', updatedAt: '2026-07-10T12:00:03.000Z' },
  ]);
});
