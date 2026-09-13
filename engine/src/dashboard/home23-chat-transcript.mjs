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
        text: el.querySelector('.h23-chat-thinking-body')?.dataset.sourceText || el.querySelector('.h23-chat-thinking-body')?.textContent || '',
      });
    } else if (el.classList?.contains('h23-chat-tool')) {
      rows.push({
        kind: 'tool',
        name: el.dataset.toolName || el.querySelector('.h23-chat-tool-name')?.textContent || 'tool',
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
        result: el.dataset.resultText ?? el.querySelector('.h23-chat-machine-body')?.textContent ?? '',
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
          text: el.dataset.sourceText || el.querySelector('.h23-chat-msg-text')?.innerText
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

// Old records lack call IDs. Only pair them when there is one possible caller;
// choosing the latest same-name call corrupts parallel tool results.
export function matchingTool(rows, name, toolCallId, turnId) {
  const candidates = rows.filter((row) => row.name === name
    && (turnId == null || row.turnId === turnId));
  if (toolCallId) return candidates.find((row) => row.toolCallId === toolCallId) || null;
  const pending = candidates.filter((row) => row.status === 'running');
  return pending.length === 1 ? pending[0] : null;
}

export function workConversationId(work) {
  return work?.originChatId || null;
}

export function toolLabel(name, args) {
  const labels = { channel_manage: 'Manage channel', read_file: 'Read file', files_read: 'Read file',
    shell: 'Run command', shell_exec: 'Run command', coding_run: 'Coding task', coding_continue: 'Continue coding task',
    spawn_agent: 'Delegate to subagent', worker_run: 'Run specialist', brain_query: 'Search memory',
    brain_status: 'Check memory', web_search: 'Search the web', bot_invoke: 'Ask a bot' };
  const label = labels[name] || String(name || 'Tool').replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
  const operation = args?.operation ?? args?.action;
  const channelActions = { list: 'List channels', get: 'Read channel', read: 'Read channel', create: 'Create channel',
    update: 'Update channel', archive: 'Archive channel', delete: 'Delete channel', join: 'Join channel', leave: 'Leave channel' };
  if (name === 'channel_manage' && channelActions[operation]) return channelActions[operation];
  const action = name === 'channel_manage' && typeof operation === 'string' ? operation.replaceAll('_', ' ') : '';
  return action ? `${label} · ${action}` : label;
}

function decodedResult(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function resultReportsFailure(value, depth = 0) {
  if (depth >= 5) return false;
  const result = decodedResult(value);
  if (typeof result === 'string') return /^(error|failed):/i.test(result);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.ok === false || result.success === false || result.isError === true || result.is_error === true) return true;
  if (result.error != null && result.error !== false && result.error !== '') return true;
  if (['failed', 'error'].includes(String(result.status || '').toLowerCase())) return true;
  return ['result', 'data', 'output'].some(key => resultReportsFailure(result[key], depth + 1));
}

export function toolOutcome(result, success) {
  if (success === false || resultReportsFailure(result)) return 'error';
  const payload = decodedResult(result);
  if (success === true || payload?.ok === true || payload?.success === true) return 'complete';
  return 'finished';
}

function toolOutcomeLabel(status) {
  return { running: 'Running', error: 'Failed', complete: 'Complete', finished: 'Finished' }[status] || 'Finished';
}

export function readableToolResult(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return parsed; }
  }
  if (!parsed || typeof parsed !== 'object') return String(parsed ?? '');
  for (const key of ['summary', 'message', 'resultText', 'text', 'description']) {
    if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key];
  }
  if (parsed.error) return typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'The tool reported an error.';
  for (const key of ['channels', 'bots', 'items', 'results', 'files']) {
    if (Array.isArray(parsed[key])) return `${parsed[key].length} ${parsed[key].length === 1 ? key.slice(0, -1) : key} returned.`;
  }
  if (Array.isArray(parsed)) return `${parsed.length} items returned.`;
  if (parsed.title || parsed.name) return String(parsed.title || parsed.name);
  return 'Result received. Technical details are available below.';
}

export function activityStatusLabel(status) {
  if (['provider_active', 'awaiting_model', 'brain_operation_active', 'joined_work_active'].includes(status)) return null;
  return { stopping: 'Stopping', queued: 'Queued', running: 'Working', blocked: 'Needs attention',
    operator_steer: 'Direction updated', retrying: 'Retrying' }[status] || 'Working';
}

export function workReceiptPresentation(work, detail) {
  const result = work?.terminalResult?.resultText || work?.error
    || (typeof detail === 'string' ? detail : '');
  return {
    ...(result ? { result } : {}),
    technicalResult: detail ?? work?.terminalResult?.receiptText ?? '',
  };
}

export function subagentStatus(event) {
  if (event.type === 'subagent_start') return 'running';
  if (event.sourceEventType === 'runtime.subagent_cancelled' || String(event.result || '').startsWith('Cancelled:')) return 'cancelled';
  const outcome = toolOutcome(event.result, event.success);
  return outcome === 'error' ? 'failed' : outcome === 'complete' ? 'completed' : 'finished';
}

function mergeActivityRecords(previous = [], incoming = []) {
  const retained = new Map();
  for (const record of [...previous, ...incoming]) retained.set(`${record.turn_id}:${record.seq}`, record);
  for (const record of [...retained.values()]) {
    if (!(record.display_start_seq < record.seq)) continue;
    const ownKey = `${record.turn_id}:${record.seq}`;
    for (const [key, existing] of retained) {
      if (key !== ownKey && existing.turn_id === record.turn_id
          && (existing.display_start_seq ?? existing.seq) >= record.display_start_seq
          && existing.seq <= record.seq) retained.delete(key);
    }
  }
  return [...retained.values()].sort((a, b) => a.seq - b.seq);
}

export function subagentProgressRow(event, previous = {}, depth = 0, identity = {}) {
  const activity = event.activity || {};
  const kind = activity.type;
  const record = { type: 'event', kind, turn_id: `${identity.turnId || ''}/${event.subagentId}`,
    seq: Number.isInteger(identity.sequence) ? identity.sequence : (previous.activityRecords?.length || 0) + 1,
    ...(Number.isInteger(identity.startSequence) ? { display_start_seq: identity.startSequence } : {}),
    data: activity };
  if (previous.activityRecords?.some(item => item.turn_id === record.turn_id && item.seq === record.seq)) return previous;
  const activityRecords = mergeActivityRecords(previous.activityRecords, [record]);
  const row = {
    ...previous, kind: 'work', workId: event.subagentId,
    label: previous.label || event.label || event.task || 'Subagent',
    task: event.task || previous.task || '',
    status: ['completed', 'finished', 'failed', 'cancelled', 'interrupted'].includes(previous.status) ? previous.status : 'running', preserveStream: true,
    technicalResult: activity,
    activityRecords,
    ...(identity.turnId ? { turnId: identity.turnId } : {}),
  };
  let text = '';
  if (kind === 'thinking' || kind === 'response_chunk' || kind === 'text') {
    const piece = kind === 'thinking' ? activity.content || activity.message || '' : activity.chunk || activity.text || '';
    if (piece) {
      row.progressKind = kind;
      row.progressText = ((previous.progressKind === kind ? previous.progressText || '' : '') + piece).slice(-4000);
      text = kind === 'thinking' ? `Thinking\n\n${row.progressText}` : row.progressText;
    }
  } else if (kind === 'tool_start') {
    text = toolLabel(activity.tool || activity.name, activity.args);
  } else if (kind === 'tool_result' || kind === 'tool_complete') {
    const result = activity.exactResult ?? activity.result ?? activity.summary ?? '';
    text = `${toolLabel(activity.tool || activity.name)} · ${toolOutcomeLabel(toolOutcome(result, activity.success))}\n\n${readableToolResult(result)}`;
  } else if (kind === 'status') {
    text = activityStatusLabel(activity.status) || '';
  } else if (kind === 'subagent_start' || kind === 'subagent_result') {
    text = `${activity.label || activity.task || 'Subagent'} · ${subagentStatus(activity)}`;
  } else if (kind === 'subagent_progress' && depth < 3) {
    row.nestedProgress = subagentProgressRow(activity,
      previous.nestedProgress?.workId === activity.subagentId ? previous.nestedProgress : {}, depth + 1);
    text = `${row.nestedProgress.label}\n\n${row.nestedProgress.progressSummary || 'Working'}`;
  }
  if (text) {
    row.progressSummary = text.slice(-4000);
    if (kind !== 'thinking' && kind !== 'response_chunk' && kind !== 'text') {
      row.progressKind = kind;
      row.progressText = '';
    }
  }
  return row;
}

// The history endpoint retains the last sequence of a coalesced delta. Resume
// after that sequence, seeding the current segment instead of replaying it.
export function turnContinuation(records, turnId) {
  const state = { turnId, cursor: -1, currentResponse: '', currentThinking: '', currentThinkingSegment: '', thinkingPaused: false };
  for (const record of records || []) {
    if (record?.type !== 'event' || record.turn_id !== turnId) continue;
    if (Number.isInteger(record.seq)) state.cursor = Math.max(state.cursor, record.seq);
    const event = record.data || {};
    const kind = record.kind || event.type;
    if (kind === 'thinking') {
      const piece = event.content || event.message || '';
      if (!piece) continue;
      if (!state.currentThinkingSegment) state.currentResponse = '';
      if (state.thinkingPaused && state.currentThinking) state.currentThinking += '\n\n';
      state.thinkingPaused = false;
      state.currentThinking += piece;
      state.currentThinkingSegment += piece;
    } else if (['text', 'response_chunk', 'tool_start', 'subagent_start', 'subagent_result'].includes(kind)) {
      state.thinkingPaused = Boolean(state.currentThinking.trim());
      state.currentThinkingSegment = '';
      if (kind === 'text' || kind === 'response_chunk') state.currentResponse += event.text || event.chunk || '';
      else state.currentResponse = '';
    }
  }
  return state;
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
  let thinkingRow = null;
  let responseRow = null;

  for (const raw of records || []) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (rec.type === 'turn') continue;
    if (rec.type === 'event' || rec.kind) {
      const data = asRecord(rec.data) || rec;
      const kind = rec.kind || data.type;
      const turnId = rec.turn_id || data.turn_id || null;
      if (['text', 'response_chunk', 'tool_start', 'subagent_start', 'subagent_result'].includes(kind)) thinkingRow = null;
      if (['tool_start', 'subagent_start', 'subagent_result'].includes(kind)
          || (kind === 'thinking' && (data.content || data.message))) responseRow = null;
      if (kind === 'thinking') {
        if (!String(data.content || data.message || '')) continue;
        const previous = rows.at(-1);
        if (previous === thinkingRow && previous?.kind === 'thinking' && previous.turnId === turnId) {
          previous.text += String(data.content || data.message || '');
          continue;
        }
        rows.push({
          kind: 'thinking',
          text: String(data.content || data.message || ''),
          turnId,
          collapsed: true,
        });
        thinkingRow = rows.at(-1);
        continue;
      }
      if (kind === 'tool_start') {
        if (data.toolCallId && matchingTool(rows.filter(row => row.kind === 'tool'), String(data.tool || data.name || 'tool'), data.toolCallId, turnId)) continue;
        const row = {
          kind: 'tool',
          name: String(data.tool || data.name || 'tool'),
          args: data.args ?? null,
          result: '',
          status: 'running',
          success: null,
          turnId,
          toolCallId: data.toolCallId || null,
        };
        rows.push(row);
        continue;
      }
      if (kind === 'tool_result' || kind === 'tool_complete') {
        const name = String(data.tool || data.name || 'tool');
        const target = matchingTool(rows.filter((row) => row.kind === 'tool'), name, data.toolCallId, turnId);
        const result = data.exactResult ?? data.result ?? data.summary ?? data.output ?? '';
        const success = data.success;
        const status = toolOutcome(result, success);
        if (target) {
          target.result = result;
          target.status = status;
          target.success = success;
        } else {
          rows.push({
            kind: 'tool',
            name,
            args: null,
            result,
            status,
            success,
            turnId,
            toolCallId: data.toolCallId || null,
          });
        }
        continue;
      }
      if (kind === 'response_chunk') {
        // The server removes only an exact canonical final segment. Remaining
        // deltas are interim commentary or an unfinished response, even when
        // a bounded page no longer includes the opening turn envelope.
        const text = String(data.chunk || '');
        const previous = rows.at(-1);
        if (previous === responseRow && previous?.kind === 'assistant' && previous.turnId === turnId) previous.text += text;
        else if (text) {
          rows.push({ kind: 'assistant', text, turnId });
          responseRow = rows.at(-1);
        }
        continue;
      }
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
      if (kind === 'subagent_progress') {
        const existing = data.subagentId && rows.find(row => row.kind === 'work' && row.workId === data.subagentId);
        const row = subagentProgressRow(data, existing || {}, 0, { turnId, sequence: rec.seq, startSequence: rec.display_start_seq });
        row.turnId = turnId;
        if (existing) Object.assign(existing, row);
        else rows.push(row);
        continue;
      }
      if (kind === 'subagent_start' || kind === 'subagent_result') {
        const existing = data.subagentId && rows.find((row) => row.kind === 'work' && row.workId === data.subagentId);
        const row = {
          kind: 'work',
          workId: data.subagentId || null,
          label: String(existing?.label || data.label || data.task || 'Subagent'),
          task: String(data.task || ''),
          result: String(data.result || ''),
          ...(kind === 'subagent_result' ? { progressSummary: undefined } : {}),
          status: subagentStatus({ ...data, type: kind }),
          turnId,
        };
        if (existing) Object.assign(existing, row);
        else rows.push(row);
        continue;
      }
      continue;
    }
    thinkingRow = null;
    responseRow = null;
    if (rec.role === 'user' && rec.content) {
      rows.push({ kind: 'user', text: String(rec.content) });
    } else if (rec.role === 'assistant' && typeof rec.content === 'string' && rec.content.trim()) {
      // Skip whitespace-only / non-display assistant rows (API may still carry metadata turns).
      if (rec.display_assistant === false) continue;
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
  const toolCards = [];
  const workCards = new Map();
  // Keep each nested renderer across a parent history refresh so child
  // disclosure choices and already observed events survive bounded rereads.
  const workActivityViews = new Map();
  const thinkingCounts = new Map();

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
    liveThinking = null;
    liveAssistant = null;
    toolCards.length = 0;
    workCards.clear();
    workActivityViews.clear();
    thinkingCounts.clear();
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

  function appendThinking(text, { live = true, collapsed = !showThinking, turnId = null } = {}) {
    if (!container) return null;
    clearEmpty();
    liveAssistant = null;
    const details = document.createElement('details');
    details.className = 'h23-chat-thinking';
    if (turnId) details.dataset.turnId = turnId;
    const ordinal = thinkingCounts.get(turnId) || 0;
    thinkingCounts.set(turnId, ordinal + 1);
    details.dataset.disclosureKey = `thinking:${turnId || ''}:${ordinal}`;
    details.open = !collapsed;
    if (live) details.dataset.live = 'true';
    const summary = document.createElement('summary');
    summary.className = 'h23-chat-thinking-summary';
    summary.textContent = live ? 'Thinking' : 'Thought';
    const body = document.createElement('div');
    body.className = 'h23-chat-thinking-body';
    body.dataset.sourceText = text || '';
    body.innerHTML = render(text || '');
    details.append(summary, body);
    container.appendChild(details);
    if (live) liveThinking = details;
    if (showThinking) maybeScroll();
    return details;
  }

  function updateThinking(text, options = {}) {
    if (!liveThinking) return appendThinking(text, { ...options, live: true, collapsed: !showThinking });
    const body = liveThinking.querySelector('.h23-chat-thinking-body');
    if (body) { body.dataset.sourceText = text || ''; body.innerHTML = render(text || ''); }
    maybeScroll();
    return liveThinking;
  }

  function collapseThinking() {
    if (!liveThinking) return;
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

  function appendTool(name, args, status = 'running', toolCallId = null, turnId = null) {
    if (!container) return null;
    if (toolCallId) {
      const existing = matchingTool(toolCards, name, toolCallId, turnId);
      if (existing) return existing.card;
    }
    clearEmpty();
    collapseThinking();
    liveAssistant = null;
    const card = document.createElement('div');
    card.className = 'h23-chat-tool';
    card.dataset.toolName = name || 'tool';
    card.dataset.status = status;
    if (toolCallId) card.dataset.toolCallId = toolCallId;
    if (turnId) card.dataset.turnId = turnId;
    card.dataset.disclosureKey = `tool:${turnId || ''}:${toolCallId || toolCards.length}`;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'h23-chat-tool-header';
    header.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'h23-chat-tool-name';
    label.textContent = toolLabel(name, args);
    const badge = document.createElement('span');
    badge.className = 'h23-chat-tool-status';
    badge.textContent = toolOutcomeLabel(status);
    header.append(label, badge);
    const body = document.createElement('div');
    body.className = 'h23-chat-tool-body';
    body.hidden = true;
    const summary = document.createElement('div');
    summary.className = 'h23-chat-tool-summary';
    const technical = document.createElement('details');
    technical.className = 'h23-chat-technical';
    const technicalLabel = document.createElement('summary');
    technicalLabel.textContent = 'Technical details';
    technical.appendChild(technicalLabel);
    body.append(summary, technical);
    if (args != null && args !== '') {
      const argsBlock = machineBlock('Arguments', args, { startCollapsed: false });
      argsBlock.hidden = false;
      argsBlock.classList.add('h23-chat-tool-args');
      technical.appendChild(argsBlock);
    }
    const resultBlock = document.createElement('div');
    resultBlock.className = 'h23-chat-tool-result';
    technical.appendChild(resultBlock);
    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.setAttribute('aria-expanded', String(!body.hidden));
      card.classList.toggle('open', !body.hidden);
    });
    card.append(header, body);
    container.appendChild(card);
    toolCards.push({ name, toolCallId, turnId, status, card });
    maybeScroll();
    return card;
  }

  function updateTool(name, result, success, toolCallId = null, turnId = null) {
    let entry = matchingTool(toolCards, name, toolCallId, turnId);
    if (!entry) {
      appendTool(name, null, 'running', toolCallId, turnId);
      entry = toolCards.at(-1);
    }
    if (!entry) return null;
    return updateToolCard(entry, result, success);
  }

  function updateToolCard(entry, result, success) {
    const card = entry.card;
    const status = toolOutcome(result, success);
    entry.status = status;
    card.dataset.status = status;
    const badge = card.querySelector('.h23-chat-tool-status');
    if (badge) {
      badge.textContent = toolOutcomeLabel(status);
      badge.classList.toggle('done', status === 'complete');
      badge.classList.toggle('error', status === 'error');
    }
    if (result != null && result !== '') {
      const summary = card.querySelector('.h23-chat-tool-summary');
      if (summary) summary.innerHTML = render(readableToolResult(result));
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
    div.dataset.sourceText = text || '';
    const body = document.createElement('div');
    body.className = 'h23-chat-msg-text';
    body.innerHTML = render(text || '');
    const copy = copyButton();
    bindCopy(copy, () => div.dataset.sourceText || '');
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
    liveAssistant.dataset.sourceText = text || '';
    const body = liveAssistant.querySelector('.h23-chat-msg-text');
    if (body) {
      body.innerHTML = render(text || '');
      body.querySelectorAll('[data-copy="code"]').forEach((btn) => {
        const code = btn.closest('.h23-chat-code')?.querySelector('code');
        bindCopy(btn, () => code?.textContent || '');
      });
    }
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
    // A lifecycle boundary can update a card already anchored above the current
    // response. The next parent segment must still get its own message row.
    if (!row.preserveStream) {
      collapseThinking();
      liveAssistant = null;
    }
    if (row.workId && workCards.has(row.workId)) {
      const retained = workCards.get(row.workId);
      // Separate history and Work streams can arrive in either order.
      if (retained.row.updatedAt && row.updatedAt && row.updatedAt < retained.row.updatedAt) return retained.card;
      if (['completed', 'finished', 'failed', 'cancelled', 'interrupted'].includes(retained.row.status)
          && ['running', 'queued', 'blocked'].includes(row.status)) return retained.card;
      retained.row = { ...retained.row, ...row };
      updateWorkCard(retained);
      return retained.card;
    }
    const card = document.createElement('div');
    card.className = 'h23-chat-work';
    if (row.workId) card.dataset.workId = row.workId;
    if (row.turnId) card.dataset.turnId = row.turnId;
    card.dataset.disclosureKey = `work:${row.workId || workCards.size}`;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'h23-chat-work-header';
    const label = document.createElement('span');
    const badge = document.createElement('span');
    badge.className = 'h23-chat-work-status';
    header.append(label, badge);
    const body = document.createElement('div');
    body.className = 'h23-chat-work-body';
    body.hidden = true;
    header.setAttribute('aria-expanded', 'false');
    header.addEventListener('click', () => {
      body.hidden = !body.hidden;
      header.setAttribute('aria-expanded', String(!body.hidden));
      if (!body.hidden) updateWorkCard(entry);
    });
    card.append(header, body);
    const entry = { card, label, badge, body, row, header };
    if (row.workId) workCards.set(row.workId, entry);
    updateWorkCard(entry);
    const siblings = Array.from(container.children);
    const anchor = row.turnId && siblings.findLastIndex(element => element.dataset.turnId === row.turnId);
    if (Number.isInteger(anchor) && anchor >= 0 && anchor < siblings.length - 1) container.insertBefore(card, siblings[anchor + 1]);
    else container.appendChild(card);
    maybeScroll();
    return card;
  }

  function appendSubagentProgress(event, identity = {}) {
    const previous = workCards.get(event.subagentId)?.row || {};
    return appendWorkReceipt(subagentProgressRow(event, previous, 0, identity));
  }

  function updateWorkCard(entry) {
    const { card, label, badge, body, row, header } = entry;
    const status = row.status || 'running';
    card.dataset.status = status;
    card.dataset.resultText = stringifyPayload(row.result).text;
    label.textContent = row.label || 'Task';
    badge.textContent = status.replaceAll('_', ' ');
    const technicalOpen = entry.technical?.open || false;
    const expanded = header.getAttribute('aria-expanded') === 'true';
    body.replaceChildren();
    if (row.task) {
      const task = document.createElement('p');
      task.className = 'h23-chat-work-task';
      task.textContent = row.task;
      body.appendChild(task);
    }
    if (row.progressSummary && (!row.activityRecords?.length || !expanded)) {
      const progress = document.createElement('div');
      progress.className = 'h23-chat-work-progress';
      progress.innerHTML = render(row.progressSummary);
      body.appendChild(progress);
    }
    if (row.activityRecords?.length || workActivityViews.has(row.workId)) {
      let activity = workActivityViews.get(row.workId);
      if (!activity) {
        const host = document.createElement('div');
        host.className = 'h23-chat-child-activity';
        activity = { host, records: [], view: createTranscript(host, { renderMarkdown: render, showThinking: false }) };
        workActivityViews.set(row.workId, activity);
      }
      activity.records = mergeActivityRecords(activity.records, row.activityRecords);
      row.activityRecords = activity.records;
      body.appendChild(activity.host);
      if (expanded) activity.view.renderHistory(activity.records);
    }
    const lastActivity = expanded && row.activityRecords?.length ? projectHistoryToRows(row.activityRecords).at(-1) : null;
    if (row.result && !(lastActivity?.kind === 'assistant' && lastActivity.text === row.result)) {
      const result = document.createElement('div');
      result.className = 'h23-chat-work-result';
      result.innerHTML = render(readableToolResult(row.result));
      body.appendChild(result);
    }
    const technicalResult = row.technicalResult || row.result;
    if (technicalResult) {
      const technical = document.createElement('details');
      technical.className = 'h23-chat-technical';
      technical.open = technicalOpen;
      const title = document.createElement('summary');
      title.textContent = 'Technical details';
      technical.append(title, machineBlock('Result', technicalResult));
      body.appendChild(technical);
      entry.technical = technical;
    }
    const actions = document.createElement('div');
    actions.className = 'h23-chat-work-actions';
    for (const [title, action] of [['View subagent', row.onDetails], ['Stop', row.onCancel]]) {
      if (typeof action !== 'function') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = title;
      button.addEventListener('click', action);
      actions.appendChild(button);
    }
    body.appendChild(actions);
  }

  function renderHistory(records) {
    if (!container) return;
    const disclosures = new Map(Array.from(container.children).filter(el => el.dataset.disclosureKey)
      .map(el => [el.dataset.disclosureKey, {
        expanded: el.tagName === 'DETAILS' ? el.open : el.querySelector('button')?.getAttribute('aria-expanded') === 'true',
        technical: (workCards.get(el.dataset.workId)?.technical || el.querySelector('.h23-chat-technical'))?.open || false,
      }]));
    container.innerHTML = '';
    liveThinking = null;
    liveAssistant = null;
    toolCards.length = 0;
    workCards.clear();
    thinkingCounts.clear();
    const rows = projectHistoryToRows(records);
    if (rows.length === 0) {
      emptyState();
      return;
    }
    for (const row of rows) {
      const before = container.children.length;
      if (row.kind === 'user') appendUser(row.text);
      else if (row.kind === 'thinking') appendThinking(row.text, { live: false, collapsed: !showThinking, turnId: row.turnId });
      else if (row.kind === 'tool') {
        appendTool(row.name, row.args, row.status, row.toolCallId, row.turnId);
        if (row.result) updateToolCard(toolCards.at(-1), row.result, row.success);
      } else if (row.kind === 'assistant') appendAssistant(row.text, row.turnId);
      else if (row.kind === 'media') appendMedia(row.mediaType, row.path, row.caption);
      else if (row.kind === 'work') appendWorkReceipt(row);
      if (container.children.length > before && ['thinking', 'tool', 'work'].includes(row.kind)) {
        const element = container.children[container.children.length - 1];
        const key = element.dataset.disclosureKey;
        if (disclosures.has(key)) {
          const state = disclosures.get(key);
          if (element.tagName === 'DETAILS') element.open = state.expanded;
          else if (state.expanded) element.querySelector('button')?.click();
          const technical = workCards.get(element.dataset.workId)?.technical || element.querySelector('.h23-chat-technical');
          if (technical) technical.open = state.technical;
        }
      }
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

  function resumeTurn(records, turnId) {
    const state = turnContinuation(records, turnId);
    const elements = Array.from(container?.children || []).filter(element => element.dataset.turnId === turnId);
    if (state.currentThinkingSegment) {
      liveThinking = elements.findLast(element => element.classList.contains('h23-chat-thinking')) || null;
      if (liveThinking) {
        liveThinking.dataset.live = 'true';
        liveThinking.querySelector('summary').textContent = 'Thinking';
      }
    } else if (state.currentResponse) {
      liveAssistant = elements.findLast(element => element.classList.contains('assistant')) || null;
      if (!liveAssistant) appendAssistant(state.currentResponse, turnId);
    }
    return state;
  }

  return {
    emptyState,
    clear() { if (container) container.innerHTML = ''; liveThinking = null; liveAssistant = null; toolCards.length = 0; workCards.clear(); workActivityViews.clear(); thinkingCounts.clear(); },
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
    appendSubagentProgress,
    renderHistory,
    resumeTurn,
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
