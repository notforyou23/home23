import { mkdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer, createConnection } from 'node:net';
import { unlink } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { type Binding, readBoard, hash } from './board.js';
import { bootstrap, ChessSession, type Session } from './session.js';
import { atomicWrite } from './store.js';
import { signedChessWake } from './wake.js';

const usage = 'Usage: chess-watch inspect <window-marker> <document-path> | start <session-directory> <binding.json> | status|pause|resume|stop <session-directory>';
export async function main(args: string[], dependencies: { read?: typeof readBoard; wake?: typeof signedChessWake; lockRoot?: string } = {}) {
  const reader = dependencies.read ?? readBoard;
  const [command, directory, bindingFile] = args;
  if (command === 'inspect' && args.length === 3) {
    const sample = await reader({ windowMarker: directory!, documentPath: resolve(bindingFile!) });
    console.log(JSON.stringify({ sample, binding: { windowMarker: sample.windowMarker, documentPath: resolve(bindingFile!), documentMarker: sample.documentMarker, moves: sample.moves, ownerColor: 'w', channelId: 'SET_CANONICAL_CHANNEL_ID' } }, null, 2)); return;
  }
  if (!directory || !['start','status','pause','resume','stop'].includes(command!) || args.length !== (command === 'start' ? 3 : 2)) throw new Error(usage);
  const dir = resolve(directory), stateFile = join(dir, 'state.json');
  // Keep Unix socket paths below macOS's length limit.
  const lockRoot = dependencies.lockRoot ?? join(homedir(), '.home23', 'chess-watch-locks');
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const socket = join(lockRoot, hash(dir).slice(0, 24) + '.sock');
  if (command !== 'start') {
    try {
      const result = await new Promise<string>((resolveResult, reject) => {
        const client = createConnection(socket); let data = '';
        client.setTimeout(15000, () => client.destroy(new Error('Control acknowledgement timed out')));
        client.on('connect', () => client.end(command + '\n'));
        client.on('data', chunk => { data += chunk; }); client.on('error', reject); client.on('end', () => resolveResult(data));
      });
      const reply = JSON.parse(result); if (reply.error) throw new Error(reply.error);
      console.log(result.trim());
    } catch (error) {
      if (command !== 'status') throw error;
      console.log(JSON.stringify({ process: 'unreachable', state: JSON.parse(await readFile(stateFile, 'utf8')) }, null, 2));
    }
    return;
  }
  const binding: Binding = JSON.parse(await readFile(resolve(bindingFile!), 'utf8'));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Global per-document lease prevents duplicate processes even with different session directories.
  const leasePath = join(lockRoot, hash(await realpath(binding.documentPath)));
  let compromised = false;
  const lockOptions = { realpath: false, stale: 10000, update: 2000, retries: 0, onCompromised: () => { compromised = true; } };
  const releaseDirectory = await lockfile.lock(stateFile, lockOptions);
  let release: (() => Promise<void>) | undefined;
  let ownsSocket = false;
  let adapter: ReturnType<typeof signedChessWake> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    release = await lockfile.lock(leasePath, lockOptions);
    let state: Session;
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.version !== 1 || hash(state.binding) !== hash(binding) || state.mode === 'stopped') throw new Error('Stored session differs or is stopped; use a new session directory');
      state.mode = 'paused'; state.reason = 'Process restarted; explicit resume required';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const a = await reader(binding); await new Promise(resolve => setTimeout(resolve, 500));
      const b = await reader(binding); if (hash(a) !== hash(b)) throw new Error('Initial board is not stable');
      state = bootstrap(binding, b);
    }
    await atomicWrite(stateFile, state);
    adapter = (dependencies.wake ?? signedChessWake)();
    const controller = new ChessSession(state, value => atomicWrite(stateFile, value), input => {
      if (compromised) throw new Error('Session lease lost'); return adapter!.submit(input);
    }, reason => console.error(`Chess watcher paused: ${reason}`));
    // Serialize controls with observations and network admissions.
    let chain = Promise.resolve();
    const enqueue = (action: () => Promise<void>) => { chain = chain.then(action); return chain; };
    await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
    server = createServer({ allowHalfOpen: true }, client => {
      let data = ''; client.setTimeout(15000, () => client.destroy());
      client.on('error', () => {});
      client.on('data', chunk => { data += chunk; if (data.length > 100) client.destroy(); });
      client.on('end', () => { void enqueue(async () => {
        try {
          const action = data.trim();
          if (action === 'pause') await controller.pause('Paused by operator');
          else if (action === 'resume') await controller.resume();
          else if (action === 'stop') await controller.stop();
          else if (action !== 'status') throw new Error('Unknown control');
          client.end(JSON.stringify({ process: 'running', state: controller.state }) + '\n');
        } catch (error) { client.end(JSON.stringify({ error: String(error) }) + '\n'); }
      }); });
    });
    await new Promise<void>((resolveListen, reject) => { server!.once('error', reject); server!.listen(socket, resolveListen); });
    ownsSocket = true;
    const signal = () => { void enqueue(() => controller.stop()); };
    process.on('SIGINT', signal); process.on('SIGTERM', signal);
    console.log(JSON.stringify({ sessionId: state.id, mode: state.mode, directory: dir }));
    try {
      while (controller.state.mode !== 'stopped') {
        await enqueue(async () => {
          if (compromised) { await controller.stop(); throw new Error('Session lease lost'); }
          if (controller.state.mode !== 'running') return;
          try { await controller.observe(await reader(binding)); }
          catch (error) { await controller.pause(error instanceof Error ? error.message : String(error)); }
        });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally { process.off('SIGINT', signal); process.off('SIGTERM', signal); }
  } finally {
    if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
    await adapter?.close();
    if (ownsSocket) await unlink(socket).catch(() => {});
    await release?.(); await releaseDirectory();
  }
}
