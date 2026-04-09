#!/usr/bin/env node
/**
 * COSMO IDE v2 Server
 * Clean implementation - Function Calling only
 */

require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const CodebaseIndexer = require('./codebase-indexer');
const { handleFunctionCalling } = require('./ai-handler');
const { getAnthropicApiKey } = require('../../src/services/anthropic-oauth-engine');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const MsgReader = require('msgreader').default || require('msgreader');

const app = express();
const PORT = process.env.PORT || 3405;
const HTTPS_PORT = process.env.HTTPS_PORT || 3406;

// ============================================================================
// NETWORK UTILITIES
// ============================================================================

/**
 * Auto-detect local network IP address
 * Returns the first non-internal IPv4 address found
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (127.0.0.1) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null; // No network IP found
}

// Initialize AI clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Anthropic uses OAuth service with auto-refresh and fallback to .env
const getAnthropic = async () => {
  const credentials = await getAnthropicApiKey();
  if (credentials.isOAuth) {
    return new Anthropic({
      authToken: credentials.authToken,
      defaultHeaders: credentials.defaultHeaders,
      dangerouslyAllowBrowser: credentials.dangerouslyAllowBrowser
    });
  } else {
    return new Anthropic({
      apiKey: credentials.apiKey
    });
  }
};
const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});
const codebaseIndexer = new CodebaseIndexer(openai);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================================================
// FILE OPERATIONS (Unrestricted like Cursor)
// ============================================================================

app.get('/api/folder/browse', async (req, res) => {
  try {
    const { path: folderPath, recursive } = req.query;
    
    if (!folderPath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    if (recursive === 'true') {
      // Recursive directory listing
      const files = await readDirRecursive(folderPath);
      res.json({ success: true, files });
    } else {
      // Non-recursive (immediate children only)
      const entries = await fs.readdir(folderPath, { withFileTypes: true });
      
      const files = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          path: path.join(folderPath, e.name)
        }));
      
      res.json({ success: true, files });
    }
    
  } catch (error) {
    console.error('[BROWSE] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper function for recursive directory reading
async function readDirRecursive(dirPath, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];
  
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  
  for (const entry of entries) {
    // Skip hidden files and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    
    const fullPath = path.join(dirPath, entry.name);
    files.push({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: fullPath
    });
    
    // Recursively read subdirectories
    if (entry.isDirectory()) {
      const children = await readDirRecursive(fullPath, depth + 1, maxDepth);
      files.push(...children);
    }
  }
  
  return files;
}

app.get('/api/folder/read', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ success: true, content });
    
  } catch (error) {
    console.error('[READ] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/folder/write', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    console.log(`[WRITE] Writing file: ${filePath} (${content?.length || 0} chars)`);
    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`[WRITE] ✓ File written successfully: ${filePath}`);
    res.json({ success: true });
    
  } catch (error) {
    console.error('[WRITE] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/folder/create', async (req, res) => {
  try {
    const { path: filePath, content = '' } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('[CREATE] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/folder/delete', async (req, res) => {
  try {
    const { path: filePath } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    await fs.unlink(filePath);
    res.json({ success: true });
    
  } catch (error) {
    console.error('[DELETE] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve file for preview in browser
app.get('/api/serve-file', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    console.log('[SERVE] Serving file:', filePath);
    
    // Detect MIME type from extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.htm': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.svg': 'image/svg+xml',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      // Images
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon'
    };
    
    const contentType = mimeTypes[ext] || 'text/plain';
    
    // Check if it's an image
    const isImage = contentType.startsWith('image/');
    
    if (isImage) {
      // Serve image as binary
      const buffer = await fs.readFile(filePath);
      console.log(`[SERVE] ✅ Image served: ${path.basename(filePath)} (${buffer.length} bytes)`);
      res.type(contentType).send(buffer);
    } else {
      // Serve text files as UTF-8
      const content = await fs.readFile(filePath, 'utf-8');
      console.log(`[SERVE] ✅ File served: ${path.basename(filePath)}`);
      res.type(contentType).send(content);
    }
    
  } catch (error) {
    console.error('[SERVE] ❌ Error serving file:', filePath, error.message);
    res.status(500).send('Failed to serve file');
  }
});

// Extract text from Office files for editor
app.get('/api/extract-office-text', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    const ext = path.extname(filePath).toLowerCase();
    let textContent = '';
    let metadata = {};
    
    if (ext === '.docx') {
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer });
      textContent = result.value;
      metadata.format = 'docx';
      metadata.warnings = result.messages.length > 0 ? result.messages.map(m => m.message) : undefined;
      
    } else if (ext === '.xlsx' || ext === '.xls') {
      const buffer = await fs.readFile(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      
      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        
        textContent += `\n=== Sheet: ${sheetName} ===\n\n`;
        
        jsonData.forEach((row) => {
          if (row.some(cell => cell !== '')) {
            const rowText = row.map(cell => {
              const cellValue = cell === null || cell === undefined ? '' : String(cell);
              return cellValue.replace(/\t/g, ' ').replace(/\n/g, ' ');
            }).join(' | ');
            textContent += `${rowText}\n`;
          }
        });
        
        textContent += '\n';
      });
      
      metadata.format = ext.substring(1);
      metadata.sheetCount = workbook.SheetNames.length;
      
    } else if (ext === '.msg') {
      const buffer = await fs.readFile(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const msgReader = new MsgReader(arrayBuffer);
      const msg = msgReader.getFileData();
      
      if (msg.error) {
        return res.status(400).json({ error: msg.error });
      }
      
      const getField = (fieldName) => {
        if (!msg || typeof msg !== 'object') return null;
        if (msg[fieldName] !== undefined) return msg[fieldName];
        const lowerKey = Object.keys(msg).find(k => k.toLowerCase() === fieldName.toLowerCase());
        return lowerKey ? msg[lowerKey] : null;
      };
      
      const senderName = getField('senderName') || getField('from') || getField('sender') || '';
      const senderEmail = getField('senderEmail') || getField('fromEmail') || '';
      const subject = getField('subject') || '(No Subject)';
      const to = getField('to') || getField('recipient') || '';
      const cc = getField('cc') || '';
      const date = getField('date') || getField('sentDate') || getField('receivedDate') || '';
      const body = getField('body') || getField('bodyText') || getField('text') || '';
      const bodyHtml = getField('bodyHtml') || getField('htmlBody') || '';
      const attachments = getField('attachments') || [];
      
      if (senderName || senderEmail) {
        textContent += `From: ${senderName}`;
        if (senderEmail) {
          textContent += senderName ? ` <${senderEmail}>` : senderEmail;
        }
        textContent += '\n';
      }
      
      if (subject) textContent += `Subject: ${subject}\n`;
      if (to) textContent += `To: ${to}\n`;
      if (cc) textContent += `CC: ${cc}\n`;
      if (date) textContent += `Date: ${date}\n`;
      
      textContent += '\n--- Message Body ---\n\n';
      
      if (body) {
        textContent += body;
      } else if (bodyHtml) {
        textContent += bodyHtml.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      } else {
        textContent += '(No body content found)';
      }
      
      const attachmentList = Array.isArray(attachments) ? attachments : [];
      if (attachmentList.length > 0) {
        textContent += `\n\n--- Attachments (${attachmentList.length}) ---\n`;
        attachmentList.forEach((att, idx) => {
          const fileName = (att && att.fileName) ? att.fileName : (typeof att === 'string' ? att : 'Unknown');
          textContent += `${idx + 1}. ${fileName}\n`;
        });
      }
      
      metadata.format = 'msg';
      metadata.hasAttachments = attachmentList.length > 0;
      metadata.attachmentCount = attachmentList.length;
      
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    
    res.json({
      success: true,
      content: textContent.trim(),
      metadata
    });
    
  } catch (error) {
    console.error('[EXTRACT TEXT] Error:', error);
    res.status(500).json({ error: `Failed to extract text: ${error.message}` });
  }
});

// Preview Office files (convert to HTML)
app.get('/api/preview-office-file', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    const ext = path.extname(filePath).toLowerCase();
    let html = '';
    
    if (ext === '.docx') {
      // Convert DOCX to HTML
      const buffer = await fs.readFile(filePath);
      const result = await mammoth.convertToHtml({ buffer });
      html = result.value;
      
      // Wrap in styled container
      html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              line-height: 1.6;
              color: #333;
            }
            h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
            p { margin: 1em 0; }
            table { border-collapse: collapse; width: 100%; margin: 1em 0; }
            table td, table th { border: 1px solid #ddd; padding: 8px; }
            table th { background-color: #f2f2f2; }
          </style>
        </head>
        <body>
          ${html}
        </body>
        </html>
      `;
      
    } else if (ext === '.xlsx' || ext === '.xls') {
      // Convert Excel to HTML table
      const buffer = await fs.readFile(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      
      let tablesHtml = '';
      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        
        if (jsonData.length > 0) {
          tablesHtml += `<h2>Sheet: ${sheetName}</h2>`;
          tablesHtml += '<table>';
          
          jsonData.forEach((row) => {
            if (row.some(cell => cell !== '')) {
              tablesHtml += '<tr>';
              row.forEach(cell => {
                const cellValue = cell === null || cell === undefined ? '' : String(cell);
                const isHeader = jsonData.indexOf(row) === 0;
                tablesHtml += isHeader ? `<th>${cellValue}</th>` : `<td>${cellValue}</td>`;
              });
              tablesHtml += '</tr>';
            }
          });
          
          tablesHtml += '</table>';
        }
      });
      
      html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 1200px;
              margin: 0 auto;
              padding: 20px;
              line-height: 1.6;
              color: #333;
            }
            h2 { margin-top: 2em; margin-bottom: 1em; color: #555; }
            table { border-collapse: collapse; width: 100%; margin: 1em 0; }
            table td, table th { border: 1px solid #ddd; padding: 8px; text-align: left; }
            table th { background-color: #f2f2f2; font-weight: 600; }
            table tr:nth-child(even) { background-color: #f9f9f9; }
          </style>
        </head>
        <body>
          <h1>${path.basename(filePath)}</h1>
          ${tablesHtml}
        </body>
        </html>
      `;
      
    } else if (ext === '.msg') {
      // Convert MSG to HTML email format
      const buffer = await fs.readFile(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const msgReader = new MsgReader(arrayBuffer);
      const msg = msgReader.getFileData();
      
      if (msg.error) {
        return res.status(400).json({ error: msg.error });
      }
      
      const getField = (fieldName) => {
        if (!msg || typeof msg !== 'object') return null;
        if (msg[fieldName] !== undefined) return msg[fieldName];
        const lowerKey = Object.keys(msg).find(k => k.toLowerCase() === fieldName.toLowerCase());
        return lowerKey ? msg[lowerKey] : null;
      };
      
      const senderName = getField('senderName') || getField('from') || getField('sender') || '';
      const senderEmail = getField('senderEmail') || getField('fromEmail') || '';
      const subject = getField('subject') || '(No Subject)';
      const to = getField('to') || getField('recipient') || '';
      const cc = getField('cc') || '';
      const date = getField('date') || getField('sentDate') || getField('receivedDate') || '';
      const body = getField('body') || getField('bodyText') || getField('text') || '';
      const bodyHtml = getField('bodyHtml') || getField('htmlBody') || '';
      const attachments = getField('attachments') || [];
      
      const fromLine = senderName + (senderEmail ? ` <${senderEmail}>` : '');
      const bodyContent = bodyHtml || body.replace(/\n/g, '<br>');
      
      let attachmentsHtml = '';
      if (Array.isArray(attachments) && attachments.length > 0) {
        attachmentsHtml = '<div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd;">';
        attachmentsHtml += `<strong>Attachments (${attachments.length}):</strong><ul>`;
        attachments.forEach((att, idx) => {
          const fileName = (att && att.fileName) ? att.fileName : (typeof att === 'string' ? att : 'Unknown');
          attachmentsHtml += `<li>${fileName}</li>`;
        });
        attachmentsHtml += '</ul></div>';
      }
      
      html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              line-height: 1.6;
              color: #333;
              background: #f5f5f5;
            }
            .email-container {
              background: white;
              border: 1px solid #ddd;
              border-radius: 4px;
              padding: 20px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .email-header {
              border-bottom: 2px solid #eee;
              padding-bottom: 15px;
              margin-bottom: 20px;
            }
            .email-header div {
              margin: 5px 0;
              color: #666;
            }
            .email-header strong {
              color: #333;
              display: inline-block;
              width: 80px;
            }
            .email-body {
              color: #333;
            }
            .email-body pre {
              white-space: pre-wrap;
              font-family: inherit;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="email-header">
              <div><strong>From:</strong> ${fromLine || '(Unknown)'}</div>
              ${to ? `<div><strong>To:</strong> ${to}</div>` : ''}
              ${cc ? `<div><strong>CC:</strong> ${cc}</div>` : ''}
              <div><strong>Subject:</strong> ${subject}</div>
              ${date ? `<div><strong>Date:</strong> ${date}</div>` : ''}
            </div>
            <div class="email-body">
              ${bodyContent || '(No body content)'}
            </div>
            ${attachmentsHtml}
          </div>
        </body>
        </html>
      `;
      
    } else {
      return res.status(400).json({ error: 'Unsupported file type for preview' });
    }
    
    res.type('text/html').send(html);
    
  } catch (error) {
    console.error('[PREVIEW OFFICE] Error:', error);
    res.status(500).json({ error: `Failed to preview file: ${error.message}` });
  }
});

// Reveal file in system file explorer (cross-platform)
app.post('/api/reveal-in-finder', async (req, res) => {
  try {
    const { path: filePath } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }
    
    const { exec } = require('child_process');
    const platform = os.platform();
    
    let command;
    switch (platform) {
      case 'darwin': // macOS
        command = `open -R "${filePath}"`;
        break;
      case 'win32': // Windows
        // Convert forward slashes to backslashes for Windows
        command = `explorer /select,"${filePath.replace(/\//g, '\\')}"`;
        break;
      case 'linux':
        // Open parent directory (Linux doesn't have a standard "reveal" command)
        command = `xdg-open "$(dirname "${filePath}")"`;
        break;
      default:
        return res.status(501).json({ 
          success: false, 
          error: `Platform '${platform}' not supported for file reveal` 
        });
    }
    
    exec(command, (error) => {
      if (error) {
        console.error('[REVEAL] Error:', error);
        res.json({ success: false, error: error.message });
      } else {
        res.json({ success: true });
      }
    });
    
  } catch (error) {
    console.error('[REVEAL] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// AI CHAT - Function Calling with SSE Streaming
// ============================================================================

app.post('/api/chat', async (req, res) => {
  try {
    const params = req.body;
    const { message, stream } = params;
    
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }
    
    console.log(`[CHAT] "${message.substring(0, 60)}..."`);
    
    if (stream) {
      // SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      if (req.socket) req.socket.setNoDelay(true);

      const eventEmitter = (event) => {
        try {
          // DEBUG: Log all events being sent
          if (event.type === 'tool_result' || event.type === 'thinking') {
            console.log(`[SSE] Sending event:`, event.type, JSON.stringify(event).substring(0, 150));
          }
          
          // Safely stringify - handle circular refs and special chars
          const jsonString = JSON.stringify(event, (key, value) => {
            if (typeof value === 'string') {
              // Ensure strings are properly sanitized
              return value.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
            }
            return value;
          });
          res.write(`data: ${jsonString}\n\n`);
        } catch (err) {
          console.error('[SSE] Failed to send event:', err.message);
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'Event encoding failed' })}\n\n`);
        }
      };
      
      try {
        const result = await handleFunctionCalling(
          openai,
          await getAnthropic(),
          xai,
          codebaseIndexer,
          params,
          eventEmitter
        );
        
        if (!result.success) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
          res.end();
          return;
        }
        
        // Stream final response
        const response = result.response;
        const chunkSize = 80;
        
        for (let i = 0; i < response.length; i += chunkSize) {
          const chunk = response.substring(i, i + chunkSize);
          res.write(`data: ${JSON.stringify({ type: 'response_chunk', chunk })}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        
        // Done
        console.log(`[SERVER] Sending complete event with ${result.pendingEdits?.length || 0} pendingEdits:`, 
          result.pendingEdits?.map(e => ({ file: e.file, hasEdit: !!e.edit, editLength: e.edit?.length })));
        
        res.write(`data: ${JSON.stringify({ 
          type: 'complete',
          fullResponse: response,
          tokensUsed: result.tokensUsed,
          iterations: result.iterations,
          pendingEdits: result.pendingEdits || []
        })}\n\n`);
        res.end();
        
        console.log(`[CHAT] ✅ ${result.iterations} iterations, ${result.pendingEdits?.length || 0} edits`);
        
      } catch (error) {
        console.error('[CHAT] Error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
      }
      
    } else {
      // Non-streaming
      const result = await handleFunctionCalling(
        openai,
        await getAnthropic(),
        xai,
        codebaseIndexer,
        params
      );
      
      if (!result.success) {
        return res.status(500).json({ success: false, error: result.error });
      }
      
      res.json({
        success: true,
        response: result.response,
        tokensUsed: result.tokensUsed,
        iterations: result.iterations,
        pendingEdits: result.pendingEdits || []
      });
    }
    
  } catch (error) {
    console.error('[CHAT] Fatal error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ============================================================================
// CONVERSATION MANAGEMENT
// ============================================================================

const conversationsDir = path.join(__dirname, '../conversations');

// Ensure conversations directory exists
fs.mkdir(conversationsDir, { recursive: true }).catch(() => {});

app.get('/api/conversations', async (req, res) => {
  try {
    const files = await fs.readdir(conversationsDir);
    const conversations = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(conversationsDir, file), 'utf-8');
        const data = JSON.parse(content);
        conversations.push({
          id: file.replace('.json', ''),
          title: data.title,
          timestamp: data.timestamp,
          messageCount: data.messages?.length || 0
        });
      }
    }
    
    // Sort by timestamp descending
    conversations.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('[CONVERSATIONS] Error listing:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(conversationsDir, `${id}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    res.json({ success: true, conversation: data });
  } catch (error) {
    console.error('[CONVERSATIONS] Error loading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const { title, messages, folder } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array required' });
    }
    
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    
    const conversation = {
      id,
      title: title || `Conversation ${new Date().toLocaleString()}`,
      timestamp,
      folder: folder || null,
      messages
    };
    
    const filePath = path.join(conversationsDir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
    
    res.json({ success: true, id, conversation });
  } catch (error) {
    console.error('[CONVERSATIONS] Error saving:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, messages, folder } = req.body;
    
    const filePath = path.join(conversationsDir, `${id}.json`);
    const existing = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    
    const updated = {
      ...existing,
      title: title !== undefined ? title : existing.title,
      messages: messages !== undefined ? messages : existing.messages,
      folder: folder !== undefined ? folder : existing.folder,
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');
    
    res.json({ success: true, conversation: updated });
  } catch (error) {
    console.error('[CONVERSATIONS] Error updating:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(conversationsDir, `${id}.json`);
    await fs.unlink(filePath);
    
    res.json({ success: true });
  } catch (error) {
    console.error('[CONVERSATIONS] Error deleting:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// FILE SNAPSHOTS (Auto-backup before AI edits)
// ============================================================================

const snapshotsDir = path.join(__dirname, '../snapshots');

// Ensure snapshots directory exists
fs.mkdir(snapshotsDir, { recursive: true }).catch(() => {});

// Create a snapshot of a file
app.post('/api/snapshots', async (req, res) => {
  try {
    const { filePath, content, reason } = req.body;
    
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'File path and content required' });
    }
    
    const timestamp = Date.now();
    const id = `snap_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    
    const snapshot = {
      id,
      filePath,
      content,
      reason: reason || 'Manual snapshot',
      timestamp: new Date(timestamp).toISOString(),
      size: content.length
    };
    
    // Create file-specific subdirectory to organize snapshots
    const fileHash = Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
    const fileSnapshotDir = path.join(snapshotsDir, fileHash);
    await fs.mkdir(fileSnapshotDir, { recursive: true });
    
    const snapshotPath = path.join(fileSnapshotDir, `${id}.json`);
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    
    console.log(`[SNAPSHOT] Created for ${filePath}: ${reason}`);
    res.json({ success: true, id, snapshot: { id, filePath, timestamp: snapshot.timestamp, reason, size: snapshot.size } });
  } catch (error) {
    console.error('[SNAPSHOT] Error creating:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all snapshots for a specific file
app.get('/api/snapshots', async (req, res) => {
  try {
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fileHash = Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
    const fileSnapshotDir = path.join(snapshotsDir, fileHash);
    
    try {
      const files = await fs.readdir(fileSnapshotDir);
      const snapshots = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(path.join(fileSnapshotDir, file), 'utf-8');
          const data = JSON.parse(content);
          // Don't include content in list (too large), only metadata
          snapshots.push({
            id: data.id,
            filePath: data.filePath,
            timestamp: data.timestamp,
            reason: data.reason,
            size: data.size
          });
        }
      }
      
      // Sort by timestamp descending (newest first)
      snapshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      res.json({ success: true, snapshots });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // No snapshots yet for this file
        res.json({ success: true, snapshots: [] });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('[SNAPSHOT] Error listing:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get a specific snapshot (with content)
app.get('/api/snapshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fileHash = Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
    const fileSnapshotDir = path.join(snapshotsDir, fileHash);
    const snapshotPath = path.join(fileSnapshotDir, `${id}.json`);
    
    const content = await fs.readFile(snapshotPath, 'utf-8');
    const snapshot = JSON.parse(content);
    
    res.json({ success: true, snapshot });
  } catch (error) {
    console.error('[SNAPSHOT] Error loading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a specific snapshot
app.delete('/api/snapshots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fileHash = Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
    const fileSnapshotDir = path.join(snapshotsDir, fileHash);
    const snapshotPath = path.join(fileSnapshotDir, `${id}.json`);
    
    await fs.unlink(snapshotPath);
    
    res.json({ success: true });
  } catch (error) {
    console.error('[SNAPSHOT] Error deleting:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete all snapshots for a file
app.delete('/api/snapshots', async (req, res) => {
  try {
    const { filePath } = req.query;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fileHash = Buffer.from(filePath).toString('base64').replace(/[/+=]/g, '_');
    const fileSnapshotDir = path.join(snapshotsDir, fileHash);
    
    try {
      await fs.rm(fileSnapshotDir, { recursive: true, force: true });
      res.json({ success: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Directory doesn't exist, that's fine
        res.json({ success: true });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('[SNAPSHOT] Error deleting all:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// SEMANTIC SEARCH
// ============================================================================

app.post('/api/index-folder', async (req, res) => {
  try {
    const { folderPath, files } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ error: 'Folder path required' });
    }
    
    await codebaseIndexer.indexFolder(folderPath, files);
    
    res.json({ success: true, message: 'Indexing started' });
    
  } catch (error) {
    console.error('[INDEX] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/codebase-search', async (req, res) => {
  try {
    const { query, folderPath, limit = 10 } = req.body;
    
    if (!query || !folderPath) {
      return res.status(400).json({ error: 'Query and folder path required' });
    }
    
    const result = await codebaseIndexer.searchCode(folderPath, query, limit);
    
    res.json({
      success: true,
      results: result.results || [],
      count: result.results?.length || 0
    });
    
  } catch (error) {
    console.error('[SEARCH] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// START SERVER (HTTP + HTTPS)
// ============================================================================

// Start HTTP server
const localIP = getLocalIP();

http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 COSMO IDE v2 - Function Calling');
  console.log('='.repeat(60));
  console.log(`\n✓ HTTP:  http://localhost:${PORT}`);
  if (localIP) {
    console.log(`✓ HTTP:  http://${localIP}:${PORT} (network)`);
  }
});

// Start HTTPS server if certificates exist
const certPath = path.join(__dirname, '../ssl/cert.pem');
const keyPath = path.join(__dirname, '../ssl/key.pem');

if (fsSync.existsSync(certPath) && fsSync.existsSync(keyPath)) {
  const httpsOptions = {
    key: fsSync.readFileSync(keyPath),
    cert: fsSync.readFileSync(certPath)
  };
  
  https.createServer(httpsOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`✓ HTTPS: https://localhost:${HTTPS_PORT}`);
    if (localIP) {
      console.log(`✓ HTTPS: https://${localIP}:${HTTPS_PORT} 🔒 (network)`);
    }
    console.log('\n🤖 AI Models:');
    console.log('   - GPT-5.2 ✅');
    console.log('   - Claude Sonnet 4.5 ✅');
    console.log('   - Claude Opus 4.5 ✅');
    console.log('\n🧠 Semantic Search: ENABLED');
    console.log('🔧 Function Calling: ENABLED');
    console.log('🌍 Access: UNRESTRICTED (Network-wide)');
    if (localIP) {
      console.log(`\n💡 Network URL: https://${localIP}:${HTTPS_PORT}`);
    }
    console.log('💡 Use HTTPS URL for full clipboard support!');
    console.log('\n' + '='.repeat(60) + '\n');
  });
} else {
  console.log('\n⚠️  HTTPS: Not configured (certificates not found)');
  console.log('\n🤖 AI Models:');
  console.log('   - GPT-5.2 ✅');
  console.log('   - Claude Sonnet 4.5 ✅');
  console.log('   - Claude Opus 4.5 ✅');
  console.log('\n🧠 Semantic Search: ENABLED');
  console.log('🔧 Function Calling: ENABLED');
  console.log('🌍 Access: UNRESTRICTED (Network-wide)');
  console.log('\n' + '='.repeat(60) + '\n');
}

