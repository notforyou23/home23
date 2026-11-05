/**
 * DecayWorker — gentle weight reduction on warnings, stale transforms,
 * unfinished goals, and unreferenced edges.
 *
 * Phase 0 scaffold — delegates to memory.applyDecay() when enabled and
 * the store implements it. Real behavior lands in Phase 5.
 *
 * See docs/design/STEP24-OS-ENGINE-REDESIGN.md §The Decay Worker.
 */

'use strict';

export class DecayWorker {
  constructor({ memory, logger, enabled = false, cadenceMs = 30 * 60 * 1000, halfLife = {} } = {}) {
    this.memory = memory || {};
    this.logger = logger || console;
    this.enabled = enabled;
    this.cadenceMs = cadenceMs;
    this.halfLife = halfLife;
    this._timer = null;
  }

  async tick() {
    if (!this.enabled) return { decayed: 0 };
    if (typeof this.memory.applyDecay !== 'function') return { decayed: 0 };
    const rules = {
      warning:            { halfLifeMs: this.halfLife.warning_node           || 48 * 3600 * 1000 },
      surreal_transform:  { halfLifeMs: this.halfLife.surreal_transform      || 24 * 3600 * 1000 },
      unfinished_goal:    { halfLifeMs: this.halfLife.unfinished_goal_review || 72 * 3600 * 1000 },
    };
    const updated = await this.memory.applyDecay({ now: Date.now(), rules });
    const n = Array.isArray(updated) ? updated.length : 0;
    if (n && this.logger.info) this.logger.info(`[decay] decayed ${n} memory objects`);
    return { decayed: n };
  }

  start() {
    if (this._timer) return;
    const loop = async () => {
      try { await this.tick(); }
      catch (err) {
        if (this.logger.warn) this.logger.warn('[decay] tick failed:', err && err.message ? err.message : err);
      }
      if (this._timer) this._timer = setTimeout(loop, this.cadenceMs);
    };
    this._timer = setTimeout(loop, this.cadenceMs);
  }

  stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
}
