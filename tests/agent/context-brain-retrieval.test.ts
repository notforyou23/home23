import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext } from '../../src/agent/context-assembly.js';
import { deferred, flushMicrotasks } from '../helpers/manual-clock.js';

test('automatic retrieval sends topK and keeps local trigger matches when remote search fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-brain-'));
  const workspace = join(root, 'instances', 'jerry', 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'RECENT.md'), '# Recent\nLocal surface');
  let searchRequest: Record<string, unknown> | null = null;
  try {
    const result = await assembleContext('remember canary', 'chat-1', [], {
      workspacePath: workspace,
      brainDir: join(root, 'instances', 'jerry', 'brain'),
      enginePort: 5002,
      sessionId: 'chat-1',
      signal: AbortSignal.timeout(1_000),
      contextSearch: async (request: Record<string, unknown>, signal: AbortSignal) => {
        searchRequest = request;
        assert.equal(signal.aborted, false);
        throw Object.assign(new Error('dashboard memory route'), { code: 'source_unavailable' });
      },
      triggerIndex: { evaluate: () => [{
        memoryId: 'm1',
        memory: {
          title: 'Canary', statement: 'local trigger survives', confidence: { score: 0.9 },
        },
        trigger: { trigger_type: 'keyword', condition: 'canary' },
      }] } as never,
    });
    assert.equal(searchRequest?.topK, 8);
    assert.equal('limit' in (searchRequest || {}), false);
    assert.match(result.block, /local trigger survives/);
    assert.match(result.block, /source_unavailable.*dashboard memory route|dashboard memory route/s);
    assert.match(result.block, /success is not yet established/i);
    assert.doesNotMatch(result.block, /will succeed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic retrieval fails open on its own short deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-brain-timeout-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  let retrievalSignal: AbortSignal | null = null;
  try {
    const result = await assembleContext('quick reply', 'chat-timeout', [], {
      workspacePath: workspace,
      brainDir: join(root, 'brain'),
      enginePort: 5002,
      sessionId: 'chat-timeout',
      signal: new AbortController().signal,
      brainSearchTimeoutMs: 5,
      contextSearch: async (_request: Record<string, unknown>, signal: AbortSignal) => {
        retrievalSignal = signal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
        return {
          results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' },
        };
      },
      triggerIndex: { evaluate: () => [] } as never,
    });

    assert.equal(retrievalSignal?.aborted, true);
    assert.equal(result.degraded, true);
    assert.match(result.retrievalError || '', /timeout|timed out/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent context retrieval keeps per-turn clients, signals, and cancellation isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-turns-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const controllers = [new AbortController(), new AbortController()];
  const calls: Array<{ turn: number; signal: AbortSignal }> = [];
  const release = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()];
  try {
    const pending = controllers.map((controller, turn) => assembleContext(
      `turn ${turn}`,
      `chat-${turn}`,
      [],
      {
        workspacePath: workspace,
        brainDir: join(root, `brain-${turn}`),
        enginePort: 5002,
        sessionId: `chat-${turn}`,
        signal: controller.signal,
        contextSearch: async (_request: Record<string, unknown>, signal: AbortSignal) => {
          calls.push({ turn, signal });
          return Promise.race([
            release[turn]!.promise,
            new Promise((_, reject) => signal.addEventListener(
              'abort', () => reject(signal.reason), { once: true },
            )),
          ]);
        },
        triggerIndex: { evaluate: () => [] } as never,
      },
    ));
    await flushMicrotasks();
    const reason = Object.assign(new Error('cancel turn zero'), { code: 'turn_cancelled' });
    controllers[0]!.abort(reason);
    release[1]!.resolve({
      results: [{ id: 'turn-one-only', concept: 'turn-one-only', similarity: 0.9 }],
      sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
    });
    await assert.rejects(pending[0]!, (error) => error === reason);
    const second = await pending[1]!;
    assert.notEqual(calls[0]!.signal, controllers[0]!.signal);
    assert.notEqual(calls[1]!.signal, controllers[1]!.signal);
    assert.notEqual(calls[0]!.signal, calls[1]!.signal);
    assert.equal(calls[0]!.signal.aborted, true);
    assert.equal(calls[0]!.signal.reason, reason);
    assert.equal(calls[1]!.signal.aborted, false);
    assert.match(second.block, /turn-one-only/);
    assert.equal(controllers[1]!.signal.aborted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('healthy empty, filtered, and corpus-empty outcomes remain independent from source health', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-evidence-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  try {
    for (const matchOutcome of ['no_match', 'filtered', 'corpus_empty'] as const) {
      const result = await assembleContext('canary', `chat-${matchOutcome}`, [], {
        workspacePath: workspace,
        brainDir: join(root, 'brain'),
        enginePort: 5002,
        sessionId: `chat-${matchOutcome}`,
        signal: new AbortController().signal,
        contextSearch: async () => ({
          results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome },
        }),
        triggerIndex: { evaluate: () => [] } as never,
      });
      const posture = result.events.find((event) => event.event_type === 'MemoryActivationPosture');
      assert.equal(posture?.payload.sourceHealth, 'healthy');
      assert.equal(posture?.payload.matchOutcome, matchOutcome);
      assert.equal(posture?.payload.activationStatus, matchOutcome);
      assert.equal(result.degraded, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('degraded source can preserve partial cues without claiming a healthy route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-partial-cues-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  try {
    const result = await assembleContext('partial', 'chat-partial', [], {
      workspacePath: workspace,
      brainDir: join(root, 'brain'),
      enginePort: 5002,
      sessionId: 'chat-partial',
      signal: new AbortController().signal,
      contextSearch: async () => ({
        results: [{ id: 'partial-1', concept: 'retained partial cue', similarity: 0.8 }],
        sourceEvidence: { sourceHealth: 'degraded', matchOutcome: 'matches' },
      }),
      triggerIndex: { evaluate: () => [] } as never,
    });
    assert.equal(result.degraded, true);
    assert.equal(result.brainCueCount, 1);
    assert.match(result.block, /retained partial cue/);
    assert.match(result.block, /sourceHealth=degraded/);
    assert.match(result.block, /success is not yet established/);
    assert.equal(result.retrievalError, 'source reported degraded');
    assert.ok(result.events.some((event) => event.event_type === 'RetrievalDegraded'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
