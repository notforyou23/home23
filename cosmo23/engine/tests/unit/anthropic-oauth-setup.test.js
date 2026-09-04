'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const oauth = require('../../src/services/anthropic-oauth-engine');
const { encryptApiKey } = require('../../src/services/encryption');

const SETUP_TOKEN = 'sk-ant-oauth-setup-live-login';
const ENV_REVOKED = 'sk-ant-oauth-pm2-revoked';
const ENCRYPTION_KEY = 'ab'.repeat(32);

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      oauth._resetOAuthEngineForTests();
    });
}

function writeSetupDb(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-setup-oauth-'));
  const dbPath = path.join(dir, 'database.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE SystemConfig (
      key TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL,
      expiresAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const encrypted = encryptApiKey(JSON.stringify({
    token,
    refreshToken: null,
    expiresAt: Date.now() + 60 * 60 * 1000,
    type: 'oauth'
  }));
  db.prepare('INSERT INTO SystemConfig (key, value) VALUES (?, ?)').run(oauth.OAUTH_DB_KEY, encrypted);
  db.close();
  return { dir, dbPath };
}

describe('Cosmo Setup OAuth wins over env', () => {
  afterEach(() => {
    oauth._resetOAuthEngineForTests();
  });

  it('selects Setup over a different PM2 env token', () => {
    expect(oauth.selectAnthropicCredentialSource({
      setup: { token: SETUP_TOKEN },
      env: { authToken: ENV_REVOKED, isOAuth: true, source: 'env' }
    })).to.equal('setup');
  });

  it('uses env only when Setup has no token', () => {
    expect(oauth.selectAnthropicCredentialSource({
      setup: null,
      env: { authToken: ENV_REVOKED, isOAuth: true, source: 'env' }
    })).to.equal('env');
  });

  it('returns the Setup token when env ANTHROPIC_AUTH_TOKEN is a different revoked token', async () => {
    await withEnv({
      ANTHROPIC_AUTH_TOKEN: ENV_REVOKED,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_OAUTH_ONLY: 'true'
    }, async () => {
      oauth._setTokenReadersForTests({
        prisma: async () => ({ token: SETUP_TOKEN, refreshToken: null, expiresAt: Date.now() + 60000 }),
        sqlite: async () => null,
        server: async () => null
      });
      const credentials = await oauth.getAnthropicApiKey();
      expect(credentials.authToken).to.equal(SETUP_TOKEN);
      expect(credentials.authToken).to.not.equal(ENV_REVOKED);
      expect(credentials.source).to.equal('setup');
      expect(credentials.isOAuth).to.equal(true);
    });
  });

  it('reads SystemConfig sqlite + decrypt when Prisma fails with prisma generate', async () => {
    await withEnv({
      ENCRYPTION_KEY,
      ANTHROPIC_AUTH_TOKEN: ENV_REVOKED,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_OAUTH_ONLY: 'true'
    }, async () => {
      const { dir, dbPath } = writeSetupDb(SETUP_TOKEN);
      process.env.DATABASE_URL = `file:${dbPath}`;
      try {
        oauth._setTokenReadersForTests({
          prisma: async () => {
            throw new Error('prisma generate');
          },
          server: async () => null
        });
        const credentials = await oauth.getAnthropicApiKey();
        expect(credentials.authToken).to.equal(SETUP_TOKEN);
        expect(credentials.source).to.equal('setup');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
