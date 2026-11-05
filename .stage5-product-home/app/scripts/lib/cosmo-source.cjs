'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Development and acceptance tooling only. Production connects over HTTP.
function cosmoSourcePath(relativePath) {
  const root = process.env.COSMO23_SOURCE_ROOT;
  if (!root || !path.isAbsolute(root)) {
    throw new Error('Set COSMO23_SOURCE_ROOT to the standalone Cosmo checkout for cross-product acceptance tests.');
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Cosmo source path escapes the configured checkout');
  }
  if (!fs.existsSync(resolved) && !fs.existsSync(resolved + '.js')) {
    throw new Error('Standalone Cosmo source is unavailable: ' + relativePath);
  }
  return resolved;
}
module.exports = { cosmoSourcePath };
