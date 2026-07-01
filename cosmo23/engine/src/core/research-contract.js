// HOME23 PATCH — Patch 28: contract-first research governance.
// Source-dependent tasks need a shared machine-readable contract so planner,
// agents, PlanExecutor, and governor all agree on what counts as research.
const WEB_SEARCH_QUERY_PATTERN = /\bweb_search\b/gi;

const SOURCE_REQUIRED_PATTERNS = [
  { code: 'explicit_web_search', pattern: /\bweb[_ -]?search\b/i, mode: 'web_research' },
  { code: 'source_url_required', pattern: /\bsource_urls?\b|\burls?\s+searched\b/i, mode: 'web_research' },
  { code: 'citation_required', pattern: /\bcitations?\b|\bcite\b|\bbibliograph/i, mode: 'web_research' },
  { code: 'forum_research', pattern: /\bforums?\b|\breddit\b|\buser\s+notes?\b|\bfan\s+(?:anecdotes?|recollections?|memories?)\b/i, mode: 'web_research' },
  { code: 'archive_research', pattern: /\barchive\.org\b|\binternet archive\b|\barchive items?\b|\barchive\.(?:metadata|reviews?)\b|\breview\s+threads?\b|\btaper\s+notes?\b/i, mode: 'source_acquisition', providers: ['archive.advancedsearch', 'archive.metadata', 'archive.reviews'] },
  { code: 'archive_file_research', pattern: /\barchive\s+files?\b|\bdownload\s+files?\b|\bfile\s+list\b|\baudio\s+files?\b|\bocr\s+files?\b/i, mode: 'source_acquisition', providers: ['archive.files'] },
  { code: 'historical_web_research', pattern: /\bwayback\b|\bweb archive\b|\bhistorical captures?\b|\bmementos?\b|\bcdx\b|\bcommon crawl\b|\bwarc\b|\bwet file\b|\bhistorical web crawl\b/i, mode: 'source_acquisition', providers: ['wayback.availability', 'wayback.cdx', 'commoncrawl.cdx'] },
  { code: 'knowledge_graph_research', pattern: /\bwikidata\b|\bknowledge graph\b|\bentity id\b|\bcanonical entity\b|\bsparql\b/i, mode: 'source_acquisition', providers: ['wikidata.entity_search', 'wikidata.sparql'] },
  { code: 'scholarly_research', pattern: /\bopenalex\b|\bscholarly\b|\bacademic\b|\bliterature review\b|\bcitation graph\b|\bcrossref\b|\bdoi\b|\bjournal article\b|\bpublication metadata\b|\bsemantic scholar\b|\bs2ag\b|\bcorpus id\b/i, mode: 'source_acquisition', providers: ['openalex.works', 'crossref.works', 'semantic_scholar.paper_search'] },
  { code: 'preprint_research', pattern: /\barxiv\b|\bpreprint\b/i, mode: 'source_acquisition', providers: ['arxiv.query', 'semantic_scholar.paper_search'] },
  { code: 'biomedical_research', pattern: /\bpubmed\b|\bpmid\b|\bbiomedical\b|\bncbi\b/i, mode: 'source_acquisition', providers: ['pubmed.esearch_summary'] },
  { code: 'feed_research', pattern: /\brss\b|\batom feed\b|\bpodcast feed\b|\bsitemap\b|\bsite map\b/i, mode: 'source_acquisition', providers: ['rss.feed', 'feed.sitemap'] },
  { code: 'media_research', pattern: /\byoutube\b|\bvideo\b|\baudio\b|\bpodcast\b|\btranscript\b/i, mode: 'web_research' },
  { code: 'social_research', pattern: /\bsocial\b|\btwitter\b|\bx\/twitter\b|\bx\.com\b|\btweets?\b|\bthreads?\b|\bwhat(?:'s| is| are) (?:people|twitter|x).*saying\b|\bcheck x discourse\b/i, mode: 'web_research', providers: ['home23.skill.x_research.search'] },
  { code: 'interview_quote_research', pattern: /\binterview\s+quotes?\b|\bverbatim\b/i, mode: 'web_research' },
  { code: 'source_acquisition', pattern: /\bscrape\b|\bcrawl\b|\bfetch\b|\bdownload\b|\bhttp(?:s)?:\/\//i, mode: 'source_acquisition' },
  { code: 'secondary_source_scope', pattern: /\bsecondary\s+sources?\b|\bsource_type\b|\bsource\s+scope\b/i, mode: 'web_research' }
];

const LOCAL_ONLY_PATTERNS = [
  /\blocal\s+only\b/i,
  /\blocal\s+memory\s+system\b/i,
  /\binternal\s+cognitive\s+stores?\b/i,
  /\btransformed\s+memory\s+query\s+results?\b/i,
  /\bexisting\s+(?:local\s+)?artifacts?\b/i,
  /\bdo not conduct web search\b/i,
  /\bno web[_ -]?search\b/i,
  /\bweb[_ -]?search\s+is\s+prohibited\b/i,
  /\bweb access is prohibited\b/i,
  /\bno\s+source\s+data\s+acquisition\b/i,
  /\bsource\s+data\s+acquisition\s+prohibited\b/i,
  /\bpurely\s+analytical\s+framework\b/i,
  /\bwhen\s+web[_ -]?search\s+becomes\s+available\b/i
];

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function textFromCriterion(criterion) {
  if (!criterion) return '';
  if (typeof criterion === 'string') return criterion;
  return [criterion.rubric, criterion.description, criterion.text, criterion.value]
    .filter(Boolean)
    .join('\n');
}

function textFromInput(input = {}) {
  const metadata = input.metadata || {};
  const parts = [
    input.title,
    input.name,
    input.description,
    input.mission,
    input.context,
    input.sourceScope,
    input.expectedOutput,
    input.deliverable,
    metadata.sourceScope,
    metadata.expectedOutput,
    metadata.researchDigest && JSON.stringify(metadata.researchDigest)
  ];

  for (const criterion of normalizeArray(input.successCriteria)) {
    parts.push(textFromCriterion(criterion));
  }
  for (const criterion of normalizeArray(input.acceptanceCriteria)) {
    parts.push(textFromCriterion(criterion));
  }

  for (const tool of normalizeArray(input.tools || metadata.tools)) {
    parts.push(String(tool));
  }

  return parts.filter(Boolean).join('\n');
}

function extractWebSearchQueries(text = '') {
  const queries = [];
  let match;
  while ((match = WEB_SEARCH_QUERY_PATTERN.exec(text)) !== null) {
    let cursor = match.index + match[0].length;
    const tail = text.slice(cursor);
    const directive = tail.match(/^\s*(?:(?:for|query|search)\b|:)\s*/i);
    let hasDirective = false;
    if (directive) {
      cursor += directive[0].length;
      hasDirective = true;
    } else {
      const whitespace = tail.match(/^\s*/);
      if (whitespace) {
        cursor += whitespace[0].length;
      }
    }

    const opener = text[cursor];
    let query = '';
    if (opener === '"' || opener === "'" || opener === '`') {
      cursor += 1;
      const end = findClosingQuote(text, cursor, opener);
      if (end === -1) {
        query = text.slice(cursor).trim();
        WEB_SEARCH_QUERY_PATTERN.lastIndex = text.length;
      } else {
        query = text.slice(cursor, end).trim();
        WEB_SEARCH_QUERY_PATTERN.lastIndex = end + 1;
      }
    } else if (hasDirective) {
      const rest = text.slice(cursor);
      const endMatch = rest.match(/[;\n]/);
      query = (endMatch ? rest.slice(0, endMatch.index) : rest).trim();
      WEB_SEARCH_QUERY_PATTERN.lastIndex = cursor + query.length;
    } else {
      continue;
    }

    if (query && !queries.includes(query)) {
      queries.push(query);
    }
  }
  return queries;
}

function findClosingQuote(text, start, quote) {
  for (let index = start; index < text.length; index++) {
    if (text[index] !== quote) continue;

    // Treat contractions inside single-quoted queries as content, not the end
    // delimiter: "I'll", "don't", etc.
    if (quote === "'") {
      const prev = text[index - 1] || '';
      const next = text[index + 1] || '';
      if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
        continue;
      }
    }

    return index;
  }
  return -1;
}

function normalizeContract(contract = {}) {
  if (!contract || typeof contract !== 'object') {
    return deriveResearchContract({});
  }

  return {
    version: 1,
    required: Boolean(contract.required),
    mode: contract.mode || (contract.required ? 'web_research' : 'none'),
    requiredEvidence: Array.isArray(contract.requiredEvidence)
      ? contract.requiredEvidence
      : (contract.required ? ['successful_source_contact'] : []),
    requiredQueries: Array.isArray(contract.requiredQueries) ? contract.requiredQueries : [],
    minSuccessfulSources: Number.isFinite(Number(contract.minSuccessfulSources))
      ? Number(contract.minSuccessfulSources)
      : (contract.required ? 1 : 0),
    allowNullFindingsWithSourceEvidence: contract.allowNullFindingsWithSourceEvidence !== false,
    reasonCodes: Array.isArray(contract.reasonCodes) ? contract.reasonCodes : [],
    sourceProviderHints: Array.isArray(contract.sourceProviderHints)
      ? [...new Set(contract.sourceProviderHints.map(String).filter(Boolean))]
      : []
  };
}

function emptyResearchContract() {
  return {
    version: 1,
    required: false,
    mode: 'none',
    requiredEvidence: [],
    requiredQueries: [],
    minSuccessfulSources: 0,
    allowNullFindingsWithSourceEvidence: true,
    reasonCodes: [],
    sourceProviderHints: []
  };
}

function isLocalOnlyInput(input = {}, text = '') {
  const metadata = input.metadata || {};
  const webPolicy = String(
    input.webPolicy
    || metadata.webPolicy
    || input.planningDecision?.webPolicy
    || metadata.planningDecision?.webPolicy
    || ''
  ).toLowerCase();

  if (webPolicy === 'none') {
    return true;
  }

  if (isLocalArtifactOnlyText(text)) {
    return true;
  }

  return LOCAL_ONLY_PATTERNS.some(pattern => pattern.test(text));
}

function isLocalArtifactOnlyText(text = '') {
  const lower = String(text || '').toLowerCase();
  const readsOutputArtifact = /(?:^|\n|\b)read\s+@outputs\//i.test(text)
    || /\bfrom\s+@outputs\//i.test(text);
  if (!readsOutputArtifact) return false;

  const localAction =
    /\bvalidate\b|\bjson\s+parses\b|\bproblems\s*:\s*\[\]|\bsynthesize\b|\bwrite\s+markdown\b|\bgrounded only in the artifacts\b/i.test(text);
  if (!localAction) return false;

  const explicitAcquisition =
    /\buse\s+(?:typed\s+)?source\s+provider\b/i.test(text)
    || /\bexecute\s+web[_ -]?search\b/i.test(text)
    || /\buse\s+web[_ -]?search\b/i.test(text)
    || /\bfetch\s+https?:\/\//i.test(text)
    || /\b(?:scrape|crawl|download)\b/i.test(text)
    || /\buse\s+archive\.(?:metadata|reviews?|advancedsearch|files)\b/i.test(text);

  return !explicitAcquisition && lower.includes('@outputs/');
}

function getSourceScopeText(input = {}) {
  return [
    input.sourceScope,
    input.metadata?.sourceScope
  ].filter(Boolean).join('\n').toLowerCase();
}

function isExclusiveSourceScope(scopeText = '') {
  return /\b(?:only|exclusively|solely|restricted to)\b/i.test(scopeText);
}

function filterProviderHintsBySourceScope(providerHints = [], input = {}) {
  const scopeText = getSourceScopeText(input);
  if (!scopeText || !isExclusiveSourceScope(scopeText)) {
    return providerHints;
  }

  const allow = [];
  if (/\breddit\b|\br\/[a-z0-9_]+\b/i.test(scopeText)) {
    allow.push(/^reddit\./i, /^forum\./i);
  }
  if (/\barchive\.org\b|\binternet archive\b/i.test(scopeText)) {
    allow.push(/^archive\./i);
  }
  if (/\btwitter\b|\bx\/twitter\b|\bx\.com\b/i.test(scopeText)) {
    allow.push(/^home23\.skill\.x_research\./i);
  }
  if (/\bwayback\b|\bcommon crawl\b|\bweb archive\b/i.test(scopeText)) {
    allow.push(/^wayback\./i, /^commoncrawl\./i);
  }
  if (/\byoutube\b|\bvideo\b|\btranscript\b/i.test(scopeText)) {
    allow.push(/^youtube\./i, /^transcript\./i);
  }

  if (allow.length === 0) {
    return providerHints;
  }

  return providerHints.filter(hint => allow.some(pattern => pattern.test(hint)));
}

function deriveResearchContract(input = {}) {
  const text = textFromInput(input);
  const localOnly = isLocalOnlyInput(input, text);

  if (input.metadata?.researchContract) {
    if (localOnly) return emptyResearchContract();
    const contract = normalizeContract(input.metadata.researchContract);
    contract.sourceProviderHints = filterProviderHintsBySourceScope(contract.sourceProviderHints, input);
    return contract;
  }
  if (input.researchContract) {
    if (localOnly) return emptyResearchContract();
    const contract = normalizeContract(input.researchContract);
    contract.sourceProviderHints = filterProviderHintsBySourceScope(contract.sourceProviderHints, input);
    return contract;
  }

  const tools = normalizeArray(input.tools || input.metadata?.tools).map(tool => String(tool).toLowerCase());
  const agentType = String(input.agentType || input.metadata?.agentType || input.type || '').toLowerCase();
  if (localOnly) {
    return emptyResearchContract();
  }

  const reasonCodes = [];
  const modes = [];
  const sourceProviderHints = [];

  for (const rule of SOURCE_REQUIRED_PATTERNS) {
    if (rule.pattern.test(text)) {
      reasonCodes.push(rule.code);
      modes.push(rule.mode);
      sourceProviderHints.push(...normalizeArray(rule.providers));
    }
  }

  if (tools.some(tool => tool.includes('web_search'))) {
    reasonCodes.push('explicit_web_search_tool');
    modes.push('web_research');
  }

  if (agentType === 'dataacquisition' && !localOnly) {
    reasonCodes.push('dataacquisition_agent');
    modes.push('source_acquisition');
  }

  const required = !localOnly && reasonCodes.length > 0;
  const mode = required
    ? (modes.includes('source_acquisition') ? 'source_acquisition' : 'web_research')
    : 'none';

  return {
    version: 1,
    required,
    mode,
    requiredEvidence: required ? ['successful_source_contact'] : [],
    requiredQueries: extractWebSearchQueries(text),
    minSuccessfulSources: required ? 1 : 0,
    allowNullFindingsWithSourceEvidence: true,
    reasonCodes: [...new Set(reasonCodes)],
    sourceProviderHints: filterProviderHintsBySourceScope(
      [...new Set(sourceProviderHints.map(String).filter(Boolean))],
      input
    )
  };
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function mergeEvidence(target, source = {}) {
  target.queriesAttempted += positiveNumber(source.queriesAttempted, source.queryCount);
  target.queriesExecuted += positiveNumber(source.queriesExecuted);
  target.searchFailures += normalizeArray(source.searchFailures).length || positiveNumber(source.searchFailures);
  target.sourcesFound += Array.isArray(source.sourcesFound)
    ? source.sourcesFound.length
    : positiveNumber(source.sourcesFound, source.sourcesCount, source.urlsValid);
  target.sourcesContacted += positiveNumber(source.sourcesContacted);
  target.successfulSources += positiveNumber(source.successfulSources);
  target.pagesAcquired += positiveNumber(source.pagesAcquired);
  target.filesDownloaded += positiveNumber(source.filesDownloaded);
  target.bytesAcquired += positiveNumber(source.bytesAcquired);
  target.entriesFound += Array.isArray(source.entries)
    ? source.entries.length
    : positiveNumber(source.entriesFound, source.findingsAdded);
  target.filesCreated += positiveNumber(source.filesCreated, source.artifactsCreated);
  target.commandsRun += positiveNumber(source.commandsRun);

  if (source.status) target.statuses.push(source.status);
  if (source.reason) target.reasons.push(source.reason);
  if (source.error) target.errors.push(source.error);
}

function evidenceFromManifest(manifest = {}) {
  const sources = normalizeArray(manifest.sources);
  return {
    sourcesContacted: sources.length,
    successfulSources: sources.filter(source => Number(source.status) >= 200 && Number(source.status) < 400).length,
    pagesAcquired: manifest.pagesAcquired || 0,
    filesDownloaded: manifest.filesDownloaded || 0,
    bytesAcquired: manifest.bytesAcquired || 0,
    errors: manifest.errors || []
  };
}

function collectResearchEvidence(agentStates = [], extraEvidence = {}) {
  const evidence = {
    queriesAttempted: 0,
    queriesExecuted: 0,
    searchFailures: 0,
    sourcesFound: 0,
    sourcesContacted: 0,
    successfulSources: 0,
    pagesAcquired: 0,
    filesDownloaded: 0,
    bytesAcquired: 0,
    entriesFound: 0,
    filesCreated: 0,
    commandsRun: 0,
    statuses: [],
    reasons: [],
    errors: []
  };

  for (const state of normalizeArray(agentStates)) {
    const agent = state?.agent || state;
    if (!agent) continue;

    mergeEvidence(evidence, agent.metadata);
    mergeEvidence(evidence, agent.agentSpecificData);
    mergeEvidence(evidence, agent.agentSpecificData?.metadata);
    mergeEvidence(evidence, agent.accomplishment?.metrics);

    if (agent.acquisitionManifest) {
      mergeEvidence(evidence, evidenceFromManifest(agent.acquisitionManifest));
    }

    if (agent.status) evidence.statuses.push(agent.status);
    if (agent.agentSpecificData?.status) evidence.statuses.push(agent.agentSpecificData.status);
    if (agent.agentSpecificData?.reason) evidence.reasons.push(agent.agentSpecificData.reason);

    for (const result of normalizeArray(agent.results)) {
      mergeEvidence(evidence, result);
      mergeEvidence(evidence, result.metadata);
      if (result.status) evidence.statuses.push(result.status);
      if (result.reason) evidence.reasons.push(result.reason);
    }
  }

  mergeEvidence(evidence, extraEvidence);
  return evidence;
}

function evaluateResearchEvidence(contractInput, evidenceInput = {}) {
  const contract = normalizeContract(contractInput);
  if (!contract.required) {
    return { passed: true, reasonCode: 'not_required', contract, evidence: evidenceInput };
  }

  const evidence = collectResearchEvidence([], evidenceInput);
  const statuses = new Set(evidence.statuses.filter(Boolean));
  const blockedStatus = [...statuses].find(status =>
    ['blocked_search_failed', 'blocked_no_sources', 'completed_unproductive', 'failed', 'timeout'].includes(status)
  );

  if (blockedStatus === 'blocked_search_failed') {
    return { passed: false, reasonCode: 'all_searches_failed', contract, evidence };
  }
  if (blockedStatus === 'blocked_no_sources') {
    return { passed: false, reasonCode: 'no_source_urls_found', contract, evidence };
  }

  if (
    evidence.queriesAttempted > 0 &&
    evidence.searchFailures >= evidence.queriesAttempted &&
    evidence.sourcesFound === 0 &&
    evidence.successfulSources === 0
  ) {
    return { passed: false, reasonCode: 'all_searches_failed', contract, evidence };
  }

  const sourceEvidence =
    evidence.sourcesFound +
    evidence.successfulSources +
    evidence.pagesAcquired +
    evidence.filesDownloaded;

  if (sourceEvidence < contract.minSuccessfulSources) {
    return { passed: false, reasonCode: 'missing_source_evidence', contract, evidence };
  }

  return { passed: true, reasonCode: 'source_evidence_present', contract, evidence };
}

function taskNeedsResearchContract(task = {}) {
  return deriveResearchContract(task).required;
}

module.exports = {
  deriveResearchContract,
  taskNeedsResearchContract,
  evaluateResearchEvidence,
  collectResearchEvidence,
  extractWebSearchQueries
};
