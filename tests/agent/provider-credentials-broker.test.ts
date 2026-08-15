/**
 * The polled-not-triggered gap (2026-08-13).
 *
 * `force` re-read secrets.yaml, but secrets.yaml is only written by the
 * dashboard's 30-minute OAuth poller, and — per that poller's own comment —
 * its raw-token fetch is what triggers cosmo23's lazy re-mint. So between a
 * token expiring and the next poll, nobody had ASKED for a new one, and the
 * "fresh credential" retry re-read the identical dead token. Measured cost on
 * jerry's chain: 401 at 2026-08-13T17:11:43Z, next success 17:42:10Z — 31
 * minutes, exactly one poller cycle, one thought lost.
 *
 * These tests run against a STUB broker, never the live cosmo23, and never
 * print a credential value.
 *
 * The load-bearing test is the last one. This module exists to cure
 * credentials-frozen-by-value; a broker answer that outlived the file it
 * shadows would BE that disease wearing the cure's clothes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  refreshFromBroker, resolveProviderKey, _resetCredentialCache,
} from '../../src/agent/provider-credentials.js';

const FILE_TOKEN = 'sk-ant-oat-FILE-value';
const BROKER_TOKEN = 'sk-ant-oat-BROKER-value';

function secretsWith(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cred-broker-'));
  const p = join(dir, 'secrets.yaml');
  writeFileSync(p, `providers:\n  anthropic:\n    apiKey: ${token}\n`);
  return p;
}

async function withStubBroker(
  handler: (url: string) => { status: number; body: unknown },
  fn: () => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const r = handler(req.url ?? '');
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const priorPort = process.env['COSMO23_PORT'];
  process.env['COSMO23_PORT'] = String(port);
  try { await fn(); } finally {
    if (priorPort === undefined) delete process.env['COSMO23_PORT']; else process.env['COSMO23_PORT'] = priorPort;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('a 401 asks the broker, and the broker answer is used instead of the stale file', async () => {
  process.env['HOME23_SECRETS_PATH'] = secretsWith(FILE_TOKEN);
  _resetCredentialCache();
  assert.equal(resolveProviderKey('anthropic'), FILE_TOKEN, 'baseline: the file is authoritative');

  await withStubBroker(() => ({ status: 200, body: { token: BROKER_TOKEN } }), async () => {
    assert.equal(await refreshFromBroker('anthropic'), true);
    assert.equal(
      resolveProviderKey('anthropic', undefined, true), BROKER_TOKEN,
      'the retry must use what the broker just minted, not the token that just 401ed',
    );
  });
});

test('THE ANTI-FREEZE PROPERTY: once the poller writes the file, the file wins again', async () => {
  const path = secretsWith(FILE_TOKEN);
  process.env['HOME23_SECRETS_PATH'] = path;
  _resetCredentialCache();

  await withStubBroker(() => ({ status: 200, body: { token: BROKER_TOKEN } }), async () => {
    await refreshFromBroker('anthropic');
    assert.equal(resolveProviderKey('anthropic', undefined, true), BROKER_TOKEN);

    // The poller catches up: secrets.yaml is rewritten, so its mtime is now
    // NEWER than the broker answer. The override must stop shadowing it — a
    // broker token that outlives its file is the frozen-credential disease
    // this whole module exists to cure.
    writeFileSync(path, `providers:\n  anthropic:\n    apiKey: ${FILE_TOKEN}\n`);
    const soon = (Date.now() + 5_000) / 1000;
    utimesSync(path, soon, soon);
    // Deliberately NO cache reset here: this proves the override yields to a
    // newer file, not that a cache flush happens to hide it.
    assert.equal(
      resolveProviderKey('anthropic', undefined, true), FILE_TOKEN,
      'the broker override must not outlive the file it shadows',
    );
  });
});

test('degraded-honest: an unreachable or unhelpful broker changes nothing', async () => {
  process.env['HOME23_SECRETS_PATH'] = secretsWith(FILE_TOKEN);
  _resetCredentialCache();

  // Unreachable: nothing listening on this port.
  const prior = process.env['COSMO23_PORT'];
  process.env['COSMO23_PORT'] = '1';
  assert.equal(await refreshFromBroker('anthropic', 500), false, 'must not throw, must not hang');
  assert.equal(resolveProviderKey('anthropic', undefined, true), FILE_TOKEN, 'behaviour identical to before this existed');
  if (prior === undefined) delete process.env['COSMO23_PORT']; else process.env['COSMO23_PORT'] = prior;

  // Reachable but refusing, and reachable but empty.
  await withStubBroker(() => ({ status: 503, body: {} }), async () => {
    assert.equal(await refreshFromBroker('anthropic'), false);
  });
  await withStubBroker(() => ({ status: 200, body: { token: '' } }), async () => {
    assert.equal(await refreshFromBroker('anthropic'), false);
  });
  assert.equal(resolveProviderKey('anthropic', undefined, true), FILE_TOKEN);
});

test('only cosmo23-brokered providers are asked — no stray fetch for static keys', async () => {
  process.env['HOME23_SECRETS_PATH'] = secretsWith(FILE_TOKEN);
  _resetCredentialCache();
  let asked = 0;
  await withStubBroker(() => { asked++; return { status: 200, body: { token: BROKER_TOKEN } }; }, async () => {
    assert.equal(await refreshFromBroker('xai'), false);
    assert.equal(await refreshFromBroker('ollama-cloud'), false);
    assert.equal(await refreshFromBroker('openai-codex'), false, 'codex refreshes through codex-auth.ts, not the polled file');
    assert.equal(asked, 0, 'a non-brokered provider must not generate a request at all');
    assert.equal(await refreshFromBroker('anthropic'), true);
    assert.equal(asked, 1);
  });
});

test('a pinned static (non-OAuth) key still wins — the deliberate exception is intact', async () => {
  process.env['HOME23_SECRETS_PATH'] = secretsWith(FILE_TOKEN);
  _resetCredentialCache();
  await withStubBroker(() => ({ status: 200, body: { token: BROKER_TOKEN } }), async () => {
    await refreshFromBroker('anthropic');
    assert.equal(
      resolveProviderKey('anthropic', 'sk-static-pinned-key', true), 'sk-static-pinned-key',
      'a deliberately pinned static key outranks both file and broker',
    );
  });
});
