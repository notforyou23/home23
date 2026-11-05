/**
 * critic-verdict-parser.js — enforce that critic outputs end with a verdict.
 *
 * The critic role's prompt asks for one of:
 *   INVESTIGATE / NOTIFY / TRIGGER / OBSERVE / NO_ACTION / ACT
 *
 * Jerry's 2026-04-17 self-diagnosis flagged that critic outputs frequently
 * drift into prose poems without producing a verdict — the quality ratchet
 * has no teeth. This parser detects whether a critic output carries at
 * least one verdict tag so the caller can discard tagless outputs and
 * prevent them from polluting the thought stream.
 */

// Match the same tags the thought-action-parser recognizes, but only
// presence-check — we don't need the payload here.
const VERDICT_TAGS = [
  /(?:^|\n)\s*INVESTIGATE\b/i,
  /(?:^|\n)\s*NOTIFY\b/i,
  /(?:^|\n)\s*TRIGGER\b/i,
  /(?:^|\n)\s*OBSERVE\b/i,
  /(?:^|\n)\s*NO_ACTION\b/i,
  /(?:^|\n)\s*ACT\b/i,
  // Also accept the classic keep/revise/discard trio that Jerry's diagnosis
  // proposed for the repaired critic. Either vocabulary is acceptable.
  /(?:^|\n)\s*VERDICT\s*:\s*(keep|revise|discard)\b/i,
];

function hasVerdictTag(text) {
  if (!text || typeof text !== 'string') return false;
  for (const re of VERDICT_TAGS) {
    if (re.test(text)) return true;
  }
  return false;
}

module.exports = { hasVerdictTag, VERDICT_TAGS };
