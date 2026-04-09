/**
 * File Tree Module
 * Handles folder picker, file tree rendering, file operations
 */

import { openFile } from './editor.js';

let currentFolder = null;
let fileTree = [];

/**
 * Initialize File Tree
 */
export async function initializeFileTree() {
    // Folder picker button
    document.getElementById('pick-folder-btn').addEventListener('click', showFolderPicker);
    
    // Check if path in URL
    const params = new URLSearchParams(window.location.search);
    const path = params.get('path');
    
    if (path) {
        await loadFolder(path);
    } else {
        showFolderPicker();
    }
    
    console.log('✅ File Tree initialized');
}

/**
 * Go up one directory level
 */
export async function goUpDirectory() {
    if (!currentFolder || currentFolder === '/') return;

    const parentPath = currentFolder.split('/').slice(0, -1).join('/') || '/';
    await loadFolder(parentPath);
}

/**
 * Show folder picker modal (exported for global use)
 */
export function showFolderPicker() {
    const modal = document.getElementById('folder-picker-modal');
    modal.classList.remove('hidden');
    
    // Start browsing from home
    const home = '/Users';
    browseFolders(home);
    
    // Close button
    document.getElementById('close-folder-picker').onclick = () => {
        modal.classList.add('hidden');
    };
}

/**
 * Browse folders for picker
 */
async function browseFolders(path) {
    try {
        const response = await fetch(`/api/folder/browse?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error);
        }
        
        const browser = document.getElementById('folder-browser');
        browser.innerHTML = `
            <div class="folder-path">
                <strong>Current:</strong> ${path}
                <button class="btn-primary select-folder-btn" data-path="${path}">
                    ✓ Select This Folder
                </button>
            </div>
            <div class="folder-list"></div>
        `;
        
        const folderList = browser.querySelector('.folder-list');
        
        // Parent folder
        if (path !== '/') {
            const parent = path.split('/').slice(0, -1).join('/') || '/';
            const item = createBrowserItem('..', parent, true, true);
            folderList.appendChild(item);
        }
        
        // Directories only
        const dirs = data.files.filter(f => f.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
        
        dirs.forEach(file => {
            const item = createBrowserItem(file.name, file.path, true, false);
            folderList.appendChild(item);
        });
        
        // Select folder button
        browser.querySelector('.select-folder-btn').onclick = async () => {
            await loadFolder(path);
            document.getElementById('folder-picker-modal').classList.add('hidden');
        };
        
    } catch (error) {
        console.error('Failed to browse:', error);
        alert(`Failed to browse: ${error.message}`);
    }
}

/**
 * Create browser item
 */
function createBrowserItem(name, path, isDir, isParent) {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.innerHTML = `
        <span class="folder-icon">${isParent ? '⬆️' : '📁'}</span>
        <span class="folder-name">${name}</span>
    `;
    
    if (isDir) {
        item.onclick = () => browseFolders(path);
    }
    
    return item;
}

/**
 * Load folder into file tree
 */
async function loadFolder(path) {
    try {
        currentFolder = path;

        // Update status bar
        document.getElementById('status-folder').textContent = path;

        // Update sidebar path display
        const sidebarPath = document.getElementById('sidebar-path');
        if (sidebarPath) {
            sidebarPath.textContent = path;
            sidebarPath.title = `${path}\n(Click to change folder)`;
        }

        // Update go-up button state
        const goUpBtn = document.getElementById('go-up-btn');
        if (goUpBtn) {
            goUpBtn.style.opacity = path === '/' ? '0.3' : '1';
            goUpBtn.style.pointerEvents = path === '/' ? 'none' : 'auto';
        }
        
        // Load files recursively
        fileTree = await loadFolderRecursive(path);
        
        // Render tree
        renderFileTree();
        
        // Update URL
        window.history.replaceState({}, '', `?path=${encodeURIComponent(path)}`);

        // Notify other modules (e.g., AI chat) that folder changed
        window.dispatchEvent(new CustomEvent('cosmo:folderChanged', { detail: { path } }));
        
        console.log(`📁 Loaded folder: ${path}`);
        
    } catch (error) {
        console.error('Failed to load folder:', error);
        alert(`Failed to load folder: ${error.message}`);
    }
}

/**
 * Load folder recursively (limited depth)
 */
async function loadFolderRecursive(path, depth = 0) {
    if (depth > 2) return []; // Limit depth
    
    try {
        const response = await fetch(`/api/folder/browse?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        
        if (!data.success) return [];
        
        const items = [];
        
        for (const file of data.files) {
            const item = {
                name: file.name,
                path: file.path,
                isDirectory: file.isDirectory,
                children: []
            };
            
            if (file.isDirectory && depth < 2) {
                item.children = await loadFolderRecursive(file.path, depth + 1);
            }
            
            items.push(item);
        }
        
        return items.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
        
    } catch (error) {
        console.error(`Failed to load ${path}:`, error);
        return [];
    }
}

/**
 * Render file tree
 */
function renderFileTree() {
    const container = document.getElementById('file-tree');
    container.innerHTML = '';
    
    fileTree.forEach(item => {
        const element = createTreeItem(item, 0);
        container.appendChild(element);
    });
}

/**
 * Create tree item element
 */
function createTreeItem(item, depth) {
    const wrapper = document.createElement('div');
    
    const div = document.createElement('div');
    div.className = 'tree-item';
    div.style.paddingLeft = `${depth * 16 + 16}px`;
    
    if (item.isDirectory) {
        div.innerHTML = `
            <span class="tree-icon">📁</span>
            <span class="tree-name">${item.name}</span>
        `;
        
        div.onclick = (e) => {
            e.stopPropagation();
            toggleFolder(wrapper, item);
        };
        
        // Add children container as sibling, not child
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children hidden';
        
        item.children.forEach(child => {
            const childElement = createTreeItem(child, depth + 1);
            childrenContainer.appendChild(childElement);
        });
        
        wrapper.appendChild(div);
        wrapper.appendChild(childrenContainer);
        
    } else {
        // Get appropriate icon for file type
        const icon = getFileIconForTree(item.name);
        
        div.innerHTML = `
            <span class="tree-icon">${icon}</span>
            <span class="tree-name">${item.name}</span>
        `;
        
        div.onclick = () => {
            openFile(item.path);
        };
        
        wrapper.appendChild(div);
    }
    
    return wrapper;
}

/**
 * Get file icon based on extension
 */
function getFileIconForTree(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        // Office Documents
        'docx': '📄', 'doc': '📄',
        'xlsx': '📊', 'xls': '📊',
        'pptx': '📽️', 'ppt': '📽️',
        'msg': '📧',
        
        // Code Files
        'js': '📜', 'jsx': '⚛️',
        'ts': '📘', 'tsx': '⚛️',
        'py': '🐍', 'java': '☕',
        'cpp': '⚙️', 'c': '⚙️', 'h': '⚙️',
        'cs': '#️⃣', 'go': '🔷', 'rs': '🦀',
        'php': '🐘', 'rb': '💎',
        
        // Web
        'html': '🌐', 'htm': '🌐',
        'css': '🎨', 'scss': '🎨', 'sass': '🎨',
        'vue': '💚',
        
        // Data
        'json': '📋', 'xml': '📋',
        'yaml': '📋', 'yml': '📋',
        'csv': '📊', 'sql': '🗄️',
        
        // Documentation
        'md': '📝', 'markdown': '📝',
        'txt': '📄', 'pdf': '📕',
        
        // Images
        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️',
        'gif': '🖼️', 'svg': '🎨', 'webp': '🖼️',
        
        // Config
        'env': '⚙️', 'config': '⚙️', 'ini': '⚙️',
        
        // Archives
        'zip': '📦', 'tar': '📦', 'gz': '📦',
        
        // Other
        'sh': '⚡', 'bash': '⚡', 'log': '📜', 'lock': '🔒'
    };
    return iconMap[ext] || '📄';
}

/**
 * Toggle folder open/closed
 */
function toggleFolder(wrapper, item) {
    const children = wrapper.querySelector('.tree-children');
    if (!children) return;
    
    const isOpen = !children.classList.contains('hidden');
    const icon = wrapper.querySelector('.tree-icon');
    
    if (isOpen) {
        children.classList.add('hidden');
        icon.textContent = '📁';
    } else {
        children.classList.remove('hidden');
        icon.textContent = '📂';
    }
}

/**
 * Build file tree context for AI
 */
export function buildFileTreeContext() {
    if (!fileTree || fileTree.length === 0) return '';
    
    let context = '';
    const maxItems = 100;
    let count = 0;
    
    function buildTree(items, depth = 0) {
        for (const item of items) {
            if (count >= maxItems) {
                context += `${'  '.repeat(depth)}... (truncated at ${maxItems} items)\n`;
                return;
            }
            
            const indent = '  '.repeat(depth);
            const icon = item.isDirectory ? '📁' : '📄';
            context += `${indent}${icon} ${item.name}\n`;
            count++;
            
            if (item.isDirectory && item.children && depth < 2) {
                buildTree(item.children, depth + 1);
            }
        }
    }
    
    buildTree(fileTree);
    return context;
}

// Export
export { currentFolder, fileTree };

