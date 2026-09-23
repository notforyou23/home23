/** Isolation boundaries for an installed Home23 Host. No ambient credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';

export const PORT_KEYS = ['coordination', 'engine', 'dashboard', 'mcp', 'bridge', 'evobrew', 'observatory'];
export const PORT_KEYS_WITH_EMBEDDER = [...PORT_KEYS, 'embedder'];
export const OWNED_EMBEDDER_FORBIDDEN_PORT = 11435;
export function portKeysFor({ encoderRequired = false } = {}) {
  return encoderRequired ? PORT_KEYS_WITH_EMBEDDER : PORT_KEYS;
}
export function embedderCacheDir(homeRoot) {
  return join(absoluteHome(homeRoot), 'runtime', 'embedder-cache');
}
export function absoluteHome(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || resolve(value) === '/') throw new Error('Choose an absolute directory for this Home23 home.');
  const homeRoot = resolve(value);
  for (let current = homeRoot; ; current = dirname(current)) {
    if (existsSync(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) throw new Error('Home23 requires real home directory ancestors, not symbolic links.');
    if (dirname(current) === current) break;
  }
  return homeRoot;
}
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Home23 private runtime directory is not owned and private.');
  return path;
}
export function privateJSON(path, value) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Home23 state must be a regular private file.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export function readPrivateJSON(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Home23 state must be a private file owned by this user.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function socketRootFor(homeRoot) {
  // /tmp is intentionally short: macOS sockaddr_un has a 104-byte path limit.
  const hash = createHash('sha256').update(resolve(homeRoot)).digest('hex').slice(0, 16);
  return join('/tmp', `h23-${process.getuid?.() ?? 'user'}-${hash}`);
}
export function productEnvironment(homeRoot, { prepare = false, encoderRequired = false, embedderPort } = {}) {
  homeRoot = absoluteHome(homeRoot);
  const runtime = join(homeRoot, 'runtime');
  const socketRoot = socketRootFor(homeRoot);
  const userHome = join(runtime, 'user');
  const pm2Home = join(runtime, 'pm2');
  const cache = embedderCacheDir(homeRoot);
  if (prepare) for (const directory of [runtime, userHome, pm2Home, socketRoot, ...(encoderRequired ? [cache] : [])]) privateDirectory(directory);
  const env = {
    HOME: userHome, USER: `home23-${process.getuid?.() ?? 'user'}`, LOGNAME: `home23-${process.getuid?.() ?? 'user'}`,
    PATH: `${join(homeRoot, 'bin')}:${join(homeRoot, 'tools', 'node_modules', 'pm2', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: socketRoot, LANG: 'en_US.UTF-8', NODE_ENV: 'production',
    HOME23_ROOT: join(homeRoot, 'app'), HOME23_PRODUCT_HOST: 'true',
    PM2_HOME: pm2Home, PM2_DAEMON_RPC_PORT: join(socketRoot, 'pm2-rpc.sock'),
    PM2_DAEMON_PUB_PORT: join(socketRoot, 'pm2-pub.sock'), PM2_INTERACTOR_RPC_PORT: join(socketRoot, 'pm2-agent.sock'),
    PM2_SILENT: 'true', PM2_DISABLE_UPDATE: 'true',
  };
  if (encoderRequired) {
    if (cache === env.HOME || cache === process.env.HOME) throw new Error('HOME23_EMBEDDER_CACHE must not be the GUI or home directory');
    env.HOME23_EMBEDDER_CACHE = cache;
    env.HOME23_EMBEDDER_BIND = '127.0.0.1';
    if (Number.isInteger(embedderPort)) env.HOME23_EMBEDDER_PORT = String(embedderPort);
  }
  return env;
}
export function validatePortPlan(plan, { encoderRequired = false, continuingBindings = false } = {}) {
  const keys = portKeysFor({ encoderRequired });
  if (!plan || !keys.every(key => Number.isInteger(plan[key]) && plan[key] >= (continuingBindings ? 1024 : 20000) && plan[key] <= 60999)
    || new Set(keys.map(key => plan[key])).size !== keys.length) throw new Error('The saved Home23 port plan is invalid.');
  if (encoderRequired && plan.embedder === OWNED_EMBEDDER_FORBIDDEN_PORT) throw new Error('port 11435 is not the Host embedder port');
  return plan;
}
async function reserve(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}
export async function withReservedPorts(plan, callback, options = {}) {
  const encoderRequired = options.encoderRequired === true || (options.encoderRequired !== false && Number.isInteger(plan?.embedder));
  validatePortPlan(plan, { encoderRequired, continuingBindings: options.continuingBindings === true });
  const servers = [];
  try {
    for (const key of portKeysFor({ encoderRequired })) servers.push(await reserve(plan[key]));
    return await callback();
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
export async function choosePortPlan({ encoderRequired = false } = {}) {
  // Complete disjoint plans, avoiding all historical low fixed Home23 ports.
  const keys = portKeysFor({ encoderRequired });
  const first = 20000 + Math.floor(Math.random() * 35000);
  for (let attempt = 0; attempt < 500; attempt++) {
    const base = 20000 + ((first - 20000 + attempt * keys.length) % 40000);
    const plan = Object.fromEntries(keys.map((key, index) => [key, base + index]));
    try { return await withReservedPorts(plan, async () => plan, { encoderRequired }); }
    catch (error) { if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error; }
  }
  throw new Error('Could not reserve local Home23 ports. Close an unused local service and retry.');
}
export function providerEndpoint(value) {
  if (typeof value !== 'string') throw new Error('Enter an HTTP or HTTPS model server URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter an HTTP or HTTPS model server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model server URL must use HTTP or HTTPS without credentials, query, or fragment.');
  return url.href.replace(/\/+$/, '');
}
