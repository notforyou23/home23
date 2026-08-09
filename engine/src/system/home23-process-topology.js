/**
 * Home23 process topology classification.
 *
 * Home23 can run several sibling agents side by side. Each sibling normally
 * has an engine, dashboard, and harness process, plus an agent-scoped MCP
 * server (unless disabled) and a substrate seed runner (when the agent has a
 * Seed). Shared/support services run alongside those sets. The classifier
 * keeps telemetry interpretation from mistaking expected sibling roles for
 * duplicate deployments.
 */

'use strict';

const ROLE_SPECS = {
  'agent-engine': {
    expectedScriptSuffix: '/engine/src/index.js',
    category: 'agent',
    expectedParallelRole: true,
  },
  'agent-dashboard': {
    expectedScriptSuffix: '/engine/src/dashboard/server.js',
    category: 'agent',
    expectedParallelRole: true,
  },
  'agent-harness': {
    expectedScriptSuffix: '/dist/home.js',
    category: 'agent',
    expectedParallelRole: true,
  },
  'agent-mcp': {
    expectedScriptSuffix: '/mcp/http-server.js',
    category: 'agent',
    expectedParallelRole: true,
  },
  'agent-seed': {
    expectedScriptSuffix: '/substrate/bin/seed-runner.ts',
    category: 'agent',
    expectedParallelRole: true,
  },
  'shared-service': {
    category: 'shared',
    expectedParallelRole: false,
  },
  'support-service': {
    category: 'support',
    expectedParallelRole: false,
  },
  'external-workload': {
    category: 'external',
    expectedParallelRole: false,
  },
  unknown: {
    category: 'unknown',
    expectedParallelRole: false,
  },
};

const SHARED_SERVICE_NAMES = new Set([
  'home23-evobrew',
  'home23-cosmo23',
]);

const SUPPORT_SERVICE_NAMES = new Set([
  'home23-dashboard',
  'home23-screenlogic',
  'home23-chrome-cdp',
]);

function classifyHome23Process(input = {}) {
  const name = normalizeString(input.name || input.pm2Name);
  const script = normalizePath(input.script || input.pmExecPath || input.pm_exec_path);
  const command = normalizeString(input.command);
  const nameRole = roleFromName(name);
  const scriptRole = roleFromScript(script || command);
  const role = nameRole.role !== 'unknown' ? nameRole.role : scriptRole.role;
  const spec = ROLE_SPECS[role] || ROLE_SPECS.unknown;
  const agentName = nameRole.agentName || null;

  let topologyWarning = null;
  if (
    nameRole.role !== 'unknown' &&
    scriptRole.role !== 'unknown' &&
    nameRole.role !== scriptRole.role
  ) {
    topologyWarning = 'name-script-role-mismatch';
  }

  const duplicateKey = agentName && spec.category === 'agent'
    ? `${agentName}:${role}`
    : name || null;

  return {
    family: role === 'external-workload' || role === 'unknown' ? null : 'home23',
    processName: name || null,
    agentName,
    role,
    category: spec.category,
    expectedParallelRole: Boolean(spec.expectedParallelRole),
    duplicateKey,
    duplicateCandidate: false,
    topologyWarning,
    scriptRole: scriptRole.role,
    nameRole: nameRole.role,
    interpretation: buildInterpretation({
      name,
      role,
      agentName,
      nameRole: nameRole.role,
      scriptRole: scriptRole.role,
      topologyWarning,
    }),
  };
}

function annotateHome23ProcessList(processes = []) {
  const annotated = processes.map((process) => ({
    ...process,
    topology: classifyHome23Process(process),
  }));

  const counts = new Map();
  for (const process of annotated) {
    const key = process.topology.duplicateKey;
    if (!key || process.topology.category !== 'agent') continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return annotated.map((process) => {
    const key = process.topology.duplicateKey;
    const duplicateCandidate = Boolean(key && process.topology.category === 'agent' && (counts.get(key) || 0) > 1);
    return {
      ...process,
      topology: {
        ...process.topology,
        duplicateCandidate,
      },
    };
  });
}

function roleFromName(name) {
  if (!name) return { role: 'unknown', agentName: null };
  if (SHARED_SERVICE_NAMES.has(name)) return { role: 'shared-service', agentName: null };
  if (SUPPORT_SERVICE_NAMES.has(name)) return { role: 'support-service', agentName: null };

  const match = /^home23-(.+?)(?:-(dash|harness|mcp|seed))?$/.exec(name);
  if (!match) return { role: 'external-workload', agentName: null };

  const [, agentName, suffix] = match;
  if (suffix === 'dash') return { role: 'agent-dashboard', agentName };
  if (suffix === 'harness') return { role: 'agent-harness', agentName };
  if (suffix === 'mcp') return { role: 'agent-mcp', agentName };
  if (suffix === 'seed') return { role: 'agent-seed', agentName };
  return { role: 'agent-engine', agentName };
}

function roleFromScript(script) {
  if (!script) return { role: 'unknown' };
  const normalized = normalizePath(script);
  if (normalized.endsWith('/engine/src/index.js')) return { role: 'agent-engine' };
  if (normalized.endsWith('/engine/src/dashboard/server.js')) return { role: 'agent-dashboard' };
  if (normalized.endsWith('/dist/home.js')) return { role: 'agent-harness' };
  if (normalized.endsWith('/mcp/http-server.js')) return { role: 'agent-mcp' };
  if (normalized.endsWith('/substrate/bin/seed-runner.ts')) return { role: 'agent-seed' };
  if (normalized.endsWith('/evobrew/server/server.js')) return { role: 'shared-service' };
  if (normalized.endsWith('/cosmo23/server/index.js')) return { role: 'shared-service' };
  if (normalized.endsWith('/scripts/screenlogic_bridge.py')) return { role: 'support-service' };
  if (normalized.endsWith('/scripts/chrome-cdp.sh')) return { role: 'support-service' };
  if (normalized.includes('openclaw-node')) return { role: 'external-workload' };
  return { role: 'unknown' };
}

function buildInterpretation({ name, role, agentName, nameRole, scriptRole, topologyWarning }) {
  if (topologyWarning === 'name-script-role-mismatch') {
    return `Process ${name || '(unknown)'} needs review: name says ${nameRole}, script says ${scriptRole}.`;
  }
  if (role === 'agent-engine') {
    return `${agentName} engine process; expected sibling role, not a duplicate of its harness or dashboard.`;
  }
  if (role === 'agent-dashboard') {
    return `${agentName} dashboard process; expected sibling role for that agent.`;
  }
  if (role === 'agent-harness') {
    return `${agentName} harness bridge; expected compiled TypeScript agent loop, not a duplicate engine.`;
  }
  if (role === 'agent-mcp') {
    return `${agentName} agent-scoped MCP HTTP server; expected sibling role for that agent.`;
  }
  if (role === 'agent-seed') {
    return `${agentName} substrate seed runner; expected single resident — a second instance of this individual is a real duplicate.`;
  }
  if (role === 'shared-service') return 'Shared Home23 service used across sibling agents.';
  if (role === 'support-service') return 'Support Home23 service outside the agent triplet.';
  if (role === 'external-workload') return 'External or non-Home23 workload running on the same host.';
  return 'Unclassified process; treat as unknown until PM2 name, script, or cwd identifies it.';
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizePath(value) {
  return normalizeString(value).replace(/\\/g, '/');
}

module.exports = {
  classifyHome23Process,
  annotateHome23ProcessList,
  _test: {
    roleFromName,
    roleFromScript,
  },
};
