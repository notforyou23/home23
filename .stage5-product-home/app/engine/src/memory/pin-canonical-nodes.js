/**
 * pin-canonical-nodes.js — one-shot memory pins for "stop rediscovering X".
 *
 * Jerry's 2026-04-17 self-diagnosis counted the health-pipeline conclusion
 * rediscovered 16+ times. The dedup-before-spawn primitive (2026-04-17)
 * prevents redundant agent spawns when an answer-tagged node is present
 * — but only if such a node exists. This module seeds those pin nodes
 * at startup when HOME23_PIN_CANONICAL_NODES=1 is set.
 *
 * Idempotent: if a node with the designated tag already exists, skip.
 */

const DASHBOARD_RESOLUTION_CONCEPT = [
  '[RESOLVED] Dashboard Health Pipeline.',
  'The Pi Pressure Bridge and Pi Health Bridge are operational.',
  'The dashboard is live on port 8090.',
  'The iOS Health Shortcut stopped delivering data around 2026-04-13;',
  'the root cause is phone-side, not server-side.',
  'The fix is to re-trigger the iOS Shortcut manually on the phone.',
  'The correlation view is the intended next build but is blocked until',
  'health data flows again. Status: waiting on jtr action.',
  'No further autonomous agent cycles are needed to diagnose this —',
  'every recent investigation converges on the same phone-side conclusion.'
].join(' ');

const PINS = [
  {
    id: 'dashboard-pipeline',
    concept: DASHBOARD_RESOLUTION_CONCEPT,
    tag: 'resolved:dashboard-pipeline',
  },
];

async function pinCanonicalNodes({ memory, logger }) {
  if (!memory || typeof memory.addNode !== 'function') {
    logger?.warn?.('[pin-canonical] memory.addNode unavailable, skipping');
    return { pinned: 0, skipped: 0 };
  }
  let pinned = 0;
  let skipped = 0;
  for (const pin of PINS) {
    // Skip if a node with this tag already exists.
    let exists = false;
    try {
      for (const node of memory.nodes.values()) {
        if (String(node?.tag || '').toLowerCase() === pin.tag.toLowerCase()) {
          exists = true;
          break;
        }
      }
    } catch { /* fallthrough */ }
    if (exists) {
      logger?.info?.('[pin-canonical] already present, skipping', { tag: pin.tag });
      skipped++;
      continue;
    }
    try {
      const node = await memory.addNode(pin.concept, pin.tag);
      if (node) {
        pinned++;
        logger?.info?.('[pin-canonical] pinned', { id: node.id, tag: pin.tag });
      } else {
        logger?.warn?.('[pin-canonical] addNode returned null', { tag: pin.tag });
      }
    } catch (err) {
      logger?.error?.('[pin-canonical] failed', { tag: pin.tag, error: err.message });
    }
  }
  return { pinned, skipped };
}

module.exports = { pinCanonicalNodes, PINS, DASHBOARD_RESOLUTION_CONCEPT };
