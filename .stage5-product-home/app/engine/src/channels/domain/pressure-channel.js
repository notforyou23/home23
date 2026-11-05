/**
 * PressureChannel — tails ~/.pressure_log.jsonl (Pi BME280 sensor bridge).
 * Emits each 5-min sample as a COLLECTED domain observation.
 */

'use strict';

import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class PressureChannel extends TailChannel {
  constructor({ path, id = 'domain.pressure' }) {
    super({ id, class: ChannelClass.DOMAIN, path });
  }

  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj.ts || obj.pressure_pa == null) return null;
    return { payload: obj, sourceRef: `pressure:${obj.ts}`, producedAt: obj.ts };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'pressure:bme280',
    });
  }

  crystallize() {
    return { method: 'sensor_primary', type: 'observation', topic: 'pressure', tags: ['domain', 'pressure', 'bme280'] };
  }
}
