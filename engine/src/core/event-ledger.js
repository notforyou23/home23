/**
 * Event Ledger — engine-side mirror of src/agent/event-ledger.ts
 *
 * Writes to the same append-only JSONL file the harness uses:
 *   instances/<agent>/brain/event-ledger.jsonl
 *
 * Format matches EventEnvelope (see src/types.ts). Both harness (TS) and
 * engine (JS) write to the shared file so continuity auditing sees all
 * activity from both sides.
 *
 * Phase 5 of thinking-machine-cycle rebuild. See
 * docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md.
 *
 * Event types emitted by the engine pipeline (in addition to Step 20's):
 *   ThoughtEmerged        — deep-dive produced raw thought (pre-critique)
 *   PgsInvoked            — connect phase called PGS, with result metadata
 *   CritiqueVerdict       — critique pass result (one event per pass)
 *   MemoryCandidateCreated — kept thought enters the promotion pipeline
 *   ThoughtDiscarded      — discard with reason + pass count
 *
 * Never throws. Event logging is best-effort.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_EVENT_SCHEMA = 'home23.state-event.v1';

class EventLedger {
  constructor(brainDir, opts = {}) {
    this.brainDir = brainDir;
    this.ledgerPath = opts.ledgerPath
      ? path.resolve(opts.ledgerPath)
      : path.join(brainDir, 'event-ledger.jsonl');
    this.logger = opts.logger || null;
    this.ready = false;
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      this.ready = true;
    } catch (err) {
      this.logger?.warn?.('[event-ledger] brainDir mkdir failed', { error: err?.message });
    }
  }

  /**
   * Record a single event. Never throws.
   *
   * @param {string} eventType
   * @param {string} sessionId - logical grouping (cycle id, session id, etc.)
   * @param {object} payload
   * @param {object} [opts] - optional thread_id / object_id / actor
   * @returns {object} the emitted event envelope
   */
  record(eventType, sessionId, payload, opts = {}) {
    const envelope = {
      event_id: crypto.randomUUID(),
      event_type: eventType,
      thread_id: opts.threadId,
      session_id: sessionId || 'engine',
      object_id: opts.objectId,
      timestamp: new Date().toISOString(),
      actor: opts.actor || 'engine',
      invocation_id: opts.invocationId,
      payload: payload || {},
    };
    this._append(envelope);
    return envelope;
  }

  /**
   * Record multiple events as a batch. Chain-ordered: later events know
   * earlier event_ids for linkage via payload.prevEventId if caller sets it.
   */
  recordBatch(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    for (const e of events) this._append(e);
  }

  recordStateTransition({
    eventType,
    subject,
    actor = 'engine',
    payload = {},
    evidence = null,
    sourceSurface = null,
    causedBy = null,
    occurredAt = null,
    sessionId = null,
    threadId = null,
    objectId = null,
    invocationId = null,
  } = {}) {
    if (!eventType) throw new Error('recordStateTransition requires eventType');
    if (!subject) throw new Error('recordStateTransition requires subject');
    const transitionPayload = compactObject({
      schema: STATE_EVENT_SCHEMA,
      subject,
      occurredAt: occurredAt || new Date().toISOString(),
      causedBy,
      sourceSurface,
      evidence,
      payload,
      payloadHash: sha256(canonicalJson({ eventType, subject, causedBy, sourceSurface, evidence, payload })),
    });
    return this.record(eventType, sessionId || `state:${subject}`, transitionPayload, {
      actor,
      threadId: threadId || `state:${subject}`,
      objectId: objectId || subject,
      invocationId,
    });
  }

  _append(envelope) {
    if (!this.ready) return;
    try {
      fs.appendFileSync(this.ledgerPath, JSON.stringify(envelope) + '\n', 'utf8');
    } catch (err) {
      this.logger?.warn?.('[event-ledger] append failed', { error: err?.message });
    }
  }

  /**
   * Read all events (synchronous, best-effort).
   */
  readAll() {
    if (!fs.existsSync(this.ledgerPath)) return [];
    try {
      return fs.readFileSync(this.ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  readByType(eventType) {
    return this.readAll().filter(e => e.event_type === eventType);
  }

  readBySession(sessionId) {
    return this.readAll().filter(e => e.session_id === sessionId);
  }

  readStateChain(subject) {
    return this.readAll().filter(e => (
      e.payload?.schema === STATE_EVENT_SCHEMA
      && e.payload?.subject === subject
    ));
  }

  projectSubject(subject) {
    const events = this.readStateChain(subject);
    const latest = events[events.length - 1] || null;
    return {
      subject,
      eventCount: events.length,
      latestEventType: latest?.event_type || null,
      latest: latest ? latest.payload : null,
      events,
    };
  }

  countByType() {
    const counts = {};
    for (const e of this.readAll()) counts[e.event_type] = (counts[e.event_type] || 0) + 1;
    return counts;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

module.exports = { EventLedger, STATE_EVENT_SCHEMA };
