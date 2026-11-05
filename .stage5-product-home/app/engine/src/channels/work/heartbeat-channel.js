/**
 * HeartbeatChannel — periodic engine self-observation. Emits cycle count,
 * awake time, and whatever else the caller plumbs through getEngineState.
 * Informational-only: crystallize() returns null so heartbeats don't flood
 * memory-objects.json.
 */

'use strict';

import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class HeartbeatChannel extends PollChannel {
  constructor({ getEngineState, intervalMs = 60 * 1000, id = 'work.heartbeat' } = {}) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.getEngineState = typeof getEngineState === 'function' ? getEngineState : () => ({});
    this._tick = 0;
  }

  async poll() {
    this._tick += 1;
    const state = this.getEngineState() || {};
    return [{ tick: this._tick, ...state, at: new Date().toISOString() }];
  }

  parse(raw) {
    return { payload: raw, sourceRef: `hb:${raw.tick}`, producedAt: raw.at };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'heartbeat',
    });
  }

  // Informational — bus persists to sidecar but nothing crystallizes.
  crystallize() { return null; }
}
