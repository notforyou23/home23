/**
 * Files Tab
 * Browse brain outputs with file viewer and AI assistant
 */

let fileTree = null;
let openFiles = [];
let activeFile = null;

function initFilesTab() {
  const panel = document.getElementById('files-panel');
  
  // EXACT COSMO IDE v2 structure
  panel.innerHTML = `
    <div class="files-layout">
      <!-- Sidebar: File Tree (COSMO IDE pattern) -->
      <aside class="files-sidebar">
        <div class="sidebar-header">
          <span>BRAIN OUTPUTS</span>
        </div>
        <div class="file-tree" id="fileTree"></div>
      </aside>

      <!-- Center: File Viewer with Tabs (COSMO IDE pattern) -->
      <div class="files-main">
        <div class="tabs-bar" id="fileTabs"></div>
        <div class="file-content" id="fileContent">
          <div class="empty-state">
            <div class="empty-icon">📄</div>
            <div>Select a file to view</div>
          </div>
        </div>
      </div>

      <!-- Right: AI Assistant (COSMO IDE pattern - hidden by default) -->
      <aside class="files-ai hidden" id="filesAI">
        <div class="ai-header">
          <span>🤖 AI Assistant</span>
          <div>
            <button onclick="toggleFilesAI()" style="background: none; border: none; color: var(--text-primary); cursor: pointer; font-size: 18px;">×</button>
          </div>
        </div>
        
        <div class="ai-quick-actions">
          <div class="ai-quick-actions-title">🤖 Model</div>
          <select id="filesAIModel" class="ai-quick-action-btn" style="cursor: pointer; padding: 6px 12px; width: 100%;">
            <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (Default - Fast)</option>
            <option value="claude-opus-4-5">Claude Opus 4.5 (Most Capable)</option>
            <option value="gpt-5.2">GPT-5.2</option>
          </select>
        </div>
        
        <div class="ai-chat-messages" id="filesAIMessages">
          <div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 12px;">
            👋 Hi! I'm your AI assistant.<br>
            Ask me to help with files in this brain!
          </div>
        </div>
        
        <div class="ai-input-container">
          <textarea 
            id="filesAIInput" 
            class="ai-input" 
            placeholder="Ask AI about files..."
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendFileMessage();}"
          ></textarea>
          <button id="filesAISendBtn" class="ai-send-btn" onclick="sendFileMessage()">
            Send (Enter)
          </button>
        </div>
      </aside>
    </div>
    
    <!-- Toggle AI Button (top right) -->
    <button class="toggle-ai-btn" onclick="toggleFilesAI()" title="Toggle AI Assistant">
      🤖
    </button>
  `;

  loadFileTree();
}

function toggleFilesAI() {
  const aiPanel = document.getElementById('filesAI');
  aiPanel.classList.toggle('hidden');
}

async function loadFileTree() {
  const tree = await fetch('/api/tree').then(r => r.json());
  fileTree = tree;
  renderFileTree(tree, document.getElementById('fileTree'));
}

function renderFileTree(node, container, depth = 0) {
  if (!node.isDirectory) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = (depth * 16 + 12) + 'px';
    item.innerHTML = `
      <span class="file-icon">${getFileIcon(node.name)}</span>
      <span class="file-name">${node.name}</span>
      <span class="file-size">${formatBytes(node.size)}</span>
    `;
    item.onclick = () => openFile(node.path, node.name);
    container.appendChild(item);
    return;
  }

  const wrapper = document.createElement('div');
  const item = document.createElement('div');
  item.className = 'tree-item folder';
  item.style.paddingLeft = (depth * 16 + 12) + 'px';
  item.innerHTML = `<span class="folder-icon">📁</span><span class="folder-name">${node.name}</span>`;
  
  const children = document.createElement('div');
  children.className = 'tree-children collapsed'; // START COLLAPSED
  
  item.onclick = () => {
    children.classList.toggle('collapsed');
    item.querySelector('.folder-icon').textContent = children.classList.contains('collapsed') ? '📁' : '📂';
  };
  
  (node.children || []).forEach(child => renderFileTree(child, children, depth + 1));
  
  wrapper.appendChild(item);
  wrapper.appendChild(children);
  container.appendChild(wrapper);
}

async function openFile(filePath, fileName) {
  const content = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`).then(r => r.text());
  
  activeFile = { path: filePath, name: fileName, content };
  
  if (!openFiles.find(f => f.path === filePath)) {
    openFiles.push(activeFile);
  }
  
  renderFileTabs();
  renderFileContent(activeFile);
}

function renderFileTabs() {
  const container = document.getElementById('fileTabs');
  container.innerHTML = openFiles.map((file, i) => `
    <div class="file-tab ${file === activeFile ? 'active' : ''}" onclick="switchToFile(${i})">
      <span>${getFileIcon(file.name)}</span>
      <span>${file.name}</span>
      <span class="tab-close" onclick="event.stopPropagation(); closeFileTab(${i})">×</span>
    </div>
  `).join('');
}

function switchToFile(index) {
  activeFile = openFiles[index];
  renderFileTabs();
  renderFileContent(activeFile);
}

function closeFileTab(index) {
  openFiles.splice(index, 1);
  if (activeFile === openFiles[index]) {
    activeFile = openFiles[Math.max(0, index - 1)] || null;
  }
  renderFileTabs();
  if (activeFile) renderFileContent(activeFile);
  else document.getElementById('fileContent').innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><div>Select a file</div></div>';
}

function renderFileContent(file) {
  const container = document.getElementById('fileContent');
  const isMarkdown = file.name.endsWith('.md');
  
  if (isMarkdown) {
    container.innerHTML = `<div class="markdown-content">${marked.parse(file.content)}</div>`;
  } else {
    container.innerHTML = `<pre class="code-content">${escapeHtml(file.content)}</pre>`;
  }
}

// AI Chat State
let aiConversationHistory = [];
let aiProcessing = false;

async function sendFileMessage() {
  const input = document.getElementById('filesAIInput');
  const message = input.value.trim();
  if (!message || aiProcessing) return;

  const messagesContainer = document.getElementById('filesAIMessages');
  
  // Add user message
  addAIMessage('user', message);
  input.value = '';
  
  // Get current file context if any
  const fileContext = activeFile ? {
    fileName: activeFile.name,
    content: activeFile.content,
    path: activeFile.path
  } : null;
  
  aiProcessing = true;
  
  // Add streaming placeholder
  const streamingId = `streaming-${Date.now()}`;
  addAIMessage('assistant', '', { streaming: true, messageId: streamingId });
  
  try {
    // Build conversation history
    aiConversationHistory.push({ role: 'user', content: message });
    
    // Get selected model (COSMO IDE pattern - Claude Sonnet 4.5 default)
    const selectedModel = document.getElementById('filesAIModel')?.value || 'claude-sonnet-4-5';
    
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        messages: aiConversationHistory,
        model: selectedModel, // Use selected model (Claude/GPT-5, NEVER gpt-4o)
        fileName: fileContext?.fileName,
        documentContent: fileContext?.content || '',
        currentFolder: '.',
        stream: true
      })
    });
    
    // Handle SSE streaming
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      buffer += chunk;
      
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        
        const dataStr = line.substring(6);
        if (dataStr === '[DONE]') continue;
        
        try {
          const data = JSON.parse(dataStr);
          
          if (data.type === 'content') {
            fullResponse += data.content;
            updateStreamingMessage(streamingId, fullResponse);
          } else if (data.type === 'tool_call') {
            addToolCallMessage(data);
          } else if (data.type === 'tool_result') {
            addToolResultMessage(data);
          } else if (data.type === 'done') {
            aiConversationHistory.push({ role: 'assistant', content: fullResponse });
            finalizeStreamingMessage(streamingId, fullResponse);
          }
        } catch (e) {
          console.error('[AI STREAM] Parse error:', e);
        }
      }
    }
    
  } catch (error) {
    console.error('[AI CHAT] Error:', error);
    addAIMessage('assistant', `❌ Error: ${error.message}`);
  }
  
  aiProcessing = false;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function addAIMessage(role, content, options = {}) {
  const container = document.getElementById('filesAIMessages');
  const msgDiv = document.createElement('div');
  msgDiv.className = `ai-message ${role}`;
  
  if (options.messageId) {
    msgDiv.id = options.messageId;
  }
  
  if (options.streaming) {
    msgDiv.innerHTML = '<div class="ai-message-content"><span class="cursor-blink">▋</span></div>';
  } else {
    msgDiv.innerHTML = `<div class="ai-message-content">${marked.parse(content)}</div>`;
  }
  
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function updateStreamingMessage(messageId, content) {
  const msgDiv = document.getElementById(messageId);
  if (msgDiv) {
    msgDiv.querySelector('.ai-message-content').innerHTML = marked.parse(content) + '<span class="cursor-blink">▋</span>';
  }
}

function finalizeStreamingMessage(messageId, content) {
  const msgDiv = document.getElementById(messageId);
  if (msgDiv) {
    msgDiv.querySelector('.ai-message-content').innerHTML = marked.parse(content);
  }
}

function addToolCallMessage(data) {
  const container = document.getElementById('filesAIMessages');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'ai-message tool-call';
  msgDiv.innerHTML = `<div class="tool-call-content">🔧 ${data.name}(${Object.keys(data.arguments || {}).join(', ')})</div>`;
  container.appendChild(msgDiv);
}

function addToolResultMessage(data) {
  const container = document.getElementById('filesAIMessages');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'ai-message tool-result';
  msgDiv.innerHTML = `<div class="tool-result-content">✅ ${data.name} completed</div>`;
  container.appendChild(msgDiv);
}

function getFileIcon(name) {
  const ext = name.split('.').pop();
  const icons = {
    md: '📝', txt: '📄', json: '📋', py: '🐍', 
    js: '📜', html: '🌐', css: '🎨', csv: '📊'
  };
  return icons[ext] || '📄';
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

