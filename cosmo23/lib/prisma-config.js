/**
 * COSMO 2.3 - Prisma Configuration Helper
 * 
 * Configures Prisma to use the appropriate database location:
 * - ~/.cosmo2.3/database.db (global config mode)
 * - ./prisma/cosmo2.3.db (legacy mode)
 * 
 * @module lib/prisma-config
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR_NAME = '.cosmo2.3';
const DATABASE_FILE_NAME = 'database.db';

/**
 * Get the path to the global database
 */
function getGlobalDatabasePath() {
  return path.join(os.homedir(), CONFIG_DIR_NAME, DATABASE_FILE_NAME);
}

/**
 * Check if global config exists
 */
function globalConfigExists() {
  const configPath = path.join(os.homedir(), CONFIG_DIR_NAME, 'config.json');
  return fs.existsSync(configPath);
}

/**
 * Get the DATABASE_URL for Prisma.
 * Checks global config first, falls back to project-local.
 * @returns {string}
 */
function getDatabaseUrl() {
  // If global config exists, use global database
  if (globalConfigExists()) {
    const dbPath = getGlobalDatabasePath();
    return `file:${dbPath}`;
  }
  
  // Fall back to project-local database
  return process.env.DATABASE_URL || 'file:./prisma/cosmo2.3.db';
}

/**
 * Set DATABASE_URL in process.env for Prisma.
 * Call this before importing Prisma client.
 */
function configurePrismaEnv() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = getDatabaseUrl();
  }
}

/**
 * Ensure the database directory exists.
 * @returns {string} - Path to database file
 */
function ensureDatabaseDir() {
  if (globalConfigExists()) {
    const dbPath = getGlobalDatabasePath();
    const dir = path.dirname(dbPath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    
    return dbPath;
  }
  
  // Legacy: ensure prisma directory exists
  const legacyDir = path.join(process.cwd(), 'prisma');
  if (!fs.existsSync(legacyDir)) {
    fs.mkdirSync(legacyDir, { recursive: true });
  }
  
  return path.join(legacyDir, 'cosmo2.3.db');
}

module.exports = {
  getDatabaseUrl,
  getGlobalDatabasePath,
  globalConfigExists,
  configurePrismaEnv,
  ensureDatabaseDir
};
