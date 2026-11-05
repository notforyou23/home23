/**
 * Evobrew Library Index
 * 
 * Re-exports all configuration and utility modules.
 */

// Configuration system
exports.configManager = require('./config-manager');
exports.configLoader = require('./config-loader');
exports.configLoaderSync = require('./config-loader-sync');
exports.encryption = require('./encryption');
exports.prismaConfig = require('./prisma-config');

// Daemon and update management
exports.daemonManager = require('./daemon-manager');
exports.updater = require('./updater');

// Re-export commonly used functions directly
const { loadConfig, saveConfig, initConfigDir, getConfigPath, migrateFromEnv } = require('./config-manager');
const { encrypt, decrypt, isEncrypted, mask } = require('./encryption');
const { loadConfigurationSync } = require('./config-loader-sync');
const { checkForUpdates, performUpdate, fullUpdate, migrateConfig } = require('./updater');

exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.initConfigDir = initConfigDir;
exports.getConfigPath = getConfigPath;
exports.migrateFromEnv = migrateFromEnv;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.isEncrypted = isEncrypted;
exports.mask = mask;
exports.loadConfigurationSync = loadConfigurationSync;
exports.checkForUpdates = checkForUpdates;
exports.performUpdate = performUpdate;
exports.fullUpdate = fullUpdate;
exports.migrateConfig = migrateConfig;
