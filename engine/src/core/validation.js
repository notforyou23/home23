/**
 * Content Validation Utilities
 * Centralized validation to prevent garbage from entering the system
 */

/**
 * Check if content is valid for storage in memory
 * @param {string} content - Content to validate
 * @returns {Object} {valid: boolean, reason: string}
 */
function isValidContent(content) {
  // Null/undefined check
  if (!content || content === null || content === undefined) {
    return { valid: false, reason: 'Content is null or undefined' };
  }

  // Type check
  if (typeof content !== 'string') {
    return { valid: false, reason: `Content is not a string (type: ${typeof content})` };
  }

  // Length check
  if (content.length < 10) {
    return { valid: false, reason: `Content too short (${content.length} chars)` };
  }

  if (content.length > 50000) {
    return { valid: false, reason: `Content too long (${content.length} chars)` };
  }

  // Error patterns - comprehensive check
  const errorPatterns = [
    'error:',
    '[error:',
    'error]',
    'undefined',
    'null',
    '[object object]',
    ' nan',
    ' nan,',
    ' nan.',
    'nan%',
    'exception:',
    'failed to',
    'cannot read',
    'cannot access',
    'is not defined',
    'no content received',
    'request failed',
    'timeout',
    'econnrefused'
  ];

  const lowerContent = content.toLowerCase();
  for (const pattern of errorPatterns) {
    if (lowerContent.includes(pattern.toLowerCase())) {
      return { valid: false, reason: `Contains error pattern: "${pattern}"` };
    }
  }

  // Check for excessive repetition (gibberish)
  const words = content.split(/\s+/);
  if (words.length > 0) {
    const uniqueWords = new Set(words);
    const repetitionRatio = words.length / uniqueWords.size;
    if (repetitionRatio > 5) {
      return { valid: false, reason: 'Excessive word repetition detected' };
    }
  }

  // Check for minimum meaningful content
  const meaningfulChars = content.replace(/[\s\n\r\t]/g, '').length;
  if (meaningfulChars < 5) {
    return { valid: false, reason: 'Insufficient meaningful characters' };
  }

  return { valid: true, reason: '' };
}

/**
 * Sanitize content for safe storage
 * @param {string} content - Content to sanitize
 * @returns {string} Sanitized content
 */
function sanitizeContent(content) {
  if (typeof content !== 'string') {
    return '';
  }

  // Remove excessive whitespace
  let sanitized = content.replace(/\s+/g, ' ').trim();

  // Remove control characters except newlines
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // Truncate if too long
  if (sanitized.length > 10000) {
    sanitized = sanitized.substring(0, 10000) + '...';
  }

  return sanitized;
}

/**
 * Validate and clean content in one step
 * @param {string} content - Content to validate and clean
 * @returns {Object} {valid: boolean, content: string, reason: string}
 */
function validateAndClean(content) {
  const sanitized = sanitizeContent(content);
  const validation = isValidContent(sanitized);
  
  return {
    valid: validation.valid,
    content: validation.valid ? sanitized : null,
    reason: validation.reason
  };
}

module.exports = {
  isValidContent,
  sanitizeContent,
  validateAndClean
};
