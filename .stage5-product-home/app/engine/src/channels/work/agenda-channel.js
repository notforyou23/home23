/**
 * AgendaChannel — tails brain/agenda.jsonl so the engine observes each
 * agenda record as it's added, crystallizing the brain's own forward-
 * looking work as a first-class MemoryObject surface.
 */

'use strict';

import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class AgendaChannel extends TailChannel {
  constructor({ path, id = 'work.agenda' }) {
    super({ id, class: ChannelClass.WORK, path });
  }

  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    const record = obj.record || obj;
    return {
      payload: {
        id: record.id,
        type: obj.type || 'add',
        kind: record.kind,
        content: record.content,
        topicTags: record.topicTags || [],
        createdAt: record.createdAt,
        status: record.status,
      },
      sourceRef: `agenda:${record.id}:${obj.type || 'add'}`,
      producedAt: record.createdAt || new Date().toISOString(),
    };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'agenda:tail',
    });
  }

  crystallize(obs) {
    const tags = ['work', 'agenda'];
    if (obs.payload.kind) tags.push(obs.payload.kind);
    for (const t of obs.payload.topicTags || []) tags.push(t);
    return { method: 'work_event', type: 'observation', topic: 'agenda', tags };
  }
}
