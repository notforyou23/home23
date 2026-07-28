'use strict';

// Regression guard for the 2026-07-27 Codex outage post-mortem.
//
// startCallbackServer bound the loopback callback port and only ever closed it
// on the two paths that received a request. A flow the user abandoned — or one
// the dashboard gave up on, which it always did, since it aborted at 15s and no
// human finishes browser OAuth that fast — left the listener bound for the life
// of the cosmo23 process. Every later "Sign in with OpenAI" then failed with
// EADDRINUSE, so the fallback was permanently dead exactly when the token
// refresh path had also died.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { startCallbackServer } = require('../../cosmo23/lib/oauth-codex.cjs');

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// The port is only truly released if something else can bind it afterwards.
async function assertPortFree(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', err => reject(new Error(`port ${port} still bound: ${err.code}`)));
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}

test('callback server releases the port when the user never completes the flow', async () => {
  const port = await freePort();

  await assert.rejects(
    startCallbackServer('expected-state', { port, timeoutMs: 150 }),
    /timed out/i,
  );

  await assertPortFree(port);
});

test('callback server releases the port when the state does not match', async () => {
  const port = await freePort();
  const pending = startCallbackServer('expected-state', { port, timeoutMs: 5000 });
  // Attach the rejection handler before triggering it, or the rejection lands
  // unhandled while the fetch below is still in flight.
  const rejected = assert.rejects(pending, /state mismatch/i);

  await new Promise(resolve => setTimeout(resolve, 50));
  const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=wrong-state`);
  assert.equal(res.status, 400);

  await rejected;
  await assertPortFree(port);
});

test('callback server returns the code and releases the port on success', async () => {
  const port = await freePort();
  const pending = startCallbackServer('expected-state', { port, timeoutMs: 5000 });

  await new Promise(resolve => setTimeout(resolve, 50));
  const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=expected-state`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Authentication Successful/i);

  assert.equal(await pending, 'the-code');
  await assertPortFree(port);
});

test('a second concurrent attempt fails fast instead of hijacking the flow', async () => {
  const port = await freePort();
  const first = startCallbackServer('expected-state', { port, timeoutMs: 400 });

  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(
    startCallbackServer('other-state', { port, timeoutMs: 400 }),
    /already in use/i,
  );

  // The loser must not tear down the winner's listener.
  const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=c1&state=expected-state`);
  assert.equal(res.status, 200);
  assert.equal(await first, 'c1');
  await assertPortFree(port);
});

test('a served request does not leave a keep-alive connection holding the port', async () => {
  const port = await freePort();
  const pending = startCallbackServer('expected-state', { port, timeoutMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 50));

  // A keep-alive agent is what a real browser uses; server.close() alone waits
  // on those sockets forever.
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/auth/callback?code=ka&state=expected-state',
      agent,
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
  });

  assert.equal(await pending, 'ka');
  await assertPortFree(port);
  agent.destroy();
});
