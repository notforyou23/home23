#!/usr/bin/env node
/**
 * correlate-pressure-hrv.js
 *
 * First correlation view Home23 actually ships. Answers one concrete,
 * falsifiable question the brain has been asking across five sessions:
 *
 *   Does barometric pressure in the 18h before sleep correlate with
 *   that night's HRV?
 *
 * Reads ~/.pressure_log.jsonl (5-min Pi BME280 samples) and
 * ~/.health_log.jsonl (HealthKit export, one HRV value per date).
 * For each date with an HRV reading, computes pressure statistics
 * over the local-time window [prior-day 12:00 → this-day 06:00]
 * and pairs them. Reports Pearson r, n, t-stat, and interpretation
 * for four predictors: mean, min, max-minus-min delta, and
 * last-minus-first trend.
 *
 * Output: instances/<agent>/workspace/insights/correlation-pressure-hrv-YYYY-MM-DD.md
 * Step 24 WorkspaceInsightsPublisher writes to the same directory, so
 * this analyzer lives alongside publisher artifacts and benefits from
 * the feeder auto-ingesting results back into the brain.
 *
 * Usage:
 *   node scripts/analyzers/correlate-pressure-hrv.js [--agent jerry]
 *
 * Recommended cadence: daily cron after the morning HRV upload.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const agentIdx = args.indexOf('--agent');
const agent = agentIdx >= 0 ? args[agentIdx + 1] : 'jerry';

const pressurePath = path.join(os.homedir(), '.pressure_log.jsonl');
const healthPath = path.join(os.homedir(), '.health_log.jsonl');
const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(repoRoot, 'instances', agent, 'workspace', 'insights');
const today = new Date().toISOString().slice(0, 10);
const outPath = path.join(outDir, `correlation-pressure-hrv-${today}.md`);

// ─── Loaders ──────────────────────────────────────────────────────────

function loadPressure() {
  if (!fs.existsSync(pressurePath)) return [];
  const raw = fs.readFileSync(pressurePath, 'utf8').trim().split('\n');
  return raw
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.ts && typeof o.pressure_pa === 'number')
    .map((o) => ({ ts: new Date(o.ts), hpa: o.pressure_pa / 100 }))
    .filter((p) => !Number.isNaN(p.ts.getTime()))
    // Physical sanity filter: habitable-altitude atmospheric pressure sits
    // roughly in [870, 1085] hPa. Observed 18 sensor-glitch readings
    // (~0.5% of samples) — a band of ~497 hPa and one 1131 hPa outlier —
    // that make min/max/delta stats meaningless. Drop at load.
    .filter((p) => p.hpa >= 870 && p.hpa <= 1085)
    .sort((a, b) => a.ts - b.ts);
}

function loadHrvByDate() {
  if (!fs.existsSync(healthPath)) return {};
  const raw = fs.readFileSync(healthPath, 'utf8').trim().split('\n');
  const byDate = {};
  for (const l of raw) {
    try {
      const o = JSON.parse(l);
      const h = o.metrics?.heartRateVariability;
      if (h?.date && typeof h.value === 'number') {
        byDate[h.date] = h.value;
      }
    } catch { /* skip malformed */ }
  }
  return byDate;
}

// ─── Windowing ────────────────────────────────────────────────────────

// Prior-day 12:00 local → this-day 06:00 local = 18 hours pre-sleep.
function pressureWindowForDate(pressure, dateStr) {
  const thisDayMorning = new Date(`${dateStr}T06:00:00`);
  if (Number.isNaN(thisDayMorning.getTime())) return [];
  const priorNoon = new Date(thisDayMorning.getTime() - 18 * 3600 * 1000);
  return pressure.filter((p) => p.ts >= priorNoon && p.ts < thisDayMorning);
}

// ─── Stats ────────────────────────────────────────────────────────────

// Robust p5/p95 percentiles instead of absolute min/max. Single-reading
// sensor glitches (an 890 hPa dropout among 1000 hPa neighbors) otherwise
// dominate the delta metric — saw a 122 hPa "delta" that was really one
// bad sample. p5/p95 keeps the cost of glitch-tolerance cheap and is
// still faithful to "the low/high end of the window".
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx];
}

function summarize(values) {
  if (!values.length) return null;
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const p05 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);
  return {
    n,
    mean,
    min: p05,            // robust "low end" of window
    max: p95,            // robust "high end" of window
    delta: p95 - p05,    // robust range
    trend: values[values.length - 1] - values[0],
  };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return { r: null, n, tStat: null };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return { r: 0, n, tStat: 0 };
  const r = sxy / Math.sqrt(sxx * syy);
  const denom = Math.max(1e-9, 1 - r * r);
  const tStat = r * Math.sqrt((n - 2) / denom);
  return { r, n, tStat };
}

function interpret({ r, n }) {
  if (r === null) return 'insufficient data (n<3)';
  if (n < 7) return `directional only — n=${n} is too small`;
  const absR = Math.abs(r);
  const sign = r > 0 ? '+' : '−';
  if (absR < 0.15) return 'no detectable relationship';
  if (absR < 0.35) return `weak${r < 0 ? ' negative' : ' positive'}, inconclusive`;
  if (absR < 0.55) return `moderate ${sign} — worth watching`;
  if (absR < 0.75) return `strong ${sign} signal`;
  return `very strong ${sign} — probably worth acting on`;
}

// Rough two-tailed p<0.05 threshold for Pearson r given n
// (approximate, based on t-distribution critical value for df=n-2).
function rThreshold(n) {
  if (n < 4) return null;
  return 2 / Math.sqrt(Math.max(1, n - 2));
}

// ─── Render ───────────────────────────────────────────────────────────

function render(pressure, hrvByDate, paired, results) {
  const dates = Object.keys(hrvByDate).sort();
  const pStart = pressure[0]?.ts.toISOString().slice(0, 10) || 'n/a';
  const pEnd = pressure[pressure.length - 1]?.ts.toISOString().slice(0, 10) || 'n/a';
  const thresh = rThreshold(paired.length);

  const lines = [
    '# Correlation: Pressure → HRV (18h pre-sleep window)',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Agent:** ${agent}`,
    '**Window:** prior-day 12:00 local → this-day 06:00 local (18 hours before typical sleep start)',
    '**Hypothesis:** Does barometric pressure in the 18h before sleep correlate with that night\'s HRV?',
    '',
    '## Data',
    `- Pressure samples: **${pressure.length}** 5-min readings from ${pStart} to ${pEnd}`,
    `- HRV readings: **${dates.length}** distinct dates (${dates.join(', ') || 'none'})`,
    `- Paired observations (HRV date + ≥10 pressure samples in window): **${paired.length}**`,
    '',
  ];

  if (paired.length < 3) {
    lines.push(
      '## Not enough data',
      '',
      `Need at least 3 paired observations to compute correlation, got ${paired.length}. ` +
      'Continue collecting; re-run daily.',
      '',
    );
  } else {
    lines.push(
      '## Results',
      '',
      '| Predictor | Pearson r | n | t-stat | Interpretation |',
      '|---|---:|---:|---:|---|',
    );
    const predictorLabels = {
      mean:  'Mean pressure (hPa)',
      min:   'Min pressure (hPa)',
      delta: 'Pressure delta (max − min, hPa)',
      trend: 'Pressure trend (last − first, hPa)',
    };
    for (const [k, v] of Object.entries(results)) {
      lines.push(
        `| ${predictorLabels[k]} | ${v.r != null ? v.r.toFixed(3) : 'n/a'} | ${v.n} | ${v.tStat != null ? v.tStat.toFixed(2) : 'n/a'} | ${interpret(v)} |`
      );
    }
    lines.push('');

    lines.push(
      '## Paired observations',
      '',
      '| Date | HRV (ms) | Mean P (hPa) | Min P (hPa) | Delta (hPa) | Trend (hPa) |',
      '|---|---:|---:|---:|---:|---:|',
    );
    for (const p of paired) {
      lines.push(
        `| ${p.date} | ${p.hrv.toFixed(1)} | ${p.pressure.mean.toFixed(1)} | ${p.pressure.min.toFixed(1)} | ${p.pressure.delta.toFixed(1)} | ${p.pressure.trend.toFixed(1)} |`
      );
    }
    lines.push('');

    lines.push(
      '## Reading',
      `- With n=${paired.length}, rough two-tailed p<0.05 threshold for Pearson |r| is ≈ **${thresh?.toFixed(2) ?? 'n/a'}**.`,
      '- HRV has high day-to-day variance from non-pressure factors (sleep quality, exercise, alcohol, illness). ' +
      'Small n + large non-pressure noise makes early signals fragile — judge by direction first, magnitude second.',
      '- Re-run daily. If |r| stabilizes above 0.4 across consecutive runs, escalate to a dashboard tile + pressure-drop → HRV-risk bridge-chat alert.',
      '- If |r| stays below 0.2 after n≥20 paired days, this hypothesis is dead; rotate to sauna→HRV or pressure×sauna interaction.',
      '',
    );
  }

  lines.push(
    '---',
    '_Generated by `scripts/analyzers/correlate-pressure-hrv.js`. The analyzer is the first concrete answer to the brain\'s standing request for a correlation view; it turns Home23\'s sensor infrastructure into knowledge instead of more observations._',
    '',
  );

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────

function main() {
  const pressure = loadPressure();
  const hrvByDate = loadHrvByDate();
  const dates = Object.keys(hrvByDate).sort();

  const paired = [];
  for (const date of dates) {
    const win = pressureWindowForDate(pressure, date);
    if (win.length < 10) continue;
    paired.push({
      date,
      hrv: hrvByDate[date],
      pressure: summarize(win.map((p) => p.hpa)),
    });
  }

  const hrvs = paired.map((p) => p.hrv);
  const results = paired.length >= 3 ? {
    mean:  pearson(paired.map((p) => p.pressure.mean),  hrvs),
    min:   pearson(paired.map((p) => p.pressure.min),   hrvs),
    delta: pearson(paired.map((p) => p.pressure.delta), hrvs),
    trend: pearson(paired.map((p) => p.pressure.trend), hrvs),
  } : {};

  const body = render(pressure, hrvByDate, paired, results);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, body);
  console.log(`wrote ${outPath}`);
  console.log(`paired: ${paired.length}`);
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(8)} r=${v.r != null ? v.r.toFixed(3) : 'n/a'}  t=${v.tStat != null ? v.tStat.toFixed(2) : 'n/a'}  (${interpret(v)})`);
  }
}

main();
