'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inspectContract,
  planRepair,
  parsePm2JlistOutput,
} = require('../../scripts/home23-pm2-watchdog.cjs');

function expected() {
  return {
    root: '/Users/jtr/_JTR23_/release/home23',
    agent: 'jerry',
    dashboardPort: '5002',
    realtimePort: '5001',
    legacyDashboardPort: '3344',
    roles: {
      engine: {
        name: 'home23-jerry',
        requiredEnv: {
          HOME23_AGENT: 'jerry',
          DASHBOARD_PORT: '5002',
          COSMO_DASHBOARD_PORT: '5002',
          REALTIME_PORT: '5001',
        },
      },
      dashboard: {
        name: 'home23-jerry-dash',
        requiredEnv: {
          HOME23_AGENT: 'jerry',
          DASHBOARD_PORT: '5002',
          COSMO_DASHBOARD_PORT: '5002',
          REALTIME_PORT: '5001',
        },
      },
      harness: {
        name: 'home23-jerry-harness',
        requiredEnv: {
          HOME23_AGENT: 'jerry',
          DASHBOARD_PORT: '5002',
          COSMO_DASHBOARD_PORT: '5002',
          REALTIME_PORT: '5001',
        },
      },
    },
  };
}

function healthyObserved() {
  return {
    pm2List: [
      {
        name: 'home23-jerry',
        pid: 1001,
        pm2_env: {
          status: 'online',
          HOME23_AGENT: 'jerry',
          DASHBOARD_PORT: '5002',
          COSMO_DASHBOARD_PORT: '5002',
          REALTIME_PORT: '5001',
        },
      },
      {
        name: 'home23-jerry-dash',
        pid: 1002,
        pm2_env: {
          status: 'online',
          HOME23_AGENT: 'jerry',
          DASHBOARD_PORT: '5002',
          COSMO_DASHBOARD_PORT: '5002',
          REALTIME_PORT: '5001',
        },
      },
      {
        name: 'home23-jerry-harness',
        pid: 1003,
        pm2_env: {
          status: 'online',
          HOME23_AGENT: 'jerry',
          DASHBOARD_PORT: '5002',
          COSMO_DASHBOARD_PORT: '5002',
          REALTIME_PORT: '5001',
        },
      },
    ],
    listeners: [
      { port: '5001', pid: 1001, command: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js' },
      { port: '5002', pid: 1002, command: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js' },
    ],
  };
}

test('pm2 watchdog contract passes for a healthy agent triplet', () => {
  const inspection = inspectContract(expected(), healthyObserved());

  assert.equal(inspection.ok, true);
  assert.deepEqual(inspection.issues, []);
  assert.deepEqual(planRepair(expected(), inspection).startNames, []);
});

test('pm2 watchdog detects missing engine and harness even when dashboard port responds', () => {
  const observed = healthyObserved();
  observed.pm2List = observed.pm2List.filter((proc) => proc.name === 'home23-jerry-dash');
  observed.listeners = [
    { port: '5002', pid: 1002, command: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js' },
  ];

  const inspection = inspectContract(expected(), observed);
  const issueTypes = inspection.issues.map((issue) => issue.type);

  assert.equal(inspection.ok, false);
  assert.ok(issueTypes.includes('pm2_missing'));
  assert.deepEqual(planRepair(expected(), inspection).startNames, [
    'home23-jerry',
    'home23-jerry-harness',
  ]);
});

test('pm2 watchdog starts only a missing role instead of churning a healthy triplet', () => {
  const observed = healthyObserved();
  observed.pm2List = observed.pm2List.filter((proc) => proc.name !== 'home23-jerry');
  observed.listeners = [
    { port: '5002', pid: 1002, command: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js' },
  ];

  const inspection = inspectContract(expected(), observed);
  const repair = planRepair(expected(), inspection);

  assert.equal(inspection.ok, false);
  assert.deepEqual(repair.startNames, ['home23-jerry']);
});

test('pm2 watchdog treats PM2 online rows with dead pids as repairable', () => {
  const observed = healthyObserved();
  observed.pidAlive = (pid) => pid !== 1001;

  const inspection = inspectContract(expected(), observed);
  const repair = planRepair(expected(), inspection);

  assert.equal(inspection.ok, false);
  assert.ok(inspection.issues.some((issue) => issue.type === 'pm2_pid_dead' && issue.name === 'home23-jerry'));
  assert.deepEqual(repair.deleteNames, ['home23-jerry']);
  assert.deepEqual(repair.startNames, ['home23-jerry']);
});

test('pm2 watchdog treats harness cron_restart as contamination', () => {
  const observed = healthyObserved();
  observed.pm2List[2].pm2_env.cron_restart = '7,37 * * * *';

  const inspection = inspectContract(expected(), observed);
  const repair = planRepair(expected(), inspection);

  assert.equal(inspection.ok, false);
  assert.ok(inspection.issues.some((issue) => issue.type === 'pm2_unexpected_cron_restart' && issue.name === 'home23-jerry-harness'));
  assert.deepEqual(repair.deleteNames, ['home23-jerry-harness']);
  assert.deepEqual(repair.startNames, ['home23-jerry-harness']);
});

test('pm2 watchdog catches stale dashboard listener and wrong dash env', () => {
  const observed = healthyObserved();
  observed.pm2List[1] = {
    name: 'home23-jerry-dash',
    pid: 2002,
    pm2_env: {
      status: 'online',
      HOME23_AGENT: 'forrest',
      cron_restart: '7,37 * * * *',
    },
  };
  observed.listeners = [
    { port: '5001', pid: 1001, command: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js' },
    { port: '5002', pid: 70870, command: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js' },
    { port: '3344', pid: 38221, command: '/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js' },
  ];

  const inspection = inspectContract(expected(), observed);
  const repair = planRepair(expected(), inspection);

  assert.equal(inspection.ok, false);
  assert.ok(inspection.issues.some((issue) => issue.type === 'pm2_env_mismatch' && issue.key === 'HOME23_AGENT'));
  assert.ok(inspection.issues.some((issue) => issue.type === 'pm2_unexpected_cron_restart'));
  assert.ok(inspection.issues.some((issue) => issue.type === 'legacy_dashboard_listener' && issue.pid === 38221));
  assert.deepEqual(repair.killPids, [38221, 70870]);
  assert.deepEqual(repair.deleteNames, ['home23-jerry-dash']);
  assert.deepEqual(repair.startNames, ['home23-jerry-dash']);
});

test('pm2 watchdog ignores a non-Home23 process on legacy dashboard port', () => {
  const observed = healthyObserved();
  observed.listeners.push({ port: '3344', pid: 9000, command: '/usr/bin/python -m unrelated.server' });

  const inspection = inspectContract(expected(), observed);

  assert.equal(inspection.ok, true);
});

test('pm2 watchdog parses jlist JSON after PM2 startup chatter', () => {
  const parsed = parsePm2JlistOutput('[PM2] Spawning PM2 daemon\n[{"name":"home23-jerry"}]\n');

  assert.deepEqual(parsed, [{ name: 'home23-jerry' }]);
});

test('pm2 watchdog refuses non-JSON jlist output instead of repairing from it', () => {
  assert.throws(
    () => parsePm2JlistOutput('[PM2] Spawning PM2 daemon\n[PM2] PM2 Successfully daemonized\n'),
    /did not return a JSON process list/
  );
});
