/** Read-only classification of PM2 artifacts accidentally created in a role's HOME.
 * Never load PM2, create a client daemon, send a stop request, or remove a file. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

const DEAD = new Set(['ENOENT', 'ENOTDIR', 'ECONNREFUSED']);
const MAX_REPLY = 1024 * 1024;

/** PM2's Axon RPC uses AMP v1: JSON response followed by a correlation ID.
 * This single read method is deliberately independent of the PM2 Client API,
 * whose reconnect path can spawn a daemon. Unknown protocols fail closed. */
export function inspectEmptyPm2Socket(path, { connectSocket = connect, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    let socket, timer, finished = false, buffer = Buffer.alloc(0);
    const done = status => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(status);
    };
    try { socket = connectSocket(path); } catch { done('ambiguous'); return; }
    const id = `home23-inventory:${randomUUID()}`;
    const parts = [Buffer.from('j:' + JSON.stringify({ type: 'call', method: 'getMonitorData', args: [{}] })), Buffer.from('s:' + id)];
    const request = Buffer.alloc(1 + parts.reduce((size, part) => size + 4 + part.length, 0));
    request[0] = 0x12;
    let offset = 1;
    for (const part of parts) {
      request.writeUInt32BE(part.length, offset);
      offset += 4;
      part.copy(request, offset);
      offset += part.length;
    }
    timer = setTimeout(() => done('ambiguous'), timeoutMs);
    socket.once('connect', () => socket.write(request));
    socket.once('error', error => done(DEAD.has(error.code) ? 'dead' : 'ambiguous'));
    socket.once('close', () => done('ambiguous'));
    socket.on('data', chunk => {
      if (finished) return;
      if (buffer.length + chunk.length > MAX_REPLY) { done('ambiguous'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (!buffer.length) return;
      if (buffer[0] !== 0x12) { done('ambiguous'); return; }
      const values = [];
      let at = 1;
      for (let part = 0; part < 2; part++) {
        if (buffer.length < at + 4) return;
        const length = buffer.readUInt32BE(at);
        if (length > MAX_REPLY - 9) { done('ambiguous'); return; }
        at += 4;
        if (buffer.length < at + length) return;
        values.push(buffer.subarray(at, at + length).toString('utf8'));
        at += length;
      }
      if (at !== buffer.length || !values[0].startsWith('j:') || values[1] !== `s:${id}`) { done('ambiguous'); return; }
      try {
        const response = JSON.parse(values[0].slice(2));
        if (!response || Object.hasOwn(response, 'error') || !Array.isArray(response.args) || response.args.length !== 1 || !Array.isArray(response.args[0])) {
          done('ambiguous'); return;
        }
        done(response.args[0].length === 0 ? 'empty' : 'populated');
      } catch { done('ambiguous'); }
    });
  });
}

export async function inspectUserPm2Artifacts(homeRoot, deps = {}) {
  const directory = join(homeRoot, 'runtime/user/.pm2');
  if (!existsSync(directory)) return { rebuildable: false };
  for (const path of [join(homeRoot, 'runtime'), join(homeRoot, 'runtime/user'), directory]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) return { rebuildable: false };
  }
  // Never classify a claimed supervisor as an accidental, unowned daemon.
  if (['supervisor-owner.json', 'supervisor-launchd.json', 'supervisor-launchd.plist'].some(file => existsSync(join(directory, file))))
    return { rebuildable: false };
  const sockets = ['rpc.sock', 'pub.sock'].filter(file => existsSync(join(directory, file)));
  if (!sockets.length || sockets.some(file => !(deps.lstat || lstatSync)(join(directory, file)).isSocket())) return { rebuildable: false };
  const inspect = deps.inspectSocket || inspectEmptyPm2Socket;
  const rpc = await inspect(join(directory, 'rpc.sock'));
  if (rpc === 'empty') return { rebuildable: true, status: 'empty' };
  // A dead RPC socket alone cannot establish that a surviving PUB endpoint is
  // junk. Both must refuse connections. Do not trust a stale dump.pm2 or PID.
  if (rpc === 'dead' && await inspect(join(directory, 'pub.sock')) === 'dead') return { rebuildable: true, status: 'dead' };
  return { rebuildable: false };
}
