import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('pressure HRV analyzer writes a reusable hypothesis artifact beside the report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pressure-hrv-artifact-'));
  const pressurePath = join(dir, 'pressure.jsonl');
  const healthPath = join(dir, 'health.jsonl');
  const outDir = join(dir, 'out');

  const pressureRows = [];
  for (const date of ['2026-05-01', '2026-05-02', '2026-05-03']) {
    for (let hour = 12; hour < 24; hour += 1) {
      pressureRows.push(JSON.stringify({
        ts: `${date}T${String(hour).padStart(2, '0')}:00:00-04:00`,
        pressure_pa: 100000 + (hour * 8),
      }));
    }
  }
  writeFileSync(pressurePath, pressureRows.join('\n') + '\n');
  writeFileSync(healthPath, [
    { ts: '2026-05-02T08:00:00-04:00', metrics: { heartRateVariability: { date: '2026-05-02', value: 42 } } },
    { ts: '2026-05-03T08:00:00-04:00', metrics: { heartRateVariability: { date: '2026-05-03', value: 51 } } },
    { ts: '2026-05-04T08:00:00-04:00', metrics: { heartRateVariability: { date: '2026-05-04', value: 47 } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');

  execFileSync('node', [
    'scripts/analyzers/correlate-pressure-hrv.js',
    '--agent', 'jerry',
    '--date', '2026-05-11',
    '--pressure-path', pressurePath,
    '--health-path', healthPath,
    '--out-dir', outDir,
  ], { cwd: process.cwd(), stdio: 'pipe' });

  const artifactPath = join(outDir, 'correlation-pressure-hrv-2026-05-11.json');
  assert.ok(existsSync(join(outDir, 'correlation-pressure-hrv-2026-05-11.md')));
  assert.ok(existsSync(artifactPath));

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  assert.equal(artifact.schema, 'home23.sensor-fusion-hypothesis.v1');
  assert.deepEqual(artifact.sourceIssues, [70]);
  assert.equal(artifact.hypothesis.id, 'pressure-hrv-pre-sleep');
  assert.equal(artifact.pipeline.resolution, 'daily');
  assert.match(artifact.pipeline.alignment, /prior-day 12:00 local/);
  assert.equal(artifact.data.pairedObservations, 3);
  assert.equal(artifact.results.mean.n, 3);
  assert.equal(artifact.reuse.recommendedNext.length > 0, true);
  assert.equal(artifact.paired[0].date, '2026-05-02');
});

test('under the Host the HRV analyzer reads both owner logs by default, not the runtime HOME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pressure-hrv-owner-'));
  const owner = join(dir, 'owner');
  const runtimeHome = join(dir, 'runtime-user');
  const outDir = join(dir, 'out');
  mkdirSync(owner);
  mkdirSync(runtimeHome);
  const pressureRows = [];
  for (const date of ['2026-05-01', '2026-05-02', '2026-05-03']) {
    for (let hour = 12; hour < 24; hour += 1) {
      pressureRows.push(JSON.stringify({ ts: `${date}T${String(hour).padStart(2, '0')}:00:00-04:00`, pressure_pa: 100000 + (hour * 8) }));
    }
  }
  writeFileSync(join(owner, '.pressure_log.jsonl'), pressureRows.join('\n') + '\n');
  writeFileSync(join(owner, '.health_log.jsonl'), [
    { ts: '2026-05-02T08:00:00-04:00', metrics: { heartRateVariability: { date: '2026-05-02', value: 42 } } },
    { ts: '2026-05-03T08:00:00-04:00', metrics: { heartRateVariability: { date: '2026-05-03', value: 51 } } },
    { ts: '2026-05-04T08:00:00-04:00', metrics: { heartRateVariability: { date: '2026-05-04', value: 47 } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  // Empty split copies in the runtime HOME must not be what is analyzed.
  writeFileSync(join(runtimeHome, '.pressure_log.jsonl'), '');
  writeFileSync(join(runtimeHome, '.health_log.jsonl'), '');

  execFileSync('node', ['scripts/analyzers/correlate-pressure-hrv.js', '--date', '2026-05-11', '--out-dir', outDir], {
    cwd: process.cwd(), stdio: 'pipe',
    env: { ...process.env, HOME: runtimeHome, HOME23_OWNER_HOME: owner, HOME23_PRODUCT_HOST: 'true' },
  });

  const artifact = JSON.parse(readFileSync(join(outDir, 'correlation-pressure-hrv-2026-05-11.json'), 'utf8'));
  assert.equal(artifact.data.pairedObservations, 3);
});
