'use strict';

// One rule for '~' in every path an owner or resident names. Under the Host,
// HOME is Home23's private runtime home (<home>/runtime/user: npm, the Chrome
// profile, Caddy, Python caches, provider-CLI stores), so it is never the
// owner's. productEnvironment() names the owner's macOS account home in
// HOME23_OWNER_HOME, from the passwd entry, at every launch. Outside the Host
// (no HOME23_PRODUCT_HOST) HOME is honoured, so development checkouts and
// tests can redirect it. cli/lib code cannot load this file (the retained
// update executor copies only ./ imports) and uses product-environment.js's
// ownerAccountHome(), the same passwd rule.

const os = require('node:os');
const path = require('node:path');

function absolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') ? path.resolve(value) : null;
}

function accountHome() {
  // A uid without a passwd entry has no owner home at all; the process home
  // is then the only one there is.
  try { return absolute(os.userInfo().homedir) || os.homedir(); } catch { return os.homedir(); }
}

/** The owner's home: HOME23_OWNER_HOME, else (outside the Host) HOME, else the passwd entry. */
function ownerHome(env = process.env) {
  return absolute(env?.HOME23_OWNER_HOME)
    || (env?.HOME23_PRODUCT_HOST !== 'true' && absolute(env?.HOME))
    || accountHome();
}

/** Home23's own private home: HOME23_RUNTIME_HOME (kept for owner children), else HOME. */
function runtimeHome(env = process.env) {
  return absolute(env?.HOME23_RUNTIME_HOME) || absolute(env?.HOME) || os.homedir();
}

/**
 * '~' and '~/x' name the owner's home. Everything else is returned unchanged,
 * including '~user/x' (another account, not this owner's '~' plus "user"),
 * relative and absolute paths, and non-strings.
 */
function expandOwnerPath(p, env = process.env) {
  if (typeof p !== 'string') return p;
  if (p === '~') return ownerHome(env);
  if (p.startsWith('~/')) return path.join(ownerHome(env), p.slice(2));
  return p;
}

module.exports = {
  expandOwnerPath,
  ownerHome,
  runtimeHome,
};
