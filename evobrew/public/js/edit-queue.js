/**
 * Edit Queue Module
 * Handles surgical edits, diff preview, accept/reject
 */

import { editor, openFiles, activeFile } from './editor.js';

let editQueue = [];

/**
 * Initialize Edit Queue
 */
export async function initializeEditQueue() {
    // Close button
    document.getElementById('close-edit-queue').addEventListener('click', hideEditQueue);
    
    // Accept/Reject all
    document.getElementById('accept-all-edits').addEventListener('click', acceptAllEdits);
    document.getElementById('reject-all-edits').addEventListener('click', rejectAllEdits);
    
    // Click on status to show queue
    document.getElementById('status-edits').addEventListener('click', showEditQueue);
    
    console.log('✅ Edit Queue initialized');
}

/**
 * Queue an edit for review
 */
export async function queueEdit(filePath, instructions, surgicalEdit) {
    try {
        // Read current file content
        const response = await fetch(`/api/folder/read?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to read file');
        }
        
        const originalContent = data.content;
        
        // Apply surgical edit to get modified content
        // Direct replacement (no surgical parsing)
        const modifiedContent = surgicalEdit;
        
        // Add to queue
        const edit = {
            id: `edit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            filePath,
            fileName: filePath.split('/').pop(),
            instructions,
            originalContent,
            modifiedContent,
            status: 'pending'
        };
        
        editQueue.push(edit);
        
        // Update UI
        renderEditQueue();
        updateEditStatus();
        
        // Auto-show queue
        if (editQueue.filter(e => e.status === 'pending').length === 1) {
            showEditQueue();
        }
        
        console.log(`[EDIT QUEUE] Added: ${filePath} - ${instructions}`);
        
    } catch (error) {
        console.error('Failed to queue edit:', error);
        alert(`Failed to queue edit: ${error.message}`);
    }
}

/**

/**
 * Render edit queue
 */
function renderEditQueue() {
    const list = document.getElementById('edit-queue-list');
    list.innerHTML = '';
    
    const pending = editQueue.filter(e => e.status === 'pending');
    
    if (pending.length === 0) {
        list.innerHTML = '<div class="empty-state">No pending edits</div>';
        return;
    }
    
    pending.forEach(edit => {
        const item = document.createElement('div');
        item.className = 'edit-item';
        item.innerHTML = `
            <div class="edit-header">
                <strong>${edit.fileName}</strong>
                <span class="edit-instructions">${edit.instructions}</span>
            </div>
            <div class="edit-actions">
                <button class="btn-accept" data-id="${edit.id}">✓ Accept</button>
                <button class="btn-reject" data-id="${edit.id}">✕ Reject</button>
                <button class="btn-preview" data-id="${edit.id}">👁 Preview</button>
            </div>
        `;
        
        // Accept button
        item.querySelector('.btn-accept').onclick = () => acceptEdit(edit.id);
        
        // Reject button
        item.querySelector('.btn-reject').onclick = () => rejectEdit(edit.id);
        
        // Preview button
        item.querySelector('.btn-preview').onclick = () => previewEdit(edit.id);
        
        list.appendChild(item);
    });
}

/**
 * Accept edit
 */
async function acceptEdit(id) {
    const edit = editQueue.find(e => e.id === id);
    if (!edit || edit.status !== 'pending') return;
    
    console.log(`[EDIT QUEUE] Accepting edit:`, {
        id,
        filePath: edit.filePath,
        hasModifiedContent: !!edit.modifiedContent,
        modifiedContentLength: edit.modifiedContent?.length
    });
    
    try {
        // Save to file
        console.log(`[EDIT QUEUE] Writing to disk: ${edit.filePath} (${edit.modifiedContent?.length || 0} chars)`);
        
        const response = await fetch('/api/folder/write', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                path: edit.filePath, 
                content: edit.modifiedContent 
            })
        });
        
        const data = await response.json();
        
        console.log(`[EDIT QUEUE] Write response:`, data);
        
        if (!data.success) {
            throw new Error(data.error);
        }
        
        console.log(`[EDIT QUEUE] ✓ File written to disk successfully`);
        
        // Update in editor if open
        if (openFiles.has(edit.filePath)) {
            console.log(`[EDIT QUEUE] File is open in editor, updating...`);
            const fileData = openFiles.get(edit.filePath);
            fileData.model.setValue(edit.modifiedContent);
            fileData.dirty = false;
            console.log(`[EDIT QUEUE] ✓ Editor updated and marked clean`);
        } else {
            console.log(`[EDIT QUEUE] File not open in editor`);
        }
        
        edit.status = 'accepted';
        renderEditQueue();
        updateEditStatus();
        
        console.log(`[EDIT] ✓ Accepted: ${edit.fileName}`);
        
    } catch (error) {
        console.error('[EDIT QUEUE] Failed to accept edit:', error);
        alert(`Failed to accept edit: ${error.message}`);
    }
}

/**
 * Reject edit
 */
function rejectEdit(id) {
    const edit = editQueue.find(e => e.id === id);
    if (!edit || edit.status !== 'pending') return;
    
    edit.status = 'rejected';
    renderEditQueue();
    updateEditStatus();
    
    console.log(`[EDIT] ✕ Rejected: ${edit.fileName}`);
}

/**
 * Accept all pending edits
 */
async function acceptAllEdits() {
    const pending = editQueue.filter(e => e.status === 'pending');
    for (const edit of pending) {
        await acceptEdit(edit.id);
    }
}

/**
 * Reject all pending edits
 */
function rejectAllEdits() {
    editQueue.filter(e => e.status === 'pending').forEach(e => {
        e.status = 'rejected';
    });
    renderEditQueue();
    updateEditStatus();
}

/**
 * Preview edit (show diff)
 */
function previewEdit(id) {
    const edit = editQueue.find(e => e.id === id);
    if (!edit) return;
    
    // Simple diff preview (can be enhanced with proper diff library)
    const originalLines = edit.originalContent.split('\n');
    const modifiedLines = edit.modifiedContent.split('\n');
    
    let diff = `File: ${edit.filePath}\nInstructions: ${edit.instructions}\n\n`;
    diff += `--- Original (${originalLines.length} lines)\n`;
    diff += `+++ Modified (${modifiedLines.length} lines)\n\n`;
    
    // Simple line-by-line diff
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    for (let i = 0; i < maxLines; i++) {
        const orig = originalLines[i] || '';
        const mod = modifiedLines[i] || '';
        
        if (orig !== mod) {
            if (orig) diff += `- ${orig}\n`;
            if (mod) diff += `+ ${mod}\n`;
        }
    }
    
    alert(diff); // Simple preview - can enhance with modal + syntax highlighting
}

/**
 * Show/hide edit queue
 */
function showEditQueue() {
    document.getElementById('edit-queue-modal').classList.remove('hidden');
}

function hideEditQueue() {
    document.getElementById('edit-queue-modal').classList.add('hidden');
}

/**
 * Update edit status in status bar
 */
function updateEditStatus() {
    const statusEl = document.getElementById('status-edits');
    const pending = editQueue.filter(e => e.status === 'pending').length;
    
    if (pending > 0) {
        statusEl.textContent = `${pending} edit${pending > 1 ? 's' : ''} pending`;
        statusEl.classList.remove('hidden');
    } else {
        statusEl.classList.add('hidden');
    }
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Export
export { editQueue };

