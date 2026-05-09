import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-openai-key';
const { PulseRemarks } = require('../../../engine/src/pulse/pulse-remarks.js');

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
