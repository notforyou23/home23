/**
 * HealthChannel — tails ~/.health_log.jsonl (HealthKit export bridge).
 * Extracts the metrics we care about (HRV, RHR, sleep, VO2, wrist temp,
 * steps, exercise minutes, oxygen sat) into a flat payload.
 */

'use strict';

import { existsSync, readFileSync } from 'node:fs';
import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const BASELINE_METRICS = [
  'heartRateVariability',
  'restingHeartRate',
  'sleepTime',
  'wristTemperature',
  'oxygenSaturation',
  'respiratoryRate',
];

const HEALTH_NEIGHBORS = [
  'restingHeartRate',
  'sleepTime',
  'wristTemperature',
  'oxygenSaturation',
  'respiratoryRate',
];

const EXTERNAL_NEIGHBORS = ['pressure', 'sauna', 'weather', 'subjectiveNotes'];

function parseMetricDay(value) {
  if (!value) return null;
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function newestMetricDate(metrics) {
  let newest = null;
  const metricDates = {};
  for (const [key, value] of Object.entries(metrics || {})) {
    const date = value && typeof value === 'object' ? value.date : null;
    if (!date) continue;
    metricDates[key] = date;
    const parsed = parseMetricDay(date);
    if (parsed && (!newest || parsed > newest)) newest = parsed;
  }
  return { newest, metricDates };
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function metricAgeDays(date) {
  const parsed = parseMetricDay(date);
  if (!parsed) return null;
  return Math.floor((Date.now() - parsed.getTime()) / 86400000);
}

function metricValue(metrics, key) {
  const metric = metrics?.[key];
  const value = metric && typeof metric.value !== 'undefined' ? Number(metric.value) : NaN;
  return Number.isFinite(value) ? value : null;
}

function metricDate(metrics, key) {
  const metric = metrics?.[key];
  return metric && typeof metric.date === 'string' ? metric.date.slice(0, 10) : null;
}

function buildInterpretationPosture({ semanticStale, metricDates, hrvBaseline, coalition }) {
  return {
    schema: 'home23.health.interpretation-posture.v1',
    sourceIssues: [83, 84],
    actionPosture: 'context_only',
    boundary: 'Health metrics are context signals, not a red-green readiness tile or direct instruction about what jtr should do.',
    hrv: {
      role: 'adaptive_capacity_shadow',
      forbiddenUse: 'readiness_command',
      posture: semanticStale ? 'historical_only' : 'fresh_context',
      metricDate: metricDates.heartRateVariability || null,
      note: 'HRV can suggest adaptation room, but it cannot explain the whole body or authorize action by itself.',
      baseline: hrvBaseline,
    },
    coalition,
  };
}

export class HealthChannel extends TailChannel {
  constructor({ path, id = 'domain.health', baselineMinDays = 7, baselineMaxDays = 60 }) {
    super({ id, class: ChannelClass.DOMAIN, path });
    this.baselineMinDays = baselineMinDays;
    this.baselineMaxDays = baselineMaxDays;
    this.metricHistory = new Map();
    this.baselineSeeded = false;
  }

  async start() {
    this.seedBaselineFromFile();
    await super.start();
  }

  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    const m = obj.metrics || {};
    const get = (k) => (m[k] && typeof m[k].value !== 'undefined') ? m[k].value : null;
    const { newest, metricDates } = newestMetricDate(m);
    const baselines = this.buildBaselines(m);
    const coalition = this.buildSignalCoalition(m, metricDates, baselines);
    const dataAgeDays = newest
      ? Math.floor((Date.now() - newest.getTime()) / 86400000)
      : null;
    const semanticStale = dataAgeDays == null || dataAgeDays > 3;
    const payload = {
      ts: obj.ts,
      hrv:          get('heartRateVariability'),
      rhr:          get('restingHeartRate'),
      sleepMin:     get('sleepTime'),
      vo2:          get('vo2Max'),
      wristTempF:   get('wristTemperature'),
      steps:        get('stepCount'),
      exerciseMin:  get('exerciseMinutes'),
      oxygenSat:    get('oxygenSaturation'),
      respiratoryRate: get('respiratoryRate'),
      metricDates,
      healthDataEndDate: obj.health_data_end_date || (newest ? newest.toISOString().slice(0, 10) : null),
      healthDataAgeDays: obj.health_data_age_days ?? dataAgeDays,
      semanticStale: obj.semantic_stale ?? semanticStale,
    };
    payload.interpretationPosture = buildInterpretationPosture({
      semanticStale: payload.semanticStale,
      metricDates,
      hrvBaseline: baselines.heartRateVariability,
      coalition,
    });
    this.recordMetrics(m);
    return { payload, sourceRef: `health:${obj.ts}`, producedAt: obj.ts };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: parsed.payload.semanticStale ? 'UNCERTIFIED' : 'COLLECTED',
      confidence: parsed.payload.semanticStale ? 0.45 : 0.95,
      producedAt: parsed.producedAt,
      verifierId: parsed.payload.semanticStale ? 'health:kit-export-stale' : 'health:kit-export',
    });
  }

  crystallize() {
    return { method: 'sensor_primary', type: 'observation', topic: 'health', tags: ['domain', 'health'] };
  }

  seedBaselineFromFile() {
    if (this.baselineSeeded) return;
    this.baselineSeeded = true;
    if (!existsSync(this.path)) return;
    let raw = '';
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter(Boolean).slice(-2000);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        this.recordMetrics(obj.metrics || {});
      } catch {
        // Ignore malformed historical rows; live parsing still owns observation quality.
      }
    }
  }

  recordMetrics(metrics) {
    for (const key of BASELINE_METRICS) {
      const value = metricValue(metrics, key);
      const date = metricDate(metrics, key);
      if (value == null || !date) continue;
      if (!this.metricHistory.has(key)) this.metricHistory.set(key, new Map());
      const history = this.metricHistory.get(key);
      history.set(date, value);
      const orderedDates = Array.from(history.keys()).sort();
      while (orderedDates.length > this.baselineMaxDays) {
        const oldest = orderedDates.shift();
        if (oldest) history.delete(oldest);
      }
    }
  }

  buildBaselines(metrics) {
    const baselines = {};
    for (const key of BASELINE_METRICS) {
      const currentValue = metricValue(metrics, key);
      const currentDate = metricDate(metrics, key);
      baselines[key] = this.buildMetricBaseline(key, currentValue, currentDate);
    }
    return baselines;
  }

  buildMetricBaseline(key, currentValue, currentDate) {
    const history = this.metricHistory.get(key) || new Map();
    const rows = Array.from(history.entries())
      .filter(([date]) => date !== currentDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-this.baselineMaxDays);
    const values = rows.map(([, value]) => value).filter((value) => Number.isFinite(value));
    const center = median(values);
    const sampleDays = values.length;
    const base = {
      basis: 'jtr_recent_distinct_metric_days',
      sampleDays,
      minSampleDays: this.baselineMinDays,
      metricDate: currentDate || null,
      currentValue,
      status: sampleDays >= this.baselineMinDays ? 'ready' : 'building',
      band: 'unknown',
      median: center,
      deltaFromMedian: null,
      deltaPct: null,
    };
    if (currentValue == null) {
      return { ...base, status: 'unavailable', reason: 'current metric value missing' };
    }
    if (center == null || sampleDays < this.baselineMinDays) {
      return { ...base, reason: 'not enough distinct local history to compare jtr against himself' };
    }
    const delta = currentValue - center;
    const deltaPct = center === 0 ? null : delta / center;
    const threshold = Math.max(Math.abs(center) * 0.15, 0.0001);
    let band = 'near_baseline';
    if (delta <= -threshold) band = 'below_baseline';
    if (delta >= threshold) band = 'above_baseline';
    return {
      ...base,
      band,
      deltaFromMedian: Number(delta.toFixed(3)),
      deltaPct: deltaPct == null ? null : Number(deltaPct.toFixed(3)),
      reason: `compared against ${sampleDays} distinct local metric day(s), not a population chart`,
    };
  }

  buildSignalCoalition(metrics, metricDates, baselines) {
    const availableHealth = HEALTH_NEIGHBORS
      .filter((key) => metricValue(metrics, key) != null)
      .map((key) => ({
        metric: key,
        date: metricDates[key] || null,
        ageDays: metricAgeDays(metricDates[key]),
        baselineBand: baselines[key]?.band || 'unknown',
      }));
    const freshHealth = availableHealth.filter((item) => item.ageDays != null && item.ageDays <= 3);
    const hrvBand = baselines.heartRateVariability?.band;
    const rhrBand = baselines.restingHeartRate?.band;
    const sleepBand = baselines.sleepTime?.band;
    let agreement = 'insufficient_context';
    if (hrvBand === 'below_baseline' && (rhrBand === 'above_baseline' || sleepBand === 'below_baseline')) {
      agreement = 'neighbor_health_signals_support_recovery_load_hypothesis';
    } else if (hrvBand === 'near_baseline') {
      agreement = 'no_hrv_deviation_to_explain';
    } else if (hrvBand === 'below_baseline') {
      agreement = 'thin_hrv_signal_needs_neighbors';
    }
    return {
      schema: 'home23.health.signal-coalition.v1',
      posture: 'ask_neighboring_signals_before_action',
      agreement,
      confidence: agreement === 'neighbor_health_signals_support_recovery_load_hypothesis' ? 'medium' : 'low',
      availableHealthSignals: availableHealth,
      freshHealthSignalCount: freshHealth.length,
      missingExternalSignals: EXTERNAL_NEIGHBORS,
      requiredBeforeInstruction: [
        'personal baseline',
        'resting heart rate',
        'sleep',
        'temperature or respiratory context',
        'pressure',
        'sauna',
        'weather',
        'subjective note when available',
      ],
      forbiddenConclusion: 'do not infer readiness, illness, stress, or needed action from HRV alone',
    };
  }
}
