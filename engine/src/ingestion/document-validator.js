'use strict';

class DocumentValidator {
  constructor({ logger = null }) {
    this.logger = logger;
  }

  /**
   * Validate document text and blocks for quality/integrity issues.
   * Runs AFTER chunking, BEFORE enqueue.
   *
   * @param {string} text - The full document text
   * @param {object[]} blocks - The chunked blocks from DocumentChunker
   * @param {object} metadata - { filePath, format }
   * @returns {{ status: string, issues: string[], structuralSignature: object, divergenceScore: null }}
   */
  validate(text, blocks, metadata = {}) {
    const issues = [];

    // ─── Truncation Detection ──────────────────────────────

    // 1. Text ends mid-word (last char is a letter, no sentence-ending punctuation in final 20 chars)
    if (text.length > 50) {
      const tail = text.trimEnd();
      const lastChar = tail[tail.length - 1];
      const finalSegment = tail.slice(-20);
      if (/[a-zA-Z]/.test(lastChar) && !/[.!?;:)\]}"']/.test(finalSegment)) {
        issues.push(`truncated mid-word at position ${tail.length}`);
      }
    }

    // 2. Unmatched quotes or parentheses
    const openParens = (text.match(/\(/g) || []).length;
    const closeParens = (text.match(/\)/g) || []).length;
    if (openParens > 0 && Math.abs(openParens - closeParens) > Math.max(2, openParens * 0.3)) {
      issues.push(`unmatched parentheses: ${openParens} open vs ${closeParens} close`);
    }

    const openBrackets = (text.match(/\[/g) || []).length;
    const closeBrackets = (text.match(/\]/g) || []).length;
    if (openBrackets > 0 && Math.abs(openBrackets - closeBrackets) > Math.max(2, openBrackets * 0.3)) {
      issues.push(`unmatched brackets: ${openBrackets} open vs ${closeBrackets} close`);
    }

    const doubleQuotes = (text.match(/"/g) || []).length;
    if (doubleQuotes > 0 && doubleQuotes % 2 !== 0) {
      // Only flag if there are enough quotes that it's clearly structural
      if (doubleQuotes >= 3) {
        issues.push(`unmatched double quotes: ${doubleQuotes} occurrences`);
      }
    }

    // 3. Incomplete markdown constructs -- unclosed code fences
    const fenceOpens = (text.match(/^```/gm) || []).length;
    if (fenceOpens % 2 !== 0) {
      issues.push('unclosed code fence');
    }

    // Unclosed markdown links [text](
    const openLinks = (text.match(/\[[^\]]*\]\([^)]*$/gm) || []).length;
    if (openLinks > 0) {
      issues.push(`${openLinks} unclosed markdown link(s)`);
    }

    // 4. Very low block count relative to text length (suggests parser failure)
    if (blocks.length > 0 && text.length > 2000) {
      const avgCharsPerBlock = text.length / blocks.length;
      if (avgCharsPerBlock > 5000) {
        issues.push(`very low block count (${blocks.length}) for text length (${text.length}), possible parser failure`);
      }
    }

    // 5. Abrupt heading without content after it at the end
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock.type === 'heading') {
        issues.push('document ends with a heading and no following content');
      }
    }

    // ─── Low Quality Detection ─────────────────────────────

    if (blocks.length > 0) {
      const unknownBlocks = blocks.filter(b => b.type === 'unknown');
      const unknownRatio = unknownBlocks.length / blocks.length;
      if (unknownRatio > 0.5) {
        issues.push(`${Math.round(unknownRatio * 100)}% of blocks are type "unknown"`);
      }

      const avgTextLen = blocks.reduce((sum, b) => sum + (b.text || '').length, 0) / blocks.length;
      if (avgTextLen < 20 && blocks.length > 3) {
        issues.push(`average block text length is ${Math.round(avgTextLen)} chars (very short, suggests junk/noise)`);
      }
    }

    // ─── Build Structural Signature ────────────────────────

    const typeCounts = {};
    const levelCounts = {};
    for (const block of blocks) {
      typeCounts[block.type] = (typeCounts[block.type] || 0) + 1;
      if (block.level > 0) {
        levelCounts[block.level] = (levelCounts[block.level] || 0) + 1;
      }
    }

    const avgTextLen = blocks.length > 0
      ? blocks.reduce((sum, b) => sum + (b.text || '').length, 0) / blocks.length
      : 0;

    const structuralSignature = {
      nBlocks: blocks.length,
      typeCounts,
      levelCounts,
      avgTextLen: Math.round(avgTextLen),
      hasTables: (typeCounts.table || 0) > 0,
      hasSignatures: (typeCounts.signature || 0) > 0,
      hasDefinitions: (typeCounts.definition || 0) > 0
    };

    // ─── Determine Status ──────────────────────────────────

    let status = 'ok';

    const truncationIssues = issues.filter(i =>
      i.includes('truncated') || i.includes('unclosed') || i.includes('unmatched') || i.includes('ends with a heading')
    );
    const qualityIssues = issues.filter(i =>
      i.includes('unknown') || i.includes('very short') || i.includes('parser failure')
    );

    if (truncationIssues.length > 0 && qualityIssues.length > 0) {
      status = 'un_normalizable';
    } else if (truncationIssues.length >= 2) {
      status = 'suspect_truncation';
    } else if (truncationIssues.length === 1) {
      // Single truncation signal is suspect but not blocking on its own
      // unless it's the mid-word truncation (strong signal)
      if (truncationIssues[0].includes('truncated mid-word')) {
        status = 'suspect_truncation';
      }
    }

    if (status === 'ok' && qualityIssues.length > 0) {
      status = 'low_quality';
    }

    return {
      status,
      issues,
      structuralSignature,
      divergenceScore: null
    };
  }
}

module.exports = { DocumentValidator };
