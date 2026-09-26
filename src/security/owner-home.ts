import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ownerHomeRule = require('../../shared/owner-home.cjs') as {
  ownerHome: (env?: NodeJS.ProcessEnv) => string;
  runtimeHome: (env?: NodeJS.ProcessEnv) => string;
  expandOwnerPath: (p: string, env?: NodeJS.ProcessEnv) => string;
};

/** The owner's macOS home for '~' in owner- and resident-named paths (shared/owner-home.cjs). */
export const ownerHome = ownerHomeRule.ownerHome;
/** Home23's own private home, for product-private state. */
export const runtimeHome = ownerHomeRule.runtimeHome;
export const expandOwnerPath = ownerHomeRule.expandOwnerPath;
