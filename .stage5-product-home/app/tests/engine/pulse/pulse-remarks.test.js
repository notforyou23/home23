import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-openai-key';
const { PulseRemarks, isCognitionInternalProblem } = require('../../../engine/src/pulse/pulse-remarks.js');

function baseSnapshot() {
  return {
    cycle: 42,
    ts: new Date().toISOString(),
    thoughts: [],
    actions: [],
    requested: [],
    notifications: [],
    goals: { active: [], broken: [], completed: [], total: 0 },
    brain: { nodes: 3, edges: 2, topActive: [] },
    surfaces: {},
    sensors: {},
    brainState: null,
  };
}

function writeSignals(dir, signals) {
  fs.writeFileSync(
    path.join(dir, 'signals.jsonl'),
    signals.map((signal) => JSON.stringify(signal)).join('\n') + '\n',
  );
}

test('pulse brief suppresses positive signals for problems that are currently open', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const now = new Date().toISOString();
  writeSignals(brainDir, [
    {
      id: 'sig-cleared-timeout',
      type: 'resolved',
      source: 'live-problems',
      title: 'Cycle timeout check cleared',
      message: 'Cycle timeout check cleared 32m ago.',
      evidence: { problemId: 'jerry_engine_cycle_timeouts_clear' },
      ts: now,
    },
    {
      id: 'sig-good-save',
      type: 'observation',
      source: 'persistence',
      title: 'Brain persistence saved',
      message: 'Sidecar save completed with unique temp paths.',
      evidence: { problemId: 'different_problem' },
      ts: now,
    },
  ]);

  const pulse = new PulseRemarks({
    logsDir: brainDir,
    liveProblems: {
      briefSnapshot() {
        return {
          open: [{
            id: 'jerry_engine_cycle_timeouts_clear',
            claim: 'Jerry engine cycle timeout log is clear',
            detail: '1 matching log entries in last 30m',
            ageMin: 2,
            openedAt: now,
          }],
          chronic: [],
          resolvedJustNow: [],
          counts: { open: 1, chronic: 0, resolved: 0, unverifiable: 0 },
        };
      },
    },
  });

  const brief = pulse.synthesize(baseSnapshot());
  assert.deepEqual(brief.signals.map((s) => s.id), ['sig-good-save']);

  const { userMessage } = pulse.buildPrompt(brief);
  assert.match(userMessage, /jerry_engine_cycle_timeouts_clear/);
  assert.match(userMessage, /Brain persistence saved/);
  assert.doesNotMatch(userMessage, /Cycle timeout check cleared/);
});

test('pulse brief keeps escalated open problems visible even after prior mention', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const now = new Date().toISOString();
  const pulse = new PulseRemarks({
    logsDir: brainDir,
    liveProblems: {
      briefSnapshot() {
        return {
          open: [{
            id: 'jerry_engine_cycle_timeouts_clear',
            claim: 'Jerry engine cycle timeout log is clear',
            detail: '1 matching log entries in last 30m',
            ageMin: 55,
            openedAt: '2026-05-10T22:07:33.764Z',
            escalatedAt: '2026-05-10T22:10:34.129Z',
            lastMentionedInPulseAt: now,
            escalated: true,
          }],
          chronic: [],
          resolvedJustNow: [],
          counts: { open: 1, chronic: 0, resolved: 0, unverifiable: 0 },
        };
      },
    },
  });

  const brief = pulse.synthesize(baseSnapshot());
  const { userMessage } = pulse.buildPrompt(brief);

  assert.match(userMessage, /jerry_engine_cycle_timeouts_clear/);
  assert.match(userMessage, /escalated/);
  assert.doesNotMatch(userMessage, /No open, chronic, or newly resolved live problems/);
});

test('pulse brief warns when stable open problems are omitted from the visible brief', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const now = new Date().toISOString();
  const pulse = new PulseRemarks({
    logsDir: brainDir,
    liveProblems: {
      briefSnapshot() {
        return {
          open: [{
            id: 'stable_problem',
            claim: 'Stable problem remains open',
            detail: 'unchanged',
            ageMin: 90,
            openedAt: '2026-05-10T21:00:00.000Z',
            lastMentionedInPulseAt: now,
          }],
          chronic: [],
          resolvedJustNow: [],
          counts: { open: 1, chronic: 0, resolved: 0, unverifiable: 0 },
        };
      },
    },
  });

  const brief = pulse.synthesize(baseSnapshot());
  const { userMessage } = pulse.buildPrompt(brief);

  assert.match(userMessage, /1 stable-known open problem/);
  assert.match(userMessage, /Do not claim there are no open problems/);
  assert.doesNotMatch(userMessage, /No open, chronic, or newly resolved live problems/);
});

test('pulse voice is a five-minute house voice even during quiet cycles', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const pulse = new PulseRemarks({ logsDir: brainDir, agentName: 'jerry' });
  const now = Date.parse('2026-05-27T14:00:00.000Z');
  const brief = pulse.synthesize(baseSnapshot());

  pulse.lastRemarkAt = now - (4 * 60 * 1000 + 59 * 1000);
  assert.equal(pulse.shouldGenerateRemark(brief, now), false);

  pulse.lastRemarkAt = now - 5 * 60 * 1000;
  assert.equal(pulse.shouldGenerateRemark(brief, now), true);
  assert.equal(pulse.nextDelayAfterTick(true), 5 * 60 * 1000);

  const { systemPrompt, userMessage } = pulse.buildPrompt(brief);
  assert.match(systemPrompt, /cool, direct, laid back/i);
  assert.match(systemPrompt, /whimsical/i);
  assert.match(userMessage, /every five minutes/i);
  assert.match(userMessage, /coming up|follow-up|quirky insight|joke|quote/i);
});

// ---------------------------------------------------------------------------
// isCognitionInternalProblem() -- the pure gate for self-report content
// ---------------------------------------------------------------------------

test('isCognitionInternalProblem: matches the three seeds behind the cited self-report example', () => {
  assert.equal(isCognitionInternalProblem({ id: 'jerry_create_file_tool_writes_to_disk' }), true);
  assert.equal(isCognitionInternalProblem({ id: 'thoughts_flowing' }), true);
  assert.equal(isCognitionInternalProblem({ id: 'jerry_dispatch_ledger_write_path_healthy' }), true);
});

test('isCognitionInternalProblem: does not match real-world or other engine-uptime seeds', () => {
  assert.equal(isCognitionInternalProblem({ id: 'sauna_sensor_fresh' }), false);
  assert.equal(isCognitionInternalProblem({ id: 'weather_sensor_fresh' }), false);
  assert.equal(isCognitionInternalProblem({ id: 'health_log_fresh' }), false);
  // Deliberately left alone -- not part of the cited example, has plausible
  // jtr relevance (uptime/cost/host resources this fix does not touch).
  assert.equal(isCognitionInternalProblem({ id: 'jerry_harness_online' }), false);
  assert.equal(isCognitionInternalProblem({ id: 'jerry_cpu_pressure_clear' }), false);
  assert.equal(isCognitionInternalProblem({ id: 'disk_free_ok' }), false);
  assert.equal(isCognitionInternalProblem({ id: 'brain_graph_populated' }), false);
});

test('isCognitionInternalProblem: handles missing/malformed input without throwing', () => {
  assert.equal(isCognitionInternalProblem(null), false);
  assert.equal(isCognitionInternalProblem(undefined), false);
  assert.equal(isCognitionInternalProblem({}), false);
});

// ---------------------------------------------------------------------------
// pulse brief: RESOLVED cognition-internal checks are dropped; OPEN/CHRONIC
// instances and real-world resolutions are untouched.
// ---------------------------------------------------------------------------

test('pulse brief drops RESOLVED self-report about the engine\'s own cognitive machinery, keeps real-world resolutions', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const now = new Date().toISOString();
  const pulse = new PulseRemarks({
    logsDir: brainDir,
    liveProblems: {
      briefSnapshot() {
        return {
          open: [],
          chronic: [],
          resolvedJustNow: [
            { id: 'jerry_create_file_tool_writes_to_disk', claim: "File tool writes bytes to disk", resolvedAt: now },
            { id: 'thoughts_flowing', claim: 'Cognitive loop is producing thoughts', resolvedAt: now },
            { id: 'jerry_dispatch_ledger_write_path_healthy', claim: 'Dispatch ledger write path is healthy', resolvedAt: now },
            { id: 'sauna_sensor_fresh', claim: 'Sauna sensor data is fresh', resolvedAt: now },
          ],
          counts: { open: 0, chronic: 0, resolved: 4, unverifiable: 0 },
        };
      },
    },
  });

  const brief = pulse.synthesize(baseSnapshot());
  assert.deepEqual(brief.liveProblems.resolvedJustNow.map((p) => p.id), ['sauna_sensor_fresh']);

  const { userMessage } = pulse.buildPrompt(brief);
  assert.match(userMessage, /sauna_sensor_fresh/);
  assert.doesNotMatch(userMessage, /create_file_tool_writes_to_disk/);
  assert.doesNotMatch(userMessage, /thoughts_flowing/);
  assert.doesNotMatch(userMessage, /dispatch_ledger_write_path_healthy/);
});

test('pulse brief keeps OPEN and CHRONIC cognition-internal problems fully visible -- only the RESOLVED acknowledgment is suppressed', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const now = new Date().toISOString();
  const pulse = new PulseRemarks({
    logsDir: brainDir,
    liveProblems: {
      briefSnapshot() {
        return {
          open: [{
            id: 'thoughts_flowing',
            claim: 'Cognitive loop stalled',
            detail: 'no new thoughts in 25 min',
            ageMin: 25,
            openedAt: now,
          }],
          chronic: [{
            id: 'jerry_dispatch_ledger_write_path_healthy',
            claim: 'Dispatch ledger write path is unhealthy',
            detail: 'remediation exhausted',
            ageMin: 200,
            openedAt: now,
          }],
          resolvedJustNow: [],
          counts: { open: 1, chronic: 1, resolved: 0, unverifiable: 0 },
        };
      },
    },
  });

  const brief = pulse.synthesize(baseSnapshot());
  const { userMessage } = pulse.buildPrompt(brief);

  // Something actually broken is real information regardless of what it is.
  assert.match(userMessage, /thoughts_flowing/);
  assert.match(userMessage, /dispatch_ledger_write_path_healthy/);
  assert.match(userMessage, /Cognitive loop stalled/);
  assert.match(userMessage, /remediation exhausted/i);
});

test('pulse brief also drops the SIGNALS-block echo of the same self-report (live-problems/loop.js mirrors every resolution into signals.jsonl)', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-remarks-'));
  const now = new Date().toISOString();
  writeSignals(brainDir, [
    {
      id: 'sig-file-tool',
      type: 'resolved',
      source: 'live-problems',
      title: 'resolved: File tool writes bytes to disk',
      message: 'File tool writes bytes to disk',
      evidence: { problemId: 'jerry_create_file_tool_writes_to_disk' },
      ts: now,
    },
    {
      id: 'sig-sauna',
      type: 'resolved',
      source: 'live-problems',
      title: 'resolved: Sauna sensor data is fresh',
      message: 'Sauna sensor data is fresh',
      evidence: { problemId: 'sauna_sensor_fresh' },
      ts: now,
    },
  ]);

  const pulse = new PulseRemarks({ logsDir: brainDir });
  const brief = pulse.synthesize(baseSnapshot());

  assert.deepEqual(brief.signals.map((s) => s.id), ['sig-sauna']);
  const { userMessage } = pulse.buildPrompt(brief);
  assert.match(userMessage, /Sauna sensor data is fresh/);
  assert.doesNotMatch(userMessage, /File tool writes bytes to disk/);
});
