/**
 * WeatherChannel — polls a weather provider (e.g. Ecowitt). On success
 * emits COLLECTED; on empty/stale fetch emits ZERO_CONTEXT (legal terminal);
 * on throw emits UNKNOWN (bus retries with jitter).
 */

'use strict';

import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class WeatherChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, fetchWeather, id = 'domain.weather' } = {}) {
    super({ id, class: ChannelClass.DOMAIN, intervalMs });
    this.fetchWeather = typeof fetchWeather === 'function' ? fetchWeather : async () => null;
  }

  async poll() {
    try {
      const w = await this.fetchWeather();
      if (!w) return [{ __zeroContext: true, at: new Date().toISOString() }];
      return [{ ...w, at: w.at || new Date().toISOString() }];
    } catch (err) {
      return [{ __error: err?.message || String(err), at: new Date().toISOString() }];
    }
  }

  parse(raw) {
    const ref = raw.__zeroContext ? `weather:zero:${raw.at}` : raw.__error ? `weather:err:${raw.at}` : `weather:${raw.at}`;
    return { payload: raw, sourceRef: ref, producedAt: raw.at };
  }

  verify(parsed) {
    const p = parsed.payload;
    const flag = p.__zeroContext ? 'ZERO_CONTEXT' : p.__error ? 'UNKNOWN' : 'COLLECTED';
    const confidence = flag === 'COLLECTED' ? 0.9 : flag === 'ZERO_CONTEXT' ? 0.2 : 0;
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag, confidence, producedAt: parsed.producedAt, verifierId: 'weather:ecowitt',
    });
  }

  crystallize(obs) {
    if (obs.flag === 'COLLECTED') {
      return { method: 'sensor_primary', type: 'observation', topic: 'weather', tags: ['domain', 'weather'] };
    }
    if (obs.flag === 'ZERO_CONTEXT') {
      return { method: 'zero_context_audit', type: 'observation', topic: 'weather', tags: ['domain', 'weather', 'zero-context'] };
    }
    return null;
  }
}
