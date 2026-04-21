/**
 * MemoryIngest — engine-side writer that lands verified observations into
 * the harness-managed memory-objects.json + crystallization-receipts.jsonl.
 *
 * The harness's TypeScript MemoryObjectStore (src/agent/memory-objects.ts)
 * owns the schema and read path. The engine's bus writes to the same file
 * with proper-lockfile so both processes can coexist safely. When the
 * harness reloads (on conversation boundary or startup), it sees the bus-
 * ingested MemoryObjects as part of the same store.
 *
 * Confidence caps mirror config/home.yaml → osEngine.crystallization.
 */

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const lockfile = require('proper-lockfile');

const CHANNEL_CAPS = Object.freeze({
  sensor_primary:     0.95,
  sensor_derived:     0.80,
  build_event:        0.90,
  work_event:         0.90,
  neighbor_gossip:    0.70,
  zero_context_audit: 0.20,
});

function applyChannelCap(method, confidence) {
  const cap = CHANNEL_CAPS[method];
  if (cap === undefined) return confidence;
  return Math.min(confidence, cap);
}

class MemoryIngest {
  constructor({ brainDir, logger }) {
    if (!brainDir) throw new Error('MemoryIngest requires brainDir');
    this.brainDir = brainDir;
    this.logger = logger || console;
    this.objectsPath = path.join(brainDir, 'memory-objects.json');
    this.receiptsPath = path.join(brainDir, 'crystallization-receipts.jsonl');
    try { fs.mkdirSync(brainDir, { recursive: true }); } catch {}
  }

  _loadSafe() {
    if (!fs.existsSync(this.objectsPath)) return { objects: [] };
    try {
      const raw = fs.readFileSync(this.objectsPath, 'utf8');
      if (!raw.trim()) return { objects: [] };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.objects)) return { objects: [] };
      return parsed;
    } catch { return { objects: [] }; }
  }

  _toMemoryObject(obs, draft, existing) {
    const now = new Date().toISOString();
    const confidenceRaw = applyChannelCap(draft.method, obs.confidence);
    const confidence = obs.flag === 'ZERO_CONTEXT'
      ? Math.min(confidenceRaw, CHANNEL_CAPS.zero_context_audit)
      : confidenceRaw;
    const id = existing?.memory_id || `mo-bus-${crypto.randomUUID()}`;
    const title = `[${obs.channelId}] ${summarizePayload(obs.payload)}`.slice(0, 120);
    const statement = typeof obs.payload === 'string' ? obs.payload : safeStringify(obs.payload);
    return {
      memory_id: id,
      type: draft.type || 'observation',
      thread_id: 'bus-ingest',
      session_id: `bus-ingest-${obs.receivedAt.slice(0, 10)}`,
      lifecycle_layer: 'raw',
      status: 'candidate',
      title,
      statement: statement.slice(0, 4000),
      summary: summarizePayload(obs.payload).slice(0, 280),
      created_at: existing?.created_at || now,
      updated_at: now,
      actor: 'os-engine-bus',
      provenance: {
        source_refs: [obs.sourceRef, obs.channelId, ...(draft.tags || [])],
        session_refs: [`bus-ingest-${obs.receivedAt.slice(0, 10)}`],
        generation_method: draft.method || 'build_event',
      },
      evidence: {
        evidence_links: obs.verifierId ? [`verifier:${obs.verifierId}`] : [],
        grounding_strength: obs.flag === 'COLLECTED' ? 'strong' : obs.flag === 'UNCERTIFIED' ? 'medium' : 'weak',
        grounding_note: `flag=${obs.flag}`,
      },
      confidence: {
        score: confidence,
        basis: `bus-ingest/${obs.flag}/${draft.method || 'n/a'}`,
      },
      state_delta: {
        delta_class: 'no_change',
        before: {},
        after: {},
        why: 'observation ingested',
      },
      triggers: [],
      scope: {
        applies_to: (draft.tags || []).slice(),
        excludes: [],
      },
      review_state: 'unreviewed',
      staleness_policy: {},
      reuse_count: existing?.reuse_count ?? 0,
    };
  }

  async writeFromObservation(obs, draft) {
    if (!obs || !obs.channelId) throw new Error('writeFromObservation requires obs with channelId');
    if (!draft) draft = { method: 'build_event', type: 'observation', topic: obs.channelId, tags: [] };

    // Ensure the file exists before acquiring a lock
    if (!fs.existsSync(this.objectsPath)) {
      fs.writeFileSync(this.objectsPath, JSON.stringify({ objects: [] }));
    }

    let written = null;
    await lockfile.lock(this.objectsPath, { retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } })
      .then(async (release) => {
        try {
          const store = this._loadSafe();
          const existing = store.objects.find(
            (o) => Array.isArray(o.provenance?.source_refs)
              && o.provenance.source_refs.includes(obs.sourceRef)
              && o.provenance.source_refs.includes(obs.channelId),
          );
          const mo = this._toMemoryObject(obs, draft, existing);
          if (existing) {
            const idx = store.objects.indexOf(existing);
            store.objects[idx] = mo;
          } else {
            store.objects.push(mo);
          }
          fs.writeFileSync(this.objectsPath, JSON.stringify(store));
          written = mo;
        } finally {
          await release();
        }
      })
      .catch((err) => {
        this.logger.warn?.('[memory-ingest] write failed:', err?.message || err);
        throw err;
      });

    if (written) {
      const receipt = {
        at: new Date().toISOString(),
        channelId: obs.channelId,
        sourceRef: obs.sourceRef,
        memoryObjectId: written.memory_id,
        flag: obs.flag,
        confidence: written.confidence.score,
        method: draft.method || null,
      };
      try { fs.appendFileSync(this.receiptsPath, JSON.stringify(receipt) + '\n'); }
      catch (err) { this.logger.warn?.('[memory-ingest] receipt append failed:', err?.message || err); }
    }

    return written;
  }
}

function summarizePayload(payload) {
  if (payload == null) return '(empty)';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);
  // Prefer obvious textual fields
  for (const k of ['summary', 'subject', 'content', 'title', 'message', 'event']) {
    if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k];
  }
  return safeStringify(payload).slice(0, 280);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { MemoryIngest, applyChannelCap, CHANNEL_CAPS };
