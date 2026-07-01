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

function isValidArchiveIdentifier(value) {
  const cleaned = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(cleaned)) return false;
  return !/^(?:use|fetch|inspect|these|exact|identifier|identifiers|archive|archive\.org|metadata|reviews?|required|source|routes?|outputs?|raw|extracted|validation|final)$/i.test(cleaned);
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

function taskTextForValidation(expected = {}, context = {}) {
  const task = context.task || {};
  return [
    expected.label,
    task.title,
    task.description,
    task.expectedOutput,
    task.metadata?.expectedOutput,
    task.metadata?.sourceScope,
    ...normalizeArray(task.acceptanceCriteria).map(item => textFromValidationCriterion(item))
  ].filter(Boolean).join('\n');
}

function textFromValidationCriterion(criterion = {}) {
  if (typeof criterion === 'string') return criterion;
  return [criterion.rubric, criterion.description, criterion.text, criterion.value]
    .filter(Boolean)
    .join('\n');
}

function getRequiredMarkdownSectionChecks(expected = {}, context = {}) {
  const text = taskTextForValidation(expected, context).toLowerCase();
  const checks = [];
  const add = (key, label, patterns) => {
    if (!checks.some(check => check.key === key)) checks.push({ key, label, patterns });
  };

  if (/\bconfirmed\s+extracted\s+anecdotes?\b|\bconfirmed\s+.*listener-review\s+evidence\b/.test(text)) {
    add('confirmed_extracted_anecdotes', 'confirmed extracted anecdotes', [
      /\bconfirmed\s+extracted\s+anecdotes?\b/i,
      /\bconfirmed\s+.*listener[- ]review\s+evidence\b/i,
      /\bconfirmed\s+.*review\s+evidence\b/i
    ]);
  }
  if (/\bnegative\s+receipts?\b/.test(text)) {
    add('negative_receipts', 'negative receipts', [/\bnegative\s+receipts?\b/i]);
  }
  if (/\buseful\s+source\s+routes?\b|\bproductive\s+source\s+routes?\b/.test(text)) {
    add('useful_source_routes', 'useful source routes', [
      /\buseful\s+source\s+routes?\b/i,
      /\bproductive\s+source\s+routes?\b/i,
      /\buseful\s+routes?\b/i
    ]);
  }
  if (/\bfailed\/empty\s+routes?\b|\bfailed\s+or\s+empty\s+routes?\b|\bfailed\s+routes?\b/.test(text)) {
    add('failed_empty_routes', 'failed/empty routes', [
      /\bfailed\/empty\s+routes?\b/i,
      /\bfailed\s+or\s+empty\s+routes?\b/i,
      /\bfailed\s+\/\s+empty\s+routes?\b/i,
      /\bfailed\s+routes?\b/i,
      /\bempty\s+routes?\b/i
    ]);
  }
  if (/\bnext\s+source\s+famil(?:y|ies)\b|\bsource\s+famil(?:y|ies)\s+to\s+pursue\b/.test(text)) {
    add('next_source_families', 'next source families', [
      /\bnext\s+source\s+famil(?:y|ies)\b/i,
      /\bsource\s+famil(?:y|ies)\s+to\s+pursue\b/i,
      /\bnext\s+sources?\s+to\s+pursue\b/i
    ]);
  }

  return checks;
}

function validateMarkdownRequiredSections(content = '', expected = {}, context = {}) {
  const checks = getRequiredMarkdownSectionChecks(expected, context);
  if (checks.length === 0) return { passed: true, missing: [] };
  const missing = checks
    .filter(check => !check.patterns.some(pattern => pattern.test(content)))
    .map(check => check.label);
  return { passed: missing.length === 0, missing };
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
  const invalidIdentifier = requiredIdentifiers.find(identifier => !isValidArchiveIdentifier(identifier));
  if (invalidIdentifier) {
    return { passed: false, reason: `archive_invalid_required_identifier:${invalidIdentifier}` };
  }
  const identifierStatuses = normalizeArray(value.identifier_statuses || value.identifierStatuses);
  const invalidStatus = identifierStatuses.find(status => status?.identifier && !isValidArchiveIdentifier(status.identifier));
  if (invalidStatus) {
    return { passed: false, reason: `archive_invalid_status_identifier:${invalidStatus.identifier}` };
  }
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

function validateForumSocialCandidatesJson(value = {}) {
  if (!isPlainObject(value)) {
    return { passed: false, reason: 'forum_social_not_object' };
  }

  if (!Array.isArray(value.candidates)) {
    return { passed: false, reason: 'forum_social_missing_candidates_array' };
  }

  const queries = normalizeArray(value.queries).map(String).filter(Boolean);
  if (queries.length === 0) {
    return { passed: false, reason: 'forum_social_missing_queries' };
  }

  const instructionQuery = queries.find(query =>
    query.length > 512 ||
    /\bqueries must target\b|\bexpected output\b|@outputs\/|\bsource_url\b|\bsource_type\b/i.test(query)
  );
  if (instructionQuery) {
    return { passed: false, reason: 'forum_social_instruction_text_used_as_query' };
  }

  for (const [index, candidate] of value.candidates.entries()) {
    if (!candidate || typeof candidate !== 'object') {
      return { passed: false, reason: `forum_social_invalid_candidate:${index}` };
    }
    if (!/^https?:\/\//i.test(String(candidate.source_url || ''))) {
      return { passed: false, reason: `forum_social_candidate_missing_source_url:${index}` };
    }
    if (!String(candidate.source_type || '').trim()) {
      return { passed: false, reason: `forum_social_candidate_missing_source_type:${index}` };
    }
    const excerpt = String(candidate.excerpt || candidate.anecdote_text || candidate.quote || '').replace(/\s+/g, ' ').trim();
    if (excerpt.length < 20) {
      return { passed: false, reason: `forum_social_candidate_missing_excerpt:${index}` };
    }
  }

  if (value.candidates.length > 0) {
    return { passed: true };
  }

  const negativeReceipts = normalizeArray(value.negative_receipts || value.negativeReceipts);
  const routeAttempts = normalizeArray(value.route_receipts?.attempts || value.routeReceipts?.attempts);
  const searchedUrls = normalizeArray(value.urls_searched || value.urlsSearched);
  if (negativeReceipts.length === 0 || routeAttempts.length === 0 || searchedUrls.length === 0) {
    return { passed: false, reason: 'forum_social_empty_without_negative_receipts' };
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
    if (/forum-social-candidates\.json$/i.test(path.basename(absolutePath))) {
      const forumSocialValidation = validateForumSocialCandidatesJson(parsed);
      if (!forumSocialValidation.passed) {
        return { passed: false, reason: forumSocialValidation.reason };
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
    const sectionValidation = validateMarkdownRequiredSections(content, expected, context);
    if (!sectionValidation.passed) {
      return {
        passed: false,
        reason: `markdown_missing_required_sections:${sectionValidation.missing.join(',')}`
      };
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
        for (const route of normalizeArray(data.attempted_routes)) addEvidenceRoute(evidence, 'attemptedRoutes', route);
        for (const route of normalizeArray(data.accepted_routes)) addEvidenceRoute(evidence, 'successfulRoutes', route);
        for (const route of normalizeArray(data.accepted_empty_routes)) addEvidenceRoute(evidence, 'acceptedEmptyRoutes', route);
        for (const route of normalizeArray(data.failed_routes)) {
          addEvidenceRoute(evidence, 'attemptedRoutes', route);
          addEvidenceRoute(evidence, 'failedRoutes', route);
        }
        if (normalizeArray(data.missing_required_routes).length > 0) {
          evidence.missingRequiredRoutes = normalizeArray(data.missing_required_routes);
        }
        if (normalizeArray(data.failed_required_routes).length > 0) {
          evidence.failedRequiredRoutes = normalizeArray(data.failed_required_routes);
        }
        if (data.can_continue === false) {
          if (normalizeArray(data.missing_required_routes).length > 0) {
            evidence.statuses.push('blocked_missing_required_routes');
          } else if (normalizeArray(data.failed_required_routes).length > 0) {
            evidence.statuses.push('blocked_failed_required_routes');
          } else {
            evidence.statuses.push('blocked_no_sources');
          }
        }
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
