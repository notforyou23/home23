/**
 * Action: launch_research
 * Starts a COSMO 2.3 research run. Target is the topic. Context/cycles are
 * optional. This is an HTTP call to the cosmo23 HTTP API (shared process).
 */

const COSMO_DEFAULT_URL = process.env.COSMO23_URL || 'http://localhost:43210';

async function run({ action, target, logger }) {
  const topic = target || action.topic;
  if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
    return { status: 'rejected', detail: 'target (research topic) required' };
  }

  const body = {
    topic: topic.trim(),
    context: action.context || null,
    cycles: typeof action.cycles === 'number' ? action.cycles : 8,
    // Let cosmo pick its default models unless the caller overrides
    ...(action.model ? { model: action.model } : {}),
  };

  try {
    const res = await fetch(`${COSMO_DEFAULT_URL}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { status: 'rejected', detail: `cosmo /api/runs returned ${res.status}: ${errBody.slice(0, 200)}` };
    }
    const json = await res.json().catch(() => ({}));
    return {
      status: 'success',
      detail: `launched run ${json.runId || '(id unknown)'}`,
      memoryDelta: { runs_launched: [json.runId || topic.slice(0, 40)] },
    };
  } catch (err) {
    return { status: 'rejected', detail: `cosmo launch failed: ${err.message}` };
  }
}

module.exports = { run };
