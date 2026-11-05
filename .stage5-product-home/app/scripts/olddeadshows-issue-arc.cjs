#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ISSUES_DIR = process.env.OLDDEADSHOWS_ISSUES_DIR || path.join(process.cwd(), 'issues');
const DEFAULT_MARKDOWN_OUT = path.join(process.cwd(), 'docs/design/STEP26-FROM-THE-INSIDE-ISSUE-ARC-MAP.md');
const DEFAULT_JSON_OUT = path.join(process.cwd(), 'docs/design/step26-from-the-inside-issue-arc-map.json');

const THEMES = [
  {
    id: 'provenance-auditability',
    label: 'Provenance, Receipts, And Auditability',
    keywords: ['audit', 'receipt', 'receipts', 'evidence', 'verifier', 'verification', 'manifest', 'hash', 'merkle', 'trail', 'prove', 'proof', 'provenance'],
  },
  {
    id: 'memory-coherence',
    label: 'Memory Coherence And Corrections',
    keywords: ['memory', 'amnesia', 'context', 'coherence', 'correction', 'tombstone', 'crdt', 'eventual consistency', 'state', 'projection', 'authority'],
  },
  {
    id: 'operator-governance',
    label: 'Operator Governance And Autonomy',
    keywords: ['governance', 'autonomous', 'autonomy', 'agent', 'agents', 'decision', 'intervention', 'authority', 'sovereignty', 'ethics', 'trust'],
  },
  {
    id: 'runtime-stewardship',
    label: 'Runtime Stewardship And Resource Discipline',
    keywords: ['cron', 'schedule', 'resource', 'memory pressure', 'swap', 'disk', 'cpu', 'persistence', 'pipeline', 'queue', 'failure', 'maintenance', 'infrastructure'],
  },
  {
    id: 'home-sensing',
    label: 'Home, Body, And Sensing Loops',
    keywords: ['home automation', 'house', 'sensor', 'pressure', 'barometric', 'rf', 'wifi', 'health', 'hrv', 'interoceptive', 'body', 'insula'],
  },
  {
    id: 'learning-curriculum',
    label: 'Learning Loop And Curriculum Use',
    keywords: ['curriculum', 'learning', 'study', 'topic', 'dissertation', 'analogy', 'cross-domain', 'optimization', 'ethnobotany'],
  },
  {
    id: 'publishing-distribution',
    label: 'Publishing, Distribution, And Output Value',
    keywords: ['newsletter', 'subscriber', 'audience', 'publish', 'publishing', 'distribution', 'rss', 'stripe', 'resend', 'marketing', 'output'],
  },
];

const DIRECTIVE_PATTERNS = [
  /\bmust\b/i,
  /\bneeds?\b/i,
  /\bshould\b/i,
  /\bhas to\b/i,
  /\bhave to\b/i,
  /\bthe fix\b/i,
  /\bnext (step|handle|move)\b/i,
  /\bthe real (job|lesson|answer|constraint|requirement)\b/i,
  /\bthe point\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bcannot\b/i,
  /\bcan’t\b/i,
];

function readIssue(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const number = normalizeNumber(parsed.number, file);
  const content = String(parsed.content || parsed.preview || parsed.description || '').trim();
  return {
    file,
    number,
    title: String(parsed.title || `Issue ${number}`).trim(),
    date: parsed.date || parsed.publishedAt || parsed.published || null,
    slug: parsed.slug || null,
    content,
    summary: String(parsed.description || parsed.preview || '').replace(/\s+/g, ' ').trim(),
  };
}

function normalizeNumber(value, file) {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  const fromName = path.basename(file).match(/^(\d+)/);
  return fromName ? Number(fromName[1]) : null;
}

function listIssues(issuesDir = DEFAULT_ISSUES_DIR) {
  return fs.readdirSync(issuesDir)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => readIssue(path.join(issuesDir, name)))
    .sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999) || a.title.localeCompare(b.title));
}

function classifyIssue(issue) {
  const haystack = `${issue.title}\n${issue.summary}\n${issue.content}`.toLowerCase();
  const matches = THEMES.map((theme) => {
    const hits = theme.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
    return { id: theme.id, label: theme.label, hits };
  }).filter((theme) => theme.hits.length > 0);

  return matches.length
    ? matches.sort((a, b) => b.hits.length - a.hits.length || a.label.localeCompare(b.label))
    : [{ id: 'unclassified', label: 'Unclassified', hits: [] }];
}

function extractDirectives(issue) {
  const sentences = splitSentences(issue.content || issue.summary || issue.title);
  const scored = [];
  for (const sentence of sentences) {
    const compact = sentence.replace(/\s+/g, ' ').trim();
    if (compact.length < 35) continue;
    const directive = DIRECTIVE_PATTERNS.some((pattern) => pattern.test(compact));
    const themeHit = THEMES.some((theme) => theme.keywords.some((keyword) => compact.toLowerCase().includes(keyword.toLowerCase())));
    if (!directive && !themeHit) continue;
    const score = Number(directive) * 2 + Number(themeHit) + Math.min(2, Math.floor(compact.length / 180));
    scored.push({ text: compactText(compact, 260), score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .slice(0, 4)
    .map((item) => item.text);
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function compactText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function buildArc(issuesDir = DEFAULT_ISSUES_DIR) {
  const issues = listIssues(issuesDir);
  const rows = issues.map((issue) => {
    const themes = classifyIssue(issue);
    return {
      number: issue.number,
      title: issue.title,
      date: issue.date,
      slug: issue.slug,
      file: issue.file,
      themes: themes.map((theme) => theme.id),
      themeLabels: themes.map((theme) => theme.label),
      directives: extractDirectives(issue),
      summary: compactText(issue.summary || issue.content, 240),
    };
  });

  const missing = [];
  const numbered = rows.map((row) => row.number).filter((number) => Number.isSafeInteger(number));
  const max = Math.max(...numbered, 0);
  for (let n = 1; n <= max; n += 1) {
    if (!numbered.includes(n)) missing.push(n);
  }

  const themes = {};
  for (const row of rows) {
    for (const theme of row.themes) {
      themes[theme] ||= [];
      themes[theme].push(row.number);
    }
  }

  return {
    schema: 'home23.from-the-inside.issue-arc.v1',
    generatedAt: new Date().toISOString(),
    sourceDir: issuesDir,
    count: rows.length,
    range: { first: numbered[0] || null, last: numbered[numbered.length - 1] || null, missing },
    rows,
    themes,
  };
}

function renderMarkdown(arc) {
  const themeLines = THEMES.map((theme) => {
    const nums = arc.themes[theme.id] || [];
    return `- **${theme.label}:** ${nums.length ? nums.map((n) => `#${String(n).padStart(3, '0')}`).join(', ') : 'none'}`;
  }).join('\n');

  const issueLines = arc.rows.map((row) => {
    const directives = row.directives.length
      ? row.directives.map((directive) => `  - ${directive}`).join('\n')
      : '  - No directive-like sentence extracted by the deterministic pass; review manually before treating this issue as exhausted.';
    return `### #${String(row.number).padStart(3, '0')} ${row.title}\n\n- **Date:** ${row.date || 'unknown'}\n- **Themes:** ${row.themeLabels.join(', ')}\n- **Source:** \`${row.file}\`\n- **Summary:** ${row.summary || 'No summary text recorded.'}\n- **Extracted incorporation notes:**\n${directives}`;
  }).join('\n\n');

  return `# From The Inside Issue Arc Map\n\n` +
    `Generated from \`${arc.sourceDir}\`.\n\n` +
    `This is a deterministic extraction pass over the published issue JSON files. It is a working map for Home23 implementation, not a substitute for human/agent review of the full prose. The map intentionally keeps source file paths and extracted directive sentences so later implementation can trace every claim back to the issue artifact.\n\n` +
    `## Coverage\n\n` +
    `- Issues read: ${arc.count}\n` +
    `- Number range: #${String(arc.range.first).padStart(3, '0')} through #${String(arc.range.last).padStart(3, '0')}\n` +
    `- Missing issue numbers in this folder: ${arc.range.missing.length ? arc.range.missing.map((n) => `#${String(n).padStart(3, '0')}`).join(', ') : 'none'}\n\n` +
    `## Theme Arc\n\n${themeLines}\n\n` +
    `## Implementation Spine\n\n` +
    `1. Treat Good Life and operator surfaces as projections with provenance, not authority-free summaries.\n` +
    `2. Attach receipts and verifier evidence to claims that can drive action.\n` +
    `3. Preserve corrections as tombstones that demote old governing claims without deleting history.\n` +
    `4. Make active work manifest-first: allowed transition, source surface, verifier, receipt, and output artifact.\n` +
    `5. Keep resource stewardship, cron sovereignty, and persistence health inside the same operator loop instead of separate report-only pages.\n` +
    `6. Turn curriculum outputs into reusable system doctrine only when a source issue and implementation receipt can both be named.\n\n` +
    `## Issues\n\n${issueLines}\n`;
}

function writeArc({ issuesDir = DEFAULT_ISSUES_DIR, markdownOut = DEFAULT_MARKDOWN_OUT, jsonOut = DEFAULT_JSON_OUT } = {}) {
  const arc = buildArc(issuesDir);
  fs.mkdirSync(path.dirname(markdownOut), { recursive: true });
  fs.writeFileSync(markdownOut, renderMarkdown(arc));
  fs.writeFileSync(jsonOut, `${JSON.stringify(arc, null, 2)}\n`);
  return { arc, markdownOut, jsonOut };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--issues-dir') options.issuesDir = argv[++i];
    else if (arg === '--markdown-out') options.markdownOut = argv[++i];
    else if (arg === '--json-out') options.jsonOut = argv[++i];
    else if (arg === '--write') options.write = true;
    else if (arg === '--json') options.json = true;
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.write) {
    const { arc, markdownOut, jsonOut } = writeArc(options);
    console.log(`wrote ${arc.count} issues`);
    console.log(markdownOut);
    console.log(jsonOut);
  } else {
    const arc = buildArc(options.issuesDir);
    process.stdout.write(options.json ? `${JSON.stringify(arc, null, 2)}\n` : renderMarkdown(arc));
  }
}

module.exports = {
  buildArc,
  classifyIssue,
  extractDirectives,
  listIssues,
  renderMarkdown,
  writeArc,
};
