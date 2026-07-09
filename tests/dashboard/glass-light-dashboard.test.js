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

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseHtmlTree(source) {
  const root = { tag: '#document', attrs: new Map(), children: [], start: 0, end: source.length };
  const stack = [root];
  const tagPattern = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  let match;
  while ((match = tagPattern.exec(source))) {
    const rawTag = match[0];
    const tag = match[1].toLowerCase();
    if (rawTag.startsWith('</')) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag !== tag) continue;
        stack[index].end = tagPattern.lastIndex;
        stack.length = index;
        break;
      }
      continue;
    }

    const attrs = new Map();
    const attrSource = rawTag.slice(tag.length + 1, -1);
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrSource))) {
      attrs.set(attrMatch[1], attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '');
    }

    const node = {
      tag,
      attrs,
      children: [],
      parent: stack.at(-1),
      start: match.index,
      end: tagPattern.lastIndex,
    };
    stack.at(-1).children.push(node);
    if (!VOID_ELEMENTS.has(tag) && !rawTag.endsWith('/>')) stack.push(node);
  }
  for (const node of stack) node.end = source.length;
  return root;
}

function walk(node) {
  return [node, ...node.children.flatMap(walk)];
}

function hasClass(node, className) {
  return (node.attrs.get('class') || '').split(/\s+/).includes(className);
}

function findById(tree, id) {
  return walk(tree).find((node) => node.attrs.get('id') === id);
}

function findDescendant(node, predicate) {
  return node.children.flatMap(walk).find(predicate);
}

function sourceForNode(source, node) {
  return source.slice(node.start, node.end);
}

function functionFragment(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\b`);
  const start = source.search(declaration);
  assert.notEqual(start, -1, `missing function ${name}`);
  const tail = source.slice(start + 1);
  const next = tail.search(/\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\b/);
  return source.slice(start, next === -1 ? source.length : start + 1 + next);
}

function functionClosure(source, entryNames) {
  const queue = [...entryNames];
  const seen = new Set();
  const fragments = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const fragment = functionFragment(source, name);
    fragments.push(fragment);
    for (const call of fragment.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const calledName = call[1];
      if (seen.has(calledName)) continue;
      if (new RegExp(`(?:async\\s+)?function\\s+${calledName}\\b`).test(source)) queue.push(calledName);
    }
  }
  return fragments.join('\n');
}

function stringArrayConstants(source) {
  return [...source.matchAll(/const\s+([A-Z_$][\w$]*)\s*=\s*(?:new Set\(\s*)?\[([\s\S]*?)\]\s*\)?\s*;/g)]
    .map((match) => ({
      name: match[1],
      values: [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map((value) => value[1]),
    }));
}

const htmlTree = parseHtmlTree(html);

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

test('Home regions are correctly nested with five sensor cards and Chat first', () => {
  const home = findById(htmlTree, 'human-home');
  assert.ok(home, 'missing #human-home');
  assert.equal(home.children.length, 3, '#human-home must have only hero, sensor strip, and main grid');

  const [hero, sensorStrip, mainGrid] = home.children;
  assert.ok(hasClass(hero, 'h23-human-hero'), 'Home first region must be the Jerry hero');
  assert.ok(hasClass(sensorStrip, 'h23-human-sensor-strip'), 'Home second region must be the sensor strip');
  assert.equal(sensorStrip.attrs.get('data-home-sensor-layout'), 'true');
  assert.ok(hasClass(mainGrid, 'h23-human-main-grid'), 'Home third region must be the Chat-first main grid');

  assert.ok(findDescendant(hero, (node) => hasClass(node, 'h23-human-hero-copy')));
  assert.ok(findDescendant(hero, (node) => node.attrs.get('id') === 'tz1-time'));
  assert.equal(sensorStrip.children.length, 5, 'sensor strip must have Weather, Sauna, Pool, Problems, and Good Life');
  assert.deepEqual(
    sensorStrip.children.slice(0, 3).map((node) => node.attrs.get('data-home-tile-id')),
    ['outside-weather', 'sauna-control', 'pool-screenlogic'],
  );
  assert.equal(sensorStrip.children[3].tag, 'button');
  assert.ok(findDescendant(sensorStrip.children[3], (node) => node.attrs.get('id') === 'human-issues-value'));
  assert.equal(sensorStrip.children[4].tag, 'button');
  assert.ok(findDescendant(sensorStrip.children[4], (node) => node.attrs.get('id') === 'human-goodlife-value'));

  assert.equal(mainGrid.children.length, 2, 'main grid must contain Chat and the Vibe/Briefs side stack');
  assert.ok(findDescendant(mainGrid.children[0], (node) => node.attrs.get('id') === 'chat-slot-tile'), 'Chat must be first');
  assert.ok(findDescendant(mainGrid.children[1], (node) => node.attrs.get('id') === 'home-vibe-image'));
  assert.ok(findDescendant(mainGrid.children[1], (node) => node.attrs.get('id') === 'human-briefs-list'));
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
  const allowlist = js.match(/const\s+HOME_LAYOUT_MANAGED_SENSOR_IDS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(allowlist, 'missing HOME_LAYOUT_MANAGED_SENSOR_IDS Set');
  const managedIds = [...allowlist[1].matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(managedIds, ['outside-weather', 'pool-screenlogic', 'sauna-control']);

  for (const fn of ['applyHomeTileLayout', 'renderHomeTileInlineControls', 'mutateHomeTileLayout']) {
    assert.match(
      functionClosure(js, [fn]),
      /HOME_LAYOUT_MANAGED_SENSOR_IDS/,
      `${fn} must enforce the sensor allowlist`,
    );
  }
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

test('dashboard Settings overview contains no write surface or mutation route', () => {
  const panel = findById(htmlTree, 'panel-settings');
  assert.ok(panel, 'missing #panel-settings');
  const panelSource = sourceForNode(html, panel);

  assert.doesNotMatch(panelSource, /<(?:form|button|input|select|textarea)\b/i);
  assert.doesNotMatch(panelSource, /\bcontenteditable(?:\s*=|\b)/i);
  assert.doesNotMatch(panelSource, /\bon(?:click|change|submit|input)\s*=/i);
  assert.doesNotMatch(panelSource, /\b(?:formaction|action|method)\s*=/i);
  assert.doesNotMatch(panelSource, /\/home23\/api\//i);
  assert.doesNotMatch(panelSource, /\b(?:Save|Start|Stop|Delete|Restart|Install|Build|Connect|Disconnect)\b/i);
  assert.doesNotMatch(
    panelSource,
    /(?:aria-label|title|data-action|name|value)="[^"]*\b(?:save|start|stop|delete|restart|install|build|connect|disconnect)\b[^"]*"/i,
  );

  const links = walk(panel)
    .filter((node) => node.tag === 'a')
    .map((node) => node.attrs.get('href'));
  assert.ok(links.length >= 5, 'overview needs the full Settings link plus section links');
  assert.ok(links.every((href) => /^\/home23\/settings(?:#[a-z-]+)?$/.test(href)), 'all links must stay on full Settings');

  const loader = functionClosure(js, ['loadSettingsOverview']);
  assert.doesNotMatch(loader, /\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
  assert.doesNotMatch(loader, /\/(?:save|start|stop|restart|delete|install|build)\b/i);
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

test('overlay dialogs have real dismiss, labelling, focus, Escape, and scroll-lock contracts', () => {
  const overlayIds = [
    'problems-overlay',
    'goodlife-overlay',
    'brain-storage-overlay',
    'home-vibe-detail-modal',
    'chat-overlay',
    'problem-editor-overlay',
  ];

  for (const id of overlayIds) {
    const overlay = findById(htmlTree, id);
    assert.ok(overlay, `missing #${id}`);
    const dialog = findDescendant(overlay, (node) => node.attrs.get('role') === 'dialog')
      || (overlay.attrs.get('role') === 'dialog' ? overlay : null);
    assert.ok(dialog, `${id} needs a dialog owner`);
    assert.equal(dialog.attrs.get('aria-modal'), 'true', `${id} must be modal`);
    const labelledBy = dialog.attrs.get('aria-labelledby');
    assert.ok(labelledBy, `${id} must use aria-labelledby`);
    assert.ok(findById(htmlTree, labelledBy), `${id} references missing #${labelledBy}`);

    const overlaySource = sourceForNode(html, overlay);
    assert.match(
      overlaySource,
      /<button\b[^>]*(?:(?:aria-label|title)="[^"]*(?:close|dismiss)[^"]*")[^>]*>|<button\b[^>]*>\s*(?:<[^>]+>\s*)*(?:Close|Dismiss)\b/i,
      `${id} needs an accessible dismiss control`,
    );
  }

  const setup = functionClosure(js, ['setupDashboardOverlayAccessibility']);
  const closeTopmost = functionClosure(js, ['closeTopmostDashboardOverlay']);
  const lifecycle = `${setup}\n${closeTopmost}`;
  assert.match(setup, /addEventListener\(\s*['"]keydown['"]/);
  assert.match(setup, /(?:event|e)\.key\s*===\s*['"]Escape['"]/);
  assert.match(setup, /closeTopmostDashboardOverlay\(\)/);
  assert.match(setup, /(?:event|e)\.key\s*===\s*['"]Tab['"]/);
  assert.match(setup, /querySelectorAll\([\s\S]*(?:button|\[href\]|input)/);
  assert.match(setup, /preventDefault\(\)/);
  assert.match(lifecycle, /document\.activeElement/);
  assert.ok((lifecycle.match(/\.focus\(/g) || []).length >= 2, 'lifecycle must enter/trap and restore focus');
  const capturedFocus = lifecycle.match(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*document\.activeElement/);
  const mappedFocus = /\.set\([^)]*document\.activeElement[^)]*\)[\s\S]*\.get\([^)]*\)(?:\.|\?\.)focus\(/.test(lifecycle);
  const restoresCapturedFocus = capturedFocus
    && new RegExp(`${capturedFocus[1]}(?:\\.|\\?\\.)focus\\(`).test(lifecycle);
  assert.ok(restoresCapturedFocus || mappedFocus, 'lifecycle must restore the invoking element');

  const directOverlayList = overlayIds.every((id) => closeTopmost.includes(id));
  const referencedOverlayConstant = stringArrayConstants(js).find((candidate) => (
    closeTopmost.includes(candidate.name)
      && candidate.values.length === overlayIds.length
      && candidate.values.every((id) => overlayIds.includes(id))
  ));
  assert.ok(directOverlayList || referencedOverlayConstant, 'topmost close must be limited to the six dashboard overlays');
  assert.match(closeTopmost, /(?:\.at\(\s*-1\s*\)|\.findLast\(|\.reverse\(\)|\[\s*[^\]]+\.length\s*-\s*1\s*\])/);
  assert.match(closeTopmost, /(?:aria-hidden|hidden|getComputedStyle|classList\.contains)/);
  assert.match(closeTopmost, /(?:\.click\(\)|closeProblemsPanel|closeGoodLifeOperator|closeBrainStoragePanel|closeVibeImageDetail)/);

  const inlineScrollLock = /document\.body\.style\.overflow\s*=\s*['"]hidden['"]/.test(js)
    && /document\.body\.style\.overflow\s*=\s*(?:['"]['"]|[A-Za-z_$][\w$]*)/.test(js);
  const classScrollLock = /document\.body\.classList\.(?:add|toggle)\([\s\S]*overlay[\w-]*open/i.test(js)
    && /document\.body\.classList\.(?:remove|toggle)\([\s\S]*overlay[\w-]*open/i.test(js)
    && /body\.[\w-]*overlay[\w-]*open[^\{]*\{[^}]*overflow:\s*hidden/i.test(css);
  assert.ok(inlineScrollLock || classScrollLock, 'overlay lifecycle must lock and restore background scrolling');
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
