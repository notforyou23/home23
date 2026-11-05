/** These tools use the requester-authorized operation API with stable request IDs.
 * Replay reattaches the same operation; it must never start a second paid run. */
export const IDEMPOTENT_OPERATION_TOOLS = new Set([
  'research_launch', 'research_continue', 'research_compile_brain',
  'research_compile_section', 'brain_synthesize',
]);
export function plannedRecoveryPolicy(tool: string): 'safe_before_start' | 'idempotent_operation' | 'idempotent_bot_invocation' {
  if (tool === 'bot_invoke') return 'idempotent_bot_invocation';
  return IDEMPOTENT_OPERATION_TOOLS.has(tool) ? 'idempotent_operation' : 'safe_before_start';
}
