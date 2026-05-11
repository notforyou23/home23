/**
 * hallucinated-tool-call-detector.js
 *
 * Jerry's 2026-04-17 self-diagnosis found agents writing literal
 * [TOOL_CALL: query_brain] text in their thought output — hallucinating
 * tool calls instead of actually invoking tools. When detected and no
 * real action tag accompanies it, the thought is noise: the agent
 * THINKS it's doing something, but the text is inert. This detector
 * lets the caller discard such thoughts before they pollute the
 * journal.
 */

// Match bare [TOOL_CALL: name] or [tool_call: name] variants.
const TOOL_CALL_PATTERN = /\[\s*(?:TOOL[_\s]*CALL|tool[_\s]*call|TOOL|tool)\s*:\s*[a-zA-Z_][\w-]*\s*[\]\s]/;
const KNOWN_CYCLE_TOOLS = [
  'get_system_state',
  'get_live_problems',
  'get_recent_signals',
  'read_surface',
  'query_brain',
  'get_recent_thoughts',
];
const ACTION_ONLY_PATTERN = /^(?:INVESTIGATE|NOTIFY|TRIGGER|OBSERVE|NO_ACTION|ACT)$/i;
const TOOL_RESULT_PATTERN = /\b(returned|returns|reports|reported|shows|showed|reads|read|found|current state|state reads|heartbeat shows|live problems returned|no current|no active)\b/i;
const TOOL_PLAN_PATTERN = /\b(i will|i'll|i am going to|i'm going to|i need to|let me|tool calls?|calling|call fresh|use fresh|using fresh|after receiving tool results|without fresh tool access)\b/i;
const RESTLESS_STIMULATION_PATTERN = /\b(bored|boredom|restless|idle cycle|idle cycles|nothing (?:is )?landing|thin results|no interesting results|same query again|running (?:the )?same query|routine quer(?:y|ies)|tool calls? to feel productive|feels like action|scroll(?:ing)? equivalent|more stimulation)\b/i;
const TARGET_ACQUISITION_PATTERN = /\b(rest|wait|drift|better target|target acquisition|fresh context|put it down|come back|re-engage|genuine engagement|genuine rest|discard the thread)\b/i;

// Count occurrences — useful for "how hallucinogenic is this output?"
function countHallucinatedToolCalls(text) {
  if (!text || typeof text !== 'string') return 0;
  const re = /\[\s*(?:TOOL[_\s]*CALL|tool[_\s]*call|TOOL|tool)\s*:\s*[a-zA-Z_][\w-]*\s*[\]\s]/g;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function hasHallucinatedToolCall(text) {
  return Boolean(classifyInertThought(text));
}

function classifyInertThought(text) {
  if (!text || typeof text !== 'string') return null;
  if (countHallucinatedToolCalls(text) > 0) return 'literal_tool_call_syntax';
  if (isBareActionOnlyThought(text)) return 'bare_action_tag';
  if (isBareToolCommandText(text)) return 'bare_tool_command';
  if (isToolPlanWithoutResult(text)) return 'tool_plan_without_result';
  if (isRestlessStimulationLoop(text)) return 'restless_stimulation_loop';
  return null;
}

function isBareActionOnlyThought(text) {
  const normalized = String(text || '')
    .replace(/[`*_>\-\s:：]+/g, ' ')
    .trim();
  return ACTION_ONLY_PATTERN.test(normalized);
}

function isBareToolCommandText(text) {
  const normalized = normalizeToolText(text);
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 8) return false;
  return tokens.every(t => KNOWN_CYCLE_TOOLS.includes(t));
}

function isToolPlanWithoutResult(text) {
  const s = String(text || '');
  const toolCount = KNOWN_CYCLE_TOOLS.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(s)).length;
  if (toolCount === 0) return false;
  if (TOOL_RESULT_PATTERN.test(s)) return false;
  return TOOL_PLAN_PATTERN.test(s);
}

function isRestlessStimulationLoop(text) {
  const s = String(text || '');
  if (!RESTLESS_STIMULATION_PATTERN.test(s)) return false;
  if (TARGET_ACQUISITION_PATTERN.test(s)) return false;
  const mentionsToolOrQuery = /\b(query|queries|tool calls?|brain|check|run|generate|refresh|stimulat(?:e|ion))\b/i.test(s);
  return mentionsToolOrQuery;
}

function normalizeToolText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/\b(read_surface)\s*\(\s*[^)]*\)/g, '$1')
    .replace(/\b(get_system_state|get_live_problems|get_recent_signals|query_brain|get_recent_thoughts)\s*\(\s*\)/g, '$1')
    .replace(/[\[\]{}(),:：;|+\-*/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  countHallucinatedToolCalls,
  hasHallucinatedToolCall,
  classifyInertThought,
  isBareActionOnlyThought,
  isBareToolCommandText,
  isToolPlanWithoutResult,
  isRestlessStimulationLoop,
  TOOL_CALL_PATTERN,
};
