/**
 * Action: compile_research_section
 * Save one specific COSMO research goal/insight as a focused memory node.
 * Expects action.brainId and action.section.
 */

const COSMO_DEFAULT_URL = process.env.COSMO23_URL || 'http://localhost:43210';

async function run({ action, logger }) {
  const brainId = action.brainId || action.brain;
  const section = action.section;
  if (!brainId) return { status: 'rejected', detail: 'action.brainId required' };
  if (!section) return { status: 'rejected', detail: 'action.section required' };

  try {
    const res = await fetch(`${COSMO_DEFAULT_URL}/api/brains/${encodeURIComponent(brainId)}/compile-section`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { status: 'rejected', detail: `cosmo compile-section returned ${res.status}: ${errBody.slice(0, 200)}` };
    }
    const json = await res.json().catch(() => ({}));
    return {
      status: 'success',
      detail: `compiled section '${section}' from ${brainId}`,
      memoryDelta: { compiled: [section] },
      rawResponse: json,
    };
  } catch (err) {
    return { status: 'rejected', detail: `cosmo call failed: ${err.message}` };
  }
}

module.exports = { run };
