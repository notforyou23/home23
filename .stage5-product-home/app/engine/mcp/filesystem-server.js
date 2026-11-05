#!/usr/bin/env node

/**
 * Simple MCP Filesystem Server for COSMO
 * Exposes read_file and list_directory tools via HTTP JSON-RPC
 * 
 * This allows COSMO agents to read repo files during guided tests.
 * 
 * Usage:
 *   node filesystem-mcp-server.js [port] [root_path]
 * 
 * Default:
 *   port: 3336
 *   root_path: parent directory of this script
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// Configuration
const PORT = process.argv[2] || 3336;
const ROOT_PATH = process.argv[3] || path.join(__dirname, '..');

// Load COSMO configuration for file access control
let COSMO_CONFIG = null;
let ALLOWED_PATHS = null;
try {
  const configPath = path.join(ROOT_PATH, 'src', 'config.yaml');
  if (fsSync.existsSync(configPath)) {
    const yaml = require('js-yaml');
    COSMO_CONFIG = yaml.load(fsSync.readFileSync(configPath, 'utf8'));

    // Extract allowed paths from config structure: mcp.client.servers[0].allowedPaths
    const mcpServers = COSMO_CONFIG?.mcp?.client?.servers;
    if (mcpServers && mcpServers[0] && mcpServers[0].allowedPaths) {
      ALLOWED_PATHS = mcpServers[0].allowedPaths;
      console.log('📁 File access configured for paths:', ALLOWED_PATHS);
    } else {
      console.log('📁 No file access restrictions configured (full repository access)');
    }
  }
} catch (error) {
  console.warn('Could not load COSMO config for file access control:', error.message);
}

console.log('🗂️  MCP Filesystem Server');
console.log('');
console.log('  Port:', PORT);
console.log('  Root:', ROOT_PATH);
console.log('');

// Available tools
const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the repository',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to file from repo root (e.g. "runtime/coordinator/insights_curated_cycle_50_2025-10-11.md")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to directory from repo root (default: ".")',
          default: '.'
        }
      }
    }
  }
];

/**
 * Universal exclusions - always blocked regardless of allowedPaths config
 */
const EXCLUDED_PATHS = ['node_modules', '.git'];

/**
 * Check if path should be universally excluded
 */
function isPathExcluded(relPath) {
  const normalizedPath = path.normalize(relPath);
  return EXCLUDED_PATHS.some(excluded => {
    return normalizedPath.includes(`/${excluded}/`) || 
           normalizedPath.startsWith(`${excluded}/`) ||
           normalizedPath === excluded;
  });
}

/**
 * Detect if file is likely binary
 */
function isBinaryFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.7z',
    '.exe', '.dll', '.so', '.dylib',
    '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.avi', '.mov',
    '.bin', '.dat', '.db', '.sqlite'
  ];
  return binaryExtensions.includes(ext);
}

/**
 * Check if path is allowed based on configuration
 * Supports both COSMO-relative paths and absolute external paths
 */
function isPathAllowed(relPath) {
  // Universal exclusions first
  if (isPathExcluded(relPath)) {
    return false;
  }
  
  if (!ALLOWED_PATHS || ALLOWED_PATHS.length === 0) {
    return true; // No restrictions configured
  }

  // Resolve the requested path (supports both absolute and relative)
  const resolvedRequested = path.isAbsolute(relPath)
    ? path.resolve(relPath)  // Use absolute path as-is
    : path.resolve(ROOT_PATH, relPath);  // Resolve relative to COSMO root

  // Check if path starts with any allowed path
  return ALLOWED_PATHS.some(allowedPath => {
    // Handle both absolute external paths and COSMO-relative paths
    const resolvedAllowed = path.isAbsolute(allowedPath)
      ? path.resolve(allowedPath)  // External absolute path (e.g., /home/user/Documents/)
      : path.resolve(ROOT_PATH, allowedPath);  // COSMO-relative path (e.g., runtime/outputs/)
    
    return resolvedRequested.startsWith(resolvedAllowed);
  });
}

/**
 * Read a file (with security checks)
 * Supports both COSMO-relative paths and absolute external paths
 */
async function readFile(relPath) {
  // Check file access permissions first (handles allowed paths validation)
  if (!isPathAllowed(relPath)) {
    throw new Error(`Access denied: path '${relPath}' not in allowed directories`);
  }

  // Resolve path (supports both relative to ROOT and absolute external paths)
  const fullPath = path.isAbsolute(relPath) 
    ? path.resolve(relPath)  // Use absolute external path as-is
    : path.resolve(ROOT_PATH, relPath);  // Resolve relative to COSMO root

  // Check if binary file
  if (isBinaryFile(fullPath)) {
    throw new Error(`Binary file access not supported: ${relPath}. Only text files can be read.`);
  }

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const stats = await fs.stat(fullPath);

    return {
      path: relPath,
      content,
      size: stats.size,
      modified: stats.mtime.toISOString()
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`File not found: ${relPath}`);
    }
    throw new Error(`Failed to read file: ${error.message}`);
  }
}

/**
 * List directory (with security checks)
 * Supports both COSMO-relative paths and absolute external paths
 */
async function listDirectory(relPath = '.') {
  // Check file access permissions first (handles allowed paths validation)
  if (!isPathAllowed(relPath)) {
    throw new Error(`Access denied: path '${relPath}' not in allowed directories`);
  }

  // Resolve path (supports both relative to ROOT and absolute external paths)
  const fullPath = path.isAbsolute(relPath) 
    ? path.resolve(relPath)  // Use absolute external path as-is
    : path.resolve(ROOT_PATH, relPath);  // Resolve relative to COSMO root

  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    
    const items = await Promise.all(entries.map(async entry => {
      const itemPath = path.join(fullPath, entry.name);
      const stats = await fs.stat(itemPath);
      
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isFile() ? stats.size : null,
        modified: stats.mtime.toISOString()
      };
    }));
    
    return {
      path: relPath,
      items,
      count: items.length
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${relPath}`);
    }
    throw new Error(`Failed to list directory: ${error.message}`);
  }
}

/**
 * Handle JSON-RPC request
 */
async function handleRequest(rpcRequest) {
  const { method, params, id } = rpcRequest;

  try {
    // List tools
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      };
    }

    // Call tool
    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      if (name === 'read_file') {
        const result = await readFile(args.path);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }
        };
      }

      if (name === 'list_directory') {
        const result = await listDirectory(args.path);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          }
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    }

    throw new Error(`Unknown method: ${method}`);
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error.message
      }
    };
  }
}

/**
 * HTTP Server
 */
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Only accept POST
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // Read body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const rpcRequest = JSON.parse(body);
      const rpcResponse = await handleRequest(rpcRequest);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcResponse));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error: ' + error.message
        }
      }));
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log('✅ Server running at http://localhost:' + PORT);
  console.log('');
  console.log('Available tools:');
  TOOLS.forEach(tool => {
    console.log(`  - ${tool.name}: ${tool.description}`);
  });
  console.log('');
  console.log('Example curl test:');
  console.log(`  curl -X POST http://localhost:${PORT} \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`);
  console.log('');
});

