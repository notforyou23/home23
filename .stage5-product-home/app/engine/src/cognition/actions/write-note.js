/**
 * Action: write_note
 * Writes a markdown note to instances/<agent>/workspace/notes/<name>.md.
 * Path-confined: cannot escape workspace/notes/. If the name contains
 * slashes, .., or starts with /, we reject.
 */

const fs = require('fs');
const path = require('path');

function sanitizeName(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (!s || s.includes('..') || s.startsWith('/') || s.startsWith('~')) return null;
  // Collapse to a single segment, strip any path separators
  const base = s.replace(/[\\/]/g, '_').replace(/[^\w.\-]/g, '_').slice(0, 80);
  if (!base) return null;
  return base.endsWith('.md') ? base : `${base}.md`;
}

async function run({ action, target, workspaceDir, logger }) {
  if (!workspaceDir) {
    return { status: 'rejected', detail: 'workspaceDir not provided' };
  }

  const name = sanitizeName(target || action.name);
  if (!name) {
    return { status: 'rejected', detail: 'invalid or missing note name' };
  }
  const body = action.body || action.content;
  if (!body || typeof body !== 'string' || body.trim().length < 3) {
    return { status: 'rejected', detail: 'action.body required (markdown content)' };
  }

  const notesDir = path.join(workspaceDir, 'notes');
  try {
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
  } catch (err) {
    return { status: 'rejected', detail: `could not create notes dir: ${err.message}` };
  }

  const filePath = path.join(notesDir, name);
  try {
    fs.writeFileSync(filePath, body.trim() + '\n', 'utf8');
  } catch (err) {
    return { status: 'rejected', detail: `write failed: ${err.message}` };
  }

  return {
    status: 'success',
    detail: `wrote ${path.relative(workspaceDir, filePath)}`,
    memoryDelta: { added: [`notes/${name}`] },
  };
}

module.exports = { run };
