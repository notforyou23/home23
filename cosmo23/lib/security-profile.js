const fs = require('fs');
const path = require('path');

const SECURITY_PROFILES = Object.freeze({
  LOCAL: 'local',
  INTERNET: 'internet'
});

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function normalizeSecurityProfile(value) {
  const normalized = String(value || SECURITY_PROFILES.LOCAL).trim().toLowerCase();
  if (normalized !== SECURITY_PROFILES.LOCAL && normalized !== SECURITY_PROFILES.INTERNET) {
    throw new Error(`Invalid SECURITY_PROFILE "${value}". Expected "local" or "internet".`);
  }
  return normalized;
}

function normalizeAllowlistEntry(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      throw new Error(`Invalid ONLYOFFICE_CALLBACK_ALLOWLIST URL entry: ${raw}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol in ONLYOFFICE_CALLBACK_ALLOWLIST: ${raw}`);
    }
    return {
      type: 'origin',
      protocol: parsed.protocol.toLowerCase(),
      host: parsed.host.toLowerCase(),
      origin: `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`
    };
  }

  return {
    type: 'host',
    host: raw.toLowerCase()
  };
}

function parseOnlyOfficeAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((entry) => normalizeAllowlistEntry(entry))
    .filter(Boolean);
}

function hostMatches(ruleHost, urlHost) {
  if (ruleHost.startsWith('*.')) {
    const suffix = ruleHost.slice(2);
    return urlHost === suffix || urlHost.endsWith(`.${suffix}`);
  }
  return urlHost === ruleHost;
}

function isOnlyOfficeCallbackUrlAllowed(urlString, allowlistRules) {
  if (!urlString) return false;

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (err) {
    return false;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return false;
  }

  const targetHost = parsedUrl.host.toLowerCase();
  const targetOrigin = `${parsedUrl.protocol.toLowerCase()}//${targetHost}`;

  return allowlistRules.some((rule) => {
    if (rule.type === 'origin') {
      return targetOrigin === rule.origin;
    }
    return hostMatches(rule.host, targetHost);
  });
}

function loadSecurityProfile(env = process.env) {
  const securityProfile = normalizeSecurityProfile(env.SECURITY_PROFILE);
  const isInternetProfile = securityProfile === SECURITY_PROFILES.INTERNET;
  const workspaceRootRaw = String(env.WORKSPACE_ROOT || '').trim();
  const workspaceRoot = workspaceRootRaw ? path.resolve(workspaceRootRaw) : null;
  const proxySharedSecret = String(env.EVOBREW_PROXY_SHARED_SECRET || '').trim();
  const onlyOfficeAllowlistRaw = String(env.ONLYOFFICE_CALLBACK_ALLOWLIST || '').trim();
  const onlyOfficeAllowlist = parseOnlyOfficeAllowlist(onlyOfficeAllowlistRaw);
  const collaboraSecret = String(env.COLLABORA_SECRET || '').trim();

  const config = {
    securityProfile,
    isLocalProfile: securityProfile === SECURITY_PROFILES.LOCAL,
    isInternetProfile,
    proxySharedSecret,
    workspaceRoot,
    internetEnableMutations: parseBoolean(env.INTERNET_ENABLE_MUTATIONS, false),
    internetEnableGatewayProxy: parseBoolean(env.INTERNET_ENABLE_GATEWAY_PROXY, false),
    internetEnableTerminal: parseBoolean(env.INTERNET_ENABLE_TERMINAL, false),
    collaboraSecret,
    onlyOfficeAllowlistRaw,
    onlyOfficeAllowlist,
    proxyUserHeaderCandidates: [
      'x-evobrew-auth-user',
      'x-auth-request-user',
      'x-forwarded-user',
      'x-forwarded-email'
    ]
  };

  if (isInternetProfile) {
    const missing = [];

    if (!config.proxySharedSecret) missing.push('EVOBREW_PROXY_SHARED_SECRET');
    if (!config.workspaceRoot) missing.push('WORKSPACE_ROOT');
    if (!config.collaboraSecret) missing.push('COLLABORA_SECRET');
    if (!config.onlyOfficeAllowlistRaw) missing.push('ONLYOFFICE_CALLBACK_ALLOWLIST');

    if (missing.length > 0) {
      throw new Error(
        `SECURITY_PROFILE=internet requires: ${missing.join(', ')}`
      );
    }

    if (!fs.existsSync(config.workspaceRoot)) {
      throw new Error(`WORKSPACE_ROOT does not exist: ${config.workspaceRoot}`);
    }
    if (!fs.statSync(config.workspaceRoot).isDirectory()) {
      throw new Error(`WORKSPACE_ROOT is not a directory: ${config.workspaceRoot}`);
    }

    if (config.onlyOfficeAllowlist.length === 0) {
      throw new Error('ONLYOFFICE_CALLBACK_ALLOWLIST is empty after parsing.');
    }
  }

  return config;
}

module.exports = {
  SECURITY_PROFILES,
  loadSecurityProfile,
  isOnlyOfficeCallbackUrlAllowed
};
