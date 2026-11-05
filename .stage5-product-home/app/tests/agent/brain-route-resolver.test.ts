import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrainRoute } from '../../src/agent/brain-route-resolver.js';

describe('resolveBrainRoute', () => {
  it('returns brainRoute when cosmo23 lists a brain matching the agent name', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ brains: [
        { id: 'abc123', name: 'jerry', path: '/x/instances/jerry/brain' },
        { id: 'def456', name: 'coz', path: '/x/instances/coz/brain' },
      ]}),
    } as unknown as Response));

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 0 });
    assert.equal(route, 'http://localhost:43210/api/brain/abc123');
  });

  it('returns brainRoute when brain matches by path segment instead of name', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ brains: [
        { id: 'xyz789', name: 'cosmo', path: '/x/instances/jerry/brain' },
      ]}),
    } as unknown as Response));

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 0 });
    assert.equal(route, 'http://localhost:43210/api/brain/xyz789');
  });

  it('returns null when no brain matches', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ brains: [{ id: 'abc123', name: 'other', path: '/x/other/brain' }] }),
    } as unknown as Response));

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 0 });
    assert.equal(route, null);
  });

  it('retries on network failure up to the configured count', async () => {
    let attempts = 0;
    const fetchMock = mock.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ brains: [{ id: 'z1', name: 'jerry', path: '' }] }) } as unknown as Response;
    });

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 2, retryDelayMs: 0 });
    assert.equal(route, 'http://localhost:43210/api/brain/z1');
    assert.equal(attempts, 3);
  });

  it('returns null after retries exhausted', async () => {
    const fetchMock = mock.fn(async () => { throw new Error('ECONNREFUSED'); });
    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 2, retryDelayMs: 0 });
    assert.equal(route, null);
  });
});
