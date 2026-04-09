/**
 * AI Tools - Function Calling Implementation
 * Clean, modular, production-ready
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

// ============================================================================
// TOOL DEFINITIONS (OpenAI/Anthropic Format)
// ============================================================================

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read contents of a file. Use before editing or analyzing code.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to file (relative or absolute)'
          }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List directory contents to understand project structure.',
      parameters: {
        type: 'object',
        properties: {
          directory_path: {
            type: 'string',
            description: 'Directory to list (. for current)'
          }
        },
        required: ['directory_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for exact text patterns using grep. Use when you know the symbol/text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Text or regex pattern to search for'
          },
          path: {
            type: 'string',
            description: 'Path to search - use "." for current directory'
          }
        },
        required: ['pattern', 'path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'codebase_search',
      description: 'Semantic search by MEANING (not exact text). Powerful for unfamiliar code.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query like "Where is auth handled?" or "How does error handling work?"'
          },
          limit: {
            type: 'number',
            description: 'Max results to return (use 10 for typical searches)'
          }
        },
        required: ['query', 'limit'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit an existing file. CRITICAL: Return COMPLETE file content with all changes applied. PREFER surgical edit tools (edit_file_range, search_replace) for targeted changes.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to file to edit'
          },
          instructions: {
            type: 'string',
            description: 'Brief explanation of what you changed'
          },
          code_edit: {
            type: 'string',
            description: 'COMPLETE file content with ALL changes applied. Must include the ENTIRE file from start to finish. User will review in diff viewer before accepting.'
          }
        },
        required: ['file_path', 'instructions', 'code_edit'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file_range',
      description: 'PREFERRED: Edit specific line range in a file. Much more efficient than rewriting entire files. Changes are queued for user review.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to file to edit'
          },
          start_line: {
            type: 'number',
            description: 'Starting line number (1-based, inclusive)'
          },
          end_line: {
            type: 'number',
            description: 'Ending line number (1-based, inclusive)'
          },
          new_content: {
            type: 'string',
            description: 'New content to replace the specified line range'
          },
          instructions: {
            type: 'string',
            description: 'Brief explanation of what you changed'
          }
        },
        required: ['file_path', 'start_line', 'end_line', 'new_content', 'instructions'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description: 'PREFERRED: Find exact text and replace it. Perfect for targeted changes. Include surrounding context for uniqueness. Changes are queued for user review.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to file to edit'
          },
          old_string: {
            type: 'string',
            description: 'Exact text to find and replace. Include enough surrounding context to be unique in the file.'
          },
          new_string: {
            type: 'string',
            description: 'New text to replace the old string'
          },
          instructions: {
            type: 'string',
            description: 'Brief explanation of what you changed'
          }
        },
        required: ['file_path', 'old_string', 'new_string', 'instructions'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_lines',
      description: 'Insert new lines at a specific position in a file. Changes are queued for user review.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to file'
          },
          line_number: {
            type: 'number',
            description: 'Line number to insert before (1-based). Use 1 to insert at start, file_length+1 to append.'
          },
          content: {
            type: 'string',
            description: 'Content to insert'
          },
          instructions: {
            type: 'string',
            description: 'Brief explanation of what you added'
          }
        },
        required: ['file_path', 'line_number', 'content', 'instructions'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_lines',
      description: 'Delete specific lines from a file. Changes are queued for user review.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to file'
          },
          start_line: {
            type: 'number',
            description: 'Starting line to delete (1-based, inclusive)'
          },
          end_line: {
            type: 'number',
            description: 'Ending line to delete (1-based, inclusive)'
          },
          instructions: {
            type: 'string',
            description: 'Brief explanation of what you removed'
          }
        },
        required: ['file_path', 'start_line', 'end_line', 'instructions'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create new file. Use relative paths from current folder.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative path (e.g. src/utils/helper.ts)'
          },
          content: {
            type: 'string',
            description: 'Complete file content'
          }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Execute terminal commands (npm, git, build, test, etc.)',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute'
          }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete file or directory. Use carefully.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to delete'
          }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: 'Read an image file and return it for viewing. Supports png, jpg, jpeg, gif, webp formats.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to image file (relative or absolute)'
          }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  // ============================================================================
  // BRAIN TOOLS - Access COSMO brain knowledge
  // ============================================================================
  {
    type: 'function',
    function: {
      name: 'brain_search',
      description: 'Search COSMO brain memory for relevant findings on a specific topic. Returns nodes with concepts, tags, and relevance scores. Use when you need to find brain knowledge about a topic.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query - natural language description of what to find'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default 15, max 100)'
          }
        },
        required: ['query', 'limit'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'brain_node',
      description: 'Get full content of a specific brain node by ID. Use after brain_search to get complete details of a relevant finding.',
      parameters: {
        type: 'object',
        properties: {
          node_id: {
            type: 'string',
            description: 'The ID of the node to retrieve'
          }
        },
        required: ['node_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'brain_thoughts',
      description: 'Search COSMO thought stream for reasoning and insights. Thoughts capture the AI agents reasoning process during research.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for thoughts'
          },
          limit: {
            type: 'number',
            description: 'Maximum results (default 15, max 50)'
          }
        },
        required: ['query', 'limit'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'brain_coordinator_insights',
      description: 'Get the latest coordinator strategic review. Contains high-level synthesis of research progress and insights.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'brain_stats',
      description: 'Get brain overview statistics including node count, edge count, cycles, and tag distribution.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  }
];

// Convert to Anthropic format
const anthropicTools = toolDefinitions.map(t => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters
}));

// ============================================================================
// TOOL EXECUTOR
// ============================================================================

class ToolExecutor {
  constructor(codebaseIndexer, workingDirectory, brainPath = null) {
    this.indexer = codebaseIndexer;
    this.cwd = workingDirectory || process.cwd();
    this.brainPath = brainPath;
    this._brainCache = null; // Cache loaded brain state
  }

  // Lazy-load brain state for tools
  async _loadBrainState() {
    if (this._brainCache) return this._brainCache;
    if (!this.brainPath) return null;

    try {
      const fs = require('fs');
      const zlib = require('zlib');
      const { promisify } = require('util');
      const gunzip = promisify(zlib.gunzip);
      const statePath = path.join(this.brainPath, 'state.json.gz');

      if (!fs.existsSync(statePath)) {
        console.log('[BRAIN] state.json.gz not found at:', statePath);
        return null;
      }

      const compressed = await fs.promises.readFile(statePath);
      const decompressed = await gunzip(compressed);
      const state = JSON.parse(decompressed.toString());

      this._brainCache = {
        state,
        nodes: state.memory?.nodes || [],
        edges: state.memory?.edges || [],
        brainPath: this.brainPath
      };

      console.log(`[BRAIN] Loaded: ${this._brainCache.nodes.length} nodes, ${this._brainCache.edges.length} edges`);
      return this._brainCache;
    } catch (err) {
      console.error('[BRAIN] Failed to load brain state:', err.message);
      return null;
    }
  }

  resolvePath(inputPath) {
    if (path.isAbsolute(inputPath)) return inputPath;
    if (inputPath === '.') return this.cwd;
    return path.join(this.cwd, inputPath);
  }

  async execute(toolName, args) {
    console.log(`[TOOL] ${toolName}(${JSON.stringify(args).substring(0, 100)}...)`);
    
    try {
      switch (toolName) {
        case 'file_read':
          return await this.readFile(args.file_path);
          
        case 'list_directory':
          return await this.listDirectory(args.directory_path);
          
        case 'grep_search':
          return await this.grepSearch(args.pattern, args.path);
          
        case 'codebase_search':
          return await this.codebaseSearch(args.query, args.limit);
          
        case 'edit_file':
          return this.queueEdit(args.file_path, args.instructions, args.code_edit);
          
        case 'edit_file_range':
          return await this.queueEditRange(args.file_path, args.start_line, args.end_line, args.new_content, args.instructions);
          
        case 'search_replace':
          return await this.queueSearchReplace(args.file_path, args.old_string, args.new_string, args.instructions);
          
        case 'insert_lines':
          return await this.queueInsertLines(args.file_path, args.line_number, args.content, args.instructions);
          
        case 'delete_lines':
          return await this.queueDeleteLines(args.file_path, args.start_line, args.end_line, args.instructions);
          
        case 'create_file':
          return await this.createFile(args.file_path, args.content);
          
        case 'run_terminal':
          return await this.runCommand(args.command);
          
        case 'delete_file':
          return await this.deleteFile(args.file_path);
          
        case 'read_image':
          return await this.readImage(args.file_path);

        // Brain tools
        case 'brain_search':
          return await this.brainSearch(args.query, args.limit);
        case 'brain_node':
          return await this.brainNode(args.node_id);
        case 'brain_thoughts':
          return await this.brainThoughts(args.query, args.limit);
        case 'brain_coordinator_insights':
          return await this.brainCoordinatorInsights();
        case 'brain_stats':
          return await this.brainStats();

        default:
          return { error: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      console.error(`[TOOL ERROR] ${toolName}:`, error.message);
      return { error: error.message };
    }
  }

  async readFile(filePath) {
    const resolved = this.resolvePath(filePath);
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n').length;
    return { 
      content, 
      path: resolved,
      lines,
      size: content.length 
    };
  }

  async readImage(filePath) {
    let resolved = this.resolvePath(filePath);
    
    // Validate file extension
    const ext = path.extname(resolved).toLowerCase();
    const supportedFormats = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    
    if (!supportedFormats.includes(ext)) {
      return { 
        error: `Unsupported image format: ${ext}. Supported: ${supportedFormats.join(', ')}` 
      };
    }
    
    // Try to read the file - if it fails due to Unicode issues, try normalized path
    let buffer;
    try {
      buffer = await fs.readFile(resolved);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // macOS screenshots may contain \u202f (narrow no-break space) before AM/PM
        // Try reading the directory and finding a matching file with Unicode normalization
        const dir = path.dirname(resolved);
        const targetFilename = path.basename(resolved);
        
        try {
          const files = await fs.readdir(dir);
          
          // Try to find a match by normalizing both filenames
          const match = files.find(f => {
            // Normalize both filenames: replace various Unicode spaces with regular space
            const normalizedF = f.replace(/\u202f/g, ' ').replace(/\u00a0/g, ' ');
            const normalizedTarget = targetFilename.replace(/\u202f/g, ' ').replace(/\u00a0/g, ' ');
            return normalizedF === normalizedTarget;
          });
          
          if (match) {
            resolved = path.join(dir, match);
            buffer = await fs.readFile(resolved);
          } else {
            throw err; // Re-throw original error if no match found
          }
        } catch (dirErr) {
          throw err; // Re-throw original error if directory operations fail
        }
      } else {
        throw err; // Re-throw if it's not a file-not-found error
      }
    }
    
    const base64 = buffer.toString('base64');
    
    // Map extension to MIME type
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    
    return {
      type: 'image',
      mime_type: mimeTypes[ext],
      data: base64,
      path: resolved,
      size: buffer.length,
      format: ext.substring(1)
    };
  }

  async listDirectory(dirPath) {
    const resolved = this.resolvePath(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    
    const items = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: path.join(resolved, e.name)
      }))
      .sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
    
    return { items, path: resolved, count: items.length };
  }

  async grepSearch(pattern, searchPath = '.') {
    const resolved = this.resolvePath(searchPath);
    
    try {
      const escapedPattern = pattern.replace(/"/g, '\\"');
      let cmd;
      
      // Try ripgrep first, fallback to grep
      try {
        execSync('which rg', { encoding: 'utf-8' });
        cmd = `rg "${escapedPattern}" "${resolved}" --max-count 50 --max-columns 200`;
      } catch {
        cmd = `grep -r "${escapedPattern}" "${resolved}" | head -100`;
      }
      
      const output = execSync(cmd, { 
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10000
      });
      
      const matchCount = (output.match(/\n/g) || []).length;
      return { matches: output, count: matchCount };
      
    } catch (err) {
      if (err.status === 1) {
        return { matches: '', count: 0, message: 'No matches found' };
      }
      throw err;
    }
  }

  async codebaseSearch(query, limit = 10) {
    if (!this.indexer) {
      return { error: 'Semantic search not available' };
    }
    
    const result = await this.indexer.searchCode(this.cwd, query, limit);
    
    if (!result.results || result.results.length === 0) {
      return { results: [], message: 'No results found' };
    }
    
    return {
      results: result.results.map(r => ({
        file: r.filePath,
        lines: `${r.startLine}-${r.endLine}`,
        similarity: Math.round(r.similarity * 100) + '%',
        content: r.content
      })),
      count: result.results.length
    };
  }

  queueEdit(filePath, instructions, codeEdit) {
    // Return for frontend to queue (not applied here)
    return {
      action: 'queue_edit',
      file_path: this.resolvePath(filePath),
      instructions,
      code_edit: codeEdit,
      message: 'Edit queued for review'
    };
  }

  async queueEditRange(filePath, startLine, endLine, newContent, instructions) {
    const resolved = this.resolvePath(filePath);
    
    // Read current file
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n');
    
    // Validate range
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return { 
        error: `Invalid line range: ${startLine}-${endLine} (file has ${lines.length} lines)`,
        file_path: resolved
      };
    }
    
    // Build complete edited file
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const newLines = newContent.split('\n');
    const editedContent = [...before, ...newLines, ...after].join('\n');
    
    // Return for frontend to queue
    return {
      action: 'queue_edit',
      edit_type: 'range',
      file_path: resolved,
      start_line: startLine,
      end_line: endLine,
      old_content: lines.slice(startLine - 1, endLine).join('\n'),
      new_content: newContent,
      instructions,
      code_edit: editedContent,
      message: `Edit lines ${startLine}-${endLine} queued for review`
    };
  }

  async queueSearchReplace(filePath, oldString, newString, instructions) {
    const resolved = this.resolvePath(filePath);
    
    // Read current file
    const content = await fs.readFile(resolved, 'utf-8');
    
    // Normalize line endings
    const oldStringNormalized = oldString.replace(/\r\n/g, '\n');
    const contentNormalized = content.replace(/\r\n/g, '\n');
    
    // Check if old string exists
    if (!contentNormalized.includes(oldStringNormalized)) {
      return { 
        error: 'Old string not found in file. Make sure to include exact text with proper context.',
        file_path: resolved
      };
    }
    
    // Check for multiple occurrences
    const occurrences = contentNormalized.split(oldStringNormalized).length - 1;
    if (occurrences > 1) {
      return {
        error: `Found ${occurrences} occurrences of the old string. Please include more surrounding context to make it unique.`,
        file_path: resolved
      };
    }
    
    // Build edited content
    const editedContent = contentNormalized.replace(oldStringNormalized, newString);
    
    // Return for frontend to queue
    return {
      action: 'queue_edit',
      edit_type: 'search_replace',
      file_path: resolved,
      old_string: oldString,
      new_string: newString,
      instructions,
      code_edit: editedContent,
      message: 'Search-replace edit queued for review'
    };
  }

  async queueInsertLines(filePath, lineNumber, content, instructions) {
    const resolved = this.resolvePath(filePath);
    
    // Read current file
    const fileContent = await fs.readFile(resolved, 'utf-8');
    const lines = fileContent.split('\n');
    
    // Validate line number
    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return { 
        error: `Invalid line number: ${lineNumber} (file has ${lines.length} lines, use 1-${lines.length + 1})`,
        file_path: resolved
      };
    }
    
    // Build edited content
    const before = lines.slice(0, lineNumber - 1);
    const after = lines.slice(lineNumber - 1);
    const newLines = content.split('\n');
    const editedContent = [...before, ...newLines, ...after].join('\n');
    
    // Return for frontend to queue
    return {
      action: 'queue_edit',
      edit_type: 'insert',
      file_path: resolved,
      line_number: lineNumber,
      inserted_content: content,
      instructions,
      code_edit: editedContent,
      message: `Insert at line ${lineNumber} queued for review`
    };
  }

  async queueDeleteLines(filePath, startLine, endLine, instructions) {
    const resolved = this.resolvePath(filePath);
    
    // Read current file
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n');
    
    // Validate range
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return { 
        error: `Invalid line range: ${startLine}-${endLine} (file has ${lines.length} lines)`,
        file_path: resolved
      };
    }
    
    // Build edited content
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const editedContent = [...before, ...after].join('\n');
    
    // Return for frontend to queue
    return {
      action: 'queue_edit',
      edit_type: 'delete',
      file_path: resolved,
      start_line: startLine,
      end_line: endLine,
      deleted_content: lines.slice(startLine - 1, endLine).join('\n'),
      instructions,
      code_edit: editedContent,
      message: `Delete lines ${startLine}-${endLine} queued for review`
    };
  }

  async createFile(filePath, content) {
    const resolved = this.resolvePath(filePath);
    const dir = path.dirname(resolved);
    
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
    
    return { 
      success: true, 
      path: resolved, 
      message: `Created ${path.basename(resolved)}` 
    };
  }

  async runCommand(command) {
    try {
      const output = execSync(command, {
        cwd: this.cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: { ...process.env }
      });
      
      return { output, exitCode: 0, success: true };
    } catch (err) {
      return {
        output: err.stdout || err.stderr || '',
        exitCode: err.status || 1,
        success: false,
        error: err.message
      };
    }
  }

  async deleteFile(filePath) {
    const resolved = this.resolvePath(filePath);
    await fs.unlink(resolved);
    return {
      success: true,
      path: resolved,
      message: `Deleted ${path.basename(resolved)}`
    };
  }

  // ============================================================================
  // BRAIN TOOLS - Access COSMO brain knowledge
  // ============================================================================

  async brainSearch(query, limit = 15) {
    try {
      const brain = await this._loadBrainState();
      if (!brain) return { error: 'No brain loaded.' };

      const { BrainQueryEngine } = require('../lib/brain-query-engine');
      const qe = new BrainQueryEngine(this.brainPath, process.env.OPENAI_API_KEY);

      const safeLimit = Math.min(Math.max(1, limit || 15), 100);
      const results = await qe.queryEngine.queryMemory(brain.state, query, {
        limit: safeLimit,
        includeConnected: true,
        useSemanticSearch: true
      });

      return {
        success: true,
        query,
        count: results.length,
        nodes: results.map(n => ({
          id: n.id,
          score: Math.round(n.score * 100) / 100,
          tag: n.tag,
          concept: (n.concept || '').substring(0, 2000),
          connected: n.connected || false
        }))
      };
    } catch (error) {
      console.error('[BRAIN SEARCH] Error:', error);
      return { error: `Brain search failed: ${error.message}` };
    }
  }

  async brainNode(nodeId) {
    try {
      const brain = await this._loadBrainState();
      if (!brain) return { error: 'No brain loaded.' };

      const node = brain.nodes.find(n => String(n.id) === String(nodeId));
      if (!node) return { error: `Node ${nodeId} not found.` };

      const connections = [];
      brain.edges.forEach(e => {
        if (String(e.source) === String(nodeId)) connections.push({ direction: 'outgoing', target: e.target });
        if (String(e.target) === String(nodeId)) connections.push({ direction: 'incoming', source: e.source });
      });

      return {
        success: true,
        node: {
          id: node.id,
          concept: node.concept,
          tag: node.tag,
          created: node.created,
          activation: node.activation,
          weight: node.weight
        },
        connections: connections.slice(0, 20),
        total_connections: connections.length
      };
    } catch (error) {
      console.error('[BRAIN NODE] Error:', error);
      return { error: `Brain node lookup failed: ${error.message}` };
    }
  }

  async brainThoughts(query, limit = 15) {
    try {
      const brain = await this._loadBrainState();
      if (!brain) return { error: 'No brain loaded.' };

      const { BrainQueryEngine } = require('../lib/brain-query-engine');
      const qe = new BrainQueryEngine(this.brainPath, process.env.OPENAI_API_KEY);

      const thoughts = await qe.queryEngine.loadThoughts();
      const results = await qe.queryEngine.queryThoughts(thoughts, query, { limit: limit || 15 });

      return {
        success: true,
        query,
        count: results.length,
        thoughts: results.map(t => ({
          cycle: t.cycle,
          thought: (t.thought || '').substring(0, 1500),
          goal: t.goal,
          surprise: t.surprise,
          score: Math.round(t.score * 100) / 100
        }))
      };
    } catch (error) {
      console.error('[BRAIN THOUGHTS] Error:', error);
      return { error: `Brain thoughts search failed: ${error.message}` };
    }
  }

  async brainCoordinatorInsights() {
    try {
      const brain = await this._loadBrainState();
      if (!brain) return { error: 'No brain loaded.' };

      const { BrainQueryEngine } = require('../lib/brain-query-engine');
      const qe = new BrainQueryEngine(this.brainPath, process.env.OPENAI_API_KEY);

      const report = await qe.queryEngine.getLatestReport();
      if (!report) return { success: true, has_report: false };

      return {
        success: true,
        has_report: true,
        filename: report.filename,
        content: report.content.substring(0, 8000)
      };
    } catch (error) {
      console.error('[BRAIN COORDINATOR] Error:', error);
      return { error: `Failed to get coordinator insights: ${error.message}` };
    }
  }

  async brainStats() {
    try {
      const brain = await this._loadBrainState();
      if (!brain) return { error: 'No brain loaded.' };

      const tagCounts = {};
      brain.nodes.forEach(n => {
        const tags = Array.isArray(n.tag) ? n.tag : [n.tag];
        tags.forEach(t => t && (tagCounts[t] = (tagCounts[t] || 0) + 1));
      });

      return {
        success: true,
        nodes: brain.nodes.length,
        edges: brain.edges.length,
        cycles: brain.state.cycleCount || 0,
        domain: brain.state.domain || brain.state.runMetadata?.domain,
        top_tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)
      };
    } catch (error) {
      console.error('[BRAIN STATS] Error:', error);
      return { error: `Brain stats failed: ${error.message}` };
    }
  }
}

module.exports = {
  toolDefinitions,
  anthropicTools,
  ToolExecutor
};
