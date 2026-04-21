/**
 * FsWatchHome23Channel — watches the home23 code tree for changes.
 * Informational: crystallize returns null (build.fswatch handles the
 * load-bearing path tagging for design docs / config).
 */

'use strict';

import { WatchChannel } from '../base/watch-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class FsWatchHome23Channel extends WatchChannel {
  constructor({ repoPath, id = 'os.fswatch-home23' }) {
    const paths = [`${repoPath}/engine`, `${repoPath}/src`, `${repoPath}/cli`, `${repoPath}/scripts`];
    super({ id, class: ChannelClass.OS, paths });
  }

  parseEvent(evt) { return { payload: evt, sourceRef: `fs:home23:${evt.type}:${evt.path}`, producedAt: evt.ts }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'fs:home23',
    });
  }

  crystallize() { return null; }
}
