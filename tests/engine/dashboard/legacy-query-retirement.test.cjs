'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const {
  createLegacyQueryRetirementRouter,
} = require('../../../engine/src/dashboard/legacy-query-retirement.js');

async function request(app, route, options = {}) {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
          redirect: 'manual',
          ...options,
        });
        const body = response.headers.get('content-type')?.includes('application/json')
          ? await response.json()
          : await response.text();
        server.close();
        resolve({
          status: response.status,
          location: response.headers.get('location'),
          body,
        });
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
}

test('legacy Query pages redirect to the canonical Home23 Query tab', async () => {
  const app = express();
  app.use(createLegacyQueryRetirementRouter());

  for (const route of ['/query', '/query.html']) {
    const response = await request(app, route);
    assert.equal(response.status, 308);
    assert.equal(response.location, '/home23#query');
  }
});

test('legacy Query and PGS APIs fail closed with the canonical replacement', async () => {
  const app = express();
  app.use(createLegacyQueryRetirementRouter());

  for (const [method, route] of [
    ['POST', '/api/query'],
    ['GET', '/api/query/models'],
    ['POST', '/api/query/followup'],
    ['POST', '/api/pgs'],
  ]) {
    const response = await request(app, route, { method });
    assert.equal(response.status, 410, `${method} ${route}`);
    assert.equal(response.body.error, 'legacy_query_api_retired');
    assert.equal(response.body.canonicalPage, '/home23#query');
    assert.equal(response.body.catalog, '/home23/api/query/catalog');
    assert.equal(response.body.run, '/home23/api/query/run');
  }
});

test('legacy dashboard navigation points to the canonical Query tab only', () => {
  for (const relative of [
    'engine/src/dashboard/legacy-dashboard.html',
    'engine/src/dashboard/runs.html',
    'engine/src/dashboard/intelligence.html',
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
    assert.doesNotMatch(source, /(?:href|location\.href)\s*=\s*["']\/query["']/, relative);
  }
  const intelligence = fs.readFileSync(
    path.join(process.cwd(), 'engine/src/dashboard/intelligence.html'),
    'utf8',
  );
  assert.doesNotMatch(intelligence, /data-tab=["']query["']/);
  assert.match(intelligence, /href=["']\/home23#query["']/);
});
