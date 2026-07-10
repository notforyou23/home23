#!/usr/bin/env node

/**
 * Home23 CLI — Install, configure, and manage agents
 *
 * Usage:
 *   node cli/home23.js init                 — Set up API keys, install deps, build
 *   node cli/home23.js setup                — Web guided first run
 *   node cli/home23.js setup --cli          — Terminal guided first run
 *   node cli/home23.js agent create <name>  — Create a new agent
 *   node cli/home23.js start [name]         — Start agent(s) via PM2
 *   node cli/home23.js stop [name]          — Stop agent(s) via PM2
 *   node cli/home23.js status               — Show running processes
 *   node cli/home23.js logs [name]          — Tail PM2 logs
 */

import { resolve } from 'node:path';
import { isSharedServiceName } from './lib/shared-service-start.js';

const HOME23_ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`
Home23 — Installable AI operating system

Commands:
  init                    First-time setup (deps, build, plumbing)
  setup                   Web guided first run
  setup --cli             Terminal guided first run (init + personal agent)
  start [name]            Start agent(s) via PM2
  stop [name]             Stop agent(s) via PM2
  worker create <name>    Create a reusable worker without a full engine
  worker list             List reusable workers
  worker run <name> "..." Run a reusable worker through the bridge connector
  trust explain <claim>   Explain whether a claim is safe to inherit
  brain-operations prepare [--dry-run]
                          Prepare the signed internal brain-operation boundary
  brain-operations list --state nonterminal --all-requesters
                          Read-only preflight of durable active operations
  update                  Update to latest release
  update --check          Check for updates
  agent create <name>     Create a new agent instance
  status                  Show running processes
  logs [name]             Tail PM2 logs
  help                    Show this help
`);
    process.exit(0);
  }

  if (command === 'init') {
    const { runInit } = await import('./lib/init.js');
    await runInit(HOME23_ROOT);
  } else if (command === 'setup') {
    const { runSetup } = await import('./lib/setup.js');
    await runSetup(HOME23_ROOT, { mode: args.includes('--cli') ? 'cli' : 'web' });
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
    if (isSharedServiceName(`home23-${name}`)) {
      console.error(`Agent name "${name}" is reserved for a Home23 shared service.`);
      process.exit(1);
    }
    const { runAgentCreate } = await import('./lib/agent-create.js');
    await runAgentCreate(HOME23_ROOT, name);
  } else if (command === 'worker') {
    const { handleWorkerCommand } = await import('./lib/worker-commands.js');
    await handleWorkerCommand(args.slice(1), HOME23_ROOT);
  } else if (command === 'trust') {
    const { handleTrustCommand } = await import('./lib/trust-commands.js');
    await handleTrustCommand(args.slice(1), HOME23_ROOT);
  } else if (command === 'brain-operations') {
    const { runBrainOperationsCommand } = await import('./lib/brain-operations-command.js');
    const receipt = await runBrainOperationsCommand(HOME23_ROOT, args.slice(1));
    console.log(JSON.stringify(receipt, null, 2));
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
  } else if (command === 'evobrew' || command === 'cosmo23') {
    console.log(`${command} is now bundled with Home23 and updates automatically.`);
    console.log('Run "home23 update" to update everything.');
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
