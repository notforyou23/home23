/**
 * Action: ack_notification
 * Marks a notification as acknowledged by the agent itself (self-management).
 * Writes to notifications-ack.json (the canonical ack map that cycle-tools
 * and the dashboard both read). Supports target='all' to ack everything
 * pending, which is useful when the agent decides a whole class is stale.
 */

const fs = require('fs');
const path = require('path');

async function run({ action, target, brainDir, role, logger }) {
  const id = target || action.id;
  if (!id) {
    return { status: 'rejected', detail: 'target (notification id, or "all") required' };
  }

  const notifFile = path.join(brainDir, 'notifications.jsonl');
  const ackFile = path.join(brainDir, 'notifications-ack.json');

  if (!fs.existsSync(notifFile)) {
    return { status: 'rejected', detail: 'notifications.jsonl does not exist' };
  }

  let acks = {};
  try {
    if (fs.existsSync(ackFile)) acks = JSON.parse(fs.readFileSync(ackFile, 'utf-8')) || {};
  } catch { acks = {}; }

  const entry = {
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: `agent:${role}`,
    reason: action.reason || null,
  };

  if (id === 'all') {
    // Ack every currently-pending notification
    const lines = fs.readFileSync(notifFile, 'utf-8').split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines) {
      try {
        const n = JSON.parse(line);
        if (n.id && !acks[n.id]) {
          acks[n.id] = entry;
          count++;
        }
      } catch { /* skip */ }
    }
    try { fs.writeFileSync(ackFile, JSON.stringify(acks, null, 2)); }
    catch (err) { return { status: 'rejected', detail: `write failed: ${err.message}` }; }
    return { status: 'success', detail: `acked ${count} pending notifications`, memoryDelta: { acked_all: count } };
  }

  // Verify the id exists in the jsonl before acking (don't silently ack phantom ids)
  let found = false;
  const lines = fs.readFileSync(notifFile, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const n = JSON.parse(line);
      if (n.id === id) { found = true; break; }
    } catch { /* skip */ }
  }
  if (!found) return { status: 'rejected', detail: `notification id '${id}' not found` };

  acks[id] = entry;
  try {
    fs.writeFileSync(ackFile, JSON.stringify(acks, null, 2));
  } catch (err) {
    return { status: 'rejected', detail: `write failed: ${err.message}` };
  }

  return {
    status: 'success',
    detail: `acked notification ${id}`,
    memoryDelta: { acked: [id] },
  };
}

module.exports = { run };
