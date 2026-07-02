import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateRecentDigest } = require('../../../engine/src/core/curator-llm-tools.js');

test('generateRecentDigest writes RECENT.md through durable fsync path', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'home23-recent-workspace-'));
  const brainDir = mkdtempSync(join(tmpdir(), 'home23-recent-brain-'));
  const client = {
    async generate() {
      return { text: '**Last 24h**\n- event recorded\n\n**Open threads**\n- none\n\n**State changes**\n- RECENT refreshed' };
    },
  };

  const result = await generateRecentDigest({
    workspacePath,
    brainDir,
    journal: [{ cycle: 1, role: 'curator', thought: 'RECENT should refresh.' }],
    client,
    cadenceMs: 0,
  });

  const recentPath = join(workspacePath, 'RECENT.md');
  const content = readFileSync(recentPath, 'utf8');
  assert.equal(result.written, true);
  assert.match(content, /# Recent Activity/);
  assert.match(content, /RECENT refreshed/);
  assert.ok(statSync(recentPath).size > 0);
});

test('generateRecentDigest rejects stale Forrest feel-route blocker when correction evidence is current', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'home23-forrest-recent-'));
  const workspacePath = join(rootDir, 'instances', 'forrest', 'workspace');
  const brainDir = join(rootDir, 'instances', 'forrest', 'brain');
  const homeRoot = join(workspacePath, '..', '..', '..');
  mkdirSync(brainDir, { recursive: true });
  mkdirSync(join(workspacePath, 'health_jtr', 'ledgers'), { recursive: true });
  mkdirSync(join(workspacePath, 'scripts'), { recursive: true });
  mkdirSync(join(homeRoot, 'engine', 'src', 'utils'), { recursive: true });

  writeFileSync(join(brainDir, 'live-problems.json'), JSON.stringify({
    problems: [{ id: 'forrest_dashboard_ping', state: 'resolved' }],
  }));
  writeFileSync(join(workspacePath, 'health_jtr', 'ledgers', 'subjective_state.jsonl'), [
    JSON.stringify({
      timestamp: '2026-06-03T17:50:24.682200+00:00',
      note: 'First run back after 37 days off. 10 min treadmill, 0.94mi.',
    }),
    JSON.stringify({
      timestamp: '2026-06-03T22:17:22.725978+00:00',
      note: 'CORRECTION: left leg deadness was present but RESOLVED — went away.',
    }),
    '',
  ].join('\n'));
  writeFileSync(join(workspacePath, 'scripts', 'health-api.py'), 'def append_jsonl_durable():\n    return {"durability": True}\n');
  writeFileSync(join(homeRoot, 'engine', 'src', 'utils', 'durable-write.js'), 'function appendJsonlDurableSync() {}\n');

  const client = {
    async generate() {
      return {
        text: [
          '**Last 24h**',
          '- health activity',
          '',
          '**Open threads**',
          '- `/api/feel` endpoint unwired 167+ cycles — gates daily subjective-state floor-check',
          '',
          '**State changes**',
          '- none',
        ].join('\n'),
      };
    },
  };

  await generateRecentDigest({
    workspacePath,
    brainDir,
    journal: [{ cycle: 1, role: 'curator', thought: '/api/feel is still unwired.' }],
    agentName: 'forrest',
    client,
    cadenceMs: 0,
  });

  const content = readFileSync(join(workspacePath, 'RECENT.md'), 'utf8');
  assert.doesNotMatch(content, /endpoint unwired/);
  assert.match(content, /June 3 subjective data present/);
  assert.match(content, /live-problems active: 0/);
});
