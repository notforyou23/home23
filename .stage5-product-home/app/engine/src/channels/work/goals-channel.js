/**
 * GoalsChannel — watches the lifecycle-state directories under
 * brain/goals/ and emits an observation on each add/change/unlink.
 * The state is inferred from the parent directory name.
 */

'use strict';

import { basename, dirname } from 'node:path';
import { WatchChannel } from '../base/watch-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const LIFECYCLE = ['pending', 'assigned', 'acks', 'complete', 'revoked'];

export class GoalsChannel extends WatchChannel {
  constructor({ goalsDir, id = 'work.goals', usePolling = false, interval = 1000 }) {
    super({
      id,
      class: ChannelClass.WORK,
      paths: LIFECYCLE.map((s) => `${goalsDir}/${s}`),
      usePolling,
      interval,
    });
    this.goalsDir = goalsDir;
  }

  parseEvent(evt) {
    const state = basename(dirname(evt.path));
    const goalId = basename(evt.path).replace(/\.json$/, '');
    return {
      payload: { state, goalId, eventType: evt.type, path: evt.path },
      sourceRef: `goal:${goalId}:${state}:${evt.type}`,
      producedAt: evt.ts,
    };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'goals:watch',
    });
  }

  crystallize(obs) {
    return {
      method: 'work_event', type: 'observation', topic: 'goal-lifecycle',
      tags: ['work', 'goal', obs.payload.state, obs.payload.eventType],
    };
  }
}
