/**
 * Channel contract for the OS-engine universal bus.
 *
 * Every signal the engine observes — machine telemetry, OS state, domain
 * sensors, build events, work events, neighbor gossip — implements this
 * interface. See docs/design/STEP24-OS-ENGINE-REDESIGN.md for the design.
 */

'use strict';

import { createHash } from 'node:crypto';

export const ChannelClass = Object.freeze({
  MACHINE:  'machine',
  OS:       'os',
  DOMAIN:   'domain',
  BUILD:    'build',
  WORK:     'work',
  NEIGHBOR: 'neighbor',
});

export const VERIFICATION_FLAGS = Object.freeze([
  'COLLECTED', 'UNCERTIFIED', 'ZERO_CONTEXT', 'UNKNOWN',
]);

export function makeTraceId(channelId, sourceRef) {
  const input = `${channelId || 'unknown'}\0${sourceRef || 'unknown'}`;
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 24);
  return `trace:${hash}`;
}

export function ensureTraceId(obs) {
  if (!obs || typeof obs !== 'object') return obs;
  if (obs.traceId) return obs;
  return {
    ...obs,
    traceId: makeTraceId(obs.channelId, obs.sourceRef),
  };
}

export function validateObservation(obs) {
  if (!obs || typeof obs !== 'object') {
    throw new Error('observation must be an object');
  }
  if (typeof obs.traceId !== 'string' || !/^trace:[0-9a-f]{24}$/.test(obs.traceId)) {
    throw new Error(`observation.traceId invalid: ${obs.traceId}`);
  }
  if (typeof obs.channelId !== 'string' || !obs.channelId.trim()) {
    throw new Error('observation.channelId is required');
  }
  if (typeof obs.sourceRef !== 'string' || !obs.sourceRef.trim()) {
    throw new Error('observation.sourceRef is required');
  }
  if (!VERIFICATION_FLAGS.includes(obs.flag)) {
    throw new Error(`observation.flag invalid: ${obs.flag}`);
  }
  if (typeof obs.confidence !== 'number' || obs.confidence < 0 || obs.confidence > 1) {
    throw new Error(`observation.confidence must be 0..1, got ${obs.confidence}`);
  }
  if (typeof obs.producedAt !== 'string' || !obs.producedAt.trim()) {
    throw new Error('observation.producedAt is required');
  }
  if (typeof obs.receivedAt !== 'string' || !obs.receivedAt.trim()) {
    throw new Error('observation.receivedAt is required');
  }
  return obs;
}

/**
 * Build a well-formed verified observation. Throws on invalid flag or
 * out-of-range confidence so bad data never leaves a channel.
 */
export function makeObservation({
  channelId,
  sourceRef,
  payload,
  flag,
  confidence,
  producedAt,
  verifierId,
  traceId,
  origin,
}) {
  if (!VERIFICATION_FLAGS.includes(flag)) {
    throw new Error(`invalid verification flag: ${flag}`);
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error(`confidence must be 0..1, got ${confidence}`);
  }
  return validateObservation({
    traceId: traceId || makeTraceId(channelId, sourceRef),
    channelId,
    sourceRef,
    payload,
    flag,
    confidence,
    producedAt,
    receivedAt: new Date().toISOString(),
    verifierId: verifierId || null,
    ...(origin ? { origin } : {}),
  });
}

/**
 * Base Channel. Concrete channels override source()/parse()/verify()/
 * crystallize(). Subclasses live in channels/base/ (shared shapes) or
 * per-class folders (build/, work/, domain/, machine/, os/, neighbor/).
 */
export class Channel {
  constructor({ id, class: cls }) {
    if (!id) throw new Error('Channel requires id');
    if (!cls) throw new Error('Channel requires class');
    this.id = id;
    this.class = cls;
  }

  async source() { throw new Error('Channel.source() not implemented'); }
  parse(_raw)    { throw new Error('Channel.parse() not implemented'); }

  // Default verify: trust the parse and tag as COLLECTED. Concrete
  // channels override to apply channel-specific evidence logic.
  verify(parsed, _ctx) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'COLLECTED',
      confidence: 0.9,
      producedAt: parsed.producedAt,
    });
  }

  // Default crystallize: null (informational only). Concrete channels
  // override when observations should become MemoryObjects.
  crystallize(_verified) { return null; }
}
