/**
 * Agency/worker tools talk to THIS harness's bridge.
 * Prefer the bound port (ctx), then HOME23_BRIDGE_PORT, then BRIDGE_PORT.
 * Never fall through to Jerry's 5004 when another agent's BRIDGE_PORT is set.
 */
export function resolveHarnessBridgePort(env: NodeJS.ProcessEnv = process.env): string {
  const named = String(env.HOME23_BRIDGE_PORT || '').trim();
  if (named) return named;
  const bound = String(env.BRIDGE_PORT || '').trim();
  if (bound) return bound;
  return '5004';
}

export function resolveHarnessBridgeUrl(
  ctx: { workerConnectorBaseUrl?: string } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromCtx = ctx?.workerConnectorBaseUrl?.trim();
  if (fromCtx) return fromCtx.replace(/\/$/, '');
  return `http://127.0.0.1:${resolveHarnessBridgePort(env)}`;
}
