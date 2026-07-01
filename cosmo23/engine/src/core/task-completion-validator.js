const fs = require('fs').promises;
const path = require('path');

const {
  deriveResearchContract,
  evaluateResearchEvidence,
  collectResearchEvidence
} = require('./research-contract');

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addExpectedSpec(specs, raw, source = 'metadata') {
  if (!raw) return;

  if (Array.isArray(raw)) {
    for (const item of raw) addExpectedSpec(specs, item, source);
    return;
  }

  if (typeof raw === 'object') {
    if (raw.path) addExpectedSpec(specs, raw.path, source);
    if (raw.file) addExpectedSpec(specs, raw.file, source);
    if (raw.filename && raw.location) addExpectedSpec(specs, `${raw.location}${raw.filename}`, source);
    return;
  }

  if (typeof raw !== 'string') return;

  const parts = raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const cleaned = part.replace(/^["'`]+|["'`.,;:]+$/g, '');
    if (cleaned) specs.push({ label: cleaned, source });
  }
}

function getExpectedOutputSpecs(task = {}) {
  const specs = [];

  addExpectedSpec(specs, task.metadata?.expectedOutput, 'metadata.expectedOutput');
  addExpectedSpec(specs, task.expectedOutput, 'task.expectedOutput');
  addExpectedSpec(specs, task.deliverable, 'task.deliverable');

  const deliverableSpec = task.metadata?.deliverableSpec;
  if (deliverableSpec?.filename && deliverableSpec?.location) {
    addExpectedSpec(specs, `${deliverableSpec.location}${deliverableSpec.filename}`, 'metadata.deliverableSpec');
  }

  for (const criterion of normalizeArray(task.acceptanceCriteria)) {
    const rubric = typeof criterion?.rubric === 'string' ? criterion.rubric : '';
    const matches = rubric.match(/@outputs\/[^\s`'",)]+/g) || [];
    for (const match of matches) addExpectedSpec(specs, match, 'acceptanceCriteria');
  }

  const deduped = [];
  const seen = new Set();
  for (const spec of specs) {
    const key = spec.label;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(spec);
  }
  return deduped;
}

function resolveOutputRoot(context = {}) {
  if (context.outputRoot) return context.outputRoot;

  const resolver = context.pathResolver;
  if (resolver?.getOutputsRoot) {
    const root = resolver.getOutputsRoot();
    if (root) return root;
  }
  if (resolver?.resolve) {
    try {
      const root = resolver.resolve('@outputs');
      if (root) return root;
    } catch {
      // fall through
    }
  }

  if (context.logsDir) return path.join(context.logsDir, 'outputs');
  return null;
}

function resolveExpectedOutputPath(label, context = {}) {
  if (!label || typeof label !== 'string') return null;

  const resolver = context.pathResolver;
  if (resolver?.resolve) {
    try {
      return resolver.resolve(label);
    } catch {
      // fall through to output-root resolution
    }
  }

  if (path.isAbsolute(label)) return label;

  const outputRoot = resolveOutputRoot(context);
  if (!outputRoot) return null;

  if (label.startsWith('@outputs/')) {
    return path.join(outputRoot, label.slice('@outputs/'.length));
  }
  if (label.startsWith('outputs/')) {
    return path.join(outputRoot, label.slice('outputs/'.length));
  }
  return path.join(outputRoot, label);
}

function hasSubstantiveText(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 80) return false;
  if (/\b(todo|tbd|coming soon)\b/i.test(normalized) && normalized.length < 500) return false;
  if (/\bplaceholder\b/i.test(normalized) &&
      !/\bnot\b[^.]{0,60}\bplaceholder\b/i.test(normalized) &&
      normalized.length < 500) {
    return false;
  }
  return true;
}

function isNegativeReceiptObject(value = {}) {
  const statusText = [
    value.status,
    value.reason,
    value.outcome,
    value.result,
    value.next_allowed_action
  ].filter(Boolean).join(' ').toLowerCase();

  const provesRoutes = normalizeArray(value.urls_searched).length > 0 ||
    normalizeArray(value.urlsSearched).length > 0 ||
    Number(value.attempts || 0) > 0 ||
    Number(value.crossings || 0) > 0 ||
    normalizeArray(value.failed_routes).length > 0;

  return provesRoutes && /\b(no_|none|empty|not_found|failed|blocked|stop_and_repair|exhausted)\b/.test(statusText);
}

function hasJsonSubstance(value) {
  if (Array.isArray(value)) {
    return value.some(item => hasJsonSubstance(item));
  }

  if (!isPlainObject(value)) {
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== null && value !== undefined;
  }

  if (isNegativeReceiptObject(value)) return true;

  const evidenceKeys = [
    'sources', 'sourceUrls', 'source_urls', 'entries', 'records', 'results',
    'findings', 'anecdotes', 'quotes', 'items', 'searchEvidence',
    'sourceValidation', 'attempts', 'crossings', 'extractions',
    'productive_source_urls'
  ];

  for (const key of evidenceKeys) {
    if (Array.isArray(value[key]) && value[key].length > 0) {
      return value[key].some(item => hasJsonSubstance(item));
    }
  }

  return Object.values(value).some(child => {
    if (Array.isArray(child)) return child.some(item => hasJsonSubstance(item));
    if (isPlainObject(child)) return hasJsonSubstance(child);
    if (typeof child === 'string') return child.trim().length > 0;
    if (typeof child === 'number') return Number.isFinite(child);
    return false;
  });
}

function normalizeRouteReceiptAttempts(value = {}) {
  return normalizeArray(value.route_receipts?.attempts || value.routeReceipts?.attempts || value.attempts);
}

function addEvidenceRoute(evidence, field, value) {
  if (!value) return;
  if (!Array.isArray(evidence[field])) evidence[field] = [];
  const route = String(value).trim();
  if (route && !evidence[field].includes(route)) evidence[field].push(route);
}

function recordArtifactRouteAttempt(evidence, attempt = {}) {
  if (!attempt || typeof attempt !== 'object') return;
  const route = attempt.route || attempt.backend || attempt.provider || attempt.providerId;
  if (!route) return;

  addEvidenceRoute(evidence, 'attemptedRoutes', route);
  const status = String(attempt.status || attempt.outcome || attempt.result || (attempt.ok === true ? 'accepted' : '')).toLowerCase();
  if (!Array.isArray(evidence.routeStatuses)) evidence.routeStatuses = [];
  evidence.routeStatuses.push({
    route: String(route),
    status: status || null,
    error: attempt.error || null
  });

  if (
    attempt.ok === true ||
    ['accepted', 'success', 'succeeded', 'successful', 'ok', 'completed', 'metadata_only'].includes(status)
  ) {
    addEvidenceRoute(evidence, 'successfulRoutes', route);
    return;
  }

  if (['empty', 'no_results', 'no_results_found', 'no_reviews_found', 'not_found', 'negative', 'accepted_empty'].includes(status)) {
    addEvidenceRoute(evidence, 'acceptedEmptyRoutes', route);
    return;
  }

  if (
    attempt.ok === false ||
    attempt.error ||
    ['failed', 'error', 'blocked', 'timeout', 'rejected'].includes(status)
  ) {
    addEvidenceRoute(evidence, 'failedRoutes', route);
  }
}

function validateArchiveOrgCommentsJson(value = {}) {
  if (!isPlainObject(value)) {
    return { passed: false, reason: 'archive_comments_not_an_object' };
  }

  const entries = normalizeArray(value.entries);
  const requiredIdentifiers = normalizeArray(value.required_identifiers || value.requiredIdentifiers)
    .map(String)
    .filter(Boolean);
  const identifierStatuses = normalizeArray(value.identifier_statuses || value.identifierStatuses);
  const attempts = normalizeRouteReceiptAttempts(value);
  const attemptedRoutes = new Set(attempts.map(item => item.route).filter(Boolean));

  if (!attemptedRoutes.has('archive.reviews')) {
    return { passed: false, reason: 'archive_reviews_route_not_attempted' };
  }

  if (requiredIdentifiers.length > 0 && !attemptedRoutes.has('archive.metadata')) {
    return { passed: false, reason: 'archive_metadata_route_not_attempted' };
  }

  for (const entry of entries) {
    if (!entry.identifier) return { passed: false, reason: 'archive_review_entry_missing_identifier' };
    if (!entry.source_url) return { passed: false, reason: 'archive_review_entry_missing_source_url' };
    const body = entry.review_body || entry.body || entry.anecdote_text || '';
    if (typeof body !== 'string' || body.trim().length === 0) {
      return { passed: false, reason: 'archive_review_entry_missing_body' };
    }
  }

  if (requiredIdentifiers.length > 0) {
    for (const identifier of requiredIdentifiers) {
      const hasEntry = entries.some(entry => entry.identifier === identifier);
      const status = identifierStatuses.find(item => item.identifier === identifier);
      const hasAcceptedNegative = status &&
        status.metadata_route === 'accepted' &&
        status.review_route === 'accepted' &&
        status.status === 'no_reviews_found';
      if (!hasEntry && !hasAcceptedNegative) {
        return { passed: false, reason: `archive_identifier_not_resolved:${identifier}` };
      }
    }
  }

  if (entries.length === 0) {
    const hasNegativeReceipts = identifierStatuses.length > 0 &&
      identifierStatuses.every(item =>
        item.status === 'no_reviews_found' &&
        item.metadata_route === 'accepted' &&
        item.review_route === 'accepted'
      );
    const urlsSearched = normalizeArray(value.urls_searched || value.urlsSearched);
    if (!hasNegativeReceipts || urlsSearched.length === 0) {
      return { passed: false, reason: 'archive_comments_no_entries_without_negative_receipts' };
    }
  }

  return { passed: true };
}

async function validateExpectedOutputFile(absolutePath, expected = {}, context = {}) {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    return { passed: false, reason: 'not_a_file' };
  }
  if (stat.size <= 0) {
    return { passed: false, reason: 'empty_file' };
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const maxReadBytes = context.maxReadBytes || 5 * 1024 * 1024;
  const shouldRead = stat.size <= maxReadBytes ||
    ['.json', '.jsonl', '.md', '.markdown', '.txt', '.csv'].includes(ext);
  const content = shouldRead ? await fs.readFile(absolutePath, 'utf8') : '';

  if (ext === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      return { passed: false, reason: `invalid_json: ${error.message}` };
    }
    if (/archive-org-comments\.json$/i.test(path.basename(absolutePath))) {
      const archiveValidation = validateArchiveOrgCommentsJson(parsed);
      if (!archiveValidation.passed) {
        return { passed: false, reason: archiveValidation.reason };
      }
    }
    if (!hasJsonSubstance(parsed)) {
      return { passed: false, reason: 'json_has_no_substantive_records' };
    }
  } else if (ext === '.jsonl') {
    const rows = content.split('\n').map(line => line.trim()).filter(Boolean);
    if (rows.length === 0) {
      return { passed: false, reason: 'jsonl_has_no_rows' };
    }
    for (const row of rows.slice(0, 20)) {
      try {
        JSON.parse(row);
      } catch (error) {
        return { passed: false, reason: `invalid_jsonl: ${error.message}` };
      }
    }
  } else if (ext === '.md' || ext === '.markdown') {
    if (!hasSubstantiveText(content) || !/^#\s+/m.test(content)) {
      return { passed: false, reason: 'markdown_has_no_substantive_body' };
    }
  } else if (ext === '.txt' || ext === '.csv') {
    if (!hasSubstantiveText(content)) {
      return { passed: false, reason: 'text_has_no_substantive_body' };
    }
  }

  return {
    passed: true,
    stat,
    validation: {
      parseStatus: ['.json', '.jsonl'].includes(ext) ? 'ok' : 'not_required',
      substanceStatus: 'ok',
      bytes: stat.size,
      expectedOutput: expected.label || null
    }
  };
}

async function validateExpectedOutputs(expectedOutputs = [], artifacts = [], context = {}) {
  const presentArtifacts = [];
  const missing = [];
  const invalid = [];
  const outputRoot = resolveOutputRoot(context);

  for (const expected of expectedOutputs) {
    const absolutePath = resolveExpectedOutputPath(expected.label, context);
    if (!absolutePath) {
      missing.push(expected);
      continue;
    }

    try {
      const validation = await validateExpectedOutputFile(absolutePath, expected, context);
      if (!validation.passed) {
        invalid.push({ ...expected, absolutePath, reason: validation.reason });
        continue;
      }

      const relativePath = outputRoot && absolutePath.startsWith(outputRoot)
        ? path.relative(outputRoot, absolutePath)
        : path.basename(absolutePath);

      presentArtifacts.push({
        type: 'file',
        path: relativePath,
        absolutePath,
        size: validation.stat.size,
        source: 'expected_output_contract',
        expectedOutput: expected.label,
        validation: validation.validation
      });
    } catch {
      const alreadyTracked = artifacts.some(artifact =>
        artifact.absolutePath === absolutePath ||
        artifact.path === expected.label ||
        artifact.path === path.basename(absolutePath)
      );

      if (alreadyTracked) {
        presentArtifacts.push(...artifacts.filter(artifact =>
          artifact.absolutePath === absolutePath ||
          artifact.path === expected.label ||
          artifact.path === path.basename(absolutePath)
        ));
      } else {
        missing.push(expected);
      }
    }
  }

  return {
    passed: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    artifacts: presentArtifacts
  };
}

function normalizeArtifactRefs(task = {}, closure = {}) {
  return [
    ...normalizeArray(task.artifacts),
    ...normalizeArray(task.producedArtifacts),
    ...normalizeArray(closure.artifacts),
    ...normalizeArray(closure.producedArtifacts)
  ].filter(Boolean);
}

function resolveArtifactPath(artifact = {}, context = {}) {
  if (artifact.absolutePath) return artifact.absolutePath;
  if (artifact.path && path.isAbsolute(artifact.path)) return artifact.path;

  const outputRoot = resolveOutputRoot(context);
  const workspacePath = artifact.workspacePath || artifact.relativePath || artifact.path;
  if (!outputRoot || !workspacePath) return null;

  if (workspacePath.startsWith('outputs/')) {
    return path.join(outputRoot, workspacePath.slice('outputs/'.length));
  }
  return path.join(outputRoot, workspacePath);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonlIfPresent(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function collectResearchEvidenceFromArtifacts(task = {}, closure = {}, context = {}) {
  const evidence = collectResearchEvidence([], closure.researchEvidence || closure.metadata || {});
  const artifacts = normalizeArtifactRefs(task, closure);

  for (const artifact of artifacts) {
    const absolutePath = resolveArtifactPath(artifact, context);
    const filename = path.basename(absolutePath || artifact.path || artifact.workspacePath || '');

    if (filename === 'sources.json') {
      const data = absolutePath ? await readJsonIfPresent(absolutePath) : null;
      const sources = normalizeArray(data?.sources);
      evidence.sourcesFound += sources.length;
      evidence.successfulSources += sources.filter(source => source.url || source.source_url).length;
    }

    if (filename === 'source_backbone_status.json') {
      const data = absolutePath ? await readJsonIfPresent(absolutePath) : null;
      if (data) {
        evidence.queriesAttempted += Number(data.planned_queries?.length || data.attempts || 0);
        evidence.queriesExecuted += Number(data.attempts || 0);
        evidence.sourcesFound += Number(data.productive_sources || 0);
        evidence.successfulSources += normalizeArray(data.productive_source_urls).length;
        evidence.pagesAcquired += Number(data.crossings || 0);
        for (const route of normalizeArray(data.required_routes)) addEvidenceRoute(evidence, 'requiredRoutes', route);
        for (const route of normalizeArray(data.failed_routes)) {
          addEvidenceRoute(evidence, 'attemptedRoutes', route);
          addEvidenceRoute(evidence, 'failedRoutes', route);
        }
        if (data.can_continue === false) evidence.statuses.push('blocked_no_sources');
        if (data.next_allowed_action) evidence.reasons.push(data.next_allowed_action);
      }
    }

    if (filename === 'source_attempts.jsonl') {
      const rows = absolutePath ? await readJsonlIfPresent(absolutePath) : [];
      evidence.queriesAttempted += rows.length;
      evidence.queriesExecuted += rows.filter(row => row.status).length;
      evidence.searchFailures += rows.filter(row => row.status === 'failed').length;
      evidence.sourcesFound += rows.reduce((sum, row) => sum + Number(row.url_count || 0), 0);
      for (const row of rows) recordArtifactRouteAttempt(evidence, row);
    }

    if (filename === 'source_crossing.jsonl') {
      const rows = absolutePath ? await readJsonlIfPresent(absolutePath) : [];
      evidence.sourcesContacted += rows.length;
      evidence.successfulSources += rows.filter(row => row.ok === true).length;
      evidence.pagesAcquired += rows.filter(row => row.ok === true).length;
      for (const row of rows) {
        recordArtifactRouteAttempt(evidence, {
          route: row.route,
          status: row.ok === true ? 'accepted' : 'failed',
          error: row.error || row.blocked_reason || null
        });
      }
    }

    if (filename === 'archive-org-comments.json') {
      const data = absolutePath ? await readJsonIfPresent(absolutePath) : null;
      if (data) {
        const entries = normalizeArray(data.entries);
        const attempts = normalizeRouteReceiptAttempts(data);
        for (const attempt of attempts) recordArtifactRouteAttempt(evidence, attempt);
        for (const route of normalizeArray(data.route_receipts?.required_routes || data.routeReceipts?.requiredRoutes)) {
          addEvidenceRoute(evidence, 'requiredRoutes', route);
        }
        for (const route of normalizeArray(data.route_receipts?.failed_routes || data.routeReceipts?.failedRoutes)) {
          addEvidenceRoute(evidence, 'failedRoutes', route);
        }
        for (const status of normalizeArray(data.identifier_statuses || data.identifierStatuses)) {
          if (status.metadata_route === 'accepted') addEvidenceRoute(evidence, 'successfulRoutes', 'archive.metadata');
          if (status.review_route === 'accepted') {
            const bucket = status.status === 'no_reviews_found' ? 'acceptedEmptyRoutes' : 'successfulRoutes';
            addEvidenceRoute(evidence, bucket, 'archive.reviews');
          }
        }
        evidence.queriesAttempted += attempts.length;
        evidence.queriesExecuted += attempts.filter(row => row.status).length;
        evidence.searchFailures += attempts.filter(row => row.status === 'failed').length;
        evidence.sourcesFound += normalizeArray(data.urls_searched || data.urlsSearched).length;
        evidence.successfulSources += normalizeArray(data.route_receipts?.productive_source_urls || data.routeReceipts?.productiveSourceUrls).length;
        evidence.entriesFound += entries.length;
        if (entries.length > 0) {
          evidence.successfulSources += entries.filter(entry => entry.source_url).length;
          addEvidenceRoute(evidence, 'successfulRoutes', 'archive.reviews');
        }
      }
    }
  }

  return evidence;
}

async function validateTaskCompletionClosure(task = {}, closure = {}, context = {}) {
  const expectedOutputs = getExpectedOutputSpecs(task);
  const artifacts = normalizeArtifactRefs(task, closure);
  const expectedArtifacts = [];

  if (expectedOutputs.length > 0) {
    const expectedValidation = await validateExpectedOutputs(expectedOutputs, artifacts, context);
    if (!expectedValidation.passed) {
      const missing = expectedValidation.missing.map(item => item.label);
      const invalid = expectedValidation.invalid.map(item => `${item.label} (${item.reason})`);
      return {
        passed: false,
        reasonCode: expectedValidation.missing.length > 0 ? 'missing_expected_output' : 'invalid_expected_output',
        reason: [
          missing.length > 0 ? `Missing expected output: ${missing.join(', ')}` : null,
          invalid.length > 0 ? `Invalid expected output: ${invalid.join(', ')}` : null
        ].filter(Boolean).join('; '),
        expectedValidation
      };
    }
    expectedArtifacts.push(...expectedValidation.artifacts);
  }

  const researchContract = task.metadata?.researchContract || task.researchContract || deriveResearchContract(task);
  if (researchContract.required) {
    const evidence = await collectResearchEvidenceFromArtifacts({
      ...task,
      producedArtifacts: [
        ...normalizeArray(task.producedArtifacts),
        ...expectedArtifacts
      ]
    }, closure, context);
    const contractValidation = evaluateResearchEvidence(researchContract, evidence);
    if (!contractValidation.passed) {
      return {
        passed: false,
        reasonCode: `research_${contractValidation.reasonCode}`,
        reason: `Research contract failed: ${contractValidation.reasonCode}`,
        researchContract,
        researchEvidence: contractValidation.evidence
      };
    }
  }

  return { passed: true, expectedOutputs, researchContract };
}

module.exports = {
  getExpectedOutputSpecs,
  validateExpectedOutputs,
  validateExpectedOutputFile,
  validateTaskCompletionClosure,
  collectResearchEvidenceFromArtifacts,
  resolveOutputRoot,
  resolveExpectedOutputPath,
  hasJsonSubstance
};
