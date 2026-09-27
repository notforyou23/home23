'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendJsonlDurableSync, writeFileDurableSync } = require('../utils/durable-write');

function actionEvent(entry, receiptLine) {
  const status = entry.phase === 'intent' ? 'intent'
    : entry.status === 'success' ? 'completed'
    : entry.status === 'dry_run' ? 'simulated'
    : ['failed', 'rejected', 'blocked', 'cancelled', 'queued', 'dispatched'].includes(entry.status) ? entry.status : 'unknown';
  const scope = status === 'completed' ? 'handler completed; task outcome unverified'
    : status === 'simulated' ? 'simulation only; handler not invoked' : status;
  const detail = String(entry.detail || entry.reason || '').slice(0, 1200);
  const digest = crypto.createHash('sha256').update(receiptLine).digest('hex');
  return {
    event_id: `action-receipt:${digest}`,
    event_type: entry.phase === 'intent' ? 'ExecutionIntentObserved' : 'ExecutionOutcomeObserved',
    session_id: `action:${entry.executionId}`, object_id: entry.executionId,
    timestamp: entry.timestamp || entry.ts, ts: entry.timestamp || entry.ts,
    actor: 'engine-action-dispatcher',
    payload: {
      schema: 'home23.execution-outcome.v1', executionKind: 'action', executionId: entry.executionId,
      phase: entry.phase, status, declaredStatus: entry.status || 'intent',
      verificationStatus: 'unknown', taskOutcomeVerified: false,
      action: String(entry.action).slice(0, 160), target: String(entry.target || '').slice(0, 500) || null,
      agendaId: entry.agendaId || null,
      head: `Action ${String(entry.action).slice(0, 160)}: ${scope}${detail ? `. ${detail}` : ''}`,
      detail, sourceRef: `action:${entry.executionId}`, evidenceRefs: [`actions.jsonl#sha256=${digest}`],
    },
  };
}

/** Replay only durable receipts, never handlers. Cursor is a derived projection
 * checkpoint; a crash after append replays the same stable event ID safely. */
function flushActionFeedback(brainDir, options = {}) {
  if (!brainDir) return { projected: 0 };
  const source = path.join(brainDir, 'actions.jsonl');
  if (!fs.existsSync(source)) return { projected: 0 };
  const cursorPath = path.join(brainDir, 'action-feedback-cursor.json');
  let offset = 0;
  if (fs.existsSync(cursorPath)) {
    offset = JSON.parse(fs.readFileSync(cursorPath, 'utf8')).offset;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid action feedback cursor');
  }
  const size = fs.statSync(source).size;
  if (offset > size) offset = 0;
  if (offset === size) return { projected: 0 };
  const bytes = Buffer.alloc(Math.min(size - offset, 8 * 1024 * 1024));
  const fd = fs.openSync(source, 'r');
  let read;
  try { read = fs.readSync(fd, bytes, 0, bytes.length, offset); } finally { fs.closeSync(fd); }
  let start = 0; let projected = 0; let examined = 0;
  while (examined < 500) {
    const end = bytes.indexOf(0x0a, start);
    if (end < 0 || end >= read) break;
    const line = bytes.subarray(start, end).toString('utf8').trim();
    if (line) {
      const entry = JSON.parse(line);
      // Older receipts have no stable invocation ID. Preserve them as history,
      // rather than manufacturing new execution events on upgrade.
      if (entry.executionId && ['intent', 'outcome'].includes(entry.phase)) {
        const envelope = actionEvent(entry, line);
        const append = options.append || appendJsonlDurableSync;
        append(path.join(brainDir, 'event-ledger.jsonl'), envelope);
        projected++;
      }
    }
    start = end + 1; examined++;
    writeFileDurableSync(cursorPath, JSON.stringify({ schema: 'home23.action-feedback-cursor.v1', offset: offset + start }));
  }
  if (!start && read === bytes.length && offset + read < size) throw new Error('action receipt exceeds bounded projection window');
  return { projected, pendingBytes: size - offset - start };
}

module.exports = { flushActionFeedback };
