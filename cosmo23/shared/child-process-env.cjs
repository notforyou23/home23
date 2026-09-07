'use strict';

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

module.exports = {
  PRIVILEGED_CHILD_ENV_KEYS,
  unprivilegedChildEnv,
};
