import type { ShortcutBridgeConfig } from './secrets.js';

export async function runNamedShortcut(
  name: string,
  bridge: ShortcutBridgeConfig,
  fetchImpl: typeof fetch = fetch,
  opts: { confirm?: boolean; dryRun?: boolean } = {},
): Promise<{ ok: boolean; dryRun: boolean; detail: string }> {
  const target = name.trim();
  if (!target) throw new Error('shortcut name required');
  if (bridge.allowedTargets.length > 0 && !bridge.allowedTargets.includes(target)) {
    throw new Error(`shortcut '${target}' is not on the allowlist (${bridge.allowedTargets.join(', ')})`);
  }
  if (!bridge.enabled || !bridge.url) {
    throw new Error('shortcut_bridge is not enabled/configured in configs/action-allowlist.yaml');
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, detail: `would POST ${bridge.url}/${encodeURIComponent(target)}` };
  }
  if (!opts.confirm) {
    throw new Error('phone shortcuts require confirm=true');
  }
  const url = `${bridge.url}/${encodeURIComponent(target)}`;
  const res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(15000) });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`shortcut bridge HTTP ${res.status}: ${body.slice(0, 200)}`);
  return { ok: true, dryRun: false, detail: `triggered ${target}` };
}
