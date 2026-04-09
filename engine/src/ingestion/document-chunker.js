'use strict';

const crypto = require('crypto');

class DocumentChunker {
  constructor({ maxChunkSize = 3000, overlap = 300, logger = null }) {
    this.maxChunkSize = maxChunkSize;
    this.overlap = overlap;
    this.logger = logger;
  }

  /**
   * Chunk text into canonical typed blocks with hierarchical paths.
   * Falls back to sliding window for oversized blocks.
   * @param {string} text - The text to chunk
   * @param {object} metadata - { filePath, format }
   * @returns {{ chunks: Block[], relationships: Relationship[] }}
   */
  chunk(text, metadata = {}) {
    if (!text || text.trim().length === 0) {
      return { chunks: [], relationships: [] };
    }

    const lines = text.split('\n');
    const rawBlocks = this._parseBlocks(lines);

    // If single block that fits, return directly
    if (rawBlocks.length <= 1 && text.length <= this.maxChunkSize) {
      const block = rawBlocks[0] || { type: 'paragraph', level: 0, path: [], text: text.trim(), strategy: 'semantic' };
      const chunk = {
        blockId: this._shortId(),
        type: block.type,
        level: block.level,
        path: block.path,
        text: block.text.trim(),
        index: 0,
        totalBlocks: 1,
        // backward-compat aliases
        totalChunks: 1,
        heading: block.path.length > 0 ? block.path[block.path.length - 1] : null,
        depth: block.level,
        strategy: block.strategy || 'semantic'
      };
      return { chunks: [chunk], relationships: [] };
    }

    // Split oversized blocks
    const finalBlocks = [];
    for (const block of rawBlocks) {
      if (block.text.length <= this.maxChunkSize) {
        finalBlocks.push(block);
      } else if (block.type === 'code') {
        // Code fences are atomic -- never split mid-fence
        finalBlocks.push(block);
      } else {
        // Try paragraph splitting within the block
        const paragraphs = this._splitByParagraphs(block.text);
        const merged = this._mergeParagraphs(paragraphs);
        for (const piece of merged) {
          finalBlocks.push({
            type: block.type,
            level: block.level,
            path: [...block.path],
            text: piece.text,
            strategy: piece.strategy
          });
        }
      }
    }

    // Number the blocks and build output
    const chunks = finalBlocks.map((b, i) => ({
      blockId: this._shortId(),
      type: b.type,
      level: b.level,
      path: b.path,
      text: b.text.trim(),
      index: i,
      totalBlocks: finalBlocks.length,
      // backward-compat aliases
      totalChunks: finalBlocks.length,
      heading: b.path.length > 0 ? b.path[b.path.length - 1] : null,
      depth: b.level,
      strategy: b.strategy || 'semantic'
    }));

    // Fix totals after final count
    const total = chunks.length;
    chunks.forEach(c => { c.totalBlocks = total; c.totalChunks = total; });

    const relationships = this._buildRelationships(chunks);

    return { chunks, relationships };
  }

  // ─── Block Parsing ─────────────────────────────────────────

  /**
   * Parse lines into typed blocks with hierarchical path construction.
   */
  _parseBlocks(lines) {
    const blocks = [];
    const headingStack = []; // [{ text, level }]
    let currentLines = [];
    let currentType = 'paragraph';
    let inCodeFence = false;
    let codeFenceLines = [];
    let currentPath = [];

    const flushCurrent = () => {
      const text = currentLines.join('\n').trim();
      if (text.length > 0) {
        blocks.push({
          type: currentType,
          level: 0,
          path: [...currentPath],
          text,
          strategy: 'semantic'
        });
      }
      currentLines = [];
      currentType = 'paragraph';
    };

    const getCurrentPath = () => headingStack.map(h => h.text);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track code fences
      if (line.trimStart().startsWith('```')) {
        if (!inCodeFence) {
          // Start of code fence -- flush anything before it
          flushCurrent();
          inCodeFence = true;
          codeFenceLines = [line];
          continue;
        } else {
          // End of code fence
          codeFenceLines.push(line);
          inCodeFence = false;
          blocks.push({
            type: 'code',
            level: 0,
            path: [...currentPath],
            text: codeFenceLines.join('\n'),
            strategy: 'semantic'
          });
          codeFenceLines = [];
          continue;
        }
      }

      if (inCodeFence) {
        codeFenceLines.push(line);
        continue;
      }

      // Check for markdown headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushCurrent();
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();

        // Pop headings at same or deeper level
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ text: headingText, level });
        currentPath = getCurrentPath();

        blocks.push({
          type: 'heading',
          level,
          path: [...currentPath],
          text: line.trim(),
          strategy: 'semantic'
        });
        continue;
      }

      // Check for HTML headings
      const htmlHeadingMatch = line.match(/<h([1-6])[^>]*>(.*?)<\/h\1>/i);
      if (htmlHeadingMatch) {
        flushCurrent();
        const level = parseInt(htmlHeadingMatch[1], 10);
        const headingText = htmlHeadingMatch[2].replace(/<[^>]+>/g, '').trim();

        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ text: headingText, level });
        currentPath = getCurrentPath();

        blocks.push({
          type: 'heading',
          level,
          path: [...currentPath],
          text: line.trim(),
          strategy: 'semantic'
        });
        continue;
      }

      // Check for horizontal rules (section breaks)
      if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line.trim())) {
        flushCurrent();
        continue;
      }

      // Check for table lines
      if (this._isTableLine(line)) {
        if (currentType !== 'table') {
          flushCurrent();
          currentType = 'table';
        }
        currentLines.push(line);
        continue;
      }

      // Check for list items
      if (this._isListItem(line)) {
        if (currentType !== 'list_item') {
          flushCurrent();
          currentType = 'list_item';
        }
        currentLines.push(line);
        continue;
      }

      // Check for definition patterns
      if (this._isDefinition(line)) {
        if (currentType !== 'definition') {
          flushCurrent();
          currentType = 'definition';
        }
        currentLines.push(line);
        continue;
      }

      // Check for signature lines (near end of document)
      if (this._isSignatureLine(line) && i >= lines.length * 0.7) {
        if (currentType !== 'signature') {
          flushCurrent();
          currentType = 'signature';
        }
        currentLines.push(line);
        continue;
      }

      // Check for footer patterns (last 10% of doc)
      if (this._isFooterLine(line) && i >= lines.length * 0.9) {
        if (currentType !== 'footer') {
          flushCurrent();
          currentType = 'footer';
        }
        currentLines.push(line);
        continue;
      }

      // If we were accumulating a non-paragraph type and hit a normal line,
      // flush the special block
      if (currentType !== 'paragraph' && currentType !== 'table' && line.trim().length > 0) {
        // Allow continuation of list items if indented
        if (currentType === 'list_item' && /^\s{2,}/.test(line)) {
          currentLines.push(line);
          continue;
        }
        // Allow continuation of definitions for next line
        if (currentType === 'definition' && line.trim().length > 0 && !this._isListItem(line)) {
          currentLines.push(line);
          continue;
        }
        flushCurrent();
      }

      currentLines.push(line);
    }

    // Handle unclosed code fence
    if (inCodeFence && codeFenceLines.length > 0) {
      blocks.push({
        type: 'code',
        level: 0,
        path: [...currentPath],
        text: codeFenceLines.join('\n'),
        strategy: 'semantic'
      });
    }

    flushCurrent();

    return blocks;
  }

  // ─── Type Detection ────────────────────────────────────────

  _isTableLine(line) {
    // Pipe-delimited table rows or HTML table tags
    if (/^\s*\|.*\|/.test(line)) return true;
    if (/<\/?table/i.test(line) || /<\/?t[rdh]/i.test(line)) return true;
    // Separator rows like |---|---|
    if (/^\s*\|[\s\-:]+\|/.test(line)) return true;
    return false;
  }

  _isListItem(line) {
    return /^\s*[-*+]\s/.test(line) || /^\s*\d+[.)]\s/.test(line);
  }

  _isDefinition(line) {
    // Patterns: "X" means, 'X' means, As used herein, shall mean, Term shall mean
    if (/["'].+?["']\s+means?\b/i.test(line)) return true;
    if (/\bshall mean\b/i.test(line)) return true;
    if (/\bas used herein\b/i.test(line)) return true;
    if (/\bterm shall\b/i.test(line)) return true;
    if (/^["'].+?["']\s*[-:]/i.test(line)) return true;
    return false;
  }

  _isSignatureLine(line) {
    const trimmed = line.trim();
    if (/^_{3,}/.test(trimmed)) return true;
    if (/^Signed:/i.test(trimmed)) return true;
    if (/^By:\s/i.test(trimmed)) return true;
    if (/^Name:\s/i.test(trimmed)) return true;
    if (/^Title:\s/i.test(trimmed)) return true;
    if (/^Date:\s/i.test(trimmed)) return true;
    return false;
  }

  _isFooterLine(line) {
    const trimmed = line.trim();
    // Page numbers
    if (/^(Page\s+)?\d+(\s+of\s+\d+)?$/i.test(trimmed)) return true;
    // Copyright
    if (/copyright\s*(\(c\)|©)/i.test(trimmed)) return true;
    if (/^©\s*\d{4}/i.test(trimmed)) return true;
    // Disclaimer patterns
    if (/^(CONFIDENTIAL|DISCLAIMER|PRIVILEGED)/i.test(trimmed)) return true;
    // All rights reserved
    if (/all rights reserved/i.test(trimmed)) return true;
    return false;
  }

  // ─── Paragraph & Sliding Window (unchanged logic) ──────────

  /**
   * Split text into paragraphs (double newline boundaries).
   * Code fences are kept intact as single units.
   */
  _splitByParagraphs(text) {
    const parts = [];
    const fenceRegex = /```[\s\S]*?```/g;
    let lastIndex = 0;
    let match;

    while ((match = fenceRegex.exec(text)) !== null) {
      const before = text.slice(lastIndex, match.index);
      if (before.trim()) {
        parts.push(...before.split(/\n\s*\n/).filter(p => p.trim().length > 0));
      }
      parts.push(match[0]);
      lastIndex = match.index + match[0].length;
    }

    const after = text.slice(lastIndex);
    if (after.trim()) {
      parts.push(...after.split(/\n\s*\n/).filter(p => p.trim().length > 0));
    }

    return parts.length > 0 ? parts : text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  }

  /**
   * Merge paragraphs into pieces that fit within maxChunkSize.
   * Falls back to sliding window for individual oversized paragraphs.
   */
  _mergeParagraphs(paragraphs) {
    const merged = [];
    let buffer = '';

    for (const para of paragraphs) {
      if (para.length > this.maxChunkSize) {
        if (buffer.trim()) {
          merged.push({ text: buffer, strategy: 'semantic' });
          buffer = '';
        }
        if (para.trimStart().startsWith('```')) {
          merged.push({ text: para, strategy: 'semantic' });
        } else {
          const swResult = this._slidingWindowChunk(para);
          for (const c of swResult.chunks) {
            merged.push({ text: c.text, strategy: 'sliding-window' });
          }
        }
        continue;
      }

      const combined = buffer ? buffer + '\n\n' + para : para;
      if (combined.length > this.maxChunkSize) {
        if (buffer.trim()) {
          merged.push({ text: buffer, strategy: 'semantic' });
        }
        buffer = para;
      } else {
        buffer = combined;
      }
    }

    if (buffer.trim()) {
      merged.push({ text: buffer, strategy: 'semantic' });
    }

    return merged;
  }

  /**
   * Sliding window chunking -- fixed size with overlap.
   */
  _slidingWindowChunk(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + this.maxChunkSize, text.length);
      chunks.push({
        text: text.slice(start, end),
        index: chunks.length,
        totalChunks: 0,
        strategy: 'sliding-window'
      });
      if (end === text.length) break;
      start += this.maxChunkSize - this.overlap;
    }
    chunks.forEach(c => { c.totalChunks = chunks.length; });

    const relationships = this._buildRelationships(chunks);
    return { chunks, relationships };
  }

  // ─── Relationships ─────────────────────────────────────────

  /**
   * Build FOLLOWS and CONTAINS relationships between chunks.
   */
  _buildRelationships(chunks) {
    const relationships = [];
    for (let i = 0; i < chunks.length - 1; i++) {
      relationships.push({ from: i, to: i + 1, type: 'FOLLOWS' });
    }
    for (let i = 0; i < chunks.length - 1; i++) {
      const parent = chunks[i].heading || chunks[i + 1].heading || 'document';
      relationships.push({ from: i, to: i + 1, type: 'CONTAINS', parent });
    }
    return relationships;
  }

  // ─── Utilities ─────────────────────────────────────────────

  _shortId() {
    return 'b_' + crypto.randomBytes(6).toString('hex');
  }
}

module.exports = { DocumentChunker };
