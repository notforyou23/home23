const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_AGENTS = ['jerry', 'forrest'];
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 240;
const MAX_FILE_BYTES = 512 * 1024;

const AGENT_SOURCE_DIRS = [
  { rel: 'workspace/reports', type: 'report' },
  { rel: 'workspace/insights', type: 'insight' },
  { rel: 'workspace/research', type: 'research' },
  { rel: 'workspace/sessions', type: 'session' },
];

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function safeReadText(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = safeStat(file);
    if (!stat || !stat.isFile() || stat.size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlTail(file, limit = 1, maxBytes = 192 * 1024) {
  try {
    const stat = safeStat(file);
    if (!stat || !stat.isFile() || stat.size <= 0) return [];
    const bytesToRead = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - bytesToRead);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function hashId(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 18);
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function normalizeDate(value, fallbackMs = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = [];
  let inCode = false;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
    list = [];
  }

  function flushCode() {
    if (!codeLines.length) return;
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1].trim());
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  flushCode();
  return html.join('\n') || '<p>No readable content yet.</p>';
}

function markdownTitle(text, fallback) {
  const titleLine = String(text || '').split('\n').find((line) => /^#\s+/.test(line.trim()));
  if (titleLine) return titleLine.replace(/^#\s+/, '').trim();
  return fallback;
}

function humanLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function formatNumber(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '');
  return num.toFixed(digits).replace(/\.?0+$/, '');
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function humanizeMachineFailure(text, context = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (!/error calling|command failed|fetch failed|timeout|operation was aborted|traceback/.test(lowered)) {
    return null;
  }

  const isWorker = context.type === 'worker';
  const title = isWorker ? 'Worker check failed' : 'Brief generation failed';
  const reason = /timeout|operation was aborted/.test(lowered)
    ? 'The model request timed out before a readable brief was produced.'
    : /fetch failed/.test(lowered)
      ? 'The model request failed before a readable brief was produced.'
      : /command failed/.test(lowered)
        ? 'The automation command failed before producing a readable brief.'
        : 'The run failed before producing a readable brief.';
  const commandMatch = raw.match(/(?:python3|bash|node|perl)\s+([^\s]+)/);
  const command = commandMatch ? path.basename(commandMatch[1]) : '';
  const lines = [`# ${title}`, '', reason];
  if (context.title) lines.push('', `Job: ${context.title}`);
  if (command) lines.push('', `Command: ${command}`);
  return {
    title: context.title || title,
    text: lines.join('\n'),
    summary: `${title}: ${reason}`,
  };
}

function healthFreshnessJsonToMarkdown(data, fallbackTitle) {
  if (!('healthy' in data) && !data.details?.daily_metrics_newest && !data.details?.api_live) return null;
  const details = data.details || {};
  const healthy = data.healthy === true || (Array.isArray(data.issues) && data.issues.length === 0);
  const title = fallbackTitle || 'HealthKit pipeline freshness check';
  const lines = [
    `# ${title}`,
    '',
    healthy ? 'HealthKit pipeline is healthy.' : 'HealthKit pipeline needs attention.',
  ];
  if (Array.isArray(data.issues) && data.issues.length) {
    lines.push('', '## Issues');
    for (const issue of data.issues.slice(0, 8)) lines.push(`- ${issue}`);
  }
  lines.push('', '## Freshness');
  if (details.api_live != null) lines.push(`- API live: ${details.api_live ? 'yes' : 'no'}`);
  if (details.last_post_ts) lines.push(`- Last phone post: ${details.last_post_ts}`);
  if (details.daily_metrics_newest) lines.push(`- Daily metrics: ${details.daily_metrics_newest}`);
  if (details.sleep_newest) lines.push(`- Sleep: ${details.sleep_newest}`);
  if (details.workouts_newest) lines.push(`- Workouts: ${details.workouts_newest}`);
  if (data.checked_at) lines.push('', `Checked: ${data.checked_at}`);
  return { title, text: lines.join('\n') };
}

function sensorFusionJsonToMarkdown(data, fallbackTitle) {
  if (!data.hypothesis && !data.results && !data.pipeline) return null;
  const question = data.hypothesis?.question || data.question || fallbackTitle;
  const title = /pressure/i.test(question) && /hrv/i.test(question)
    ? 'Pressure and HRV correlation'
    : humanLabel(data.hypothesis?.id || fallbackTitle || 'Sensor fusion result');
  const lines = [`# ${title}`];
  if (question) lines.push('', question);
  if (data.hypothesis?.status) lines.push('', `Status: ${humanLabel(data.hypothesis.status)}`);
  lines.push('', '## Readout');
  if (data.data?.latestHrvDate) lines.push(`- Latest HRV date: ${data.data.latestHrvDate}`);
  if (data.data?.healthFresh != null) lines.push(`- Health data: ${data.data.healthFresh ? 'fresh' : 'stale'}`);
  if (data.data?.pairedObservations != null) lines.push(`- Paired observations: ${data.data.pairedObservations}`);
  if (data.freshness?.reason) lines.push(`- Freshness: ${data.freshness.reason}`);
  if (data.results && typeof data.results === 'object') {
    lines.push('', '## Correlations');
    for (const [name, result] of Object.entries(data.results).slice(0, 8)) {
      if (!result || typeof result !== 'object') continue;
      const parts = [];
      if (result.r != null) parts.push(`r=${formatNumber(result.r, 3)}`);
      if (result.n != null) parts.push(`n=${result.n}`);
      if (parts.length) lines.push(`- ${humanLabel(name)}: ${parts.join(', ')}`);
    }
  }
  if (data.generatedAt) lines.push('', `Generated: ${data.generatedAt}`);
  return { title, text: lines.join('\n') };
}

function dailyInsightJsonToMarkdown(data, fallbackTitle) {
  const date = data.date || data.generated_at || data.timestamp || '';
  const title = data.title || (date ? `Daily insight - ${String(date).slice(0, 10)}` : fallbackTitle);
  const lines = [`# ${title}`];
  const topSignals = Array.isArray(data.top) && data.top.length
    ? data.top
    : Array.isArray(data.signals)
      ? data.signals.slice(0, 5)
      : [];
  if (topSignals.length) {
    lines.push('', '## What I am watching');
    for (const signal of topSignals.slice(0, 6)) {
      lines.push(`- ${signal.headline || signal.key || humanLabel(signal)}`);
    }
  }
  if (Array.isArray(data.rest) && data.rest.length) {
    lines.push('', '## Also noted');
    for (const signal of data.rest.slice(0, 6)) {
      lines.push(`- ${signal.headline || signal.key || humanLabel(signal)}`);
    }
  }
  if (data.summary) lines.push('', String(data.summary));
  if (data.generated_at) lines.push('', `Generated: ${data.generated_at}`);
  return topSignals.length || data.summary ? { title, text: lines.join('\n') } : null;
}

function genericJsonToMarkdown(data, fallbackTitle) {
  const title = data.title || data.name || fallbackTitle || 'Brief';
  const lines = [`# ${title}`];
  if (data.summary) lines.push('', String(data.summary));
  const entries = Object.entries(data)
    .filter(([key, value]) => !['title', 'name', 'summary', 'text', 'html'].includes(key) && value != null)
    .slice(0, 12);
  if (entries.length) lines.push('', '## Details');
  for (const [key, value] of entries) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`- ${humanLabel(key)}: ${value}`);
    } else if (Array.isArray(value)) {
      const headlines = value
        .filter((item) => item && typeof item === 'object' && (item.headline || item.title || item.summary))
        .map((item) => item.headline || item.title || item.summary)
        .slice(0, 5);
      if (headlines.length) {
        lines.push(`- ${humanLabel(key)}:`);
        for (const headline of headlines) lines.push(`  - ${headline}`);
      } else {
        lines.push(`- ${humanLabel(key)}: ${value.length} item${value.length === 1 ? '' : 's'}`);
      }
    } else if (typeof value === 'object') {
      const simple = Object.entries(value)
        .filter(([, nested]) => ['string', 'number', 'boolean'].includes(typeof nested))
        .slice(0, 4)
        .map(([nestedKey, nestedValue]) => `${humanLabel(nestedKey)} ${nestedValue}`);
      lines.push(`- ${humanLabel(key)}: ${simple.length ? simple.join(', ') : 'recorded'}`);
    }
  }
  return { title, text: lines.join('\n') };
}

function jsonDocumentToMarkdown(file, text, fallbackTitle) {
  const data = parseJsonObject(text);
  if (!data) {
    return { title: fallbackTitle, text };
  }

  return sensorFusionJsonToMarkdown(data, fallbackTitle)
    || healthFreshnessJsonToMarkdown(data, fallbackTitle)
    || dailyInsightJsonToMarkdown(data, fallbackTitle)
    || genericJsonToMarkdown(data, fallbackTitle);
}

function normalizeBriefText(rawText, context = {}) {
  const stripped = stripAgencyIntakePacket(rawText);
  const failure = humanizeMachineFailure(stripped, context);
  if (failure) return failure;
  const json = parseJsonObject(stripped);
  if (json) {
    return sensorFusionJsonToMarkdown(json, context.title)
      || healthFreshnessJsonToMarkdown(json, context.title)
      || dailyInsightJsonToMarkdown(json, context.title)
      || genericJsonToMarkdown(json, context.title);
  }
  return {
    title: context.title,
    text: stripped,
    summary: textSummary(stripped),
  };
}

function normalizeSessionMarkdown(rawText, fallbackTitle) {
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  const chatId = text.match(/\*\*chatId:\*\*\s*([^\n]+)/)?.[1]?.trim()
    || text.match(/chatId:\s*([^\n]+)/)?.[1]?.trim();
  const updated = text.match(/\*\*updated:\*\*\s*([^\n]+)/)?.[1]?.trim()
    || text.match(/updated:\s*([^\n]+)/)?.[1]?.trim();
  const userTurns = [...text.matchAll(/\*\*User:\*\*\s*([\s\S]*?)(?=\n\n\*\*(?:User|Agent):\*\*|$)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const agentTurns = [...text.matchAll(/\*\*Agent:\*\*\s*([\s\S]*?)(?=\n\n\*\*(?:User|Agent):\*\*|$)/g)]
    .map((match) => match[1].trim())
    .filter((turn) => turn && !/^\[Used tools:/i.test(turn));
  if (!chatId && !userTurns.length && !agentTurns.length) return null;

  const title = chatId ? `Conversation: ${chatId}` : fallbackTitle;
  const latestUser = userTurns[userTurns.length - 1] || '';
  const latestAgent = agentTurns[agentTurns.length - 1] || '';
  const lines = [`# ${title}`];
  if (updated) lines.push('', `Updated: ${updated}`);
  if (latestUser) lines.push('', '## Latest request', latestUser);
  if (latestAgent) lines.push('', '## Latest answer', latestAgent);
  return {
    title,
    text: lines.join('\n'),
    summary: textSummary([latestUser, latestAgent].filter(Boolean).join(' ')),
  };
}

function textSummary(text, maxLen = 180) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'No summary available.';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1).trim()}...` : cleaned;
}

function stripAgencyIntakePacket(text) {
  return String(text || '').replace(/\n?\s*AGENCY_INTAKE_PACKET:\s*[\s\S]*$/m, '').trim();
}

function fileTypeFromExt(file) {
  const ext = path.extname(file).toLowerCase();
  return ['.md', '.markdown', '.txt', '.json'].includes(ext);
}

function collectFiles(dir, maxFiles = 160) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && fileTypeFromExt(full)) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out
    .map((file) => ({ file, stat: safeStat(file) }))
    .filter((item) => item.stat?.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((item) => item.file);
}

function compactBriefItem(item) {
  if (!item || typeof item !== 'object') return item;
  const { text, html, ...rest } = item;
  return rest;
}

function jobShouldBeBrief(job, row) {
  const deliveryMode = job?.delivery?.mode || job?.deliveryMode || '';
  const kind = job?.payload?.kind || job?.kind || '';
  const status = row?.status || job?.state?.lastStatus || '';
  if (status && status !== 'ok' && status !== 'success') return true;
  if (kind === 'agentTurn') return true;
  return deliveryMode === 'summary' || deliveryMode === 'full';
}

class Home23BriefsService {
  constructor(options = {}) {
    this.home23Root = options.home23Root || path.resolve(__dirname, '..', '..', '..');
    this.agents = Array.isArray(options.agents) && options.agents.length ? options.agents : DEFAULT_AGENTS;
    this.logger = options.logger || console;
  }

  async list(options = {}) {
    const limit = normalizeLimit(options.limit);
    const agentFilter = options.agent ? String(options.agent).toLowerCase() : '';
    const typeFilter = options.type ? String(options.type).toLowerCase() : '';
    const compact = options.compact === true || options.compact === '1' || options.compact === 'true';
    const perAgentBudget = Math.max(limit, Math.min(MAX_LIMIT, limit * 2));

    let items = [];
    for (const agent of this.agents) {
      if (agentFilter && agentFilter !== agent) continue;
      items.push(...this.collectAgentFiles(agent, perAgentBudget));
      items.push(...this.collectCronBriefs(agent));
    }
    if (!agentFilter || agentFilter === 'forrest' || agentFilter === 'jerry') {
      items.push(...this.collectWorkerReceipts(agentFilter));
    }
    if (typeFilter) {
      items = items.filter((item) => item.type === typeFilter);
    }

    items.sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0) || a.title.localeCompare(b.title));
    const selected = items.slice(0, limit);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      count: selected.length,
      items: compact ? selected.map(compactBriefItem) : selected,
    };
  }

  async get(id) {
    const target = String(id || '');
    if (!target) return { ok: false, error: 'missing_id' };
    const list = await this.list({ limit: MAX_LIMIT });
    const item = list.items.find((candidate) => candidate.id === target);
    if (!item) return { ok: false, error: 'not_found' };
    return { ok: true, item };
  }

  collectAgentFiles(agent, maxItems = DEFAULT_LIMIT) {
    const items = [];
    const candidates = [];
    for (const source of AGENT_SOURCE_DIRS) {
      const dir = path.join(this.home23Root, 'instances', agent, source.rel);
      if (!exists(dir)) continue;
      for (const file of collectFiles(dir, Math.max(40, maxItems))) {
        const stat = safeStat(file);
        if (stat?.isFile()) candidates.push({ file, source, stat });
      }
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const { file, source, stat } of candidates.slice(0, maxItems)) {
      const rawText = safeReadText(file);
      if (!rawText.trim()) continue;
      const fallbackTitle = path.basename(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
      const normalized = source.type === 'session'
        ? (normalizeSessionMarkdown(rawText, fallbackTitle) || { title: markdownTitle(rawText, fallbackTitle), text: rawText })
        : path.extname(file).toLowerCase() === '.json'
        ? jsonDocumentToMarkdown(file, rawText, fallbackTitle)
        : { title: markdownTitle(rawText, fallbackTitle), text: rawText };
      const text = normalized.text;
      const title = markdownTitle(text, normalized.title || fallbackTitle);
      items.push({
        id: hashId(['file', agent, source.type, path.relative(this.home23Root, file), stat?.mtimeMs]),
        agent,
        type: source.type,
        title,
        timestamp: normalizeDate(null, stat?.mtimeMs || Date.now()),
        status: 'available',
        summary: normalized.summary || textSummary(text),
        text,
        html: renderMarkdown(text),
        sourcePath: file,
        provenance: {
          kind: 'agent-file',
          sourcePath: file,
          relPath: path.relative(this.home23Root, file),
        },
      });
    }
    return items;
  }

  collectCronBriefs(agent) {
    const jobsPath = path.join(this.home23Root, 'instances', agent, 'conversations', 'cron-jobs.json');
    const runsDir = path.join(this.home23Root, 'instances', agent, 'conversations', 'cron-runs');
    const jobs = safeReadJson(jobsPath, []);
    if (!Array.isArray(jobs) || !exists(runsDir)) return [];

    const items = [];
    for (const job of jobs) {
      const jobId = job?.id;
      if (!jobId) continue;
      const runLog = path.join(runsDir, `${jobId}.jsonl`);
      const row = readJsonlTail(runLog, 1)[0] || null;
      if (!row || !jobShouldBeBrief(job, row)) continue;

      const body = stripAgencyIntakePacket(row.response || row.output || row.error || row.message || '');
      if (!body && (row.status === 'ok' || row.status === 'success')) continue;
      const title = job.name || jobId;
      const timestamp = normalizeDate(row.timestamp || row.finishedAt || job.state?.lastRunAtMs, Date.now());
      const normalized = normalizeBriefText(body || `Status: ${row.status || job.state?.lastStatus || 'unknown'}`, {
        title,
        type: 'cron',
        status: row.status || job.state?.lastStatus || 'unknown',
      });
      const text = normalized.text;
      items.push({
        id: hashId(['cron', agent, jobId, row.runId || timestamp]),
        agent,
        type: 'cron',
        title: normalized.title || title,
        timestamp,
        status: row.status || job.state?.lastStatus || 'unknown',
        summary: normalized.summary || textSummary(text),
        text,
        html: renderMarkdown(text),
        sourcePath: runLog,
        provenance: {
          kind: 'cron-run',
          jobId,
          runId: row.runId || null,
          sourcePath: runLog,
          deliveryMode: job.delivery?.mode || null,
        },
      });
    }
    return items;
  }

  collectWorkerReceipts(agentFilter = '') {
    const workersDir = path.join(this.home23Root, 'instances', 'workers');
    if (!exists(workersDir)) return [];
    const items = [];
    let workers = [];
    try {
      workers = fs.readdirSync(workersDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return items;
    }
    for (const workerEntry of workers) {
      const runsDir = path.join(workersDir, workerEntry.name, 'runs');
      let runs = [];
      try {
        runs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch {
        continue;
      }
      for (const runEntry of runs.slice(-80)) {
        const receiptPath = path.join(runsDir, runEntry.name, 'receipt.json');
        const receipt = safeReadJson(receiptPath, null);
        if (!receipt) continue;
        const ownerAgent = String(receipt.ownerAgent || receipt.agent || 'house').toLowerCase();
        if (agentFilter && ownerAgent !== agentFilter) continue;
        const stat = safeStat(receiptPath);
        const worker = receipt.worker || workerEntry.name;
        const status = receipt.status || receipt.verifierStatus || 'recorded';
        const title = `${worker} worker: ${status}`;
        const rawSummary = receipt.summary || receipt.result?.summary || receipt.verifierSummary || 'Worker receipt recorded.';
        const timestamp = normalizeDate(receipt.finishedAt || receipt.completedAt || receipt.startedAt || receipt.createdAt, stat?.mtimeMs || Date.now());
        const normalized = normalizeBriefText(rawSummary, { title, type: 'worker', status });
        const text = [
          normalized.text.replace(/^# .+\n\n?/, ''),
          receipt.verifierStatus ? `Verifier: ${receipt.verifierStatus}` : '',
          receipt.runId ? `Run: ${receipt.runId}` : '',
        ].filter(Boolean).join('\n\n');
        items.push({
          id: hashId(['worker', worker, receipt.runId || runEntry.name, timestamp]),
          agent: ownerAgent,
          type: 'worker',
          title,
          timestamp,
          status,
          summary: normalized.summary || textSummary(text),
          text,
          html: renderMarkdown(`# ${title}\n\n${text}`),
          sourcePath: receiptPath,
          provenance: {
            kind: 'worker-receipt',
            worker,
            runId: receipt.runId || runEntry.name,
            sourcePath: receiptPath,
          },
        });
      }
    }
    return items;
  }
}

module.exports = {
  Home23BriefsService,
  renderMarkdown,
  stripAgencyIntakePacket,
};
