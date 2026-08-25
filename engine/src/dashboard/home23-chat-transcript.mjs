/**
 * Typed transcript rows for dashboard chat.
 * DOM helpers take a container; history projection is pure and unit-tested.
 */

import { escapeHtml, renderMarkdown } from './home23-chat-markdown.mjs';

export const SHOW_MORE_CHARS = 100_000;

const CHAT_STARTER_PROMPTS = Object.freeze([
  'Hey Jerry. Where are we?',
  'What changed since we last talked that actually matters?',
  'What have we forgotten or let fall by the wayside?',
  'What are you noticing that I’m not?',
  'TCB: pick the most worthwhile thing you can finish right now.',
  'Pick up our most alive thread and make the next move.',
  'What actually needs me today—and what can you handle?',
  'Let’s make something. Give me three directions worth pursuing.',
]);

export function formatTranscriptMarkdown(rows, meta = {}) {
  const lines = [];
  const hasMeta = meta.agent || meta.conversationId || meta.exportedAt;
  if (hasMeta) {
    lines.push('# Chat transcript');
    if (meta.agent) lines.push(`Agent: ${meta.agent}`);
    if (meta.conversationId) lines.push(`Conversation: ${meta.conversationId}`);
    if (meta.exportedAt) lines.push(`Exported: ${meta.exportedAt}`);
    lines.push('');
  }

  for (const row of rows || []) {
    if (row.kind === 'user') {
      lines.push('## User', '', row.text || '');
      if (row.imageCount) {
        const noun = row.imageCount === 1 ? 'image attachment' : 'image attachments';
        lines.push('', `(${row.imageCount} ${noun})`);
      }
      lines.push('');
    } else if (row.kind === 'thinking') {
      lines.push('## Thought', '', row.text || '', '');
    } else if (row.kind === 'tool') {
      lines.push(`## Tool \`${row.name || 'tool'}\` (${row.status || 'complete'})`, '');
      if (row.args) lines.push('Arguments:', '', '```', String(row.args), '```', '');
      if (row.result) lines.push('Result:', '', '```', String(row.result), '```', '');
    } else if (row.kind === 'assistant') {
      lines.push('## Assistant', '', row.text || '', '');
    } else if (row.kind === 'media') {
      lines.push('## Media', '', row.caption || row.path || '', '');
    } else if (row.kind === 'work') {
      lines.push(`## Work (${row.status || 'completed'})`, '', row.label || '', '');
      if (row.result) lines.push('```', String(row.result), '```', '');
    } else if (row.kind === 'error') {
      lines.push('## Error', '', row.text || '', '');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

export function snapshotTranscriptRows(container) {
  if (!container) return [];
  const rows = [];
  for (const el of container.children) {
    if (el.classList?.contains('h23-chat-empty')) continue;
    if (el.classList?.contains('h23-chat-msg') && el.classList.contains('user')) {
      rows.push({
        kind: 'user',
        text: el.querySelector('.h23-chat-msg-text')?.textContent || '',
        imageCount: el.querySelectorAll('.h23-chat-msg-images img').length,
      });
    } else if (el.classList?.contains('h23-chat-thinking')) {
      rows.push({
        kind: 'thinking',
        text: el.querySelector('.h23-chat-thinking-body')?.textContent || '',
      });
    } else if (el.classList?.contains('h23-chat-tool')) {
      rows.push({
        kind: 'tool',
        name: el.querySelector('.h23-chat-tool-name')?.textContent || 'tool',
        status: el.dataset?.status || 'complete',
        args: el.querySelector('.h23-chat-tool-args .h23-chat-machine-body')?.textContent || '',
        result: el.querySelector('.h23-chat-tool-result')?.textContent || '',
      });
    } else if (el.classList?.contains('h23-chat-work')) {
      const labelEl = el.querySelector('.h23-chat-work-header span');
      rows.push({
        kind: 'work',
        label: labelEl?.textContent || 'Background work',
        status: el.dataset?.status || 'completed',
        result: el.querySelector('.h23-chat-machine-body')?.textContent || '',
      });
    } else if (el.classList?.contains('h23-chat-error')) {
      rows.push({ kind: 'error', text: el.textContent || '' });
    } else if (el.classList?.contains('h23-chat-msg') && el.classList.contains('assistant')) {
      if (el.classList.contains('h23-chat-media')) {
        rows.push({
          kind: 'media',
          caption: el.querySelector('.h23-chat-media-caption')?.textContent || el.textContent || '',
        });
      } else {
        rows.push({
          kind: 'assistant',
          text: el.querySelector('.h23-chat-msg-text')?.innerText
            || el.querySelector('.h23-chat-msg-text')?.textContent
            || '',
        });
      }
    }
  }
  return rows;
}

export function stringifyPayload(value) {
  let text = '';
  if (value == null) text = '';
  else if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value); }
  }
  const overflow = text.length > SHOW_MORE_CHARS;
  return {
    text,
    display: overflow ? text.slice(0, SHOW_MORE_CHARS) : text,
    overflow,
  };
}

function asRecord(value) {
  return value && typeof value === 'object' ? value : null;
}

export function collectThinkingText(records, { separator = '\n\n', currentTurnOnly = true } = {}) {
  const rows = projectHistoryToRows(records);
  const thinkingRows = rows.filter((row) => row.kind === 'thinking');
  let selected = thinkingRows;
  if (currentTurnOnly) {
    let afterUser = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'user') afterUser = i + 1;
    }
    const trailing = rows.slice(afterUser).filter((row) => row.kind === 'thinking');
    if (trailing.length) {
      selected = trailing;
    } else {
      const lastTurnId = [...thinkingRows].reverse().find((row) => row.turnId)?.turnId;
      selected = lastTurnId
        ? thinkingRows.filter((row) => row.turnId === lastTurnId)
        : thinkingRows.slice(-1);
    }
  }
  return selected
    .map((row) => String(row.text || '').trim())
    .filter(Boolean)
    .join(separator);
}

export function projectHistoryToRows(records) {
  const rows = [];
  const pendingTools = [];

  for (const raw of records || []) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (rec.type === 'turn') continue;
    if (rec.type === 'event' || rec.kind) {
      const data = asRecord(rec.data) || rec;
      const kind = rec.kind || data.type;
      const turnId = rec.turn_id || data.turn_id || null;
      if (kind === 'thinking') {
        rows.push({
          kind: 'thinking',
          text: String(data.content || data.message || ''),
          turnId,
          collapsed: true,
        });
        continue;
      }
      if (kind === 'tool_start') {
        const row = {
          kind: 'tool',
          name: String(data.tool || data.name || 'tool'),
          args: data.args ?? null,
          result: '',
          status: 'running',
          success: null,
          turnId,
        };
        rows.push(row);
        pendingTools.push(row);
        continue;
      }
      if (kind === 'tool_result' || kind === 'tool_complete') {
        const name = String(data.tool || data.name || 'tool');
        const target = [...pendingTools].reverse().find((row) => row.name === name && row.status === 'running')
          || [...rows].reverse().find((row) => row.kind === 'tool' && row.name === name);
        const result = data.result ?? data.summary ?? data.output ?? '';
        const success = data.success !== false && kind !== 'tool_error';
        if (target) {
          target.result = result;
          target.status = success ? 'complete' : 'error';
          target.success = success;
        } else {
          rows.push({
            kind: 'tool',
            name,
            args: null,
            result,
            status: success ? 'complete' : 'error',
            success,
            turnId,
          });
        }
        continue;
      }
      if (kind === 'response_chunk') continue;
      if (kind === 'media') {
        rows.push({
          kind: 'media',
          mediaType: data.mediaType || 'image',
          path: data.path || '',
          caption: data.caption || '',
          turnId,
        });
        continue;
      }
      if (kind === 'subagent_result') {
        rows.push({
          kind: 'work',
          label: String(data.task || 'Sub-agent'),
          result: String(data.result || ''),
          status: String(data.result || '').startsWith('Error:') ? 'failed' : 'completed',
          turnId,
        });
        continue;
      }
      continue;
    }
    if (rec.role === 'user' && rec.content) {
      rows.push({ kind: 'user', text: String(rec.content) });
    } else if (rec.role === 'assistant' && rec.content) {
      rows.push({
        kind: 'assistant',
        text: String(rec.content),
        turnId: rec.turn_id || null,
      });
    }
  }
  return rows;
}

function copyButton(label = 'Copy') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'h23-chat-copy-btn';
  btn.textContent = label;
  return btn;
}

function bindCopy(btn, getText) {
  if (!btn) return;
  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = typeof getText === 'function' ? getText() : String(getText || '');
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    } catch {
      btn.textContent = 'Copy failed';
    }
  });
}

function machineBlock(heading, payload, { startCollapsed = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'h23-chat-machine';
  const parsed = stringifyPayload(payload);
  wrap.dataset.fullText = parsed.text;
  const head = document.createElement('div');
  head.className = 'h23-chat-machine-head';
  const title = document.createElement('span');
  title.textContent = heading;
  const copy = copyButton();
  bindCopy(copy, () => wrap.dataset.fullText || parsed.text);
  head.append(title, copy);
  const body = document.createElement('pre');
  body.className = 'h23-chat-machine-body';
  body.textContent = parsed.display;
  if (parsed.overflow) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'h23-chat-show-more';
    more.textContent = 'Show more';
    more.addEventListener('click', () => {
      body.textContent = wrap.dataset.fullText || parsed.text;
      more.remove();
    });
    wrap.append(head, body, more);
  } else {
    wrap.append(head, body);
  }
  if (startCollapsed) wrap.hidden = true;
  return wrap;
}

export function createTranscript(container, options = {}) {
  const render = options.renderMarkdown || renderMarkdown;
  let pinnedToBottom = true;
  let liveThinking = null;
  let liveAssistant = null;
  let onPinnedChange = options.onPinnedChange || null;
  let showThinking = options.showThinking !== false;

  function setPinned(next) {
    if (pinnedToBottom === next) return;
    pinnedToBottom = next;
    if (onPinnedChange) onPinnedChange(pinnedToBottom);
  }

  function maybeScroll() {
    if (!pinnedToBottom || !container) return;
    container.scrollTop = container.scrollHeight;
  }

  if (container && !container.dataset.pinBound) {
    container.addEventListener('scroll', () => {
      const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
      setPinned(gap < 48);
    });
    container.dataset.pinBound = 'true';
  }

  function emptyState(text) {
    if (!container) return;
    container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'h23-chat-empty';

    if (text !== undefined) {
      empty.textContent = text;
      container.appendChild(empty);
      return;
    }

    empty.className += ' h23-chat-empty-prompts';
    empty.setAttribute('role', 'group');
    empty.setAttribute('aria-label', 'Conversation starters');
    const prompts = document.createElement('div');
    prompts.className = 'h23-chat-starters';
    for (const prompt of CHAT_STARTER_PROMPTS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'h23-chat-starter';
      button.textContent = prompt;
      button.addEventListener('click', () => options.onPromptSelect?.(prompt));
      prompts.appendChild(button);
    }
    empty.appendChild(prompts);
    container.appendChild(empty);
  }

  function clearEmpty() {
    container?.querySelector('.h23-chat-empty')?.remove();
  }

  function appendUser(text, imageDataUrls = []) {
    if (!container) return null;
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'h23-chat-msg user';
    if (imageDataUrls?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'h23-chat-msg-images';
      for (const url of imageDataUrls) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'attachment';
        wrap.appendChild(img);
      }
      div.appendChild(wrap);
    }
    if (text) {
      const body = document.createElement('div');
      body.className = 'h23-chat-msg-text';
      body.textContent = text;
      div.appendChild(body);
    }
    const copy = copyButton();
    bindCopy(copy, text || '');
    div.appendChild(copy);
    container.appendChild(div);
    liveThinking = null;
    liveAssistant = null;
    maybeScroll();
    return div;
  }

  function appendThinking(text, { live = true, collapsed = !showThinking } = {}) {
    if (!container) return null;
    clearEmpty();
    const details = document.createElement('details');
    details.className = 'h23-chat-thinking';
    details.open = !collapsed;
    if (live) details.dataset.live = 'true';
    const summary = document.createElement('summary');
    summary.className = 'h23-chat-thinking-summary';
    summary.textContent = live ? 'Thinking' : 'Thought';
    const body = document.createElement('div');
    body.className = 'h23-chat-thinking-body';
    body.textContent = text || '';
    details.append(summary, body);
    container.appendChild(details);
    if (live) liveThinking = details;
    if (showThinking) maybeScroll();
    return details;
  }

  function updateThinking(text) {
    if (!liveThinking) return appendThinking(text, { live: true, collapsed: !showThinking });
    const body = liveThinking.querySelector('.h23-chat-thinking-body');
    if (body) body.textContent = text || '';
    liveThinking.open = showThinking;
    return liveThinking;
  }

  function collapseThinking() {
    if (!liveThinking) return;
    liveThinking.open = showThinking;
    liveThinking.dataset.live = 'false';
    const summary = liveThinking.querySelector('summary');
    if (summary) summary.textContent = 'Thought';
    liveThinking = null;
  }

  function setShowThinking(next) {
    showThinking = Boolean(next);
    if (!container) return showThinking;
    for (const el of container.querySelectorAll('.h23-chat-thinking')) {
      el.open = showThinking;
    }
    return showThinking;
  }

  function appendTool(name, args, status = 'running') {
    if (!container) return null;
    clearEmpty();
    collapseThinking();
    liveAssistant = null;
    const card = document.createElement('div');
    card.className = 'h23-chat-tool';
    card.dataset.toolName = name || 'tool';
    card.dataset.status = status;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'h23-chat-tool-header';
    const label = document.createElement('span');
    label.className = 'h23-chat-tool-name';
    label.textContent = name || 'tool';
    const badge = document.createElement('span');
    badge.className = 'h23-chat-tool-status';
    badge.textContent = status === 'running' ? 'Running' : status === 'error' ? 'Failed' : 'Complete';
    header.append(label, badge);
    const body = document.createElement('div');
    body.className = 'h23-chat-tool-body';
    body.hidden = true;
    if (args != null && args !== '') {
      const argsBlock = machineBlock('Arguments', args, { startCollapsed: false });
      argsBlock.hidden = false;
      argsBlock.classList.add('h23-chat-tool-args');
      body.appendChild(argsBlock);
    }
    const resultBlock = document.createElement('div');
    resultBlock.className = 'h23-chat-tool-result';
    body.appendChild(resultBlock);
    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      card.classList.toggle('open', !body.hidden);
    });
    card.append(header, body);
    container.appendChild(card);
    maybeScroll();
    return card;
  }

  function updateTool(name, result, success = true) {
    const selectorName = String(name || 'tool').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const cards = container?.querySelectorAll(`.h23-chat-tool[data-tool-name="${selectorName}"]`);
    const card = cards?.[cards.length - 1];
    if (!card) return appendTool(name, null, success ? 'complete' : 'error');
    card.dataset.status = success ? 'complete' : 'error';
    const badge = card.querySelector('.h23-chat-tool-status');
    if (badge) {
      badge.textContent = success ? 'Complete' : 'Failed';
      badge.classList.toggle('done', success);
      badge.classList.toggle('error', !success);
    }
    if (result != null && result !== '') {
      const resultHost = card.querySelector('.h23-chat-tool-result');
      if (resultHost) {
        resultHost.innerHTML = '';
        const block = machineBlock('Result', result, { startCollapsed: false });
        block.hidden = false;
        resultHost.appendChild(block);
      }
    }
    maybeScroll();
    return card;
  }

  function appendAssistant(text, turnId) {
    if (!container) return null;
    clearEmpty();
    collapseThinking();
    const div = document.createElement('div');
    div.className = 'h23-chat-msg assistant';
    if (turnId) div.dataset.turnId = turnId;
    const body = document.createElement('div');
    body.className = 'h23-chat-msg-text';
    body.innerHTML = render(text || '');
    const copy = copyButton();
    bindCopy(copy, text || '');
    body.querySelectorAll('[data-copy="code"]').forEach((btn) => {
      const code = btn.closest('.h23-chat-code')?.querySelector('code');
      bindCopy(btn, () => code?.textContent || '');
    });
    div.append(body, copy);
    container.appendChild(div);
    liveAssistant = div;
    maybeScroll();
    return div;
  }

  function updateAssistant(text, turnId) {
    if (!liveAssistant) return appendAssistant(text, turnId);
    if (turnId) liveAssistant.dataset.turnId = turnId;
    const body = liveAssistant.querySelector('.h23-chat-msg-text');
    if (body) {
      body.innerHTML = render(text || '');
      body.querySelectorAll('[data-copy="code"]').forEach((btn) => {
        const code = btn.closest('.h23-chat-code')?.querySelector('code');
        bindCopy(btn, () => code?.textContent || '');
      });
    }
    const copy = liveAssistant.querySelector(':scope > .h23-chat-copy-btn');
    if (copy) bindCopy(copy, text || '');
    maybeScroll();
    return liveAssistant;
  }

  function appendMedia(mediaType, filePath, caption) {
    if (!container) return null;
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'h23-chat-msg assistant h23-chat-media';
    if (mediaType === 'image') {
      div.innerHTML = `
        <img src="/home23/api/media?path=${encodeURIComponent(filePath)}" alt="${escapeHtml(caption || 'Generated image')}">
        ${caption ? `<div class="h23-chat-media-caption">${escapeHtml(caption)}</div>` : ''}
      `;
    } else {
      div.textContent = `[${mediaType}: ${filePath}]${caption ? ` — ${caption}` : ''}`;
    }
    container.appendChild(div);
    maybeScroll();
    return div;
  }

  function appendError(text) {
    if (!container) return null;
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'h23-chat-error';
    div.textContent = text || 'Error';
    container.appendChild(div);
    maybeScroll();
    return div;
  }

  function appendWorkReceipt(row) {
    if (!container) return null;
    clearEmpty();
    const card = document.createElement('div');
    card.className = 'h23-chat-work';
    card.dataset.status = row.status || 'completed';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'h23-chat-work-header';
    const label = document.createElement('span');
    label.textContent = row.label || 'Background work';
    const badge = document.createElement('span');
    badge.className = 'h23-chat-work-status';
    badge.textContent = row.status || 'completed';
    header.append(label, badge);
    const body = machineBlock('Receipt', row.result || '', { startCollapsed: false });
    body.hidden = true;
    header.addEventListener('click', () => { body.hidden = !body.hidden; });
    card.append(header, body);
    container.appendChild(card);
    maybeScroll();
    return card;
  }

  function renderHistory(records) {
    if (!container) return;
    container.innerHTML = '';
    liveThinking = null;
    liveAssistant = null;
    const rows = projectHistoryToRows(records);
    if (rows.length === 0) {
      emptyState();
      return;
    }
    for (const row of rows) {
      if (row.kind === 'user') appendUser(row.text);
      else if (row.kind === 'thinking') continue;
      else if (row.kind === 'tool') {
        appendTool(row.name, row.args, row.status);
        if (row.result) updateTool(row.name, row.result, row.success !== false);
      } else if (row.kind === 'assistant') appendAssistant(row.text, row.turnId);
      else if (row.kind === 'media') appendMedia(row.mediaType, row.path, row.caption);
      else if (row.kind === 'work') appendWorkReceipt(row);
    }
    liveAssistant = null;
    liveThinking = null;
    pinnedToBottom = true;
    maybeScroll();
  }

  function beginAssistantTurn() {
    collapseThinking();
    liveAssistant = null;
  }

  return {
    emptyState,
    clear() { if (container) container.innerHTML = ''; liveThinking = null; liveAssistant = null; },
    appendUser,
    appendThinking,
    updateThinking,
    collapseThinking,
    setShowThinking,
    appendTool,
    updateTool,
    appendAssistant,
    updateAssistant,
    appendMedia,
    appendError,
    appendWorkReceipt,
    renderHistory,
    toMarkdown(meta = {}) {
      const rows = snapshotTranscriptRows(container);
      if (meta.thinkingText && !rows.some((row) => row.kind === 'thinking')) {
        rows.push({ kind: 'thinking', text: meta.thinkingText });
      }
      return formatTranscriptMarkdown(rows, meta);
    },
    beginAssistantTurn,
    maybeScroll,
    jumpToLatest() { setPinned(true); maybeScroll(); },
    isPinned() { return pinnedToBottom; },
    setOnPinnedChange(cb) { onPinnedChange = cb; },
    get liveAssistant() { return liveAssistant; },
    set liveAssistant(el) { liveAssistant = el; },
  };
}
