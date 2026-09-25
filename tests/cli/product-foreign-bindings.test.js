import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectForeignBindings, foreignBindingWarnings, readPlist } from '../../cli/lib/product-foreign-bindings.js';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-foreign-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A user home with a global PM2 dump and LaunchAgents folder, all outside any home root. */
function userHomeWith(root, { apps = null, agents = {} } = {}) {
  const userHome = path.join(root, 'user');
  if (apps) {
    fs.mkdirSync(path.join(userHome, '.pm2'), { recursive: true });
    fs.writeFileSync(path.join(userHome, '.pm2', 'dump.pm2'), JSON.stringify(apps, null, 2));
  }
  const agentsDir = path.join(userHome, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [file, text] of Object.entries(agents)) fs.writeFileSync(path.join(agentsDir, file), text);
  return userHome;
}

function plist(label, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
${body}
</dict>
</plist>
`;
}

function watcherAgent(label, root) {
  return plist(label, `  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${root}/app/scripts/watch.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${root}/app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME23_ROOT</key>
    <string>${root}/app</string>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${root}/app/logs/watch.log</string>
  <key>RunAtLoad</key>
  <true/>`);
}

const unrelatedAgent = plist('com.example.other', `  <key>ProgramArguments</key>
  <array>
    <string>/opt/other/bin/run</string>
  </array>
  <key>StandardErrorPath</key>
  <string>/opt/other/err.log</string>`);

function engineApp(root) {
  return {
    name: 'cosmo-engine',
    pm_exec_path: '/usr/local/bin/node',
    pm_cwd: `${root}/app`,
    args: ['dist/engine.js'],
    env: { HOME23_ROOT: `${root}/app`, COSMO_CONFIG_PATH: `${root}/app/config/cosmo.yaml`, PATH: '/usr/bin:/bin' },
    pm_out_log_path: `${root}/app/logs/engine-out.log`,
    pm_err_log_path: `${root}/app/logs/engine-err.log`,
  };
}

const unrelatedApp = userHome => ({ name: 'unrelated', pm_cwd: '/opt/other', env: { HOME: userHome }, pm_out_log_path: '/opt/other/out.log' });
const lookalikeApp = root => ({ name: 'lookalike', pm_cwd: `${root}-archive/app`, env: { HOME23_ROOT: `${root}.bak/app` } });

test('reports global PM2 apps and launchd agents still bound to a retired home root without changing them', t => {
  const root = tempRoot(t);
  const oldRoot = path.join(root, 'old-home');
  const newRoot = path.join(root, 'new-home');
  const userHome = userHomeWith(root, {
    apps: [engineApp(oldRoot), unrelatedApp(path.join(root, 'user')), lookalikeApp(oldRoot)],
    agents: { 'com.example.home23-watch.plist': watcherAgent('com.example.home23-watch', oldRoot), 'com.example.other.plist': unrelatedAgent, 'notes.txt': `${oldRoot}\n` },
  });
  const dumpFile = path.join(userHome, '.pm2', 'dump.pm2');
  const agentFile = path.join(userHome, 'Library/LaunchAgents/com.example.home23-watch.plist');
  const before = { dump: fs.readFileSync(dumpFile), agent: fs.readFileSync(agentFile), dumpStat: fs.statSync(dumpFile).mtimeMs, agentStat: fs.statSync(agentFile).mtimeMs };

  const report = detectForeignBindings({ homeRoot: newRoot, previousRoot: `${oldRoot}/`, homeDirectory: userHome });
  assert.equal(report.schema, 'home23.foreign-bindings.v1');
  assert.deepEqual(report.roots, [newRoot, oldRoot]);
  assert.deepEqual(report.unreadable, []);
  assert.deepEqual(report.references, [
    { source: 'pm2', name: 'cosmo-engine', field: 'pm_cwd', value: `${oldRoot}/app`, root: oldRoot, file: dumpFile },
    { source: 'pm2', name: 'cosmo-engine', field: 'env.HOME23_ROOT', value: `${oldRoot}/app`, root: oldRoot, file: dumpFile },
    { source: 'pm2', name: 'cosmo-engine', field: 'env.COSMO_CONFIG_PATH', value: `${oldRoot}/app/config/cosmo.yaml`, root: oldRoot, file: dumpFile },
    { source: 'pm2', name: 'cosmo-engine', field: 'pm_out_log_path', value: `${oldRoot}/app/logs/engine-out.log`, root: oldRoot, file: dumpFile },
    { source: 'pm2', name: 'cosmo-engine', field: 'pm_err_log_path', value: `${oldRoot}/app/logs/engine-err.log`, root: oldRoot, file: dumpFile },
    { source: 'launchd', name: 'com.example.home23-watch', field: 'ProgramArguments[2]', value: `${oldRoot}/app/scripts/watch.mjs`, root: oldRoot, file: agentFile },
    { source: 'launchd', name: 'com.example.home23-watch', field: 'WorkingDirectory', value: `${oldRoot}/app`, root: oldRoot, file: agentFile },
    { source: 'launchd', name: 'com.example.home23-watch', field: 'EnvironmentVariables.HOME23_ROOT', value: `${oldRoot}/app`, root: oldRoot, file: agentFile },
    { source: 'launchd', name: 'com.example.home23-watch', field: 'StandardOutPath', value: `${oldRoot}/app/logs/watch.log`, root: oldRoot, file: agentFile },
  ]);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0], /PM2 app "cosmo-engine"/);
  assert.match(report.warnings[0], new RegExp(`still references ${oldRoot.replaceAll('.', '\\.')} `));
  assert.match(report.warnings[0], /pm_cwd, env\.HOME23_ROOT, env\.COSMO_CONFIG_PATH, pm_out_log_path, pm_err_log_path/);
  assert.match(report.warnings[0], /Home23 did not change it/);
  assert.match(report.warnings[1], /launchd agent "com\.example\.home23-watch"/);
  assert.match(report.warnings[1], /ProgramArguments\[2\], WorkingDirectory, EnvironmentVariables\.HOME23_ROOT, StandardOutPath/);

  // Detection is read-only: neither the dump nor the agent changed.
  assert.deepEqual(fs.readFileSync(dumpFile), before.dump);
  assert.deepEqual(fs.readFileSync(agentFile), before.agent);
  assert.equal(fs.statSync(dumpFile).mtimeMs, before.dumpStat);
  assert.equal(fs.statSync(agentFile).mtimeMs, before.agentStat);
});

test('reports nothing when no supervisor references the roots or when the folders are absent', t => {
  const root = tempRoot(t);
  const homeRoot = path.join(root, 'home');
  const userHome = userHomeWith(root, {
    apps: [unrelatedApp(path.join(root, 'user')), lookalikeApp(homeRoot)],
    agents: { 'com.example.other.plist': unrelatedAgent },
  });
  const clean = detectForeignBindings({ homeRoot, previousRoot: path.join(root, 'old'), homeDirectory: userHome });
  assert.deepEqual(clean.references, []);
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.unreadable, []);
  assert.equal(clean.scanned.pm2Dump, path.join(userHome, '.pm2/dump.pm2'));
  assert.equal(clean.scanned.launchAgents, path.join(userHome, 'Library/LaunchAgents'));

  const absent = detectForeignBindings({ homeRoot, homeDirectory: path.join(root, 'nobody') });
  assert.deepEqual(absent.references, []);
  assert.deepEqual(absent.warnings, []);
  assert.deepEqual(absent.unreadable, []);
  assert.deepEqual(absent.roots, [homeRoot]);
  assert.deepEqual(foreignBindingWarnings([]), []);
});

test('respects HOME and PM2_HOME overrides and never treats the home\'s own supervisor as foreign', t => {
  const root = tempRoot(t);
  const homeRoot = path.join(root, 'home');
  const userHome = userHomeWith(root, { apps: [engineApp(homeRoot)] });
  const previous = { HOME: process.env.HOME, PM2_HOME: process.env.PM2_HOME };
  t.after(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.HOME = userHome;
  delete process.env.PM2_HOME;
  const viaHome = detectForeignBindings({ homeRoot });
  assert.equal(viaHome.scanned.pm2Dump, path.join(userHome, '.pm2/dump.pm2'));
  assert.equal(viaHome.references.length, 5);
  assert.ok(viaHome.references.every(reference => reference.source === 'pm2' && reference.root === homeRoot));

  const customPm2 = path.join(root, 'custom-pm2');
  fs.mkdirSync(customPm2, { recursive: true });
  fs.writeFileSync(path.join(customPm2, 'dump.pm2'), JSON.stringify([{ name: 'custom', pm_cwd: `${homeRoot}/app` }]));
  process.env.PM2_HOME = customPm2;
  const viaPm2Home = detectForeignBindings({ homeRoot });
  assert.equal(viaPm2Home.scanned.pm2Dump, path.join(customPm2, 'dump.pm2'));
  assert.deepEqual(viaPm2Home.references.map(reference => [reference.name, reference.field]), [['custom', 'pm_cwd']]);

  // The home's own supervisor lives inside the home root; its dump legitimately names the home.
  const owned = path.join(homeRoot, 'runtime/pm2');
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, 'dump.pm2'), JSON.stringify([{ name: 'home23-coordination', pm_cwd: `${homeRoot}/app` }]));
  process.env.PM2_HOME = owned;
  const ownedReport = detectForeignBindings({ homeRoot, homeDirectory: path.join(root, 'nobody') });
  assert.equal(ownedReport.scanned.pm2Dump, null);
  assert.deepEqual(ownedReport.references, []);
  const explicit = detectForeignBindings({ homeRoot, homeDirectory: path.join(root, 'nobody'), pm2Home: customPm2 });
  assert.equal(explicit.references.length, 1);
});

test('unreadable dumps and agents are reported as unreadable instead of failing the scan', t => {
  const root = tempRoot(t);
  const homeRoot = path.join(root, 'home');
  const userHome = userHomeWith(root, {
    apps: [],
    agents: { 'broken.plist': '<plist><dict><key>Label</key><string>x</string></dict>', 'com.example.home23-watch.plist': watcherAgent('com.example.home23-watch', homeRoot) },
  });
  fs.writeFileSync(path.join(userHome, '.pm2/dump.pm2'), '{ not json');
  const report = detectForeignBindings({ homeRoot, homeDirectory: userHome });
  assert.deepEqual(report.unreadable, [path.join(userHome, '.pm2/dump.pm2'), path.join(userHome, 'Library/LaunchAgents/broken.plist')]);
  assert.equal(report.references.length, 4);
  assert.ok(report.references.every(reference => reference.source === 'launchd'));
  assert.equal(report.warnings.length, 1);

  fs.writeFileSync(path.join(userHome, '.pm2/dump.pm2'), JSON.stringify({ name: 'not-a-list', pm_cwd: homeRoot }));
  assert.deepEqual(detectForeignBindings({ homeRoot, homeDirectory: userHome }).unreadable.slice(0, 1), [path.join(userHome, '.pm2/dump.pm2')]);
});

test('readPlist decodes nested dictionaries, arrays, entities and scalars', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'sample.plist');
  fs.writeFileSync(file, plist('com.example.sample', `  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>echo &quot;a &amp; b&quot; &gt; /tmp/x &#38; true</string>
  </array>
  <key>Nested</key>
  <dict>
    <key>Enabled</key>
    <true/>
    <key>Disabled</key>
    <false/>
    <key>Count</key>
    <integer>3</integer>
    <key>Ratio</key>
    <real>0.5</real>
    <key>Empty</key>
    <string></string>
    <key>Items</key>
    <array/>
  </dict>`));
  assert.deepEqual(readPlist(file), {
    Label: 'com.example.sample',
    ProgramArguments: ['/bin/sh', '-c', 'echo "a & b" > /tmp/x & true'],
    Nested: { Enabled: true, Disabled: false, Count: 3, Ratio: 0.5, Empty: '', Items: [] },
  });
});

test('binary launchd agents are read through plutil on macOS', { skip: process.platform !== 'darwin' }, t => {
  const root = tempRoot(t);
  const homeRoot = path.join(root, 'home');
  const userHome = userHomeWith(root, { agents: { 'com.example.binary.plist': watcherAgent('com.example.binary', homeRoot) } });
  const file = path.join(userHome, 'Library/LaunchAgents/com.example.binary.plist');
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file]);
  assert.equal(fs.readFileSync(file).subarray(0, 6).toString(), 'bplist');
  const report = detectForeignBindings({ homeRoot, homeDirectory: userHome });
  assert.deepEqual(report.unreadable, []);
  assert.deepEqual(report.references.map(reference => reference.field), ['ProgramArguments[2]', 'WorkingDirectory', 'EnvironmentVariables.HOME23_ROOT', 'StandardOutPath']);
  assert.equal(report.references[0].name, 'com.example.binary');
});
