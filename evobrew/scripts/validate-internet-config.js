#!/usr/bin/env node

const { loadSecurityProfile } = require('../lib/security-profile');

function fail(message) {
  console.error(`[security:validate-internet] ${message}`);
  process.exit(1);
}

try {
  const env = { ...process.env, SECURITY_PROFILE: 'internet' };
  const config = loadSecurityProfile(env);

  if (!config.isInternetProfile) {
    fail('SECURITY_PROFILE=internet validation did not resolve internet mode');
  }

  console.log('[security:validate-internet] OK');
  console.log(`  workspaceRoot=${config.workspaceRoot}`);
  console.log(`  internetEnableMutations=${config.internetEnableMutations}`);
  console.log(`  internetEnableGatewayProxy=${config.internetEnableGatewayProxy}`);
  console.log(`  internetEnableTerminal=${config.internetEnableTerminal}`);
} catch (error) {
  fail(error.message);
}
