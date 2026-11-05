'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const server = readFileSync('instances/jerry/scripts/empire-server.py', 'utf8');
const dashboard = readFileSync('instances/jerry/scripts/card-flip-dashboard.html', 'utf8');

test('dashboard scan-now route is implemented by empire server', () => {
  assert.match(dashboard, /apiPost\('\/api\/card-scanner\/scan'/);
  assert.match(server, /\/api\/card-scanner\/scan/);
  assert.match(server, /sync-pi-card-state\.py/);
});

test('legacy card-scan route remains available as a compatibility alias', () => {
  assert.match(server, /\/api\/card-scan/);
});

test('oracle supports documented GET route and normalizes UI fields', () => {
  assert.match(server, /def do_GET\(self\):/);
  assert.match(server, /\/api\/card-oracle/);
  assert.match(server, /clean_range/);
  assert.match(server, /comps_used/);
});

test('watchlist supports settings route and delete by card name', () => {
  assert.match(server, /\/api\/card-watchlist\/settings/);
  assert.match(server, /query.*card|card.*query/s);
});

test('trusted network check uses real Tailscale CGNAT CIDR, not prefix matching', () => {
  assert.match(server, /ipaddress/);
  assert.match(server, /100\.64\.0\.0\/10/);
  assert.doesNotMatch(server, /startswith\('100\.'\)/);
});

test('manual scan status is surfaced to the dashboard', () => {
  assert.match(server, /manual-scan-job\.json|pi-card-scanner-sync-status\.json/);
  assert.match(dashboard, /scan_job|sync_status|scanStatus/);
});
