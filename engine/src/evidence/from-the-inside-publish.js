'use strict';

const fs = require('fs');
const path = require('path');
const {
  artifactFromBytes,
  artifactFromPath,
  buildEvidenceReceipt,
  safeReceiptPart,
  writeEvidenceReceipt,
} = require('./evidence-v1');
const { EventLedger } = require('../core/event-ledger');

const DEFAULT_PROJECT_DIR = path.resolve(__dirname, '..', '..', '..', 'instances', 'jerry', 'projects', 'from-the-inside');
const DEFAULT_SITE_DIR = '/Users/jtr/websites/olddeadshows.com';
const DEFAULT_PUBLIC_BASE_URL = 'https://olddeadshows.com';

async function verifyFromTheInsidePublish(opts = {}) {
  const issueNumber = normalizeIssueNumber(opts.issue);
  const padded = issueNumber.toString().padStart(3, '0');
  const projectDir = path.resolve(opts.projectDir || DEFAULT_PROJECT_DIR);
  const siteDir = path.resolve(opts.siteDir || DEFAULT_SITE_DIR);
  const publicBaseUrl = String(opts.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
  const createdAt = opts.createdAt || new Date().toISOString();

  const localIssuePath = path.join(projectDir, 'issues', `${padded}.json`);
  const siteIssuePath = path.join(siteDir, 'issues', `${padded}.json`);
  const publicHtmlPath = path.join(siteDir, 'public', 'issues', `${padded}.html`);
  const indexPath = path.join(siteDir, 'public', 'index.html');
  const feedPath = path.join(siteDir, 'public', 'feed.xml');
  const sitemapPath = path.join(siteDir, 'public', 'sitemap.xml');
  const nextIssuePath = path.join(projectDir, 'state', 'next-issue.txt');
  const publicIssueUrl = `${publicBaseUrl}/issues/${padded}.html`;

  const checks = [];
  const sourceArtifacts = [];
  const derivedArtifacts = [];
  let issue = null;
  let localIssueText = '';
  let htmlText = '';

  if (fs.existsSync(localIssuePath)) {
    checks.push({ name: 'source_exists', pass: true, detail: localIssuePath });
    sourceArtifacts.push(artifactFromPath(localIssuePath, { role: 'source_issue_json' }));
    try {
      localIssueText = fs.readFileSync(localIssuePath, 'utf8');
      issue = JSON.parse(localIssueText);
    } catch (err) {
      checks.push({ name: 'source_json_parses', pass: false, detail: err.message });
    }
  } else {
    checks.push({ name: 'source_exists', pass: false, detail: `missing: ${localIssuePath}` });
  }

  if (issue) {
    const schemaPass = Number(issue.number) === issueNumber
      && nonempty(issue.title)
      && nonempty(issue.date)
      && nonempty(issue.content);
    checks.push({
      name: 'source_schema',
      pass: schemaPass,
      detail: schemaPass ? 'number/title/date/content present' : 'number/title/date/content incomplete',
      observed: {
        number: issue.number ?? null,
        titlePresent: nonempty(issue.title),
        datePresent: nonempty(issue.date),
        contentChars: String(issue.content || '').length,
      },
    });
    checks.push({
      name: 'published_flag_true',
      pass: issue.published === true,
      detail: issue.published === true ? 'published=true' : `published=${String(issue.published)}`,
    });
  }

  const siteJsonExists = fs.existsSync(siteIssuePath);
  checks.push({
    name: 'site_json_exists',
    pass: siteJsonExists,
    detail: siteJsonExists ? siteIssuePath : `missing: ${siteIssuePath}`,
  });
  if (siteJsonExists) {
    derivedArtifacts.push(artifactFromPath(siteIssuePath, { role: 'public_issue_json' }));
    const siteIssueText = fs.readFileSync(siteIssuePath, 'utf8');
    checks.push({
      name: 'site_json_matches_source',
      pass: localIssueText.length > 0 && siteIssueText === localIssueText,
      detail: localIssueText.length > 0 && siteIssueText === localIssueText
        ? 'copied JSON bytes match source'
        : 'public JSON differs from source JSON bytes',
    });
  }

  const htmlExists = fs.existsSync(publicHtmlPath);
  checks.push({
    name: 'html_exists',
    pass: htmlExists,
    detail: htmlExists ? publicHtmlPath : `missing: ${publicHtmlPath}`,
  });
  if (htmlExists) {
    htmlText = fs.readFileSync(publicHtmlPath, 'utf8');
    derivedArtifacts.push(artifactFromPath(publicHtmlPath, { role: 'public_issue_html' }));
    const htmlCheck = issue ? htmlMatchesIssue(htmlText, issue) : { pass: false, detail: 'source issue unavailable' };
    checks.push({ name: 'html_matches_issue', ...htmlCheck });
  }

  addContainsCheck(checks, derivedArtifacts, {
    name: 'homepage_updated',
    filePath: indexPath,
    role: 'public_homepage',
    needles: [`/issues/${padded}.html`, issue?.title || ''],
  });
  addContainsCheck(checks, derivedArtifacts, {
    name: 'feed_updated',
    filePath: feedPath,
    role: 'public_feed',
    needles: [publicIssueUrl],
  });
  addContainsCheck(checks, derivedArtifacts, {
    name: 'sitemap_updated',
    filePath: sitemapPath,
    role: 'public_sitemap',
    needles: [publicIssueUrl],
  });

  const nextIssue = readIntFile(nextIssuePath);
  checks.push({
    name: 'next_issue_incremented',
    pass: Number.isFinite(nextIssue) && nextIssue > issueNumber,
    detail: Number.isFinite(nextIssue)
      ? `next=${nextIssue}`
      : `missing or invalid: ${nextIssuePath}`,
    observed: { nextIssue },
  });

  if (opts.checkRemote) {
    const remote = await fetchRemote(publicIssueUrl, opts.fetchText);
    if (remote.ok) {
      derivedArtifacts.push(artifactFromBytes({
        role: 'public_issue_html_remote',
        url: publicIssueUrl,
        bytes: remote.body,
      }));
      const htmlCheck = issue ? htmlMatchesIssue(remote.body, issue) : { pass: false, detail: 'source issue unavailable' };
      checks.push({
        name: 'remote_html_matches_issue',
        pass: htmlCheck.pass,
        detail: `${remote.status} ${htmlCheck.detail || ''}`.trim(),
        observed: { status: remote.status },
      });
    } else {
      checks.push({
        name: 'remote_html_matches_issue',
        pass: false,
        detail: remote.detail,
        observed: { status: remote.status ?? null },
      });
    }
  }

  const receipt = buildEvidenceReceipt({
    actor: opts.actor || 'jerry',
    action: 'publish_issue',
    subject: `from-the-inside/${padded}`,
    sourceSurface: {
      type: 'from-the-inside-publish',
      projectDir,
      siteDir,
      publicIssueUrl,
    },
    sourceArtifacts,
    derivedArtifacts,
    checks,
    createdAt,
    correctionOf: opts.correctionOf || null,
    metadata: {
      issue: issueNumber,
      padded,
      title: issue?.title || null,
      slug: issue?.slug || null,
      publicIssueUrl,
    },
  });

  let receiptPath = null;
  let indexReceiptPath = null;
  if (opts.writeReceipt || opts.writeEventLog) {
    receiptPath = opts.receiptPath
      ? path.resolve(opts.receiptPath)
      : path.join(projectDir, 'receipts', 'publish', `${padded}.evidence.json`);
    indexReceiptPath = opts.indexPath
      ? path.resolve(opts.indexPath)
      : path.join(projectDir, 'receipts', 'publish', 'index.jsonl');
    writeEvidenceReceipt({ receipt, receiptPath, indexPath: indexReceiptPath });
  }

  let event = null;
  let eventLogPath = null;
  if (opts.writeEventLog) {
    eventLogPath = opts.eventLogPath
      ? path.resolve(opts.eventLogPath)
      : path.join(projectDir, 'events', 'state-events.jsonl');
    const ledger = new EventLedger(projectDir, { ledgerPath: eventLogPath, logger: opts.logger || null });
    event = ledger.recordStateTransition({
      eventType: receipt.result === 'pass' ? 'issue.published' : 'issue.publish_verification_failed',
      subject: `from-the-inside/${padded}`,
      actor: opts.actor || 'jerry',
      payload: {
        issue: issueNumber,
        title: issue?.title || null,
        publicIssueUrl,
        checks: receipt.checks.map((check) => ({ name: check.name, pass: check.pass })),
      },
      evidence: {
        receiptId: receipt.receiptId,
        receiptPath,
        result: receipt.result,
        claimLevel: receipt.claimLevel,
      },
      sourceSurface: receipt.sourceSurface,
      occurredAt: receipt.createdAt,
    });
  }

  return { receipt, receiptPath, indexPath: indexReceiptPath, event, eventLogPath };
}

function normalizeIssueNumber(issue) {
  const n = Number.parseInt(String(issue || '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error('issue must be a positive number');
  return n;
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readIntFile(filePath) {
  try {
    return Number.parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
  } catch {
    return NaN;
  }
}

function addContainsCheck(checks, artifacts, { name, filePath, role, needles }) {
  if (!fs.existsSync(filePath)) {
    checks.push({ name, pass: false, detail: `missing: ${filePath}` });
    return;
  }
  artifacts.push(artifactFromPath(filePath, { role }));
  const raw = fs.readFileSync(filePath, 'utf8');
  const hay = normalizeText(raw);
  const missing = needles
    .filter(Boolean)
    .filter((needle) => !hay.includes(normalizeText(needle)));
  checks.push({
    name,
    pass: missing.length === 0,
    detail: missing.length === 0 ? 'updated' : `missing: ${missing.join(', ')}`,
  });
}

function htmlMatchesIssue(html, issue) {
  const text = normalizeText(stripTags(decodeHtml(html)));
  const title = normalizeText(issue.title || '');
  const tail = normalizeText(issueTailSnippet(issue.content || ''));
  const missing = [];
  if (title && !text.includes(title)) missing.push('title');
  if (tail && !text.includes(tail)) missing.push('body ending');
  return {
    pass: missing.length === 0,
    detail: missing.length === 0
      ? 'HTML contains expected title and body ending'
      : `HTML missing ${missing.join(', ')}`,
    observed: { tailSnippet: tail || null },
  };
}

function issueTailSnippet(content) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 20);
  const tail = lines[lines.length - 1] || String(content || '').trim();
  return stripMarkdown(tail).slice(-160);
}

function stripMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .trim();
}

function stripTags(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeText(text) {
  return decodeHtml(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function fetchRemote(url, fetchText) {
  try {
    if (typeof fetchText === 'function') {
      const body = await fetchText(url);
      return { ok: true, status: 200, body: String(body || '') };
    }
    const res = await fetch(url);
    const body = await res.text();
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body,
      detail: res.status >= 200 && res.status < 300 ? 'ok' : `unexpected status ${res.status}`,
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

module.exports = {
  DEFAULT_PROJECT_DIR,
  DEFAULT_SITE_DIR,
  verifyFromTheInsidePublish,
  _test: {
    htmlMatchesIssue,
    issueTailSnippet,
    normalizeText,
    safeReceiptPart,
  },
};
