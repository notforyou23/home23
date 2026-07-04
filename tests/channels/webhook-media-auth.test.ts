import test from 'node:test';
import assert from 'node:assert/strict';
import { WebhookServer } from '../../src/channels/webhooks.ts';

function makeReqRes(opts: { auth?: string; path?: unknown }) {
  const req = {
    headers: opts.auth ? { authorization: opts.auth } : {},
    query: { path: opts.path },
  } as any;
  const res: any = {
    statusCode: 200,
    body: null as unknown,
    sentFile: null as string | null,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    sendFile(p: string) { this.sentFile = p; return this; },
  };
  return { req, res };
}

function makeServer() {
  return new WebhookServer(
    { path: '/webhook', token: 'secret-token', mappings: [], sessionApi: { enabled: true } },
    async () => {},
  );
}

test('media endpoint rejects unauthenticated requests', () => {
  const server = makeServer() as any;
  const { req, res } = makeReqRes({ path: '/etc/passwd' });
  server.handleMedia(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.sentFile, null);
});

test('media endpoint rejects a wrong token', () => {
  const server = makeServer() as any;
  const { req, res } = makeReqRes({ auth: 'Bearer nope', path: '/tmp/x' });
  server.handleMedia(req, res);
  assert.equal(res.statusCode, 401);
});

test('media endpoint blocks paths outside the allowed roots even when authenticated', () => {
  const server = makeServer() as any;
  const { req, res } = makeReqRes({ auth: 'Bearer secret-token', path: '/etc/passwd' });
  server.handleMedia(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.sentFile, null);
});

test('media endpoint does not treat a sibling directory as inside the root', () => {
  const server = makeServer() as any;
  // A path that shares a string prefix with cwd but is a sibling directory
  // must not pass the containment check.
  const sibling = `${process.cwd()}-evil/secret.txt`;
  const { req, res } = makeReqRes({ auth: 'Bearer secret-token', path: sibling });
  server.handleMedia(req, res);
  assert.equal(res.statusCode, 403);
});
