/**
 * Home23 CLI — PM2 wrapper commands
 *
 * start, stop, status, logs — all filtered to home23-* processes.
 */

import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureSystemHealth } from './system-health.js';

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

export async function runStart(home23Root, agentName) {
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
    // Start specific agent's processes
    const names = agentProcessNames(agentName);
    console.log(`Starting ${agentName}...`);
    try {
      execSync(`pm2 start ${ecosystemPath} --only ${names.join(',')}`, { cwd: home23Root, stdio: 'inherit' });
    } catch {
      // PM2 prints its own output
    }
  } else {
    // Start all
    console.log('Starting all agents...');
    try {
      execSync(`pm2 start ${ecosystemPath}`, { cwd: home23Root, stdio: 'inherit' });
    } catch {
      // PM2 prints its own output
    }
  }

  // Start evobrew (shared process) if not already running
  try {
    const jlist = exec('pm2 jlist');
    const procs = JSON.parse(jlist);
    const evobrewRunning = procs.some(p => p.name === 'home23-evobrew' && p.pm2_env?.status === 'online');
    if (!evobrewRunning) {
      console.log('Starting evobrew...');
      execSync(`pm2 start ${ecosystemPath} --only home23-evobrew`, { cwd: home23Root, stdio: 'inherit' });
    }
  } catch {
    console.log('  (evobrew not started)');
  }

  // Start cosmo23 (shared process) if not already running
  try {
    const jlist2 = exec('pm2 jlist');
    const procs2 = JSON.parse(jlist2);
    const cosmo23Running = procs2.some(p => p.name === 'home23-cosmo23' && p.pm2_env?.status === 'online');
    if (!cosmo23Running) {
      console.log('Starting COSMO 2.3...');
      execSync(`pm2 start ${ecosystemPath} --only home23-cosmo23`, { cwd: home23Root, stdio: 'inherit' });
    }
  } catch (err) {
    console.error(`  ⚠ COSMO 2.3 failed to start: ${err.message}`);
    console.log('  Check logs/cosmo23-err.log for details');
  }

  // Find dashboard port for the URL
  let dashPort = 5002;
  try {
    const { readdirSync, readFileSync: readFs } = await import('node:fs');
    const yaml = (await import('js-yaml')).default;
    const instancesDir = join(home23Root, 'instances');
    if (existsSync(instancesDir)) {
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
