/**
 * Content Validation & Quality Classification
 * Centralized validation to prevent garbage from entering the memory system.
 *
 * Two-tier classification:
 * - Tier 1: Pattern-based category detection (zero-cost regex)
 * - Tier 2: Content density heuristic (cheap string analysis, no API call)
 *
 * Tag allowlists preserve agent-to-agent JSON communication (queryMemoryForData).
 */

// ─── Tag Allowlists ────────────────────────────────────────────────────────────

/**
 * Structural tags: JSON data used for agent-to-agent communication.
 * Content with these tags ALWAYS passes the quality gate regardless of content.
 */
const STRUCTURAL_TAGS = new Set([
  'mission_plan',
  'cross_agent_pattern',
  'file_inventory',
  'source_code_analysis',
  'source_code_file',
  'codebase_inventory',
  'knowledge_landscape',
  'document_metadata_summary',
  'document_contents_for_analysis',
  'code_project_metadata',
  'code_creation_output_files',
  'code_execution_output_files',
  'research_output_files',
  'binary_extraction_metadata',
]);

/**
 * High-value tags: real research knowledge content.
 * Content with these tags passes with only a minimum length check.
 */
const HIGH_VALUE_TAGS = new Set([
  'research',
  'analysis',
  'synthesis_report',
  'analysis_insight',
  'novel_implication',
  'novel_connection',
  'speculative_hypothesis',
  'document_collection_analysis',
  'document_analysis',
  'document_analysis_insight',
  'document_ingestion_insight',
  'document_concept',
  'injected_document_content',
  'consistency_review',
  'sub_goal',
  'contradiction',
  'meta_insight',
  'architecture_analysis',
  'quality_analysis',
  'code_pattern',
  'code_analysis_insight',
  'qa_report',
  'exploration',
  'novel_connection',
  'document_compilation',
  'binary_extraction',
]);

// ─── Pattern Lists ─────────────────────────────────────────────────────────────

/**
 * Operational patterns: status messages, bookkeeping, process updates.
 * These contain zero research knowledge.
 */
const OPERATIONAL_PATTERNS = [
  /^IDE work completed/i,
  /^Pre-planned execution/i,
  /^Batch processing complete/i,
  /^Promoted \d+ file/i,
  /^Binary file processing complete/i,
  /^Final deliverable assembled:/i,
  /^Continuation agent (queued|spawned)/i,
  /^Exploration during .* mode\s*[-–—]\s*optimal/i,
  /^\d+\/\d+ actions succeeded/i,
  /^Agent \w+ (completed|finished|started|initialized)/i,
  /^Processing complete\b/i,
  /^Task (completed|finished|done)\b/i,
  /^Audit complete\b/i,
  /^Missing tokens?\b/i,
];

/**
 * Error patterns: transient error state that doesn't belong in knowledge graph.
 * Only rejected when tag is NOT 'error_report'.
 */
const ERROR_PATTERNS = [
  /failed with error:/i,
  /API returned (empty response|error)/i,
  /Section omitted/i,
  /failed to (generate|create|process)\b.*\b(error|timeout)\b/i,
  /^(connection|request) (timeout|refused|reset|failed)/i,
  /^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/,
  /missing tokens?\b.*\b(required|expected)/i,
];

/**
 * Garbage patterns: content that is definitely not useful in any context.
 * These are always rejected regardless of tag.
 */
const GARBAGE_PATTERNS = [
  /^\[object object\]$/i,
  /^(undefined|null|NaN)$/i,
  /^error:\s*$/i,
];

// ─── Stop Words for Density Calculation ────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'not', 'no', 'so', 'if', 'then',
  'than', 'very', 'just', 'also', 'as', 'into', 'about', 'up', 'out',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'too', 'any', 'now', 'new',
]);

// ─── Core Classification ───────────────────────────────────────────────────────

/**
 * Classify content for memory quality gating.
 *
 * @param {string} content - Content to classify
 * @param {string} tag - Memory tag (e.g., 'research', 'agent_finding')
 * @returns {{ category: 'knowledge'|'structural'|'operational'|'error'|'garbage', score: number, reason: string }}
 */
function classifyContent(content, tag = 'general') {
  // Basic validity
  if (!content || typeof content !== 'string') {
    return { category: 'garbage', score: 0, reason: 'Content is null or not a string' };
  }

  const trimmed = content.trim();

  if (trimmed.length < 10) {
    return { category: 'garbage', score: 0, reason: `Content too short (${trimmed.length} chars)` };
  }

  if (trimmed.length > 50000) {
    return { category: 'garbage', score: 0, reason: `Content too long (${trimmed.length} chars)` };
  }

  // Always-reject garbage patterns
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { category: 'garbage', score: 0, reason: `Matches garbage pattern: ${pattern}` };
    }
  }

  // Excessive repetition check
  const words = trimmed.split(/\s+/);
  if (words.length > 5) {
    const uniqueWords = new Set(words);
    const repetitionRatio = words.length / uniqueWords.size;
    if (repetitionRatio > 5) {
      return { category: 'garbage', score: 0, reason: 'Excessive word repetition' };
    }
  }

  // Structural tags: always pass (agent-to-agent JSON communication)
  if (STRUCTURAL_TAGS.has(tag)) {
    return { category: 'structural', score: 1.0, reason: 'Structural tag (agent-to-agent data)' };
  }

  // High-value tags: pass with minimal check
  if (HIGH_VALUE_TAGS.has(tag)) {
    // Strip prefix tags like [AGENT: xxx] before checking meaningful length
    const stripped = trimmed.replace(/^\[(?:AGENT|AGENT INSIGHT):\s*\w+\]\s*/i, '');
    if (stripped.length >= 30) {
      return { category: 'knowledge', score: 0.9, reason: 'High-value tag' };
    }
    // Short high-value content still passes but with lower score
    return { category: 'knowledge', score: 0.6, reason: 'High-value tag (short content)' };
  }

  // Operational pattern detection
  // Strip [AGENT: xxx] prefix before checking patterns
  const stripped = trimmed.replace(/^\[(?:AGENT|AGENT INSIGHT):\s*\w+\]\s*/i, '');

  for (const pattern of OPERATIONAL_PATTERNS) {
    if (pattern.test(stripped)) {
      return { category: 'operational', score: 0, reason: `Matches operational pattern: ${pattern}` };
    }
  }

  // Error pattern detection (unless tag indicates this IS an error report)
  if (tag !== 'error_report') {
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(stripped)) {
        return { category: 'error', score: 0, reason: `Matches error pattern: ${pattern}` };
      }
    }
  }

  // Tier 2: Content density heuristic for remaining content
  const density = contentDensityScore(stripped);
  if (density < 0.4) {
    return { category: 'operational', score: density, reason: `Low content density (${density.toFixed(2)})` };
  }

  return { category: 'knowledge', score: density, reason: 'Passed quality gate' };
}

/**
 * Calculate content density score (0-1).
 * Higher = more information-dense, more likely to be real knowledge.
 *
 * @param {string} content - Content to score
 * @returns {number} Score between 0 and 1
 */
function contentDensityScore(content) {
  if (!content || content.length === 0) return 0;

  const words = content.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return 0;

  // Meaningful words: > 3 chars, not stop words
  const meaningfulWords = words.filter(w => {
    const clean = w.toLowerCase().replace(/[^a-z]/g, '');
    return clean.length > 3 && !STOP_WORDS.has(clean);
  });

  const meaningfulRatio = meaningfulWords.length / words.length;

  // Knowledge markers (boost score)
  let knowledgeBoost = 0;

  // Numbers/statistics indicate concrete data
  const numberCount = (content.match(/\d+\.?\d*/g) || []).length;
  if (numberCount >= 2) knowledgeBoost += 0.15;

  // Proper nouns (capitalized words mid-sentence) indicate specific entities
  const properNouns = (content.match(/(?<=[a-z]\s)[A-Z][a-z]{2,}/g) || []).length;
  if (properNouns >= 1) knowledgeBoost += 0.1;

  // Technical terms (long words, likely domain-specific)
  const technicalWords = words.filter(w => w.length >= 8).length;
  if (technicalWords >= 3) knowledgeBoost += 0.1;

  // Quoted content or citations indicate evidence
  if (content.includes('"') || content.includes("'") || content.includes('http')) {
    knowledgeBoost += 0.05;
  }

  // Noise markers (reduce score)
  let noisePenalty = 0;

  // Status phrasing
  if (/\d+\s*(of|\/)\s*\d+\s*(succeeded|completed|processed|finished|done)/i.test(content)) {
    noisePenalty += 0.3;
  }

  // Pure path announcements
  if (/^[\/\w.-]+\.(js|json|txt|md|html|yaml|yml|csv)$/m.test(content)) {
    noisePenalty += 0.2;
  }

  // Compute final score
  const score = Math.max(0, Math.min(1, meaningfulRatio + knowledgeBoost - noisePenalty));
  return score;
}

// ─── Legacy API (backward-compatible wrappers) ─────────────────────────────────

/**
 * Check if content is valid for storage in memory (legacy).
 * Now wraps classifyContent for backward compatibility.
 */
function isValidContent(content) {
  if (!content || typeof content !== 'string') {
    return { valid: false, reason: 'Content is null or not a string' };
  }

  if (content.length < 10) {
    return { valid: false, reason: `Content too short (${content.length} chars)` };
  }

  if (content.length > 50000) {
    return { valid: false, reason: `Content too long (${content.length} chars)` };
  }

  // Check for garbage content
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(content.trim())) {
      return { valid: false, reason: `Matches garbage pattern` };
    }
  }

  // Excessive repetition
  const words = content.split(/\s+/);
  if (words.length > 5) {
    const uniqueWords = new Set(words);
    if (words.length / uniqueWords.size > 5) {
      return { valid: false, reason: 'Excessive word repetition detected' };
    }
  }

  // Minimum meaningful content
  const meaningfulChars = content.replace(/[\s\n\r\t]/g, '').length;
  if (meaningfulChars < 5) {
    return { valid: false, reason: 'Insufficient meaningful characters' };
  }

  return { valid: true, reason: '' };
}

/**
 * Sanitize content for safe storage
 */
function sanitizeContent(content) {
  if (typeof content !== 'string') {
    return '';
  }

  let sanitized = content.replace(/\s+/g, ' ').trim();
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  if (sanitized.length > 10000) {
    sanitized = sanitized.substring(0, 10000) + '...';
  }

  return sanitized;
}

/**
 * Validate and clean content in one step (legacy).
 * Now uses classifyContent under the hood.
 */
function validateAndClean(content) {
  const sanitized = sanitizeContent(content);
  const classification = classifyContent(sanitized);

  const valid = classification.category === 'knowledge' ||
                classification.category === 'structural';

  return {
    valid,
    content: valid ? sanitized : null,
    reason: classification.reason
  };
}

module.exports = {
  // New API
  classifyContent,
  contentDensityScore,
  STRUCTURAL_TAGS,
  HIGH_VALUE_TAGS,
  // Legacy API (backward-compatible)
  isValidContent,
  sanitizeContent,
  validateAndClean
};
