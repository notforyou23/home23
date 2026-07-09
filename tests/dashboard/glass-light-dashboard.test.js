import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const HOME23_ROOT = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(HOME23_ROOT, relativePath), 'utf8');

const html = read('engine/src/dashboard/home23-dashboard.html');
const js = read('engine/src/dashboard/home23-dashboard.js');
const css = read('engine/src/dashboard/home23-dashboard.css');
const spec = read('docs/superpowers/specs/2026-07-09-glass-light-dashboard-integration-design.md');

function fragmentFromId(source, id, nextPattern) {
  const idIndex = source.indexOf(`id="${id}"`);
  assert.notEqual(idIndex, -1, `missing #${id}`);
  const start = source.lastIndexOf('<', idIndex);
  const next = source.indexOf(nextPattern, idIndex + id.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function cssValuePattern(value) {
  const escapedParts = value
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escapedParts.join('\\s*');
}

test('glass dashboard replaces the dark sidebar shell with the complete top navigation', () => {
  assert.match(html, /class="h23-topbar"/);
  assert.doesNotMatch(html, /class="h23-sidebar"/);
  assert.doesNotMatch(html, /class="h23-system-rail"/);

  for (const label of ['Home', 'Agency', 'Briefs', 'Workers', 'Query', 'Brain Map']) {
    assert.match(html, new RegExp(`data-tab-label="${label}"`));
  }
  assert.match(html, /href="\/home23\/chat"[^>]*data-scope-tab="chat"[^>]*data-tab-label="Chat"/);
  assert.match(html, /id="settings-btn"[^>]*data-scope-tab="settings"[^>]*data-tab-label="Settings"/);
  assert.match(html, /id="cosmo23-btn"[^>]*data-scope-tab="cosmo23"[^>]*data-tab-label="cosmo23"/);
  assert.match(html, /id="evobrew-btn"[^>]*data-scope-tab="evobrew"[^>]*data-tab-label="evobrew"/);
});

test('Home uses the approved fixed hero, sensor strip, and chat-first hierarchy', () => {
  assert.match(html, /class="h23-human-hero-copy"/);
  assert.match(html, /class="h23-human-sensor-strip"/);
  assert.match(html, /class="h23-human-main-grid"/);
  assert.match(html, /data-home-sensor-layout="true"/);

  for (const id of ['outside-weather', 'sauna-control', 'pool-screenlogic']) {
    assert.match(html, new RegExp(`data-home-tile-id="${id}"`));
  }
  for (const id of ['chat', 'vibe', 'good-life', 'system-summary']) {
    assert.doesNotMatch(html, new RegExp(`data-home-tile-id="${id}"`));
  }
});

test('the redesign preserves production chat, operator, COSMO, and Brain Map hooks', () => {
  for (const id of [
    'chat-shared-template', 'chat-slot-tile', 'chat-slot-overlay',
    'chat-attach-btn', 'chat-attach-input', 'chat-conv-panel',
    'problems-overlay', 'goodlife-overlay', 'brain-storage-overlay',
    'home-vibe-detail-modal', 'chat-overlay', 'problem-editor-overlay',
    'cosmo23-frame-wrap', 'brain-map-container',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  for (const fn of [
    'renderProblemsList', 'renderBrainStoragePanel', 'openGoodLifeOperator',
    'setSaunaPreset', 'runHumanSaunaAction', 'showCosmoFrame',
  ]) assert.match(js, new RegExp(`function ${fn}\\b`));
});

test('the approved redesign boundary excludes server, settings API, and runtime state', () => {
  const expectedFiles = spec.match(/Expected production changes:\n\n([\s\S]*?)\n\nAvoid unless proven necessary:/)?.[1];
  assert.ok(expectedFiles, 'spec must retain an explicit expected-production-files section');

  for (const forbidden of [
    'engine/src/dashboard/server.js',
    'engine/src/dashboard/home23-settings-api.js',
    'engine/src/dashboard/home23-settings.js',
    'instances/',
    'config/',
    'ecosystem.config.cjs',
  ]) assert.doesNotMatch(expectedFiles, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Home layout persistence is scoped to environmental sensor cards', () => {
  assert.match(js, /HOME_LAYOUT_MANAGED_SENSOR_IDS/);
  assert.match(js, /outside-weather/);
  assert.match(js, /sauna-control/);
  assert.match(js, /pool-screenlogic/);
});

test('dashboard Settings is a read-only overview linked to the full control surface', () => {
  assert.match(html, /id="panel-settings"/);
  assert.match(js, /loadSettingsOverview/);

  const settingsPanel = fragmentFromId(html, 'panel-settings', '<div class="h23-panel"');
  for (const hash of ['agents', 'feeder', 'models', 'vibe']) {
    assert.match(settingsPanel, new RegExp(`href="/home23/settings#${hash}"`));
  }
  assert.doesNotMatch(settingsPanel, /<button\b[^>]*>\s*(?:Save|Start|Stop|Delete)\b/i);
});

test('all six dashboard overlays expose dialog semantics and unified keyboard lifecycle', () => {
  assert.match(js, /setupDashboardOverlayAccessibility/);
  assert.match(js, /closeTopmostDashboardOverlay/);

  for (const id of [
    'problems-overlay',
    'goodlife-overlay',
    'brain-storage-overlay',
    'home-vibe-detail-modal',
    'chat-overlay',
    'problem-editor-overlay',
  ]) {
    const overlay = fragmentFromId(html, id, '<!--');
    assert.match(overlay, /role="dialog"/, `${id} must expose role="dialog"`);
    assert.match(overlay, /aria-modal="true"/, `${id} must be modal`);
    assert.match(overlay, /aria-labelledby="[^"]+"/, `${id} must have a labelled title`);
  }

  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

test('dashboard installs the approved light-glass tokens and uses them on rendered surfaces', () => {
  const approvedTokens = {
    '--h23-bg': 'linear-gradient(160deg, #EAEEF4 0%, #E4EAF2 40%, #E9EDF0 100%)',
    '--h23-bg-wash-1': 'radial-gradient(900px 480px at 82% -8%, rgba(120, 170, 255, 0.16), transparent 60%)',
    '--h23-bg-wash-2': 'radial-gradient(700px 420px at 4% 108%, rgba(110, 210, 200, 0.13), transparent 60%)',
    '--h23-glass-card': 'rgba(255, 255, 255, 0.58)',
    '--h23-glass-panel': 'rgba(255, 255, 255, 0.62)',
    '--h23-glass-overlay': 'rgba(255, 255, 255, 0.9)',
    '--h23-glass-input': 'rgba(255, 255, 255, 0.85)',
    '--h23-glass-border': 'rgba(255, 255, 255, 0.9)',
    '--h23-glass-blur-card': '20px',
    '--h23-glass-blur-panel': '24px',
    '--h23-glass-blur-overlay': '30px',
    '--h23-shadow-card': '0 8px 32px rgba(30, 45, 70, 0.07)',
    '--h23-shadow-panel': '0 12px 44px rgba(30, 45, 70, 0.09)',
    '--h23-shadow-overlay': '0 32px 90px rgba(20, 30, 50, 0.28)',
    '--h23-shadow-pill': '0 2px 8px rgba(30, 45, 70, 0.08)',
    '--h23-shadow-accent-btn': '0 6px 18px rgba(62, 123, 224, 0.32)',
    '--h23-text-primary': '#1B2028',
    '--h23-text-body': '#333B48',
    '--h23-text-heading': '#232936',
    '--h23-text-secondary': '#5A6474',
    '--h23-text-muted': '#8A93A3',
    '--h23-accent': '#3E7BE0',
    '--h23-accent-tint': 'rgba(62, 123, 224, 0.1)',
    '--h23-accent-tint-border': 'rgba(62, 123, 224, 0.22)',
    '--h23-green': '#1E9E6F',
    '--h23-green-pulse': '#2EB88A',
    '--h23-amber': '#D9762B',
    '--h23-red': '#C94F4F',
    '--h23-text-muted-aa': '#697384',
    '--h23-green-aa': '#177F5B',
    '--h23-amber-aa': '#A9571C',
    '--h23-red-aa': '#B53F3F',
    '--h23-hairline': 'rgba(27, 32, 40, 0.07)',
    '--h23-input-border': 'rgba(27, 32, 40, 0.09)',
    '--h23-hover-row': 'rgba(27, 32, 40, 0.04)',
    '--h23-hover-card': 'rgba(255, 255, 255, 0.78)',
    '--h23-overlay-backdrop': 'rgba(30, 42, 64, 0.32)',
    '--h23-radius-pill': '999px',
    '--h23-radius-input': '14px',
    '--h23-radius-card': '16px',
    '--h23-radius-panel': '20px',
    '--h23-radius-overlay': '24px',
    '--h23-font-ui': "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    '--h23-font-mono': "'IBM Plex Mono', ui-monospace, monospace",
    '--h23-gutter': '24px',
    '--h23-gap': '16px',
    '--h23-card-pad': '22px 24px',
  };

  for (const [token, value] of Object.entries(approvedTokens)) {
    assert.match(css, new RegExp(`${token}:\\s*${cssValuePattern(value)}\\s*;`, 'i'), `missing ${token}`);
  }

  assert.match(html, /family=Instrument\+Sans:wght@400;500;600;700/);
  assert.match(css, /body\.h23-dashboard-page[\s\S]*background:\s*var\(--h23-bg\)/);
  assert.match(css, /\.h23-human-card[^\{]*\{[^}]*background:\s*var\(--h23-glass-card\)/);
  assert.match(css, /\.h23-topbar[^\{]*\{[^}]*background:\s*var\(--h23-glass-panel\)/);

  const dashboardScopedCss = css.slice(css.indexOf('body.h23-dashboard-page'));
  assert.doesNotMatch(dashboardScopedCss, /background-size:\s*88px 88px/);
  assert.doesNotMatch(dashboardScopedCss, /rgba\(255,\s*255,\s*255,\s*0\.025\) 1px/);
});
