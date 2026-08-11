/**
 * The harness and engine credential resolvers MUST agree. They are two
 * packages either side of an ESM/CJS boundary (root is "type": "module",
 * engine/package.json has no type), so the logic is deliberately duplicated
 * rather than shared — the same call this house already made for the
 * projection retina in semantic-projection-parity.test.ts. If you change one,
 * this test forces you to change both.
 *
 * What is pinned here is the RESOLUTION CONTRACT, because getting it wrong
 * does not throw — it silently hands a process a stale credential and the
 * failure shows up hours later as a dead fleet (2026-07-27, 2026-08-08/09).
 *
 * Two divergences are DELIBERATE and are asserted as such at the bottom. They
 * are not drift, and making them "symmetric" would be wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  resolveProviderKey as harnessResolve,
  freshProviderKey as harnessFresh,
  isAuthError as harnessIsAuthError,
  _resetCredentialCache as harnessReset,
} from '../../src/agent/provider-credentials.js';

const require = createRequire(import.meta.url);
const engine = require('../../engine/src/core/provider-credentials.js') as {
  resolveProviderKey: (p: string, configured?: string, force?: boolean) => string;
  freshProviderKey: (p: string, force?: boolean) => string;
  isAuthError: (e: unknown) => boolean;
  _resetCredentialCache: () => void;
};

/** Point BOTH resolvers at the same temp secrets file and clear both caches. */
function withSecrets(body: string | null, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cred-parity-'));
  const secretsPath = join(dir, 'secrets.yaml');
  if (body !== null) writeFileSync(secretsPath, body);
  const savedPath = process.env.HOME23_SECRETS_PATH;
  process.env.HOME23_SECRETS_PATH = secretsPath;
  harnessReset();
  engine._resetCredentialCache();
  try {
    fn();
  } finally {
    if (savedPath === undefined) delete process.env.HOME23_SECRETS_PATH;
    else process.env.HOME23_SECRETS_PATH = savedPath;
    harnessReset();
    engine._resetCredentialCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Both resolvers must return the SAME value for the same inputs. */
function assertSame(provider: string, configured: string | undefined, why: string): void {
  harnessReset();
  engine._resetCredentialCache();
  const h = harnessResolve(provider, configured);
  harnessReset();
  engine._resetCredentialCache();
  const e = engine.resolveProviderKey(provider, configured);
  assert.equal(h, e, `${why} — harness=${JSON.stringify(h)} engine=${JSON.stringify(e)}`);
}

const FILE = 'providers:\n'
  + '  anthropic:\n    apiKey: sk-ant-oat01-FILE\n'
  + '  openai:\n    apiKey: sk-proj-FILE\n'
  + '  xai:\n    apiKey: xai-FILE\n'
  + '  minimax:\n    apiKey: sk-cp-FILE\n'
  + '  ollama-cloud:\n    apiKey: olc-FILE\n';

test('a managed OAuth token resolves fresh from the file in BOTH packages', () => {
  withSecrets(FILE, () => {
    assertSame('anthropic', undefined, 'file value with nothing configured');
    assertSame('anthropic', 'sk-ant-oat01-STALE', 'file beats a stale configured OAuth token');
  });
});

test('a static configured key is a deliberate pin in BOTH packages', () => {
  withSecrets(FILE, () => {
    for (const [provider, pin] of [
      ['anthropic', 'sk-ant-api03-PINNED'],
      ['openai', 'sk-proj-PINNED'],
      ['xai', 'xai-PINNED'],
      ['minimax', 'sk-cp-PINNED'],
      ['ollama-cloud', 'olc-PINNED'],
    ] as const) {
      assertSame(provider, pin, `${provider} static pin is respected`);
      assertSame(provider, undefined, `${provider} unpinned falls to the file`);
    }
  });
});

test('the env floor serves both packages identically when the file is absent', () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
    'MINIMAX_API_KEY', 'OLLAMA_CLOUD_API_KEY']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    withSecrets(null, () => {
      assertSame('anthropic', undefined, 'no file, no env → empty');

      process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-ENV';
      assertSame('anthropic', undefined, 'ANTHROPIC_AUTH_TOKEN is the first floor');

      delete process.env.ANTHROPIC_AUTH_TOKEN;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-ENV';
      assertSame('anthropic', undefined, 'ANTHROPIC_API_KEY is the second floor');

      process.env.OPENAI_API_KEY = 'sk-proj-ENV';
      process.env.XAI_API_KEY = 'xai-ENV';
      process.env.MINIMAX_API_KEY = 'sk-cp-ENV';
      process.env.OLLAMA_CLOUD_API_KEY = 'olc-ENV';
      for (const p of ['openai', 'xai', 'minimax', 'ollama-cloud']) {
        assertSame(p, undefined, `${p} env floor`);
      }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('a missing secrets file reads as empty in both packages and never throws', () => {
  withSecrets(null, () => {
    assert.equal(harnessFresh('anthropic'), '');
    assert.equal(engine.freshProviderKey('anthropic'), '');
  });
});

test('force re-read sees a rotation immediately in both packages', () => {
  withSecrets(FILE, () => {
    assert.equal(harnessResolve('anthropic'), 'sk-ant-oat01-FILE');
    assert.equal(engine.resolveProviderKey('anthropic'), 'sk-ant-oat01-FILE');

    const rotated = 'providers:\n  anthropic:\n    apiKey: sk-ant-oat01-ROTATED\n';
    writeFileSync(process.env.HOME23_SECRETS_PATH as string, rotated);

    // Inside the 15s check window the cache still serves the old value...
    assert.equal(harnessResolve('anthropic'), 'sk-ant-oat01-FILE', 'harness caches');
    assert.equal(engine.resolveProviderKey('anthropic'), 'sk-ant-oat01-FILE', 'engine caches');
    // ...and force is the auth-failure escape hatch in both.
    assert.equal(harnessResolve('anthropic', undefined, true), 'sk-ant-oat01-ROTATED');
    assert.equal(engine.resolveProviderKey('anthropic', undefined, true), 'sk-ant-oat01-ROTATED');
  });
});

test('isAuthError classifies every real revocation shape the same way', () => {
  const cases: Array<[unknown, boolean, string]> = [
    [{ status: 401 }, true, 'SDK 401'],
    [{ status: 403 }, true, 'SDK 403'],
    [{ status: 500 }, false, 'server error is not auth'],
    [new Error('authentication_error: token bad'), true, 'anthropic body'],
    [new Error('OAuth access token has been revoked.'), true, 'revoked prose'],
    [new Error('{"error":{"code":"invalid_api_key"}}'), true, 'openai machine code'],
    [new Error('Invalid API key'), true, 'spaced prose'],
    [new Error('invalid-api-key'), true, 'hyphenated'],
    [new Error('OpenAI Codex 401: unauthorized'), true, 'bare 401 in text'],
    [new Error('rate limit exceeded'), false, 'rate limit is not auth'],
    [new Error('anthropic HTTP 500: overloaded'), false, 'overload is not auth'],
    [new Error('ECONNRESET'), false, 'transport is not auth'],
  ];
  for (const [err, expected, why] of cases) {
    assert.equal(harnessIsAuthError(err), expected, `harness: ${why}`);
    assert.equal(engine.isAuthError(err), expected, `engine: ${why}`);
  }
});

// ── Deliberate divergences ────────────────────────────────────────────────
// These are asserted so they cannot flip silently in either direction. Making
// them symmetric would be wrong, for the reasons stated.

test('DELIBERATE: only the engine treats a codex OAuth JWT as a managed token', () => {
  const jwt = (marker: string): string => {
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'none' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, sub: marker })}.sig`;
  };
  const fileToken = jwt('FILE');
  withSecrets(`providers:\n  openai-codex:\n    apiKey: ${fileToken}\n`, () => {
    const staleConfigured = jwt('STALE');

    // ENGINE: its codex path resolves the mirrored token out of secrets.yaml
    // (services/openai-codex-oauth-engine.js), so a configured JWT must be
    // treated as managed and yield to the file.
    assert.equal(engine.resolveProviderKey('openai-codex', staleConfigured), fileToken,
      'engine: codex JWT is managed, the file wins');

    // HARNESS: text-generation.ts returns early for openai-codex BEFORE the
    // resolver and delegates to codex-auth.ts, which owns its own OAuth store
    // (~/.evobrew/auth-profiles.json) with refresh. The resolver is never
    // asked about codex, so the managed rule would be dead code here — and a
    // configured value stays a pin, matching every other static key.
    assert.equal(harnessResolve('openai-codex', staleConfigured), staleConfigured,
      'harness: no codex rule, configured value is a pin');
  });
});

test('DELIBERATE: the engine env floor is a superset (groq, huggingface, codex)', () => {
  const saved = { g: process.env.GROQ_API_KEY, h: process.env.HF_TOKEN };
  process.env.GROQ_API_KEY = 'gsk-ENV';
  process.env.HF_TOKEN = 'hf-ENV';
  try {
    withSecrets(null, () => {
      // The engine serves these providers (unified-client builds groq/hf
      // clients); the harness does not, so it has no floor for them.
      assert.equal(engine.resolveProviderKey('groq'), 'gsk-ENV');
      assert.equal(engine.resolveProviderKey('huggingface'), 'hf-ENV');
      assert.equal(harnessResolve('groq'), '');
      assert.equal(harnessResolve('huggingface'), '');
    });
  } finally {
    if (saved.g === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved.g;
    if (saved.h === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = saved.h;
  }
});
