/**
 * Home23 CLI — guided first-run setup
 *
 * Runs install plumbing, then creates the first personal agent.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInit } from './init.js';
import { runAgentCreate } from './agent-create.js';
import { askWithDefault, closeRL } from './prompts.js';

function discoverAgents(home23Root) {
  const instancesDir = join(home23Root, 'instances');
  if (!existsSync(instancesDir)) return [];
  return readdirSync(instancesDir).filter((name) => existsSync(join(instancesDir, name, 'config.yaml')));
}

function safeAgentName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'home';
}

export async function runSetup(home23Root) {
  console.log('');
  console.log('Home23 — Guided First Run');
  console.log('────────────────────────');
  console.log('');
  console.log('This will prepare Home23, create your first personal agent, and let you add project folders for ingestion.');
  console.log('');

  await runInit(home23Root, { finalMessage: false });

  const agents = discoverAgents(home23Root);
  if (agents.length > 0) {
    console.log('');
    console.log('An agent already exists. Start Home23 with:');
    console.log('');
    console.log(`  node cli/home23.js start ${agents[0]}`);
    console.log('');
    return;
  }

  console.log('');
  const rawName = await askWithDefault('Personal agent short name', 'home');
  const name = safeAgentName(rawName);
  if (name !== rawName.trim()) {
    console.log(`  Using safe agent name: ${name}`);
  }

  await runAgentCreate(home23Root, name);
  closeRL();

  console.log('Guided setup complete.');
  console.log('');
  console.log(`  Start: node cli/home23.js start ${name}`);
  console.log('  Open:  http://localhost:5002/home23');
  console.log('');
}
