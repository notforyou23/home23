/**
 * Attention gate for Home23's Companion Layer (Step 30, Piece 3).
 *
 * Notice broadly, interrupt narrowly — for AUTONOMOUS, resident-originated
 * outbound messages only (cron/scheduler turns, live-problems notifications,
 * good-life and agency chatter, worker/subagent results). It decides whether a
 * resident-initiated message earns jtr's attention now (surface), should be
 * dropped (suppress), or should be held for a later digest (aggregate).
 *
 * The core is deterministic-first: no model calls, no Math.random, no Date.now
 * in any decision path (time comes through the injected nowMs()). Reason slugs
 * are the inspectable audit trail — every verdict names why.
 *
 * This mirrors the materiality vocabulary and thresholds of the engine policy
 * in engine/src/attention/attention-policy.cjs (classifyAttentionRequest /
 * shouldInterrupt): interruptive on requiresAction / automation-exhausted /
 * anomaly / alert+urgent+ severity; deferral on stale signals and protected
 * rhythms. It is a self-contained TS reimplementation (the .cjs is NOT
 * imported) so the harness gate is independently testable.
 *
 * NOTE: in production this gate NEVER sees a real user-reply turn — the
 * orchestrator only wires it into DeliveryManager.deliver() and the
 * /api/notify handler, both of which carry resident-originated traffic. The
 * origin==='user-reply' and numeric-chatId guards below are defense-in-depth,
 * so a mis-wire can never suppress an answer jtr actually asked for.
 */

export type OutboundOrigin =
  | 'cron'
  | 'live-problems'
  | 'good-life'
  | 'agency'
  | 'subagent'
  | 'coding'
  | 'user-reply'
  | 'unknown';

export type AttentionDecision = 'surface' | 'suppress' | 'aggregate';

export interface OutboundSignal {
  origin: OutboundOrigin;
  chatId?: string;
  text: string;
  // Materiality inputs (all optional; the gate stays conservative when unknown).
  severity?: 'info' | 'notice' | 'alert' | 'urgent' | 'critical' | 'emergency';
  requiresAction?: boolean;
  isFailure?: boolean;
  isDirectAnswer?: boolean;
  changesStory?: boolean;
  explicitlyWatched?: boolean;
  kind?: 'anomaly' | 'status' | 'telemetry' | 'digest' | string;
  observedAtMs?: number;
  jtrRhythm?: string;
  dedupeKey?: string;
}

export interface AttentionVerdict {
  decision: AttentionDecision;
  reason: string;
  detail?: string;
}

export interface AttentionGateOptions {
  nowMs?: () => number;
  dedupeWindowMs?: number;
  aggregateFlushCount?: number;
  aggregateFlushMs?: number;
}

const CRITICAL_SEVERITIES = new Set(['critical', 'emergency']);
const INTERRUPTIVE_SEVERITIES = new Set(['alert', 'urgent']);
const URGENT_PLUS = new Set(['urgent', 'alert', 'critical', 'emergency']);
const PROTECTED_RHYTHMS = new Set(['family-evening', 'sleep', 'deep-work']);
const NOISE_KINDS = new Set(['telemetry', 'metric', 'health', 'health-metric', 'heartbeat', 'queue-depth', 'ping', 'stat']);
const DIGEST_KINDS = new Set(['status', 'digest', 'summary']);

const DEFAULT_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AGGREGATE_FLUSH_COUNT = 8;
const DEFAULT_AGGREGATE_FLUSH_MS = 60 * 60 * 1000;

function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function isNumericChatId(chatId?: string): boolean {
  return typeof chatId === 'string' && /^-?\d+$/.test(chatId.trim());
}

/**
 * Map a chatId to its outbound origin using Home23's prefix conventions.
 * Numeric ids are real jtr user turns and must never be gated.
 */
export function originFromChatId(chatId?: string): OutboundOrigin {
  if (!chatId || !chatId.trim()) return 'unknown';
  const id = chatId.trim();
  if (/^-?\d+$/.test(id)) return 'user-reply';
  if (id.startsWith('cron-')) return 'cron';
  if (id.startsWith('proposer:')) return 'agency';
  if (id.startsWith('worker:')) return 'agency';
  if (id.startsWith('subagent:')) return 'subagent';
  return 'unknown';
}

export class AttentionGate {
  private readonly nowMs: () => number;
  private readonly dedupeWindowMs: number;
  private readonly aggregateFlushCount: number;
  private readonly aggregateFlushMs: number;
  private readonly dedupe = new Map<string, number>();
  private aggregateBuffer: Array<{ signal: OutboundSignal; atMs: number }> = [];

  constructor(opts: AttentionGateOptions = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.dedupeWindowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.aggregateFlushCount = opts.aggregateFlushCount ?? DEFAULT_AGGREGATE_FLUSH_COUNT;
    this.aggregateFlushMs = opts.aggregateFlushMs ?? DEFAULT_AGGREGATE_FLUSH_MS;
  }

  /**
   * Deterministic decision tree. HARD safety rules (1-4) run first: user
   * questions, requested results, blocking failures, and critical escalations
   * always surface. Only after those do the softening rules (dedup, materiality,
   * staleness, protected rhythms, telemetry noise) apply.
   */
  evaluate(signal: OutboundSignal): AttentionVerdict {
    // 1. Never gate a real user turn (numeric chatId) or an explicit user-reply.
    if (signal.origin === 'user-reply' || isNumericChatId(signal.chatId)) {
      return { decision: 'surface', reason: 'user_reply_never_gated' };
    }

    // 2. A requested result / direct answer to jtr must never be suppressed.
    if (signal.isDirectAnswer === true) {
      return { decision: 'surface', reason: 'direct_answer_never_suppressed' };
    }

    // 3. A failure that PREVENTS completion stays visible.
    if (signal.isFailure === true) {
      return { decision: 'surface', reason: 'failure_must_surface' };
    }

    // 4. Preserve urgent escalation.
    if (signal.severity && CRITICAL_SEVERITIES.has(signal.severity)) {
      return { decision: 'surface', reason: 'critical_escalation' };
    }

    const now = this.nowMs();

    // 5. Duplicate within the dedupe window — hold the noise.
    const key = this.keyFor(signal);
    const lastMs = this.dedupe.get(key);
    if (lastMs !== undefined && now - lastMs < this.dedupeWindowMs) {
      return {
        decision: 'suppress',
        reason: 'duplicate_suppressed',
        detail: `same key ${Math.round((now - lastMs) / 1000)}s ago`,
      };
    }

    // 6. Materiality — surface iff the signal carries operator-relevant weight.
    const material = this.materialReason(signal);
    if (material) {
      return { decision: 'surface', reason: material };
    }

    // 7. Stale non-material signal — old state is not live state.
    if (typeof signal.observedAtMs === 'number' && Number.isFinite(signal.observedAtMs)) {
      const ageMs = now - signal.observedAtMs;
      if (ageMs > this.maxAgeFor(signal.severity)) {
        return {
          decision: 'suppress',
          reason: 'stale_signal_deferred',
          detail: `age ${Math.round(ageMs / 60000)}m`,
        };
      }
    }

    // 8. Protected rhythm — defer non-urgent, non-action chatter to a digest.
    if (
      signal.jtrRhythm
      && PROTECTED_RHYTHMS.has(signal.jtrRhythm)
      && !signal.requiresAction
      && !(signal.severity && URGENT_PLUS.has(signal.severity))
    ) {
      return {
        decision: 'aggregate',
        reason: 'protected_rhythm_defers_non_urgent',
        detail: signal.jtrRhythm,
      };
    }

    // 9. Routine telemetry/status/digest with no materiality must not dominate.
    const kind = (signal.kind ?? '').toLowerCase();
    if (NOISE_KINDS.has(kind)) {
      return { decision: 'suppress', reason: 'telemetry_noise_suppressed', detail: kind };
    }
    if (DIGEST_KINDS.has(kind)) {
      return { decision: 'aggregate', reason: 'aggregated_low_materiality', detail: kind };
    }

    // 10. Conservative default — hold for a later digest rather than spam.
    return { decision: 'aggregate', reason: 'low_materiality_deferred' };
  }

  /** Mark a key as surfaced. Call AFTER a real surface so the next duplicate is caught. */
  record(signal: OutboundSignal): void {
    const now = this.nowMs();
    this.dedupe.set(this.keyFor(signal), now);
    this.pruneDedupe(now);
  }

  /** Hold a signal for the next digest flush. */
  enqueueAggregate(signal: OutboundSignal): void {
    this.aggregateBuffer.push({ signal, atMs: this.nowMs() });
  }

  pendingAggregateCount(): number {
    return this.aggregateBuffer.length;
  }

  /** Return and clear the held signals. The caller sends the digest — the gate never sends. */
  drainAggregate(): OutboundSignal[] {
    const out = this.aggregateBuffer.map((entry) => entry.signal);
    this.aggregateBuffer = [];
    return out;
  }

  /** True when the buffer is worth flushing (count threshold reached or oldest entry aged out). */
  shouldFlushAggregate(): boolean {
    if (this.aggregateBuffer.length === 0) return false;
    if (this.aggregateFlushCount > 0 && this.aggregateBuffer.length >= this.aggregateFlushCount) {
      return true;
    }
    if (this.aggregateFlushMs > 0) {
      const oldest = this.aggregateBuffer[0];
      if (oldest && this.nowMs() - oldest.atMs >= this.aggregateFlushMs) return true;
    }
    return false;
  }

  /** Compact, deduped, bounded (~1500 chars) digest of held signals for a single message. */
  buildDigest(signals: OutboundSignal[]): string {
    const MAX = 1500;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const s of signals) {
      const key = this.keyFor(s);
      if (seen.has(key)) continue;
      seen.add(key);
      const text = (s.text ?? '').replace(/\s+/g, ' ').trim();
      const snippet = text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
      lines.push(`• [${s.origin}] ${snippet}`);
    }

    const header = `Held updates (${seen.size}):`;
    let body = header;
    let included = 0;
    for (const line of lines) {
      if (body.length + 1 + line.length > MAX) break;
      body += `\n${line}`;
      included++;
    }
    if (included < lines.length) {
      const more = `\n…(+${lines.length - included} more)`;
      if (body.length + more.length <= MAX) body += more;
    }
    return body;
  }

  private keyFor(signal: OutboundSignal): string {
    if (signal.dedupeKey && signal.dedupeKey.trim()) return signal.dedupeKey.trim();
    return `text:${fnv1aHex(signal.text ?? '')}`;
  }

  private materialReason(signal: OutboundSignal): string | null {
    if (signal.requiresAction === true) return 'action_required';
    if ((signal.kind ?? '').toLowerCase() === 'anomaly') return 'anomaly';
    if (signal.severity && INTERRUPTIVE_SEVERITIES.has(signal.severity)) {
      return `severity_${signal.severity}`;
    }
    if (signal.changesStory === true) return 'changes_story';
    if (signal.explicitlyWatched === true) return 'explicitly_watched';
    return null;
  }

  private maxAgeFor(severity?: string): number {
    switch (severity) {
      case 'urgent':
      case 'alert':
        return 15 * 60 * 1000;
      case 'notice':
        return 60 * 60 * 1000;
      case 'info':
      default:
        return DEFAULT_MAX_AGE_MS;
    }
  }

  private pruneDedupe(now: number): void {
    for (const [k, ts] of this.dedupe) {
      if (now - ts >= this.dedupeWindowMs) this.dedupe.delete(k);
    }
  }
}
