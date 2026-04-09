/**
 * Monaco Editor Module
 * Handles editor initialization, file management, tabs
 */

let editor = null;
let openFiles = new Map(); // path -> { model, viewState }
let activeFile = null;

/**
 * Initialize Monaco Editor
 */
export async function initializeEditor() {
    return new Promise((resolve, reject) => {
        require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
        
        require(['vs/editor/editor.main'], () => {
            editor = monaco.editor.create(document.getElementById('editor-container'), {
                value: '// Select a file or pick a folder to start coding\n',
                language: 'javascript',
                theme: 'vs-dark',
                automaticLayout: true,
                fontSize: 14,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                wordWrap: 'on'
            });
            
            console.log('✅ Monaco Editor initialized');
            resolve();
        });
    });
}

/**
 * Open a file in the editor
 */
export async function openFile(filePath) {
    try {
        // Check if already open
        if (openFiles.has(filePath)) {
            switchToFile(filePath);
            return;
        }
        
        // Read file content
        const response = await fetch(`/api/folder/read?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to read file');
        }
        
        // Determine language
        const ext = filePath.split('.').pop();
        const language = getLanguageFromExtension(ext);
        
        // Create Monaco model
        const model = monaco.editor.createModel(data.content, language);
        
        // Store file info
        openFiles.set(filePath, {
            model,
            viewState: null,
            dirty: false
        });
        
        // Switch to this file
        switchToFile(filePath);
        
        // Add tab
        addTab(filePath);
        
        // Listen for changes
        model.onDidChangeContent(() => {
            markFileDirty(filePath);
        });
        
        console.log(`📄 Opened: ${filePath}`);
        
    } catch (error) {
        console.error('Failed to open file:', error);
        alert(`Failed to open file: ${error.message}`);
    }
}

/**
 * Switch to an already open file
 */
function switchToFile(filePath) {
    if (!openFiles.has(filePath)) return;
    
    // Save current view state
    if (activeFile && openFiles.has(activeFile)) {
        openFiles.get(activeFile).viewState = editor.saveViewState();
    }
    
    // Switch model
    const fileData = openFiles.get(filePath);
    editor.setModel(fileData.model);
    
    // Restore view state
    if (fileData.viewState) {
        editor.restoreViewState(fileData.viewState);
    }
    
    activeFile = filePath;
    
    // Update active tab
    updateActiveTab(filePath);
    
    editor.focus();
}

/**
 * Close a file
 */
export function closeFile(filePath) {
    if (!openFiles.has(filePath)) return;
    
    const fileData = openFiles.get(filePath);
    
    // Check if dirty
    if (fileData.dirty) {
        if (!confirm(`${filePath.split('/').pop()} has unsaved changes. Close anyway?`)) {
            return;
        }
    }
    
    // Dispose model
    fileData.model.dispose();
    
    // Remove from open files
    openFiles.delete(filePath);
    
    // Remove tab
    removeTab(filePath);
    
    // If this was active file, switch to another or show welcome
    if (activeFile === filePath) {
        const remaining = Array.from(openFiles.keys());
        if (remaining.length > 0) {
            switchToFile(remaining[0]);
        } else {
            activeFile = null;
            editor.setModel(null);
        }
    }
}

/**
 * Save current file
 */
export async function saveCurrentFile() {
    if (!activeFile) return;
    
    try {
        const fileData = openFiles.get(activeFile);
        const content = fileData.model.getValue();
        
        const response = await fetch('/api/folder/write', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: activeFile, content })
        });
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Save failed');
        }
        
        // Mark as clean
        fileData.dirty = false;
        updateTabDirtyState(activeFile, false);
        
        console.log(`💾 Saved: ${activeFile}`);
        
    } catch (error) {
        console.error('Failed to save:', error);
        alert(`Failed to save: ${error.message}`);
    }
}

/**
 * Mark file as dirty (modified)
 */
function markFileDirty(filePath) {
    if (!openFiles.has(filePath)) return;
    
    const fileData = openFiles.get(filePath);
    if (!fileData.dirty) {
        fileData.dirty = true;
        updateTabDirtyState(filePath, true);
    }
}

/**
 * Get current file info
 */
export function getCurrentFile() {
    if (!activeFile) return null;
    
    const fileData = openFiles.get(activeFile);
    return {
        path: activeFile,
        name: activeFile.split('/').pop(),
        content: fileData.model.getValue(),
        language: fileData.model.getLanguageId(),
        selection: editor.getSelection()
    };
}

/**
 * Get selected text
 */
export function getSelectedText() {
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return null;
    return editor.getModel().getValueInRange(selection);
}

/**
 * Get language from file extension
 */
function getLanguageFromExtension(ext) {
    const map = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'py': 'python',
        'rs': 'rust',
        'go': 'go',
        'java': 'java',
        'cpp': 'cpp',
        'c': 'c',
        'html': 'html',
        'css': 'css',
        'json': 'json',
        'md': 'markdown',
        'yaml': 'yaml',
        'yml': 'yaml',
        'sh': 'shell',
        'sql': 'sql'
    };
    return map[ext] || 'plaintext';
}

/**
 * Tab Management
 */

function addTab(filePath) {
    const tabBar = document.getElementById('tab-bar');
    const fileName = filePath.split('/').pop();
    
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.path = filePath;
    tab.innerHTML = `
        <span class="tab-name">${fileName}</span>
        <span class="tab-close" data-path="${filePath}">×</span>
    `;
    
    tab.querySelector('.tab-name').addEventListener('click', () => {
        switchToFile(filePath);
    });
    
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeFile(filePath);
    });
    
    tabBar.appendChild(tab);
    updateActiveTab(filePath);
}

function removeTab(filePath) {
    const tab = document.querySelector(`.tab[data-path="${filePath}"]`);
    if (tab) tab.remove();
}

function updateActiveTab(filePath) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.path === filePath);
    });
}

function updateTabDirtyState(filePath, dirty) {
    const tab = document.querySelector(`.tab[data-path="${filePath}"]`);
    if (tab) {
        const nameSpan = tab.querySelector('.tab-name');
        const fileName = filePath.split('/').pop();
        nameSpan.textContent = dirty ? `● ${fileName}` : fileName;
    }
}

/**
 * Keyboard shortcuts
 */
document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + S = Save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentFile();
    }
    
    // Cmd/Ctrl + W = Close tab
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (activeFile) closeFile(activeFile);
    }
});

// Export for other modules
export { editor, openFiles, activeFile };

