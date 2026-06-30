const fs = require('fs');
const path = require('path');

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

function summarizeRunArtifacts(runPath, options = {}) {
  const inventory = {
    runPath: runPath || null,
    exists: false,
    generatedAt: new Date().toISOString(),
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

  lines.push(
    'Use this inventory as current artifact truth before graph memory or coordinator commentary.',
    'Do not claim research deliverables exist unless the named file is present here or in the loaded output files.',
    'For source questions, distinguish source URLs/receipts from extracted records and say when the substrate is meta-only or sources-only.'
  );

  return lines.join('\n');
}

module.exports = {
  summarizeRunArtifacts,
  buildArtifactFirstContext,
  classifyRunFile
};
