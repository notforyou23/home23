/**
 * SafeResponseFormatter
 * Non-breaking markdown formatter for query responses
 * Falls back to original formatting if anything fails
 */
const SafeResponseFormatter = {
  /**
   * Format response with basic markdown support
   * Completely safe - falls back to original behavior
   * @param {string} text - Raw response text
   * @returns {string} - Formatted HTML or original text with line breaks
   */
  formatResponse(text) {
    if (!text || typeof text !== 'string') {
      return this.escapeHtml(text || '').replace(/\n/g, '<br>');
    }

    try {
      // Check if text contains markdown-like content
      const hasMarkdown = this.detectMarkdown(text);

      if (!hasMarkdown) {
        // No markdown detected, use simple formatting
        return this.escapeHtml(text).replace(/\n/g, '<br>');
      }

      // Try to parse basic markdown
      let html = this.parseBasicMarkdown(text);

      // Validate the result
      if (!html || html.length === 0) {
        throw new Error('Empty result from markdown parsing');
      }

      return html;
    } catch (error) {
      console.warn('Response formatting failed, using fallback:', error.message);
      // Always fall back to safe original behavior
      return this.escapeHtml(text).replace(/\n/g, '<br>');
    }
  },

  /**
   * Detect if text contains markdown elements
   */
  detectMarkdown(text) {
    // Check for common markdown patterns
    const patterns = [
      /^#{1,6}\s+/m,  // Headers
      /```[\s\S]*?```/, // Code blocks
      /`[^`]+`/,       // Inline code
      /\[.*?\]\(.*?\)/, // Links
      /^\s*[-*+]\s+/m, // Lists
      /^\s*\d+\.\s+/m, // Numbered lists
      /\*\*.*?\*\*/,   // Bold
      /\*.*?\*/,       // Italic
      /> /m           // Blockquotes
    ];

    return patterns.some(pattern => pattern.test(text));
  },

  /**
   * Parse basic markdown without external dependencies
   */
  parseBasicMarkdown(text) {
    let html = text;

    // Headers (h1-h6)
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Code blocks (with language detection)
    html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (match, lang, code) => {
      const language = lang || this.detectCodeLanguage(code);
      const escapedCode = this.escapeHtml(code);
      return `<div class="response-code-block"><div class="response-code-header"><span class="response-code-lang">${language}</span></div><pre class="response-code-content"><code>${escapedCode}</code></pre></div>`;
    });

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code class="response-inline-code">$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^[-*+]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
      // Only convert to <ol> if it looks like a numbered list
      if (match.includes('<ul>')) return match;
      return '<ol>' + match + '</ol>';
    });

    // Line breaks (but not in code blocks or headers)
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    // Wrap in paragraphs if not already wrapped
    if (!html.includes('<p>') && !html.includes('<div') && !html.includes('<h')) {
      html = '<p>' + html + '</p>';
    }

    return html;
  },

  /**
   * Simple language detection for code blocks
   */
  detectCodeLanguage(code) {
    const sample = code.trim().toLowerCase();

    if (sample.includes('#!/bin/bash') || sample.includes('#!/usr/bin/env bash')) {
      return 'bash';
    }
    if (sample.includes('#!/usr/bin/env python') || sample.includes('import ') || sample.includes('def ')) {
      return 'python';
    }
    if (sample.includes('#!/usr/bin/env node') || sample.includes('const ') || sample.includes('function ') || sample.includes('=> ')) {
      return 'javascript';
    }
    if (sample.includes('{') && sample.includes('}') && (sample.includes('"') || sample.includes(':'))) {
      try {
        JSON.parse(code);
        return 'json';
      } catch (e) {
        // Not valid JSON
      }
    }
    if (sample.includes('select ') || sample.includes('from ') || sample.includes('where ')) {
      return 'sql';
    }

    return 'text';
  },

  /**
   * Safe HTML escaping
   */
  escapeHtml(text) {
    if (typeof text !== 'string') return '';

    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SafeResponseFormatter;
}
