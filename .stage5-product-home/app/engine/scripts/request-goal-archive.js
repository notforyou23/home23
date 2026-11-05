#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { StateCompression } = require('../src/core/state-compression');

function parseArgs(argv) {
  const out = {
    agent: 'jerry',
    sources: [],
    sourcePrefixes: [],
    statuses: ['active'],
    statusesSpecified: false,
    reason: 'maintenance_goal_prune',
    apply: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent' && argv[i + 1]) out.agent = argv[++i];
    else if (arg === '--source' && argv[i + 1]) out.sources.push(argv[++i]);
    else if (arg === '--source-prefix' && argv[i + 1]) out.sourcePrefixes.push(argv[++i]);
    else if (arg === '--status' && argv[i + 1]) {
      if (!out.statusesSpecified) {
        out.statuses = [];
        out.statusesSpecified = true;
      }
      out.statuses.push(argv[++i]);
    }
    else if (arg === '--reason' && argv[i + 1]) out.reason = argv[++i];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
  }
  if (out.statuses.length > 1) {
    out.statuses = [...new Set(out.statuses.filter(Boolean))];
  }
  return out;
}

function normalizeGoalEntries(goalsSection) {
  const rows = [];
  for (const status of ['active', 'completed', 'archived']) {
    const bucket = Array.isArray(goalsSection?.[status]) ? goalsSection[status] : [];
    for (const entry of bucket) {
      if (status === 'active' && Array.isArray(entry) && entry[1] && typeof entry[1] === 'object') {
        const goal = entry[1];
        rows.push({ status: goal.status || status, goal });
      } else if (entry && typeof entry === 'object') {
        rows.push({ status: entry.status || status, goal: entry });
      }
    }
  }
  return rows;
}

function sourceLabels(goal) {
  const source = goal?.source;
  if (typeof source === 'string') return [source];
  if (source && typeof source === 'object') {
    return [source.label, source.origin].filter(Boolean);
  }
  return [];
}

function matchesSource(goal, opts) {
  const labels = sourceLabels(goal);
  if (opts.sources.length === 0 && opts.sourcePrefixes.length === 0) return false;
  return labels.some((label) => (
    opts.sources.includes(label)
    || opts.sourcePrefixes.some((prefix) => label.startsWith(prefix))
  ));
}

function printText(report) {
  console.log(`goal archive request: agent=${report.agent}`);
  console.log(`matches: ${report.goalIds.length}`);
  for (const goal of report.matches) {
    console.log(`  ${goal.id}  ${goal.status}  ${goal.sourceLabel}  ${goal.description.slice(0, 140)}`);
  }
  if (report.requestPath) {
    console.log('');
    console.log(`request written: ${report.requestPath}`);
    console.log('restart home23-jerry to consume it.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const brainDir = path.join(repoRoot, 'instances', args.agent, 'brain');
  const state = await StateCompression.loadCompressed(path.join(brainDir, 'state.json'));
  const all = normalizeGoalEntries(state.goals || {});

  const matches = all
    .filter(({ status, goal }) => args.statuses.includes(status) && matchesSource(goal, args))
    .map(({ status, goal }) => ({
      id: goal.id,
      status,
      sourceLabel: sourceLabels(goal)[0] || 'unknown',
      description: goal.description || '',
    }));

  const report = {
    agent: args.agent,
    statuses: args.statuses,
    sources: args.sources,
    sourcePrefixes: args.sourcePrefixes,
    goalIds: matches.map((goal) => goal.id),
    matches,
    requestPath: null,
  };

  if (args.apply) {
    const controlDir = path.join(brainDir, 'control');
    const requestPath = path.join(controlDir, 'archive-goals-request.json');
    fs.mkdirSync(controlDir, { recursive: true });
    if (fs.existsSync(requestPath)) {
      throw new Error(`request already exists: ${requestPath}`);
    }
    fs.writeFileSync(requestPath, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: args.reason,
      goalIds: report.goalIds,
    }, null, 2));
    report.requestPath = requestPath;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printText(report);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
