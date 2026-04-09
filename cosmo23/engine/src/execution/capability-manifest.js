/**
 * Capability Manifest — Structured description of execution agent capabilities
 *
 * Pure data + text generation. No execution logic. Imported by coordinators
 * and planners to inject execution-awareness into LLM prompts.
 *
 * Each execution agent type declares:
 *   - can: what operations it performs
 *   - produces: what output types it generates
 *   - needs: what inputs it requires
 *   - typical_duration: expected runtime range
 *   - tools: what system tools it uses
 *   - hands_off_to: which agent types it can delegate to
 *   - use_when: scenario descriptions for dispatch decisions
 */

'use strict';

// ── Agent Capability Definitions ────────────────────────────────────────────

const CAPABILITIES = {
  dataacquisition: {
    can: [
      'web_scraping',
      'api_consumption',
      'file_download',
      'feed_ingestion',
      'content_extraction'
    ],
    produces: [
      'raw_data',
      'extracted_content',
      'discovered_schemas',
      'source_manifests'
    ],
    needs: [
      'target_urls_or_apis',
      'extraction_goals',
      'output_format_preferences'
    ],
    typical_duration: '10-30 min',
    tools: [
      'curl', 'wget', 'playwright', 'puppeteer', 'scrapy',
      'cheerio', 'httpie', 'jq', 'aria2c', 'yt-dlp'
    ],
    hands_off_to: ['datapipeline', 'analysis', 'research'],
    use_when: [
      'Research requires data from external websites or APIs',
      'Content needs to be downloaded or scraped from the web',
      'RSS/Atom feeds need monitoring or ingestion',
      'Structured data must be extracted from unstructured sources',
      'Media files need to be retrieved for analysis'
    ]
  },

  datapipeline: {
    can: [
      'schema_mapping',
      'data_transform',
      'database_creation',
      'data_validation',
      'data_export',
      'data_profiling'
    ],
    produces: [
      'sqlite_databases',
      'csv_exports',
      'json_exports',
      'validation_reports',
      'data_profiles',
      'schema_definitions'
    ],
    needs: [
      'input_data_files_or_streams',
      'target_schema_or_format',
      'validation_rules'
    ],
    typical_duration: '5-20 min',
    tools: [
      'sqlite3', 'jq', 'python3', 'pandas', 'duckdb',
      'csvkit', 'miller', 'awk'
    ],
    hands_off_to: ['analysis', 'synthesis', 'research'],
    use_when: [
      'Raw data needs cleaning, transformation, or normalization',
      'A queryable database must be created from collected data',
      'Data quality checks or profiling are required',
      'Multiple data sources need schema alignment and merging',
      'Results must be exported in a specific format'
    ]
  },

  infrastructure: {
    can: [
      'container_management',
      'service_setup',
      'env_provisioning',
      'dependency_installation',
      'port_management'
    ],
    produces: [
      'running_services',
      'configured_environments',
      'docker_compositions',
      'teardown_scripts'
    ],
    needs: [
      'service_requirements',
      'environment_spec',
      'dependency_list'
    ],
    typical_duration: '5-15 min',
    tools: [
      'docker', 'docker-compose', 'podman', 'npm', 'pip',
      'homebrew', 'venv', 'nvm'
    ],
    hands_off_to: ['dataacquisition', 'datapipeline', 'automation'],
    use_when: [
      'A tool or service needs to be installed before other agents can work',
      'Docker containers must be built, started, or managed',
      'Python virtual environments or Node environments need setup',
      'System dependencies are missing and must be provisioned',
      'Port conflicts need resolution or service orchestration is required'
    ]
  },

  automation: {
    can: [
      'file_operations',
      'os_automation',
      'process_management',
      'scheduled_tasks',
      'gui_automation',
      'batch_processing'
    ],
    produces: [
      'organized_files',
      'running_processes',
      'automation_scripts',
      'operation_logs'
    ],
    needs: [
      'task_description',
      'target_files_or_processes',
      'success_criteria'
    ],
    typical_duration: '5-30 min',
    tools: [
      'bash', 'osascript', 'rsync', 'cron', 'find',
      'tar', 'zip', 'exiftool', 'imagemagick'
    ],
    hands_off_to: ['analysis', 'datapipeline', 'research'],
    use_when: [
      'Files need bulk renaming, moving, or organization',
      'OS-level automation or scripting is required',
      'Long-running processes need monitoring or management',
      'Repetitive tasks should be scripted for reuse',
      'Image or media files need batch processing'
    ]
  }
};

// ── CapabilityManifest Class ────────────────────────────────────────────────

class CapabilityManifest {
  /**
   * Returns the full capability map for all execution agent types.
   * @returns {Object} Map of agent type to capability descriptor
   */
  getCapabilities() {
    // Return a deep copy to prevent mutation of the canonical definitions
    return JSON.parse(JSON.stringify(CAPABILITIES));
  }

  /**
   * Generates a formatted text block for coordinator LLM prompts.
   * Explains execution agents, lists capabilities, and includes dispatch guidance.
   *
   * @param {Object} [options]
   * @param {Array<Object>} [options.learnedSkills] - Skills learned from prior executions
   * @param {Array<Object>} [options.campaignPatterns] - Patterns from campaign memory
   * @returns {string} Text block for injection into coordinator prompts
   */
  getCoordinatorInjectionText(options = {}) {
    const { learnedSkills, campaignPatterns } = options;
    const lines = [];

    lines.push('=== EXECUTION AGENT CAPABILITIES ===');
    lines.push('');
    lines.push('In addition to cerebral agents (research, analysis, synthesis, critique, etc.),');
    lines.push('you can dispatch EXECUTION agents that interact with the real world — they run');
    lines.push('code, fetch data, manage infrastructure, and automate tasks on the local machine.');
    lines.push('');
    lines.push('DISPATCH GUIDANCE:');
    lines.push('  - Cerebral agents = thinking: research, analyze, synthesize, critique');
    lines.push('  - Execution agents = doing: scrape, transform, build, automate');
    lines.push('  - Use execution agents when a goal requires real-world interaction');
    lines.push('  - Execution agents produce artifacts (files, databases, services) not just knowledge');
    lines.push('  - Chain execution agents via hands_off_to for multi-step workflows');
    lines.push('');

    for (const [agentType, cap] of Object.entries(CAPABILITIES)) {
      lines.push(`[${agentType.toUpperCase()}]`);
      lines.push(`  Can: ${cap.can.join(', ')}`);
      lines.push(`  Produces: ${cap.produces.join(', ')}`);
      lines.push(`  Needs: ${cap.needs.join(', ')}`);
      lines.push(`  Typical duration: ${cap.typical_duration}`);
      lines.push(`  Tools: ${cap.tools.join(', ')}`);
      lines.push(`  Hands off to: ${cap.hands_off_to.join(', ')}`);
      lines.push('  Use when:');
      for (const scenario of cap.use_when) {
        lines.push(`    - ${scenario}`);
      }
      lines.push('');
    }

    if (learnedSkills && learnedSkills.length > 0) {
      lines.push('=== LEARNED SKILLS (from prior executions) ===');
      for (const skill of learnedSkills) {
        const name = skill.name || skill.id || 'unnamed';
        const desc = skill.description || '';
        const confidence = typeof skill.confidence === 'number'
          ? ` (confidence: ${(skill.confidence * 100).toFixed(0)}%)`
          : '';
        lines.push(`  - ${name}${confidence}${desc ? ': ' + desc : ''}`);
      }
      lines.push('');
    }

    if (campaignPatterns && campaignPatterns.length > 0) {
      lines.push('=== CAMPAIGN PATTERNS (cross-run learning) ===');
      for (const pattern of campaignPatterns) {
        const label = pattern.pattern || pattern.name || pattern.description || JSON.stringify(pattern);
        lines.push(`  - ${label}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generates a formatted text block for planner LLM prompts.
   * Builds on coordinator text and adds available tools from the machine.
   *
   * @param {Array<Object>} toolSnapshot - Output of ToolRegistry.getSnapshot()
   * @param {Object} [options] - Same options as getCoordinatorInjectionText
   * @returns {string} Text block for injection into planner prompts
   */
  getPlannerInjectionText(toolSnapshot, options = {}) {
    const coordinatorText = this.getCoordinatorInjectionText(options);
    const lines = [coordinatorText];

    lines.push('=== AVAILABLE TOOLS ON THIS MACHINE ===');
    lines.push('');

    if (!toolSnapshot || toolSnapshot.length === 0) {
      lines.push('  No tools currently discovered. Infrastructure agent may need to install dependencies.');
    } else {
      for (const tool of toolSnapshot) {
        const version = tool.version ? ` (${tool.version})` : '';
        const caps = tool.capabilities && tool.capabilities.length > 0
          ? ` — ${tool.capabilities.join(', ')}`
          : '';
        lines.push(`  - ${tool.name || tool.id}${version}${caps}`);
      }
    }
    lines.push('');
    lines.push('When planning execution steps, prefer tools that are available on this machine.');
    lines.push('If a required tool is missing, plan an infrastructure agent step to install it first.');
    lines.push('');

    return lines.join('\n');
  }
}

module.exports = { CapabilityManifest, CAPABILITIES };
