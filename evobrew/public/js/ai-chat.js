/**
 * AI Chat Module (CRITICAL)
 * Handles chat UI, SSE streaming, tool feedback
 */

import { getCurrentFile, getSelectedText } from './editor.js';
import { currentFolder, buildFileTreeContext } from './file-tree.js';
import { queueEdit } from './edit-queue.js';

// Conversation history is stored per-folder to avoid cross-directory bleed
// and to keep token usage bounded to the relevant workspace.
const HISTORY_STORAGE_PREFIX = 'cosmo.aiChat.history:';
const HISTORY_MAX_MESSAGES_PER_FOLDER = 60;
const HISTORY_MAX_CHARS_PER_MESSAGE = 8000;

let conversationHistoriesByFolder = new Map(); // folderKey -> [{role, content}]
let activeFolderKey = null;
let isProcessing = false;

function getFolderKeyFromPath(path) {
    if (!path) return '__NO_FOLDER__';
    return String(path);
}

function getActiveFolderKey() {
    return getFolderKeyFromPath(currentFolder);
}

function loadHistoryFromStorage(folderKey) {
    try {
        const raw = localStorage.getItem(HISTORY_STORAGE_PREFIX + encodeURIComponent(folderKey));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-HISTORY_MAX_MESSAGES_PER_FOLDER);
    } catch (e) {
        console.warn('Failed to load chat history:', e);
        return [];
    }
}

function saveHistoryToStorage(folderKey, history) {
    try {
        localStorage.setItem(
            HISTORY_STORAGE_PREFIX + encodeURIComponent(folderKey),
            JSON.stringify(history.slice(-HISTORY_MAX_MESSAGES_PER_FOLDER))
        );
    } catch (e) {
        // Storage quota/full shouldn't break chat.
        console.warn('Failed to save chat history:', e);
    }
}

function normalizeHistoryContent(content) {
    if (typeof content !== 'string') return '';
    if (content.length <= HISTORY_MAX_CHARS_PER_MESSAGE) return content;
    return content.slice(0, HISTORY_MAX_CHARS_PER_MESSAGE) + '\n\n[...truncated for history...]';
}

function getHistoryForFolder(folderKey) {
    if (!conversationHistoriesByFolder.has(folderKey)) {
        conversationHistoriesByFolder.set(folderKey, loadHistoryFromStorage(folderKey));
    }
    return conversationHistoriesByFolder.get(folderKey);
}

function setActiveFolder(folderKey) {
    activeFolderKey = folderKey;
    const history = getHistoryForFolder(folderKey);

    // Reset chat UI to reflect folder-specific conversation
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = '';

    if (!history.length) {
        // Minimal welcome message (same as initial state)
        const welcome = document.createElement('div');
        welcome.className = 'welcome-message';
        const noFolder = folderKey === '__NO_FOLDER__';
        welcome.innerHTML = noFolder
            ? `<h3>👋 AI Assistant</h3><p>Choose a working folder first, then open a file to ask questions or request edits.</p>`
            : `<h3>👋 AI Assistant Ready</h3><p>Open a file and ask questions, or request edits.</p>`;
        container.appendChild(welcome);
        return;
    }

    for (const msg of history) {
        addChatMessage(msg.role === 'user' ? 'user' : 'assistant', msg.content);
    }
}

/**
 * Initialize AI Chat
 */
export async function initializeAIChat() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    
    // Send button
    sendBtn.addEventListener('click', sendMessage);
    
    // Cmd/Ctrl + Enter to send
    input.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
    });

    // Folder-scoped history: switch active conversation when folder changes
    setActiveFolder(getActiveFolderKey());
    window.addEventListener('cosmo:folderChanged', (e) => {
        const newKey = getFolderKeyFromPath(e?.detail?.path);
        setActiveFolder(newKey);
    });
    
    console.log('✅ AI Chat initialized');
}

/**
 * Send message to AI
 */
async function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message || isProcessing) return;
    
    // Get current context
    const fileInfo = getCurrentFile();
    const selectedText = getSelectedText();
    const model = document.getElementById('model-select').value;
    
    // Add user message to chat
    addChatMessage('user', message);
    
    // Clear input
    input.value = '';
    
    // Set processing
    isProcessing = true;
    document.getElementById('chat-send-btn').disabled = true;
    updateStatus('AI thinking...');
    
    // Create streaming message
    const streamingId = `msg-${Date.now()}`;
    const streamingMsg = addChatMessage('assistant', '', { streaming: true, id: streamingId });
    
    try {
        const folderKey = activeFolderKey || getActiveFolderKey();
        const historyForFolder = getHistoryForFolder(folderKey);

        // Build request
        const requestBody = {
            message,
            currentFolder,
            model,
            documentContent: fileInfo?.content || '',
            selectedText,
            fileName: fileInfo?.name || 'untitled',
            language: fileInfo?.language || 'text',
            fileTreeContext: buildFileTreeContext(),
            // Only send history for the current folder
            conversationHistory: historyForFolder.slice(-12),
            stream: true
        };
        
        // Fetch with SSE
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        let fullResponse = '';
        let toolFeedbackMsg = null;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(line.slice(6));
                        
                        // DEBUG: Log ALL events
                        console.log('[SSE RECEIVED]', event.type, event);
                        
                        // Handle different event types
                        if (event.type === 'error') {
                            throw new Error(event.error);
                        }
                        
                        else if (event.type === 'iteration') {
                            console.log(`[AI] Iteration ${event.iteration}/${event.max}`);
                            updateStatus(`AI thinking (iteration ${event.iteration}/${event.max})...`);
                        }
                        
                        else if (event.type === 'thinking') {
                            // NEW: Show AI's reasoning/thinking
                            addChatMessage('system', `💭 ${event.content}`, { 
                                cssClass: 'thinking-message',
                                persistent: true 
                            });
                        }
                        
                        else if (event.type === 'tools_start') {
                            // Show tool feedback
                            const toolNames = event.tools.map(t => t.name).join(', ');
                            const feedback = `🔧 Using ${event.tools.length} tool(s): ${toolNames}`;
                            
                            if (toolFeedbackMsg) {
                                updateChatMessage(toolFeedbackMsg, feedback);
                            } else {
                                toolFeedbackMsg = addChatMessage('system', feedback, { temp: true });
                            }
                        }
                        
                        else if (event.type === 'tool_start') {
                            // Update feedback with current tool
                            const icon = getToolIcon(event.tool);
                            const argStr = getToolArgString(event.args);
                            const feedback = `${icon} ${event.tool}: ${argStr}`;
                            
                            if (toolFeedbackMsg) {
                                updateChatMessage(toolFeedbackMsg, feedback);
                            }
                            
                            updateStatus(`Running: ${event.tool}...`);
                        }
                        
                        else if (event.type === 'tool_complete') {
                            console.log(`[AI] ✓ ${event.tool}`);
                        }
                        
                        else if (event.type === 'tool_result') {
                            // NEW: Show tool execution results
                            console.log('[FRONTEND] tool_result event received:', event);
                            const icon = getToolIcon(event.tool);
                            const statusIcon = event.success ? '✓' : '✗';
                            const message = `${icon} ${statusIcon} ${event.summary}`;
                            console.log('[FRONTEND] Adding tool result message:', message);
                            addChatMessage('system', message, {
                                cssClass: 'tool-result',
                                persistent: true
                            });
                        }
                        
                        else if (event.type === 'response_chunk') {
                            // Remove tool feedback, start streaming response
                            if (toolFeedbackMsg) {
                                removeChatMessage(toolFeedbackMsg);
                                toolFeedbackMsg = null;
                            }
                            
                            fullResponse += event.chunk;
                            updateChatMessage(streamingMsg, fullResponse);
                            updateStatus('AI responding...');
                        }
                        
                        else if (event.type === 'complete') {
                            // Done!
                            if (toolFeedbackMsg) {
                                removeChatMessage(toolFeedbackMsg);
                            }
                            
                            fullResponse = event.fullResponse || fullResponse;
                            updateChatMessage(streamingMsg, fullResponse, { streaming: false });
                            
                            // Handle pending edits
                            console.log('[FRONTEND] Complete event received:', { 
                                hasPendingEdits: !!event.pendingEdits, 
                                count: event.pendingEdits?.length,
                                edits: event.pendingEdits
                            });
                            
                            if (event.pendingEdits && event.pendingEdits.length > 0) {
                                console.log(`[AI] ${event.pendingEdits.length} edit(s) pending`);
                                
                                for (const edit of event.pendingEdits) {
                                    console.log('[FRONTEND] Queueing edit:', { file: edit.file, instructions: edit.instructions, hasEdit: !!edit.edit });
                                    queueEdit(edit.file, edit.instructions, edit.edit);
                                }
                                
                                // Show notification
                                const count = event.pendingEdits.length;
                                addChatMessage('system', `✅ ${count} edit${count > 1 ? 's' : ''} added to queue for review`);
                            } else {
                                console.log('[FRONTEND] No pending edits in complete event');
                            }
                            
                            // Add to conversation history
                            const folderKey = activeFolderKey || getActiveFolderKey();
                            const history = getHistoryForFolder(folderKey);
                            history.push(
                                { role: 'user', content: normalizeHistoryContent(message) },
                                { role: 'assistant', content: normalizeHistoryContent(fullResponse) }
                            );
                            // Cap and persist
                            const capped = history.slice(-HISTORY_MAX_MESSAGES_PER_FOLDER);
                            conversationHistoriesByFolder.set(folderKey, capped);
                            saveHistoryToStorage(folderKey, capped);
                            
                            updateStatus(`✓ Complete (${event.iterations} iterations, ${event.tokensUsed} tokens)`);
                        }
                        
                    } catch (e) {
                        console.error('Failed to parse SSE event:', e);
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('AI chat error:', error);
        removeChatMessage(streamingMsg);
        addChatMessage('error', `Error: ${error.message}`);
        updateStatus('Error');
        
    } finally {
        isProcessing = false;
        document.getElementById('chat-send-btn').disabled = false;
        updateStatus('AI Ready');
    }
}

/**
 * Add message to chat
 */
function addChatMessage(type, content, options = {}) {
    const container = document.getElementById('chat-messages');
    
    // Remove welcome message if exists
    const welcome = container.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    
    const msg = document.createElement('div');
    msg.className = `chat-message ${type}`;
    
    // NEW: Support custom CSS class (backward compatible)
    if (options.cssClass) {
        msg.classList.add(options.cssClass);
    }
    
    if (options.id) {
        msg.id = options.id;
    }
    
    if (options.temp) {
        msg.classList.add('temp');
    }
    
    // NEW: Support persistent messages (backward compatible)
    if (options.persistent) {
        msg.classList.add('persistent');
    }
    
    const header = type === 'user' ? 'You' :
                   type === 'assistant' ? 'AI Assistant' :
                   type === 'system' ? 'System' :
                   type === 'error' ? 'Error' : '';
    
    // Render assistant messages with markdown, escape others for safety
    const renderedContent = type === 'assistant' 
        ? renderMarkdownSafe(content)
        : escapeHtml(content);
    
    msg.innerHTML = `
        <div class="message-header">${header}</div>
        <div class="message-content">${renderedContent}</div>
    `;
    
    if (options.streaming) {
        msg.querySelector('.message-content').innerHTML += '<span class="cursor">▋</span>';
    }
    
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    
    return msg;
}

/**
 * Update chat message
 */
function updateChatMessage(msgElement, content, options = {}) {
    if (!msgElement) return;
    
    const contentDiv = msgElement.querySelector('.message-content');
    
    // Check if this is an assistant message by looking at parent class
    const isAssistant = msgElement.classList.contains('assistant');
    
    // Render markdown for assistant messages, escape for others
    if (isAssistant && window.marked) {
        contentDiv.innerHTML = renderMarkdownSafe(content);
    } else {
        contentDiv.textContent = content;
    }
    
    if (options.streaming === false) {
        const cursor = contentDiv.querySelector('.cursor');
        if (cursor) cursor.remove();
    } else if (options.streaming) {
        contentDiv.innerHTML += '<span class="cursor">▋</span>';
    }
}

/**
 * Remove chat message
 */
function removeChatMessage(msgElement) {
    if (msgElement && msgElement.parentNode) {
        msgElement.remove();
    }
}

/**
 * Update status bar
 */
function updateStatus(text) {
    document.getElementById('status-ai').textContent = text;
}

/**
 * Get tool icon
 */
function getToolIcon(toolName) {
    const icons = {
        'file_read': '📖',
        'read_image': '🖼️',
        'create_image': '🎨',
        'edit_image': '✏️',
        'list_directory': '📁',
        'grep_search': '🔍',
        'codebase_search': '🧠',
        'edit_file': '✏️',
        'edit_file_range': '✂️',
        'search_replace': '🔄',
        'insert_lines': '➕',
        'delete_lines': '➖',
        'create_file': '📝',
        'create_docx': '📄',
        'create_xlsx': '📊',
        'run_terminal': '💻',
        'terminal_open': '💻',
        'terminal_write': '💻',
        'terminal_wait': '💻',
        'terminal_resize': '💻',
        'terminal_close': '💻',
        'terminal_list': '💻',
        'delete_file': '🗑️'
    };
    return icons[toolName] || '🔧';
}

/**
 * Get tool argument string
 */
function getToolArgString(args) {
    // File operations
    if (args.file_path) {
        // Show line info for range operations
        if (args.start_line && args.end_line) {
            return `${args.file_path} (lines ${args.start_line}-${args.end_line})`;
        }
        if (args.line_number) {
            return `${args.file_path} (line ${args.line_number})`;
        }
        return args.file_path;
    }
    
    // Directory operations
    if (args.directory_path) return args.directory_path;
    
    // Search operations
    if (args.query) return args.query;
    if (args.pattern) return args.pattern;
    
    // Terminal operations
    if (args.command) return args.command;
    
    // Fallback
    return JSON.stringify(args).substring(0, 50);
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function sanitizeRenderedHtml(html) {
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
        return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return escapeHtml(String(html || ''));
}

function renderMarkdownSafe(markdown) {
    if (window.marked) {
        return sanitizeRenderedHtml(marked.parse(markdown || ''));
    }
    return escapeHtml(markdown || '');
}
