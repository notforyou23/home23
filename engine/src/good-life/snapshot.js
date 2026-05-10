'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const topology = require('../system/home23-process-topology.js');

const { classifyHome23Process } = topology;

function buildGoodLifeSnapshot({
  runtimeRoot,
  workspacePath,
  orchestrator,
  memory,
  goals,
  includeCurrentPm2 = false,
  currentPm2List,
} = {}) {
  const now = new Date().toISOString();
  return {
    now,
    memory: {
      nodes: sizeOf(memory?.nodes),
      edges: sizeOf(memory?.edges),
    },
    liveProblems: summarizeLiveProblems(orchestrator, runtimeRoot),
    goals: summarizeGoals(goals, runtimeRoot),
    agenda: summarizeAgenda(runtimeRoot),
    crystallization: summarizeJsonl(path.join(runtimeRoot || '', 'crystallization-receipts.jsonl')),
    host: summarizeHostPressure(runtimeRoot),
    discovery: orchestrator?.discoveryEngine?.getStats?.() || null,
    thinkingMachine: orchestrator?.thinkingMachine?.getStats?.() || null,
    publish: summarizePublish(runtimeRoot),
    goodLife: summarizeGoodLife(runtimeRoot),
    pm2: summarizePm2(runtimeRoot, includeCurrentPm2 ? readCurrentPm2List() : currentPm2List),
    surfaces: summarizeSurfaces(workspacePath),
    sleep: {
      active: Boolean(orchestrator?.sleepSession?.active),
      startCycle: orchestrator?.sleepSession?.startCycle ?? null,
    },
    crashRecovery: {
      crashDetected: Boolean(orchestrator?.crashRecovery?.crashDetected),
    },
    actions: summarizeActions(orchestrator),
  };
}

function summarizeLiveProblems(orchestrator, runtimeRoot) {
  const list = orchestrator?.liveProblems?.store?.all?.()
    || readJson(path.join(runtimeRoot || '', 'live-problems.json'))?.problems
    || [];
  const out = { open: 0, chronic: 0, resolved: 0, unverifiable: 0, total: 0, goodLifeDiagnostics: 0 };
  for (const p of Array.isArray(list) ? list : []) {
    if (isGoodLifeDiagnosticProblem(p)) {
      out.goodLifeDiagnostics++;
      continue;
    }
    out.total++;
    if (p.state === 'open') out.open++;
    else if (p.state === 'chronic') out.chronic++;
    else if (p.state === 'resolved') out.resolved++;
    else if (p.state === 'unverifiable') out.unverifiable++;
  }
  return out;
}

function summarizeHostPressure(runtimeRoot) {
  const channelsDir = path.join(runtimeRoot || '', 'channels');
  const cpu = latestChannelPayload(path.join(channelsDir, 'machine.cpu.jsonl'));
  const memory = latestChannelPayload(path.join(channelsDir, 'machine.memory.jsonl'));
  const swap = latestChannelPayload(path.join(channelsDir, 'machine.swap.jsonl'));
  const disk = latestChannelPayload(path.join(channelsDir, 'machine.disk.jsonl'));
  const process = latestChannelPayload(path.join(channelsDir, 'machine.process.jsonl'));
  const load1 = Array.isArray(cpu?.loadAvg) ? Number(cpu.loadAvg[0]) : null;
  const cpuCount = Number(cpu?.cpuCount || 0);
  return {
    cpu: cpu ? {
      at: toIsoTime(cpu.at),
      load1: Number.isFinite(load1) ? load1 : null,
      cpuCount: Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : null,
      loadRatio: Number.isFinite(load1) && cpuCount > 0 ? +(load1 / cpuCount).toFixed(2) : null,
    } : null,
    memory: memory ? {
      at: toIsoTime(memory.at),
      freePct: Number.isFinite(Number(memory.freePct)) ? Number(memory.freePct) : null,
      freeBytes: Number.isFinite(Number(memory.free)) ? Number(memory.free) : null,
      totalBytes: Number.isFinite(Number(memory.total)) ? Number(memory.total) : null,
    } : null,
    swap: swap ? {
      at: toIsoTime(swap.at),
      usedPct: Number.isFinite(Number(swap.swap?.usedPct)) ? Number(swap.swap.usedPct) : null,
      usedMb: Number.isFinite(Number(swap.swap?.usedMb)) ? Number(swap.swap.usedMb) : null,
      totalMb: Number.isFinite(Number(swap.swap?.totalMb)) ? Number(swap.swap.totalMb) : null,
    } : null,
    disk: disk ? {
      at: toIsoTime(disk.at),
      mount: disk.mount || null,
      usagePct: Number.isFinite(Number(disk.usagePct)) ? Number(disk.usagePct) : null,
    } : null,
    process: process ? {
      at: toIsoTime(process.at),
      topCpuPct: Number.isFinite(Number(process.topCpuPct)) ? Number(process.topCpuPct) : null,
      totalCpuPctTopN: Number.isFinite(Number(process.totalCpuPctTopN)) ? Number(process.totalCpuPctTopN) : null,
      topProcess: Array.isArray(process.processes) && process.processes[0]
        ? {
          command: process.processes[0].command || null,
          pm2Name: process.processes[0].pm2Name || null,
          cpuPct: Number.isFinite(Number(process.processes[0].cpuPct)) ? Number(process.processes[0].cpuPct) : null,
        }
        : null,
    } : null,
  };
}

function summarizePm2(runtimeRoot, currentPm2List) {
  const rows = tailJsonl(path.join(runtimeRoot || '', 'channels', 'os.pm2.jsonl'), 80)
    .map((row) => row?.payload)
    .filter((payload) => payload && payload.topology?.family === 'home23');
  const byName = new Map();
  let invalidRestartCounters = 0;
  for (const payload of rows) {
    if (payload.restartCount === null && payload.rawRestartCount != null) invalidRestartCounters++;
    const rec = byName.get(payload.name) || {
      name: payload.name,
      role: payload.topology?.role || null,
      lastChangeStatus: payload.status || null,
      changes: 0,
      lastAt: null,
      lastRestartCount: null,
      rawRestartCount: null,
    };
    rec.changes++;
    rec.lastChangeStatus = payload.status || rec.lastChangeStatus;
    rec.lastAt = toIsoTime(payload.at) || rec.lastAt;
    rec.lastRestartCount = payload.restartCount == null
      ? null
      : (Number.isFinite(Number(payload.restartCount)) ? Number(payload.restartCount) : null);
    rec.rawRestartCount = payload.rawRestartCount != null ? String(payload.rawRestartCount) : rec.rawRestartCount;
    byName.set(payload.name, rec);
  }
  const processes = [...byName.values()]
    .sort((a, b) => b.changes - a.changes || String(a.name).localeCompare(String(b.name)))
    .slice(0, 8);
  const current = summarizeCurrentPm2(currentPm2List);
  return {
    recentHome23Changes: rows.length,
    invalidRestartCounters,
    processes,
    ...current,
  };
}

function summarizeCurrentPm2(list) {
  if (!Array.isArray(list)) return {
    currentSampledAt: null,
    currentTotal: null,
    offline: null,
    invalidCurrentRestartCounters: null,
    current: [],
    offlineProcesses: [],
  };

  const sampledAt = new Date().toISOString();
  let invalidCurrentRestartCounters = 0;
  const current = [];
  for (const p of list) {
    const name = p?.name;
    const status = p?.pm2_env?.status || null;
    const script = p?.pm2_env?.pm_exec_path || null;
    const topology = classifyHome23Process({
      name,
      script,
      cwd: p?.pm2_env?.pm_cwd,
    });
    if (topology.family !== 'home23') continue;
    const restartCount = normalizePm2RestartCount(p?.pm2_env?.restart_time ?? 0);
    if (restartCount === null) invalidCurrentRestartCounters++;
    current.push({
      name,
      role: topology.role || null,
      agentName: topology.agentName || null,
      status,
      restartCount,
      rawRestartCount: restartCount === null ? String(p?.pm2_env?.restart_time ?? '') : null,
    });
  }

  current.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const offlineProcesses = current.filter((p) => p.status !== 'online');
  return {
    currentSampledAt: sampledAt,
    currentTotal: current.length,
    offline: offlineProcesses.length,
    invalidCurrentRestartCounters,
    current,
    offlineProcesses,
  };
}

function readCurrentPm2List() {
  try {
    const stdout = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function normalizePm2RestartCount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function latestChannelPayload(file) {
  const row = tailJsonl(file, 1)[0];
  return row?.payload || null;
}

function isGoodLifeDiagnosticProblem(problem) {
  const claim = String(problem?.claim || '');
  const id = String(problem?.id || '');
  return id.startsWith('agenda_') && /Agenda action: Diagnose Good Life /i.test(claim);
}

function summarizeGoals(goals, runtimeRoot) {
  const list = typeof goals?.getGoals === 'function' ? goals.getGoals() : [];
  let open = 0;
  let complete = 0;
  for (const g of Array.isArray(list) ? list : []) {
    if (isOpenGoal(g)) open++;
    else complete++;
  }
  const brainSnapshot = readJson(path.join(runtimeRoot || '', 'brain-snapshot.json'));
  const snapshotActive = snapshotActiveGoalCount(brainSnapshot);
  if (snapshotActive != null) open = Math.max(open, snapshotActive);
  if (Number.isFinite(Number(brainSnapshot?.goalCounts?.completed))) {
    complete = Math.max(complete, Number(brainSnapshot.goalCounts.completed));
  }
  return { open, complete, total: open + complete };
}

function snapshotActiveGoalCount(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const activeCount = Number(snapshot.goalCounts?.active);
  const activeSummaries = Array.isArray(snapshot.activeGoalSummaries)
    ? snapshot.activeGoalSummaries.filter(isOpenGoal).length
    : null;
  if (Number.isFinite(activeCount) && activeCount >= 0 && activeSummaries != null) {
    return Math.max(activeCount, activeSummaries);
  }
  if (Number.isFinite(activeCount) && activeCount >= 0) return activeCount;
  return activeSummaries;
}

function isOpenGoal(goal) {
  if (!goal) return false;
  const status = String(goal.status || 'active').toLowerCase();
  if (['completed', 'complete', 'archived', 'cancelled', 'canceled', 'resolved'].includes(status)) {
    return false;
  }
  if (goal.completed || goal.completedAt || goal.completed_at) return false;
  const progress = Number.isFinite(Number(goal.progress)) ? Number(goal.progress) : null;
  return progress === null || progress < 1;
}

function summarizeAgenda(runtimeRoot) {
  const file = path.join(runtimeRoot || '', 'agenda.jsonl');
  const rows = readJsonl(file);
  const items = new Map();
  for (const row of rows) {
    if (row.type === 'add' && row.id) {
      const record = row.record || {};
      items.set(row.id, {
        status: record.status || row.status || 'candidate',
      });
    } else if (row.type === 'status' && row.id) {
      const rec = items.get(row.id) || {};
      rec.status = row.status || rec.status || 'candidate';
      items.set(row.id, rec);
    } else if (row.id && row.status) {
      items.set(row.id, { status: row.status });
    }
  }

  const counts = { candidate: 0, surfaced: 0, acknowledged: 0, actedOn: 0, stale: 0, discarded: 0, total: 0 };
  for (const rec of items.values()) {
    const status = rec.status || 'candidate';
    if (status === 'acted_on') counts.actedOn++;
    else if (status === 'surfaced') counts.surfaced++;
    else if (status === 'acknowledged') counts.acknowledged++;
    else if (status === 'stale') counts.stale++;
    else if (status === 'discarded') counts.discarded++;
    else counts.candidate++;
    counts.total++;
  }
  return {
    pending: counts.candidate + counts.surfaced + counts.acknowledged,
    actedOn: counts.actedOn,
    stale: counts.stale,
    discarded: counts.discarded,
    candidate: counts.candidate,
    surfaced: counts.surfaced,
    acknowledged: counts.acknowledged,
    total: counts.total,
    sampled: rows.length,
  };
}

function summarizePublish(runtimeRoot) {
  const file = path.join(runtimeRoot || '', 'publish-ledger.jsonl');
  const stat = statIso(file);
  const rows = tailJsonl(file, 200);
  const useful = rows
    .filter((r) => ['workspace_insights', 'dashboard', 'bridge_chat', 'dream_log', 'signals'].includes(r.target || r.kind))
    .slice(-1)[0];
  return {
    lastLedgerWriteAt: stat,
    lastUsefulOutputAt: toIsoTime(useful?.at || useful?.timestamp || stat),
    sampled: rows.length,
  };
}

function summarizeGoodLife(runtimeRoot) {
  return {
    commitments: readJson(path.join(runtimeRoot || '', 'good-life-commitments.json')),
    trends: readJson(path.join(runtimeRoot || '', 'good-life-trends-current.json')),
    regulator: readJson(path.join(runtimeRoot || '', 'good-life-regulator-state.json')),
  };
}

function summarizeSurfaces(workspacePath) {
  if (!workspacePath) return {};
  return {
    nowUpdatedAt: statIso(path.join(workspacePath, 'NOW.md')),
    heartbeatUpdatedAt: statIso(path.join(workspacePath, 'HEARTBEAT.md')),
    projectsUpdatedAt: statIso(path.join(workspacePath, 'PROJECTS.md')),
    topologyUpdatedAt: statIso(path.join(workspacePath, 'TOPOLOGY.md')),
  };
}

function summarizeActions(orchestrator) {
  const journal = Array.isArray(orchestrator?.journal) ? orchestrator.journal.slice(-40) : [];
  let maintenance = 0;
  const structuredFailures = journal
    .map((entry) => Number(entry?.cognitiveState?.recentFailures))
    .filter((value) => Number.isFinite(value));
  const structuredFailureDelta = structuredFailures.length > 0
    ? Math.max(0, structuredFailures[structuredFailures.length - 1] - structuredFailures[0])
    : null;
  let textFailureMentions = 0;
  for (const j of journal) {
    const text = String(j?.thought || j?.reasoning || '').toLowerCase();
    if (structuredFailureDelta == null && isActionFailureText(text)) textFailureMentions++;
    if (text.includes('restart') || text.includes('maintenance') || text.includes('self') || text.includes('engine')) maintenance++;
  }
  return {
    recentFailures: structuredFailureDelta ?? textFailureMentions,
    maintenanceRatio: journal.length ? maintenance / journal.length : 0,
  };
}

function isActionFailureText(text) {
  if (!text) return false;
  if (/(resolved|healthy|clean state|zero open|no current operational issues|no_action)/i.test(text)) {
    return false;
  }
  return /(failed|error|timeout)/i.test(text);
}

function summarizeJsonl(file) {
  const rows = tailJsonl(file, 20);
  const last = rows[rows.length - 1] || null;
  return {
    countSampled: rows.length,
    lastReceiptAt: toIsoTime(last?.at || last?.timestamp || statIso(file)),
  };
}

function tailJsonl(file, limit) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonl(file) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function statIso(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function toIsoTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function sizeOf(maybeMap) {
  if (!maybeMap) return 0;
  if (typeof maybeMap.size === 'number') return maybeMap.size;
  if (Array.isArray(maybeMap)) return maybeMap.length;
  if (typeof maybeMap === 'object') return Object.keys(maybeMap).length;
  return 0;
}

module.exports = { buildGoodLifeSnapshot, readCurrentPm2List };
