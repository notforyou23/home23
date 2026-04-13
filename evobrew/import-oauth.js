#!/usr/bin/env node
/**
 * Import OAuth Token from Claude CLI
 *
 * This script imports the OAuth token from Claude CLI's ~/.claude/auth.json
 * and stores it in the local database.
 *
 * Usage:
 *   1. Run: claude setup-token
 *   2. Run: node import-oauth.js
 */

require('dotenv').config();
const { importFromClaudeCLI, getOAuthStatus } = require('./server/services/anthropic-oauth');

async function main() {
  console.log('━'.repeat(60));
  console.log('  OAuth Token Import from Claude CLI');
  console.log('━'.repeat(60));
  console.log();

  console.log('Attempting to import OAuth token from Claude CLI...');
  console.log('Location: ~/.claude/auth.json');
  console.log();

  const result = await importFromClaudeCLI();

  if (result.success) {
    console.log('✅ SUCCESS! OAuth token imported');
    console.log();
    console.log('Details:');
    console.log(`   Email: ${result.email || 'N/A'}`);
    console.log(`   Token Type: ${result.isOAuth ? 'OAuth (sk-ant-oat*)' : 'API Key (sk-ant-api*)'}`);
    if (result.expiresAt) {
      console.log(`   Expires: ${result.expiresAt}`);
    } else {
      console.log(`   Expires: Never (long-lived token)`);
    }
    console.log();

    // Show status
    const status = await getOAuthStatus();
    console.log('Current Status:');
    console.log(`   Source: ${status.source}`);
    console.log(`   Valid: ${status.valid ? 'Yes' : 'No'}`);
    console.log();

    console.log('🎉 You can now use the IDE with your Claude subscription!');
    console.log();
    console.log('Start the IDE:');
    console.log('   npm start        # Brain Browser (port 4398)');
    console.log('   npm run studio   # Full IDE (port 4405)');
  } else {
    console.log('❌ FAILED to import OAuth token');
    console.log();
    console.log('Error:', result.error);
    console.log();
    console.log('To fix this:');
    console.log('1. Install Claude CLI if you haven\'t:');
    console.log('   npm install -g @anthropic-ai/claude-cli');
    console.log();
    console.log('2. Run the OAuth setup:');
    console.log('   claude setup-token');
    console.log();
    console.log('3. Then run this script again:');
    console.log('   node import-oauth.js');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
