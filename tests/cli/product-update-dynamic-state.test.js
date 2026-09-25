import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { inspectUpdateInventory, ownedWriterNames } from '../../cli/lib/product-update-inventory.js';

function home(t) {
  // Keep the Unix-domain socket fixture below macOS's sockaddr_un limit.
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/h23dyn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function relevant(result, target) {
  return result.reasons.filter(item => item.path === target).map(item => item.code);
}

test('writer inventory includes optional Host roles without accepting saved arbitrary names', async t => {
  const root = home(t);
  const statePath = path.join(root, '.home23-host.json');
  const state = { schema: 'home23.host.v2', homeRoot: root, profile: { name: 'milo' }, desiredRunning: false };
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const fresh = await inspectUpdateInventory(root);
  assert(fresh.writers.includes('home23-milo-mcp'));
  assert(fresh.writers.includes('home23-milo-house-sense'));
  assert.equal(ownedWriterNames('milo/other'), null);
  fs.writeFileSync(statePath, JSON.stringify({ ...state,
    residentMap: { milo: { processNames: ['home23-milo', 'unrelated-writer'] } },
  }), { mode: 0o600 });
  const adopted = await inspectUpdateInventory(root);
  assert(adopted.writers.includes('home23-milo-mcp'));
  assert(!adopted.writers.includes('unrelated-writer'));
});

test('only the exact live coordination socket is accepted as ephemeral state', async t => {
  const root = home(t);
  const directory = path.join(root, 'app/instances/.house/coordination');
  fs.mkdirSync(directory, { recursive: true });
  const socket = path.join(directory, 'coord.sock');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(relevant(await inspectUpdateInventory(root), 'app/instances/.house/coordination/coord.sock'), []);

  const unexpected = path.join(directory, 'other.sock');
  const otherServer = createServer();
  await new Promise((resolve, reject) => { otherServer.once('error', reject); otherServer.listen(unexpected, resolve); });
  t.after(() => new Promise(resolve => otherServer.close(resolve)));
  assert.deepEqual(relevant(await inspectUpdateInventory(root), 'app/instances/.house/coordination/other.sock'), ['unknown_state']);
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(socket, 'not a socket');
  assert.deepEqual(relevant(await inspectUpdateInventory(root), 'app/instances/.house/coordination/coord.sock'), ['unknown_state']);
});

test('only owned PM2 sockets and the Chrome temporary singleton link are ephemeral', async t => {
  const root = home(t);
  const pm2 = path.join(root, 'runtime/pm2');
  fs.mkdirSync(pm2, { recursive: true });
  const servers = [];
  for (const name of ['pub.sock', 'rpc.sock', 'unrelated.sock']) {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(pm2, name), resolve); });
    servers.push(server);
  }
  t.after(() => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));
  for (const name of ['pub.sock', 'rpc.sock'])
    assert.deepEqual(relevant(await inspectUpdateInventory(root), `runtime/pm2/${name}`), []);
  assert.deepEqual(relevant(await inspectUpdateInventory(root), 'runtime/pm2/unrelated.sock'), ['unknown_state']);

  const relative = 'runtime/user/.home23/chrome-cdp/SingletonSocket';
  const singleton = path.join(root, relative);
  fs.mkdirSync(path.dirname(singleton), { recursive: true });
  fs.symlinkSync('/var/folders/aa/bb/T/com.google.Chrome.Test123/SingletonSocket', singleton);
  assert.deepEqual(relevant(await inspectUpdateInventory(root), relative), []);
  fs.unlinkSync(singleton);
  fs.symlinkSync('/var/folders/aa/bb/T/com.google.Chrome.Test123/other.sock', singleton);
  assert.deepEqual(relevant(await inspectUpdateInventory(root), relative), ['linked_state_path']);
  fs.unlinkSync(singleton);
  fs.writeFileSync(singleton, 'not a link');
  assert.deepEqual(relevant(await inspectUpdateInventory(root), relative), ['linked_state_path']);
});

test('reviewed internal insight pointer may rotate only to a real same-directory report', async t => {
  const root = home(t);
  const relative = 'app/instances/milo/brain/coordinator/insights_curated_LATEST.md';
  const directory = path.dirname(path.join(root, relative));
  fs.mkdirSync(directory, { recursive: true });
  const old = path.join(directory, 'insights_curated_cycle_1_2026-09-22.md');
  const next = 'insights_curated_cycle_2_2026-09-23.md';
  fs.writeFileSync(old, 'previous report');
  fs.writeFileSync(path.join(directory, next), 'next report');
  const receipt = path.join(root, 'runtime/adoption-preservation.json');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'home23.adoption-preservation-receipt.v1',
    links: [{ path: relative, kind: 'retain-link', target: old }] }), { mode: 0o600 });
  const pointer = path.join(root, relative);
  fs.symlinkSync(next, pointer);
  const accepted = await inspectUpdateInventory(root);
  assert.deepEqual(relevant(accepted, relative), []);

  fs.unlinkSync(pointer);
  const external = path.join(root, 'outside.md');
  fs.writeFileSync(external, 'outside');
  fs.symlinkSync(external, pointer);
  assert(relevant(await inspectUpdateInventory(root), relative).includes('linked_state_changed'));

  fs.unlinkSync(pointer);
  const indirect = 'insights_curated_cycle_3_2026-09-23.md';
  fs.symlinkSync(external, path.join(directory, indirect));
  fs.symlinkSync(indirect, pointer);
  assert(relevant(await inspectUpdateInventory(root), relative).includes('linked_state_changed'));

  fs.unlinkSync(pointer);
  fs.symlinkSync(next, pointer);
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'home23.adoption-preservation-receipt.v1',
    links: [{ path: relative, kind: 'retain-authority', target: old }] }), { mode: 0o600 });
  assert(relevant(await inspectUpdateInventory(root), relative).includes('linked_state_changed'));

  fs.writeFileSync(receipt, JSON.stringify({ schema: 'home23.adoption-preservation-receipt.v1',
    links: [{ path: relative, kind: 'retain-link', target: external }] }), { mode: 0o600 });
  assert(relevant(await inspectUpdateInventory(root), relative).includes('linked_state_changed'));
});

test('Finder and other OS metadata is ignorable at any depth while real unknown files are named', async t => {
  const root = home(t);
  const installed = { files: ['app', 'app/cli', 'app/cli/lib', 'app/config', 'tools', 'tools/node_modules']
    .map(relative => ({ path: relative, type: 'directory', mode: 0o755 })) };
  for (const relative of ['.DS_Store', 'app/.DS_Store', 'app/config/.DS_Store', 'app/cli/lib/.DS_Store', 'app/cli/._home23.js',
    'tools/node_modules/Thumbs.db', 'app/desktop.ini', '.Spotlight-V100/Store-V2/index', '.fseventsd/fseventsd-uuid',
    '.Trashes/501/old.txt', '.TemporaryItems/folders.501', 'app/instances/milo/.DS_Store']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), 'desktop metadata');
  }
  fs.writeFileSync(path.join(root, 'app/config/home.yaml'), 'home: {}\n');
  const clean = await inspectUpdateInventory(root, { installed });
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.complete, true);

  fs.writeFileSync(path.join(root, 'app/config/home.yaml.bak'), 'owner: backup');
  const refused = await inspectUpdateInventory(root, { installed });
  assert.deepEqual(refused.reasons.map(item => [item.code, item.path]), [['unknown_state', 'app/config/home.yaml.bak']]);
  assert.match(refused.reasons[0].message, /app\/config\/home\.yaml\.bak/);
});

test('unclassified path reasons are bounded to ten named paths plus a remainder count', async t => {
  const root = home(t);
  for (let index = 0; index < 12; index += 1) fs.writeFileSync(path.join(root, `stray-${String(index).padStart(2, '0')}.bin`), 'stray');
  const unknown = (await inspectUpdateInventory(root)).reasons.filter(item => item.code === 'unknown_state');
  assert.deepEqual(unknown.slice(0, 10).map(item => item.path), Array.from({ length: 10 }, (_, index) => `stray-${String(index).padStart(2, '0')}.bin`));
  assert.equal(unknown.length, 11);
  assert.equal(unknown[10].path, undefined);
  assert.equal(unknown[10].omitted, 2);
  assert.match(unknown[10].message, /2 more unclassified paths/);
});
