/** Validate declared execution needs before allocating a worker or Working Thread. */
export function delegationCapabilityError(input: Record<string, unknown>): string | null {
  const kind = input.task_kind;
  if (kind !== undefined && !['analysis', 'local_state_change', 'source_change'].includes(String(kind))) {
    return 'spawn_agent task_kind must be analysis, local_state_change, or source_change.';
  }
  if (kind === 'source_change') {
    return 'Tracked-source changes require coding_run, not spawn_agent. Use the existing authorized task and an explicit coding workspace/backend; no worker was started.';
  }
  if (kind === 'local_state_change' && (!Array.isArray(input.tool_grants)
      || !input.tool_grants.some(x => x === 'files' || x === 'shell'))) {
    return 'This local-state change needs an explicit files or shell grant. No worker was started; provide the minimum allowed capability or use the appropriate tool directly.';
  }
  return null;
}
