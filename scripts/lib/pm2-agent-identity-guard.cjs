'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

function pm2AgentFromName(name) {
  const match = /^home23-([a-z0-9_-]+?)(?:-dash|-harness)?$/.exec(String(name || ''));
  return match?.[1] || '';
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

function buildExpectedEnv(root, agent) {
  const ports = loadAgentPorts(root, agent);
  const dashboard = String(ports.dashboard || '');
  const realtime = String(ports.engine || '');
  const mcp = String(ports.mcp || '');
  const expected = {
    HOME23_AGENT: agent,
    INSTANCE_ID: `home23-${agent}`,
  };
  if (dashboard) {
    expected.DASHBOARD_PORT = dashboard;
    expected.COSMO_DASHBOARD_PORT = dashboard;
  }
  if (realtime) expected.REALTIME_PORT = realtime;
  if (mcp) expected.MCP_HTTP_PORT = mcp;
  return expected;
}

function validatePm2AgentIdentity({ root, env = process.env, pid = process.pid, pm2List } = {}) {
  const home23Root = root || path.resolve(__dirname, '..', '..');
  const list = pm2List || readPm2List();
  const proc = findPm2ProcessForPid(list, pid);
  if (!proc) return { ok: true, skipped: true, reason: 'pm2_process_not_found' };

  const expectedAgent = pm2AgentFromName(proc.name);
  if (!expectedAgent) return { ok: true, skipped: true, reason: 'non_agent_pm2_process', pm2Name: proc.name };

  const expected = buildExpectedEnv(home23Root, expectedAgent);
  const mismatches = [];
  for (const [key, value] of Object.entries(expected)) {
    const actual = env[key] === undefined ? '' : String(env[key]);
    if (actual !== value) mismatches.push({ key, expected: value, actual });
  }

  return {
    ok: mismatches.length === 0,
    skipped: false,
    pm2Name: proc.name,
    expectedAgent,
    mismatches,
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
  parsePm2JlistOutput,
};
