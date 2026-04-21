/**
 * ChannelBus — the OS engine's universal ingest spine.
 *
 * Registration → scheduling → fan-in → fan-out with per-channel JSONL
 * persistence for audit and replay.
 *
 * Emits:
 *   'observation'   — every verified observation from every channel
 *   'crystallize'   — when a channel returns a non-null crystallize() draft
 *
 * Persistence: if persistenceDir is provided, each channel's raw stream is
 * appended to `<class>.<id>.jsonl` under that dir. MemoryObjects are the
 * distilled output downstream; the JSONL sidecar is the audit record.
 *
 * See docs/design/STEP24-OS-ENGINE-REDESIGN.md §The Universal Channel Bus.
 */

'use strict';

import { EventEmitter } from 'node:events';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export class ChannelBus extends EventEmitter {
  constructor({ persistenceDir, logger } = {}) {
    super();
    this.setMaxListeners(50);
    this.channels = [];
    this.persistenceDir = persistenceDir || null;
    this.logger = logger || console;
    this._running = false;
  }

  register(channel) {
    if (!channel || !channel.id) throw new Error('ChannelBus.register requires a channel with id');
    if (this.channels.find((c) => c.id === channel.id)) {
      throw new Error(`duplicate channel id: ${channel.id}`);
    }
    this.channels.push(channel);
  }

  async start() {
    if (this._running) return;
    this._running = true;
    if (this.persistenceDir) {
      try { mkdirSync(this.persistenceDir, { recursive: true }); } catch {}
    }
    for (const ch of this.channels) {
      if (typeof ch.start === 'function') {
        try { await ch.start(); } catch (err) { this._logWarn(`channel ${ch.id} start failed`, err); }
      }
      this._pumpChannel(ch);
    }
  }

  async stop() {
    this._running = false;
    for (const ch of this.channels) {
      try { if (typeof ch.stop === 'function') await ch.stop(); } catch {}
    }
  }

  _pumpChannel(channel) {
    (async () => {
      try {
        for await (const raw of channel.source()) {
          if (!this._running) break;
          await this._handleRaw(channel, raw);
        }
      } catch (err) {
        this._logWarn(`channel ${channel.id} pump failed`, err);
      }
    })();
  }

  async _handleRaw(channel, raw) {
    try {
      const parsed = raw && raw.payload !== undefined ? raw : channel.parse(raw);
      const obs = channel.verify(parsed, {});
      if (!obs || !obs.flag) return;
      this._persist(channel, obs);
      this.emit('observation', obs);
      const draft = channel.crystallize(obs);
      if (draft) this.emit('crystallize', { channel, observation: obs, draft });
    } catch (err) {
      this._logWarn(`handle failed on ${channel.id}`, err);
    }
  }

  _persist(channel, obs) {
    if (!this.persistenceDir) return;
    const path = join(this.persistenceDir, `${channel.class}.${channel.id}.jsonl`);
    try { appendFileSync(path, JSON.stringify(obs) + '\n'); }
    catch (err) { this._logWarn(`persist failed for ${channel.id}`, err); }
  }

  _logWarn(msg, err) {
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(`[bus] ${msg}:`, err && err.message ? err.message : err);
    }
  }
}
