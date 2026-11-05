/**
 * NeighborChannel — polls a peer agent's GET /__state/public.json and
 * emits UNCERTIFIED observations when the peer's lastMemoryWrite /
 * snapshotAt advance. Default confidence 0.70 per channel_gossip cap.
 *
 * Crystallizes via neighbor_gossip so the bus MemoryIngest applies the
 * hard 0.70 cap regardless of what confidence we pass through.
 */

'use strict';

import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

async function defaultFetch(url, { token = null, headers = null } = {}) {
  try {
    const requestHeaders = { accept: 'application/json', ...(headers || {}) };
    if (token && !requestHeaders.authorization && !requestHeaders.Authorization) {
      requestHeaders.authorization = `Bearer ${token}`;
    }
    const res = await fetch(url, { method: 'GET', headers: requestHeaders });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export class NeighborChannel extends PollChannel {
  constructor({ peerName, url, intervalMs = 3 * 60 * 1000, fetchState = null, id = null, token = null, headers = null, peerSource = null }) {
    super({ id: id || `neighbor.${peerName}`, class: ChannelClass.NEIGHBOR, intervalMs });
    this.peerName = peerName;
    this.url = url;
    this.peerSource = peerSource || null;
    this.fetchState = typeof fetchState === 'function' ? fetchState : (() => defaultFetch(url, { token, headers }));
    this._lastKey = null;
  }

  async poll() {
    const st = await this.fetchState();
    if (!st) return [];
    const key = `${st.lastMemoryWrite || ''}:${st.snapshotAt || ''}`;
    if (key === this._lastKey) return [];
    this._lastKey = key;
    return [st];
  }

  parse(raw) {
    const agent = raw.agent || this.peerName;
    const snapshotAt = raw.snapshotAt || new Date().toISOString();
    return {
      payload: { ...raw, agent, snapshotAt },
      sourceRef: `neighbor:${agent}:${snapshotAt}`,
      producedAt: snapshotAt,
      origin: {
        agent,
        peerName: this.peerName,
        peerSource: this.peerSource,
        url: this.url,
        snapshotAt,
        protocol: 'home23-neighbor-state',
        protocolVersion: raw.origin?.protocolVersion || raw.provenance?.protocolVersion || 1,
      },
    };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'UNCERTIFIED', confidence: 0.7, producedAt: parsed.producedAt,
      verifierId: `neighbor:${this.peerName}`,
      origin: parsed.origin,
    });
  }

  crystallize(obs) {
    const tags = ['neighbor', this.peerName];
    if (obs.origin?.agent) tags.push(`agent:${obs.origin.agent}`);
    if (obs.origin?.peerSource) tags.push(`peer-source:${obs.origin.peerSource}`);
    if (obs.payload.dispatchState) tags.push(obs.payload.dispatchState);
    return { method: 'neighbor_gossip', type: 'observation', topic: 'neighbor-state', tags };
  }
}
