/**
 * BridgeChatPublisher — sends a message to the bridge-chat lane only
 * when an observation's computed salience exceeds the threshold.
 * Avoids noise in jtr's chat window while still surfacing high-signal
 * observations.
 */

'use strict';

import attentionPolicy from '../attention/attention-policy.cjs';

const { classifyObservationAttention } = attentionPolicy;

export class BridgeChatPublisher {
  constructor({ salienceThreshold = 0.75, sender, ledger, logger } = {}) {
    this.salienceThreshold = salienceThreshold;
    this.sender = typeof sender === 'function' ? sender : null;
    this.ledger = ledger;
    this.logger = logger || console;
  }

  async onObservation({ salience, summary, observation } = {}) {
    if (typeof salience !== 'number' || salience < this.salienceThreshold) return null;
    if (observation) {
      const attention = classifyObservationAttention(observation);
      if (attention.mode !== 'interruptive') {
        this.logger.info?.(`[publish] bridge-chat suppressed ambient observation: ${attention.reason}`);
        return null;
      }
    }
    if (!this.sender) return null;
    try {
      await this.sender({ text: summary, observation });
      await this.ledger?.record?.({ target: 'bridge_chat', artifact: `bridge:${new Date().toISOString()}` });
      this.logger.info?.(`[publish] bridge-chat: salience ${salience.toFixed(2)}`);
      return true;
    } catch (err) {
      this.logger.warn?.('[publish] bridge-chat failed:', err?.message || err);
      return false;
    }
  }
}

/**
 * Default salience: higher for COLLECTED, recent, and high-confidence
 * observations. Simple and boundaried.
 */
export function computeSalience(obs, { now = Date.now() } = {}) {
  if (!obs || typeof obs !== 'object') return 0;
  const base = typeof obs.confidence === 'number' ? obs.confidence : 0.5;
  const flagWeight = obs.flag === 'COLLECTED' ? 1 : obs.flag === 'UNCERTIFIED' ? 0.7 : 0.3;
  const receivedAt = Date.parse(obs.receivedAt) || now;
  const ageMs = Math.max(0, now - receivedAt);
  const recency = Math.max(0, 1 - ageMs / (30 * 60 * 1000));
  return Math.min(1, base * flagWeight * (0.5 + 0.5 * recency));
}
