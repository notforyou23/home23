/**
 * Action: run_shortcut
 * Invokes an iOS Shortcut via an external HTTP bridge. The bridge URL is
 * configured in configs/action-allowlist.yaml under integrations.shortcut_bridge.
 * If not configured or disabled, rejects — nothing silently no-ops.
 */

async function run({ target, integrations, logger }) {
  const bridge = integrations?.shortcut_bridge || {};
  if (!bridge.enabled) {
    return { status: 'rejected', detail: 'shortcut_bridge disabled in allowlist yaml' };
  }
  if (!bridge.url) {
    return { status: 'rejected', detail: 'shortcut_bridge.url not configured' };
  }
  if (!target) {
    return { status: 'rejected', detail: 'target (shortcut name) required' };
  }

  try {
    const url = `${bridge.url.replace(/\/$/, '')}/${encodeURIComponent(target)}`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: 'rejected', detail: `bridge returned ${res.status}: ${body.slice(0, 200)}` };
    }
    const body = await res.text().catch(() => '');
    return {
      status: 'success',
      detail: `shortcut '${target}' triggered`,
      memoryDelta: { refreshed: [target] },
      rawResponse: body.slice(0, 500),
    };
  } catch (err) {
    return { status: 'rejected', detail: `bridge call failed: ${err.message}` };
  }
}

module.exports = { run };
