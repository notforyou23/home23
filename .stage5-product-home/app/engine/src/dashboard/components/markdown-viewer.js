/**
 * MarkdownViewer Component
 * Full-screen markdown renderer with table of contents
 * Uses marked.js for markdown parsing
 */
class MarkdownViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.isOpen = false;
    
    if (!this.container) {
      console.error(`MarkdownViewer container not found: #${containerId}`);
      return;
    }
    
    this.setupCloseHandlers();
  }
  
  setupCloseHandlers() {
    // Close button
    const closeBtn = this.container.querySelector('.close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    
    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }
  
  async render(markdown, options = {}) {
    const title = options.title || 'Document';
    const showExport = options.showExport !== false;
    
    // Generate TOC
    const toc = this.generateTOC(markdown);
    
    // Parse markdown
    const html = this.parseMarkdown(markdown);
    
    // Build viewer HTML
    this.container.innerHTML = `
      <div class="markdown-viewer-header">
        <h2>${this.escapeHtml(title)}</h2>
        <div class="markdown-viewer-actions">
          ${showExport ? `
            <button class="btn-export" data-format="html">Export HTML</button>
            <button class="btn-export" data-format="md">Export MD</button>
          ` : ''}
          <button class="close-btn">×</button>
        </div>
      </div>
      <div class="markdown-viewer-body">
        <aside class="markdown-toc">
          <h3>Contents</h3>
          ${toc}
        </aside>
        <div class="markdown-content">
          ${html}
        </div>
      </div>
    `;
    
    // Setup export handlers
    if (showExport) {
      this.container.querySelectorAll('.btn-export').forEach(btn => {
        btn.addEventListener('click', () => {
          const format = btn.dataset.format;
          this.export(format, markdown, title);
        });
      });
    }
    
    // Re-setup close handler for new button
    const closeBtn = this.container.querySelector('.close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    
    // Setup TOC click handlers
    this.container.querySelectorAll('.toc-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = link.getAttribute('href').slice(1);
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
    
    this.open();
  }
  
  generateTOC(markdown) {
    const headers = [];
    const lines = markdown.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+)/);
      if (match) {
        const level = match[1].length;
        const text = match[2].trim();
        const id = this.slugify(text);
        headers.push({ level, text, id });
      }
    }
    
    if (headers.length === 0) {
      return '<p class="toc-empty">No sections</p>';
    }
    
    let tocHtml = '<ul class="toc-list">';
    for (const header of headers) {
      const indent = header.level - 1;
      tocHtml += `
        <li class="toc-item toc-level-${header.level}" style="padding-left: ${indent * 12}px">
          <a href="#${header.id}" class="toc-link">${this.escapeHtml(header.text)}</a>
        </li>
      `;
    }
    tocHtml += '</ul>';
    
    return tocHtml;
  }
  
  parseMarkdown(markdown) {
    // Basic markdown parsing (can be replaced with marked.js if available)
    let html = markdown;
    
    // Add IDs to headers
    html = html.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, text) => {
      const level = hashes.length;
      const id = this.slugify(text);
      return `<h${level} id="${id}">${text}</h${level}>`;
    });
    
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    
    // Code blocks
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code class="language-${lang || 'text'}">${this.escapeHtml(code)}</code></pre>`;
    });
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    
    // Lists
    html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    
    // Numbered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    
    // Paragraphs
    html = html.split('\n\n').map(para => {
      if (para.trim() && !para.match(/^<[^>]+>/)) {
        return `<p>${para}</p>`;
      }
      return para;
    }).join('\n');
    
    return html;
  }
  
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  export(format, markdown, title) {
    const filename = `${title.replace(/[^a-z0-9]/gi, '_')}.${format}`;
    let content, mimeType;
    
    if (format === 'md') {
      content = markdown;
      mimeType = 'text/markdown';
    } else if (format === 'html') {
      const html = this.parseMarkdown(markdown);
      content = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1, h2, h3 { margin-top: 2em; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
  </style>
</head>
<body>
${html}
</body>
</html>`;
      mimeType = 'text/html';
    }
    
    // Create download
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  open() {
    this.container.classList.add('open');
    this.isOpen = true;
    document.body.style.overflow = 'hidden';
  }
  
  close() {
    this.container.classList.remove('open');
    this.isOpen = false;
    document.body.style.overflow = '';
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MarkdownViewer;
}

