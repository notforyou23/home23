// Shipped scripts that read or write the owner's logs resolve them in the
// owner's home. Under the Home23 Host, HOME is Home23's private runtime home
// and HOME23_OWNER_HOME names the owner's; the owner's own cron has only HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

function homes(t) {
  const base = mkdtempSync(join(tmpdir(), 'home23-owner-scripts-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const owner = join(base, 'owner');
  const runtimeHome = join(base, 'runtime-user');
  const bin = join(base, 'bin');
  for (const dir of [owner, runtimeHome, bin]) mkdirSync(dir);
  const hostEnv = { ...process.env, HOME: runtimeHome, HOME23_OWNER_HOME: owner, HOME23_PRODUCT_HOST: 'true', PATH: `${bin}:${process.env.PATH}` };
  return { base, owner, runtimeHome, bin, hostEnv };
}

function stubCurl(bin, body) {
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\ncat <<'JSON'\n${body}\nJSON\n`);
  chmodSync(join(bin, 'curl'), 0o755);
}

/** Evaluates a script's own path assignments, as the script does, and prints them. */
function assignments(script, names, env) {
  const lines = readFileSync(join(repoRoot, script), 'utf8').split('\n').filter((line) => names.some((name) => line.startsWith(`${name}=`)));
  assert.equal(lines.length, names.length, `${script} assigns ${names.join(', ')}`);
  const printed = execFileSync('bash', ['-c', `${lines.join('\n')}\nprintf '%s\\n' ${names.map((name) => `"$${name}"`).join(' ')}`], { env, encoding: 'utf8' });
  return printed.trimEnd().split('\n');
}

test('the shell log scripts parse and name owner-home paths, falling back to HOME for the owner cron', () => {
  const env = (extra) => ({ PATH: process.env.PATH, HOME: '/fixture/runtime-user', ...extra });
  const owner = { HOME23_OWNER_HOME: '/fixture/owner', HOME23_PRODUCT_HOST: 'true' };
  const cases = [
    ['scripts/log-health.sh', ['LOG_PATH', 'STATUS_PATH'], ['.health_log.jsonl', '.health_log.status.json']],
    ['scripts/log-workouts.sh', ['LOG_PATH'], ['.workouts_log.jsonl']],
    ['scripts/log-pressure.sh', ['LOG_PATH', 'PI_SSH_KEY_PATH'], ['.pressure_log.jsonl', '.ssh/id_ed25519_pi']],
    ['scripts/x-timeline-fetch.sh', ['OUTPUT_DIR'], ['.openclaw/workspace/reports/x-timeline']],
  ];
  for (const [script, names, suffixes] of cases) {
    execFileSync('bash', ['-n', join(repoRoot, script)]);
    assert.deepEqual(assignments(script, names, env(owner)), suffixes.map((suffix) => `/fixture/owner/${suffix}`), script);
    assert.deepEqual(assignments(script, names, env({})), suffixes.map((suffix) => `/fixture/runtime-user/${suffix}`), script);
  }
});

test('log-health.sh and log-workouts.sh append to the owner home logs under the Host', (t) => {
  const { owner, runtimeHome, bin, hostEnv } = homes(t);
  const today = new Date().toISOString().slice(0, 10);
  stubCurl(bin, JSON.stringify({ export_info: { endDate: today }, metrics: { heartRateVariability: [{ date: today, qty: 42 }] } }));
  execFileSync('bash', [join(repoRoot, 'scripts/log-health.sh')], { env: { ...hostEnv, HEALTH_API_URL: 'http://health.fixture.invalid/api' }, stdio: 'pipe' });
  assert.equal(readFileSync(join(owner, '.health_log.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(readFileSync(join(owner, '.health_log.status.json'), 'utf8')).ok, true);

  stubCurl(bin, JSON.stringify({ total_count: 2, recent_count: 1, recent_duration_hours: 0.5, workouts: [] }));
  execFileSync('bash', [join(repoRoot, 'scripts/log-workouts.sh')], { env: { ...hostEnv, WORKOUTS_API_URL: 'http://workouts.fixture.invalid/api' }, stdio: 'pipe' });
  assert.equal(JSON.parse(readFileSync(join(owner, '.workouts_log.jsonl'), 'utf8')).total_count, 2);
  assert.deepEqual(readdirSync(runtimeHome), []);
});

test('the Forrest health bridge writes the owner health log and status, nothing under HOME', (t) => {
  const { base, owner, runtimeHome, hostEnv } = homes(t);
  const ledgers = join(base, 'health_jtr', 'ledgers');
  mkdirSync(ledgers, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(ledgers, 'daily_metrics.jsonl'), `${JSON.stringify({ metric: 'heart_rate_variability', date: today, qty: 44, units: 'ms', ingested_at: `${today}T08:00:00Z` })}\n`);

  execFileSync('python3', ['-B', join(repoRoot, 'scripts/log-health-from-forrest.py')], { env: { ...hostEnv, HEALTH_LEDGER_DIR: join(base, 'health_jtr') }, stdio: 'pipe' });

  const entry = JSON.parse(readFileSync(join(owner, '.health_log.jsonl'), 'utf8'));
  assert.equal(entry.metrics.heartRateVariability.value, 44);
  assert.equal(JSON.parse(readFileSync(join(owner, '.health_log.status.json'), 'utf8')).ok, true);
  assert.deepEqual(readdirSync(runtimeHome), []);
});

test('the Ecowitt backfill defaults its pressure logs to the owner home', (t) => {
  const { base, owner, hostEnv } = homes(t);
  // A stub PyYAML: only the module constants are read, nothing is fetched.
  const stubs = join(base, 'pystubs');
  mkdirSync(stubs);
  writeFileSync(join(stubs, 'yaml.py'), 'def safe_load(text):\n    return {}\n');
  const read = `import importlib.util, sys
spec = importlib.util.spec_from_file_location('backfill', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.DEFAULT_OUTPUT)
print(module.DEFAULT_MAIN_LOG)`;
  const printed = execFileSync('python3', ['-B', '-c', read, join(repoRoot, 'scripts/backfill-ecowitt-pressure.py')],
    { env: { ...hostEnv, PYTHONPATH: stubs }, encoding: 'utf8' });
  assert.deepEqual(printed.trim().split('\n'), [join(owner, '.pressure_log.ecowitt.jsonl'), join(owner, '.pressure_log.jsonl')]);
});

test('pursuits compaction keeps its backup inside the home, never in a home directory', (t) => {
  const { base, runtimeHome, hostEnv } = homes(t);
  // The script resolves its home from its own location: run a copy in a fixture home.
  const home = join(base, 'home');
  mkdirSync(join(home, 'scripts'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/compact-pursuits-ledger.cjs'), join(home, 'scripts/compact-pursuits-ledger.cjs'));
  const agency = join(home, 'instances', 'testbot', 'brain', 'agency');
  mkdirSync(agency, { recursive: true });
  writeFileSync(join(agency, 'pursuits.jsonl'), [
    { pursuit: { id: 'p1', evidence: [] } },
    { pursuit: { id: 'p1', evidence: ['newer'] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  execFileSync('node', [join(home, 'scripts/compact-pursuits-ledger.cjs'), 'testbot', '--apply'], { env: hostEnv, stdio: 'pipe' });

  const backups = readdirSync(join(home, 'instances', 'testbot', 'brain', 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^pursuits-testbot-.*\.jsonl\.gz$/);
  assert.equal(existsSync(join(runtimeHome, 'brain-backups')), false);
  assert.equal(readFileSync(join(agency, 'pursuits.jsonl'), 'utf8').trim().split('\n').length, 1);
});
