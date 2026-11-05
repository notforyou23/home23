import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('pressure house dynamics analyzer writes single-sensor inference artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pressure-house-dynamics-'));
  const pressurePath = join(dir, 'pressure.jsonl');
  const outDir = join(dir, 'out');

  const rows = [];
  const start = Date.parse('2026-05-10T00:00:00-04:00');
  for (let i = 0; i < 24; i += 1) {
    rows.push(JSON.stringify({
      ts: new Date(start + i * 5 * 60 * 1000).toISOString(),
      pressure_pa: 100000 + i * 18,
    }));
  }
  writeFileSync(pressurePath, `${rows.join('\n')}\n`);

  execFileSync('node', [
    'scripts/analyzers/pressure-house-dynamics.js',
    '--agent', 'jerry',
    '--date', '2026-05-11',
    '--pressure-path', pressurePath,
    '--out-dir', outDir,
  ], { cwd: process.cwd(), stdio: 'pipe' });

  const mdPath = join(outDir, 'pressure-house-dynamics-2026-05-11.md');
  const jsonPath = join(outDir, 'pressure-house-dynamics-2026-05-11.json');
  assert.ok(existsSync(mdPath));
  assert.ok(existsSync(jsonPath));

  const artifact = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.equal(artifact.schema, 'home23.pressure-house-dynamics.v1');
  assert.deepEqual(artifact.sourceIssues, [73]);
  assert.equal(artifact.source.sampleRole, 'single_point_indoor_pressure');
  assert.equal(artifact.analysis.status, 'analyzed');
  assert.equal(artifact.analysis.sampleCount, 24);
  assert.equal(artifact.analysis.posture.temporalSignal, 'weather_event_candidate');
  assert.equal(artifact.analysis.posture.spatialInference, 'not_supported');
  assert.match(artifact.analysis.posture.reason, /single indoor pressure sensor/);
  assert.match(artifact.reuse.recommendedNext.join(' '), /two or three BME280 sensors/);

  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /Pressure House Dynamics/);
  assert.match(md, /Spatial inference: \*\*not_supported\*\*/);
});
