/**
 * Home23 — Trigger Index (Step 20)
 *
 * Loads durable MemoryObject triggers on startup.
 * Evaluates trigger conditions against inbound messages per-turn.
 * Records trigger audit events.
 */

import type { MemoryObject, TriggerCondition, EventEnvelope } from '../types.js';
import type { MemoryObjectStore } from './memory-objects.js';
import type { EventLedger } from './event-ledger.js';
import { semanticMatchScore, SEMANTIC_MATCH_FLOOR } from '../substrate/semantic-match.js';

interface TriggerMatch {
  memoryId: string;
  trigger: TriggerCondition;
  memory: MemoryObject;
}

export class TriggerIndex {
  private entries: Array<{ memory: MemoryObject; trigger: TriggerCondition }> = [];

  /**
   * Load all durable memories with triggers.
   */
  loadFrom(store: MemoryObjectStore): void {
    const durable = store.getDurableWithTriggers();
    this.entries = [];
    for (const obj of durable) {
      for (const trigger of obj.triggers) {
        this.entries.push({ memory: obj, trigger });
      }
    }
    console.log(`[trigger-index] Loaded ${this.entries.length} trigger(s) from ${durable.length} durable memories`);
  }

  /**
   * Evaluate all triggers against the current message + context.
   * Returns matching memories.
   */
  evaluate(
    userText: string,
    context: { isFirstTurn: boolean; recentDomains?: string[] },
    ledger?: EventLedger,
    sessionId?: string,
    embed?: (text: string) => number[] | null,
  ): TriggerMatch[] {
    const matches: TriggerMatch[] = [];
    const textLower = userText.toLowerCase();

    for (const entry of this.entries) {
      let fired = false;

      switch (entry.trigger.trigger_type) {
        case 'keyword': {
          // v2 cut 3: the keyword list is a meaning-anchor, not a tripwire —
          // the turn's meaning must genuinely pull toward the memory (title +
          // cues, matched in the retina's native space at the calibrated
          // floor). Substring remains the degraded fallback so a down
          // embedder never silences reactivation entirely.
          const keywords = entry.trigger.condition.split(/\s+OR\s+/i).map(k => k.trim().toLowerCase());
          const score = semanticMatchScore(userText, `${entry.memory.title}: ${keywords.join(', ')}`, embed);
          fired = score !== null
            ? score >= SEMANTIC_MATCH_FLOOR
            : keywords.some(kw => textLower.includes(kw));
          break;
        }
        case 'temporal': {
          if (entry.trigger.condition === 'first turn of new session') {
            fired = context.isFirstTurn;
          }
          break;
        }
        case 'domain_entry': {
          // Check if recent domains include the specified domain
          const domain = entry.trigger.condition.replace(/conversation enters\s+/i, '').replace(/\s+domain$/i, '').trim().toLowerCase();
          fired = context.recentDomains?.includes(domain) ?? false;
          break;
        }
        case 'workflow_stage': {
          // Meaning-gated like keyword triggers; substring fallback.
          const stage = entry.trigger.condition.toLowerCase();
          const score = semanticMatchScore(userText, `${entry.memory.title}: ${stage}`, embed);
          fired = score !== null
            ? score >= SEMANTIC_MATCH_FLOOR
            : textLower.includes(stage);
          break;
        }
        case 'recurrence': {
          // Recurrence matching is complex — defer to curator cycle
          fired = false;
          break;
        }
      }

      if (fired) {
        matches.push({
          memoryId: entry.memory.memory_id,
          trigger: entry.trigger,
          memory: entry.memory,
        });

        // Emit TriggerFired event
        if (ledger && sessionId) {
          ledger.record('TriggerFired', sessionId, {
            memory_id: entry.memory.memory_id,
            trigger_type: entry.trigger.trigger_type,
            trigger_condition: entry.trigger.condition,
            memory_title: entry.memory.title,
          }, { objectId: entry.memory.memory_id, actor: 'trigger-index' });
        }
      }
    }

    return matches;
  }
}
