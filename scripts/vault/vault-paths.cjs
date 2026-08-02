'use strict';

// Type is derived MECHANICALLY from the origin path. Provenance is a fact;
// meaning is a judgment and lives in frontmatter tags, never in folders.
//
// Precedence: MOST SPECIFIC PROVENANCE WINS.
//   1. capture-mechanism dirs (voice/)   - how it was recorded
//   2. agent-session dirs                - what produced it
//   3. named-project dirs                - what body of work it belongs to
//   4. drop-zone / sensitive dirs        - where jtr filed it
//   5. extension rules                   - last-resort format signals
// A rule may only match a PATH SEGMENT (delimited by /) or a FILE EXTENSION.
// Never match a bare word: words are topics, and topics are judgments.
const RULES = [
  [/\/voice\//i, 'voice'],
  [/\/workspace\/jtr\//i, 'sessions'],
  [/\/sessions\//i, 'sessions'],
  // A session is a real event, whoever ran it -- jtr's own and other agents'.
  [/\/runs\/[^/]+\/inputs\//i, 'sessions'],
  // Only the atomizer's YYYY-MM-DD-slug-id.md shape counts as a conversation.
  // A bare /conversations/ dir rule was removed: on the real corpus it had 0
  // true positives and 16 false positives, catching runtime state
  // (telegram-offset.json, cron-jobs.json), not conversations.
  //
  // The atomizer emits `undated-*` when a conversation has no created_at. It
  // MUST keep emitting them -- refusing would be silent loss -- so this rule has
  // to accept them, or an undated conversation silently files itself as a note
  // and conversations/ drifts toward the 0-byte dir the reachability test
  // prevents. This rule and conversationFilename() in atomize-claude-archive.cjs
  // are one contract: the date token is ISO-8601 or the literal `undated`.
  // An atomizer that emits any other date shape (e.g. a unix timestamp) routes
  // its output to notes/ silently -- normalize in the atomizer, not here.
  [/\/conversations\/(?:\d{4}-\d{2}-\d{2}|undated)-.*\.md$/i, 'conversations'],
  [/(anthropic|antrhopic)_archive\/.*conversations\.json$/i, 'conversations'],
  [/\/(jerry_garcia|trail-running|research-runs|research)\//i, 'research'],
  [/\/COSMObrains\/.*\/outputs\//i, 'research'],
  [/\/workspace\/curriculum\//i, 'research'],
  [/\/(health|\.health_log)\//i, 'health'],
  [/\/feed\/.*\.(pdf|jpg|jpeg|png|heic)$/i, 'health'],
  [/\.bib$/i, 'reading'],
  [/\/(feed|reading|refs)\//i, 'reading'],
];

// Exclusion is the EVENT RULE applied to paths: a record that nothing happened
// is not a document. These are previous generations of this same system
// (cosmo-home, .openclaw) writing their own diaries -- the exact theatre this
// project removes from the current brain.
//   engine/runtime/coordinator/  9,622x "Meta-Coordinator Review ... Thoughts Analyzed: 0"
//   workspace/persist/           2,437x "scheduled-sync-state ... auto sync, 1 file changed"
//   workspace/memory/            1,433x "reflection not found in memory" / "Checked: 0"
// Nothing is deleted -- excluded material stays on disk and the old installs are
// archived to external storage. This only decides what enters the vault.
const EXCLUDE_RULES = [
  /\/engine\/runtime\/coordinator\//i,
  /\/workspace\/persist\//i,
  /\/workspace\/memory\//i,
  // Timer-written telemetry. workspace/heartbeat/ holds PI_STATUS.md, a
  // 213-byte snapshot ("PM2: 13/15 online | Disk: 33%") that cron rewrites on
  // a fixed interval -- verified live: its bytes changed inside a 150s window
  // with no work occurring. Its content is "still alive": a record that a loop
  // ticked. Exact-match dedup correctly treats each rewrite as a NEW document,
  // which is precisely what makes it an unbounded generator of records that
  // nothing happened -- the same class as the coordinator reviews above.
  //
  // ANCHORED TO THE DIRECTORY, deliberately NOT to the basenames
  // HEARTBEAT/PI_STATUS/STATUS. Measured on the real corpus: a basename rule
  // matches 30 files, of which exactly ONE is timer exhaust and 29 are real
  // documents -- e.g. jerry-garcia-deep-dive/STATUS.md (a 9.5KB hand-written
  // launch report with deployment steps) and coz-migration/STATUS.md (a
  // hand-written archive note). workspace/HEARTBEAT.md is a 17KB tracker that
  // accumulates what WAS done ("Published issue #80", "Fixed topic name
  // mismatch") and sat unchanged for 13+ minutes: it records that things
  // happened, the opposite of exhaust. Only this one directory is a timer.
  /\/workspace\/heartbeat\//i,
];

// NOTE: '_archive' intentionally absent. The oversized artifacts it was meant to
// hold (chat.html, checkpoint-15880.json) are not document extensions and never
// reach this function. Plan 3 (archive + rebuild) owns them.
const TYPES = ['voice', 'sessions', 'conversations', 'research', 'health', 'reading', 'notes'];

function classifyOrigin(originPath) {
  if (typeof originPath !== 'string' || !originPath.startsWith('/')) {
    throw new TypeError(`classifyOrigin requires an absolute path, got: ${JSON.stringify(originPath)}`);
  }
  for (const [re, type] of RULES) {
    if (re.test(originPath)) return type;
  }
  return 'notes';
}

function isExcluded(originPath) {
  if (typeof originPath !== 'string' || !originPath.startsWith('/')) {
    throw new TypeError(`isExcluded requires an absolute path, got: ${JSON.stringify(originPath)}`);
  }
  return EXCLUDE_RULES.some((re) => re.test(originPath));
}

module.exports = { classifyOrigin, isExcluded, TYPES };
