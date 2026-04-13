#!/usr/bin/env node
/**
 * Import OAuth Token (Direct)
 *
 * Import an OAuth token directly by pasting it.
 * Use this when you have a token from `claude setup-token`.
 *
 * Usage:
 *   node import-oauth-token.js sk-ant-oat01-...
 */

require('dotenv').config();
const { storeToken, getOAuthStatus } = require('./server/services/anthropic-oauth');

async function main() {
  console.log('━'.repeat(60));
  console.log('  Import OAuth Token');
  console.log('━'.repeat(60));
  console.log();

  // Get token from command line argument
  const token = process.argv[2];

  if (!token) {
    console.log('Usage: node import-oauth-token.js <your-token>');
    console.log();
    console.log('Example:');
    console.log('  node import-oauth-token.js sk-ant-oat01-...');
    console.log();
    console.log('Get your token from: claude setup-token');
    process.exit(1);
  }

  // Validate token format
  if (!token.startsWith('sk-ant-')) {
    console.log('❌ Invalid token format');
    console.log('   Expected: sk-ant-oat* or sk-ant-api*');
    console.log('   Got: ' + token.substring(0, 20) + '...');
    process.exit(1);
  }

  console.log('Token received:', token.substring(0, 20) + '...');
  console.log();

  // Store the token (no expiry for long-lived tokens)
  console.log('Storing token in database...');
  const success = await storeToken(token, null);

  if (success) {
    console.log('✅ SUCCESS! Token stored');
    console.log();

    // Show status
    const status = await getOAuthStatus();
    console.log('Status:');
    console.log(`   Source: ${status.source}`);
    console.log(`   Type: ${token.includes('oat') ? 'OAuth (long-lived)' : 'API Key'}`);
    console.log(`   Valid: ${status.valid ? 'Yes' : 'No'}`);
    console.log();

    console.log('🎉 You can now use the IDE with your Claude subscription!');
    console.log();
    console.log('Start the IDE:');
    console.log('   npm start        # Brain Browser (port 4398)');
    console.log('   npm run studio   # Full IDE (port 4405)');
  } else {
    console.log('❌ FAILED to store token');
    console.log();
    console.log('Check:');
    console.log('1. Database is initialized: npm run db:migrate');
    console.log('2. ENCRYPTION_KEY is set in .env');
    console.log('3. Permissions on prisma/studio.db');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
