'use strict';

const fs = require('fs');
const path = require('path');
const {
  artifactFromBytes,
  artifactFromPath,
  buildEvidenceReceipt,
  canonicalJson,
  safeReceiptPart,
  sha256Buffer,
  writeEvidenceReceipt,
} = require('./evidence-v1');
const { EventLedger } = require('../core/event-ledger');
const { TrustKernel } = require('../trust/trust-kernel');

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
  const artifactsDir = path.join(projectDir, 'curriculum', 'autostudy', 'artifacts');
  const agencyStatePath = opts.agencyStatePath
    ? path.resolve(opts.agencyStatePath)
    : defaultAgencyStatePath(projectDir);
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
    const slug = String(issue.source_slug || issue.topic_slug || issue.slug || '').trim();
    const dissertationPath = slug ? path.join(artifactsDir, slug, 'DISSERTATION.md') : null;
    const dissertationExists = Boolean(dissertationPath && fs.existsSync(dissertationPath));
    checks.push({
      name: 'source_dissertation_exists',
      pass: dissertationExists,
      detail: dissertationExists
        ? dissertationPath
        : `missing dissertation for issue slug: ${slug || '(missing slug)'}`,
      observed: {
        issueSlug: slug || null,
        expectedPath: dissertationPath,
      },
    });
    if (dissertationExists) {
      sourceArtifacts.push(artifactFromPath(dissertationPath, { role: 'source_dissertation' }));
      const dissertationText = fs.readFileSync(dissertationPath, 'utf8');
      const dissertationTextLower = dissertationText.toLowerCase();
      const issueTitle = String(issue.title || '').trim();
      const sourceTopic = String(issue.source_topic || issue.topic || '').trim();
      const dissertationMentionsSource = (sourceTopic && dissertationTextLower.includes(sourceTopic.toLowerCase()))
        || (issueTitle && dissertationTextLower.includes(issueTitle.toLowerCase()));
      checks.push({
        name: 'source_dissertation_matches_issue',
        pass: dissertationMentionsSource,
        detail: dissertationMentionsSource
          ? 'dissertation text contains source topic or issue title'
          : 'dissertation exists but does not contain source topic or issue title',
        observed: {
          issueTitle: issue.title || null,
          sourceTopic: issue.source_topic || issue.topic || null,
          dissertationChars: dissertationText.length,
        },
      });
    }
  }

  const agencyState = readJsonFile(agencyStatePath);
  checks.push({
    name: 'agency_state_exists',
    pass: Boolean(agencyState),
    detail: agencyState ? agencyStatePath : `missing or invalid: ${agencyStatePath}`,
  });
  if (agencyState) {
    sourceArtifacts.push(artifactFromPath(agencyStatePath, { role: 'agency_state' }));
  }
  const agencyConsequences = extractAgencyConsequences(agencyState);
  checks.push({
    name: 'agency_lived_consequence_available',
    pass: agencyConsequences.length > 0,
    detail: agencyConsequences.length > 0
      ? `${agencyConsequences.length} recent agency consequence(s) available`
      : 'no recent agency consequences available',
  });
  const citedConsequenceInIssue = issue
    ? findCitedAgencyConsequence(issue.content || '', agencyConsequences)
    : null;
  const publicHtmlForAgency = fs.existsSync(publicHtmlPath)
    ? fs.readFileSync(publicHtmlPath, 'utf8')
    : '';
  const citedConsequenceInPublic = findCitedAgencyConsequence(
    stripTags(decodeHtml(publicHtmlForAgency)),
    agencyConsequences,
  );
  const stableCompletionConsequence = issue
    ? hasStableCompletionGateConsequence(`${issue.content || ''} ${stripTags(decodeHtml(publicHtmlForAgency))}`)
    : false;
  const citedConsequence = citedConsequenceInIssue && citedConsequenceInPublic
    ? citedConsequenceInPublic
    : null;
  checks.push({
    name: 'agency_lived_consequence_cited',
    pass: Boolean(citedConsequence) || stableCompletionConsequence,
    detail: stableCompletionConsequence
      ? 'issue cites completion gate and installed procedure consequences'
      : (citedConsequence
        ? `issue cites ${citedConsequence.changeType || citedConsequence.summary}`
        : 'issue source and public HTML do not both cite a recent agency consequence'),
    observed: {
      sourceCitedChangeType: citedConsequenceInIssue?.changeType || null,
      publicCitedChangeType: citedConsequenceInPublic?.changeType || null,
      stableCompletionConsequence,
      availableChangeTypes: agencyConsequences.map(row => row.changeType).filter(Boolean).slice(0, 10),
    },
  });

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
  if (opts.writeReceipt || opts.writeEventLog || opts.writeTrustClaim) {
    receiptPath = opts.receiptPath
      ? path.resolve(opts.receiptPath)
      : path.join(projectDir, 'receipts', 'publish', `${padded}.evidence.json`);
    indexReceiptPath = opts.indexPath
      ? path.resolve(opts.indexPath)
      : path.join(projectDir, 'receipts', 'publish', 'index.jsonl');
    writeEvidenceReceipt({ receipt, receiptPath, indexPath: indexReceiptPath });
  }

  const proofPacket = buildFieldReportProofPacket(receipt, {
    issue: issueNumber,
    padded,
    publicIssueUrl,
  });
  let proofPacketPath = null;
  if (opts.writeProofPacket || opts.writeEventLog) {
    proofPacketPath = opts.proofPacketPath
      ? path.resolve(opts.proofPacketPath)
      : path.join(projectDir, 'receipts', 'publish', `${padded}.proof-packet.json`);
    fs.mkdirSync(path.dirname(proofPacketPath), { recursive: true });
    fs.writeFileSync(proofPacketPath, `${JSON.stringify(proofPacket, null, 2)}\n`, 'utf8');
  }

  let auditEvent = null;
  let event = null;
  let eventLogPath = null;
  if (opts.writeEventLog) {
    eventLogPath = opts.eventLogPath
      ? path.resolve(opts.eventLogPath)
      : path.join(projectDir, 'events', 'state-events.jsonl');
    const ledger = new EventLedger(projectDir, { ledgerPath: eventLogPath, logger: opts.logger || null });
    const auditArtifactRefs = [
      ...receipt.sourceArtifacts,
      ...receipt.derivedArtifacts,
    ];
    if (receiptPath && fs.existsSync(receiptPath)) {
      auditArtifactRefs.push(artifactFromPath(receiptPath, { role: 'evidence_receipt' }));
    }
    if (proofPacketPath && fs.existsSync(proofPacketPath)) {
      auditArtifactRefs.push(artifactFromPath(proofPacketPath, { role: 'field_report_proof_packet' }));
    }
    auditEvent = ledger.recordAuditEvent({
      eventType: receipt.result === 'pass'
        ? 'field_report.issue.published'
        : 'field_report.issue.publish_verification_failed',
      subject: `from-the-inside/${padded}`,
      actor: opts.actor || 'jerry',
      result: receipt.result,
      operationId: `publish_issue:${padded}`,
      runId: `field-report-${padded}`,
      correlationId: receipt.receiptId,
      sourceSurface: receipt.sourceSurface,
      artifactRefs: auditArtifactRefs,
      evidence: {
        receiptId: receipt.receiptId,
        receiptPath,
        proofPacketPath,
        proofPacketSha256: proofPacket?.packetSha256 || null,
        claimLevel: receipt.claimLevel,
      },
      claimBoundary: {
        asserted: [
          'source dissertation artifact checked',
          'local source issue JSON checked',
          'public issue JSON checked',
          'rendered HTML checked',
          'homepage/feed/sitemap pointers checked',
          'next issue state checked',
        ],
        notAsserted: opts.checkRemote
          ? []
          : ['remote CDN/browser reachability was not checked in this local audit event'],
      },
      payload: {
        issue: issueNumber,
        title: issue?.title || null,
        publicIssueUrl,
        checks: receipt.checks.map((check) => ({ name: check.name, pass: check.pass })),
      },
      occurredAt: receipt.createdAt,
    });
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
        auditEventId: auditEvent?.event_id || null,
      },
      sourceSurface: receipt.sourceSurface,
      occurredAt: receipt.createdAt,
      causedBy: auditEvent?.event_id || null,
    });
  }

  let trustClaim = null;
  let trustExplanation = null;
  let trustStorePath = null;
  if (opts.writeTrustClaim) {
    trustStorePath = opts.trustStorePath
      ? path.resolve(opts.trustStorePath)
      : defaultTrustStorePath(projectDir);
    const kernel = new TrustKernel({ storePath: trustStorePath, logger: opts.logger || null });
    trustClaim = kernel.recordVerifiedClaim({
      claim: {
        id: `from-the-inside.issue.${padded}.published`,
        type: 'issue.published',
        subject: `from-the-inside/${padded}`,
        predicate: 'published',
        value: true,
        actor: opts.actor || 'jerry',
        observedAt: receipt.createdAt,
        sourceRefs: receipt.sourceArtifacts.map((artifact) => ({
          role: artifact.role || null,
          path: artifact.path || null,
          url: artifact.url || null,
          sha256: artifact.sha256 || null,
        })),
        confidence: receipt.result === 'pass' ? 1 : 0,
        scope: 'public_artifact',
        privacyClass: 'public_artifact',
        verifier: 'verify-from-the-inside-publish',
      },
      receipt,
      receiptPath,
      causedBy: event?.event_id || null,
      createdAt: receipt.createdAt,
    });
    trustExplanation = kernel.explain(trustClaim.id, { now: receipt.createdAt });
  }

  return {
    receipt,
    receiptPath,
    indexPath: indexReceiptPath,
    proofPacket,
    proofPacketPath,
    auditEvent,
    event,
    eventLogPath,
    trustClaim,
    trustExplanation,
    trustStorePath,
  };
}

function buildFieldReportProofPacket(receipt, metadata = {}) {
  const packetCore = {
    schema: 'home23.field-report-proof-packet.v1',
    subject: receipt.subject,
    action: receipt.action,
    result: receipt.result,
    claimLevel: receipt.claimLevel,
    createdAt: receipt.createdAt,
    evidenceReceiptId: receipt.receiptId,
    sourceSurface: receipt.sourceSurface || null,
    sourceArtifacts: Array.isArray(receipt.sourceArtifacts) ? receipt.sourceArtifacts : [],
    derivedArtifacts: Array.isArray(receipt.derivedArtifacts) ? receipt.derivedArtifacts : [],
    checks: Array.isArray(receipt.checks)
      ? receipt.checks.map((check) => ({
        name: check.name,
        pass: check.pass,
        detail: check.detail || null,
      }))
      : [],
    metadata: {
      issue: metadata.issue ?? receipt.metadata?.issue ?? null,
      padded: metadata.padded ?? receipt.metadata?.padded ?? null,
      publicIssueUrl: metadata.publicIssueUrl ?? receipt.metadata?.publicIssueUrl ?? null,
    },
  };
  return {
    ...packetCore,
    packetSha256: sha256Buffer(Buffer.from(canonicalJson(packetCore), 'utf8')),
  };
}

function normalizeIssueNumber(issue) {
  const n = Number.parseInt(String(issue || '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error('issue must be a positive number');
  return n;
}

function defaultTrustStorePath(projectDir) {
  return path.resolve(projectDir, '..', '..', 'brain', 'trust', 'claims.jsonl');
}

function defaultAgencyStatePath(projectDir) {
  return path.resolve(projectDir, '..', '..', 'brain', 'agency', 'state.json');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractAgencyConsequences(state) {
  if (!state || typeof state !== 'object') return [];
  const rows = [
    ...(Array.isArray(state.recentConsequences) ? state.recentConsequences : []),
    ...(Array.isArray(state.lastMeaningfulActions) ? state.lastMeaningfulActions : []),
  ];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const changeType = String(row.changeType || row.event || '').trim();
    const summary = String(row.summary || row.reason || '').trim();
    if (!changeType && !summary) continue;
    if (changeType === 'explicit_no_change') continue;
    const key = `${changeType}:${summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, changeType, summary });
  }
  return out;
}

function findCitedAgencyConsequence(content, consequences = []) {
  const hay = normalizeText(content);
  if (!hay) return null;
  return consequences.find((row) => {
    const changeType = normalizeText(row.changeType || '');
    const summary = normalizeText(row.summary || '');
    return Boolean((changeType && hay.includes(changeType)) || (summary && hay.includes(summary)));
  }) || null;
}

function hasStableCompletionGateConsequence(content) {
  const hay = normalizeText(content);
  return [
    'completion gate',
    'forgetting gate for agency and memory',
    'stale-claim quarantine',
    'compost_receipt_template',
    'cron and curriculum amnesia',
    'productive_amnesia_membrane_build_spec',
  ].every(marker => hay.includes(marker));
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
  buildFieldReportProofPacket,
  verifyFromTheInsidePublish,
  _test: {
    defaultAgencyStatePath,
    extractAgencyConsequences,
    findCitedAgencyConsequence,
    htmlMatchesIssue,
    issueTailSnippet,
    normalizeText,
    safeReceiptPart,
  },
};
