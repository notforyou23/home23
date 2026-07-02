import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Home23BriefsService } = require('../../engine/src/dashboard/home23-briefs.js');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 2));
}

function writeJsonl(file, rows) {
  write(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('Briefs service turns Jerry and Forrest artifacts into readable dashboard documents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-briefs-'));
  try {
    write(
      path.join(root, 'instances/jerry/workspace/reports/x/agency.md'),
      '# X Timeline Read\n\nThis belongs in the dashboard.\n\n- one signal\n- one action\n'
    );
    write(
      path.join(root, 'instances/forrest/workspace/insights/2026-05-27.md'),
      '# Field Read\n\nPressure is dropping, keep it easy.\n'
    );
    write(
      path.join(root, 'instances/forrest/workspace/sessions/active-dashboard-forrest.md'),
      '# Active Conversation (live snapshot)\n\n- **chatId:** codex-forrest-cron-repair\n- **messages:** 4\n- **updated:** 2026-05-27T19:07:32.426Z\n\n---\n\n**User:** Use cron_run once for job_id agent-d685. Report only status.\n\n**Agent:** **status:** ok\n**consecutiveErrors:** 0\n'
    );
    writeJson(path.join(root, 'instances/jerry/conversations/cron-jobs.json'), [
      {
        id: 'job-human',
        name: 'field-report-cycle',
        enabled: true,
        payload: { kind: 'agentTurn' },
        delivery: { mode: 'summary', channel: 'telegram', to: '123456789' },
        state: { lastRunAtMs: Date.parse('2026-05-27T18:07:00Z'), lastStatus: 'ok' },
      },
      {
        id: 'job-mechanical',
        name: 'sauna-tile-bridge',
        enabled: true,
        payload: { kind: 'exec' },
        delivery: { mode: 'none' },
        state: { lastRunAtMs: Date.parse('2026-05-27T18:08:00Z'), lastStatus: 'ok' },
      },
    ]);
    writeJsonl(path.join(root, 'instances/jerry/conversations/cron-runs/job-human.jsonl'), [
      {
        runId: 'run-human',
        timestamp: '2026-05-27T18:07:00Z',
        status: 'ok',
        response: 'From the inside: wrote the next **curriculum** unit using `STATE.json` and set `units_completed`.\n\nAGENCY_INTAKE_PACKET: {"ignore":true}',
        durationMs: 42,
      },
    ]);
    writeJsonl(path.join(root, 'instances/jerry/conversations/cron-runs/job-mechanical.jsonl'), [
      {
        runId: 'run-mechanical',
        timestamp: '2026-05-27T18:08:00Z',
        status: 'ok',
        response: 'ok',
        durationMs: 4,
      },
    ]);
    writeJson(
      path.join(root, 'instances/workers/systems/runs/wr_1/receipt.json'),
      {
        runId: 'wr_1',
        worker: 'systems',
        ownerAgent: 'forrest',
        status: 'fixed',
        verifierStatus: 'pass',
        finishedAt: '2026-05-27T18:09:00Z',
        summary: 'Forrest verifier passed with durable evidence.',
      }
    );

    const service = new Home23BriefsService({ home23Root: root });
    const list = await service.list({ limit: 20 });

    assert.equal(list.ok, true);
    assert.equal(list.items.some((item) => item.title === 'X Timeline Read' && item.agent === 'jerry'), true);
    assert.equal(list.items.some((item) => item.title === 'Field Read' && item.agent === 'forrest'), true);
    assert.equal(list.items.some((item) => item.title === 'Conversation: codex-forrest-cron-repair' && item.type === 'session'), true);
    assert.equal(list.items.some((item) => item.title === 'field-report-cycle' && item.type === 'cron'), true);
    assert.equal(list.items.some((item) => item.title === 'systems worker: fixed' && item.agent === 'forrest'), true);
    assert.equal(list.items.some((item) => item.title === 'sauna-tile-bridge'), false);

    const cron = list.items.find((item) => item.type === 'cron');
    const session = list.items.find((item) => item.type === 'session');
    assert.ok(cron);
    assert.doesNotMatch(cron.summary, /`|\*\*/);
    assert.match(cron.summary, /units_completed/);
    assert.match(cron.html, /From the inside/);
    assert.doesNotMatch(cron.html, /AGENCY_INTAKE_PACKET/);
    assert.equal(cron.provenance.kind, 'cron-run');
    assert.match(session.summary, /Use cron_run once/);
    assert.doesNotMatch(session.summary, /chatId|---|\*\*/);
    assert.match(session.html, /Latest answer/);

    const detail = await service.get(cron.id);
    assert.equal(detail.ok, true);
    assert.equal(detail.item.id, cron.id);
    assert.match(detail.item.html, /wrote the next <strong>curriculum<\/strong> unit/);

    const compact = await service.list({ limit: 2, compact: true });
    assert.equal(compact.ok, true);
    assert.equal(compact.items.length, 2);
    assert.equal(Object.hasOwn(compact.items[0], 'html'), false);
    assert.equal(Object.hasOwn(compact.items[0], 'text'), false);
    assert.ok(compact.items[0].summary);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Briefs service formats machine JSON artifacts as reader-grade documents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-briefs-json-'));
  try {
    writeJson(
      path.join(root, 'instances/forrest/workspace/insights/correlation-pressure-hrv-2026-05-27.json'),
      {
        schema: 'home23.sensor-fusion-hypothesis.v1',
        generatedAt: '2026-05-27T18:54:22.581Z',
        agent: 'forrest',
        hypothesis: {
          question: "Does barometric pressure in the 18h before sleep correlate with that night's HRV?",
          status: 'testable',
        },
        data: {
          latestHrvDate: '2026-05-27',
          healthFresh: true,
          pairedObservations: 30,
        },
        freshness: {
          reason: 'latest HRV metric is within the freshness window',
        },
        results: {
          mean: { r: -0.09464908761751538, n: 30 },
          delta: { r: 0.029427315312627236, n: 30 },
        },
      }
    );
    writeJson(path.join(root, 'instances/forrest/conversations/cron-jobs.json'), [
      {
        id: 'health-freshness',
        name: 'HealthKit pipeline freshness check',
        enabled: true,
        payload: { kind: 'exec' },
        delivery: { mode: 'summary' },
        state: { lastStatus: 'ok' },
      },
      {
        id: 'provider-failure',
        name: 'ticker-home23-mid-session',
        enabled: true,
        payload: { kind: 'agentTurn' },
        delivery: { mode: 'summary' },
        state: { lastStatus: 'ok' },
      },
    ]);
    writeJsonl(path.join(root, 'instances/forrest/conversations/cron-runs/health-freshness.jsonl'), [
      {
        runId: 'run-health',
        timestamp: '2026-05-27T19:37:39Z',
        status: 'ok',
        response: JSON.stringify({
          checked_at: '2026-05-27T19:37:39.750708+00:00',
          healthy: true,
          issues: [],
          details: {
            api_live: true,
            daily_metrics_newest: '2026-05-27',
            sleep_newest: '2026-05-27',
            workouts_newest: '2026-05-23T13:36:30-04:00',
          },
        }),
      },
    ]);
    writeJsonl(path.join(root, 'instances/forrest/conversations/cron-runs/provider-failure.jsonl'), [
      {
        runId: 'run-fail',
        timestamp: '2026-05-27T19:42:00Z',
        status: 'ok',
        response: 'Error calling gpt-5.5: The operation was aborted due to timeout',
      },
    ]);
    writeJson(
      path.join(root, 'instances/workers/systems/runs/wr_failed/receipt.json'),
      {
        runId: 'wr_failed',
        worker: 'systems',
        ownerAgent: 'forrest',
        status: 'failed',
        verifierStatus: 'unknown',
        finishedAt: '2026-05-27T19:43:00Z',
        summary: 'Error calling gpt-5.5: fetch failed',
      }
    );

    const service = new Home23BriefsService({ home23Root: root });
    const list = await service.list({ limit: 20 });
    const insight = list.items.find((item) => item.type === 'insight');
    const health = list.items.find((item) => item.title === 'HealthKit pipeline freshness check');
    const providerFailure = list.items.find((item) => item.title === 'ticker-home23-mid-session');
    const workerFailure = list.items.find((item) => item.type === 'worker');

    assert.ok(insight);
    assert.match(insight.title, /Pressure and HRV/i);
    assert.match(insight.summary, /barometric pressure/i);
    assert.match(insight.html, /Paired observations/);
    assert.doesNotMatch(insight.summary, /"schema":/);
    assert.doesNotMatch(insight.html, /"pairedObservations":/);

    assert.ok(health);
    assert.match(health.summary, /HealthKit pipeline is healthy/i);
    assert.match(health.html, /Daily metrics: 2026-05-27/);
    assert.doesNotMatch(health.summary, /"checked_at":/);
    assert.doesNotMatch(health.html, /"api_live":/);

    assert.ok(providerFailure);
    assert.match(providerFailure.summary, /Brief generation failed/i);
    assert.match(providerFailure.html, /The model request timed out/);
    assert.doesNotMatch(providerFailure.summary, /Error calling gpt-5\.5/);
    assert.doesNotMatch(providerFailure.html, /Error calling gpt-5\.5/);

    assert.ok(workerFailure);
    assert.match(workerFailure.summary, /Worker check failed/i);
    assert.doesNotMatch(workerFailure.summary, /Error calling gpt-5\.5/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
