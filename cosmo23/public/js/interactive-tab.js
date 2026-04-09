/**
 * Interactive Tab — Chat interface for live interaction with COSMO research brains
 * Self-contained IIFE module. Exposes window.InteractiveTab.
 */
(function () {
  'use strict';

  let sessionId = null;
  let currentBrainId = null;
  let isWaiting = false;
  let currentAssistantEl = null;
  let abortController = null;

  /* ═══════════════════════════════════════════════════════
     Init / Destroy
     ═══════════════════════════════════════════════════════ */

  function init(brainId) {
    currentBrainId = brainId || null;
    bindEvents();
    // Model select populated by app.js renderModelOptions() — single source of truth
    updateContextBar();
    updateSessionUI();
  }

  function destroy() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    sessionId = null;
    currentBrainId = null;
    isWaiting = false;
    currentAssistantEl = null;
  }

  /* ═══════════════════════════════════════════════════════
     Event Binding
     ═══════════════════════════════════════════════════════ */

  let _bound = false;

  function bindEvents() {
    if (_bound) return;
    _bound = true;

    const sessionBtn = document.getElementById('interactive-session-btn');
    const sendBtn = document.getElementById('interactive-send');
    const input = document.getElementById('interactive-input');

    if (sessionBtn) {
      sessionBtn.addEventListener('click', () => {
        if (sessionId) {
          stopSession();
        } else {
          startSession();
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const msg = input?.value?.trim();
        if (msg) sendMessage(msg);
      });
    }

    if (input) {
      input.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          const msg = input.value?.trim();
          if (msg && !isWaiting && sessionId) sendMessage(msg);
        }
      });
    }
  }

  /* ═══════════════════════════════════════════════════════
     Session Management
     ═══════════════════════════════════════════════════════ */

  async function startSession() {
    try {
      const body = {};
      if (currentBrainId) body.brainId = currentBrainId;
      const modelSelect = document.getElementById('interactive-model');
      const selectedModel = modelSelect?.value;
      const selectedProvider = modelSelect?.selectedOptions?.[0]?.dataset?.provider;
      if (selectedModel) body.model = selectedModel;
      if (selectedProvider) body.provider = selectedProvider;

      const res = await fetch('/api/interactive/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const result = await res.json();
      sessionId = result.sessionId;
      updateSessionUI();
      updateContextBar(result.context);
      clearMessages();
      addSystemMessage('Session started. You can now interact with the research brain.');
    } catch (err) {
      console.error('[InteractiveTab] Failed to start session:', err);
      addSystemMessage('Failed to start session: ' + err.message);
    }
  }

  async function stopSession() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    try {
      await fetch('/api/interactive/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } catch (err) {
      console.warn('[InteractiveTab] Stop session error:', err);
    }

    sessionId = null;
    isWaiting = false;
    currentAssistantEl = null;
    updateSessionUI();
    addSystemMessage('Session ended.');
  }

  /* ═══════════════════════════════════════════════════════
     Message Sending (SSE streaming)
     ═══════════════════════════════════════════════════════ */

  async function sendMessage(message) {
    if (!sessionId) {
      addSystemMessage('No active session. Start a session first.');
      return;
    }

    if (isWaiting) return;

    const input = document.getElementById('interactive-input');
    const sendBtn = document.getElementById('interactive-send');

    // Add user message to chat
    addUserMessage(message);

    // Clear input and disable
    if (input) {
      input.value = '';
      input.disabled = true;
    }
    if (sendBtn) sendBtn.disabled = true;
    isWaiting = true;

    // Create assistant message placeholder
    currentAssistantEl = addAssistantMessage('');

    abortController = new AbortController();

    try {
      const modelSelect = document.getElementById('interactive-model');
      const selectedModel = modelSelect?.value || undefined;
      const selectedProvider = modelSelect?.selectedOptions?.[0]?.dataset?.provider || undefined;
      const response = await fetch('/api/interactive/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId, model: selectedModel, provider: selectedProvider }),
        signal: abortController.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';
      let currentEventType = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim();
            continue;
          }

          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);
              const type = currentEventType || event.type || 'chunk';
              currentEventType = null;

              switch (type) {
                case 'interactive_thinking':
                  addThinkingIndicator(event.message || 'Thinking...');
                  break;

                case 'interactive_tool_call':
                  addToolCard(event.name || event.tool, event.args || event.arguments, null);
                  break;

                case 'interactive_tool_result':
                  updateLastToolCard(event.result || event.output);
                  break;

                case 'interactive_chunk':
                case 'chunk':
                case 'response_chunk':
                  accumulatedText += (event.text || event.chunk || event.content || '');
                  if (currentAssistantEl) {
                    updateAssistantMessage(currentAssistantEl, accumulatedText);
                  }
                  break;

                case 'interactive_complete':
                case 'complete':
                case 'result':
                  if (event.answer || event.text || event.content) {
                    accumulatedText = event.answer || event.text || event.content || accumulatedText;
                  }
                  if (currentAssistantEl) {
                    updateAssistantMessage(currentAssistantEl, accumulatedText);
                  }
                  break;

                case 'interactive_error':
                case 'error':
                  throw new Error(event.error || event.message || 'Unknown error');

                default:
                  // Unknown event type, try to handle gracefully
                  if (event.text || event.chunk || event.content) {
                    accumulatedText += (event.text || event.chunk || event.content || '');
                    if (currentAssistantEl) {
                      updateAssistantMessage(currentAssistantEl, accumulatedText);
                    }
                  }
                  break;
              }
            } catch (parseErr) {
              if (parseErr.message && !parseErr.message.includes('JSON')) {
                // Re-throw non-parse errors (like our explicit error throws)
                throw parseErr;
              }
              console.warn('[InteractiveTab] SSE parse error:', parseErr);
            }
          }

          // Reset event type on empty lines (event boundary)
          if (line.trim() === '') {
            currentEventType = null;
          }
        }
      }

      // If no text accumulated but stream completed, show a fallback
      if (!accumulatedText && currentAssistantEl) {
        updateAssistantMessage(currentAssistantEl, '(No response content)');
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        // User cancelled
        if (currentAssistantEl) {
          updateAssistantMessage(currentAssistantEl, '(Cancelled)');
        }
      } else {
        console.error('[InteractiveTab] Message failed:', err);
        if (currentAssistantEl) {
          currentAssistantEl.classList.add('interactive-msg-error');
          updateAssistantMessage(currentAssistantEl, 'Error: ' + escapeHtml(err.message));
        } else {
          addSystemMessage('Error: ' + err.message);
        }
      }
    } finally {
      isWaiting = false;
      currentAssistantEl = null;
      abortController = null;
      if (input) input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  }

  /* ═══════════════════════════════════════════════════════
     DOM Helpers
     ═══════════════════════════════════════════════════════ */

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getMessagesContainer() {
    return document.getElementById('interactive-messages');
  }

  function scrollToBottom() {
    const container = getMessagesContainer();
    if (container) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  function clearMessages() {
    const container = getMessagesContainer();
    if (container) container.innerHTML = '';
  }

  function addUserMessage(text) {
    const container = getMessagesContainer();
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'interactive-msg interactive-msg-user';
    div.textContent = text;
    container.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addAssistantMessage(text) {
    const container = getMessagesContainer();
    if (!container) return null;

    // Remove any thinking indicators
    container.querySelectorAll('.interactive-thinking').forEach(el => el.remove());

    const div = document.createElement('div');
    div.className = 'interactive-msg interactive-msg-assistant';
    div.innerHTML = renderContent(text);
    container.appendChild(div);
    scrollToBottom();
    return div;
  }

  function updateAssistantMessage(el, text) {
    if (!el) return;
    el.innerHTML = renderContent(text);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    const container = getMessagesContainer();
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'interactive-msg interactive-msg-system';
    div.textContent = text;
    container.appendChild(div);
    scrollToBottom();
  }

  function addThinkingIndicator(text) {
    const container = getMessagesContainer();
    if (!container) return;

    // Remove previous thinking indicators
    container.querySelectorAll('.interactive-thinking').forEach(el => el.remove());

    const div = document.createElement('div');
    div.className = 'interactive-thinking';
    div.textContent = text;
    container.appendChild(div);
    scrollToBottom();
  }

  function addToolCard(toolName, args, result) {
    const container = getMessagesContainer();
    if (!container) return;

    // Remove thinking indicators
    container.querySelectorAll('.interactive-thinking').forEach(el => el.remove());

    const div = document.createElement('div');
    div.className = 'interactive-tool-card';
    div.dataset.toolCard = 'pending';

    let argsPreview = '';
    if (args) {
      try {
        const argsObj = typeof args === 'string' ? JSON.parse(args) : args;
        const keys = Object.keys(argsObj);
        if (keys.length > 0) {
          argsPreview = ' ' + keys.slice(0, 3).map(k => {
            const v = String(argsObj[k]);
            return k + '=' + (v.length > 30 ? v.slice(0, 30) + '...' : v);
          }).join(', ');
        }
      } catch (e) {
        argsPreview = '';
      }
    }

    div.innerHTML = `<span class="tool-name">${escapeHtml(toolName)}</span>${escapeHtml(argsPreview)}`;

    if (result) {
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const preview = resultStr.length > 120 ? resultStr.slice(0, 120) + '...' : resultStr;
      div.innerHTML += `<div class="tool-result">${escapeHtml(preview)}</div>`;
      div.dataset.toolCard = 'done';
    }

    container.appendChild(div);
    scrollToBottom();
  }

  function updateLastToolCard(result) {
    const container = getMessagesContainer();
    if (!container) return;

    const cards = container.querySelectorAll('.interactive-tool-card[data-tool-card="pending"]');
    const lastCard = cards[cards.length - 1];
    if (!lastCard) return;

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    const preview = resultStr.length > 120 ? resultStr.slice(0, 120) + '...' : resultStr;

    let resultEl = lastCard.querySelector('.tool-result');
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'tool-result';
      lastCard.appendChild(resultEl);
    }
    resultEl.textContent = preview;
    lastCard.dataset.toolCard = 'done';
    scrollToBottom();
  }

  function renderContent(text) {
    if (!text) return '';
    // Simple markdown-like rendering: code blocks, inline code, paragraphs
    let html = escapeHtml(text);

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre>${code}</pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  /* ═══════════════════════════════════════════════════════
     UI State
     ═══════════════════════════════════════════════════════ */

  function updateSessionUI() {
    const sessionBtn = document.getElementById('interactive-session-btn');
    const statusEl = document.getElementById('interactive-status');
    const input = document.getElementById('interactive-input');
    const sendBtn = document.getElementById('interactive-send');

    if (sessionId) {
      if (sessionBtn) {
        sessionBtn.textContent = 'End Session';
        sessionBtn.classList.remove('ghost-btn');
        sessionBtn.classList.add('danger-btn');
      }
      if (statusEl) {
        statusEl.textContent = 'Session active';
        statusEl.style.color = 'var(--success)';
      }
      if (input) input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
    } else {
      if (sessionBtn) {
        sessionBtn.textContent = 'Start Session';
        sessionBtn.classList.remove('danger-btn');
        sessionBtn.classList.add('ghost-btn');
      }
      if (statusEl) {
        statusEl.textContent = 'No active session';
        statusEl.style.color = '';
      }
      if (input) input.disabled = true;
      if (sendBtn) sendBtn.disabled = true;
    }
  }

  function updateContextBar(context) {
    const bar = document.getElementById('interactive-context');
    if (!bar) return;

    if (!context && !currentBrainId) {
      bar.innerHTML = '<span>No brain selected</span>';
      return;
    }

    const brainName = context?.brainName || currentBrainId || 'Unknown';
    const cycle = context?.currentCycle ?? '-';
    const coherence = context?.coherence != null ? (context.coherence * 100).toFixed(0) + '%' : '-';
    const agents = context?.activeAgents ?? '-';

    bar.innerHTML = [
      `<span>Brain: <strong>${escapeHtml(brainName)}</strong></span>`,
      `<span>Cycle: ${escapeHtml(String(cycle))}</span>`,
      `<span>Coherence: ${escapeHtml(String(coherence))}</span>`,
      `<span>Agents: ${escapeHtml(String(agents))}</span>`
    ].join('');
  }

  /* ═══════════════════════════════════════════════════════
     Public API
     ═══════════════════════════════════════════════════════ */

  window.InteractiveTab = {
    init: init,
    destroy: destroy,
    setBrain(brainId) {
      currentBrainId = brainId;
      updateContextBar();
    }
  };
})();
