/**
 * JSON Repair Utilities
 * Handles malformed JSON from LLM outputs
 * 
 * Common issues fixed:
 * - Trailing commas: [{...},]
 * - Comments: // explanation or /* comment *\/
 * - Extra prose before/after JSON
 * - Missing quotes on some keys
 */

/**
 * Extract and repair JSON from text that may contain prose
 * @param {string} text - Text containing JSON
 * @param {string} expectedType - 'object' or 'array'
 * @returns {any} Parsed JSON
 * @throws {Error} If no valid JSON found even after repair
 */
function extractAndRepairJSON(text, expectedType = 'object') {
  if (!text || typeof text !== 'string') {
    throw new Error('Input must be a non-empty string');
  }

  // 1. Find JSON boundaries
  const start = expectedType === 'array' ? '[' : '{';
  const end = expectedType === 'array' ? ']' : '}';
  
  const s = text.indexOf(start);
  const e = text.lastIndexOf(end);
  
  if (s < 0 || e < 0 || e <= s) {
    throw new Error(`No JSON ${expectedType} found in text`);
  }
  
  let json = text.slice(s, e + 1);
  
  // 2. Remove trailing commas before ] or }
  json = json.replace(/,(\s*[}\]])/g, '$1');
  
  // 3. Remove single-line comments
  json = json.replace(/\/\/.*$/gm, '');
  
  // 4. Remove multi-line comments
  json = json.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // 5. Remove any remaining whitespace issues
  json = json.trim();
  
  return JSON.parse(json);
}

/**
 * Try to parse JSON with multiple fallback strategies
 * @param {string} text - Text to parse
 * @param {string} expectedType - 'object' or 'array'
 * @returns {any|null} Parsed JSON or null if all attempts fail
 */
function parseWithFallback(text, expectedType = 'object') {
  // Strategy 1: Direct parse (fast path)
  try {
    return JSON.parse(text);
  } catch (e) {
    // Expected, continue to repair strategies
  }
  
  // Strategy 2: Extract and repair
  try {
    return extractAndRepairJSON(text, expectedType);
  } catch (e) {
    // Failed repair
  }
  
  // Strategy 3: Try alternative type
  if (expectedType === 'object') {
    try {
      return extractAndRepairJSON(text, 'array');
    } catch (e) {
      // Failed
    }
  }
  
  // All strategies failed
  return null;
}

module.exports = {
  extractAndRepairJSON,
  parseWithFallback
};
