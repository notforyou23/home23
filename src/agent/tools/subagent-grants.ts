/** Capability groups a temporary joined specialist may receive explicitly. */
export const SUBAGENT_TOOL_GRANTS = ['files', 'web', 'brain', 'shell'] as const;
export type SubAgentToolGrant = typeof SUBAGENT_TOOL_GRANTS[number];
