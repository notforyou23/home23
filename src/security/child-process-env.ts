import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childEnv = require('../../shared/child-process-env.cjs') as {
  PRIVILEGED_CHILD_ENV_KEYS: readonly [string, string];
  unprivilegedChildEnv: (base?: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  ownerChildEnv: (base?: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

export const PRIVILEGED_CHILD_ENV_KEYS = childEnv.PRIVILEGED_CHILD_ENV_KEYS;
export const unprivilegedChildEnv = childEnv.unprivilegedChildEnv;
/** unprivilegedChildEnv with the owner's home as HOME under the Host (shared/child-process-env.cjs). */
export const ownerChildEnv = childEnv.ownerChildEnv;
