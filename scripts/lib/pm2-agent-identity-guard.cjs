'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

/**
 * Split a Home23 PM2 process name into owning agent + role suffix. The
 * suffix set must track cli/lib/generate-ecosystem.js — an unrecognized
 * suffix would otherwise be swallowed into the agent name and the guard
 * would demand env for a phantom agent (e.g. "jerry-seed").
 */
function parsePm2ProcessName(name) {
  const match = /^home23-([a-z0-9_-]+?)(?:-(dash|harness|mcp|seed))?$/.exec(String(name || ''));
  if (!match) return { agent: '', suffix: '' };
  return { agent: match[1], suffix: match[2] || '' };
}

function pm2AgentFromName(name) {
  return parsePm2ProcessName(name).agent;
}

function loadAgentPorts(root, agent) {
  const file = path.join(root, 'instances', agent, 'config.yaml');
  if (!fs.existsSync(file)) return {};
  const config = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  return config.ports || {};
}

function findPm2ProcessForPid(pm2List, pid) {
  return (pm2List || []).find((proc) => Number(proc.pid) === Number(pid)) || null;
}

function readPm2List() {
  const output = execFileSync('pm2', ['jlist'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 8_000,
  });
  return parsePm2JlistOutput(output);
}

function parsePm2JlistOutput(output) {
  const text = String(output || '').trim();
  const lines = text.split(/\r?\n/);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join('\n').trim();
    if (candidate.startsWith('[')) candidates.push(candidate);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // PM2 may print daemon startup chatter before JSON.
    }
  }

  const sample = text.slice(0, 160).replace(/\s+/g, ' ');
  throw new Error(`pm2 jlist did not return a JSON process list: ${sample || '<empty>'}`);
}

function buildExpectedEnv(root, agent, suffix = '') {
  const expected = {
    HOME23_AGENT: agent,
    // The seed runner is the one agent process whose INSTANCE_ID carries its
    // suffix (see generate-ecosystem.js); every other role uses the base id.
    INSTANCE_ID: suffix === 'seed' ? `home23-${agent}-seed` : `home23-${agent}`,
  };
  // The seed runner's env carries no port variables — asserting ports there
  // would refuse a correctly-configured process.
  if (suffix === 'seed') return expected;

  const ports = loadAgentPorts(root, agent);
  const dashboard = String(ports.dashboard || '');
  const realtime = String(ports.engine || '');
  const mcp = String(ports.mcp || '');
  if (mcp) expected.MCP_HTTP_PORT = mcp;
  // The MCP server's env carries only its own port.
  if (suffix === 'mcp') return expected;

  if (dashboard) {
    expected.DASHBOARD_PORT = dashboard;
    expected.COSMO_DASHBOARD_PORT = dashboard;
  }
  if (realtime) expected.REALTIME_PORT = realtime;
  return expected;
}

function hasInstanceConfig(root, agent) {
  try {
    return fs.existsSync(path.join(root, 'instances', agent, 'config.yaml'));
  } catch {
    return false;
  }
}

function collectEnvMismatches(env, expected) {
  const mismatches = [];
  for (const [key, value] of Object.entries(expected)) {
    const actual = env[key] === undefined ? '' : String(env[key]);
    if (actual !== value) mismatches.push({ key, expected: value, actual });
  }
  return mismatches;
}

function validatePm2AgentIdentity({ root, env = process.env, pid = process.pid, pm2List } = {}) {
  const home23Root = root || path.resolve(__dirname, '..', '..');
  const list = pm2List || readPm2List();
  const proc = findPm2ProcessForPid(list, pid);
  if (!proc) return { ok: true, skipped: true, reason: 'pm2_process_not_found' };

  const parsed = parsePm2ProcessName(proc.name);
  if (!parsed.agent) return { ok: true, skipped: true, reason: 'non_agent_pm2_process', pm2Name: proc.name };

  // Agent names may legally end in a role suffix (every creation validator
  // accepts "alice-seed"), so home23-alice-seed is ambiguous: alice's seed
  // runner or agent alice-seed's engine. Accept the process when its env
  // matches either reading; check the reading whose instance config exists
  // first so refusals report against the agent that is actually installed.
  const interpretations = [parsed];
  if (parsed.suffix) {
    interpretations.push({ agent: `${parsed.agent}-${parsed.suffix}`, suffix: '' });
  }
  interpretations.sort(
    (a, b) => Number(hasInstanceConfig(home23Root, b.agent)) - Number(hasInstanceConfig(home23Root, a.agent)),
  );

  let firstFailure = null;
  for (const candidate of interpretations) {
    const expected = buildExpectedEnv(home23Root, candidate.agent, candidate.suffix);
    const mismatches = collectEnvMismatches(env, expected);
    if (mismatches.length === 0) {
      return {
        ok: true,
        skipped: false,
        pm2Name: proc.name,
        expectedAgent: candidate.agent,
        mismatches: [],
      };
    }
    if (!firstFailure) firstFailure = { expectedAgent: candidate.agent, mismatches };
  }

  return {
    ok: false,
    skipped: false,
    pm2Name: proc.name,
    ...firstFailure,
  };
}

function assertPm2AgentIdentity(options = {}) {
  let result;
  try {
    result = validatePm2AgentIdentity(options);
  } catch (err) {
    const message = `[pm2-agent-identity] unable to verify PM2 identity before startup: ${err.message || err}`;
    if (typeof options.onWarn === 'function') options.onWarn(message);
    else console.warn(message);
    return { ok: true, skipped: true, reason: 'verification_failed', error: err.message || String(err) };
  }

  if (!result.ok) {
    const details = result.mismatches
      .map((m) => `${m.key}=${m.actual || '<empty>'} expected ${m.expected}`)
      .join('; ');
    throw new Error(`[pm2-agent-identity] refusing startup for ${result.pm2Name}: ${details}`);
  }
  return result;
}

module.exports = {
  assertPm2AgentIdentity,
  validatePm2AgentIdentity,
  pm2AgentFromName,
  parsePm2ProcessName,
  parsePm2JlistOutput,
};
