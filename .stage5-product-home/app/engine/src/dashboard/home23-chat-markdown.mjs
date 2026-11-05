/**
 * Sanitized markdown for dashboard chat. Escape first, then apply a small
 * CommonMark-ish subset so model text never becomes raw HTML.
 */

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderListItems(list, marker, tag) {
  const items = [];
  for (const line of list.replace(/\n+$/, '').split('\n')) {
    if (marker.test(line)) {
      items.push(line.replace(marker, ''));
      continue;
    }
    if (line.trim() === '') continue;
    if (items.length) items[items.length - 1] += `<br>${line.replace(/^\s+/, '')}`;
  }
  return `<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`;
}

function fenceHtml(lang, code) {
  const language = escapeHtml((lang || '').trim());
  const body = escapeHtml(code.replace(/\n$/, ''));
  return `<div class="h23-chat-code"><div class="h23-chat-code-bar"><span class="h23-chat-code-lang">${language}</span><button type="button" class="h23-chat-copy-btn" data-copy="code">Copy</button></div><pre><code>${body}</code></pre></div>`;
}

export function renderMarkdown(text) {
  if (text == null || text === '') return '';
  const source = String(text);
  const fences = [];
  let html = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const token = `\u0000FENCE${fences.length}\u0000`;
    fences.push(fenceHtml(lang, code));
    return token;
  });

  html = escapeHtml(html);

  html = html.replace(/\u0000FENCE(\d+)\u0000/g, (_, index) => fences[Number(index)] || '');

  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  html = html.replace(/(^|\n)((?:\|.+\|(?:\n|$))+)/g, (full, lead, block) => {
    const rows = block.trim().split('\n').filter(Boolean);
    if (rows.length < 2 || !/^\s*\|?\s*:?-{3,}/.test(rows[1])) return full;
    const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    const thead = `<tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr>`;
    const tbody = body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('');
    return `${lead}<table class="h23-chat-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  html = html.replace(/(?:^|\n)((?:\s*[-*] .+(?:\n|$))+)/g, (_, list) => {
    return `\n\n${renderListItems(list, /^\s*[-*]\s+/, 'ul')}\n\n`;
  });
  html = html.replace(/(?:^|\n)((?:\s*\d+\. .+(?:\n|$))+)/g, (_, list) => {
    return `\n\n${renderListItems(list, /^\s*\d+\.\s+/, 'ol')}\n\n`;
  });

  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p>\s*(<(?:h[1-6]|ul|ol|pre|table|blockquote|div)[\s\S]*?<\/(?:h[1-6]|ul|ol|pre|table|blockquote|div)>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}
