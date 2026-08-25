/**
 * Home23 Chat — single transcript surface for the dashboard Chat tab and
 * /home23/chat. Thinking, tools, work receipts, stop/resume, and cross-tab
 * ownership live here. Home only shows a preview that opens this surface.
 */

import { chatState } from './home23-chat-state.mjs';
import { reconcileCanonicalAssistantElements } from './home23-chat-reconstruction.mjs';
import { decodeModelPair, encodeModelPair } from './home23-model-pair.mjs';
import { renderMarkdown } from './home23-chat-markdown.mjs';
import { collectThinkingText, createTranscript } from './home23-chat-transcript.mjs';
import {
  CHAT_REASONING_EFFORTS,
  encodeChatEffortKey,
  effectiveChatReasoningEffort,
  effortLabel,
  parseChatReasoningEffort,
} from './home23-chat-effort.mjs';

if (typeof window !== 'undefined') window.chatState = chatState;

const CHAT_API = '/home23/api/chat';
const CHAT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TAB_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let chatAgent = null;
let chatAgents = [];
let chatModels = {};
let chatModel = null;
let chatProvider = null;
let chatStreaming = false;
let chatDisconnected = false;
let activeTurnId = null;
let activeChatId = null;
let activeCursor = -1;
let activeEventSource = null;
let workEventSource = null;
let currentTurnCtx = null;
let chatConversationId = null;
let chatConversations = [];
let chatInitialized = false;
let chatMode = 'tab';
let transcript = null;
let pendingAttachments = [];
let chatPersistTimer = null;
let chatPersistenceBound = false;
let chatCurrentAgentName = null;
let activeWork = [];
let agentWork = [];
let agentRecentWork = [];
let attachedWorkId = null;
let pinnedConversationIds = new Set();
let workTabEventSource = null;
let seenWorkReceipts = new Set();
let hudToolName = '';
let streamOwnerId = TAB_ID;
let chatChannel = null;
let lastPreviewSnippet = '';
let chatReasoningEffort = null;
let chatDefaultReasoningEffort = 'medium';
let chatReasoningEfforts = CHAT_REASONING_EFFORTS.slice();
let chatShowThinking = true;
let conversationThinking = '';
const SHOW_THINKING_KEY = 'home23:chat:show-thinking';

const ATTACH_MAX_IMAGES = 6;
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function bridgeAuthHeaders() {
  return chatAgent?.bridgeToken ? { Authorization: `Bearer ${chatAgent.bridgeToken}` } : {};
}
function bridgeTokenParam() {
  return chatAgent?.bridgeToken ? `&token=${encodeURIComponent(chatAgent.bridgeToken)}` : '';
}
function bridgeBase() {
  if (!chatAgent?.bridgePort) return '';
  return `http://${window.location.hostname}:${chatAgent.bridgePort}`;
}

function _syncState() {
  chatState.set({
    agent: chatAgent,
    model: chatModel,
    provider: chatProvider ?? chatAgent?.provider ?? null,
    conversationId: chatConversationId,
    conversations: chatConversations,
    streaming: chatStreaming,
    activeTurnId,
    activeCursor,
    turnCtx: currentTurnCtx,
    input: document.getElementById('chat-input')?.value || '',
    activeWork,
    disconnected: chatDisconnected,
    previewSnippet: lastPreviewSnippet,
    reasoningEffort: chatReasoningEffort,
    defaultReasoningEffort: chatDefaultReasoningEffort,
    showThinking: chatShowThinking,
  });
  renderHomePreview();
}

function isStreamOwner() {
  return streamOwnerId === TAB_ID;
}

function postChannel(payload) {
  try { chatChannel?.postMessage({ tabId: TAB_ID, ...payload }); } catch { /* unsupported */ }
}

function claimStreamOwnership() {
  streamOwnerId = TAB_ID;
  postChannel({
    type: 'own-stream',
    chatId: chatConversationId,
    turnId: activeTurnId,
    cursor: activeCursor,
  });
  if (activeTurnId && chatConversationId && !activeEventSource && chatAgent?.bridgePort) {
    openTurnStream({
      bridgeBase: bridgeBase(),
      chatId: chatConversationId,
      turnId: activeTurnId,
      cursor: activeCursor,
    });
  }
}

function setupCrossTab() {
  if (chatChannel || typeof BroadcastChannel === 'undefined') return;
  chatChannel = new BroadcastChannel('home23-chat');
  chatChannel.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.tabId === TAB_ID) return;
    if (msg.type === 'own-stream') {
      streamOwnerId = msg.tabId;
      if (!isStreamOwner() && activeEventSource) {
        try { activeEventSource.close(); } catch { /* ignore */ }
        activeEventSource = null;
      }
    } else if (msg.type === 'selection' && msg.chatId && msg.chatId !== chatConversationId) {
      openConversation(msg.chatId, { fromChannel: true });
    } else if (msg.type === 'draft' && typeof msg.input === 'string') {
      const input = document.getElementById('chat-input');
      if (input && document.activeElement !== input) input.value = msg.input;
    } else if (msg.type === 'send' || msg.type === 'stop' || msg.type === 'new') {
      if (msg.chatId && msg.chatId === chatConversationId && chatAgent) {
        loadHistory(chatAgent.agentName, chatConversationId).catch(() => {});
      }
    }
  };
  window.addEventListener('focus', () => claimStreamOwnership());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') claimStreamOwnership();
  });
  window.addEventListener('hashchange', () => {
    if (String(window.location.hash || '').replace(/^#/, '') === 'chat') claimStreamOwnership();
  });
  claimStreamOwnership();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

export function populateChatInput(prompt, input = document.getElementById('chat-input')) {
  if (!input) return false;
  input.value = String(prompt || '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  return true;
}

async function ingestAttachmentFiles(files) {
  for (const file of files) {
    if (pendingAttachments.length >= ATTACH_MAX_IMAGES) break;
    if (!ATTACH_ALLOWED_MIME.has(file.type) || file.size > ATTACH_MAX_BYTES) continue;
    try {
      pendingAttachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        dataUrl: await readFileAsDataURL(file),
      });
    } catch { /* skip unreadable */ }
  }
  renderAttachmentTray();
}

function renderAttachmentTray() {
  const tray = document.getElementById('chat-attach-tray');
  if (!tray) return;
  if (pendingAttachments.length === 0) {
    tray.hidden = true;
    tray.innerHTML = '';
    return;
  }
  tray.hidden = false;
  tray.innerHTML = pendingAttachments.map((a) => `
    <div class="h23-chat-attach-thumb">
      <img src="${a.dataUrl}" alt="${a.file.name || 'attachment'}" />
      <button class="h23-chat-attach-thumb-remove" data-att-id="${a.id}" aria-label="Remove">&times;</button>
    </div>
  `).join('');
  tray.querySelectorAll('.h23-chat-attach-thumb-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((a) => a.id !== btn.dataset.attId);
      renderAttachmentTray();
    });
  });
}

export async function initChat(mode) {
  if (chatInitialized) return;
  chatInitialized = true;
  chatMode = mode || 'tab';

  try {
    const res = await fetch('/home23/api/settings/agents');
    const data = await res.json();
    chatAgents = data.agents || [];
    chatCurrentAgentName = data.currentAgent || null;
  } catch { chatAgents = []; }

  try {
    const res = await fetch('/home23/api/settings/models');
    const data = await res.json();
    chatModels = data.providers || {};
  } catch { chatModels = {}; }

  const urlAgent = new URLSearchParams(window.location.search).get('agent');
  const initialAgent = (urlAgent && chatAgents.find((a) => a.name === urlAgent))
    || (chatCurrentAgentName && chatAgents.find((a) => a.name === chatCurrentAgentName))
    || chatAgents.find((a) => a.isPrimary)
    || chatAgents[0];

  mountSharedChatNodes();
  const messages = document.getElementById('chat-messages');
  transcript = createTranscript(messages, {
    renderMarkdown,
    showThinking: chatShowThinking,
    onPromptSelect: populateChatInput,
  });
  transcript.setOnPinnedChange((pinned) => {
    const jump = document.getElementById('chat-jump-latest');
    if (jump) jump.hidden = pinned;
  });
  document.getElementById('chat-jump-latest')?.addEventListener('click', () => transcript?.jumpToLatest());
  setupThinkingToggle();

  if (!initialAgent) {
    transcript?.emptyState('No agents configured. Create one in Settings.');
    bindHomePreview();
    return;
  }

  bindChatPersistence();
  setupCrossTab();
  renderAgentSelectors(initialAgent.name);
  const shouldResumeHistory = chatMode !== 'preview';
  await switchAgent(initialAgent.name, {
    preferRestore: shouldResumeHistory,
    preferLatest: shouldResumeHistory,
  });
  chatModel = initialAgent.model;
  chatProvider = initialAgent.provider;
  populateModelSelect(initialAgent.provider, initialAgent.model);
  bindInput();
  setupWorkTab();
  setupMoreMenu();
  setupAgentPill();
  setupModelPill();
  setupEffortControls();
  setupKeyboard();
  setupHud();
  setupSidebar();
  bindHomePreview();

  const renderAgentHeader = (snap) => {
    const title = snap.agent?.displayName || snap.agent?.agentName || snap.agent?.name || '…';
    const nameEl = document.getElementById('chat-agent-name');
    const avatarEl = document.getElementById('chat-agent-avatar');
    if (nameEl) nameEl.textContent = title;
    if (avatarEl) avatarEl.textContent = String(title).trim().slice(0, 1).toUpperCase() || '*';
  };
  chatState.on('agent:switch', renderAgentHeader);
  renderAgentHeader(chatState.get());
  _syncState();
  const searchParams = new URLSearchParams(window.location.search);
  const deepWorkId = searchParams.get('work');
  if (deepWorkId) await openWorkById(deepWorkId);
}

function bindHomePreview() {
  const preview = document.getElementById('chat-home-preview');
  if (!preview || preview.dataset.bound) return;
  preview.dataset.bound = 'true';
  const open = () => {
    if (typeof window.selectDashboardTab === 'function') window.selectDashboardTab('chat');
    else window.location.hash = 'chat';
  };
  preview.addEventListener('click', open);
  preview.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
}

function renderHomePreview() {
  const agentEl = document.getElementById('chat-preview-agent');
  const snippetEl = document.getElementById('chat-preview-snippet');
  const statusEl = document.getElementById('chat-preview-status');
  const title = chatAgent?.displayName || chatAgent?.agentName || chatAgent?.name || 'Agent';
  if (agentEl) agentEl.textContent = title;
  if (snippetEl) snippetEl.textContent = lastPreviewSnippet || 'Open Chat to talk with your agent.';
  if (statusEl) {
    if (chatStreaming) statusEl.textContent = 'Live reply';
    else if (activeWork.length) statusEl.textContent = `${activeWork.length} running`;
    else statusEl.textContent = '';
  }
}

function mountSharedChatNodes() {
  if (document.getElementById('chat-shared')) return;
  const tpl = document.getElementById('chat-shared-template');
  const dest = document.getElementById('chat-slot-tab')
    || document.getElementById('chat-slot-standalone');
  if (!tpl?.content || !dest) return;
  dest.appendChild(tpl.content.firstElementChild.cloneNode(true));
}

function setupSidebar() {
  document.getElementById('chat-conv-new-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    newConversation();
  });
  document.getElementById('chat-sidebar-toggle')?.addEventListener('click', () => {
    document.getElementById('chat-sidebar')?.classList.toggle('open');
  });
}

function closeConversationList() {
  document.getElementById('chat-sidebar')?.classList.remove('open');
}

function setupKeyboard() {
  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') {
      if (chatStreaming) { event.preventDefault(); stopChat(); }
      document.getElementById('chat-sidebar')?.classList.remove('open');
      return;
    }
    if (mod && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      newConversation();
    }
    if (mod && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      document.getElementById('chat-input')?.focus();
    }
  });
}

function setupHud() {
  document.getElementById('chat-hud-stop')?.addEventListener('click', () => stopChat());
  document.getElementById('chat-hud-reconnect')?.addEventListener('click', () => {
    if (!activeTurnId || !chatConversationId || !chatAgent?.bridgePort) return;
    claimStreamOwnership();
    openTurnStream({
      bridgeBase: bridgeBase(),
      chatId: chatConversationId,
      turnId: activeTurnId,
      cursor: activeCursor,
    });
  });
  document.getElementById('chat-hud-refresh')?.addEventListener('click', () => refreshTurnStatus());
}

function setHud(visible, statusText) {
  const hud = document.getElementById('chat-turn-hud');
  const status = document.getElementById('chat-hud-status');
  if (status && statusText) status.textContent = statusText;
  if (hud) hud.hidden = !visible;
}

async function refreshTurnStatus() {
  if (!chatAgent?.bridgePort || !chatConversationId || !activeTurnId) return;
  try {
    const res = await fetch(
      `${bridgeBase()}/api/chat/turn-status?chatId=${encodeURIComponent(chatConversationId)}&turn_id=${encodeURIComponent(activeTurnId)}`,
      { headers: bridgeAuthHeaders() },
    );
    if (!res.ok) return;
    const data = await res.json();
    setHud(true, data.phase || data.status || 'Working');
  } catch { /* ignore */ }
}

function setupMoreMenu() {
  const menu = document.getElementById('chat-more-menu');
  if (!menu) return;
  function openAt(anchor) {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
  }
  function closeAll() {
    menu.hidden = true;
    document.getElementById('chat-more-btn')?.setAttribute('aria-expanded', 'false');
  }
  document.getElementById('chat-more-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.hidden) openAt(event.currentTarget);
    else closeAll();
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-action]');
    if (!item) return;
    event.preventDefault();
    closeAll();
    handleMenuAction(item.dataset.action);
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('#chat-more-btn, #chat-more-menu')) return;
    closeAll();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeAll();
  });
}

function handleMenuAction(action) {
  if (action === 'new-conversation') newConversation();
  else if (action === 'copy-transcript') copyTranscript();
  else if (action === 'export-transcript') exportTranscript();
  else if (action === 'open-standalone') {
    cacheHistory();
    const url = `/home23/chat?agent=${encodeURIComponent(chatAgent?.agentName || '')}`;
    window.open(url, '_blank');
  }
}

function openListPopover({ anchor, items, onSelect, emptyText = 'Nothing to show' }) {
  if (!anchor) return;
  let pop = document.getElementById('chat-list-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'chat-list-popover';
    pop.className = 'h23-chat-menu h23-chat-list-popover';
    pop.setAttribute('role', 'menu');
    document.body.appendChild(pop);
  }
  if (!items?.length) {
    pop.innerHTML = `<div class="h23-chat-menu-empty">${emptyText}</div>`;
  } else {
    pop.innerHTML = items.map((it, i) => `
      <button class="h23-chat-menu-item" data-i="${i}" role="menuitem" type="button">
        ${escapeHtml(it.label || String(it))}
        ${it.hint ? `<span class="h23-chat-menu-hint">${escapeHtml(it.hint)}</span>` : ''}
      </button>
    `).join('');
  }
  const rect = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 260))}px`;
  pop.style.top = `${rect.bottom + 4}px`;
  pop.hidden = false;
  const close = () => {
    pop.hidden = true;
    document.removeEventListener('click', onDocClick, true);
  };
  const onDocClick = (event) => {
    if (pop.contains(event.target) || anchor.contains(event.target)) return;
    close();
  };
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  pop.onclick = (event) => {
    const btn = event.target.closest('[data-i]');
    if (!btn) return;
    close();
    onSelect?.(items[Number(btn.dataset.i)]);
  };
}

function setupModelPill() {
  const pill = document.getElementById('chat-model-pill');
  if (!pill) return;
  pill.addEventListener('click', () => {
    const select = document.getElementById('chat-model-select');
    if (!select) return;
    const current = select.value;
    const items = Array.from(select.options).filter((o) => o.value).map((option) => ({
      label: option.dataset.model || option.textContent || '',
      hint: option.dataset.provider || '',
      _value: option.value,
      active: option.value === current,
    }));
    openListPopover({
      anchor: pill,
      items,
      emptyText: 'No models available for this provider.',
      onSelect: (it) => {
        select.value = it._value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  });
  const renderLabel = (snap) => {
    const label = document.getElementById('chat-model-pill-label');
    if (!label) return;
    const raw = snap.model || chatModel || '';
    label.textContent = shortenModelName(raw) || 'model';
    pill.title = raw ? `Model: ${raw}` : 'Change model';
  };
  chatState.on('change', renderLabel);
  renderLabel(chatState.get());
}

function shortenModelName(model) {
  if (!model) return '';
  const withoutDate = String(model).trim().replace(/-\d{8}$/, '');
  return withoutDate.length > 22 ? `${withoutDate.slice(0, 21)}…` : withoutDate;
}

function showEffortPicker(anchorOverride) {
  const configured = chatDefaultReasoningEffort || 'medium';
  const effective = effectiveChatReasoningEffort(chatReasoningEffort, configured);
  const items = [
    {
      label: `Default (${effortLabel(configured)})`,
      hint: 'configured',
      active: chatReasoningEffort === null,
      _effort: null,
    },
    ...chatReasoningEfforts.map((effort) => ({
      label: effortLabel(effort),
      hint: effort === effective && chatReasoningEffort !== null ? 'this chat' : '',
      active: chatReasoningEffort === effort,
      _effort: effort,
    })),
  ];
  const anchor = anchorOverride
    || document.getElementById('chat-effort-pill')
    || document.getElementById('chat-more-btn');
  openListPopover({
    anchor,
    items,
    emptyText: 'No reasoning efforts available.',
    onSelect: (item) => setChatReasoningEffort(item._effort),
  });
}

function setupEffortControls() {
  const pill = document.getElementById('chat-effort-pill');
  if (pill) pill.addEventListener('click', () => showEffortPicker(pill));

  const select = document.getElementById('chat-effort-select');
  if (select) {
    select.addEventListener('change', () => {
      setChatReasoningEffort(select.value || null);
    });
  }

  const renderControls = (snap) => {
    const configured = snap.defaultReasoningEffort || chatDefaultReasoningEffort || 'medium';
    const override = snap.reasoningEffort ?? null;
    const label = document.getElementById('chat-effort-pill-label');
    const effective = effectiveChatReasoningEffort(override, configured);
    if (pill) {
      pill.disabled = false;
      pill.dataset.override = override === null ? 'false' : 'true';
      pill.title = override === null
        ? `Reasoning effort: ${effortLabel(effective)} (configured default)`
        : `Reasoning effort: ${effortLabel(effective)} (this chat)`;
    }
    if (label) label.textContent = effortLabel(effective);
    if (select) {
      select.disabled = false;
      select.innerHTML = [
        `<option value="">Default (${escapeHtml(effortLabel(configured))})</option>`,
        ...chatReasoningEfforts.map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effortLabel(effort))}</option>`),
      ].join('');
      select.value = override || '';
    }
  };
  chatState.on('change', renderControls);
  renderControls(chatState.get());
}

function readShowThinking() {
  try {
    const stored = localStorage.getItem(SHOW_THINKING_KEY);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch { /* keep the page usable without storage */ }
  return true;
}

function applyShowThinkingUi() {
  const root = document.getElementById('chat-shared');
  if (root) root.dataset.showThinking = chatShowThinking ? 'true' : 'false';
  const btn = document.getElementById('chat-thinking-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', chatShowThinking ? 'true' : 'false');
    btn.title = chatShowThinking ? 'Hide thinking' : 'Show thinking';
  }
  transcript?.setShowThinking(chatShowThinking);
  if (!chatShowThinking) hideThoughtDock();
  else updateThoughtDock(conversationThinking, { live: chatStreaming });
}

function setShowThinking(next) {
  chatShowThinking = Boolean(next);
  try { localStorage.setItem(SHOW_THINKING_KEY, chatShowThinking ? '1' : '0'); } catch { /* ignore */ }
  applyShowThinkingUi();
  _syncState();
}

function setupThinkingToggle() {
  chatShowThinking = readShowThinking();
  const btn = document.getElementById('chat-thinking-toggle');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = 'true';
    btn.addEventListener('click', () => setShowThinking(!chatShowThinking));
  }
  applyShowThinkingUi();
}

function setThoughtRailLive(live) {
  const dock = document.getElementById('chat-thought-dock');
  const label = document.getElementById('chat-thought-dock-label');
  if (dock) dock.dataset.live = live ? 'true' : 'false';
  if (label) label.textContent = live ? 'Thinking' : 'Thought';
}

function updateThoughtDock(text, { live = false } = {}) {
  const dock = document.getElementById('chat-thought-dock');
  const body = document.getElementById('chat-thought-dock-body');
  if (!dock || !body) return;
  const next = String(text || '');
  conversationThinking = next;
  setThoughtRailLive(Boolean(live && next.trim()));
  if (!chatShowThinking || !next.trim()) {
    dock.hidden = true;
    return;
  }
  body.textContent = next;
  dock.hidden = false;
  body.scrollTop = body.scrollHeight;
}

function syncThoughtRailFromRecords(records) {
  updateThoughtDock(collectThinkingText(records), { live: chatStreaming });
}

function pauseTurnThinking(ctx) {
  if (!ctx) return;
  ctx.thinkingPaused = Boolean(ctx.currentThinking && String(ctx.currentThinking).trim());
}

function appendTurnThinking(ctx, chunk) {
  const piece = chunk || '';
  if (!piece) return;
  if (ctx.thinkingPaused && ctx.currentThinking) ctx.currentThinking += '\n\n';
  ctx.thinkingPaused = false;
  ctx.currentThinking += piece;
  updateThoughtDock(ctx.currentThinking, { live: true });
}

function hideThoughtDock() {
  const dock = document.getElementById('chat-thought-dock');
  if (dock) dock.hidden = true;
}

function getChatEffortStorageKey() {
  if (!chatAgent?.agentName || !chatConversationId) return null;
  return encodeChatEffortKey(chatAgent.agentName, chatConversationId);
}

function restoreChatReasoningEffort() {
  chatReasoningEffort = null;
  const key = getChatEffortStorageKey();
  if (!key) return;
  try {
    const stored = localStorage.getItem(key);
    chatReasoningEffort = parseChatReasoningEffort(stored, { allowDefault: true });
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    chatReasoningEffort = null;
  }
}

function setChatReasoningEffort(value) {
  const effort = parseChatReasoningEffort(value, { allowDefault: true });
  chatReasoningEffort = effort;
  const key = getChatEffortStorageKey();
  if (key) {
    try {
      if (effort === null) localStorage.removeItem(key);
      else localStorage.setItem(key, effort);
    } catch { /* keep the page usable without storage */ }
  }
  _syncState();
}

async function loadReasoningEffortCatalog() {
  chatDefaultReasoningEffort = 'medium';
  chatReasoningEfforts = CHAT_REASONING_EFFORTS.slice();
  if (!chatAgent?.bridgePort) return;
  try {
    const res = await fetch(`${bridgeBase()}/api/chat/models`, { headers: bridgeAuthHeaders() });
    if (!res.ok) return;
    const modelConfig = await res.json();
    chatDefaultReasoningEffort = parseChatReasoningEffort(
      modelConfig.defaultReasoningEffort,
      { allowDefault: true },
    ) ?? 'medium';
    if (Array.isArray(modelConfig.reasoningEfforts)) {
      chatReasoningEfforts = modelConfig.reasoningEfforts.map((value) => parseChatReasoningEffort(value));
    }
  } catch (err) {
    console.warn('[chat] reasoning effort catalog unavailable', err);
  }
}

function currentTranscriptMarkdown() {
  const exportedAt = new Date().toISOString();
  return transcript?.toMarkdown({
    agent: chatAgent?.displayName || chatAgent?.agentName || '',
    conversationId: chatConversationId || '',
    exportedAt,
    thinkingText: conversationThinking,
  }) || '';
}

function transcriptFilename() {
  const agent = String(chatAgent?.agentName || 'agent').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `home23-chat-${agent}-${stamp}.md`;
}

async function copyTranscript() {
  const markdown = currentTranscriptMarkdown();
  if (!markdown.trim()) {
    transcript?.appendError('Nothing to copy yet.');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(markdown);
    else throw new Error('clipboard unavailable');
    const item = document.querySelector('[data-action="copy-transcript"]');
    if (item) {
      const previous = item.textContent;
      item.textContent = 'Copied';
      setTimeout(() => { item.textContent = previous; }, 1200);
    }
  } catch {
    exportTranscript();
  }
}

function exportTranscript() {
  const markdown = currentTranscriptMarkdown();
  if (!markdown.trim()) {
    transcript?.appendError('Nothing to export yet.');
    return;
  }
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = transcriptFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setupAgentPill() {
  const pill = document.getElementById('chat-agent-pill');
  if (!pill) return;
  pill.addEventListener('click', () => {
    const currentName = chatAgent?.agentName;
    openListPopover({
      anchor: pill,
      items: chatAgents.map((a) => ({
        label: a.displayName || a.name,
        hint: a.isPrimary ? 'primary' : '',
        _name: a.name,
      })),
      onSelect: (it) => {
        if (it?._name && it._name !== currentName) switchAgent(it._name, { preferRestore: false });
      },
    });
  });
}

function bindInput() {
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      scheduleChatPersist();
      postChannel({ type: 'draft', input: input.value });
      _syncState();
    });
    input.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData?.items || [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (files.length) {
        event.preventDefault();
        ingestAttachmentFiles(files);
      }
    });
  }
  if (btn) {
    btn.addEventListener('click', () => {
      if (chatStreaming && !attachedWorkId) stopChat();
      else sendMessage();
    });
  }
  document.getElementById('chat-stop-btn')?.addEventListener('click', () => stopChat());

  const attachBtn = document.getElementById('chat-attach-btn');
  const attachInput = document.getElementById('chat-attach-input');
  if (attachBtn && attachInput && !attachBtn.dataset.bound) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      ingestAttachmentFiles(Array.from(attachInput.files || []));
      attachInput.value = '';
    });
    attachBtn.dataset.bound = 'true';
  }

  const inputArea = document.getElementById('chat-input-area') || document.querySelector('.sh-input-bar');
  const dropOverlay = document.getElementById('chat-drop-overlay');
  if (inputArea && dropOverlay && !inputArea.dataset.dropBound) {
    let dragDepth = 0;
    inputArea.addEventListener('dragenter', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      dragDepth += 1;
      dropOverlay.hidden = false;
    });
    inputArea.addEventListener('dragover', (event) => event.preventDefault());
    inputArea.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.hidden = true;
    });
    inputArea.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      dropOverlay.hidden = true;
      ingestAttachmentFiles(Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/')));
    });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      if (!inputArea.contains(event.target)) event.preventDefault();
    });
    inputArea.dataset.dropBound = 'true';
  }
}

function renderAgentSelectors(selectedName) {
  const options = chatAgents.map((agent) =>
    `<option value="${agent.name}" ${agent.name === selectedName ? 'selected' : ''}>${agent.displayName || agent.name}${agent.isPrimary ? ' (primary)' : ''}</option>`
  ).join('');
  document.querySelectorAll('.h23-chat-agent-select').forEach((select) => {
    select.innerHTML = options;
    select.value = selectedName;
    if (!select.dataset.bound) {
      select.addEventListener('change', () => switchAgent(select.value));
      select.dataset.bound = 'true';
    }
  });
}

function populateModelSelect(provider, currentModel) {
  let selectedValue = '';
  try {
    selectedValue = encodeModelPair({ provider, model: currentModel });
  } catch { /* invalid agent configuration stays unselected */ }
  const options = Object.entries(chatModels).map(([providerName, config]) => {
    const providerOptions = (config.defaultModels || []).map((model) => {
      const modelEntry = { provider: providerName, model };
      const value = encodeModelPair(modelEntry);
      return `<option value="${escapeHtml(encodeModelPair(modelEntry))}" data-provider="${escapeHtml(modelEntry.provider)}" data-model="${escapeHtml(modelEntry.model)}" title="${escapeHtml(`${modelEntry.provider} / ${modelEntry.model}`)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(formatModelLabel(modelEntry.model))}</option>`;
    }).join('');
    return providerOptions
      ? `<optgroup label="${escapeHtml(providerName)}">${providerOptions}</optgroup>`
      : '';
  }).join('');

  document.querySelectorAll('.h23-chat-model-select').forEach((select) => {
    select.innerHTML = options;
    select.value = selectedValue;
    select.title = select.selectedOptions[0]?.title || '';
    if (!select.dataset.bound) {
      select.addEventListener('change', async () => {
        let selectedPair;
        try {
          selectedPair = decodeModelPair(select.value);
        } catch {
          select.value = '';
          return;
        }
        chatModel = selectedPair.model;
        chatProvider = selectedPair.provider;
        if (chatAgent) chatAgent = { ...chatAgent, model: selectedPair.model, provider: selectedPair.provider };
        const agentRow = chatAgents.find((agent) => agent.name === chatAgent?.agentName);
        if (agentRow) {
          agentRow.model = selectedPair.model;
          agentRow.provider = selectedPair.provider;
        }
        syncModelSelectors(selectedPair.provider, selectedPair.model);
        _syncState();
        postChannel({ type: 'selection', chatId: chatConversationId, model: chatModel });
        if (chatAgent?.agentName) {
          try {
            await fetch(`/home23/api/settings/agents/${chatAgent.agentName}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: selectedPair.model, provider: selectedPair.provider }),
            });
          } catch (err) {
            console.warn('Failed to persist model change:', err);
          }
        }
      });
      select.dataset.bound = 'true';
    }
  });

  chatProvider = provider;
  chatModel = currentModel;
  syncModelSelectors(provider, currentModel);
}

function syncModelSelectors(providerName, modelName) {
  if (!providerName || !modelName) return;
  const value = encodeModelPair({ provider: providerName, model: modelName });
  document.querySelectorAll('.h23-chat-model-select').forEach((select) => {
    select.value = value;
    select.title = select.selectedOptions[0]?.title || '';
  });
}

function formatModelLabel(modelName) {
  return modelName.length > 28 ? `${modelName.slice(0, 25)}…` : modelName;
}

async function switchAgent(name, { preferRestore = false, preferLatest = true } = {}) {
  const agentData = chatAgents.find((a) => a.name === name);
  if (!agentData) return;
  try {
    const res = await fetch(`${CHAT_API}/config/${encodeURIComponent(name)}`);
    const cfg = await res.json();
    chatAgent = {
      ...agentData,
      agentName: cfg.agentName || name,
      displayName: cfg.displayName || agentData.displayName || name,
      bridgePort: cfg.bridgePort,
      bridgeToken: cfg.bridgeToken || '',
    };
  } catch {
    chatAgent = { ...agentData, agentName: name };
  }
  chatProvider = agentData.provider;
  populateModelSelect(agentData.provider, agentData.model);
  await loadReasoningEffortCatalog();
  await loadConversationList(name);
  if (preferRestore && restoreChatState(name)) {
    restoreChatReasoningEffort();
    renderConversationList();
    resetSendButtons();
    openWorkStream();
    _syncState();
    return;
  }
  const latest = Array.isArray(chatConversations) ? chatConversations.find(isResumableConversation) : null;
  if (preferLatest && latest?.id) {
    chatConversationId = latest.id;
    await loadHistory(name, latest.id);
  } else {
    newConversation();
    await loadHistory(name);
  }
  restoreChatReasoningEffort();
  renderConversationList();
  openWorkStream();
  _syncState();
}

function isMachineConversationId(id) {
  const value = String(id || '');
  return value === 'cron-decisions'
    || value.startsWith('cron-')
    || value.startsWith('subagent:')
    || value.startsWith('cron-agent-')
    || value.startsWith('diagnose_')
    || value.startsWith('repair_')
    || value.startsWith('verify_')
    || value.startsWith('worker_');
}

function isResumableConversation(conversation) {
  if (!conversation || isMachineConversationId(conversation.id)) return false;
  if (String(conversation.id || '').startsWith('codex-')) return false;
  return !['cron', 'diagnostic', 'machine'].includes(conversation.source);
}

async function loadHistory(agentName, conversationId) {
  if (!transcript) return;
  const convId = conversationId || chatConversationId;
  if (chatAgent?.bridgePort && convId) {
    try {
      const res = await fetch(
        `${bridgeBase()}/api/chat/history?chatId=${encodeURIComponent(convId)}&limit=200`,
        { headers: bridgeAuthHeaders() },
      );
      if (res.ok) {
        const data = await res.json();
        transcript.renderHistory(data.records || []);
        syncThoughtRailFromRecords(data.records || []);
        const lastAssistant = [...(data.records || [])].reverse().find((r) => r?.role === 'assistant' && r.content);
        lastPreviewSnippet = lastAssistant?.content?.slice(0, 140) || lastPreviewSnippet;
        scheduleChatPersist();
        await resumePendingTurns();
        _syncState();
        return;
      }
    } catch (err) {
      console.warn('[chat] projected history failed, falling back', err);
    }
  }
  const convParam = convId ? `&conversation=${encodeURIComponent(convId)}` : '';
  try {
    const res = await fetch(`${CHAT_API}/history/${agentName}?limit=100${convParam}`);
    const data = await res.json();
    const records = (data.messages || []).map((m) => ({ role: m.role, content: m.content }));
    transcript.renderHistory(records);
    syncThoughtRailFromRecords(records);
  } catch {
    transcript.emptyState();
    if (!chatStreaming) syncThoughtRailFromRecords([]);
  }
  await resumePendingTurns();
  _syncState();
}

async function resumePendingTurns() {
  if (!chatAgent?.bridgePort || !chatConversationId) return;
  try {
    const res = await fetch(
      `${bridgeBase()}/api/chat/pending?chatId=${encodeURIComponent(chatConversationId)}`,
      { headers: bridgeAuthHeaders() },
    );
    if (!res.ok) return;
    const data = await res.json();
    const pending = data.pending || [];
    if (!pending.length) return;
    const turn = pending[pending.length - 1];
    currentTurnCtx = {
      turnId: turn.turn_id,
      currentResponse: '',
      currentThinking: '',
      thinkingPaused: false,
    };
    activeTurnId = turn.turn_id;
    activeChatId = chatConversationId;
    activeCursor = -1;
    chatStreaming = true;
    setSendAsStop();
    setHud(true, 'Resuming');
    if (isStreamOwner()) {
      openTurnStream({
        bridgeBase: bridgeBase(),
        chatId: activeChatId,
        turnId: turn.turn_id,
        cursor: -1,
      });
    }
    _syncState();
  } catch (err) {
    console.warn('[chat] pending-turn resume failed', err);
  }
}

function newConversation() {
  unpinMachineChatsExcept(null);
  attachedWorkId = null;
  chatConversationId = `dashboard-${chatAgent?.agentName || 'agent'}-${Date.now()}`;
  seenWorkReceipts = new Set();
  transcript?.emptyState();
  lastPreviewSnippet = '';
  updateThoughtDock('');
  restoreChatReasoningEffort();
  updateConversationListHighlight();
  scheduleChatPersist();
  openWorkStream();
  postChannel({ type: 'new', chatId: chatConversationId });
  _syncState();
}

async function loadConversationList(agentName) {
  try {
    const res = await fetch(`${CHAT_API}/conversations/${encodeURIComponent(agentName)}`);
    const data = await res.json();
    chatConversations = (data.conversations || []).filter((c) =>
      !isMachineConversationId(c.id) || pinnedConversationIds.has(c.id));
  } catch { chatConversations = []; }
  renderConversationList();
}

function renderConversationList() {
  const list = document.getElementById('chat-conv-list');
  if (!list) return;
  if (!chatConversations.length) {
    list.innerHTML = '<div class="h23-chat-conv-empty">No previous conversations</div>';
    return;
  }
  list.innerHTML = chatConversations.map((c) => {
    const isActive = c.id === chatConversationId;
    const timeStr = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '';
    return `
      <button class="h23-chat-conv-item ${isActive ? 'active' : ''}" data-conv-id="${escapeHtml(c.id)}" type="button" title="${escapeHtml(c.preview || '')}">
        <div class="h23-chat-conv-preview">${escapeHtml(c.preview || 'Conversation')}</div>
        <div class="h23-chat-conv-meta">${escapeHtml(timeStr)} · ${c.messageCount || 0} msgs</div>
      </button>
    `;
  }).join('');
  list.querySelectorAll('[data-conv-id]').forEach((el) => {
    el.addEventListener('click', () => openConversation(el.dataset.convId));
  });
}

function updateConversationListHighlight() {
  document.querySelectorAll('.h23-chat-conv-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.convId === chatConversationId);
  });
}

async function openConversation(id, { fromChannel = false } = {}) {
  if (!id || !chatAgent) return;
  unpinMachineChatsExcept(id);
  chatConversationId = id;
  seenWorkReceipts = new Set();
  updateConversationListHighlight();
  await loadHistory(chatAgent.agentName, id);
  restoreChatReasoningEffort();
  openWorkStream();
  document.getElementById('chat-sidebar')?.classList.remove('open');
  if (!fromChannel) postChannel({ type: 'selection', chatId: id });
  _syncState();
}

const SLASH = {
  '/new': { description: 'Start a fresh conversation', handler: () => newConversation() },
  '/clear': { description: 'Clear chat history', handler: () => newConversation() },
  '/stop': { description: 'Stop the current agent run', handler: () => stopChat() },
  '/effort': {
    description: 'Show or set this chat\'s reasoning effort',
    handler: (arg) => handleEffortCommand(arg),
  },
  '/help': { description: 'Show available commands', handler: () => {
    transcript?.appendAssistant(Object.entries(SLASH).map(([k, v]) => `**${k}** — ${v.description}`).join('\n'));
  } },
};

function handleEffortCommand(arg) {
  const configured = chatDefaultReasoningEffort || 'medium';
  if (!arg) {
    const effective = effectiveChatReasoningEffort(chatReasoningEffort, configured);
    transcript?.appendAssistant(chatReasoningEffort
      ? `Reasoning effort: **${effortLabel(effective)}** (this chat). \`/effort reset\` returns to ${effortLabel(configured)}.`
      : `Reasoning effort: **${effortLabel(effective)}** (configured default).`);
    return;
  }
  if (arg.toLowerCase() === 'reset') {
    setChatReasoningEffort(null);
    transcript?.appendAssistant(`Reasoning effort reset to **${effortLabel(configured)}** (configured default).`);
    return;
  }
  try {
    const effort = parseChatReasoningEffort(arg);
    setChatReasoningEffort(effort);
    transcript?.appendAssistant(`Reasoning effort set to **${effortLabel(effort)}** for this chat.`);
  } catch {
    transcript?.appendError(`Invalid effort. Use: ${CHAT_REASONING_EFFORTS.join(', ')}, or reset.`);
  }
}

function handleSlashCommand(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const entry = SLASH[cmd];
  if (!entry) {
    transcript?.appendError(`Unknown command ${cmd}. Try /help.`);
    return;
  }
  entry.handler(rest.join(' ').trim());
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  if (!input || !chatAgent) return;
  const text = input.value.trim();
  if (attachedWorkId && (chatStreaming || activeTurnId) && text) {
    input.value = '';
    input.style.height = 'auto';
    await injectSteer(attachedWorkId, text);
    return;
  }
  if (chatStreaming) return;
  if ((!text && pendingAttachments.length === 0)) return;
  const turnAttachments = pendingAttachments.slice();
  pendingAttachments = [];
  renderAttachmentTray();
  input.value = '';
  input.style.height = 'auto';
  if (text.startsWith('/')) {
    handleSlashCommand(text);
    return;
  }
  lastPreviewSnippet = text.slice(0, 140);
  transcript?.appendUser(text, turnAttachments.map((a) => a.dataUrl));
  chatStreaming = true;
  chatDisconnected = false;
  setSendAsStop();
  setHud(true, 'Working');
  conversationThinking = '';
  currentTurnCtx = {
    currentResponse: '',
    currentThinking: '',
    thinkingPaused: false,
  };
  updateThoughtDock('', { live: true });
  activeChatId = chatConversationId;
  activeCursor = -1;
  _syncState();
  claimStreamOwnership();

  let turnId;
  try {
    const imagesPayload = turnAttachments.map((a) => ({
      data: dataUrlToBase64(a.dataUrl),
      mimeType: a.file.type,
      fileName: a.file.name,
    }));
    const res = await fetch(`${bridgeBase()}/api/chat/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeAuthHeaders() },
      body: JSON.stringify({
        chatId: activeChatId,
        message: text,
        ...(chatReasoningEffort ? { effort: chatReasoningEffort } : {}),
        ...(imagesPayload.length ? { images: imagesPayload } : {}),
      }),
    });
    if (res.status === 409) {
      const data = await res.json();
      turnId = data.turn_id;
    } else if (!res.ok) {
      let errBody = '';
      try { errBody = (await res.json()).error || ''; } catch { /* ignore */ }
      throw new Error(`turn start failed (${res.status}) ${errBody}`);
    } else {
      turnId = (await res.json()).turn_id;
    }
  } catch (err) {
    transcript?.appendError(`Connection failed: ${err.message}`);
    chatStreaming = false;
    resetSendButtons();
    setHud(false);
    _syncState();
    return;
  }
  activeTurnId = turnId;
  currentTurnCtx.turnId = turnId;
  postChannel({ type: 'send', chatId: activeChatId, turnId });
  openTurnStream({ bridgeBase: bridgeBase(), chatId: activeChatId, turnId, cursor: -1 });
}

function dispatchLegacyEvent(event, ctx) {
  if (event.type === 'text' || event.type === 'response_chunk') {
    pauseTurnThinking(ctx);
    ctx.currentResponse += event.text || event.chunk || '';
    transcript?.updateAssistant(ctx.currentResponse, ctx.turnId);
    setHud(true, hudToolName ? `Streaming · ${hudToolName}` : 'Streaming');
  } else if (event.type === 'thinking') {
    appendTurnThinking(ctx, event.content || event.message || '');
    setHud(true, 'Thinking');
  } else if (event.type === 'tool_start') {
    hudToolName = event.tool || event.name || 'tool';
    pauseTurnThinking(ctx);
    ctx.currentResponse = '';
    transcript?.appendTool(hudToolName, event.args, 'running');
    setHud(true, `Running ${hudToolName}`);
    if (hudToolName === 'spawn_agent' || hudToolName === 'coding_run' || hudToolName === 'coding_continue') {
      refreshWorkSnapshot();
    }
  } else if (event.type === 'tool_complete' || event.type === 'tool_result') {
    transcript?.updateTool(event.tool || event.name, event.result || event.summary || event.output, event.success !== false);
    hudToolName = '';
  } else if (event.type === 'media') {
    transcript?.appendMedia(event.mediaType, event.path, event.caption);
  } else if (event.type === 'subagent_result') {
    transcript?.appendWorkReceipt({
      label: event.task || 'Sub-agent',
      result: event.result || '',
      status: String(event.result || '').startsWith('Error:') ? 'failed' : 'completed',
    });
  } else if (event.type === 'status') {
    setHud(true, event.status || event.content || 'Working');
  }
}

function openTurnStream({ bridgeBase: base, chatId, turnId, cursor }) {
  if (!isStreamOwner()) return;
  if (activeEventSource) { try { activeEventSource.close(); } catch { /* ignore */ } }
  const url = `${base}/api/chat/stream?chatId=${encodeURIComponent(chatId)}&turn_id=${encodeURIComponent(turnId)}&cursor=${cursor}${bridgeTokenParam()}`;
  const es = new EventSource(url);
  activeEventSource = es;
  chatDisconnected = false;

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
    try { es.close(); } catch { /* ignore */ }
    if (activeEventSource === es) activeEventSource = null;
    if (activeTurnId) {
      chatDisconnected = true;
      chatStreaming = false;
      resetSendButtons();
      setHud(true, 'Disconnected — Reconnect to continue');
      _syncState();
    }
  };
}

function finalizeTurn(finalEnvelope) {
  if (!chatStreaming && !activeTurnId) {
    resetSendButtons();
    setHud(false);
    return;
  }
  if (finalEnvelope?.status === 'complete' && typeof finalEnvelope.assistant_content === 'string') {
    const container = document.getElementById('chat-messages');
    const reconciled = reconcileCanonicalAssistantElements(
      container?.querySelectorAll('.h23-chat-msg.assistant'),
      finalEnvelope.turn_id,
      finalEnvelope.assistant_content,
      renderMarkdown,
    );
    if (!reconciled) transcript?.appendAssistant(finalEnvelope.assistant_content, finalEnvelope.turn_id);
    lastPreviewSnippet = finalEnvelope.assistant_content.slice(0, 140);
  }
  if (finalEnvelope?.status === 'error') {
    transcript?.appendError(finalEnvelope.error || 'Error');
  } else if (finalEnvelope?.status === 'orphaned') {
    transcript?.appendError('Previous turn was interrupted — try resending.');
  } else if (finalEnvelope?.status === 'stopped' && activeWork.length) {
    transcript?.appendError(`Stopped this reply. ${activeWork.length} background job${activeWork.length === 1 ? '' : 's'} still running.`);
  }

  chatStreaming = false;
  chatDisconnected = false;
  hudToolName = '';
  activeTurnId = null;
  activeChatId = null;
  activeCursor = -1;
  currentTurnCtx = null;
  resetSendButtons();
  setHud(false);
  updateThoughtDock(conversationThinking, { live: false });
  cacheHistory();
  scheduleChatPersist();
  _syncState();
}

function setStopButtonVisible(visible) {
  const stopBtn = document.getElementById('chat-stop-btn');
  if (stopBtn) stopBtn.hidden = !visible;
}

function setSendAsStop() {
  const sendBtn = document.getElementById('chat-send-btn');
  setStopButtonVisible(true);
  if (!sendBtn) return;
  if (attachedWorkId) {
    resetSendButtons();
    setStopButtonVisible(true);
    return;
  }
  sendBtn.innerHTML = '&#9632;';
  sendBtn.disabled = false;
  sendBtn.title = 'Stop this reply';
  sendBtn.setAttribute('aria-label', 'Stop this reply');
  sendBtn.style.background = 'var(--accent-red, #b53f3f)';
}

function resetSendButtons() {
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) {
    sendBtn.innerHTML = '&#9654;';
    sendBtn.disabled = false;
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.style.background = '';
  }
  setStopButtonVisible(Boolean(chatStreaming && attachedWorkId));
}

async function stopChat() {
  const turnId = activeTurnId;
  const chatId = activeChatId || chatConversationId;
  if (activeEventSource) { try { activeEventSource.close(); } catch { /* ignore */ } activeEventSource = null; }
  if (chatAgent?.bridgePort && chatId) {
    try {
      await fetch(`${bridgeBase()}/api/chat/stop-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bridgeAuthHeaders() },
        body: JSON.stringify({ chatId, ...(turnId ? { turn_id: turnId } : {}) }),
      });
    } catch { /* unreachable */ }
  }
  postChannel({ type: 'stop', chatId, turnId });
  finalizeTurn({ status: 'stopped' });
}

function workChatId(item) {
  const handle = item?.resultHandle;
  if (!handle || typeof handle !== 'object') return null;
  if (handle.type === 'subagent_chat' || handle.type === 'cron_chat') return handle.chatId || null;
  return null;
}

function unpinMachineChatsExcept(keepId) {
  for (const id of [...pinnedConversationIds]) {
    if (id !== keepId && isMachineConversationId(id)) pinnedConversationIds.delete(id);
  }
  if (attachedWorkId) {
    const known = [...activeWork, ...agentWork, ...agentRecentWork].find((item) => item.workId === attachedWorkId);
    if (!known || workChatId(known) !== keepId) attachedWorkId = null;
  }
}

function pinConversation(id, label) {
  if (!id) return;
  pinnedConversationIds.add(id);
  if (!chatConversations.some((c) => c.id === id)) {
    chatConversations = [{
      id,
      preview: label || id,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    }, ...chatConversations];
  }
}

async function openWorkConversation(work) {
  const chatId = workChatId(work);
  if (!chatId || !chatAgent) return;
  pinConversation(chatId, work.label);
  document.querySelector('.h23-tab[data-tab="chat"]')?.click();
  await openConversation(chatId);
  attachedWorkId = work.workId;
  renderConversationList();
  if (chatStreaming) setSendAsStop();
}

async function openWorkById(workId) {
  if (!workId || !chatAgent?.bridgePort) return;
  const known = [...activeWork, ...agentWork, ...agentRecentWork].find((item) => item.workId === workId);
  if (known) {
    await openWorkConversation(known);
    return;
  }
  try {
    const res = await fetch(`${bridgeBase()}/api/work/${encodeURIComponent(workId)}`, { headers: bridgeAuthHeaders() });
    if (!res.ok) return;
    await openWorkConversation(await res.json());
  } catch { /* ignore */ }
}

async function injectSteer(workId, text) {
  if (!chatAgent?.bridgePort || !workId || !text) return;
  transcript?.appendUser(text);
  try {
    const res = await fetch(`${bridgeBase()}/api/work/${encodeURIComponent(workId)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeAuthHeaders() },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      transcript?.appendError(data.error || `Steer failed (${res.status})`);
    }
  } catch (err) {
    transcript?.appendError(`Steer failed: ${err.message || err}`);
  }
}

function renderWorkStrip() {
  const el = document.getElementById('chat-work-strip');
  if (!el) return;
  if (!activeWork.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = activeWork.map((item) => {
    const canOpen = Boolean(workChatId(item));
    return `
    <div class="h23-chat-work-row" data-work-id="${escapeHtml(item.workId)}">
      <span class="h23-chat-work-kind">${escapeHtml(item.kind || '')}</span>
      <span class="h23-chat-work-label">${escapeHtml(item.label || item.kind)}</span>
      <span class="h23-chat-work-progress">${escapeHtml(item.progressSummary || item.status)}</span>
      ${canOpen ? `<button type="button" class="h23-chat-work-open" data-work-id="${escapeHtml(item.workId)}">Open</button>` : ''}
      <button type="button" class="h23-chat-work-cancel" data-work-id="${escapeHtml(item.workId)}">Cancel</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.h23-chat-work-cancel').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      cancelWork(btn.dataset.workId);
    });
  });
  el.querySelectorAll('.h23-chat-work-open').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openWorkById(btn.dataset.workId);
    });
  });
  el.querySelectorAll('.h23-chat-work-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('.h23-chat-work-cancel, .h23-chat-work-open')) return;
      openWorkById(row.dataset.workId);
    });
  });
}

async function cancelWork(workId) {
  if (!chatAgent?.bridgePort || !workId) return;
  try {
    await fetch(`${bridgeBase()}/api/work/${encodeURIComponent(workId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeAuthHeaders() },
    });
    await refreshWorkSnapshot();
    await refreshAgentWorkSnapshot();
  } catch { /* ignore */ }
}

async function refreshWorkSnapshot() {
  if (!chatAgent?.bridgePort || !chatConversationId) return;
  try {
    const res = await fetch(
      `${bridgeBase()}/api/work?chatId=${encodeURIComponent(chatConversationId)}&active=1`,
      { headers: bridgeAuthHeaders() },
    );
    if (!res.ok) return;
    const data = await res.json();
    activeWork = data.work || [];
    renderWorkStrip();
    _syncState();
  } catch { /* ignore */ }
}

function openWorkStream() {
  if (workEventSource) { try { workEventSource.close(); } catch { /* ignore */ } workEventSource = null; }
  if (!chatAgent?.bridgePort || !chatConversationId) return;
  refreshWorkSnapshot();
  const url = `${bridgeBase()}/api/work/stream?chatId=${encodeURIComponent(chatConversationId)}${bridgeTokenParam()}`;
  const es = new EventSource(url);
  workEventSource = es;
  es.onmessage = (msg) => {
    if (!msg.data || msg.data.startsWith(':')) return;
    let record;
    try { record = JSON.parse(msg.data); } catch { return; }
    if (record.type === 'snapshot') {
      activeWork = record.work || [];
      renderWorkStrip();
      _syncState();
      return;
    }
    if (record.type === 'update' && record.work) {
      const next = record.work;
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(next.status);
      if (terminal) {
        activeWork = activeWork.filter((w) => w.workId !== next.workId);
        if (!seenWorkReceipts.has(next.workId)) {
          seenWorkReceipts.add(next.workId);
          fetchWorkReceipt(next.workId, next);
        }
      } else {
        const idx = activeWork.findIndex((w) => w.workId === next.workId);
        if (idx >= 0) activeWork[idx] = next;
        else activeWork.push(next);
      }
      renderWorkStrip();
      _syncState();
    }
  };
  es.onerror = () => {
    try { es.close(); } catch { /* ignore */ }
    if (workEventSource === es) workEventSource = null;
  };
}

async function fetchWorkReceipt(workId, work) {
  try {
    const res = await fetch(`${bridgeBase()}/api/work/${encodeURIComponent(workId)}/receipt`, { headers: bridgeAuthHeaders() });
    let result = work?.error || work?.status || '';
    if (res.ok) {
      const data = await res.json();
      result = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data.work, null, 2);
    }
    transcript?.appendWorkReceipt({
      label: work?.label || 'Background work',
      result,
      status: work?.status || 'completed',
    });
  } catch {
    transcript?.appendWorkReceipt({
      label: work?.label || 'Background work',
      result: work?.error || 'Finished.',
      status: work?.status || 'completed',
    });
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function cacheHistory() {
  if (!chatAgent) return;
  try {
    localStorage.setItem(getChatSessionKey(chatAgent.agentName), JSON.stringify({
      agentName: chatAgent.agentName,
      conversationId: chatConversationId,
      streaming: chatStreaming,
      savedAt: Date.now(),
      tileInput: document.getElementById('chat-input')?.value || '',
    }));
  } catch { /* quota */ }
}

function getChatSessionKey(agentName) {
  return `home23:chat:session:${agentName}`;
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
    const restoredId = saved.conversationId;
    if (!restoredId || isMachineConversationId(restoredId) || String(restoredId).startsWith('codex-')) return false;
    chatConversationId = restoredId;
    const input = document.getElementById('chat-input');
    if (input) input.value = saved.tileInput || '';
    loadHistory(agentName, restoredId);
    return true;
  } catch {
    return false;
  }
}

const TERMINAL_WORK = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function workTabRowHtml(item) {
  const canOpen = Boolean(workChatId(item));
  return `
    <div class="h23-work-row" data-work-id="${escapeHtml(item.workId)}">
      <span class="h23-work-kind">${escapeHtml(item.kind || '')}</span>
      <span class="h23-work-label">${escapeHtml(item.label || item.kind || item.workId)}</span>
      <span class="h23-work-origin">${escapeHtml(item.originChatId || '')}</span>
      <span class="h23-work-progress">${escapeHtml(item.progressSummary || item.status || '')}</span>
      ${canOpen ? `<button type="button" class="h23-chat-work-open" data-work-id="${escapeHtml(item.workId)}">Open</button>` : ''}
      ${TERMINAL_WORK.has(item.status) ? '' : `<button type="button" class="h23-chat-work-cancel" data-work-id="${escapeHtml(item.workId)}">Cancel</button>`}
    </div>`;
}

function bindWorkList(el) {
  if (!el) return;
  el.querySelectorAll('.h23-chat-work-open').forEach((btn) => {
    btn.addEventListener('click', () => openWorkById(btn.dataset.workId));
  });
  el.querySelectorAll('.h23-chat-work-cancel').forEach((btn) => {
    btn.addEventListener('click', () => cancelWork(btn.dataset.workId));
  });
}

function renderWorkTab() {
  const activeEl = document.getElementById('work-active-list');
  const recentEl = document.getElementById('work-recent-list');
  if (activeEl) {
    activeEl.innerHTML = agentWork.length
      ? agentWork.map(workTabRowHtml).join('')
      : '<div class="h23-work-empty">Nothing running</div>';
    bindWorkList(activeEl);
  }
  if (recentEl) {
    recentEl.innerHTML = agentRecentWork.length
      ? agentRecentWork.map(workTabRowHtml).join('')
      : '<div class="h23-work-empty">No recent work</div>';
    bindWorkList(recentEl);
  }
}

async function refreshAgentWorkSnapshot() {
  if (!chatAgent?.bridgePort) return;
  try {
    const res = await fetch(`${bridgeBase()}/api/work?limit=40`, { headers: bridgeAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const all = data.work || [];
    agentWork = all.filter((item) => !TERMINAL_WORK.has(item.status));
    agentRecentWork = all.filter((item) => TERMINAL_WORK.has(item.status)).slice(0, 8);
    renderWorkTab();
  } catch { /* ignore */ }
}

function openAgentWorkStream() {
  if (workTabEventSource) { try { workTabEventSource.close(); } catch { /* ignore */ } workTabEventSource = null; }
  if (!chatAgent?.bridgePort) return;
  refreshAgentWorkSnapshot();
  const url = `${bridgeBase()}/api/work/stream${bridgeTokenParam() ? `?${bridgeTokenParam().slice(1)}` : ''}`;
  const es = new EventSource(url);
  workTabEventSource = es;
  es.onmessage = (msg) => {
    if (!msg.data || msg.data.startsWith(':')) return;
    let record;
    try { record = JSON.parse(msg.data); } catch { return; }
    if (record.type === 'snapshot') {
      agentWork = record.work || [];
      renderWorkTab();
      return;
    }
    if (record.type === 'update' && record.work) {
      const next = record.work;
      if (TERMINAL_WORK.has(next.status)) {
        agentWork = agentWork.filter((item) => item.workId !== next.workId);
        agentRecentWork = [next, ...agentRecentWork.filter((item) => item.workId !== next.workId)].slice(0, 8);
      } else {
        const idx = agentWork.findIndex((item) => item.workId === next.workId);
        if (idx >= 0) agentWork[idx] = next;
        else agentWork.unshift(next);
      }
      renderWorkTab();
    }
  };
  es.onerror = () => {
    try { es.close(); } catch { /* ignore */ }
    if (workTabEventSource === es) workTabEventSource = null;
  };
}

function setupWorkTab() {
  const tab = document.querySelector('.h23-tab[data-tab="work"]');
  if (!tab) return;
  tab.addEventListener('click', () => {
    openAgentWorkStream();
  });
  if (document.getElementById('panel-work')?.classList.contains('active')) {
    openAgentWorkStream();
  }
}

function bindChatPersistence() {
  if (chatPersistenceBound) return;
  const persist = () => cacheHistory();
  window.addEventListener('beforeunload', persist);
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
    if (document.visibilityState === 'visible' && activeTurnId && !activeEventSource && isStreamOwner()) {
      openTurnStream({
        bridgeBase: bridgeBase(),
        chatId: chatConversationId,
        turnId: activeTurnId,
        cursor: activeCursor,
      });
    }
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

if (typeof window !== 'undefined') {
  window.initChat = initChat;
  window.openWorkById = openWorkById;
  window.openAgentWorkStream = openAgentWorkStream;
  window.openConversation = openConversation;
  window.newConversation = newConversation;
  window.stopChat = stopChat;
  window.sendMessage = sendMessage;
  window.closeOverlay = () => {};
  window.openOverlay = () => {
    if (typeof window.selectDashboardTab === 'function') window.selectDashboardTab('chat');
  };
  window.setupConversationPanelControls = setupSidebar;
  window.closeConversationList = closeConversationList;
  window.toggleConversationList = () => document.getElementById('chat-sidebar')?.classList.toggle('open');
  window.maybeAutoInitDashboardChat = function maybeAutoInitDashboardChat() {
    if (document.getElementById('chat-slot-standalone')) return;
    if (!document.getElementById('chat-slot-tab') && !document.getElementById('chat-home-preview')) return;
    initChat('tab');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.maybeAutoInitDashboardChat, { once: true });
  } else {
    window.maybeAutoInitDashboardChat();
  }
}
