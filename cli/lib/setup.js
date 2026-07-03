/**
 * Home23 CLI — guided first-run setup
 *
 * Runs install plumbing, then opens the browser-based first-run surface.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
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

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findSetupPort(start = 50523) {
  for (let port = start; port < start + 25; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No setup web port available from ${start} to ${start + 24}`);
}

function openBrowser(url) {
  const opener = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function runWebSetup(home23Root, agents) {
  const setupPort = await findSetupPort();
  const url = `http://localhost:${setupPort}/home23/setup`;

  console.log('');
  console.log('Opening Home23 web onboarding...');
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  if (agents.length > 0) {
    console.log(`Existing agent detected: ${agents[0]}`);
    console.log('The setup page will still open so you can review providers, agent settings, imports, and launch state.');
    console.log('');
  } else {
    console.log('Use the browser to connect providers, create your first agent, add personal context, add project folders, and launch.');
    console.log('');
  }
  console.log('Keep this terminal open while onboarding is running. Press Ctrl-C after the browser redirects to the live dashboard.');
  console.log('');

  const env = {
    ...process.env,
    HOME23_ROOT: home23Root,
    HOME23_SETUP_MODE: '1',
    DASHBOARD_PORT: String(setupPort),
    COSMO_DASHBOARD_PORT: String(setupPort),
    MCP_HTTP_PORT: String(setupPort + 1),
  };
  for (const key of ['HOME23_AGENT', 'INSTANCE_ID', 'COSMO_RUNTIME_DIR', 'COSMO_WORKSPACE_PATH', 'REALTIME_PORT']) {
    delete env[key];
  }

  const child = spawn(process.execPath, [join(home23Root, 'engine', 'src', 'dashboard', 'server.js')], {
    cwd: home23Root,
    env,
    stdio: 'inherit',
  });

  setTimeout(() => {
    if (!openBrowser(url)) {
      console.log(`Open this URL in your browser: ${url}`);
    }
  }, 1200).unref();

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal || code === 0) resolve();
      else reject(new Error(`setup web server exited with code ${code}`));
    });
  });
}

export async function runSetup(home23Root, options = {}) {
  console.log('');
  console.log('Home23 — Guided First Run');
  console.log('────────────────────────');
  console.log('');
  console.log('This will prepare Home23 and open a browser setup page for providers, your first agent, personal context, project ingestion, and launch.');
  console.log('');

  await runInit(home23Root, { finalMessage: false });

  const agents = discoverAgents(home23Root);
  if (options.mode !== 'cli') {
    await runWebSetup(home23Root, agents);
    return;
  }

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
