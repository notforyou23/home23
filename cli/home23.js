#!/usr/bin/env node

/**
 * Home23 CLI — Install, configure, and manage agents
 *
 * Usage:
 *   node cli/home23.js init                 — Set up API keys, install deps, build
 *   node cli/home23.js agent create <name>  — Create a new agent
 *   node cli/home23.js start [name]         — Start agent(s) via PM2
 *   node cli/home23.js stop [name]          — Stop agent(s) via PM2
 *   node cli/home23.js status               — Show running processes
 *   node cli/home23.js logs [name]          — Tail PM2 logs
 */

import { resolve } from 'node:path';

const HOME23_ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`
Home23 — Installable AI operating system

Commands:
  init                    Set up API keys, install dependencies, build
  agent create <name>     Create a new agent instance
  start [name]            Start agent(s) via PM2
  stop [name]             Stop agent(s) via PM2
  status                  Show running processes
  logs [name]             Tail PM2 logs
  update                  Update Home23 to latest release
  update --check          Check for updates without applying
  evobrew update          Pull latest evobrew from GitHub
  cosmo23 update          Sync latest COSMO 2.3 from source
  help                    Show this help
`);
    process.exit(0);
  }

  if (command === 'init') {
    const { runInit } = await import('./lib/init.js');
    await runInit(HOME23_ROOT);
  } else if (command === 'agent' && subcommand === 'create') {
    const name = args[2];
    if (!name) {
      console.error('Usage: home23 agent create <name>');
      process.exit(1);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      console.error('Agent name must be lowercase alphanumeric with hyphens (e.g., "cosmo", "my-agent")');
      process.exit(1);
    }
    const { runAgentCreate } = await import('./lib/agent-create.js');
    await runAgentCreate(HOME23_ROOT, name);
  } else if (command === 'start') {
    const { runStart } = await import('./lib/pm2-commands.js');
    await runStart(HOME23_ROOT, args[1]);
  } else if (command === 'stop') {
    const { runStop } = await import('./lib/pm2-commands.js');
    await runStop(HOME23_ROOT, args[1]);
  } else if (command === 'status') {
    const { runStatus } = await import('./lib/pm2-commands.js');
    await runStatus();
  } else if (command === 'logs') {
    const { runLogs } = await import('./lib/pm2-commands.js');
    await runLogs(args[1]);
  } else if (command === 'evobrew') {
    if (args[1] === 'update') {
      const { runEvobrewUpdate } = await import('./lib/evobrew-update.js');
      await runEvobrewUpdate(HOME23_ROOT);
    } else {
      console.log('Usage: home23 evobrew update');
    }
  } else if (command === 'cosmo23') {
    if (args[1] === 'update') {
      const { runCosmo23Update } = await import('./lib/cosmo23-update.js');
      await runCosmo23Update(HOME23_ROOT);
    } else {
      console.log('Usage: home23 cosmo23 update');
    }
  } else if (command === 'update') {
    const checkOnly = args.includes('--check');
    const { runUpdate } = await import('./lib/update.js');
    await runUpdate(HOME23_ROOT, checkOnly);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Run "node cli/home23.js help" for usage');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
