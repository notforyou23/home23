/**
 * File-exchange lobe transport — the broker seam.
 *
 * What must hold: a request written by the Seed side is serviceable from its
 * file alone; a result delivered by the broker resolves the waiting call with
 * the REAL model receipt; a broker error surfaces as a throw (→ honest lobe
 * error receipt), never silence; an unserviced request is withdrawn on
 * timeout; stale orphan results get swept; malformed requests are rejected
 * loudly by the parser the broker uses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileLobeTransport,
  parseLobeRequest,
  formatLobeResult,
  requestsDir,
  resultsDir,
} from '../src/lobe-file-transport.js';
import type { ModelReceipt } from '../src/types.js';

const RECEIPT: ModelReceipt = {
  modelId: 'glm-5.2:cloud',
  provider: 'ollama-cloud',
  invokedAt: '2026-08-07T21:00:00.000Z',
  durationMs: 1234,
  tokensIn: 0,
  tokensOut: 0,
};

function freshExchange(): string {
  return mkdtempSync(join(tmpdir(), 'lobe-exchange-'));
}

/** Play the broker: wait for a request file, service it with `respond`. */
async function fakeBroker(exchangeDir: string, respond: (prompt: string) => Record<string, unknown>): Promise<void> {
  const reqDir = requestsDir(exchangeDir);
  for (let attempt = 0; attempt < 100; attempt++) {
    const names = readdirSync(reqDir).filter((n) => n.endsWith('.json'));
    const name = names[0];
    if (name !== undefined) {
      const request = parseLobeRequest(readFileSync(join(reqDir, name), 'utf-8'));
      const body = respond(request.prompt);
      writeFileSync(
        join(resultsDir(exchangeDir), `res-${request.id}.json`),
        formatLobeResult({ id: request.id, ...body }),
        'utf-8',
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('fake broker: no request appeared');
}

describe('file lobe transport', () => {
  it('round-trips: request file → broker result → resolved text + real receipt', async () => {
    const exchange = freshExchange();
    const transport = createFileLobeTransport(exchange, { pollMs: 25, timeoutMs: 5000 });
    const brokerDone = fakeBroker(exchange, (prompt) => {
      assert.ok(prompt.includes('ADMITTED CELLS') === false, 'raw prompt passes through untouched');
      return { text: '{"observations":[]}', modelReceipt: RECEIPT };
    });
    const outcome = await transport('what do you make of the weather?', {} as never);
    await brokerDone;
    assert.equal(outcome.text, '{"observations":[]}');
    assert.equal(outcome.modelReceipt.modelId, 'glm-5.2:cloud');
    // Exchange is clean afterwards — no request, no result left behind.
    assert.equal(readdirSync(requestsDir(exchange)).length, 0);
    assert.equal(readdirSync(resultsDir(exchange)).length, 0);
  });

  it('broker error result surfaces as a throw, never silence', async () => {
    const exchange = freshExchange();
    const transport = createFileLobeTransport(exchange, { pollMs: 25, timeoutMs: 5000 });
    const brokerDone = fakeBroker(exchange, () => ({ error: 'model exploded' }));
    await assert.rejects(() => transport('hello', {} as never), /broker: model exploded/);
    await brokerDone;
  });

  it('timeout withdraws the request so the broker never services a dead one', async () => {
    const exchange = freshExchange();
    const transport = createFileLobeTransport(exchange, { pollMs: 20, timeoutMs: 120 });
    await assert.rejects(() => transport('nobody home', {} as never), /no result within/);
    assert.equal(readdirSync(requestsDir(exchange)).length, 0, 'request withdrawn');
  });

  it('sweeps stale orphan results but leaves fresh ones', async () => {
    const exchange = freshExchange();
    const transport = createFileLobeTransport(exchange, { pollMs: 20, timeoutMs: 100 });
    const stale = join(resultsDir(exchange), 'res-req_dead_1.json');
    const fresh = join(resultsDir(exchange), 'res-req_alive_2.json');
    writeFileSync(stale, formatLobeResult({ id: 'req_dead_1', error: 'x' }), 'utf-8');
    writeFileSync(fresh, formatLobeResult({ id: 'req_alive_2', error: 'x' }), 'utf-8');
    const old = (Date.now() - 31 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    await assert.rejects(() => transport('trigger sweep', {} as never));
    assert.equal(existsSync(stale), false, 'stale orphan swept');
    assert.equal(existsSync(fresh), true, 'fresh result untouched');
  });

  it('parseLobeRequest rejects malformed requests loudly', () => {
    assert.throws(() => parseLobeRequest(JSON.stringify({ id: 'evil; rm -rf /', prompt: 'x', createdAt: 'now' })), /bad id/);
    assert.throws(() => parseLobeRequest(JSON.stringify({ id: 'req_abc_1', prompt: '', createdAt: 'now' })), /bad prompt/);
    assert.throws(() => parseLobeRequest(JSON.stringify({ id: 'req_abc_1', prompt: 'y'.repeat(70 * 1024), createdAt: 'now' })), /too large/);
    assert.throws(() => parseLobeRequest(JSON.stringify({ id: 'req_abc_1', prompt: 'x' })), /bad createdAt/);
    const good = parseLobeRequest(JSON.stringify({ id: 'req_abc_1', prompt: 'x', createdAt: '2026-08-07T21:00:00.000Z' }));
    assert.equal(good.id, 'req_abc_1');
  });
});
