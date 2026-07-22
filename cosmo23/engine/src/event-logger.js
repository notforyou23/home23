/**
 * Event Logger — compatibility facade over the durable EventLedger (H5).
 *
 * The legacy implementation appended to events.jsonl without bound and
 * reset eventCount every process. It now delegates to
 * core/event-ledger.js: monotonic seq across restarts, sha256 prevHash
 * chain, size-capped rotation with gzip + retention.
 *
 * API changes vs the legacy class (zero callers exist — grep-verified):
 *   - initialize() and close() are async.
 *   - initialize() no longer accepts cleanStart: the ledger is append-only;
 *     hygiene comes from rotation, never from unlinking history.
 */

'use strict';

const { EventLedger } = require('./core/event-ledger');

class EventLogger {
  constructor(runPath, opts = {}) {
    this.runPath = runPath;
    this.ledger = new EventLedger(runPath, opts);
    this.filePath = this.ledger.filePath;
  }

  get eventCount() {
    return this.ledger.seq;
  }

  async initialize() {
    await this.ledger.initialize();
    this.log({ type: 'session_start' });
  }

  log(event) {
    if (!event || typeof event !== 'object') return;
    const { type, ...data } = event;
    this.ledger.log(type || 'event', data);
  }

  // Convenience methods matching the event emitter API
  emitThought(data) { this.log({ type: 'thought_generated', ...data }); }
  emitCycle(data) { this.log({ type: 'cycle_start', ...data }); }
  emitGoal(data) { this.log({ type: 'goal_created', ...data }); }
  emitAgent(data) { this.log({ type: 'agent_spawned', ...data }); }
  emitWebSearch(data) { this.log({ type: 'web_search', ...data }); }
  emitCode(data) { this.log({ type: 'code_generation', ...data }); }
  emit(type, data) { this.log({ type, ...data }); }

  async close() {
    this.log({ type: 'session_end' });
    await this.ledger.close();
  }
}

module.exports = { EventLogger };
