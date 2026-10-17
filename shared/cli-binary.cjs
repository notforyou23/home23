'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function extraPathDirs() {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
}

// Shared with the coding bridge: the configured candidate comes first, then
// normal PATH and user-local installs. No shell or credential files are read.
function resolveBinFrom(candidates, configBin, env = process.env) {
  for (const candidate of configBin ? [configBin, ...candidates] : candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of [...(env.PATH || '').split(path.delimiter).filter(Boolean), ...extraPathDirs()]) {
      const found = path.join(dir, candidate);
      if (fs.existsSync(found)) return found;
    }
  }
  return null;
}

const CODEX_CATALOG_COMPATIBILITY_VERSION = '0.162.0';
function parseCodexVersion(output) {
  // Only stable, exact SemVer output is a catalog protocol version. Reject
  // diagnostics, arbitrary CLI output and development/prerelease versions.
  const text = String(output).trim();
  if (text.length > 64) return null;
  const version = /^(?:codex-cli )?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(text)?.[1];
  return version && version.split('.').every(value => Number.isSafeInteger(Number(value))) ? version : null;
}

function maxStableVersion(...values) {
  return values.filter(value => typeof value === 'string' && parseCodexVersion(value) === value)
    .sort((a, b) => {
      const left = a.split('.').map(Number); const right = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
      return 0;
    })[0] || CODEX_CATALOG_COMPATIBILITY_VERSION;
}

const CODEX_REGISTRY_VERSION_URL = 'https://registry.npmjs.org/@openai/codex/latest';
async function fetchCodexRegistryVersion(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(CODEX_REGISTRY_VERSION_URL, {
    method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(1500),
  });
  if (!response.ok || !response.body?.getReader) throw Error('Codex version metadata unavailable');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw Error('Codex version metadata too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (metadata.name !== '@openai/codex') throw Error('Invalid Codex metadata package');
  const version = metadata.version;
  if (typeof version !== 'string' || parseCodexVersion(version) !== version) throw Error('Invalid stable Codex metadata version');
  return version;
}

function versionProbeEnv(base) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (typeof base[key] === 'string') env[key] = base[key];
  }
  return env;
}

function createCodexCatalogVersionDetector({ env = process.env, resolveBin = resolveBinFrom, runVersion = execFileSync } = {}) {
  let memo; let lastVersion = CODEX_CATALOG_COMPATIBILITY_VERSION;
  return function detect(configBin) {
    let binary; let fingerprint;
    try {
      binary = resolveBin(['codex'], configBin, env);
      if (!binary) return { version: lastVersion, fingerprint: 'compatibility-no-cli', errorCode: null };
      const real = fs.realpathSync(binary); const stat = fs.statSync(real);
      fingerprint = `${binary}:${real}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
      if (memo?.fingerprint === fingerprint) return memo;
      const version = parseCodexVersion(runVersion(binary, ['--version'], {
        encoding: 'utf8', timeout: 1500, maxBuffer: 4096, env: versionProbeEnv(env), windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
      if (!version) throw Error('Invalid Codex version');
      lastVersion = maxStableVersion(lastVersion, version);
      memo = { version: lastVersion, fingerprint, errorCode: null };
    } catch {
      // A broken installed CLI is not model capability evidence. Discovery
      // still uses a reviewed/official protocol version and the provider API.
      memo = { version: lastVersion,
        fingerprint: fingerprint || `unavailable:${binary || configBin || 'codex'}`,
        errorCode: 'model_discovery_client_version' };
    }
    return memo;
  };
}

module.exports = { extraPathDirs, resolveBinFrom, CODEX_CATALOG_COMPATIBILITY_VERSION, CODEX_REGISTRY_VERSION_URL, parseCodexVersion, maxStableVersion, fetchCodexRegistryVersion, versionProbeEnv, createCodexCatalogVersionDetector };
