/**
 * HealthChannel — tails ~/.health_log.jsonl (HealthKit export bridge).
 * Extracts the metrics we care about (HRV, RHR, sleep, VO2, wrist temp,
 * steps, exercise minutes, oxygen sat) into a flat payload.
 */

'use strict';

import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

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

function buildInterpretationPosture({ semanticStale, metricDates }) {
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
    },
  };
}

export class HealthChannel extends TailChannel {
  constructor({ path, id = 'domain.health' }) {
    super({ id, class: ChannelClass.DOMAIN, path });
  }

  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    const m = obj.metrics || {};
    const get = (k) => (m[k] && typeof m[k].value !== 'undefined') ? m[k].value : null;
    const { newest, metricDates } = newestMetricDate(m);
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
    });
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
}
