#!/usr/bin/env node
/**
 * Evobrew - Configuration Migration Script
 * 
 * Migrates from .env-based configuration to ~/.evobrew/config.json
 * Also migrates the database from ./prisma/studio.db to ~/.evobrew/database.db
 * 
 * Usage: node scripts/migrate-config.js [--dry-run] [--env-path <path>]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Import our modules
const configManager = require('../lib/config-manager');
const encryption = require('../lib/encryption');

// ============================================================================
// CLI Helpers
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    envPath: null,
    force: false,
    help: false
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--env-path' && args[i + 1]) {
      options.envPath = args[++i];
    }
  }
  
  return options;
}

function printHelp() {
  console.log(`
Evobrew Configuration Migration

Migrates from .env to ~/.evobrew/config.json

Usage:
  node scripts/migrate-config.js [options]

Options:
  --dry-run, -n     Show what would be done without making changes
  --force, -f       Overwrite existing config without prompting
  --env-path <path> Path to .env file (default: ./.env)
  --help, -h        Show this help

Examples:
  node scripts/migrate-config.js
  node scripts/migrate-config.js --dry-run
  node scripts/migrate-config.js --env-path /path/to/.env
`);
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ============================================================================
// Migration Logic
// ============================================================================

async function migrate(options) {
  console.log('\n🔄 Evobrew Configuration Migration\n');
  
  // Find .env file
  const envPath = options.envPath || path.join(process.cwd(), '.env');
  
  if (!fs.existsSync(envPath)) {
    console.log(`❌ No .env file found at: ${envPath}`);
    console.log('   Nothing to migrate. Run "evobrew setup" to create new config.');
    process.exit(1);
  }
  
  console.log(`📄 Source: ${envPath}`);
  console.log(`📁 Target: ${configManager.getConfigPath()}`);
  
  // Check if config already exists
  if (configManager.configDirExists() && !options.force) {
    console.log('\n⚠️  Config already exists at ~/.evobrew/config.json');
    
    if (options.dryRun) {
      console.log('   Use --force to overwrite.');
      return;
    }
    
    const answer = await prompt('   Overwrite? (y/n): ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('   Migration cancelled.');
      process.exit(0);
    }
  }
  
  // Parse and convert .env
  console.log('\n📝 Reading .env file...');
  const config = await configManager.migrateFromEnv(envPath);
  
  // Show what will be migrated
  console.log('\n📋 Configuration to migrate:');
  console.log('   Server:');
  console.log(`     HTTP Port: ${config.server.http_port}`);
  console.log(`     HTTPS Port: ${config.server.https_port}`);
  
  console.log('   Providers:');
  if (config.providers.openai.enabled) {
    console.log(`     OpenAI: ✓ (key: ${encryption.mask(config.providers.openai.api_key)})`);
  }
  if (config.providers.anthropic.enabled) {
    console.log(`     Anthropic: ✓ (key: ${encryption.mask(config.providers.anthropic.api_key)})`);
  }
  if (config.providers.xai.enabled) {
    console.log(`     xAI: ✓ (key: ${encryption.mask(config.providers.xai.api_key)})`);
  }
  
  if (config.openclaw.enabled) {
    console.log('   OpenClaw:');
    console.log(`     Gateway: ${config.openclaw.gateway_url}`);
    if (config.openclaw.token) {
      console.log(`     Token: ${encryption.mask(config.openclaw.token)}`);
    }
  }
  
  if (options.dryRun) {
    console.log('\n🔍 DRY RUN - No changes made.');
    return;
  }
  
  // Create config directory and save
  console.log('\n📂 Creating ~/.evobrew/ directory...');
  await configManager.initConfigDir();
  
  console.log('💾 Saving config.json (with encrypted secrets)...');
  await configManager.saveConfig(config);
  
  // Migrate database if it exists
  const oldDbPath = path.join(process.cwd(), 'prisma', 'studio.db');
  if (fs.existsSync(oldDbPath)) {
    console.log('\n🗄️  Migrating database...');
    const dbResult = await configManager.migrateDatabase(oldDbPath);
    console.log(`   ${dbResult.message}`);
  }
  
  console.log('\n✅ Migration complete!');
  console.log('\n📝 Next steps:');
  console.log('   1. Verify config: cat ~/.evobrew/config.json');
  console.log('   2. Test server: npm start');
  console.log('   3. (Optional) Remove old .env: rm .env');
}

// ============================================================================
// Main
// ============================================================================

const options = parseArgs();

if (options.help) {
  printHelp();
  process.exit(0);
}

migrate(options).catch(err => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
