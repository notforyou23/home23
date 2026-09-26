'use strict';

const { ownerHome, runtimeHome } = require('./owner-home.cjs');

// Trusted parent services may hold these values, but model/tool/provider
// subprocesses must not inherit them. This is defense in depth inside one OS
// user boundary; it is not a hostile-local-code sandbox.
const PRIVILEGED_CHILD_ENV_KEYS = Object.freeze([
  'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY',
  'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY',
]);

function unprivilegedChildEnv(base = process.env, overrides = {}) {
  const env = { ...base, ...overrides };
  for (const key of PRIVILEGED_CHILD_ENV_KEYS) delete env[key];
  return env;
}

// A child that acts for the owner (a scheduled exec job, the resident shell)
// gets the owner's home as HOME under the Host, so '~', git, ssh and the
// owner's own tools behave as in the owner's shell. Home23's private runtime
// home stays reachable as HOME23_RUNTIME_HOME. Outside the Host this is
// unprivilegedChildEnv. Explicit overrides still win.
function ownerChildEnv(base = process.env, overrides = {}) {
  const owner = base.HOME23_PRODUCT_HOST === 'true'
    ? { HOME23_RUNTIME_HOME: runtimeHome(base), HOME: ownerHome(base) }
    : {};
  return unprivilegedChildEnv(base, { ...owner, ...overrides });
}

module.exports = {
  PRIVILEGED_CHILD_ENV_KEYS,
  ownerChildEnv,
  unprivilegedChildEnv,
};
