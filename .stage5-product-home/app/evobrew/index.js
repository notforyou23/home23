#!/usr/bin/env node

/**
 * COSMO Brain Platform - Entry Point
 * 
 * Launches the Brain Browser which allows discovering and 
 * interacting with portable .brain packages.
 */

require('dotenv').config();
const { startServer } = require('./server/browser');

console.log('🚀 Starting COSMO Brain Platform...');

startServer().catch(err => {
  console.error('❌ Failed to start Brain Platform:', err.message);
  process.exit(1);
});

