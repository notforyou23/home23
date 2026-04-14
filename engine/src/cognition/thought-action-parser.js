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
const { executeAction } = require('./action-dispatcher');

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

// ACT: is the autonomous-action tag. Payload is a JSON object. We grab the
// first balanced {...} after the tag on the same line or the following lines.
const ACT_MARKER = /(?:^|\n)[\s`*_>]*(?:ACT|act)\b[\s`*_]*[:：\-—]?\s*/;

function extractJsonAfter(text, startIdx) {
  // Find the first '{' at or after startIdx and return the matching balanced
  // substring. Tolerates leading whitespace and trailing text.
  let i = startIdx;
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

function parseActPayload(text) {
  if (!text) return null;
  const m = text.match(ACT_MARKER);
  if (!m) return null;
  const afterIdx = (m.index ?? 0) + m[0].length;
  const jsonStr = extractJsonAfter(text, afterIdx);
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || typeof obj !== 'object' || !obj.action) return null;
    return obj;
  } catch {
    return null;
  }
}

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

  // ACT: wins over everything else — it is the autonomous-execution tag and
  // carries a structured payload. If ACT parses, we route it; if it fails to
  // parse (missing JSON, malformed), we fall through to the legacy tags.
  const actPayload = parseActPayload(hypothesis);
  if (actPayload) {
    return { type: 'act', payload: actPayload };
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
/**
 * Scrub tool-call artifacts the LLM sometimes emits as literal text instead of
 * as structured tool_use blocks. Happens most with curator / MiniMax / older
 * Ollama models — they mirror the system prompt's tool syntax into the
 * response body, and that syntax ends up stored as the thought itself.
 *
 * Strips:
 *   [TOOL_CALL] ... [/TOOL_CALL]
 *   <tool_call> ... </tool_call>
 *   {tool => "name", args => {...}}            (perl-ish hash syntax)
 *   {"tool": "name", "args": {...}}            (raw JSON tool calls)
 *   Runs of whitespace left behind are collapsed.
 */
function scrubToolArtifacts(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  // Bracket-delimited blocks (greedy within same line, tolerates newlines)
  out = out.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  out = out.replace(/<tool_use[\s\S]*?<\/tool_use>/gi, '');
  // Perl-hash-ish tool invocations
  out = out.replace(/\{\s*tool\s*=>\s*["'][^"']+["'][\s\S]*?\}\s*\}?/g, '');
  // Raw JSON tool-call objects (best-effort, not a full parser)
  out = out.replace(/\{\s*"tool"\s*:\s*"[^"]+"[\s\S]*?\}\s*\}?/g, '');
  // Also strip a stray "[TOOL_CALL]" or closing tag on its own
  out = out.replace(/\[\/?TOOL_CALL\]/gi, '');
  out = out.replace(/<\/?tool_call>/gi, '');
  // Collapse stranded whitespace runs
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function stripActionTags(hypothesis) {
  if (!hypothesis) return hypothesis;
  let out = hypothesis
    .replace(/(?:^|\n)\s*(?:INVESTIGATE|NOTIFY|TRIGGER)\s*[:：].+?(?:\n|$)/gi, '\n')
    .replace(/(?:^|\n)\s*NO_ACTION\s*$/i, '');

  // Also strip ACT: {...} blocks (balanced-brace aware)
  const m = out.match(ACT_MARKER);
  if (m) {
    const start = m.index ?? 0;
    const afterTag = start + m[0].length;
    const jsonStr = extractJsonAfter(out, afterTag);
    if (jsonStr) {
      const endIdx = out.indexOf(jsonStr, afterTag) + jsonStr.length;
      out = out.slice(0, start) + out.slice(endIdx);
    }
  }

  return out.trim();
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
// Dedup window: if the same normalized hash was emitted within the last N
// cycles and isn't yet acked, suppress the duplicate and bump a count on
// the original entry instead. Tuned loose enough to allow genuine re-raises
// after the data changes, tight enough to prevent the stuck-loop pattern.
const NOTIF_DEDUP_WINDOW_CYCLES = 40;

// Auto-expire: any unacked notification older than this many cycles gets
// auto-acked to `notifications-ack.json` with reason=stale. Keeps the
// pending window small so coordinator context doesn't accumulate fossils.
const NOTIF_STALE_CYCLES = 60;

function normalizeForHash(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim()
    .slice(0, 200);
}

function notifHash(source, message) {
  return `${source || 'unknown'}::${normalizeForHash(message)}`;
}

function readJsonlSafe(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function loadAckMap(brainDir) {
  const ackFile = path.join(brainDir, 'notifications-ack.json');
  try {
    if (fs.existsSync(ackFile)) return JSON.parse(fs.readFileSync(ackFile, 'utf-8')) || {};
  } catch { /* ok */ }
  return {};
}

function saveAckMap(brainDir, acks) {
  const ackFile = path.join(brainDir, 'notifications-ack.json');
  try { fs.writeFileSync(ackFile, JSON.stringify(acks, null, 2)); } catch { /* ok */ }
}

function appendNotification(brainDir, { message, source, cycle, severity = 'info' }) {
  const file = path.join(brainDir, 'notifications.jsonl');
  const hash = notifHash(source, message);
  const acks = loadAckMap(brainDir);

  // ── Dedup within window ──
  // Scan the tail of the file for a matching unacked entry within the recent
  // cycle window. If found, bump its count in place and return.
  let existing = null;
  let allLines = [];
  try {
    if (fs.existsSync(file)) {
      allLines = fs.readFileSync(file, 'utf-8').split('\n');
      // Walk backwards through parsed entries (cheap — <N lines typical)
      for (let i = allLines.length - 1; i >= 0 && i >= allLines.length - 300; i--) {
        const line = allLines[i];
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.hash === hash
            && !acks[parsed.id]
            && typeof parsed.cycle === 'number'
            && cycle - parsed.cycle <= NOTIF_DEDUP_WINDOW_CYCLES) {
          existing = { parsed, lineIdx: i };
          break;
        }
      }
    }
  } catch { /* best-effort */ }

  if (existing) {
    // Bump count + last_seen_cycle + last_ts, rewrite the line in place
    const updated = {
      ...existing.parsed,
      count: (existing.parsed.count || 1) + 1,
      last_seen_cycle: cycle,
      last_ts: new Date().toISOString(),
    };
    allLines[existing.lineIdx] = JSON.stringify(updated);
    try { fs.writeFileSync(file, allLines.join('\n')); } catch { /* ok */ }
    return { ...updated, deduped: true };
  }

  // ── Not a duplicate — append normally ──
  const entry = {
    id: `notif-${cycle}-${Date.now()}`,
    cycle,
    source,
    message,
    severity,
    ts: new Date().toISOString(),
    acknowledged: false,
    hash,
    count: 1,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');

  // ── Opportunistic auto-expire of stale unacked notifications ──
  // Every time we append, take the chance to sweep stale entries into the
  // ack map (auto_expired=true) so coordinator context stops re-showing them.
  // This keeps the pending window bounded without a separate cron.
  pruneStaleNotifications(brainDir, cycle);

  return entry;
}

function pruneStaleNotifications(brainDir, currentCycle) {
  try {
    const file = path.join(brainDir, 'notifications.jsonl');
    if (!fs.existsSync(file)) return 0;
    const entries = readJsonlSafe(file);
    if (entries.length === 0) return 0;
    const acks = loadAckMap(brainDir);
    let expired = 0;
    const nowIso = new Date().toISOString();
    for (const n of entries) {
      if (!n.id || acks[n.id]) continue;
      if (typeof n.cycle !== 'number') continue;
      if (currentCycle - n.cycle > NOTIF_STALE_CYCLES) {
        acks[n.id] = { acknowledged_at: nowIso, auto_expired: true, reason: 'stale' };
        expired++;
      }
    }
    if (expired > 0) saveAckMap(brainDir, acks);
    return expired;
  } catch {
    return 0;
  }
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
  const {
    hypothesis, role, cycle, brainDir, workspaceDir, agentName,
    agentExecutor, logger, sensors, memory, goalSystem, writeReceipt,
  } = opts;
  const parsed = parseThoughtAction(hypothesis);

  if (parsed.type === 'none') {
    return { action: 'none', payload: null, routed: 'no_action' };
  }

  try {
    // ── ACT: autonomous execution via allow-listed dispatcher ──
    if (parsed.type === 'act') {
      const result = await executeAction({
        action: parsed.payload,
        role, cycle, brainDir, workspaceDir, agentName,
        sensors, memory, goalSystem, logger, writeReceipt,
      });
      return {
        action: 'act',
        actionName: parsed.payload.action,
        payload: parsed.payload,
        routed: `dispatcher:${result.status}`,
        detail: result.detail || null,
        memoryDelta: result.memoryDelta || null,
      };
    }

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
  scrubToolArtifacts,
  appendNotification,
  pruneStaleNotifications,
  addTrigger,
  routeThoughtAction,
};
