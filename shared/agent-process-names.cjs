/**
 * Agent PM2 process names — one authority for which processes belong to an
 * agent, shared by the CLI (start/stop/logs) and the dashboard settings API
 * (agent lifecycle routes).
 *
 * The ecosystem generator (cli/lib/generate-ecosystem.js) emits up to five
 * processes per agent; two of them are conditional on the agent's instance
 * config. Lifecycle code that hardcodes the engine/dash/harness triplet
 * silently strands the conditional processes — a substrate-enabled agent's
 * seed runner kept running after "stop", and was orphaned into a crash loop
 * after agent deletion removed its state directory.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/** Every suffix the ecosystem generator can emit for an agent, in emit order. */
const AGENT_PROCESS_SUFFIXES = Object.freeze(['', '-dash', '-mcp', '-harness', '-seed']);

function loadAgentInstanceConfig(home23Root, agentName) {
  try {
    const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
    if (!fs.existsSync(configPath)) return {};
    return yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function hasInstanceConfig(home23Root, agentName) {
  if (!home23Root || !agentName) return false;
  try {
    return fs.existsSync(path.join(home23Root, 'instances', agentName, 'config.yaml'));
  } catch {
    return false;
  }
}

/**
 * Agent names may legally end in a role suffix (`alice-seed` passes every
 * creation validator), so `home23-alice-seed` is ambiguous: alice's seed
 * runner or the agent alice-seed's engine. When the sibling agent exists,
 * the name belongs to the sibling's engine — alice's lifecycle must not
 * touch it. Returns the suffixes of `agentName` whose candidate name is
 * actually a sibling agent's engine process.
 */
function siblingCollisionSuffixes(home23Root, agentName) {
  return AGENT_PROCESS_SUFFIXES.filter(
    (suffix) => suffix !== '' && hasInstanceConfig(home23Root, `${agentName}${suffix}`),
  );
}

/**
 * The process names the ecosystem generator emits for this agent, derived
 * from the same config conditions the generator uses. Pass `config` to skip
 * the instance read (tests, callers that already loaded it).
 */
function agentProcessNames({ home23Root, agentName, config } = {}) {
  const cfg = config !== undefined
    ? (config || {})
    : loadAgentInstanceConfig(home23Root, agentName);
  const collisions = home23Root ? siblingCollisionSuffixes(home23Root, agentName) : [];
  const base = `home23-${agentName}`;
  const names = [base];
  if (!collisions.includes('-dash')) names.push(`${base}-dash`);
  if (cfg.mcp?.enabled !== false && !collisions.includes('-mcp')) names.push(`${base}-mcp`);
  if (!collisions.includes('-harness')) names.push(`${base}-harness`);
  if (cfg.substrate?.enabled === true && !collisions.includes('-seed')) names.push(`${base}-seed`);
  return names;
}

/**
 * Every process name that could ever belong to this agent, regardless of
 * current config. Teardown paths (stop, delete) use this so a process from a
 * previous config state is still stopped/removed instead of stranded. Pass
 * home23Root so names that are really a sibling agent's engine (see
 * siblingCollisionSuffixes) are excluded — stopping or deleting one agent
 * must never reach into another.
 */
function agentProcessNameCandidates(agentName, home23Root) {
  const collisions = home23Root ? siblingCollisionSuffixes(home23Root, agentName) : [];
  return AGENT_PROCESS_SUFFIXES
    .filter((suffix) => !collisions.includes(suffix))
    .map((suffix) => `home23-${agentName}${suffix}`);
}

/**
 * Keep only names actually declared in ecosystem.config.cjs, so
 * `pm2 start --only` never references an app PM2 cannot find. The generated
 * file is matched textually — require()ing it would execute its top-level
 * env scrubbing inside the calling process. Absent/unreadable file returns
 * the names unchanged (callers that got this far already require the file).
 */
function filterNamesByEcosystem(names, ecosystemPath) {
  let source;
  try {
    source = fs.readFileSync(ecosystemPath, 'utf8');
  } catch {
    return names;
  }
  return names.filter((name) => source.includes(`name: '${name}'`));
}

module.exports = {
  AGENT_PROCESS_SUFFIXES,
  agentProcessNames,
  agentProcessNameCandidates,
  filterNamesByEcosystem,
  hasInstanceConfig,
  loadAgentInstanceConfig,
  siblingCollisionSuffixes,
};
