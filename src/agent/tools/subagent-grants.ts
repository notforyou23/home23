/** Capability groups a temporary joined specialist may receive explicitly. */
export const SUBAGENT_TOOL_GRANTS = ['files', 'web', 'brain', 'shell'] as const;
export type SubAgentToolGrant = typeof SUBAGENT_TOOL_GRANTS[number];

/** Exact configured resident definitions selected by each closed grant group. */
export const SUBAGENT_TOOL_NAMES: Record<SubAgentToolGrant, readonly string[]> = {
  files: ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files'],
  web: ['web_browse', 'web_search'],
  brain: [
    'brain_search', 'brain_catalog', 'brain_operations_list', 'brain_pgs_partitions',
    'brain_query', 'brain_query_export', 'brain_status', 'brain_memory_graph',
    'brain_synthesize',
  ],
  shell: ['shell'],
};
