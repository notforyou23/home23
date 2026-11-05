import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessChannel, _test } from '../../../../engine/src/channels/machine/process-channel.js';

test('ProcessChannel parses ps output ordered by CPU', () => {
  const sample = `
  101     1  12.5  1.0 12345 01:02:03 node /tmp/a.js
  202   101  98.4  0.5 54321    00:09 python worker.py
  `;
  const rows = _test.parsePsOutput(sample, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 202);
  assert.equal(rows[0].cpuPct, 98.4);
  assert.equal(rows[0].command, 'python worker.py');
  assert.equal(rows[1].rssBytes, 12345 * 1024);
});

test('ProcessChannel can parse rows for memory attribution', () => {
  const sample = `
  101     1  12.5  1.0 12345 01:02:03 node /tmp/a.js
  202   101  98.4  0.5 54321    00:09 python worker.py
  `;
  const rows = _test.parsePsRows(sample);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.pid === 202).rssBytes, 54321 * 1024);
});

test('ProcessChannel treats unsafe PM2 restart counters as unknown', () => {
  assert.equal(_test.normalizePm2RestartCount(3), 3);
  assert.equal(_test.normalizePm2RestartCount('3'), 3);
  assert.equal(_test.normalizePm2RestartCount('171111111111111111111111111111111'), null);
  assert.equal(_test.normalizePm2RestartCount({}), null);
});

test('ProcessChannel emits collected observation with topology and crystallizes hot process', async () => {
  const channel = new ProcessChannel({
    sample: async () => ({
      at: '2026-05-02T03:45:00.000Z',
      topN: 1,
      processCount: 1,
      topCpuPct: 75,
      totalCpuPctTopN: 75,
      topRssBytes: 2048,
      totalRssBytesTopN: 2048,
      processes: [{
        pid: 1,
        ppid: 0,
        cpuPct: 75,
        memPct: 1,
        rssBytes: 1024,
        elapsed: '00:01',
        command: 'node /Users/jtr/_JTR23_/release/home23/engine/src/index.js',
        pm2Name: 'home23-forrest',
        script: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js',
      }],
      memoryProcesses: [{
        pid: 2,
        ppid: 0,
        cpuPct: 5,
        memPct: 3,
        rssBytes: 2048,
        elapsed: '00:02',
        command: 'node /Users/jtr/_JTR23_/release/home23/engine/src/index.js',
        pm2Name: 'home23-jerry',
        script: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js',
      }],
    }),
    hotProcessThreshold: 50,
  });
  const raw = (await channel.poll())[0];
  const parsed = channel.parse(raw);
  const obs = channel.verify(parsed);
  assert.equal(obs.channelId, 'machine.process');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.verifierId, 'os:ps-top-cpu');
  assert.equal(obs.payload.processes[0].topology.role, 'agent-engine');
  assert.equal(obs.payload.memoryProcesses[0].topology.agentName, 'jerry');
  assert.equal(obs.payload.processes[0].topology.agentName, 'forrest');
  assert.equal(obs.payload.processes[0].topology.expectedParallelRole, true);
  assert.ok(channel.crystallize(obs));
});
