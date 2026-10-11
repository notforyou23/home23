const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gunzipSync } = require('node:zlib');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-inbox-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rows(file, compressed = false) {
  const bytes = fs.readFileSync(file);
  return (compressed ? gunzipSync(bytes) : bytes).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('inbox rotation defaults to 64 MiB and three gzip segments', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t) });
  assert.deepEqual(store.persistence, { enabled: true, maxBytes: 64 * 1024 * 1024, keep: 3 });
});

test('mixed synchronous and asynchronous inbox writes preserve submission order across rotation', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t), persistence: { maxBytes: 1, keep: 30 } });
  const pending = [];
  for (let id = 0; id < 20; id += 1) {
    if (id % 3 === 2) assert.deepEqual(store.appendInbox({ id }), { id });
    else pending.push(store.appendInboxAsync({ id }));
  }
  await Promise.all(pending);
  await store.inboxWriteChain;
  const persisted = [];
  for (let index = 30; index >= 1; index -= 1) {
    if (fs.existsSync(`${store.inboxPath}.${index}.gz`)) persisted.push(...rows(`${store.inboxPath}.${index}.gz`, true));
  }
  persisted.push(...rows(store.inboxPath));
  assert.deepEqual(persisted.map(row => row.id), Array.from({ length: 20 }, (_, id) => id));
  assert.equal(store.pendingInboxWrites.size, 0);
  assert.deepEqual(store.listInbox(), [{ id: 19 }]);
  assert.equal(store.countInboxLines(), 1);
});

test('inbox rotation retains only the newest configured gzip segments and refreshes active readers', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t), persistence: { maxBytes: 1, keep: 3 } });
  for (let id = 0; id < 6; id += 1) {
    store.appendInbox({ id });
    assert.equal(store.countInboxLines(), 1);
  }
  assert.deepEqual(store.listInbox(), [{ id: 5 }]);
  assert.deepEqual(rows(`${store.inboxPath}.1.gz`, true), [{ id: 4 }]);
  assert.deepEqual(rows(`${store.inboxPath}.2.gz`, true), [{ id: 3 }]);
  assert.deepEqual(rows(`${store.inboxPath}.3.gz`, true), [{ id: 2 }]);
  assert.equal(fs.existsSync(`${store.inboxPath}.4.gz`), false);
});

test('inbox count discards its cached prefix after rotation to a larger active record', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t), persistence: { maxBytes: 1 } });
  store.appendInbox({ id: 'a' });
  assert.equal(store.countInboxLines(), 1);
  await store.appendInboxAsync({ id: 'b', long: 'x'.repeat(100) });
  assert.equal(store.countInboxLines(), 1);
  assert.equal(store.listInbox().length, 1);
});

test('oversized inbox data is unchanged at startup and preserved on the next append', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const brainDir = directory(t);
  const file = path.join(brainDir, 'agency', 'inbox.jsonl');
  fs.mkdirSync(path.dirname(file));
  // Larger than the synchronous compression chunk, with multibyte content.
  const old = `${JSON.stringify({ id: 'old', text: 'é'.repeat(600000) })}\n`;
  fs.writeFileSync(file, old);
  const store = new PursuitStore({ brainDir, persistence: { maxBytes: 32 } });
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  assert.equal(fs.existsSync(`${file}.1.gz`), false);
  await store.appendInboxAsync({ id: 'next' });
  assert.equal(gunzipSync(fs.readFileSync(`${file}.1.gz`)).toString('utf8'), old);
  assert.deepEqual(store.listInbox(), [{ id: 'next' }]);
});

test('disabled inbox rotation keeps all writes in the active file', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t), persistence: { enabled: false, maxBytes: 1 } });
  store.appendInbox({ id: 1 });
  await store.appendInboxAsync({ id: 2 });
  assert.deepEqual(rows(store.inboxPath), [{ id: 1 }, { id: 2 }]);
  assert.equal(fs.existsSync(`${store.inboxPath}.1.gz`), false);
});

test('failed inbox appends reject their callers while later writes remain usable', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t) });
  fs.unlinkSync(store.inboxPath);
  fs.mkdirSync(store.inboxPath);
  const pending = store.appendInboxAsync({ id: 'failed' });
  assert.throws(() => store.appendInbox({ id: 'also-failed' }));
  await assert.rejects(pending);
  fs.rmdirSync(store.inboxPath);
  await store.appendInboxAsync({ id: 'recovered' });
  assert.deepEqual(store.listInbox(), [{ id: 'recovered' }]);
});

test('failed inbox archive publication leaves old data available for a later retry', async t => {
  const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
  const store = new PursuitStore({ brainDir: directory(t), persistence: { maxBytes: 1 } });
  store.appendInbox({ id: 'old' });
  fs.mkdirSync(`${store.inboxPath}.3.gz`);
  await assert.rejects(store.appendInboxAsync({ id: 'next' }));
  assert.deepEqual(store.listInbox(), [{ id: 'old' }]);
  assert.equal(fs.readdirSync(store.dir).some(name => name.endsWith('.tmp')), false);
  fs.rmdirSync(`${store.inboxPath}.3.gz`);
  store.appendInbox({ id: 'next' });
  assert.deepEqual(rows(`${store.inboxPath}.1.gz`, true), [{ id: 'old' }]);
  assert.deepEqual(store.listInbox(), [{ id: 'next' }]);
});

for (const asyncWrite of [false, true]) {
  test(`failed archive directory sync preserves the active inbox (async=${asyncWrite})`, async t => {
    const { PursuitStore } = await import('../../../engine/src/agency/pursuit-store.js');
    const store = new PursuitStore({ brainDir: directory(t), persistence: { maxBytes: 1 } });
    store.appendInbox({ id: 'old' });
    const originalSync = fs.fsyncSync;
    let failNextDirectorySync = true;
    fs.fsyncSync = function (fd) {
      if (failNextDirectorySync && fs.fstatSync(fd).isDirectory()) {
        failNextDirectorySync = false;
        throw new Error('injected directory sync failure');
      }
      return originalSync.call(this, fd);
    };
    t.after(() => { fs.fsyncSync = originalSync; });
    if (asyncWrite) await assert.rejects(store.appendInboxAsync({ id: 'next' }), /directory sync failure/);
    else assert.throws(() => store.appendInbox({ id: 'next' }), /directory sync failure/);
    assert.deepEqual(store.listInbox(), [{ id: 'old' }]);
    assert.deepEqual(rows(`${store.inboxPath}.1.gz`, true), [{ id: 'old' }]);
    await store.appendInboxAsync({ id: 'next' });
    assert.deepEqual(store.listInbox(), [{ id: 'next' }]);
    assert.deepEqual(rows(`${store.inboxPath}.1.gz`, true), [{ id: 'old' }]);
  });
}
