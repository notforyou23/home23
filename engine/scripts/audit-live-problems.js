#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { defaultSeeds } = require('../src/live-problems/seed');
const { auditProblemList } = require('../src/live-problems/audit');
const { TargetsRegistry } = require('../src/live-problems/registry');

function parseArgs(argv) {
  const out = { agent: 'jerry', dashboardPort: '5002', bridgePort: '5004', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent' && argv[i + 1]) out.agent = argv[++i];
    else if (arg === '--dashboard-port' && argv[i + 1]) out.dashboardPort = argv[++i];
    else if (arg === '--bridge-port' && argv[i + 1]) out.bridgePort = argv[++i];
    else if (arg === '--json') out.json = true;
  }
  return out;
}

function loadLiveProblems(repoRoot, agent) {
  const file = path.join(repoRoot, 'instances', agent, 'brain', 'live-problems.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw.problems) ? raw.problems : [];
}

function groupFailures(results) {
  return results
    .filter((result) => result.findings.length > 0)
    .map((result) => ({
      id: result.id,
      ok: result.ok,
      findings: result.findings,
    }));
}

function printText(report) {
  console.log(`live-problems audit: agent=${report.agent}`);
  console.log(`seeded defs: ${report.seededCount}`);
  console.log(`runtime defs: ${report.runtimeCount}`);
  console.log(`findings: ${report.findingCount}`);
  console.log('');

  for (const section of ['seedFindings', 'runtimeFindings']) {
    const rows = report[section];
    if (rows.length === 0) continue;
    console.log(section === 'seedFindings' ? 'seed findings:' : 'runtime findings:');
    for (const row of rows) {
      for (const finding of row.findings) {
        console.log(`  [${finding.severity}] ${row.id} ${finding.code} - ${finding.message}`);
      }
    }
    console.log('');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const registry = new TargetsRegistry().load();
  const seeded = defaultSeeds({
    agentName: args.agent,
    dashboardPort: args.dashboardPort,
    bridgePort: args.bridgePort,
  });
  const runtime = loadLiveProblems(repoRoot, args.agent);

  const seedAudit = auditProblemList(seeded, { registry });
  const runtimeAudit = auditProblemList(runtime, { registry });

  const report = {
    agent: args.agent,
    seededCount: seeded.length,
    runtimeCount: runtime.length,
    seedFindings: groupFailures(seedAudit),
    runtimeFindings: groupFailures(runtimeAudit),
  };
  report.findingCount = report.seedFindings.reduce((sum, row) => sum + row.findings.length, 0)
    + report.runtimeFindings.reduce((sum, row) => sum + row.findings.length, 0);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printText(report);
  process.exitCode = report.findingCount === 0 ? 0 : 1;
}

main();
