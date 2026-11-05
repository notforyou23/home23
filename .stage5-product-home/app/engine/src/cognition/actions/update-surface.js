/**
 * Action: update_surface
 * Rewrites one of the domain surface files in instances/<agent>/workspace/.
 * Only TOPOLOGY / PROJECTS / PERSONAL / DOCTRINE / RECENT are allowed (enforced
 * by allow-list too, but double-checked here as defense-in-depth).
 *
 * Supports two write modes:
 *   mode=replace  → overwrites the whole file with action.body
 *   mode=append   → appends action.body to the existing file with a timestamp header
 *   (default: append — safer, preserves history)
 */

const fs = require('fs');
const path = require('path');

const ALLOWED = new Set(['TOPOLOGY', 'PROJECTS', 'PERSONAL', 'DOCTRINE', 'RECENT']);

async function run({ action, target, workspaceDir, cycle, role, logger }) {
  if (!workspaceDir) {
    return { status: 'rejected', detail: 'workspaceDir not provided' };
  }
  if (!target || !ALLOWED.has(target)) {
    return { status: 'rejected', detail: `target must be one of ${[...ALLOWED].join('/')}` };
  }
  const body = action.body || action.content;
  if (!body || typeof body !== 'string' || body.trim().length < 10) {
    return { status: 'rejected', detail: 'action.body required (markdown content, min 10 chars)' };
  }

  const filePath = path.join(workspaceDir, `${target}.md`);
  const mode = action.mode === 'replace' ? 'replace' : 'append';

  try {
    if (mode === 'replace') {
      // Back up prior version alongside (single-slot rolling backup)
      if (fs.existsSync(filePath)) {
        try { fs.copyFileSync(filePath, filePath + '.prev'); } catch { /* best-effort */ }
      }
      fs.writeFileSync(filePath, body.trim() + '\n', 'utf8');
      return {
        status: 'success',
        detail: `replaced ${target}.md (prior saved as ${target}.md.prev)`,
        memoryDelta: { rewritten: [target] },
      };
    }

    // append mode
    const header = `\n\n---\n*cycle ${cycle} · ${role} · ${new Date().toISOString()}*\n\n`;
    fs.appendFileSync(filePath, header + body.trim() + '\n', 'utf8');
    return {
      status: 'success',
      detail: `appended to ${target}.md`,
      memoryDelta: { appended: [target] },
    };
  } catch (err) {
    return { status: 'rejected', detail: `write failed: ${err.message}` };
  }
}

module.exports = { run };
