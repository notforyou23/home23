/** A guided, local-only Tailscale Serve route for the installed Home23 home. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { absoluteHome, readPrivateJSON, validatePortPlan } from './product-environment.js';

const exec = promisify(execFile);
const CLIENT_PATHS = ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const INSTALL_URL = 'https://tailscale.com/download/mac';

function result(state, message, extra = {}) {
  return { ok: true, state, message, ...extra };
}

function installedHome(homeRoot) {
  const root = absoluteHome(homeRoot);
  const receipt = readPrivateJSON(join(root, '.home23-install.json'));
  if (!receipt) return { result: result('needsSetup', 'Install and start this Home23 home before connecting another device.') };
  if (receipt.schema !== 'home23.product-install.v1' || receipt.status !== 'installed'
      || receipt.homeRoot !== root || receipt.appRoot !== join(root, 'app')) {
    return { result: result('unavailable', 'This home has no matching Home23 installation receipt. Its existing network route was left unchanged.') };
  }
  const state = readPrivateJSON(join(root, '.home23-host.json'));
  if (!state) return { result: result('needsSetup', 'Create and start your home before connecting another device.') };
  if (state.homeRoot !== root || !['home23.host.v1', 'home23.host.v2'].includes(state.schema)) {
    return { result: result('unavailable', 'This home has no matching Home23 Host state.') };
  }
  validatePortPlan(state.ports, { encoderRequired: state.encoderRequired === true });
  if (!state.desiredRunning) return { result: result('needsSetup', 'Start your home before connecting another device.') };
  return { port: state.ports.coordination };
}

function clientPath() {
  return CLIENT_PATHS.find(path => {
    try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
  });
}

async function runClient(path, args) {
  // The Mac app's Tailscale client uses the ordinary user's home and the
  // supported backend-CLI mode. Never inherit Home23's private runtime HOME.
  const env = { ...process.env, HOME: userInfo().homedir, TAILSCALE_BE_CLI: '1' };
  return exec(path, args, { env, timeout: 15000, maxBuffer: 1024 * 1024 });
}

function dnsName(status) {
  if (status?.BackendState !== 'Running' || status?.Self?.Online !== true) return null;
  const value = status.Self.DNSName?.replace(/\.$/, '').toLowerCase();
  if (!value || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(value)) return null;
  return value;
}

function routeAt(serve, domain, port) {
  // Funnel on this port would make the route public; never adopt or replace it.
  if (serve?.AllowFunnel?.[String(port)]) return 'conflict';
  const tcp = serve?.TCP?.[String(port)];
  const web = serve?.Web || {};
  const expectedKey = `${domain}:${port}`;
  const otherWeb = Object.keys(web).filter(key => key.endsWith(`:${port}`) && key !== expectedKey);
  if (otherWeb.length || (tcp && tcp.HTTPS !== true)) return 'conflict';
  const handlers = web[expectedKey]?.Handlers;
  if (!tcp && !handlers) return 'missing';
  if (tcp?.HTTPS !== true || !handlers || Object.keys(handlers).length !== 1
      || !handlers['/'] || Object.keys(handlers['/']).length !== 1) return 'conflict';
  const proxy = handlers['/'].Proxy;
  return proxy === `http://127.0.0.1:${port}` || proxy === `http://127.0.0.1:${port}/` ? 'matching' : 'conflict';
}

function officialURL(text) {
  for (const match of String(text).matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ''));
      if (['login.tailscale.com', 'tailscale.com'].includes(url.hostname)) return url.href;
    } catch { /* Ignore non-URLs in CLI diagnostics. */ }
  }
  return undefined;
}

async function probe(address, request = fetch) {
  try {
    const response = await request(`${address}/api/v1/capabilities`, {
      method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body);
  } catch { return false; }
}

async function inspect(homeRoot, dependencies = {}) {
  let home;
  try { home = installedHome(homeRoot); }
  catch { return { result: result('error', 'Home23 could not verify this installation. Check the saved home and retry.') }; }
  if (home.result) return home;
  const path = Object.hasOwn(dependencies, 'clientPath') ? dependencies.clientPath : clientPath();
  if (!path) return { result: result('missingClient', 'Install Tailscale on this Mac, then return here.', { installURL: INSTALL_URL }) };
  const run = dependencies.runClient || runClient;
  let status;
  try { status = JSON.parse((await run(path, ['status', '--json'])).stdout); }
  catch { return { result: result('notSignedIn', 'Open Tailscale on this Mac and sign in, then retry.') }; }
  const domain = dnsName(status);
  if (!domain) return { result: result('notSignedIn', 'Open Tailscale on this Mac and sign in, then retry.') };
  let serve;
  try { serve = JSON.parse((await run(path, ['serve', 'status', '--json'])).stdout); }
  catch { return { result: result('unavailable', 'Tailscale Serve status is unavailable. Open Tailscale and retry.') }; }
  const route = routeAt(serve, domain, home.port);
  if (route === 'conflict') return { result: result('unavailable', `Tailscale already uses HTTPS port ${home.port} for another route. Home23 left it unchanged.`) };
  const address = `https://${domain}:${home.port}`;
  if (route === 'matching') {
    if (await probe(address, dependencies.request)) {
      return { result: result('ready', 'Use this secure address in Home23 on your iPhone or iPad.', { address }) };
    }
    return { result: result('unavailable', 'The secure route is saved but Home23 could not be verified through HTTPS. Check that your home and Tailscale are running.') };
  }
  return { port: home.port, domain, path, run, result: result('needsSetup', 'Connect this home securely to your Tailscale devices.') };
}

export async function getDeviceConnectionStatus({ homeRoot }, dependencies = {}) {
  return (await inspect(homeRoot, dependencies)).result;
}

export async function enableDeviceConnection({ homeRoot }, dependencies = {}) {
  const initial = await inspect(homeRoot, dependencies);
  if (initial.result.state !== 'needsSetup' || !initial.port) return initial.result;
  let commandOutput;
  try {
    commandOutput = await initial.run(initial.path, ['serve', '--bg', `--https=${initial.port}`, '--yes', `http://127.0.0.1:${initial.port}`]);
  } catch (error) {
    const approvalURL = officialURL(`${error.stdout || ''}\n${error.stderr || ''}`);
    if (approvalURL) return result('needsApproval', 'Approve HTTPS for this tailnet in Tailscale, then choose Try again.', { approvalURL });
    return result('error', 'Tailscale could not set up the secure route. Check Tailscale on this Mac, then retry.');
  }
  // A CLI success line is not a shareable address. Re-read the persisted route
  // and complete a normal certificate-checked HTTPS capability request.
  const readback = (await inspect(homeRoot, dependencies)).result;
  if (readback.state === 'needsSetup') {
    const approvalURL = officialURL(`${commandOutput?.stdout || ''}\n${commandOutput?.stderr || ''}`);
    if (approvalURL) return result('needsApproval', 'Approve HTTPS for this tailnet in Tailscale, then choose Try again.', { approvalURL });
  }
  return readback;
}
