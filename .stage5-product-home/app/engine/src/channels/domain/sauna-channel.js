/**
 * SaunaChannel — tails ~/.sauna_usage_log.jsonl (Huum state transitions).
 * Emits each start/stop/etc. event.
 */

'use strict';

import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class SaunaChannel extends TailChannel {
  constructor({ path, id = 'domain.sauna' }) {
    super({ id, class: ChannelClass.DOMAIN, path });
  }

  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj.event || !obj.ts) return null;
    return { payload: obj, sourceRef: `sauna:${obj.ts}:${obj.event}`, producedAt: obj.ts };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'sauna:huum-poll',
    });
  }

  crystallize(obs) {
    const tags = ['domain', 'sauna'];
    if (obs.payload.event) tags.push(obs.payload.event);
    if (obs.payload.status) tags.push(obs.payload.status);
    return { method: 'sensor_primary', type: 'observation', topic: 'sauna', tags };
  }
}
