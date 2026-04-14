/**
 * Thought-Action Parser
 *
 * Parses structured action tags out of cognitive-role thoughts so that cycles
 * produce real consequences instead of just journal entries. Each thought can
 * emit at most one action:
 *
 *   INVESTIGATE: <specific thing to examine>   → spawns a research agent task
 *   NOTIFY: <message to send the owner>        → appends to notifications.jsonl
 *   TRIGGER: <condition to watch for>          → adds a standing trigger
 *   NO_ACTION                                  → thought was reflection only
 *
 * The parser is deliberately lenient — models drift on format. If we find any
 * tag-like marker, we extract it. If nothing matches, we treat it as NO_ACTION.
 */

const fs = require('fs');
const path = require('path');

// Match action tags liberally: model may emit "INVESTIGATE:", "INVESTIGATE ",
// "INVESTIGATE\n", or even just "INVESTIGATE" at the start/end of a line
// followed by the payload on the next line. We extract payload from either
// the same line (after : / - /  whitespace) or the next non-empty line.
const ACTION_PATTERNS = {
  investigate: /(?:^|\n)[\s`*_>]*(?:INVESTIGATE|investigate)\b[\s`*_]*[:：\-—]?\s*(.*?)(?:\n|$)/,
  notify: /(?:^|\n)[\s`*_>]*(?:NOTIFY|notify)\b[\s`*_]*[:：\-—]?\s*(.*?)(?:\n|$)/,
  trigger: /(?:^|\n)[\s`*_>]*(?:TRIGGER|trigger)\b[\s`*_]*[:：\-—]?\s*(.*?)(?:\n|$)/,
  noAction: /(?:^|\n)\s*NO_ACTION\s*$/i,
};

/**
 * Extract the first action tag from a thought's hypothesis text.
 * Returns { type, payload } or { type: 'none' } if no action.
 *
 * @param {string} hypothesis
 * @returns {{type: 'investigate'|'notify'|'trigger'|'none', payload?: string}}
 */
function parseThoughtAction(hypothesis) {
  if (!hypothesis || typeof hypothesis !== 'string') {
    return { type: 'none' };
  }

  // Explicit NO_ACTION wins
  if (ACTION_PATTERNS.noAction.test(hypothesis)) {
    return { type: 'none' };
  }

  // Check each action type
  for (const [type, pattern] of Object.entries(ACTION_PATTERNS)) {
    if (type === 'noAction') continue;
    const match = hypothesis.match(pattern);
    if (match) {
      let payload = (match[1] || '').trim();

      // If no inline payload (tag was on its own line), grab the next
      // non-empty line as the payload.
      if (!payload || payload.length < 3) {
        const matchIdx = match.index + match[0].length;
        const remainder = hypothesis.slice(matchIdx);
        const nextLine = remainder.split('\n').map(l => l.trim()).find(Boolean);
        if (nextLine && nextLine.length >= 3) {
          payload = nextLine;
        }
      }

      if (!payload || payload.length < 3 || /^(none|nothing|n\/a)$/i.test(payload)) {
        continue;
      }
      return { type, payload };
    }
  }

  return { type: 'none' };
}

/**
 * Strip action tags from hypothesis so they don't pollute the stored brain node.
 * The action is already captured separately.
 */
function stripActionTags(hypothesis) {
  if (!hypothesis) return hypothesis;
  return hypothesis
    .replace(/(?:^|\n)\s*(?:INVESTIGATE|NOTIFY|TRIGGER)\s*[:：].+?(?:\n|$)/gi, '\n')
    .replace(/(?:^|\n)\s*NO_ACTION\s*$/i, '')
    .trim();
}

/**
 * Append a notification to the agent's notifications.jsonl.
 *
 * @param {string} brainDir - instances/<agent>/brain/
 * @param {Object} notification
 * @param {string} notification.message - User-facing text
 * @param {string} notification.source - Role that emitted it (curiosity, analyst, critic, curator)
 * @param {number} notification.cycle
 * @param {string} notification.severity - 'info' | 'attention' | 'urgent' (default: 'info')
 */
function appendNotification(brainDir, { message, source, cycle, severity = 'info' }) {
  const file = path.join(brainDir, 'notifications.jsonl');
  const entry = {
    id: `notif-${cycle}-${Date.now()}`,
    cycle,
    source,
    message,
    severity,
    ts: new Date().toISOString(),
    acknowledged: false,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Add a standing trigger to trigger-index.json. If the file doesn't exist yet,
 * we create it with an empty trigger array.
 *
 * Trigger format:
 *   {
 *     id: 'trig-<cycle>-<ts>',
 *     condition: <what to watch for, as free text>,
 *     source: 'cognitive_cycle',
 *     role: <which role proposed it>,
 *     cycle: <cycle number>,
 *     ts: ISO8601,
 *     fired: 0,      // how many times matched
 *     last_fired: null
 *   }
 */
function addTrigger(brainDir, { condition, source, cycle }) {
  const file = path.join(brainDir, 'trigger-index.json');
  let data = { triggers: [] };
  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Array.isArray(data.triggers)) data.triggers = [];
    }
  } catch {
    data = { triggers: [] };
  }

  const trigger = {
    id: `trig-${cycle}-${Date.now()}`,
    condition,
    source: 'cognitive_cycle',
    role: source,
    cycle,
    ts: new Date().toISOString(),
    fired: 0,
    last_fired: null,
  };
  data.triggers.push(trigger);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return trigger;
}

/**
 * Full pipeline: parse a thought, route the action, return a summary of what
 * was done. The orchestrator calls this after each successful thought.
 *
 * @param {Object} opts
 * @param {string} opts.hypothesis - The thought's hypothesis text
 * @param {string} opts.role - curiosity/analyst/critic/curator
 * @param {number} opts.cycle
 * @param {string} opts.brainDir - instances/<agent>/brain/
 * @param {Object} [opts.agentExecutor] - For spawning investigate agents (optional)
 * @param {Object} [opts.logger]
 * @returns {{action: string, payload: string|null, routed: string}}
 */
async function routeThoughtAction(opts) {
  const { hypothesis, role, cycle, brainDir, agentExecutor, logger } = opts;
  const parsed = parseThoughtAction(hypothesis);

  if (parsed.type === 'none') {
    return { action: 'none', payload: null, routed: 'no_action' };
  }

  try {
    if (parsed.type === 'notify') {
      const entry = appendNotification(brainDir, {
        message: parsed.payload,
        source: role,
        cycle,
        severity: 'info',
      });
      logger?.info?.('📬 Thought-action: notification queued', {
        cycle, role, id: entry.id, message: parsed.payload.substring(0, 80),
      });
      return { action: 'notify', payload: parsed.payload, routed: 'notifications.jsonl' };
    }

    if (parsed.type === 'trigger') {
      const entry = addTrigger(brainDir, {
        condition: parsed.payload,
        source: role,
        cycle,
      });
      logger?.info?.('🔔 Thought-action: trigger installed', {
        cycle, role, id: entry.id, condition: parsed.payload.substring(0, 80),
      });
      return { action: 'trigger', payload: parsed.payload, routed: 'trigger-index.json' };
    }

    if (parsed.type === 'investigate') {
      // If we have an agent executor, spawn a research agent using the
      // standard missionSpec shape.
      if (agentExecutor?.spawnAgent) {
        try {
          const missionSpec = {
            missionId: `mission_thoughtaction_${cycle}_${Date.now()}`,
            agentType: 'ResearchAgent',
            description: parsed.payload,
            successCriteria: ['Produce a concise finding (1-3 paragraphs) addressing the investigation topic'],
            maxDuration: 360000, // 6 minutes
            createdBy: 'cognitive_cycle',
            spawnCycle: cycle,
            triggerSource: 'thought_action_investigate',
            spawningReason: `${role}_proposed_investigation`,
            priority: 0.5,
            provenanceChain: [`cycle_${cycle}`, role],
            metadata: { source: 'thought_action_parser', role, cycle },
          };
          const agentId = await agentExecutor.spawnAgent(missionSpec);
          if (agentId) {
            logger?.info?.('🔍 Thought-action: investigation agent spawned', {
              cycle, role, agentId, mission: parsed.payload.substring(0, 80),
            });
            return { action: 'investigate', payload: parsed.payload, routed: `agent:${agentId}` };
          }
          // spawnAgent returned falsy — fall through to notification fallback
        } catch (err) {
          logger?.warn?.('Investigation spawn failed, falling back to notification', {
            error: err.message,
          });
        }
      }
      // Fallback: record as notification so the request surfaces to the owner
      appendNotification(brainDir, {
        message: `[investigate] ${parsed.payload}`,
        source: role,
        cycle,
        severity: 'attention',
      });
      return { action: 'investigate', payload: parsed.payload, routed: 'notifications.jsonl (fallback)' };
    }
  } catch (err) {
    logger?.warn?.('Thought-action routing failed', { error: err.message, action: parsed.type });
    return { action: parsed.type, payload: parsed.payload || null, routed: 'failed' };
  }

  return { action: 'none', payload: null, routed: 'no_action' };
}

module.exports = {
  parseThoughtAction,
  stripActionTags,
  appendNotification,
  addTrigger,
  routeThoughtAction,
};
