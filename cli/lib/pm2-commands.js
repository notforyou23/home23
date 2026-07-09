/**
 * Home23 CLI — PM2 wrapper commands
 *
 * start, stop, status, logs — all filtered to home23-* processes.
 */

import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { ensureSystemHealth } from './system-health.js';
import {
  SHARED_SERVICES,
  coordinateSharedServiceStartup,
  isSharedServiceName,
  startEcosystemProcesses,
} from './shared-service-start.js';

const SHARED_SERVICE_LABELS = new Map(
  SHARED_SERVICES.map((service) => [service.name, service.label]),
);
const AUTOSTART_SUPPORT_PROCESS_NAMES = Object.freeze(['home23-chrome-cdp']);

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function agentProcessNames(agentName) {
  return [
    `home23-${agentName}`,
    `home23-${agentName}-dash`,
    `home23-${agentName}-harness`,
  ];
}

function allNonSharedAutostartProcessNames(home23Root) {
  const manifestPath = join(home23Root, 'config', 'agents.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('No agents found in config/agents.json');
  }
  return [
    ...manifest.flatMap((agent) => agentProcessNames(agent.name)),
    ...AUTOSTART_SUPPORT_PROCESS_NAMES,
  ];
}

export async function runStart(home23Root, agentName) {
  if (agentName && !/^[a-z0-9][a-z0-9-]*$/.test(agentName)) {
    console.error('Agent name must be lowercase alphanumeric with hyphens.');
    process.exit(1);
  }
  if (agentName && isSharedServiceName(`home23-${agentName}`)) {
    console.error(`Agent name "${agentName}" is reserved for a Home23 shared service.`);
    process.exit(1);
  }

  // Build TypeScript first
  console.log('Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
    console.log('  done');
  } catch {
    console.error('  Build FAILED. Fix errors with: npx tsc --noEmit');
    process.exit(1);
  }

  // Ensure system plumbing is healthy (encryption key, configs, ecosystem)
  await ensureSystemHealth(home23Root);

  const ecosystemPath = join(home23Root, 'ecosystem.config.cjs');
  if (!existsSync(ecosystemPath)) {
    console.error('No ecosystem.config.cjs found. Run "home23 agent create" first.');
    process.exit(1);
  }

  if (agentName) {
    const agentConfigPath = join(home23Root, 'instances', agentName, 'config.yaml');
    if (!existsSync(agentConfigPath)) {
      console.error(`Agent "${agentName}" does not exist. Run "node cli/home23.js agent create ${agentName}" first.`);
      process.exit(1);
    }

    // Start specific agent's processes
    const names = agentProcessNames(agentName);
    console.log(`Starting ${agentName}...`);
    try {
      startEcosystemProcesses({ home23Root, names, stdio: 'inherit' });
    } catch (err) {
      console.error(`Failed to start ${agentName}: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Start all
    console.log('Starting all agents...');
    try {
      startEcosystemProcesses({
        home23Root,
        names: allNonSharedAutostartProcessNames(home23Root),
        stdio: 'inherit',
      });
    } catch (err) {
      console.error(`Failed to start Home23: ${err.message}`);
      process.exit(1);
    }
  }

  const sharedStartup = await coordinateSharedServiceStartup({ home23Root });
  for (const service of sharedStartup.services) {
    const label = SHARED_SERVICE_LABELS.get(service.name) || service.name;
    console.log(`  ${label}: ${service.action}`);
  }

  // Find dashboard port for the URL
  let dashPort = 5002;
  try {
    const { readdirSync, readFileSync: readFs } = await import('node:fs');
    const yaml = (await import('js-yaml')).default;
    const instancesDir = join(home23Root, 'instances');
    if (agentName) {
      const cfgPath = join(instancesDir, agentName, 'config.yaml');
      if (existsSync(cfgPath)) {
        const cfg = yaml.load(readFs(cfgPath, 'utf8'));
        if (cfg?.ports?.dashboard) dashPort = cfg.ports.dashboard;
      }
    } else if (existsSync(instancesDir)) {
      const agents = readdirSync(instancesDir);
      for (const a of agents) {
        const cfgPath = join(instancesDir, a, 'config.yaml');
        if (existsSync(cfgPath)) {
          const cfg = yaml.load(readFs(cfgPath, 'utf8'));
          if (cfg?.ports?.dashboard) { dashPort = cfg.ports.dashboard; break; }
        }
      }
    }
  } catch { /* use default */ }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Home23 is running!');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log(`  Open your browser:  http://localhost:${dashPort}/home23`);
  console.log('');
  console.log('  Check status:       node cli/home23.js status');
  console.log('  View logs:          node cli/home23.js logs');
  console.log('  Stop:               node cli/home23.js stop');
  console.log('');
}

export async function runStop(home23Root, agentName) {
  const ecosystemPath = join(home23Root, 'ecosystem.config.cjs');

  if (agentName) {
    if (isSharedServiceName(`home23-${agentName}`)) {
      console.error(`Agent name "${agentName}" is reserved for a Home23 shared service.`);
      process.exit(1);
    }
    const names = agentProcessNames(agentName);
    console.log(`Stopping ${agentName}...`);
    for (const name of names) {
      try {
        execSync(`pm2 stop ${name}`, { stdio: 'pipe' });
        console.log(`  ${name}: stopped`);
      } catch {
        console.log(`  ${name}: not running`);
      }
    }
  } else {
    console.log('Stopping all Home23 agents...');
    // Also stop evobrew
    try {
      execSync('pm2 stop home23-evobrew', { stdio: 'pipe' });
      console.log('  home23-evobrew: stopped');
    } catch {
      // Not running
    }
    try {
      execSync('pm2 stop home23-cosmo23', { stdio: 'pipe' });
      console.log('  home23-cosmo23: stopped');
    } catch { /* not running */ }
    try {
      execSync('pm2 stop home23-screenlogic', { stdio: 'pipe' });
      console.log('  home23-screenlogic: stopped');
    } catch { /* not running */ }
    try {
      execSync(`pm2 stop ${ecosystemPath}`, { cwd: home23Root, stdio: 'inherit' });
    } catch {
      // PM2 prints its own output
    }
  }
}

export async function runStatus() {
  // Get PM2 process list and filter to home23-*
  try {
    const output = exec('pm2 jlist');
    const processes = JSON.parse(output);
    const home23Procs = processes.filter((p) => p.name.startsWith('home23-'));

    if (home23Procs.length === 0) {
      console.log('No Home23 processes running.');
      return;
    }

    console.log('');
    console.log('Home23 Processes:');
    console.log('─────────────────────────────────────────────────────');
    console.log('  Name                           Status    PID     Mem       Restarts');
    console.log('─────────────────────────────────────────────────────');

    for (const p of home23Procs) {
      const name = p.name.padEnd(32);
      const status = (p.pm2_env?.status || 'unknown').padEnd(9);
      const pid = String(p.pid || 0).padEnd(7);
      const mem = p.monit?.memory ? `${(p.monit.memory / 1024 / 1024).toFixed(1)}mb`.padEnd(9) : '—'.padEnd(9);
      const restarts = String(p.pm2_env?.restart_time || 0);
      console.log(`  ${name} ${status} ${pid} ${mem} ${restarts}`);
    }
    console.log('');
  } catch {
    // Fall back to pm2 status
    execSync('pm2 status', { stdio: 'inherit' });
  }
}

export async function runLogs(agentName) {
  if (agentName) {
    // Tail logs for specific agent — use pm2 logs with regex filter
    const proc = spawn('pm2', ['logs', '--lines', '30', `home23-${agentName}`], {
      stdio: 'inherit',
    });
    proc.on('error', () => {
      console.error('Failed to start pm2 logs');
    });
  } else {
    // Tail all home23 logs
    const proc = spawn('pm2', ['logs', '--lines', '30', '/home23-/'], {
      stdio: 'inherit',
    });
    proc.on('error', () => {
      console.error('Failed to start pm2 logs');
    });
  }
}
