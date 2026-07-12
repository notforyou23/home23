import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assembleContext, buildWorkerContextSection } from '../../src/agent/context-assembly.js';
import type { EventEnvelope } from '../../src/types.js';

test('buildWorkerContextSection shows roster and recent receipts without transcripts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-worker-context-'));
  mkdirSync(path.join(root, 'instances', 'workers', 'systems'), { recursive: true });
  mkdirSync(path.join(root, 'instances', 'jerry', 'brain'), { recursive: true });
  writeFileSync(path.join(root, 'instances', 'workers', 'systems', 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose host issues.',
    'visibleTo:',
    '  - jerry'
  ].join('\n'));
  writeFileSync(path.join(root, 'instances', 'jerry', 'brain', 'worker-runs.jsonl'), JSON.stringify({
    runId: 'wr_1',
    worker: 'systems',
    status: 'no_change',
    verifierStatus: 'pass',
    summary: 'Checked host signal.',
    transcriptIncluded: false
  }) + '\n');

  const section = buildWorkerContextSection(root, 'jerry');
  assert.match(section, /systems/);
  assert.match(section, /Checked host signal/);
  assert.doesNotMatch(section, /transcript\.md/);
});

test('assembleContext emits a memory activation posture when brain search returns no cues', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-context-activation-'));
  const workspacePath = path.join(root, 'instances', 'jerry', 'workspace');
  const brainDir = path.join(root, 'instances', 'jerry', 'brain');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(brainDir, { recursive: true });
  writeFileSync(path.join(workspacePath, 'RECENT.md'), 'Current verified surface.');

  const emitted: EventEnvelope[] = [];
  const ledger = {
    emit(events: EventEnvelope | EventEnvelope[]) {
      emitted.push(...(Array.isArray(events) ? events : [events]));
    },
  };

  const result = await assembleContext(
      'what port was the dashboard using last time?',
      'chat-activation',
      [{ role: 'user', content: 'we discussed dashboard ports yesterday' }],
      {
        workspacePath,
        brainDir,
        enginePort: 59999,
        sessionId: 'chat-activation',
        contextSearch: async () => ({
          results: [],
          sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' },
        }),
        signal: new AbortController().signal,
      },
      ledger as never,
    );

    const posture = result.events.find(event => event.event_type === 'MemoryActivationPosture');
    assert.ok(posture, 'expected MemoryActivationPosture event');
    assert.equal(posture.payload.schema, 'home23.memory-activation-posture.v1');
    assert.deepEqual(posture.payload.sourceIssues, [69]);
    assert.equal(posture.payload.activationStatus, 'no_match');
    assert.equal(posture.payload.searchAttempted, true);
    assert.equal(posture.payload.brainCueCount, 0);
    assert.equal(posture.payload.triggerCount, 0);
    assert.match(String(posture.payload.queryPreview), /dashboard/);
    assert.equal(result.brainCueCount, 0);
    assert.ok(emitted.some(event => event.event_type === 'MemoryActivationPosture'));
});
