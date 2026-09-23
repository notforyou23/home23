import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { inspectUpdateInventory } from '../../cli/lib/product-update-inventory.js';

function home(t) {
  // Keep the Unix-domain socket fixture below macOS's sockaddr_un limit.
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/h23dyn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function relevant(result, target) {
  return result.reasons.filter(item => item.path === target).map(item => item.code);
}

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
