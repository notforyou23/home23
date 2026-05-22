/**
 * Home23 — Event Ledger (Step 20)
 *
 * Immutable, append-only log proving continuity actually happened.
 * JSONL format — one event per line.
 *
 * Event types:
 *   SessionStarted, CheckpointLoaded, RetrievalExecuted, RetrievalDegraded,
 *   EvidenceLinked, StateDeltaRecorded, UncertaintyRecorded,
 *   MemoryCandidateCreated, MemoryPromoted, MemoryRejected, MemoryChallenged,
 *   CheckpointSaved, MemoryReactivated, MemoryActedOn, HandoffReceived,
 *   OutcomeObserved, BreakdownDiagnosed, MemoryActivationPosture,
 *   TriggerFired, TriggerAccepted, TriggerRejected, TriggerMissed
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../types.js';

export class EventLedger {
  private ledgerPath: string;

  constructor(brainDir: string) {
    mkdirSync(brainDir, { recursive: true });
    this.ledgerPath = join(brainDir, 'event-ledger.jsonl');
  }

  /**
   * Append one or more events to the ledger.
   * Never throws — event logging is best-effort.
   */
  emit(events: EventEnvelope | EventEnvelope[]): void {
    const arr = Array.isArray(events) ? events : [events];
    try {
      const lines = arr.map(e => {
        const timestamp = e.timestamp ?? new Date().toISOString();
        return JSON.stringify({
          ...e,
          timestamp,
          ts: e.ts ?? timestamp,
        });
      }).join('\n') + '\n';
      appendFileSync(this.ledgerPath, lines);
    } catch (err) {
      console.warn('[event-ledger] Failed to write:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Create and emit a single event.
   */
  record(
    eventType: string,
    sessionId: string,
    payload: Record<string, unknown>,
    opts?: { threadId?: string; objectId?: string; actor?: string },
  ): EventEnvelope {
    const timestamp = new Date().toISOString();
    const event: EventEnvelope = {
      event_id: randomUUID(),
      event_type: eventType,
      session_id: sessionId,
      timestamp,
      ts: timestamp,
      actor: opts?.actor ?? 'system',
      thread_id: opts?.threadId,
      object_id: opts?.objectId,
      payload,
    };
    this.emit(event);
    return event;
  }

  /**
   * Read all events (for curator analysis).
   * Returns in chronological order.
   */
  readAll(): EventEnvelope[] {
    if (!existsSync(this.ledgerPath)) return [];
    try {
      return readFileSync(this.ledgerPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as EventEnvelope);
    } catch {
      return [];
    }
  }

  /**
   * Read events since a given timestamp.
   */
  readSince(since: string): EventEnvelope[] {
    const sinceMs = new Date(since).getTime();
    return this.readAll().filter(e => new Date(e.timestamp).getTime() >= sinceMs);
  }

  /**
   * Read events of a specific type.
   */
  readByType(eventType: string): EventEnvelope[] {
    return this.readAll().filter(e => e.event_type === eventType);
  }

  /**
   * Read events for a specific session.
   */
  readBySession(sessionId: string): EventEnvelope[] {
    return this.readAll().filter(e => e.session_id === sessionId);
  }

  /**
   * Count events by type (for audit metrics).
   */
  countByType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.readAll()) {
      counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
    }
    return counts;
  }
}
