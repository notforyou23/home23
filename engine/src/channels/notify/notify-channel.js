/**
 * NotifyChannel — tails the cognition NOTIFY stream (notifications.jsonl)
 * as a bus channel. First consumer of the bus contract — proves the pattern
 * works for verifier-gated ingest without changing existing promoter behavior.
 *
 * Observations are emitted flagged UNCERTIFIED because notify records are
 * free-form agent-reported concerns that require downstream classification
 * (the harness-side PromoterWorker does that in parallel). crystallize()
 * returns null — the promoter owns the decision to write to live-problems.
 *
 * Class is WORK (agent's own work-stream signal about its work), not NOTIFY.
 */

'use strict';

import { existsSync, readFileSync, statSync } from 'node:fs';
import chokidar from 'chokidar';
import { dirname, join } from 'node:path';
import { TailChannel } from '../base/tail-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class NotifyChannel extends TailChannel {
  constructor({ path, id = 'notify.cognition', ackPath = null }) {
    super({ id, class: ChannelClass.WORK, path });
    this.ackPath = ackPath || join(dirname(path), 'notifications-ack.json');
    this._ackWatcher = null;
    this._lastAckKeys = new Set();
  }

  loadAcks() {
    try {
      if (!existsSync(this.ackPath)) return {};
      return JSON.parse(readFileSync(this.ackPath, 'utf-8')) || {};
    } catch {
      return {};
    }
  }

  async start() {
    await super.start();
    this._lastAckKeys = new Set(Object.keys(this.loadAcks()));
    this._startAckWatcher();
  }

  async stop() {
    if (this._ackWatcher) {
      try { await this._ackWatcher.close(); } catch {}
      this._ackWatcher = null;
    }
    await super.stop();
  }

  _startAckWatcher() {
    if (this._ackWatcher) return;
    this._ackWatcher = chokidar.watch(this.ackPath, {
      persistent: false,
      usePolling: true,
      interval: this.pollIntervalMs,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 },
      ignoreInitial: true,
    });
    this._ackWatcher.on('add', () => this._emitAckUpdates());
    this._ackWatcher.on('change', () => this._emitAckUpdates());
  }

  _emitAckUpdates() {
    const acks = this.loadAcks();
    const nextKeys = new Set(Object.keys(acks));
    const newlyAcked = [...nextKeys].filter((id) => !this._lastAckKeys.has(id));
    this._lastAckKeys = nextKeys;
    if (!newlyAcked.length) return;

    const byId = this._loadNotificationsById(newlyAcked);
    for (const id of newlyAcked) {
      const obj = byId.get(id);
      if (!obj) continue;
      const parsed = this._parsedNotification(obj, acks);
      if (parsed) this._enqueue(parsed);
    }
  }

  _loadNotificationsById(ids) {
    const wanted = new Set(ids);
    const out = new Map();
    try {
      if (!existsSync(this.path) || statSync(this.path).size === 0) return out;
      const lines = readFileSync(this.path, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.id && wanted.has(obj.id)) out.set(obj.id, obj);
      }
    } catch {
      return out;
    }
    return out;
  }

  _parsedNotification(obj, acks = this.loadAcks()) {
    const ts = obj.ts || obj.timestamp || new Date().toISOString();
    const kindSlice = (obj.kind || '').slice(0, 16);
    const payload = obj.id && acks[obj.id]
      ? { ...obj, acknowledged: true, acknowledged_at: acks[obj.id].acknowledged_at }
      : obj;
    return {
      payload,
      sourceRef: `notify:${obj.id || ts}:${kindSlice}`,
      producedAt: ts,
    };
  }

  parseLine(line) {
    if (!line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    return this._parsedNotification(obj);
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'UNCERTIFIED',
      confidence: 0.5,
      producedAt: parsed.producedAt,
      verifierId: 'notify:basic',
    });
  }

  // Promoter decides promotion; the channel only emits.
  crystallize() { return null; }
}
