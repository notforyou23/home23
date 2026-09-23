import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDeviceConnectionStatus, enableDeviceConnection } from '../../cli/lib/product-device-connection.js';

function fixture(t, { installed = true, running = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-device-connect-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homeRoot = join(root, 'home');
  mkdirSync(homeRoot);
  if (installed) {
    writeFileSync(join(homeRoot, '.home23-install.json'), JSON.stringify({
      schema: 'home23.product-install.v1', status: 'installed', homeRoot, appRoot: join(homeRoot, 'app'),
    }), { mode: 0o600 });
    writeFileSync(join(homeRoot, '.home23-host.json'), JSON.stringify({
      schema: 'home23.host.v2', homeRoot, desiredRunning: running,
      ports: { coordination: 31000, engine: 31001, dashboard: 31002, mcp: 31003,
        bridge: 31004, evobrew: 31005, observatory: 31006 },
    }), { mode: 0o600 });
  }
  return homeRoot;
}

const domain = 'mac.example.ts.net';
const status = { BackendState: 'Running', Self: { Online: true, DNSName: `${domain}.` } };
const matching = { TCP: { 31000: { HTTPS: true } }, Web: { [`${domain}:31000`]: {
  Handlers: { '/': { Proxy: 'http://127.0.0.1:31000' } },
} } };
function deps(serve, { probe = true, failure } = {}) {
  const calls = [];
  let current = serve;
  return {
    calls,
    clientPath: '/opt/homebrew/bin/tailscale',
    runClient: async (_path, args) => {
      calls.push(args);
      if (args[0] === 'status') return { stdout: JSON.stringify(status) };
      if (args[1] === 'status') return { stdout: JSON.stringify(current) };
      if (failure) throw failure;
      current = matching;
      return { stdout: 'configured' };
    },
    request: async () => probe ? { ok: true, json: async () => ({ pairingAvailable: true, capabilities: { bootstrap: true, messageSubmission: true } }) }
      : { ok: false },
  };
}

test('only an exact readback and HTTPS capability probe reveals an address', async t => {
  const homeRoot = fixture(t);
  const d = deps(matching);
  assert.deepEqual(await getDeviceConnectionStatus({ homeRoot }, d), {
    ok: true, state: 'ready', message: 'Use this secure address in Home23 on your iPhone or iPad.',
    address: `https://${domain}:31000`,
  });
  assert.equal(d.calls.length, 2);
  const noProbe = await getDeviceConnectionStatus({ homeRoot }, deps(matching, { probe: false }));
  assert.equal(noProbe.state, 'unavailable');
  assert.equal('address' in noProbe, false);
});

test('explicit setup uses only the saved port and rechecks before revealing address', async t => {
  const homeRoot = fixture(t);
  const d = deps({});
  const before = await getDeviceConnectionStatus({ homeRoot }, d);
  assert.equal(before.state, 'needsSetup');
  assert.equal(d.calls.length, 2);
  const after = await enableDeviceConnection({ homeRoot }, d);
  assert.equal(after.state, 'ready');
  assert.deepEqual(d.calls[4], ['serve', '--bg', '--https=31000', '--yes', 'http://127.0.0.1:31000']);
});

test('refuses occupied and public routes without changing Tailscale', async t => {
  const homeRoot = fixture(t);
  for (const serve of [
    { TCP: { 31000: { HTTPS: true } }, Web: { [`${domain}:31000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
    { ...matching, AllowFunnel: { [`${domain}:31000`]: true } },
    { Foreground: { otherSession: { TCP: { 31000: { HTTPS: true } }, Web: { [`${domain}:31000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } } },
    { TCP: { 31000: { HTTP: true } } },
  ]) {
    const d = deps(serve);
    const output = await enableDeviceConnection({ homeRoot }, d);
    assert.equal(output.state, 'unavailable');
    assert.equal('address' in output, false);
    assert.equal(d.calls.length, 2);
  }
});

test('an unrelated JSON response never becomes a shareable Home23 address', async t => {
  const homeRoot = fixture(t);
  const d = deps(matching);
  d.request = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  const output = await getDeviceConnectionStatus({ homeRoot }, d);
  assert.equal(output.state, 'unavailable');
  assert.equal('address' in output, false);
});

test('uninstalled or stopped home cannot mutate a Serve route', async t => {
  for (const options of [{ installed: false }, { running: false }]) {
    const homeRoot = fixture(t, options);
    const d = deps({});
    assert.equal((await enableDeviceConnection({ homeRoot }, d)).state, 'needsSetup');
    assert.equal(d.calls.length, 0);
  }
});

test('official approval link is shown but never a guessed address', async t => {
  const homeRoot = fixture(t);
  const d = deps({}, { failure: { stderr: 'Approve at https://login.tailscale.com/a/abc123\n' } });
  const output = await enableDeviceConnection({ homeRoot }, d);
  assert.equal(output.state, 'needsApproval');
  assert.equal(output.approvalURL, 'https://login.tailscale.com/a/abc123');
  assert.equal('address' in output, false);
});

test('missing client and signed-out client give setup guidance without a route', async t => {
  const homeRoot = fixture(t);
  assert.equal((await getDeviceConnectionStatus({ homeRoot }, { clientPath: null })).state, 'missingClient');
  const signedOut = deps({});
  signedOut.runClient = async () => ({ stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) });
  const output = await enableDeviceConnection({ homeRoot }, signedOut);
  assert.equal(output.state, 'notSignedIn');
  assert.equal('address' in output, false);
});

test('a successful Serve command without persistent readback remains setup', async t => {
  const homeRoot = fixture(t);
  const d = deps({});
  d.runClient = async (_path, args) => {
    d.calls.push(args);
    if (args[0] === 'status') return { stdout: JSON.stringify(status) };
    if (args[1] === 'status') return { stdout: '{}' };
    return { stdout: 'configured' };
  };
  const output = await enableDeviceConnection({ homeRoot }, d);
  assert.equal(output.state, 'needsSetup');
  assert.equal('address' in output, false);
});
