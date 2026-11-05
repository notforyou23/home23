/**
 * Action: create_goal
 * Adds an intrinsic goal the agent will pursue on its own. Target is the
 * goal description (short string). Optional action.rationale for longer text.
 */

async function run({ action, target, goalSystem, cycle, role, brainDir, logger }) {
  const description = target || action.description;
  if (!description || typeof description !== 'string' || description.trim().length < 5) {
    return { status: 'rejected', detail: 'target or action.description required (goal text, min 5 chars)' };
  }

  if (goalSystem && typeof goalSystem.createGoal === 'function') {
    try {
      const goal = await goalSystem.createGoal({
        description: description.trim(),
        rationale: action.rationale || null,
        priority: typeof action.priority === 'number' ? action.priority : 0.5,
        source: `agent:${role}`,
        spawnCycle: cycle,
      });
      return {
        status: 'success',
        detail: `goal created: ${goal?.id || '(id unknown)'}`,
        memoryDelta: { goals_added: [goal?.id || description.slice(0, 40)] },
      };
    } catch (err) {
      return { status: 'rejected', detail: `goalSystem.createGoal failed: ${err.message}` };
    }
  }

  // Fallback: append to an agent-proposed-goals.jsonl for manual promotion
  const fs = require('fs');
  const path = require('path');
  try {
    const file = path.join(brainDir, 'agent-proposed-goals.jsonl');
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      cycle, role, description: description.trim(),
      rationale: action.rationale || null,
      priority: action.priority ?? 0.5,
    }) + '\n');
  } catch { /* best-effort */ }

  return {
    status: 'success',
    detail: 'goalSystem unavailable — appended to agent-proposed-goals.jsonl',
    memoryDelta: { goals_proposed: [description.slice(0, 40)] },
  };
}

module.exports = { run };
