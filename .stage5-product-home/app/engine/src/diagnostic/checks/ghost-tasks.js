'use strict';

/**
 * Ghost Tasks
 *
 * Reads tasks.jsonl and pursuits.jsonl directly. Finds tasks that reference
 * pursuits which no longer exist or are closed/discarded — these are ghost
 * obligations cluttering agency state.
 *
 * Would have caught: 4 ghost tasks referencing dead pursuits.
 */

const fs = require('fs');
const path = require('path');

async function run(ctx) {
  const tasksPath = path.join(ctx.brainDir, 'agency', 'tasks.jsonl');
  const pursuitsPath = path.join(ctx.brainDir, 'agency', 'pursuits.jsonl');

  if (!fs.existsSync(tasksPath)) {
    return { ok: true, findings: [] };
  }

  // Load tasks
  let tasks;
  try {
    const raw = fs.readFileSync(tasksPath, 'utf8');
    tasks = raw.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    return { ok: false, error: `failed to read tasks.jsonl: ${err.message}`, findings: [] };
  }

  // Load pursuit IDs and their statuses
  const pursuitStatuses = new Map();
  if (fs.existsSync(pursuitsPath)) {
    try {
      const raw = fs.readFileSync(pursuitsPath, 'utf8');
      const pursuits = raw.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      // Last entry per pursuit ID wins (state transitions are appended)
      for (const p of pursuits) {
        if (p?.id) pursuitStatuses.set(p.id, p.status || 'active');
      }
    } catch {
      // If we can't read pursuits, we can't check for ghosts
      return { ok: true, findings: [] };
    }
  }

  const findings = [];
  const seenTaskIds = new Set();

  // Get latest state per task ID
  const latestTasks = new Map();
  for (const task of tasks) {
    if (task?.id) latestTasks.set(task.id, task);
  }

  for (const task of latestTasks.values()) {
    // Skip already-closed tasks
    if (task.status === 'closed' || task.status === 'cancelled' || task.status === 'completed') continue;
    if (!task.pursuitId) continue;

    const pursuitStatus = pursuitStatuses.get(task.pursuitId);
    if (pursuitStatus === undefined) {
      // Pursuit doesn't exist at all
      findings.push({
        id: `ghost_tasks:${task.id}`,
        severity: 'warning',
        code: 'task_references_nonexistent_pursuit',
        message: `Task ${task.id} references pursuit ${task.pursuitId} which does not exist`,
        evidence: {
          taskId: task.id,
          taskSummary: task.summary?.slice(0, 120),
          pursuitId: task.pursuitId,
          pursuitExists: false,
        },
        autoFixable: true,
        async autoFix() {
          const closure = {
            ...task,
            status: 'closed',
            closedAt: new Date().toISOString(),
            closedBy: 'diagnostic:ghost_tasks',
            closureReason: 'pursuit_does_not_exist',
          };
          fs.appendFileSync(tasksPath, JSON.stringify(closure) + '\n');
          return {
            action: 'closed_ghost_task',
            result: 'ok',
            evidence: { taskId: task.id, pursuitId: task.pursuitId },
            reversible: true,
          };
        },
      });
    } else if (pursuitStatus === 'closed' || pursuitStatus === 'discarded') {
      // Pursuit is closed/discarded but task is still open
      findings.push({
        id: `ghost_tasks:${task.id}`,
        severity: 'warning',
        code: 'task_references_closed_pursuit',
        message: `Task ${task.id} references pursuit ${task.pursuitId} which is ${pursuitStatus}`,
        evidence: {
          taskId: task.id,
          taskSummary: task.summary?.slice(0, 120),
          pursuitId: task.pursuitId,
          pursuitStatus,
        },
        autoFixable: true,
        async autoFix() {
          const closure = {
            ...task,
            status: 'closed',
            closedAt: new Date().toISOString(),
            closedBy: 'diagnostic:ghost_tasks',
            closureReason: `pursuit_${pursuitStatus}`,
          };
          fs.appendFileSync(tasksPath, JSON.stringify(closure) + '\n');
          return {
            action: 'closed_ghost_task',
            result: 'ok',
            evidence: { taskId: task.id, pursuitId: task.pursuitId, pursuitStatus },
            reversible: true,
          };
        },
      });
    }
  }

  return { ok: true, findings };
}

module.exports = {
  id: 'ghost_tasks',
  label: 'Ghost Tasks',
  intervalMs: 15 * 60 * 1000, // 15 min
  run,
};