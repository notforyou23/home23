/**
 * Home23 Dashboard Chat
 *
 * Native chat tile connecting to the agent loop via the bridge endpoint.
 * Renders in tile, overlay, or standalone mode.
 */

const CHAT_API = '/home23/api/chat';
const CHAT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
let chatAgent = null;
let chatAgents = [];
let chatModels = {};
let chatModel = null;
let chatStreaming = false;
let activeTurnId = null;
let activeChatId = null;
let activeCursor = -1;
let activeEventSource = null;
// UI render state per turn — reset when a turn starts, reused by both live streaming and reconnect.
let currentTurnCtx = null;
let chatConversationId = null;  // current conversation ID
let chatConversations = [];     // list of all conversations
let chatPersistTimer = null;
let chatPersistenceBound = false;
let chatCurrentAgentName = null;

// ── Init ──

async function initChat(mode) {
  // Load agents
  try {
    const res = await fetch('/home23/api/settings/agents');
    const data = await res.json();
    chatAgents = data.agents || [];
    chatCurrentAgentName = data.currentAgent || null;
  } catch { chatAgents = []; }

  // Load models catalog
  try {
    const res = await fetch('/home23/api/settings/models');
    const data = await res.json();
    chatModels = data.providers || {};
  } catch { chatModels = {}; }

  // Determine initial agent (URL param or this dashboard's agent)
  const urlParams = new URLSearchParams(window.location.search);
  const urlAgent = urlParams.get('agent');
  const initialAgent = (urlAgent && chatAgents.find(a => a.name === urlAgent))
    || (chatCurrentAgentName && chatAgents.find(a => a.name === chatCurrentAgentName))
    || chatAgents.find(a => a.isPrimary)
    || chatAgents[0];

  if (!initialAgent) {
    const empty = document.getElementById('chat-messages');
    if (empty) empty.innerHTML = '<div class="h23-chat-empty">No agents configured. Create one in Settings.</div>';
    return;
  }

  bindChatPersistence();
  renderAgentSelectors(initialAgent.name);
  await switchAgent(initialAgent.name, { preferRestore: true });

  // Model selector — use agent's current model (may have been changed in settings)
  chatModel = initialAgent.model;
  populateModelSelect(initialAgent.provider, initialAgent.model);

  // Input bindings
  bindInput('chat-input', 'chat-send-btn', '');
  bindInput('chat-overlay-input', 'chat-overlay-send-btn', 'overlay');

  // Expand/minimize/standalone
  const expandBtn = document.getElementById('chat-expand-btn');
  if (expandBtn) expandBtn.addEventListener('click', openOverlay);
  const minimizeBtn = document.getElementById('chat-minimize-btn');
  if (minimizeBtn) minimizeBtn.addEventListener('click', closeOverlay);
  const standaloneBtn = document.getElementById('chat-standalone-btn');
  if (standaloneBtn) standaloneBtn.addEventListener('click', () => {
    // Pass current agent + conversation cache via URL
    cacheHistory();
    window.open(`/home23/chat?agent=${chatAgent?.agentName || ''}`, '_blank');
  });
}

function bindInput(inputId, btnId, source) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(source);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }
  if (btn) btn.addEventListener('click', () => sendMessage(source));
}

function renderAgentSelectors(selectedName) {
  const options = chatAgents.map(agent =>
    `<option value="${agent.name}" ${agent.name === selectedName ? 'selected' : ''}>${agent.displayName || agent.name}${agent.isPrimary ? ' (primary)' : ''}</option>`
  ).join('');

  document.querySelectorAll('.h23-chat-agent-select').forEach(select => {
    select.innerHTML = options;
    select.value = selectedName;
    select.title = select.selectedOptions[0]?.textContent || '';
    if (!select.dataset.bound) {
      select.addEventListener('change', () => switchAgent(select.value));
      select.dataset.bound = 'true';
    }
  });
}

function populateModelSelect(provider, currentModel) {
  // Collect all models across providers
  const allModels = [];
  for (const [provName, cfg] of Object.entries(chatModels)) {
    for (const m of (cfg.defaultModels || [])) {
      allModels.push({ provider: provName, model: m });
    }
  }

  const options = allModels.map(modelEntry =>
    `<option value="${modelEntry.model}" data-provider="${modelEntry.provider}" title="${modelEntry.model}" ${modelEntry.model === currentModel ? 'selected' : ''}>${formatModelLabel(modelEntry.model)}</option>`
  ).join('');

  document.querySelectorAll('.h23-chat-model-select').forEach(select => {
    select.innerHTML = options;
    if (currentModel) {
      select.value = currentModel;
    }
    select.title = select.selectedOptions[0]?.value || currentModel || '';

    if (!select.dataset.bound) {
      select.addEventListener('change', async () => {
        chatModel = select.value;
        const selectedOpt = select.selectedOptions[0];
        const selectedProvider = selectedOpt?.dataset?.provider || '';
        syncModelSelectors(chatModel);

        if (chatAgent?.agentName) {
          try {
            await fetch(`/home23/api/settings/agents/${chatAgent.agentName}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: chatModel, provider: selectedProvider }),
            });
          } catch (err) {
            console.warn('Failed to persist model change:', err);
          }
        }
      });
      select.dataset.bound = 'true';
    }
  });

  syncModelSelectors(currentModel);
}

function syncModelSelectors(modelName) {
  if (!modelName) return;

  document.querySelectorAll('.h23-chat-model-select').forEach(select => {
    select.value = modelName;
    select.title = select.selectedOptions[0]?.value || modelName;
  });
}

function formatModelLabel(modelName) {
  return modelName.length > 28 ? `${modelName.slice(0, 25)}…` : modelName;
}

// ── Slash Commands ──

const SLASH_COMMANDS = {
  '/new': { description: 'Start a fresh conversation', handler: cmdNew },
  '/clear': { description: 'Clear chat history', handler: cmdNew },
  '/stop': { description: 'Stop the current agent run', handler: () => stopChat() },
  '/help': { description: 'Show available commands', handler: cmdHelp },
};

function handleSlashCommand(text, source) {
  const cmd = text.split(/\s/)[0].toLowerCase();
  const handler = SLASH_COMMANDS[cmd];
  if (!handler) {
    const containerId = source === 'overlay' ? 'chat-overlay-body' : 'chat-messages';
    appendError(`Unknown command: ${cmd}. Type /help for available commands.`, containerId);
    return true;
  }
  handler.handler(text, source);
  return true;
}

function cmdNew(text, source) {
  newConversation();
}

function cmdHelp(text, source) {
  const containerId = source === 'overlay' ? 'chat-overlay-body' : 'chat-messages';
  const lines = Object.entries(SLASH_COMMANDS)
    .map(([cmd, info]) => `**${cmd}** — ${info.description}`)
    .join('\n');
  appendMessage('assistant', 'Available commands:\n\n' + lines, containerId);
  scrollContainer(containerId);
}

// ── Agent Switching ──

async function switchAgent(name, options = {}) {
  const { preferRestore = false } = options;
  if (chatAgent) cacheHistory();

  try {
    const res = await fetch(`${CHAT_API}/config/${name}`);
    chatAgent = await res.json();
  } catch (err) {
    console.error('Failed to load agent config:', err);
    return;
  }

  renderAgentSelectors(name);
  const overlayTitle = document.getElementById('chat-overlay-title-label');
  if (overlayTitle) {
    overlayTitle.textContent = `Talk to ${chatAgent.displayName || chatAgent.agentName || name}`;
  }

  // Reset model to agent's default
  chatModel = null;
  const agentData = chatAgents.find(a => a.name === name);
  if (agentData) {
    chatModel = agentData.model;
    populateModelSelect(agentData.provider, agentData.model);
  }

  // Load conversation list, then start a new conversation
  await loadConversationList(name);
  if (preferRestore && restoreChatState(name)) {
    renderConversationList();
    resetSendButtons();
    return;
  }
  newConversation();

  await loadHistory(name);
}

// ── History ──

async function loadHistory(agentName, conversationId) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const convParam = conversationId ? `&conversation=${conversationId}` : '';
  try {
    const res = await fetch(`${CHAT_API}/history/${agentName}?limit=100${convParam}`);
    const data = await res.json();
    container.innerHTML = '';
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(m => appendMessage(m.role, m.content));
    } else {
      container.innerHTML = '<div class="h23-chat-empty">Start a conversation with your agent.</div>';
    }
    const overlayBody = document.getElementById('chat-overlay-body');
    if (overlayBody) overlayBody.innerHTML = container.innerHTML;
    scheduleChatPersist();
    scrollToBottom();
  } catch (err) {
    console.error('Failed to load history:', err);
    container.innerHTML = '<div class="h23-chat-empty">Start a conversation with your agent.</div>';
    const overlayBody = document.getElementById('chat-overlay-body');
    if (overlayBody) overlayBody.innerHTML = '';
    scheduleChatPersist();
  }
  await resumePendingTurns();
}

async function resumePendingTurns() {
  if (!chatAgent?.bridgePort || !chatConversationId) return;
  try {
    const bridgeBase = `http://${window.location.hostname}:${chatAgent.bridgePort}`;
    const res = await fetch(`${bridgeBase}/api/chat/pending?chatId=${encodeURIComponent(chatConversationId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const pending = data.pending || [];
    if (pending.length === 0) return;

    const turn = pending[pending.length - 1];

    const containerId = 'chat-messages';
    currentTurnCtx = {
      containerId,
      responseEl: null,
      currentResponse: '',
      thinkingEl: null,
      currentThinking: '',
    };
    activeTurnId = turn.turn_id;
    activeChatId = chatConversationId;
    activeCursor = -1;
    chatStreaming = true;

    // Button swap to Stop while resuming
    const sendBtn = document.getElementById('chat-send-btn');
    const overlaySendBtn = document.getElementById('chat-overlay-send-btn');
    if (sendBtn) { sendBtn.innerHTML = '&#9632;'; sendBtn.disabled = false; sendBtn.onclick = stopChat; sendBtn.title = 'Stop'; sendBtn.style.background = 'var(--accent-red)'; }
    if (overlaySendBtn) { overlaySendBtn.innerHTML = '&#9632;'; overlaySendBtn.disabled = false; overlaySendBtn.onclick = stopChat; overlaySendBtn.title = 'Stop'; overlaySendBtn.style.background = 'var(--accent-red)'; }

    openTurnStream({ bridgeBase, chatId: activeChatId, turnId: turn.turn_id, cursor: -1 });
  } catch (err) {
    console.warn('[chat] pending-turn resume failed', err);
  }
}

// ── Conversations ──

function newConversation() {
  chatConversationId = `dashboard-${chatAgent?.agentName || 'agent'}-${Date.now()}`;
  const container = document.getElementById('chat-messages');
  if (container) container.innerHTML = '<div class="h23-chat-empty">Start a conversation with your agent.</div>';
  const overlayBody = document.getElementById('chat-overlay-body');
  if (overlayBody) overlayBody.innerHTML = '';
  // Highlight active in list
  updateConversationListHighlight();
  scheduleChatPersist();
}

async function loadConversationList(agentName) {
  try {
    const res = await fetch(`${CHAT_API}/conversations/${agentName || chatAgent?.agentName}`);
    const data = await res.json();
    chatConversations = data.conversations || [];
  } catch { chatConversations = []; }
  renderConversationList();
}

function renderConversationList() {
  const list = document.getElementById('chat-conv-list');
  if (!list) return;

  if (chatConversations.length === 0) {
    list.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--text-muted);font-style:italic;">No previous conversations</div>';
    return;
  }

  list.innerHTML = chatConversations.map(c => {
    const date = new Date(c.lastActivity);
    const timeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
                    date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const isActive = c.id === chatConversationId;
    const sourceIcon = c.source === 'telegram' ? '&#9992; ' : c.source === 'dashboard' ? '&#128172; ' : '';
    const sourceLabel = c.source && c.source !== 'dashboard' ? `<span style="color:var(--text-muted);font-size:10px;text-transform:uppercase;">${c.source}</span> &middot; ` : '';
    return `
      <div class="h23-chat-conv-item ${isActive ? 'active' : ''}" onclick="openConversation('${c.id}')" title="${c.preview}">
        <div class="h23-chat-conv-preview">${sourceIcon}${escapeHtml(c.preview)}</div>
        <div class="h23-chat-conv-meta">${sourceLabel}${timeStr} &middot; ${c.messageCount} msgs</div>
      </div>
    `;
  }).join('');
}

function updateConversationListHighlight() {
  document.querySelectorAll('.h23-chat-conv-item').forEach(el => el.classList.remove('active'));
  // New conversation won't match any existing item — that's correct
}

async function openConversation(convId) {
  chatConversationId = convId;
  await loadHistory(chatAgent?.agentName, convId);
  renderConversationList();
  scheduleChatPersist();
}

function toggleConversationList() {
  const panel = document.getElementById('chat-conv-panel');
  if (panel) {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && chatAgent) {
      loadConversationList(chatAgent.agentName);
    }
  }
}

// ── Send Message ──

async function sendMessage(source) {
  const inputId = source === 'overlay' ? 'chat-overlay-input' : 'chat-input';
  const input = document.getElementById(inputId);
  if (!input || !chatAgent) return;

  const text = input.value.trim();
  if (!text || chatStreaming) return;

  input.value = '';
  input.style.height = 'auto';
  scheduleChatPersist();

  // Handle slash commands
  if (text.startsWith('/')) {
    handleSlashCommand(text, source);
    return;
  }

  const empty = document.querySelector('.h23-chat-empty');
  if (empty) empty.remove();

  // Determine which messages container to use
  const containerId = source === 'overlay' ? 'chat-overlay-body' : 'chat-messages';
  appendMessage('user', text, containerId);
  scrollContainer(containerId);

  chatStreaming = true;
  scheduleChatPersist();
  const sendBtn = document.getElementById('chat-send-btn');
  const overlaySendBtn = document.getElementById('chat-overlay-send-btn');
  // Swap send → stop button
  if (sendBtn) { sendBtn.innerHTML = '&#9632;'; sendBtn.disabled = false; sendBtn.onclick = stopChat; sendBtn.title = 'Stop'; sendBtn.style.background = 'var(--accent-red)'; }
  if (overlaySendBtn) { overlaySendBtn.innerHTML = '&#9632;'; overlaySendBtn.disabled = false; overlaySendBtn.onclick = stopChat; overlaySendBtn.title = 'Stop'; overlaySendBtn.style.background = 'var(--accent-red)'; }

  // New turn protocol flow
  currentTurnCtx = {
    containerId,
    responseEl: null,
    currentResponse: '',
    thinkingEl: null,
    currentThinking: '',
  };
  activeChatId = chatConversationId;
  activeCursor = -1;

  const bridgeBase = `http://${window.location.hostname}:${chatAgent.bridgePort}`;

  let turnId;
  try {
    const res = await fetch(`${bridgeBase}/api/chat/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: activeChatId, message: text }),
    });

    if (res.status === 409) {
      const data = await res.json();
      turnId = data.turn_id;
      console.warn('[chat] resuming in-flight turn', turnId);
    } else if (!res.ok) {
      let errBody = '';
      try { errBody = (await res.json()).error || ''; } catch {}
      throw new Error(`turn start failed (${res.status}) ${errBody}`);
    } else {
      const data = await res.json();
      turnId = data.turn_id;
    }
  } catch (err) {
    appendError('Connection failed: ' + err.message, containerId);
    chatStreaming = false;
    resetSendButtons();
    scheduleChatPersist();
    return;
  }

  activeTurnId = turnId;
  openTurnStream({ bridgeBase, chatId: activeChatId, turnId, cursor: -1 });
}

function dispatchLegacyEvent(event, ctx) {
  const { containerId } = ctx;
  if (event.type === 'text' || event.type === 'response_chunk') {
    ctx.thinkingEl = null;
    ctx.currentThinking = '';
    ctx.currentResponse += event.text || event.chunk || '';
    if (!ctx.responseEl) {
      ctx.responseEl = appendMessage('assistant', ctx.currentResponse, containerId);
    } else {
      ctx.responseEl.innerHTML = renderMarkdown(ctx.currentResponse);
      scheduleChatPersist();
    }
    scrollContainer(containerId);
  } else if (event.type === 'thinking') {
    ctx.responseEl = null;
    ctx.currentResponse = '';
    ctx.currentThinking += event.content || event.message || '';
    if (!ctx.thinkingEl) {
      ctx.thinkingEl = appendThinking(ctx.currentThinking, containerId);
    } else {
      ctx.thinkingEl.textContent = ctx.currentThinking;
      scheduleChatPersist();
    }
    scrollContainer(containerId);
  } else if (event.type === 'tool_start') {
    ctx.thinkingEl = null; ctx.currentThinking = '';
    ctx.responseEl = null; ctx.currentResponse = '';
    appendToolCard(event.tool || event.name, event.args, 'running', containerId);
    scrollContainer(containerId);
  } else if (event.type === 'tool_complete' || event.type === 'tool_result') {
    updateToolCard(event.tool || event.name, event.result || event.summary || event.output, true);
    scrollContainer(containerId);
  } else if (event.type === 'media') {
    appendMedia(event.mediaType, event.path, event.caption, containerId);
    scrollContainer(containerId);
  } else if (event.type === 'subagent_result') {
    appendMessage('assistant', `**[Sub-agent]** ${event.task}\n\n${event.result}`, containerId);
    scrollContainer(containerId);
  }
}

function openTurnStream({ bridgeBase, chatId, turnId, cursor }) {
  // Close any existing stream
  if (activeEventSource) { try { activeEventSource.close(); } catch {} activeEventSource = null; }

  const url = `${bridgeBase}/api/chat/stream?chatId=${encodeURIComponent(chatId)}&turn_id=${encodeURIComponent(turnId)}&cursor=${cursor}`;
  const es = new EventSource(url);
  activeEventSource = es;

  es.onmessage = (msg) => {
    if (msg.data === '[DONE]') {
      es.close();
      if (activeEventSource === es) activeEventSource = null;
      finalizeTurn(null);
      return;
    }
    let record;
    try { record = JSON.parse(msg.data); } catch { return; }

    if (record.type === 'event') {
      activeCursor = record.seq;
      if (currentTurnCtx) dispatchLegacyEvent(record.data, currentTurnCtx);
    } else if (record.type === 'turn' && record.status !== 'pending') {
      es.close();
      if (activeEventSource === es) activeEventSource = null;
      finalizeTurn(record);
    }
  };

  es.onerror = () => {
    // Don't auto-reconnect here — visibilitychange handles resume; avoid duplicate streams.
    try { es.close(); } catch {}
    if (activeEventSource === es) activeEventSource = null;
  };
}

function finalizeTurn(finalEnvelope) {
  if (finalEnvelope && finalEnvelope.status === 'error') {
    appendError(finalEnvelope.error || 'Error', (currentTurnCtx && currentTurnCtx.containerId) || 'chat-messages');
  } else if (finalEnvelope && finalEnvelope.status === 'stopped') {
    // quiet — the stop button already reflected the user action
  } else if (finalEnvelope && finalEnvelope.status === 'orphaned') {
    appendError('Previous turn was interrupted — try resending.', (currentTurnCtx && currentTurnCtx.containerId) || 'chat-messages');
  }

  chatStreaming = false;
  activeTurnId = null;
  activeChatId = null;
  activeCursor = -1;
  currentTurnCtx = null;
  resetSendButtons();
  cacheHistory();
  scheduleChatPersist();
}

function resetSendButtons() {
  const sendBtn = document.getElementById('chat-send-btn');
  const overlaySendBtn = document.getElementById('chat-overlay-send-btn');
  if (sendBtn) { sendBtn.innerHTML = '&#9654;'; sendBtn.disabled = false; sendBtn.onclick = () => sendMessage(''); sendBtn.title = 'Send'; sendBtn.style.background = ''; }
  if (overlaySendBtn) { overlaySendBtn.innerHTML = '&#9654;'; overlaySendBtn.disabled = false; overlaySendBtn.onclick = () => sendMessage('overlay'); overlaySendBtn.title = 'Send'; overlaySendBtn.style.background = ''; }
}

async function stopChat() {
  if (activeEventSource) { try { activeEventSource.close(); } catch {} activeEventSource = null; }
  if (chatAgent?.bridgePort && activeChatId) {
    try {
      await fetch(`http://${window.location.hostname}:${chatAgent.bridgePort}/api/chat/stop-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId }),
      });
    } catch { /* bridge might be unreachable */ }
  }
  // finalizeTurn will be called when the stream closes with a 'stopped' envelope,
  // but if the stream was already closed, clean up here too.
  if (!activeTurnId) {
    chatStreaming = false;
    resetSendButtons();
    scheduleChatPersist();
  }
}

// ── DOM Helpers ──

function appendMedia(mediaType, filePath, caption, containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'h23-chat-msg assistant';
  if (mediaType === 'image') {
    // Serve image via the dashboard — the path is on the server filesystem
    // Use a data endpoint or serve from tempDir
    div.innerHTML = `
      <div style="margin:4px 0;">
        <img src="/home23/api/media?path=${encodeURIComponent(filePath)}"
             style="max-width:100%;border-radius:8px;border:1px solid var(--glass-border);"
             alt="${escapeHtml(caption || 'Generated image')}"
             onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
        <span style="display:none;color:var(--text-muted);font-size:12px;">Image: ${escapeHtml(filePath)}</span>
      </div>
      ${caption ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${escapeHtml(caption)}</div>` : ''}
    `;
  } else {
    div.textContent = `[${mediaType}: ${filePath}]${caption ? ' — ' + caption : ''}`;
  }
  container.appendChild(div);
  scheduleChatPersist();
}

function renderMarkdown(text) {
  // Simple markdown: code blocks, inline code, bold, italic, lists, paragraphs
  let html = escapeHtml(text);

  // Code blocks: ```...```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *...*
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Unordered lists: lines starting with - or *
  html = html.replace(/^([- *]) (.+)$/gm, '<li>$2</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Paragraphs: double newlines
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function appendMessage(role, content, containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (!container) return null;
  const div = document.createElement('div');
  div.className = `h23-chat-msg ${role}`;
  if (role === 'assistant') {
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  container.appendChild(div);
  scheduleChatPersist();
  return div;
}

function appendThinking(text, containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (!container) return null;
  const div = document.createElement('div');
  div.className = 'h23-chat-thinking';
  div.textContent = text;
  container.appendChild(div);
  scheduleChatPersist();
  return div;
}

function appendToolCard(name, args, status, containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'h23-chat-tool';
  div.dataset.toolName = name;

  let argsPreview = '';
  if (args) {
    try {
      argsPreview = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
      if (argsPreview.length > 200) argsPreview = argsPreview.slice(0, 200) + '...';
    } catch { argsPreview = String(args); }
  }

  div.innerHTML = `
    <div class="h23-chat-tool-header">
      <span class="h23-chat-tool-name">${escapeHtml(name)}</span>
      <span class="h23-chat-tool-status">${status === 'running' ? 'running...' : 'done'}</span>
    </div>
    ${argsPreview ? `<div class="h23-chat-tool-args">${escapeHtml(argsPreview)}</div>` : ''}
    <div class="h23-chat-tool-result"></div>
  `;
  container.appendChild(div);
  scheduleChatPersist();
}

function updateToolCard(name, result, success) {
  const cards = document.querySelectorAll(`.h23-chat-tool[data-tool-name="${name}"]`);
  const card = cards[cards.length - 1];
  if (!card) return;

  const statusEl = card.querySelector('.h23-chat-tool-status');
  if (statusEl) {
    statusEl.textContent = success ? 'done' : 'error';
    statusEl.className = `h23-chat-tool-status ${success ? 'done' : 'error'}`;
  }

  if (result) {
    const resultEl = card.querySelector('.h23-chat-tool-result');
    if (resultEl) {
      let text = typeof result === 'string' ? result : JSON.stringify(result);
      if (text.length > 300) text = text.slice(0, 300) + '...';
      resultEl.textContent = text;
    }
  }
  scheduleChatPersist();
}

function appendError(text, containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'h23-chat-error';
  div.textContent = text;
  container.appendChild(div);
  scheduleChatPersist();
}

function scrollToBottom() {
  scrollContainer('chat-messages');
}

function scrollContainer(containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function cacheHistory() {
  if (!chatAgent) return;
  const container = getActiveChatContainer();
  if (!container) return;
  const messages = extractMessageHistory(container);

  try {
    localStorage.setItem(`home23:chat:${chatAgent.agentName}`, JSON.stringify(messages.slice(-50)));
    localStorage.setItem(getChatSessionKey(chatAgent.agentName), JSON.stringify({
      agentName: chatAgent.agentName,
      conversationId: chatConversationId,
      html: container.innerHTML,
      streaming: chatStreaming,
      savedAt: Date.now(),
      tileInput: document.getElementById('chat-input')?.value || '',
      overlayInput: document.getElementById('chat-overlay-input')?.value || '',
    }));
  } catch {
    // LocalStorage may be unavailable or full; keep chat functional.
  }
}

// ── Overlay ──

function openOverlay() {
  const overlay = document.getElementById('chat-overlay');
  if (!overlay) return;

  const tileMessages = document.getElementById('chat-messages');
  const overlayBody = document.getElementById('chat-overlay-body');

  if (tileMessages && overlayBody) {
    overlayBody.innerHTML = tileMessages.innerHTML;
  }

  overlay.classList.add('open');
  scrollContainer('chat-overlay-body');
  scheduleChatPersist();
}

function closeOverlay() {
  const overlay = document.getElementById('chat-overlay');
  if (overlay) overlay.classList.remove('open');

  const overlayBody = document.getElementById('chat-overlay-body');
  const tileMessages = document.getElementById('chat-messages');
  if (overlayBody && tileMessages) {
    tileMessages.innerHTML = overlayBody.innerHTML;
  }
  scrollToBottom();
  scheduleChatPersist();
}

function bindChatPersistence() {
  if (chatPersistenceBound) return;

  const persist = () => cacheHistory();
  window.addEventListener('beforeunload', persist);
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });

  chatPersistenceBound = true;
}

function scheduleChatPersist() {
  if (chatPersistTimer) return;
  chatPersistTimer = setTimeout(() => {
    chatPersistTimer = null;
    cacheHistory();
  }, 150);
}

function getChatSessionKey(agentName) {
  return `home23:chat:session:${agentName}`;
}

function getActiveChatContainer() {
  const overlay = document.getElementById('chat-overlay');
  const isOverlayOpen = overlay && overlay.classList.contains('open');
  const containerId = isOverlayOpen ? 'chat-overlay-body' : 'chat-messages';
  return document.getElementById(containerId);
}

function extractMessageHistory(container) {
  const messages = [];
  container.querySelectorAll('.h23-chat-msg').forEach(el => {
    messages.push({
      role: el.classList.contains('user') ? 'user' : 'assistant',
      content: el.textContent,
    });
  });
  return messages;
}

function restoreChatState(agentName) {
  try {
    const raw = localStorage.getItem(getChatSessionKey(agentName));
    if (!raw) return false;

    const saved = JSON.parse(raw);
    if (!saved || saved.agentName !== agentName) return false;
    if (!saved.savedAt || (Date.now() - saved.savedAt) > CHAT_SESSION_TTL_MS) {
      localStorage.removeItem(getChatSessionKey(agentName));
      return false;
    }

    chatConversationId = saved.conversationId || `dashboard-${agentName}-${Date.now()}`;

    const tileMessages = document.getElementById('chat-messages');
    const overlayBody = document.getElementById('chat-overlay-body');
    const html = saved.html || '<div class="h23-chat-empty">Start a conversation with your agent.</div>';

    if (tileMessages) tileMessages.innerHTML = html;
    if (overlayBody) overlayBody.innerHTML = html;

    const tileInput = document.getElementById('chat-input');
    const overlayInput = document.getElementById('chat-overlay-input');
    if (tileInput) tileInput.value = saved.tileInput || '';
    if (overlayInput) overlayInput.value = saved.overlayInput || '';

    if (saved.streaming) {
      if (tileMessages) appendError('Response interrupted by refresh.', 'chat-messages');
      if (overlayBody) appendError('Response interrupted by refresh.', 'chat-overlay-body');
    }

    chatStreaming = false;
    scrollToBottom();
    scrollContainer('chat-overlay-body');
    return true;
  } catch {
    return false;
  }
}

// ── Reconnect on tab visibility ──

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!activeTurnId || !activeChatId || activeEventSource) return;
  if (!chatAgent?.bridgePort) return;

  const bridgeBase = `http://${window.location.hostname}:${chatAgent.bridgePort}`;
  console.log('[chat] tab visible — resuming stream from cursor', activeCursor);
  openTurnStream({ bridgeBase, chatId: activeChatId, turnId: activeTurnId, cursor: activeCursor });
});
