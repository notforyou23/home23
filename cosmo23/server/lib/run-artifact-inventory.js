const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_FILES = 1200;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

const SOURCE_RECEIPT_NAMES = new Set([
  'sources.json',
  'source_backbone_status.json',
  'source_attempts.jsonl',
  'source_crossing.jsonl',
  'source-route-receipts.json',
  'source-routes.json',
  'search-receipts.json',
  'search-receipts.jsonl'
]);

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readTextIfSmall(filePath, maxBytes = DEFAULT_MAX_READ_BYTES) {
  const stat = safeStat(filePath);
  if (!stat?.isFile() || stat.size > maxBytes) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonIfSmall(filePath, maxBytes = DEFAULT_MAX_READ_BYTES) {
  const text = readTextIfSmall(filePath, maxBytes);
  if (text === null) return { ok: false, value: null, reason: 'unreadable_or_too_large' };
  try {
    return { ok: true, value: JSON.parse(text), reason: null };
  } catch (error) {
    return { ok: false, value: null, reason: error.message };
  }
}

function listFilesRecursive(root, options = {}) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const base = options.base || root;
  const files = [];
  const stack = [root];

  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (!entry || entry.name === '.DS_Store' || entry.name.startsWith('.git')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = safeStat(fullPath);
      if (!stat) continue;
      files.push({
        path: fullPath,
        relativePath: normalizeSlash(path.relative(base, fullPath)),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  return files;
}

function countUrls(value, seen = new Set()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value.trim())) seen.add(value.trim());
    return seen;
  }
  if (Array.isArray(value)) {
    for (const item of value) countUrls(item, seen);
    return seen;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) countUrls(child, seen);
  }
  return seen;
}

function firstArrayLength(value, keys) {
  if (!value || typeof value !== 'object') return 0;
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  return 0;
}

function classifyRunFile(file) {
  const rel = normalizeSlash(file.relativePath);
  const basename = path.basename(rel);
  const ext = path.extname(rel).toLowerCase();

  if (rel.startsWith('outputs/raw-anecdotes/')) return 'raw_anecdote';
  if (rel.startsWith('outputs/extracted/')) return 'extracted_record';
  if (rel.startsWith('exports/')) return 'query_export';
  if (SOURCE_RECEIPT_NAMES.has(basename)) return 'source_receipt';
  if (/\/source[_-]/i.test(rel) || /source[_-]/i.test(basename)) return 'source_receipt';
  if (basename === 'research_summary.md') return 'research_summary';
  if (rel.startsWith('outputs/') && ext === '.md') return 'deliverable_markdown';
  if (rel.startsWith('outputs/')) return 'output_file';
  return 'run_file';
}

function summarizeJsonFile(file, maxReadBytes) {
  const parsed = readJsonIfSmall(file.path, maxReadBytes);
  if (!parsed.ok) {
    return {
      valid: false,
      reason: parsed.reason,
      recordCount: 0,
      urlCount: 0,
      status: null
    };
  }

  return {
    valid: true,
    reason: null,
    recordCount: firstArrayLength(parsed.value, ['entries', 'records', 'results', 'items', 'anecdotes', 'quotes', 'sources']),
    urlCount: countUrls(parsed.value).size,
    status: parsed.value?.status || parsed.value?.outcome || parsed.value?.result || null
  };
}

function summarizeJsonlFile(file, maxReadBytes) {
  const text = readTextIfSmall(file.path, maxReadBytes);
  if (text === null) {
    return { valid: false, reason: 'unreadable_or_too_large', recordCount: 0, urlCount: 0, status: null };
  }
  const rows = text.split('\n').map(line => line.trim()).filter(Boolean);
  let urlCount = 0;
  for (const row of rows.slice(0, 200)) {
    try {
      urlCount += countUrls(JSON.parse(row)).size;
    } catch (error) {
      return { valid: false, reason: error.message, recordCount: rows.length, urlCount, status: null };
    }
  }
  return { valid: true, reason: null, recordCount: rows.length, urlCount, status: null };
}

function compactFile(file, extra = {}) {
  return {
    path: file.relativePath,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...extra
  };
}

function compactText(value, maxLength = 320) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function firstValue(object, keys) {
  if (!object || typeof object !== 'object') return null;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }
  return null;
}

function arrayValue(object, keys) {
  if (!object || typeof object !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key];
  }
  return [];
}

function uniqueStrings(values) {
  return Array.from(new Set(
    values
      .map(value => compactText(value, 160))
      .filter(Boolean)
  ));
}

function summarizeRouteReceipts(value) {
  const receipts = value?.route_receipts || value?.routeReceipts || {};
  const attempts = [
    ...arrayValue(receipts, ['attempts']),
    ...arrayValue(value, ['source_attempts', 'sourceAttempts'])
  ];
  const searchReceipts = arrayValue(value, ['search_receipts', 'searchReceipts']);
  const fallbackAttempts = attempts.length > 0 ? [] : searchReceipts;
  const allAttempts = attempts.length > 0 ? attempts : fallbackAttempts;

  const routeNames = allAttempts.map(attempt => attempt?.route).filter(Boolean);
  const acceptedRoutes = allAttempts
    .filter(attempt => attempt?.status === 'accepted')
    .map(attempt => attempt.route);
  const emptyRoutes = allAttempts
    .filter(attempt => attempt?.status === 'empty')
    .map(attempt => attempt.route);
  const rejectedRoutes = allAttempts
    .filter(attempt => attempt?.status === 'rejected')
    .map(attempt => attempt.route);
  const failedRoutes = [
    ...arrayValue(receipts, ['failed_routes', 'failedRoutes']),
    ...arrayValue(value, ['failed_routes', 'failedRoutes']),
    ...allAttempts
      .filter(attempt => attempt?.status === 'failed' || attempt?.error || attempt?.code)
      .map(attempt => attempt.route)
  ];

  return {
    requiredRoutes: uniqueStrings(arrayValue(receipts, ['required_routes', 'requiredRoutes'])),
    attemptCount: allAttempts.length,
    searchReceiptCount: searchReceipts.length,
    attemptedRoutes: uniqueStrings(routeNames),
    acceptedRoutes: uniqueStrings(acceptedRoutes),
    emptyRoutes: uniqueStrings(emptyRoutes),
    rejectedRoutes: uniqueStrings(rejectedRoutes),
    failedRoutes: uniqueStrings(failedRoutes)
  };
}

function summarizeRawArtifact(file, value) {
  const entries = arrayValue(value, ['entries', 'records', 'anecdotes', 'quotes']);
  const candidates = arrayValue(value, ['candidates', 'results', 'items']);
  const identifierStatuses = arrayValue(value, ['identifier_statuses', 'identifierStatuses']);
  const negativeReceipts = arrayValue(value, ['negative_receipts', 'negativeReceipts']);
  const routeSummary = summarizeRouteReceipts(value);

  return {
    path: file.relativePath,
    status: firstValue(value, ['status', 'outcome', 'result']),
    entryCount: entries.length,
    candidateCount: candidates.length,
    identifierStatusCount: identifierStatuses.length,
    negativeReceiptCount: negativeReceipts.length,
    routeSummary,
    entries: entries.slice(0, 10).map(entry => ({
      identifier: firstValue(entry, ['identifier', 'item_identifier', 'itemIdentifier']),
      reviewer: firstValue(entry, ['reviewer', 'author', 'user', 'username']),
      date: firstValue(entry, ['created_at', 'createdAt', 'date', 'review_date', 'reviewDate']),
      route: firstValue(entry, ['route', 'source_route', 'sourceRoute']),
      sourceUrl: firstValue(entry, ['source_url', 'sourceUrl', 'url']),
      title: compactText(firstValue(entry, ['review_title', 'reviewTitle', 'title']), 160),
      excerpt: compactText(firstValue(entry, ['review_body', 'reviewBody', 'body', 'text', 'quote', 'excerpt']), 360)
    })),
    candidates: candidates.slice(0, 12).map(candidate => ({
      project: firstValue(candidate, ['project', 'band', 'subject']),
      dateShowReference: firstValue(candidate, ['date_show_reference', 'dateShowReference', 'show_date', 'showDate', 'date']),
      sourceType: firstValue(candidate, ['source_type', 'sourceType', 'type']),
      route: firstValue(candidate, ['route', 'source_route', 'sourceRoute']),
      sourceUrl: firstValue(candidate, ['source_url', 'sourceUrl', 'url']),
      confidence: firstValue(candidate, ['confidence', 'score']),
      excerpt: compactText(firstValue(candidate, ['excerpt', 'text', 'description', 'quote', 'body']), 360)
    })),
    identifierStatuses: identifierStatuses.slice(0, 10).map(status => ({
      identifier: firstValue(status, ['identifier', 'item_identifier', 'itemIdentifier']),
      status: firstValue(status, ['status', 'outcome', 'result']),
      reviewCount: firstValue(status, ['review_count_reported', 'reviewCountReported', 'review_count', 'reviewCount']),
      metadataRoute: firstValue(status, ['metadata_route', 'metadataRoute']),
      reviewRoute: firstValue(status, ['review_route', 'reviewRoute']),
      sourceUrl: firstValue(status, ['source_url', 'sourceUrl', 'url'])
    })),
    negativeReceipts: negativeReceipts.slice(0, 10).map(receipt => ({
      identifier: firstValue(receipt, ['identifier', 'item_identifier', 'itemIdentifier']),
      status: firstValue(receipt, ['status', 'outcome', 'result']),
      route: firstValue(receipt, ['route', 'source_route', 'sourceRoute']),
      sourceUrl: firstValue(receipt, ['source_url', 'sourceUrl', 'url'])
    }))
  };
}

function summarizeMarkdownArtifact(file) {
  const text = readTextIfSmall(file.path, 256 * 1024);
  if (text === null) return null;
  const headings = text
    .split('\n')
    .map(line => line.match(/^(#{1,3})\s+(.+?)\s*$/))
    .filter(Boolean)
    .map(match => `${match[1]} ${match[2]}`)
    .slice(0, 16);

  return {
    path: file.relativePath,
    headings,
    preview: compactText(text.replace(/^#+\s+/gm, ''), 1400)
  };
}

function hashFileForFingerprint(file, maxReadBytes) {
  try {
    if (file.size > maxReadBytes) return null;
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(file.path))
      .digest('hex')
      .slice(0, 24);
  } catch {
    return null;
  }
}

function buildArtifactFingerprint(files, summariesByPath, maxReadBytes) {
  const entries = files
    .map(file => {
      const summary = summariesByPath.get(file.relativePath);
      return {
        path: normalizeSlash(file.relativePath),
        size: file.size,
        mtimeMs: Math.round(file.mtimeMs || 0),
        contentHash: hashFileForFingerprint(file, maxReadBytes),
        summary
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex');
}

function summarizeRunArtifacts(runPath, options = {}) {
  const inventory = {
    runPath: runPath || null,
    exists: false,
    generatedAt: new Date().toISOString(),
    fingerprint: null,
    totals: {
      filesScanned: 0,
      outputFiles: 0,
      exportFiles: 0,
      jsonFiles: 0,
      invalidJsonFiles: 0,
      markdownFiles: 0
    },
    categories: {
      rawAnecdotes: { files: 0, records: 0 },
      extractedRecords: { files: 0, records: 0 },
      sourceReceipts: { files: 0, records: 0 },
      researchSummaries: { files: 0 },
      queryExports: { files: 0 },
      deliverables: { files: 0 }
    },
    sourceEvidence: {
      sourceIndexUrls: 0,
      sourceReceiptUrls: 0,
      sourceReceiptRecords: 0,
      routeReceiptFiles: []
    },
    artifactDetails: {
      rawAnecdotes: [],
      markdownReports: []
    },
    importantFiles: [],
    invalidFiles: [],
    warnings: [],
    answerSubstrate: 'missing'
  };

  if (!runPath || !safeStat(runPath)?.isDirectory()) {
    inventory.warnings.push('run_path_missing');
    return inventory;
  }

  inventory.exists = true;
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const maxReadBytes = options.maxReadBytes || DEFAULT_MAX_READ_BYTES;
  const roots = [
    path.join(runPath, 'outputs'),
    path.join(runPath, 'exports'),
    path.join(runPath, 'kv'),
    path.join(runPath, 'coordinator')
  ].filter(root => safeStat(root)?.isDirectory());

  const files = roots.flatMap(root => listFilesRecursive(root, { base: runPath, maxFiles }));
  inventory.totals.filesScanned = files.length;
  const summariesByPath = new Map();

  for (const file of files) {
    const rel = normalizeSlash(file.relativePath);
    const ext = path.extname(rel).toLowerCase();
    const kind = classifyRunFile(file);
    let summary = null;

    if (rel.startsWith('outputs/')) inventory.totals.outputFiles += 1;
    if (rel.startsWith('exports/')) inventory.totals.exportFiles += 1;
    if (ext === '.md' || ext === '.markdown') inventory.totals.markdownFiles += 1;

    if (ext === '.json') {
      inventory.totals.jsonFiles += 1;
      summary = summarizeJsonFile(file, maxReadBytes);
      if (!summary.valid) {
        inventory.totals.invalidJsonFiles += 1;
        inventory.invalidFiles.push(compactFile(file, { reason: summary.reason }));
      }
    } else if (ext === '.jsonl') {
      summary = summarizeJsonlFile(file, maxReadBytes);
      if (!summary.valid) {
        inventory.invalidFiles.push(compactFile(file, { reason: summary.reason }));
      }
    }
    summariesByPath.set(rel, summary);

    if (rel === 'kv/research_source_index.json' && summary?.valid) {
      inventory.sourceEvidence.sourceIndexUrls = Math.max(
        inventory.sourceEvidence.sourceIndexUrls,
        summary.urlCount
      );
      inventory.importantFiles.push(compactFile(file, {
        kind: 'source_index',
        urlCount: summary.urlCount
      }));
      continue;
    }

    if (kind === 'raw_anecdote') {
      inventory.categories.rawAnecdotes.files += 1;
      inventory.categories.rawAnecdotes.records += summary?.recordCount || 0;
      if (summary?.valid) {
        const parsed = readJsonIfSmall(file.path, maxReadBytes);
        if (parsed.ok) inventory.artifactDetails.rawAnecdotes.push(summarizeRawArtifact(file, parsed.value));
      }
    } else if (kind === 'extracted_record') {
      inventory.categories.extractedRecords.files += 1;
      inventory.categories.extractedRecords.records += summary?.recordCount || 0;
    } else if (kind === 'source_receipt') {
      inventory.categories.sourceReceipts.files += 1;
      inventory.categories.sourceReceipts.records += summary?.recordCount || 0;
      inventory.sourceEvidence.sourceReceiptRecords += summary?.recordCount || 0;
      inventory.sourceEvidence.sourceReceiptUrls += summary?.urlCount || 0;
      inventory.sourceEvidence.routeReceiptFiles.push(rel);
    } else if (kind === 'research_summary') {
      inventory.categories.researchSummaries.files += 1;
    } else if (kind === 'query_export') {
      inventory.categories.queryExports.files += 1;
    } else if (kind === 'deliverable_markdown') {
      inventory.categories.deliverables.files += 1;
      const markdownSummary = summarizeMarkdownArtifact(file);
      if (markdownSummary) inventory.artifactDetails.markdownReports.push(markdownSummary);
    }

    if (['raw_anecdote', 'extracted_record', 'source_receipt', 'query_export', 'deliverable_markdown'].includes(kind)) {
      inventory.importantFiles.push(compactFile(file, {
        kind,
        records: summary?.recordCount || 0,
        urls: summary?.urlCount || 0,
        status: summary?.status || null
      }));
    }
  }

  inventory.importantFiles.sort((a, b) => {
    const aScore = (a.records || 0) * 10 + (a.urls || 0);
    const bScore = (b.records || 0) * 10 + (b.urls || 0);
    return bScore - aScore || b.size - a.size;
  });
  inventory.importantFiles = inventory.importantFiles.slice(0, options.maxImportantFiles || 30);
  inventory.invalidFiles = inventory.invalidFiles.slice(0, options.maxInvalidFiles || 20);

  if (inventory.totals.invalidJsonFiles > 0) inventory.warnings.push('invalid_json_artifacts_present');
  if (inventory.categories.rawAnecdotes.files === 0) inventory.warnings.push('raw_anecdotes_missing');
  if (inventory.categories.rawAnecdotes.files > 0 && inventory.categories.rawAnecdotes.records === 0) {
    inventory.warnings.push('raw_anecdotes_empty');
  }
  if (inventory.sourceEvidence.routeReceiptFiles.length === 0) inventory.warnings.push('source_route_receipts_missing');
  if (inventory.sourceEvidence.sourceIndexUrls === 0 && inventory.sourceEvidence.sourceReceiptUrls === 0) {
    inventory.warnings.push('source_urls_missing');
  }

  if (inventory.categories.rawAnecdotes.records > 0 || inventory.categories.extractedRecords.records > 0) {
    inventory.answerSubstrate = 'records_present';
  } else if (inventory.sourceEvidence.sourceIndexUrls > 0 || inventory.sourceEvidence.sourceReceiptUrls > 0) {
    inventory.answerSubstrate = 'sources_only';
  } else if (inventory.categories.queryExports.files > 0 || inventory.categories.researchSummaries.files > 0) {
    inventory.answerSubstrate = 'meta_only';
  }

  inventory.fingerprint = buildArtifactFingerprint(files, summariesByPath, maxReadBytes);
  return inventory;
}

function buildArtifactFirstContext(inventory) {
  if (!inventory?.exists) {
    return '# Artifact Inventory\n\nNo run artifact directory was available for this query.';
  }

  const lines = [
    '# Artifact Inventory (authoritative filesystem scan)',
    '',
    `Run path: ${inventory.runPath}`,
    `Artifact fingerprint: ${inventory.fingerprint || 'missing'}`,
    `Answer substrate: ${inventory.answerSubstrate}`,
    `Files scanned: ${inventory.totals.filesScanned} (${inventory.totals.outputFiles} outputs, ${inventory.totals.exportFiles} exports)`,
    `Source index URLs: ${inventory.sourceEvidence.sourceIndexUrls}`,
    `Source receipt files: ${inventory.sourceEvidence.routeReceiptFiles.length}`,
    `Raw anecdote files/records: ${inventory.categories.rawAnecdotes.files}/${inventory.categories.rawAnecdotes.records}`,
    `Extracted record files/records: ${inventory.categories.extractedRecords.files}/${inventory.categories.extractedRecords.records}`,
    `Research summaries: ${inventory.categories.researchSummaries.files}`,
    `Query exports: ${inventory.categories.queryExports.files}`,
    `Invalid JSON files: ${inventory.totals.invalidJsonFiles}`,
    ''
  ];

  if (inventory.warnings.length > 0) {
    lines.push(`Warnings: ${inventory.warnings.join(', ')}`, '');
  }

  if (inventory.importantFiles.length > 0) {
    lines.push('Important files:');
    for (const file of inventory.importantFiles.slice(0, 12)) {
      const details = [
        file.kind,
        file.records ? `${file.records} records` : null,
        file.urls ? `${file.urls} urls` : null,
        file.status ? `status=${file.status}` : null
      ].filter(Boolean).join(', ');
      lines.push(`- ${file.path}${details ? ` (${details})` : ''}`);
    }
    lines.push('');
  }

  if (inventory.artifactDetails?.rawAnecdotes?.length > 0) {
    lines.push('Structured raw artifact truth (authoritative counts; do not replace candidate counts with URL or route counts):');
    for (const artifact of inventory.artifactDetails.rawAnecdotes.slice(0, 8)) {
      const route = artifact.routeSummary || {};
      const routeBits = [
        route.attemptCount ? `routeAttempts=${route.attemptCount}` : null,
        route.acceptedRoutes?.length ? `acceptedRoutes=${route.acceptedRoutes.join(', ')}` : null,
        route.failedRoutes?.length ? `failedRoutes=${route.failedRoutes.join(', ')}` : null,
        route.rejectedRoutes?.length ? `rejectedRoutes=${route.rejectedRoutes.join(', ')}` : null,
        route.emptyRoutes?.length ? `emptyRoutes=${route.emptyRoutes.join(', ')}` : null
      ].filter(Boolean).join('; ');
      lines.push(`- ${artifact.path}: status=${artifact.status || 'unknown'}, entries=${artifact.entryCount}, candidates=${artifact.candidateCount}, identifierStatuses=${artifact.identifierStatusCount}${routeBits ? `; ${routeBits}` : ''}`);

      if (artifact.identifierStatuses.length > 0) {
        lines.push('  Identifier status receipts:');
        for (const status of artifact.identifierStatuses) {
          const statusBits = [
            status.identifier,
            status.status ? `status=${status.status}` : null,
            status.reviewCount !== null && status.reviewCount !== undefined ? `reviews=${status.reviewCount}` : null,
            status.metadataRoute ? `metadata=${status.metadataRoute}` : null,
            status.reviewRoute ? `reviewsRoute=${status.reviewRoute}` : null,
            status.sourceUrl
          ].filter(Boolean);
          lines.push(`  - ${statusBits.join(' | ')}`);
        }
      }

      if (artifact.entries.length > 0) {
        lines.push('  Extracted entries:');
        for (const entry of artifact.entries) {
          const entryBits = [
            entry.identifier,
            entry.reviewer ? `reviewer=${entry.reviewer}` : null,
            entry.date ? `date=${entry.date}` : null,
            entry.route ? `route=${entry.route}` : null,
            entry.sourceUrl
          ].filter(Boolean);
          lines.push(`  - ${entryBits.join(' | ')}${entry.excerpt ? ` | excerpt="${entry.excerpt}"` : ''}`);
        }
      }

      if (artifact.candidates.length > 0) {
        lines.push('  Candidate anecdotes/sources:');
        for (const candidate of artifact.candidates) {
          const candidateBits = [
            candidate.project ? `project=${candidate.project}` : null,
            candidate.dateShowReference ? `date/show=${candidate.dateShowReference}` : null,
            candidate.sourceType ? `sourceType=${candidate.sourceType}` : null,
            candidate.route ? `route=${candidate.route}` : null,
            candidate.confidence !== null && candidate.confidence !== undefined ? `confidence=${candidate.confidence}` : null,
            candidate.sourceUrl
          ].filter(Boolean);
          lines.push(`  - ${candidateBits.join(' | ')}${candidate.excerpt ? ` | excerpt="${candidate.excerpt}"` : ''}`);
        }
      }

      if (artifact.negativeReceipts.length > 0) {
        lines.push('  Negative receipts:');
        for (const receipt of artifact.negativeReceipts) {
          const receiptBits = [
            receipt.identifier,
            receipt.status ? `status=${receipt.status}` : null,
            receipt.route ? `route=${receipt.route}` : null,
            receipt.sourceUrl
          ].filter(Boolean);
          lines.push(`  - ${receiptBits.join(' | ')}`);
        }
      }
    }
    lines.push('');
  }

  if (inventory.artifactDetails?.markdownReports?.length > 0) {
    lines.push('Markdown report truth:');
    for (const report of inventory.artifactDetails.markdownReports.slice(0, 4)) {
      lines.push(`- ${report.path}`);
      if (report.headings.length > 0) lines.push(`  Headings: ${report.headings.join(' | ')}`);
      if (report.preview) lines.push(`  Preview: ${report.preview}`);
    }
    lines.push('');
  }

  lines.push(
    'Use this inventory as current artifact truth before graph memory or coordinator commentary.',
    'Do not claim research deliverables exist unless the named file is present here or in the loaded output files.',
    'For source questions, distinguish source URLs/receipts from extracted records and say when the substrate is meta-only or sources-only.',
    'When structured artifact truth is present, use its exact entry/candidate counts and named records before any memory-node or output-preview counts.'
  );

  return lines.join('\n');
}

module.exports = {
  summarizeRunArtifacts,
  buildArtifactFirstContext,
  classifyRunFile
};
