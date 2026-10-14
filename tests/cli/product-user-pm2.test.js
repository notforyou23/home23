import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { inspectEmptyPm2Socket, inspectUserPm2Artifacts } from '../../cli/lib/product-user-pm2.js';
import { inspectUpdateInventory } from '../../cli/lib/product-update-inventory.js';

function frame(values) {
  const parts = values.map(value => Buffer.from(value));
  const result = Buffer.alloc(1 + parts.reduce((size, part) => size + 4 + part.length, 0));
  result[0] = 0x12;
  let at = 1;
  for (const part of parts) {
    result.writeUInt32BE(part.length, at); at += 4;
    part.copy(result, at); at += part.length;
  }
  return result;
}
function connection(t, respond) {
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.write = request => {
    assert.equal(request[0], 0x12);
    const size = request.readUInt32BE(1), body = JSON.parse(request.subarray(5, 5 + size).toString().slice(2));
    assert.deepEqual(body, { type: 'call', method: 'getMonitorData', args: [{}] });
    const id = request.subarray(9 + size).toString();
    respond(socket, id);
  };
  t.after(() => assert.equal(socket.destroyed, true));
  return { connectSocket: () => { queueMicrotask(() => socket.emit('connect')); return socket; }, timeoutMs: 10 };
}

test('empty stray inventory uses only read-only monitor RPC and handles split frames', async t => {
  const deps = connection(t, (socket, id) => {
    const response = frame(['j:' + JSON.stringify({ args: [[]] }), id]);
    for (const part of [response.subarray(0, 2), response.subarray(2, 6), response.subarray(6)]) socket.emit('data', part);
  });
  assert.equal(await inspectEmptyPm2Socket('/fixture/rpc.sock', deps), 'empty');
});

test('a live stray with any registrations is not rebuildable', async t => {
  const deps = connection(t, (socket, id) => socket.emit('data', frame(['j:' + JSON.stringify({ args: [[{ name: 'writer' }]] }), id])));
  assert.equal(await inspectEmptyPm2Socket('/fixture/rpc.sock', deps), 'populated');
});

for (const code of ['ENOENT', 'ENOTDIR', 'ECONNREFUSED', 'EACCES']) {
  test(`socket inspection fails safely on ${code}`, async t => {
    const deps = connection(t, socket => socket.emit('error', { code }));
    assert.equal(await inspectEmptyPm2Socket('/fixture/rpc.sock', deps), code === 'EACCES' ? 'ambiguous' : 'dead');
  });
}

for (const kind of ['correlation', 'invalid-json', 'error', 'null-error', 'shape', 'version', 'oversized', 'close', 'timeout']) {
  test(`a response with ${kind} cannot bless stray sockets`, async t => {
    const deps = connection(t, (socket, id) => {
      if (kind === 'timeout') return;
      if (kind === 'close') { socket.emit('close'); return; }
      if (kind === 'oversized') { socket.emit('data', Buffer.alloc(1024 * 1024 + 1)); return; }
      const value = kind === 'invalid-json' ? 'j:{' : 'j:' + JSON.stringify(kind === 'error' ? { error: 'no' } : kind === 'null-error' ? { error: null, args: [[]] } : kind === 'shape' ? { args: [] } : { args: [[]] });
      const response = frame([value, kind === 'correlation' ? 's:wrong' : id]);
      if (kind === 'version') response[0] = 0x22;
      socket.emit('data', response);
    });
    assert.equal(await inspectEmptyPm2Socket('/fixture/rpc.sock', deps), 'ambiguous');
  });
}

function artifacts(t) {
  const root = mkdtempSync('/private/tmp/h23-junk-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'runtime/user/.pm2');
  mkdirSync(directory, { recursive: true });
  for (const file of ['rpc.sock', 'pub.sock', 'dump.pm2']) writeFileSync(join(directory, file), file === 'dump.pm2' ? '[]' : 'fixture');
  const calls = [];
  // File-type and RPC adapters represent sockets without binding in the sandbox.
  const deps = { lstat: () => ({ isSocket: () => true }), inspectSocket: async path => { calls.push(path); return 'empty'; } };
  return { root, directory, deps, calls };
}

test('an empty unowned role-home daemon is rebuildable without stopping or deleting it', async t => {
  const f = artifacts(t);
  assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: true, status: 'empty' });
  assert.deepEqual(f.calls, [join(f.directory, 'rpc.sock')]);
  assert.equal(await inspectEmptyPm2Socket('/fixture', { connectSocket: () => { throw new Error('denied'); } }), 'ambiguous');
});

test('both stray sockets must be dead; stale empty dump data grants no authority', async t => {
  const f = artifacts(t);
  f.deps.inspectSocket = async path => { f.calls.push(path); return 'dead'; };
  assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: true, status: 'dead' });
  assert.deepEqual(f.calls, [join(f.directory, 'rpc.sock'), join(f.directory, 'pub.sock')]);
  for (const pub of ['empty', 'populated', 'ambiguous']) {
    f.deps.inspectSocket = async path => path.endsWith('/rpc.sock') ? 'dead' : pub;
    assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: false });
  }
  f.deps.inspectSocket = async () => 'populated';
  assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: false });
});

test('claimed supervisors and non-socket artifacts are refused before any query', async t => {
  const f = artifacts(t);
  f.deps.lstat = () => ({ isSocket: () => false });
  assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: false });
  f.deps.lstat = () => ({ isSocket: () => true });
  writeFileSync(join(f.directory, 'supervisor-owner.json'), '{}');
  assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: false });
  assert.deepEqual(f.calls, []);
});

test('a role-home symlink is never followed to probe external sockets', async t => {
  const f = artifacts(t);
  rmSync(join(f.root, 'runtime/user'), { recursive: true });
  const external = join(f.root, 'elsewhere');
  mkdirSync(join(external, '.pm2'), { recursive: true });
  symlinkSync(external, join(f.root, 'runtime/user'));
  assert.deepEqual(await inspectUserPm2Artifacts(f.root, f.deps), { rebuildable: false });
  assert.deepEqual(f.calls, []);
});

test('update inventory accepts only the verified empty stray endpoints and preserves their files', async t => {
  const f = artifacts(t), lstat = fs.lstatSync, readdir = fs.readdirSync;
  const deps = connection(t, (socket, id) => socket.emit('data', frame(['j:' + JSON.stringify({ args: [[]] }), id])));
  const files = ['rpc.sock', 'pub.sock', 'other.sock'];
  writeFileSync(join(f.directory, 'other.sock'), 'unknown socket fixture');
  const before = files.map(name => fs.readFileSync(join(f.directory, name), 'utf8'));
  // Narrow OS adapters model only this fixture's socket metadata and RPC.
  // All inventory traversal, scope checks, and refusal rules run unchanged.
  t.mock.method(fs, 'lstatSync', path => {
    const stat = lstat(path);
    if (files.some(name => path === join(f.directory, name))) {
      stat.isFile = () => false; stat.isSocket = () => true;
    }
    return stat;
  });
  t.mock.method(fs, 'readdirSync', (path, options) => {
    const entries = readdir(path, options);
    if (path === f.directory && options?.withFileTypes) for (const entry of entries) {
      if (files.includes(entry.name)) { entry.isFile = () => false; entry.isSocket = () => true; }
    }
    return entries;
  });
  t.mock.method(net, 'connect', path => {
    assert.equal(path, join(f.directory, 'rpc.sock'));
    return deps.connectSocket();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await inspectUpdateInventory(f.root);
  assert(result.warnings.some(item => item.code === 'rebuildable_user_pm2'));
  assert.deepEqual(result.reasons.filter(item => item.code === 'unknown_state').map(item => item.path), ['runtime/user/.pm2/other.sock']);
  assert.deepEqual(files.map(name => fs.readFileSync(join(f.directory, name), 'utf8')), before);
});
