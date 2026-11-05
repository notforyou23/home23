/**
 * Action: break_goal
 * Retires an active goal (marks as broken with reason). Target is the goal id.
 */

async function run({ action, target, goalSystem, role, brainDir, logger }) {
  const id = target || action.id;
  if (!id) return { status: 'rejected', detail: 'target (goal id) required' };
  const reason = action.rationale || action.reason || 'no rationale';

  if (goalSystem && typeof goalSystem.breakCommitment === 'function') {
    try {
      const res = await goalSystem.breakCommitment(id, { reason, brokenBy: `agent:${role}` });
      return {
        status: res ? 'success' : 'rejected',
        detail: res ? `broke goal ${id}` : `goalSystem.breakCommitment returned falsy for ${id}`,
        memoryDelta: { goals_broken: [id] },
      };
    } catch (err) {
      return { status: 'rejected', detail: `breakCommitment failed: ${err.message}` };
    }
  }

  // Fallback
  const fs = require('fs');
  const path = require('path');
  try {
    const file = path.join(brainDir, 'agent-broken-goals.jsonl');
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(), role, id, reason,
    }) + '\n');
  } catch { /* best-effort */ }

  return {
    status: 'success',
    detail: 'goalSystem unavailable — appended to agent-broken-goals.jsonl',
    memoryDelta: { goals_broken: [id] },
  };
}

module.exports = { run };
