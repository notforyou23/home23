/**
 * FsWatchChannel — watches load-bearing code + design + config paths,
 * tagging filesystem events so the brain sees its own build activity.
 */

'use strict';

import { WatchChannel } from '../base/watch-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class FsWatchChannel extends WatchChannel {
  constructor({ paths, id = 'build.fswatch' }) {
    super({ id, class: ChannelClass.BUILD, paths });
  }

  parseEvent(evt) {
    return { payload: evt, sourceRef: `fs:${evt.type}:${evt.path}`, producedAt: evt.ts };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'fs:watch',
    });
  }

  crystallize(obs) {
    const p = obs.payload.path || '';
    const tags = ['build', 'fswatch', obs.payload.type];
    if (p.includes('/docs/design/')) tags.push('design-doc');
    if (p.includes('/config/')) tags.push('config');
    if (p.includes('/engine/')) tags.push('engine');
    if (p.includes('/src/')) tags.push('harness');
    return { method: 'build_event', type: 'observation', topic: 'filesystem', tags };
  }
}
