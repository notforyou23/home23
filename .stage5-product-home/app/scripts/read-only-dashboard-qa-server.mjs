#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_DASHBOARD_ROOT = path.join(REPO_ROOT, 'engine', 'src', 'dashboard');
const require = createRequire(import.meta.url);

const PAGE_ROUTES = new Map([
  ['/home23', 'home23-dashboard.html'],
  ['/home23/settings', 'home23-settings.html'],
  ['/home23/setup', 'home23-settings.html'],
  ['/home23/chat', 'home23-chat.html'],
  ['/home23/vibe-gallery', 'home23-vibe/gallery.html'],
  ['/home23/welcome', 'home23-welcome.html'],
  ['/home23-welcome.html', 'home23-welcome.html'],
]);

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function localFileFor(requestPath, dashboardRoot) {
  const routed = PAGE_ROUTES.get(requestPath);
  const candidate = routed
    ? path.join(dashboardRoot, routed)
    : path.join(dashboardRoot, requestPath.replace(/^\/+/, ''));
  const normalized = path.resolve(candidate);
  if (normalized !== dashboardRoot && !normalized.startsWith(dashboardRoot + path.sep)) return null;
  try {
    return fs.statSync(normalized).isFile() ? normalized : null;
  } catch {
    return null;
  }
}

export function openInvariantFixture({ dashboardRoot = DEFAULT_DASHBOARD_ROOT } = {}) {
  const problem = {
    id: 'qa_fixture_open_invariant',
    claim: 'Synthetic invariant editor accessibility fixture',
    state: 'open',
    seedOrigin: 'qa-fixture',
    openedAt: '2026-07-10T00:00:00.000Z',
    firstSeenAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    lastCheckedAt: '2026-07-10T00:00:00.000Z',
    stepIndex: 0,
    escalated: true,
    verifier: {
      type: 'file_mtime',
      args: { path: '/tmp/home23-qa-fixture-never-read', maxAgeMin: 60 },
    },
    remediation: [{
      type: 'notify_jtr',
      args: { text: 'Synthetic read-only QA fixture; do not act.' },
      cooldownMin: 60,
    }],
    remediationLog: [],
    lastResult: {
      ok: false,
      detail: 'Synthetic failure for invariant-editor browser verification only',
      at: '2026-07-10T00:00:00.000Z',
    },
  };
  const operatorPath = path.join(dashboardRoot, 'good-life-operator.js');
  const { buildLiveProblemSnapshot } = require(operatorPath);
  const snapshot = buildLiveProblemSnapshot([problem], new Date('2026-07-10T00:05:00.000Z'));
  return {
    available: true,
    problems: [problem],
    snapshot,
    counts: snapshot.counts,
    qaFixture: {
      synthetic: true,
      mode: 'open-invariant',
      source: 'scripts/read-only-dashboard-qa-server.mjs',
      writesAllowed: false,
    },
  };
}

export function buildUpstreamTarget(requestUrl, upstreamUrl) {
  const target = new URL(upstreamUrl.href);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  return target;
}

export function createReadOnlyDashboardQaServer({
  dashboardRoot = DEFAULT_DASHBOARD_ROOT,
  upstream = 'http://127.0.0.1:5002',
  fixtureMode = '',
} = {}) {
  const resolvedDashboardRoot = path.resolve(dashboardRoot);
  const upstreamUrl = new URL(upstream);

  return http.createServer(async (req, res) => {
    res.setHeader('X-QA-Read-Only', 'true');

    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: 'GET, HEAD',
      });
      res.end(JSON.stringify({ ok: false, error: 'qa_server_is_read_only' }));
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'qa_invalid_url' }));
      return;
    }

    if (
      fixtureMode === 'open-invariant'
      && ['/api/live-problems', '/home23/api/live-problems'].includes(requestUrl.pathname)
    ) {
      const payload = openInvariantFixture({ dashboardRoot: resolvedDashboardRoot });
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'X-QA-Fixture': 'synthetic-open-invariant',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'qa_invalid_path' }));
      return;
    }

    const localFile = localFileFor(decodedPath, resolvedDashboardRoot);
    if (localFile) {
      const body = fs.readFileSync(localFile);
      res.writeHead(200, {
        'Content-Type': MIME.get(path.extname(localFile).toLowerCase()) || 'application/octet-stream',
        'Cache-Control': 'no-store, max-age=0',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    try {
      const target = buildUpstreamTarget(requestUrl, upstreamUrl);
      const response = await fetch(target, { method: req.method, redirect: 'manual' });
      const headers = {};
      for (const [name, value] of response.headers) {
        if (!['connection', 'content-encoding', 'content-length', 'keep-alive', 'transfer-encoding'].includes(name.toLowerCase())) {
          headers[name] = value;
        }
      }
      headers['Cache-Control'] = 'no-store, max-age=0';
      const body = req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, headers);
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        error: 'qa_upstream_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  });
}

function isDirectExecution() {
  return process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isDirectExecution()) {
  const port = Number(process.env.QA_PORT || 51923);
  const upstream = process.env.QA_UPSTREAM || 'http://127.0.0.1:5002';
  const fixtureMode = process.env.QA_FIXTURE || '';
  const dashboardRoot = process.env.QA_DASHBOARD_ROOT || DEFAULT_DASHBOARD_ROOT;
  const server = createReadOnlyDashboardQaServer({ dashboardRoot, upstream, fixtureMode });

  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
      kind: 'home23-read-only-qa',
      pid: process.pid,
      port,
      upstream: new URL(upstream).href,
      dashboardRoot: path.resolve(dashboardRoot),
      fixtureMode: fixtureMode || null,
    }));
  });
}
