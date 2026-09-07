const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_SYNTHESIS_COMMIT_CONFIG = Object.freeze({
  commitStep: true,
  spineCap: 5,
  bucketNames: Object.freeze({
    spine: 'SPINE',
    facet: 'FACET',
    artifact: 'ARTIFACT'
  }),
  modeOverrides: Object.freeze({
    dive: true,
    pgs: true,
    compile: true,
    explore: false
  })
});

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBucketNames(bucketNames = {}) {
  return {
    spine: String(bucketNames.spine || DEFAULT_SYNTHESIS_COMMIT_CONFIG.bucketNames.spine).trim() || 'SPINE',
    facet: String(bucketNames.facet || DEFAULT_SYNTHESIS_COMMIT_CONFIG.bucketNames.facet).trim() || 'FACET',
    artifact: String(bucketNames.artifact || DEFAULT_SYNTHESIS_COMMIT_CONFIG.bucketNames.artifact).trim() || 'ARTIFACT'
  };
}

function normalizeSynthesisCommitConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    commitStep: parseBoolean(source.commitStep, DEFAULT_SYNTHESIS_COMMIT_CONFIG.commitStep),
    spineCap: parsePositiveInt(source.spineCap, DEFAULT_SYNTHESIS_COMMIT_CONFIG.spineCap),
    bucketNames: normalizeBucketNames(source.bucketNames),
    modeOverrides: {
      ...DEFAULT_SYNTHESIS_COMMIT_CONFIG.modeOverrides,
      ...(source.modeOverrides || {})
    }
  };
}

function resolveSynthesisCommitConfig(input, mode = 'dive') {
  const normalized = normalizeSynthesisCommitConfig(input || {});
  const modeKey = String(mode || '').trim().toLowerCase();
  const modeValue = normalized.modeOverrides[modeKey];
  const modeEnabled = modeValue === undefined ? normalized.commitStep : parseBoolean(modeValue, normalized.commitStep);
  const applied = Boolean(normalized.commitStep && modeEnabled);
  let reason = null;

  if (!normalized.commitStep) {
    reason = 'commitStep disabled';
  } else if (!modeEnabled) {
    reason = 'mode override disabled commit step';
  }

  return {
    applied,
    reason,
    spineCap: normalized.spineCap,
    bucketNames: normalized.bucketNames,
    mode: modeKey || mode
  };
}

function buildSynthesisCommitBlock(config) {
  if (!config?.applied) return '';
  const spine = config.bucketNames?.spine || 'SPINE';
  const facet = config.bucketNames?.facet || 'FACET';
  const artifact = config.bucketNames?.artifact || 'ARTIFACT';
  const cap = parsePositiveInt(config.spineCap, DEFAULT_SYNTHESIS_COMMIT_CONFIG.spineCap);

  return `---

## Commit Step (Required)

Before returning, apply the verdict mechanic.

1. Force-rank every named entity in this synthesis into exactly one of three
   buckets:

   - ${spine}: meets the run's evidential criteria as a primary commitment.
     Substrate-anchored, transferable, dissociable from a surface twin.

   - ${facet}: a perturbation regime, sub-case, alternative framing, or specific
     instance of a ${spine} entity.

   - ${artifact}: named after a benchmark, output shell, scaffold, surface
     category, or product label rather than an operation; or unsupported by
     available evidence.

2. The ${spine} bucket has a hard cap of ${cap}. To exceed the cap, justify
   each additional entity with substrate-level evidence and dissociation
   against a surface twin.

3. Every named entity in the working set must land in exactly one bucket.
   "Cannot classify" is permitted only when justified by explicit evidential
   absence, such as "term appears in no available partition", not by indecision.

4. Resolve naming inconsistencies by committing to one canonical vocabulary
   for the ${spine} entries. Rewrite all ${facet} and ${artifact} references
   to use that vocabulary.

5. List the experiments that would move entities between buckets. Rank by
   cost-to-information.

Use explicit ${spine}, ${facet}, ${artifact}, and Ranked Experiments section
labels so the committed verdict is auditable. Under each bucket heading, name
each entity as a top-level bullet or numbered item before any evidence
paragraphs.

If applying this step would require dropping or merging an earlier commitment
in the synthesis, do so. Do not preserve prior framing for continuity. The
commit step supersedes prior structure.

Return the synthesis with the commit step applied throughout, not as an appendix.
The committed verdict is the synthesis; do not write the pre-commit version and
then add buckets afterward.`;
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanInlineMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function extractSection(markdown, headingPatterns) {
  const lines = String(markdown || '').split(/\r?\n/);
  const patterns = headingPatterns.map(pattern => (
    pattern instanceof RegExp ? pattern : new RegExp(`^#{1,6}\\s+${escapeRegex(pattern)}\\b`, 'i')
  ));

  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (patterns.some(pattern => pattern.test(trimmed))) {
      const heading = trimmed.match(/^(#{1,6})\s+/);
      startLevel = heading ? heading[1].length : 0;
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const heading = lines[i].trim().match(/^(#{1,6})\s+\S/);
    if (heading && (!startLevel || heading[1].length <= startLevel)) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n').trim();
}

function extractListItems(section) {
  const items = [];
  const boldItems = [];
  const lines = String(section || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const headingItem = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingItem) {
      items.push(cleanInlineMarkdown(headingItem[1]));
      continue;
    }

    const boldOnly = trimmed.match(/^\*\*([^*]+)\*\*$/);
    if (boldOnly) {
      boldItems.push(cleanInlineMarkdown(boldOnly[1]));
      continue;
    }

    const boldLabel = trimmed.match(/^\*\*([^*]+)\*\*(?:\s*\([^)]*\))?\s*(?:[-:|\u2014])/);
    if (boldLabel) {
      boldItems.push(cleanInlineMarkdown(boldLabel[1]));
      continue;
    }

    const match = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (match) {
      items.push(cleanInlineMarkdown(match[1]));
      continue;
    }

    if (/^\|[^|]+\|/.test(trimmed) && !/^\|\s*-+/.test(trimmed)) {
      const cells = trimmed.split('|').map(cell => cell.trim()).filter(Boolean);
      if (cells.length > 0 && !/^(name|canonical name|spine|facet|artifact|rank|experiment|evidence|parent spine|estimated cost)$/i.test(cells[0])) {
        items.push(cleanInlineMarkdown(cells[0]));
      }
    }
  }

  if (boldItems.length > 0) return boldItems.filter(Boolean);
  if (items.length > 0) return items.filter(Boolean);

  const looseText = String(section || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .split(/\s+(?:-|\u2014)\s+all\s+are\b/i)[0];

  if (looseText.includes(',')) {
    return looseText
      .split(',')
      .map(item => cleanInlineMarkdown(item))
      .filter(Boolean);
  }

  return [];
}

function canonicalNameFromItem(item) {
  const cleaned = cleanInlineMarkdown(item)
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^\(([^)]+)\)\s*/, '$1 ')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[A-Z][A-Z0-9_-]*-?\d+\s*[:.)-]\s*/i, '')
    .trim();
  const split = cleaned.split(/\s+(?:-|:|=>|->|\u2014)\s+|\s+[|]\s+/)[0] || cleaned;
  return split
    .replace(/^["']|["']$/g, '')
    .replace(/[.,;]+$/g, '')
    .trim();
}

function parseExperiments(section) {
  const experiments = [];
  const lines = String(section || '').split(/\r?\n/);
  let current = null;

  function pushCurrent() {
    if (current && current.experiment) {
      experiments.push({
        experiment: current.experiment,
        moves_what_between_what: current.moves_what_between_what || '',
        cost_to_information: current.cost_to_information || ''
      });
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const boldRank = trimmed.match(/^\*\*(?:Rank\s+)?\d+[.)]?\s*(?:(?:-|\u2014)\s*)?(.+?)\*\*/i);
    if (boldRank) {
      pushCurrent();
      const title = cleanInlineMarkdown(boldRank[1]);
      const cost = title.match(/\bcost\s*:\s*([^;)]+)/i);
      const info = title.match(/\binformation\s*:\s*([^)]+)/i);
      current = {
        experiment: title.replace(/\s*\([^)]*\)\s*$/, '').trim(),
        cost_to_information: [info?.[1], cost?.[1]].filter(Boolean).join(' info, ') || ''
      };
      continue;
    }

    if (/^\|[^|]+\|/.test(trimmed) && !/^\|\s*-+/.test(trimmed)) {
      const cells = trimmed.split('|').map(cell => cleanInlineMarkdown(cell.trim())).filter(Boolean);
      if (/^\d+$/i.test(cells[0] || '') && cells[1]) {
        experiments.push({
          experiment: cells[1],
          moves_what_between_what: cells[2] || '',
          cost_to_information: cells[3] || ''
        });
        current = null;
      }
      continue;
    }

    const item = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (item) {
      pushCurrent();
      current = { experiment: cleanInlineMarkdown(item[1]) };
      continue;
    }

    if (!current) continue;

    const moves = trimmed.match(/^moves(?:_what_between_what| what between what)?\s*:\s*(.+)$/i);
    if (moves) {
      current.moves_what_between_what = cleanInlineMarkdown(moves[1]);
      continue;
    }

    const cost = trimmed.match(/^cost(?:[-_ ]?to[-_ ]?information)?\s*:\s*(.+)$/i);
    if (cost) {
      current.cost_to_information = cleanInlineMarkdown(cost[1]);
      continue;
    }

    if (trimmed && !current.moves_what_between_what && !/^#{1,6}\s+/.test(trimmed)) {
      current.moves_what_between_what = cleanInlineMarkdown(trimmed);
    }
  }

  pushCurrent();
  return experiments;
}

function parseSynthesisCommitReceipt(markdown, config) {
  const spineCap = parsePositiveInt(config?.spineCap, DEFAULT_SYNTHESIS_COMMIT_CONFIG.spineCap);
  if (!config?.applied) {
    return {
      applied: false,
      spine_cap: spineCap,
      reason: config?.reason || 'commitStep disabled'
    };
  }

  const bucketNames = normalizeBucketNames(config.bucketNames);
  const spineName = escapeRegex(bucketNames.spine);
  const facetName = escapeRegex(bucketNames.facet);
  const artifactName = escapeRegex(bucketNames.artifact);
  const spineSection = extractSection(markdown, [
    bucketNames.spine,
    new RegExp(`^#{1,6}\\s+final\\s+(?:${spineName}|${spineName}s)\\b.*$`, 'i'),
    new RegExp(`^#{1,6}\\s+(?:${spineName}|${spineName}s)\\s+vocabulary\\b.*$`, 'i'),
    new RegExp(`^#{1,6}\\s+(?:${spineName}|${spineName}s)(?:\\b|\\s|\\().*$`, 'i')
  ]);
  const facetSection = extractSection(markdown, [
    bucketNames.facet,
    new RegExp(`^#{1,6}\\s+(?:${facetName}|${facetName}s)(?:\\b|\\s|\\().*$`, 'i')
  ]);
  const artifactSection = extractSection(markdown, [
    bucketNames.artifact,
    new RegExp(`^#{1,6}\\s+(?:${artifactName}|${artifactName}s)(?:\\b|\\s|\\().*$`, 'i')
  ]);
  const cannotSection = extractSection(markdown, [
    /^(?:#{1,6}\s+)?cannot[-\s_]?classify\b/i,
    /^(?:#{1,6}\s+)?unclassified\b/i
  ]);
  const experimentsSection = extractSection(markdown, [
    /^(?:#{1,6}\s+)?ranked\s+experiments\b/i,
    /^(?:#{1,6}\s+)?ranked\s+experiment\b/i,
    /^(?:#{1,6}\s+)?experiments\b/i,
    /^(?:#{1,6}\s+)?next\s+experiments\b/i
  ]);

  const spineItems = extractListItems(spineSection);
  const facetItems = extractListItems(facetSection);
  const artifactItems = extractListItems(artifactSection);
  const cannotItems = extractListItems(cannotSection);
  const experiments = parseExperiments(experimentsSection);
  const parsedAny = spineItems.length > 0 || facetItems.length > 0 || artifactItems.length > 0 || experiments.length > 0;

  return {
    applied: true,
    spine_cap: spineCap,
    spine_count: spineItems.length,
    spine_names: spineItems.map(canonicalNameFromItem).filter(Boolean),
    facet_count: facetItems.length,
    artifact_count: artifactItems.length,
    cannot_classify_count: cannotItems.length,
    experiments_ranked: experiments,
    parse_status: parsedAny ? 'ok' : 'missing_buckets'
  };
}

async function writeSynthesisCommitReceipt(runtimeDir, details = {}) {
  if (!runtimeDir || !details.synthesisCommit) return null;
  const timestamp = details.timestamp || new Date().toISOString();
  const answer = details.answer || '';
  const entry = {
    timestamp,
    query: details.query || '',
    mode: details.mode || '',
    model: details.model || '',
    answer_hash: crypto.createHash('sha256').update(String(answer)).digest('hex'),
    synthesis_commit: details.synthesisCommit
  };

  const receiptPath = path.join(runtimeDir, 'synthesis-commit-receipts.jsonl');
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.appendFile(receiptPath, JSON.stringify(entry) + '\n', 'utf8');
  return receiptPath;
}

module.exports = {
  DEFAULT_SYNTHESIS_COMMIT_CONFIG,
  buildSynthesisCommitBlock,
  normalizeSynthesisCommitConfig,
  parseSynthesisCommitReceipt,
  resolveSynthesisCommitConfig,
  writeSynthesisCommitReceipt
};
