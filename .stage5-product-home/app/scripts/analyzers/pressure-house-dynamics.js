#!/usr/bin/env node
/**
 * pressure-house-dynamics.js
 *
 * Turns the single BME280 pressure log into a reusable house-physics artifact.
 * This intentionally separates what a one-point indoor pressure stream can
 * support from spatial claims that require outside and multi-zone sensors.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

const agent = argValue('--agent', 'jerry');
const pressurePath = argValue('--pressure-path', path.join(os.homedir(), '.pressure_log.jsonl'));
const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = argValue('--out-dir', path.join(repoRoot, 'instances', agent, 'workspace', 'insights'));
const today = argValue('--date', new Date().toISOString().slice(0, 10));
const outPath = path.join(outDir, `pressure-house-dynamics-${today}.md`);
const artifactPath = path.join(outDir, `pressure-house-dynamics-${today}.json`);

function loadPressure() {
  if (!fs.existsSync(pressurePath)) return [];
  return fs.readFileSync(pressurePath, 'utf8').split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((row) => row && row.ts && typeof row.pressure_pa === 'number')
    .map((row) => ({
      ts: new Date(row.ts),
      hpa: row.pressure_pa / 100,
      raw: row,
    }))
    .filter((row) => !Number.isNaN(row.ts.getTime()) && row.hpa >= 870 && row.hpa <= 1085)
    .sort((a, b) => a.ts - b.ts);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx];
}

function round(value, places = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function analyzePressure(rows) {
  if (!rows.length) {
    return {
      status: 'no_data',
      sampleCount: 0,
      firstSampleAt: null,
      lastSampleAt: null,
      features: null,
      posture: {
        temporalSignal: 'unknown',
        spatialInference: 'not_supported',
        reason: 'no pressure samples available',
      },
    };
  }

  const diffs = [];
  const fastAbsDiffs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const hours = (curr.ts - prev.ts) / 3600000;
    if (hours <= 0 || hours > 3) continue;
    const delta = curr.hpa - prev.hpa;
    diffs.push({
      from: prev.ts.toISOString(),
      to: curr.ts.toISOString(),
      hours,
      deltaHpa: delta,
      rateHpaPerHour: delta / hours,
    });
    if (hours <= 10 / 60) fastAbsDiffs.push(Math.abs(delta));
  }

  const pressures = rows.map((row) => row.hpa);
  const sortedPressures = [...pressures].sort((a, b) => a - b);
  const sortedFast = [...fastAbsDiffs].sort((a, b) => a - b);
  const maxRise = diffs.reduce((best, row) => !best || row.rateHpaPerHour > best.rateHpaPerHour ? row : best, null);
  const maxDrop = diffs.reduce((best, row) => !best || row.rateHpaPerHour < best.rateHpaPerHour ? row : best, null);
  const spanHours = (rows[rows.length - 1].ts - rows[0].ts) / 3600000;
  const slowDriftHpa = rows[rows.length - 1].hpa - rows[0].hpa;
  const fastJitterP95Hpa = percentile(sortedFast, 0.95) ?? 0;
  const robustRangeHpa = (percentile(sortedPressures, 0.95) ?? rows[rows.length - 1].hpa)
    - (percentile(sortedPressures, 0.05) ?? rows[0].hpa);
  const weatherEvent = Math.max(Math.abs(maxRise?.rateHpaPerHour || 0), Math.abs(maxDrop?.rateHpaPerHour || 0)) >= 1;

  return {
    status: rows.length >= 12 ? 'analyzed' : 'collecting',
    sampleCount: rows.length,
    firstSampleAt: rows[0].ts.toISOString(),
    lastSampleAt: rows[rows.length - 1].ts.toISOString(),
    features: {
      meanHpa: round(pressures.reduce((a, b) => a + b, 0) / rows.length, 2),
      robustRangeHpa: round(robustRangeHpa, 2),
      slowDriftHpa: round(slowDriftHpa, 2),
      spanHours: round(spanHours, 2),
      maxRiseHpaPerHour: maxRise ? round(maxRise.rateHpaPerHour, 2) : null,
      maxDropHpaPerHour: maxDrop ? round(maxDrop.rateHpaPerHour, 2) : null,
      fastJitterP95Hpa: round(fastJitterP95Hpa, 3),
    },
    posture: {
      temporalSignal: weatherEvent ? 'weather_event_candidate' : 'slow_envelope_tracking',
      spatialInference: 'not_supported',
      reason: 'single indoor pressure sensor supports temporal derivatives but not inside-outside attenuation, stack-effect floors, door state, or zone leakage claims',
    },
  };
}

function buildArtifact(rows, analysis) {
  return {
    schema: 'home23.pressure-house-dynamics.v1',
    version: 1,
    sourceIssues: [73],
    generatedAt: new Date().toISOString(),
    agent,
    source: {
      pressurePath,
      sensor: 'BME280',
      sampleRole: 'single_point_indoor_pressure',
    },
    pipeline: {
      resolution: 'daily',
      features: ['rate_of_change_hpa_per_hour', 'slow_drift_hpa', 'robust_range_hpa', 'fast_jitter_p95_hpa'],
      limitations: [
        'no outside pressure feed was aligned, so building-envelope attenuation is not computed',
        'no multi-zone pressure sensors are present, so spatial inference is explicitly unsupported',
      ],
    },
    data: {
      samples: rows.length,
      firstSampleAt: analysis.firstSampleAt,
      lastSampleAt: analysis.lastSampleAt,
    },
    analysis,
    reuse: {
      artifactRole: 'house_physics_signal',
      recommendedNext: [
        'use max pressure rate-of-change as the robust weather-event signal',
        'align an outside pressure source before making building-envelope attenuation claims',
        'add two or three BME280 sensors on different floors or zones before inferring stack effect, door state, or leakage maps',
      ],
    },
  };
}

function render(artifact) {
  const f = artifact.analysis.features;
  const lines = [
    '# Pressure House Dynamics',
    '',
    `**Generated:** ${artifact.generatedAt}`,
    `**Agent:** ${artifact.agent}`,
    `**Samples:** ${artifact.data.samples}`,
    `**Window:** ${artifact.data.firstSampleAt || 'n/a'} -> ${artifact.data.lastSampleAt || 'n/a'}`,
    '',
    '## Current Inference',
    '',
    `- Temporal signal: **${artifact.analysis.posture.temporalSignal}**`,
    `- Spatial inference: **${artifact.analysis.posture.spatialInference}**`,
    `- Reason: ${artifact.analysis.posture.reason}`,
    '',
  ];

  if (f) {
    lines.push(
      '## Features',
      '',
      `- Mean pressure: **${f.meanHpa} hPa**`,
      `- Robust pressure range: **${f.robustRangeHpa} hPa**`,
      `- Slow drift across window: **${f.slowDriftHpa} hPa**`,
      `- Max rise: **${f.maxRiseHpaPerHour} hPa/hour**`,
      `- Max drop: **${f.maxDropHpaPerHour} hPa/hour**`,
      `- Fast jitter p95: **${f.fastJitterP95Hpa} hPa**`,
      '',
    );
  }

  lines.push(
    '## Reuse',
    '',
    ...artifact.reuse.recommendedNext.map((item) => `- ${item}`),
    '',
    '---',
    '_Generated by `scripts/analyzers/pressure-house-dynamics.js`. This artifact implements Field Report #73 by treating the pressure log as a house-physics signal while refusing unsupported spatial claims from a single sensor._',
    '',
  );

  return lines.join('\n');
}

function main() {
  const rows = loadPressure();
  const analysis = analyzePressure(rows);
  const artifact = buildArtifact(rows, analysis);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, render(artifact));
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(`wrote ${artifactPath}`);
  console.log(`samples: ${rows.length}`);
  console.log(`temporal: ${analysis.posture.temporalSignal}`);
}

main();
