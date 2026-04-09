/**
 * Execution Architecture — Schemas
 *
 * Defines the contract shapes for the three-level hierarchy:
 *   Plugin → Skill → Tool
 *
 * These are validation helpers + factory functions, not JSON Schema validators.
 * Each schema documents the canonical shape and provides a normalize() that
 * fills defaults, strips unknown fields, and throws on missing required fields.
 */

'use strict';

// ── Tool Schema ──────────────────────────────────────────────────────────────

/**
 * A Tool is an atomic executable: a binary, script, API endpoint, or library.
 * Tools have no domain knowledge — they just run.
 */
function normalizeTool(raw) {
  if (!raw || !raw.id) throw new Error('Tool definition requires an id');
  return {
    id: String(raw.id),
    type: raw.type || 'binary',              // binary | script | api | library | pip_package
    name: raw.name || raw.id,
    command: raw.command || null,             // Shell command to invoke (for binaries)
    version: raw.version || null,
    available: raw.available !== false,
    discoveredAt: raw.discoveredAt || new Date().toISOString(),
    verifiedAt: raw.verifiedAt || null,
    verifiedBy: raw.verifiedBy || null,       // Command used to verify (e.g., 'which python3')
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    resourceRequirements: {
      type: raw.resourceRequirements?.type || 'local',
      timeout_default_sec: raw.resourceRequirements?.timeout_default_sec || 120,
      ...(raw.resourceRequirements || {})
    },
    metadata: raw.metadata || {}
  };
}

const TOOL_TYPES = ['binary', 'script', 'api', 'library', 'pip_package', 'npm_package', 'container_image'];

// ── Skill Schema ─────────────────────────────────────────────────────────────

/**
 * A Skill is a reusable operation that combines tools with domain knowledge.
 * Skills bridge COSMO's reasoning and tool execution.
 */
function normalizeSkill(raw) {
  if (!raw || !raw.id) throw new Error('Skill definition requires an id');
  if (!raw.name) throw new Error('Skill definition requires a name');
  return {
    id: String(raw.id),
    name: raw.name,
    description: raw.description || '',
    pluginId: raw.pluginId || null,          // Parent plugin (null for standalone skills)
    domain: raw.domain || null,              // e.g., 'theoretical_physics', 'legal', 'data_analysis'
    tags: Array.isArray(raw.tags) ? raw.tags : [],

    // I/O contract (JSON Schema subset)
    inputs: raw.inputs || { type: 'object', properties: {} },
    outputs: raw.outputs || { type: 'object', properties: {} },

    // What this skill assumes about the world
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions : [],

    // How to run it
    implementation: normalizeImplementation(raw.implementation),

    // Tools this skill requires
    toolsRequired: Array.isArray(raw.toolsRequired)
      ? raw.toolsRequired.map(t => typeof t === 'string' ? { id: t } : t)
      : [],

    // Provenance
    origin: raw.origin || 'authored',        // authored | learned | generated
    learnedFrom: raw.learnedFrom || null,    // { runId, agentId, cycle }
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 1.0,

    // Usage tracking
    usageCount: raw.usageCount || 0,
    successCount: raw.successCount || 0,
    failureCount: raw.failureCount || 0,
    lastUsed: raw.lastUsed || null,
    createdAt: raw.createdAt || new Date().toISOString(),

    metadata: raw.metadata || {}
  };
}

function normalizeImplementation(raw) {
  if (!raw) return { type: 'none' };
  return {
    type: raw.type || 'python_script',       // python_script | bash_command | api_call | agent_delegation
    code: raw.code || null,                  // Inline code (for python_script, bash_command)
    scriptPath: raw.scriptPath || null,      // Path to script file (alternative to inline)
    endpoint: raw.endpoint || null,          // URL (for api_call)
    agentType: raw.agentType || null,        // Agent type to delegate to (for agent_delegation)
    toolsRequired: Array.isArray(raw.toolsRequired) ? raw.toolsRequired : [],
    timeout_sec: raw.timeout_sec || 120,
    workingDir: raw.workingDir || null
  };
}

const SKILL_ORIGINS = ['authored', 'learned', 'generated'];
const IMPLEMENTATION_TYPES = ['python_script', 'bash_command', 'api_call', 'agent_delegation', 'none'];

// ── Plugin Schema ────────────────────────────────────────────────────────────

/**
 * A Plugin is a domain-specific bundle of skills and tool declarations.
 * Plugins group related capabilities and declare environment requirements.
 */
function normalizePlugin(raw) {
  if (!raw || !raw.id) throw new Error('Plugin definition requires an id');
  if (!raw.name) throw new Error('Plugin definition requires a name');
  return {
    id: String(raw.id),
    name: raw.name,
    domain: raw.domain || 'general',
    description: raw.description || '',
    version: raw.version || '0.1.0',
    tags: Array.isArray(raw.tags) ? raw.tags : [],

    // Skills bundled in this plugin (IDs — resolved at runtime)
    skills: Array.isArray(raw.skills) ? raw.skills : [],

    // Tools this plugin's skills require (with provisioning hints)
    toolsRequired: Array.isArray(raw.toolsRequired)
      ? raw.toolsRequired.map(t => {
          if (typeof t === 'string') return { id: t };
          return {
            id: t.id,
            version: t.version || null,
            provision: t.provision || null    // e.g., 'pip:numpy', 'docker:cosmo-base:v3', 'apt:sdpb'
          };
        })
      : [],

    // What assumptions this domain tracks (for sensitivity analysis)
    assumptionsTracked: Array.isArray(raw.assumptionsTracked) ? raw.assumptionsTracked : [],

    // Uncertainty model (how errors/uncertainties are characterized in this domain)
    uncertaintyModel: raw.uncertaintyModel || null,

    // Environment requirements for the full plugin
    environment: raw.environment
      ? {
          type: raw.environment.type || 'local',   // local | container | nix
          image: raw.environment.image || null,
          resources: {
            memory_gb: raw.environment.resources?.memory_gb || null,
            cores: raw.environment.resources?.cores || null,
            gpu: raw.environment.resources?.gpu || false,
            timeout_hours: raw.environment.resources?.timeout_hours || null
          }
        }
      : { type: 'local', resources: {} },

    // Provenance
    origin: raw.origin || 'authored',          // authored | generated
    createdAt: raw.createdAt || new Date().toISOString(),

    metadata: raw.metadata || {}
  };
}

// ── Output Contract Schema ───────────────────────────────────────────────────

/**
 * An Output Contract declares what files/data an execution is expected to produce.
 * Used by the Execution Monitor to validate results.
 */
function normalizeOutputContract(raw) {
  if (!raw) return { expectedOutputs: [] };
  return {
    expectedOutputs: Array.isArray(raw.expectedOutputs)
      ? raw.expectedOutputs.map(o => ({
          name: o.name,
          description: o.description || '',
          required: o.required !== false,
          schema: o.schema || null,            // JSON schema for content validation (optional)
          minSizeBytes: o.minSizeBytes || 0
        }))
      : []
  };
}

// ── Execution Result Schema ──────────────────────────────────────────────────

/**
 * Structured result from code execution.
 * Produced by the Execution Monitor, consumed by memory ingestion.
 */
function normalizeExecutionResult(raw) {
  return {
    executionId: raw.executionId || `exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    skillId: raw.skillId || null,
    pluginId: raw.pluginId || null,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : -1,
    stdout: raw.stdout || '',
    stderr: raw.stderr || '',
    outputFiles: Array.isArray(raw.outputFiles)
      ? raw.outputFiles.map(f => ({
          name: f.name,
          path: f.path || null,
          size: f.size || 0,
          contractMatch: f.contractMatch !== false
        }))
      : [],
    runtimeSec: raw.runtimeSec || 0,
    resourceUsage: {
      peakMemoryMB: raw.resourceUsage?.peakMemoryMB || null,
      cpuTimeSec: raw.resourceUsage?.cpuTimeSec || null
    },
    contractValidation: raw.contractValidation || null,
    success: raw.exitCode === 0,
    timestamp: raw.timestamp || new Date().toISOString()
  };
}

// ── Capability Snapshot Schema ───────────────────────────────────────────────

/**
 * A snapshot of what COSMO can currently do.
 * Injected into agent mission metadata for capability-aware planning.
 */
function buildCapabilitySnapshot(toolRegistry, skillRegistry, pluginRegistry) {
  return {
    timestamp: new Date().toISOString(),
    tools: toolRegistry ? toolRegistry.getSnapshot() : [],
    skills: skillRegistry ? skillRegistry.getSnapshot() : [],
    plugins: pluginRegistry ? pluginRegistry.getSnapshot() : [],
    summary: {
      toolCount: toolRegistry ? toolRegistry.size : 0,
      skillCount: skillRegistry ? skillRegistry.size : 0,
      pluginCount: pluginRegistry ? pluginRegistry.size : 0,
      hasDocker: toolRegistry ? toolRegistry.isAvailable('tool:docker') : false,
      hasPython: toolRegistry ? toolRegistry.isAvailable('tool:python') : false,
      hasNode: toolRegistry ? toolRegistry.isAvailable('tool:node') : false
    }
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  normalizeTool,
  normalizeSkill,
  normalizePlugin,
  normalizeImplementation,
  normalizeOutputContract,
  normalizeExecutionResult,
  buildCapabilitySnapshot,
  TOOL_TYPES,
  SKILL_ORIGINS,
  IMPLEMENTATION_TYPES
};
