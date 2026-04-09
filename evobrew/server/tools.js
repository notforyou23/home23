/**
 * AI Tools - Function Calling Implementation
 * Clean, modular, production-ready
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mammoth = require('mammoth');
const docx = require('docx');
const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, Table, TableRow, TableCell, WidthType } = docx;
const XLSX = require('xlsx');
const MsgReader = require('msgreader').default || require('msgreader');
const { getQueryEngine, getBrainLoader } = require('./brain-loader-module');
const { getTerminalSessionManager } = require('./terminal/session-manager');

// ============================================================================
// TOOL DEFINITIONS (OpenAI/Anthropic Format)
// ============================================================================

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read contents of a file. Use before editing or analyzing code. Supports text files, Office documents (.docx, .xlsx), and Outlook messages (.msg).',
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
      name: 'terminal_open',
      description: 'Open a real PTY terminal session for interactive command execution.',
      parameters: {
        type: 'object',
        properties: {
          client_id: {
            type: 'string',
            description: 'Terminal client id to scope sessions (optional; defaults to current client)'
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the terminal (optional)'
          },
          shell: {
            type: 'string',
            description: 'Shell executable path (optional)'
          },
          cols: {
            type: 'number',
            description: 'Terminal width in columns (optional)'
          },
          rows: {
            type: 'number',
            description: 'Terminal height in rows (optional)'
          },
          name: {
            type: 'string',
            description: 'Friendly session name (optional)'
          },
          persistent: {
            type: 'boolean',
            description: 'Whether session should persist after command completion (optional, default true)'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal_write',
      description: 'Write keystrokes/commands to a terminal session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Target terminal session id'
          },
          client_id: {
            type: 'string',
            description: 'Terminal client id to validate ownership (optional)'
          },
          data: {
            type: 'string',
            description: 'Raw bytes/text to write to terminal input'
          }
        },
        required: ['session_id', 'data'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal_wait',
      description: 'Wait for terminal output pattern or timeout and return buffered output.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Target terminal session id'
          },
          client_id: {
            type: 'string',
            description: 'Terminal client id to validate ownership (optional)'
          },
          wait_for: {
            type: 'string',
            description: 'String/marker to wait for in terminal output (optional)'
          },
          wait_for_exit: {
            type: 'boolean',
            description: 'Resolve when terminal process exits (optional)'
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in milliseconds (optional; default 30000)'
          },
          max_output_bytes: {
            type: 'number',
            description: 'Maximum output bytes to collect (optional)'
          }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal_resize',
      description: 'Resize a terminal session viewport.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Target terminal session id'
          },
          client_id: {
            type: 'string',
            description: 'Terminal client id to validate ownership (optional)'
          },
          cols: {
            type: 'number',
            description: 'New width in columns'
          },
          rows: {
            type: 'number',
            description: 'New height in rows'
          }
        },
        required: ['session_id', 'cols', 'rows'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal_close',
      description: 'Close/terminate a terminal session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Target terminal session id'
          },
          client_id: {
            type: 'string',
            description: 'Terminal client id to validate ownership (optional)'
          }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'terminal_list',
      description: 'List terminal sessions available to current terminal client id.',
      parameters: {
        type: 'object',
        properties: {
          client_id: {
            type: 'string',
            description: 'Terminal client id to scope sessions (optional)'
          }
        },
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
  {
    type: 'function',
    function: {
      name: 'create_image',
      description: 'Generate high-quality images using GPT-Image-1.5. Best for photorealistic, artistic, or illustrative images. Always create detailed, specific prompts.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed, specific image description. ALWAYS include: 1) Subject/main focus, 2) Style (e.g. photorealistic, digital art, watercolor), 3) Composition/perspective, 4) Lighting/atmosphere, 5) Colors/mood, 6) Quality descriptors (high detail, 4K, professional). Example: "A photorealistic portrait of a golden retriever puppy, close-up shot, soft natural lighting, warm sunset background, shallow depth of field, high detail, professional photography"'
          },
          file_path: {
            type: 'string',
            description: 'Path where to save the generated image (must end in .png)'
          },
          size: {
            type: 'string',
            enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
            description: 'Image size - default 1536x1024 (landscape HD). Use 1024x1536 for portrait, 1024x1024 for square'
          },
          quality: {
            type: 'string',
            enum: ['auto', 'high', 'standard'],
            description: 'Image quality - default "high" for best detail. Use "standard" for faster generation'
          }
        },
        required: ['prompt', 'file_path', 'size', 'quality'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description: 'Edit existing images using GPT-Image-1.5. Can modify images, combine multiple reference images, or use masks for precise editing (inpainting). Perfect for iterative refinements, style changes, or adding/removing elements.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of how to edit the image. Be specific about what changes to make. Example: "Add a sunset sky in the background" or "Replace the blue car with a red sports car"'
          },
          input_images: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of image file paths to use as input. First image is primary (highest fidelity). Can provide multiple images to combine or reference.'
          },
          output_path: {
            type: 'string',
            description: 'Path where to save the edited image (must end in .png)'
          },
          mask_image: {
            type: 'string',
            description: 'Path to mask image (PNG with alpha channel) for targeted editing. White areas = edit, black areas = preserve. Use empty string "" if no mask needed.'
          },
          input_fidelity: {
            type: 'string',
            enum: ['low', 'high'],
            description: 'Input fidelity - "high" preserves details like faces/logos. Use "high" for best results.'
          },
          size: {
            type: 'string',
            enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
            description: 'Output size - use "1536x1024" for landscape, "1024x1536" for portrait'
          },
          quality: {
            type: 'string',
            enum: ['auto', 'high', 'standard'],
            description: 'Quality - use "high" for best detail'
          }
        },
        required: ['prompt', 'input_images', 'output_path', 'mask_image', 'input_fidelity', 'size', 'quality'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_docx',
      description: 'Create or edit a Word document (.docx). Can create new documents with formatted text, headings, tables, and lists.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path where to save the document (e.g., "report.docx")'
          },
          content: {
            type: 'object',
            description: 'Document content with structure',
            properties: {
              title: {
                type: 'string',
                description: 'Document title (optional, use empty string if not needed)'
              },
              sections: {
                type: 'array',
                description: 'Array of sections/paragraphs',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['heading1', 'heading2', 'heading3', 'paragraph', 'table'],
                      description: 'Type of content'
                    },
                    text: {
                      type: 'string',
                      description: 'Text content (for paragraphs and headings, use empty string for tables)'
                    },
                    table: {
                      type: 'object',
                      description: 'Table data (for type: table, use null for non-tables)',
                      properties: {
                        headers: {
                          type: 'array',
                          items: { type: 'string' }
                        },
                        rows: {
                          type: 'array',
                          items: {
                            type: 'array',
                            items: { type: 'string' }
                          }
                        }
                      },
                      required: ['headers', 'rows'],
                      additionalProperties: false
                    }
                  },
                  required: ['type', 'text', 'table'],
                  additionalProperties: false
                }
              }
            },
            required: ['title', 'sections'],
            additionalProperties: false
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
      name: 'create_xlsx',
      description: 'Create or edit an Excel spreadsheet (.xlsx). Can create new spreadsheets with multiple sheets, data, and formulas.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path where to save the spreadsheet (e.g., "data.xlsx")'
          },
          sheets: {
            type: 'array',
            description: 'Array of sheets to create',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Sheet name'
                },
                data: {
                  type: 'array',
                  description: 'Array of rows (each row is array of cells)',
                  items: {
                    type: 'array',
                    items: {
                      type: 'string',
                      description: 'Cell value (string, number, or formula like "=A1+B1")'
                    }
                  }
                }
              },
              required: ['name', 'data'],
              additionalProperties: false
            }
          }
        },
        required: ['file_path', 'sheets'],
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
            description: 'Maximum results to return (default 15, max 30)'
          }
        },
        // NOTE: Some provider tool-schema validators require `required` to include *all* keys in `properties`.
        // We keep `limit` effectively optional at runtime by defaulting it when not provided.
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
            description: 'Maximum results (default 15)'
          }
        },
        // NOTE: Some provider tool-schema validators require `required` to include *all* keys in `properties`.
        // We keep `limit` effectively optional at runtime by defaulting it when not provided.
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
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run project tests or syntax-check a specific file. Use after creating or editing files to verify changes work correctly. Defaults to npm test if no arguments given.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Custom test command to run (default: npm test)'
          },
          file: {
            type: 'string',
            description: 'Specific file to syntax-check with node --check'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'progress_update',
      description: 'Update the project progress file to document what was accomplished. Call at the end of your work session so future sessions know the current state.',
      parameters: {
        type: 'object',
        properties: {
          completed: {
            type: 'string',
            description: 'What was completed this session'
          },
          state: {
            type: 'string',
            description: 'Current state of the project/task'
          },
          next_steps: {
            type: 'string',
            description: 'What should be done next'
          }
        },
        required: ['completed', 'state'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_create',
      description: 'Create a structured execution plan. Use this in planning mode to propose a plan with clear steps. The plan will be shown to the user for approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the plan' },
          steps: {
            type: 'array',
            description: 'Ordered list of steps to execute',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short step description' },
                description: { type: 'string', description: 'Detailed explanation of what this step does' },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Files this step will read or modify'
                }
              },
              required: ['label']
            }
          }
        },
        required: ['title', 'steps'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_update',
      description: 'Update a step in the active plan. Use to modify a step label, description, or files before execution.',
      parameters: {
        type: 'object',
        properties: {
          step_id: { type: 'string', description: 'Step ID to update (e.g., "step-1")' },
          label: { type: 'string', description: 'New step label' },
          description: { type: 'string', description: 'New step description' },
          files: { type: 'array', items: { type: 'string' }, description: 'Updated file list' }
        },
        required: ['step_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_status',
      description: 'Report progress on a plan step during execution. Call with "running" when starting a step and "done" or "failed" when finished.',
      parameters: {
        type: 'object',
        properties: {
          step_id: { type: 'string', description: 'Step ID (e.g., "step-1")' },
          status: { type: 'string', enum: ['running', 'done', 'failed', 'skipped'], description: 'New status for the step' },
          message: { type: 'string', description: 'Optional status message or error detail' }
        },
        required: ['step_id', 'status'],
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
  constructor(codebaseIndexer, workingDirectory, allowedRoot = null, options = {}) {
    this.indexer = codebaseIndexer;
    this.cwd = workingDirectory || process.cwd();
    this.allowedRoot = allowedRoot; // Security boundary - if set, restrict file access to this directory
    this.allowedToolNames = Array.isArray(options.allowedToolNames) && options.allowedToolNames.length > 0
      ? new Set(options.allowedToolNames)
      : null;
    this.disableSpreadsheetParsing = options.disableSpreadsheetParsing === true;
    this.terminalManager = options.terminalManager || getTerminalSessionManager();
    this.terminalPolicy = {
      enabled: options.terminalPolicy?.enabled !== false,
      allowedRoot: options.terminalPolicy?.allowedRoot || null,
      defaultClientId: typeof options.terminalPolicy?.defaultClientId === 'string' && options.terminalPolicy.defaultClientId.trim()
        ? options.terminalPolicy.defaultClientId.trim()
        : 'ai'
    };
    this.toolNames = new Set(toolDefinitions.map((tool) => tool.function.name));
    // Track proposed edits so file_read returns agent's own pending changes, not stale disk state
    this.pendingFileContents = new Map();
  }

  // Record a pending edit so subsequent file_read calls return the proposed content
  trackPendingEdit(filePath, content) {
    const resolved = path.resolve(filePath);
    this.pendingFileContents.set(resolved, content);
  }

  // Read file content, preferring pending edits over disk state
  async readFileContent(resolvedPath) {
    if (this.pendingFileContents.has(resolvedPath)) {
      return this.pendingFileContents.get(resolvedPath);
    }
    return await fs.readFile(resolvedPath, 'utf-8');
  }

  // Cap long output to prevent context flooding (keeps 60% start + 40% end)
  static capOutput(text, maxLen = 20000) {
    if (!text || text.length <= maxLen) return text;
    const keepStart = Math.floor(maxLen * 0.6);
    const keepEnd = maxLen - keepStart;
    return text.slice(0, keepStart) +
      `\n\n[... truncated ${text.length - maxLen} chars ...]\n\n` +
      text.slice(-keepEnd);
  }

  /**
   * Set the allowed root directory for file access
   * All file operations will be restricted to this directory
   */
  setAllowedRoot(rootPath) {
    this.allowedRoot = rootPath;
  }

  /**
   * Check if a path is within the allowed root directory
   */
  isPathAllowed(resolvedPath) {
    if (!this.allowedRoot) return true; // No restriction if no root set
    try {
      const normalized = path.resolve(resolvedPath);
      const normalizedRoot = path.resolve(this.allowedRoot);
      if (!(normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep))) {
        return false;
      }

      const canonicalRoot = this.resolveCanonicalPathForBoundary(normalizedRoot);
      const canonicalTarget = this.resolveCanonicalPathForBoundary(normalized);
      return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(canonicalRoot + path.sep);
    } catch (e) {
      return false;
    }
  }

  resolvePath(inputPath) {
    if (typeof inputPath !== 'string' || inputPath.trim() === '') {
      throw new Error('Path must be a non-empty string');
    }
    if (inputPath.includes('\0')) {
      throw new Error('Invalid path: null byte not allowed');
    }
    if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
    if (inputPath === '.') return path.resolve(this.cwd);
    return path.resolve(this.cwd, inputPath);
  }

  resolveCanonicalPathForBoundary(resolvedPath) {
    let candidate = path.resolve(resolvedPath);

    // For non-existent targets (create/write), walk up to nearest existing parent.
    while (!fsSync.existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }

    return fsSync.realpathSync(candidate);
  }

  isToolAllowed(toolName) {
    const normalizedToolName = this.normalizeToolName(toolName);
    if (!this.allowedToolNames) return true;
    return this.allowedToolNames.has(normalizedToolName);
  }

  normalizeToolName(toolName) {
    const value = typeof toolName === 'string' ? toolName.trim() : '';
    if (!value) return '';
    if (this.toolNames.has(value)) return value;

    const candidates = [value];
    const seen = new Set();
    const prefixPattern = /^(?:mshtools|mcp|tool|tools|function|functions)[._:-]+/i;

    while (candidates.length > 0) {
      const candidate = candidates.shift();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);

      if (this.toolNames.has(candidate)) return candidate;

      const strippedPrefix = candidate.replace(prefixPattern, '');
      if (strippedPrefix && strippedPrefix !== candidate) {
        candidates.push(strippedPrefix);
      }

      const tailSegment = candidate.split(/[.:/]/).pop();
      if (tailSegment && tailSegment !== candidate) {
        candidates.push(tailSegment);
      }
    }

    return value;
  }

  /**
   * Resolve path and validate it's within allowed root
   * Throws error if path is outside allowed directory
   */
  resolveAndValidatePath(inputPath) {
    const resolved = this.resolvePath(inputPath);
    if (!this.isPathAllowed(resolved)) {
      throw new Error(`Access denied: path outside allowed directory`);
    }
    return resolved;
  }

  normalizeToolArgs(toolName, rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};

    const pickFirstString = (...values) => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return String(value);
        }
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return '';
    };

    const pickFirstNumber = (...values) => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === 'string' && value.trim() !== '') {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
      return undefined;
    };

    switch (toolName) {
      case 'file_read':
      case 'delete_file':
      case 'read_image':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file);
        break;
      case 'list_directory':
        args.directory_path = pickFirstString(args.directory_path, args.path, args.directory, args.folder, args.folder_path, args.cwd) || '.';
        break;
      case 'grep_search':
        args.pattern = pickFirstString(args.pattern, args.query, args.search, args.text);
        args.path = pickFirstString(args.path, args.directory_path, args.directory, args.folder, args.folder_path) || '.';
        break;
      case 'codebase_search':
      case 'brain_search':
      case 'brain_thoughts':
        args.query = pickFirstString(args.query, args.search, args.prompt, args.topic, args.text);
        args.limit = pickFirstNumber(args.limit, args.max_results, args.maxResults, args.count);
        break;
      case 'brain_node':
        args.node_id = pickFirstString(args.node_id, args.id, args.nodeId);
        break;
      case 'edit_file':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file);
        args.instructions = pickFirstString(args.instructions, args.instruction, args.prompt, args.request);
        if (typeof args.code_edit !== 'string' && typeof args.content === 'string') {
          args.code_edit = args.content;
        }
        break;
      case 'edit_file_range':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file);
        args.start_line = pickFirstNumber(args.start_line, args.startLine, args.from_line, args.fromLine);
        args.end_line = pickFirstNumber(args.end_line, args.endLine, args.to_line, args.toLine);
        if (typeof args.new_content !== 'string' && typeof args.content === 'string') {
          args.new_content = args.content;
        }
        args.instructions = pickFirstString(args.instructions, args.instruction, args.prompt, args.request);
        break;
      case 'search_replace':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file);
        args.old_string = pickFirstString(args.old_string, args.search, args.search_text, args.find);
        args.new_string = pickFirstString(args.new_string, args.replace, args.replace_text, args.replacement);
        args.instructions = pickFirstString(args.instructions, args.instruction, args.prompt, args.request);
        break;
      case 'insert_lines':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file);
        args.line_number = pickFirstNumber(args.line_number, args.lineNumber, args.line, args.after_line, args.afterLine);
        args.content = pickFirstString(args.content, args.new_content, args.text);
        args.instructions = pickFirstString(args.instructions, args.instruction, args.prompt, args.request);
        break;
      case 'delete_lines':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file);
        args.start_line = pickFirstNumber(args.start_line, args.startLine, args.from_line, args.fromLine);
        args.end_line = pickFirstNumber(args.end_line, args.endLine, args.to_line, args.toLine);
        args.instructions = pickFirstString(args.instructions, args.instruction, args.prompt, args.request);
        break;
      case 'create_file':
      case 'create_docx':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file, args.output_path);
        if (typeof args.content !== 'string') {
          args.content = pickFirstString(args.content, args.text);
        }
        break;
      case 'create_xlsx':
        args.file_path = pickFirstString(args.file_path, args.path, args.filename, args.file, args.output_path);
        break;
      case 'run_terminal':
        args.command = pickFirstString(args.command, args.cmd, args.shell_command, args.script);
        break;
      case 'run_tests':
        args.command = pickFirstString(args.command, args.cmd, args.script);
        args.file = pickFirstString(args.file, args.file_path, args.path, args.filename);
        break;
      default:
        break;
    }

    return args;
  }

  async execute(toolName, args) {
    const normalizedToolName = this.normalizeToolName(toolName);
    const normalizedArgs = this.normalizeToolArgs(normalizedToolName, args);
    console.log(`[TOOL] ${normalizedToolName}(${JSON.stringify(normalizedArgs).substring(0, 100)}...)`);

    if (!this.isToolAllowed(normalizedToolName)) {
      return {
        error: `Tool "${normalizedToolName || toolName}" is disabled by security policy in this deployment profile`
      };
    }
    
    try {
      switch (normalizedToolName) {
        case 'file_read':
          return await this.readFile(normalizedArgs.file_path);
          
        case 'list_directory':
          return await this.listDirectory(normalizedArgs.directory_path);
          
        case 'grep_search':
          return await this.grepSearch(normalizedArgs.pattern, normalizedArgs.path);
          
        case 'codebase_search':
          return await this.codebaseSearch(normalizedArgs.query, normalizedArgs.limit);
          
        case 'edit_file':
          return this.queueEdit(normalizedArgs.file_path, normalizedArgs.instructions, normalizedArgs.code_edit);
          
        case 'edit_file_range':
          return await this.queueEditRange(normalizedArgs.file_path, normalizedArgs.start_line, normalizedArgs.end_line, normalizedArgs.new_content, normalizedArgs.instructions);
          
        case 'search_replace':
          return await this.queueSearchReplace(normalizedArgs.file_path, normalizedArgs.old_string, normalizedArgs.new_string, normalizedArgs.instructions);
          
        case 'insert_lines':
          return await this.queueInsertLines(normalizedArgs.file_path, normalizedArgs.line_number, normalizedArgs.content, normalizedArgs.instructions);
          
        case 'delete_lines':
          return await this.queueDeleteLines(normalizedArgs.file_path, normalizedArgs.start_line, normalizedArgs.end_line, normalizedArgs.instructions);
          
        case 'create_file':
          return await this.createFile(normalizedArgs.file_path, normalizedArgs.content);

        case 'terminal_open':
          return await this.terminalOpen(normalizedArgs);

        case 'terminal_write':
          return await this.terminalWrite(normalizedArgs);

        case 'terminal_wait':
          return await this.terminalWait(normalizedArgs);

        case 'terminal_resize':
          return await this.terminalResize(normalizedArgs);

        case 'terminal_close':
          return await this.terminalClose(normalizedArgs);

        case 'terminal_list':
          return await this.terminalList(normalizedArgs);
          
        case 'run_terminal':
          return await this.runCommand(normalizedArgs.command);
          
        case 'delete_file':
          return await this.deleteFile(normalizedArgs.file_path);
          
        case 'read_image':
          return await this.readImage(normalizedArgs.file_path);

        case 'create_image':
          return await this.createImage(args.prompt, args.file_path, args.size, args.quality);

        case 'edit_image':
          return await this.editImage(args.prompt, args.input_images, args.output_path, args.mask_image, args.input_fidelity, args.size, args.quality);

        case 'create_docx':
          return await this.createDocx(normalizedArgs.file_path, normalizedArgs.content);
          
        case 'create_xlsx':
          return await this.createXlsx(normalizedArgs.file_path, normalizedArgs.sheets);

        // Brain tools
        case 'brain_search':
          return await this.brainSearch(normalizedArgs.query, normalizedArgs.limit);
        case 'brain_node':
          return await this.brainNode(normalizedArgs.node_id);
        case 'brain_thoughts':
          return await this.brainThoughts(normalizedArgs.query, normalizedArgs.limit);
        case 'brain_coordinator_insights':
          return await this.brainCoordinatorInsights();
        case 'brain_stats':
          return await this.brainStats();

        case 'run_tests':
          return await this.runTests(normalizedArgs.command, normalizedArgs.file);

        case 'progress_update':
          return await this.progressUpdate(normalizedArgs.completed, normalizedArgs.state, normalizedArgs.next_steps);

        case 'plan_create':
          return this.planCreate(normalizedArgs.title, normalizedArgs.steps);

        case 'plan_update':
          return this.planUpdate(normalizedArgs.step_id, normalizedArgs);

        case 'plan_status':
          return this.planStatus(normalizedArgs.step_id, normalizedArgs.status, normalizedArgs.message);

        default:
          return { error: `Unknown tool: ${normalizedToolName || toolName}` };
      }
    } catch (error) {
      console.error(`[TOOL ERROR] ${toolName}:`, error.message);
      return { error: error.message };
    }
  }

  async readFile(filePath) {
    const resolved = this.resolveAndValidatePath(filePath);

    // Return pending edit content if agent has already proposed changes to this file
    if (this.pendingFileContents.has(resolved)) {
      return {
        content: this.pendingFileContents.get(resolved),
        path: resolved,
        pending_edit: true,
        note: 'This is your proposed edit, not yet saved to disk.'
      };
    }

    const ext = path.extname(resolved).toLowerCase();

    // Handle Office file formats
    if (ext === '.docx') {
      return await this.readDocx(resolved);
    } else if (ext === '.xlsx' || ext === '.xls') {
      if (this.disableSpreadsheetParsing) {
        return {
          error: 'Spreadsheet parsing is disabled in this deployment profile.',
          path: resolved
        };
      }
      return await this.readExcel(resolved);
    } else if (ext === '.msg') {
      return await this.readMsg(resolved);
    }
    
    // Default: read as text
    try {
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n').length;
    return { 
      content, 
      path: resolved,
      lines,
      size: content.length 
    };
    } catch (error) {
      // If UTF-8 fails, it might be a binary file
      if (error.code === 'ENOENT') {
        throw error;
      }
      return {
        error: `Cannot read file as text. File may be binary or encoded differently. Error: ${error.message}`,
        path: resolved
      };
    }
  }

  async readDocx(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      
      // Extract text with comments
      const options = {
        includeDefaultStyleMap: true,
        styleMap: [
          "comment-reference => sup[comment]"
        ]
      };
      
      const result = await mammoth.extractRawText({ buffer, ...options });
      let content = result.value;
      
      // Try to extract additional metadata/comments if available
      const htmlResult = await mammoth.convertToHtml({ buffer });
      
      // Check for comments in HTML output
      if (htmlResult.value.includes('comment')) {
        content += '\n\n--- Document Notes ---';
        content += '\n(Some comments or annotations may be present in the original document)';
      }
      
      const lines = content.split('\n').length;
      
      return {
        content,
        path: filePath,
        lines,
        size: content.length,
        format: 'docx',
        warnings: result.messages.length > 0 ? result.messages.map(m => m.message) : undefined
      };
    } catch (error) {
      return {
        error: `Failed to read DOCX file: ${error.message}`,
        path: filePath
      };
    }
  }

  async readExcel(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellStyles: true });
      
      let content = '';
      const sheetData = [];
      let hasFormulas = false;
      let hasComments = false;
      
      workbook.SheetNames.forEach((sheetName, index) => {
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
        const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
        
        sheetData.push({
          name: sheetName,
          rows: jsonData.length,
          columns: jsonData[0]?.length || 0
        });
        
        // Convert to readable text format
        content += `\n=== Sheet: ${sheetName} ===\n\n`;
        
        jsonData.forEach((row, rowIndex) => {
          if (row.some(cell => cell !== '')) { // Skip completely empty rows
            const rowText = row.map((cell, colIndex) => {
              const cellValue = cell === null || cell === undefined ? '' : String(cell);
              
              // Check for formula in this cell
              const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
              const cellObj = worksheet[cellRef];
              
              if (cellObj && cellObj.f) {
                hasFormulas = true;
                return `${cellValue} [=${cellObj.f}]`;
              }
              
              if (cellObj && cellObj.c) {
                hasComments = true;
              }
              
              return cellValue.replace(/\t/g, ' ').replace(/\n/g, ' ');
            }).join(' | ');
            content += `${rowText}\n`;
          }
        });
        
        // Add comments if present
        if (worksheet['!comments']) {
          content += '\n--- Comments ---\n';
          hasComments = true;
          // Process comments
        }
        
        content += '\n';
      });
      
      if (hasFormulas) {
        content += '\n--- NOTE: Cells with formulas show both value and formula [=FORMULA] ---\n';
      }
      
      if (hasComments) {
        content += '\n--- NOTE: This spreadsheet contains cell comments ---\n';
      }
      
      const lines = content.split('\n').length;
      
      return {
        content: content.trim(),
        path: filePath,
        lines,
        size: content.length,
        format: path.extname(filePath).toLowerCase(),
        sheets: sheetData,
        sheetCount: workbook.SheetNames.length,
        hasFormulas,
        hasComments
      };
    } catch (error) {
      return {
        error: `Failed to read Excel file: ${error.message}`,
        path: filePath
      };
    }
  }

  async readMsg(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      // Convert Buffer to ArrayBuffer for msgreader
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const msgReader = new MsgReader(arrayBuffer);
      const msg = msgReader.getFileData();
      
      // Check for error
      if (msg.error) {
        return {
          error: msg.error,
          path: filePath
        };
      }
      
      let content = '';
      
      // Extract key information from fieldsData
      // The structure may vary, so we'll try common field names
      const getField = (fieldName) => {
        if (!msg || typeof msg !== 'object') return null;
        // Try direct property access
        if (msg[fieldName] !== undefined) return msg[fieldName];
        // Try lowercase
        const lowerKey = Object.keys(msg).find(k => k.toLowerCase() === fieldName.toLowerCase());
        if (lowerKey) return msg[lowerKey];
        return null;
      };
      
      const senderName = getField('senderName') || getField('from') || getField('sender');
      const senderEmail = getField('senderEmail') || getField('fromEmail');
      const subject = getField('subject');
      const to = getField('to') || getField('recipient');
      const cc = getField('cc');
      const date = getField('date') || getField('sentDate') || getField('receivedDate');
      const body = getField('body') || getField('bodyText') || getField('text');
      const bodyHtml = getField('bodyHtml') || getField('htmlBody');
      const attachments = getField('attachments') || [];
      
      if (senderName || senderEmail) {
        content += `From: ${senderName || ''}`;
        if (senderEmail) {
          content += senderName ? ` <${senderEmail}>` : senderEmail;
        }
        content += '\n';
      }
      
      if (subject) {
        content += `Subject: ${subject}\n`;
      }
      
      if (to) {
        content += `To: ${to}\n`;
      }
      
      if (cc) {
        content += `CC: ${cc}\n`;
      }
      
      if (date) {
        content += `Date: ${date}\n`;
      }
      
      content += '\n--- Message Body ---\n\n';
      
      // Extract body text
      if (body) {
        content += body;
      } else if (bodyHtml) {
        // Strip HTML tags for plain text
        content += bodyHtml.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      } else {
        content += '(No body content found)';
      }
      
      // Add attachments info if any
      const attachmentList = Array.isArray(attachments) ? attachments : [];
      if (attachmentList.length > 0) {
        content += `\n\n--- Attachments (${attachmentList.length}) ---\n`;
        attachmentList.forEach((att, idx) => {
          const fileName = (att && att.fileName) ? att.fileName : (typeof att === 'string' ? att : 'Unknown');
          const size = (att && att.contentLength) ? att.contentLength : (att && att.size) ? att.size : 'unknown size';
          content += `${idx + 1}. ${fileName} (${size} bytes)\n`;
        });
      }
      
      // If we got the raw fieldsData, include a note about available fields
      if (Object.keys(msg).length > 0 && !body && !bodyHtml) {
        content += `\n\n--- Available Fields ---\n`;
        content += `Fields found: ${Object.keys(msg).join(', ')}\n`;
        content += `Raw data structure available for inspection.\n`;
      }
      
      const lines = content.split('\n').length;
      
      return {
        content: content.trim(),
        path: filePath,
        lines,
        size: content.length,
        format: 'msg',
        hasAttachments: attachmentList.length > 0,
        attachmentCount: attachmentList.length
      };
    } catch (error) {
      return {
        error: `Failed to read MSG file: ${error.message}`,
        path: filePath
      };
    }
  }

  async readImage(filePath) {
    let resolved = this.resolveAndValidatePath(filePath);
    
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
    const resolved = this.resolveAndValidatePath(dirPath);
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
    const resolved = this.resolveAndValidatePath(searchPath);
    
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
      
      const lines = output.split('\n').filter(Boolean);
      const totalCount = lines.length;

      // Cap results at 50 — force the agent to narrow its query (SWE-agent's #1 leverage point)
      if (totalCount > 50) {
        return {
          matches: lines.slice(0, 50).join('\n'),
          count: totalCount,
          truncated: true,
          message: `Found ${totalCount} matches (showing first 50). Narrow your search pattern for more specific results.`
        };
      }

      return { matches: output, count: totalCount };
      
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
      file_path: this.resolveAndValidatePath(filePath),
      instructions,
      code_edit: codeEdit,
      message: 'Edit queued for review'
    };
  }

  async queueEditRange(filePath, startLine, endLine, newContent, instructions) {
    const resolved = this.resolveAndValidatePath(filePath);

    // Read current file (uses pending edits if agent already proposed changes)
    const content = await this.readFileContent(resolved);
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
    const resolved = this.resolveAndValidatePath(filePath);

    // Read current file (uses pending edits if agent already proposed changes)
    const content = await this.readFileContent(resolved);
    
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
    const resolved = this.resolveAndValidatePath(filePath);

    // Read current file (uses pending edits if agent already proposed changes)
    const fileContent = await this.readFileContent(resolved);
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
    const resolved = this.resolveAndValidatePath(filePath);

    // Read current file (uses pending edits if agent already proposed changes)
    const content = await this.readFileContent(resolved);
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
    const resolved = this.resolveAndValidatePath(filePath);
    const dir = path.dirname(resolved);

    // Check if file already exists — overwriting requires approval, new files write directly
    let fileExists = false;
    try {
      await fs.access(resolved);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (fileExists) {
      // OVERWRITE: Route through approval queue — user reviews before overwrite
      // Auto-validate JS/JSON before queueing
      const ext = path.extname(resolved).toLowerCase();
      let syntaxCheck = null;
      if (['.js', '.mjs', '.cjs'].includes(ext)) {
        const tmpPath = resolved + '.evobrew-check';
        try {
          await fs.writeFile(tmpPath, content, 'utf-8');
          execSync(`node --check "${tmpPath}"`, { encoding: 'utf-8', timeout: 5000 });
          syntaxCheck = { passed: true };
        } catch (err) {
          syntaxCheck = { passed: false, error: (err.stderr || err.message).trim().replace(tmpPath, resolved) };
        } finally {
          try { await fs.unlink(tmpPath); } catch { /* ignore */ }
        }
      } else if (ext === '.json') {
        try { JSON.parse(content); syntaxCheck = { passed: true }; }
        catch (err) { syntaxCheck = { passed: false, error: err.message }; }
      }

      return {
        action: 'queue_create',
        file_path: resolved,
        code_edit: content,
        message: `Overwrite of ${path.basename(resolved)} queued for review`,
        ...(syntaxCheck && { syntaxCheck })
      };
    }

    // NEW FILE: Write directly — low risk, agent needs files on disk to build on them
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');

    // Auto-validate JS/JSON after writing
    const ext = path.extname(resolved).toLowerCase();
    let syntaxCheck = null;
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      try {
        execSync(`node --check "${resolved}"`, { encoding: 'utf-8', timeout: 5000 });
        syntaxCheck = { passed: true };
      } catch (err) {
        syntaxCheck = { passed: false, error: (err.stderr || err.message).trim() };
      }
    } else if (ext === '.json') {
      try { JSON.parse(content); syntaxCheck = { passed: true }; }
      catch (err) { syntaxCheck = { passed: false, error: err.message }; }
    }

    return {
      success: true,
      path: resolved,
      message: `Created ${path.basename(resolved)}`,
      ...(syntaxCheck && { syntaxCheck })
    };
  }

  isTerminalEnabled() {
    return this.terminalPolicy.enabled !== false && this.terminalManager && typeof this.terminalManager.createSession === 'function';
  }

  getTerminalClientId(rawClientId) {
    if (typeof rawClientId === 'string' && rawClientId.trim()) {
      return rawClientId.trim();
    }
    return this.terminalPolicy.defaultClientId || 'ai';
  }

  getTerminalAllowedRoot() {
    return this.terminalPolicy.allowedRoot || null;
  }

  async terminalOpen(args = {}) {
    if (!this.isTerminalEnabled()) {
      return { error: 'Terminal feature is disabled in this deployment profile' };
    }

    const clientId = this.getTerminalClientId(args.client_id);
    const session = this.terminalManager.createSession({
      clientId,
      cwd: args.cwd || this.cwd,
      shell: args.shell,
      cols: args.cols,
      rows: args.rows,
      name: args.name,
      persistent: args.persistent !== false,
      allowedRoot: this.getTerminalAllowedRoot()
    });

    return {
      success: true,
      ...session
    };
  }

  async terminalWrite(args = {}) {
    if (!this.isTerminalEnabled()) {
      return { error: 'Terminal feature is disabled in this deployment profile' };
    }

    const clientId = this.getTerminalClientId(args.client_id);
    const result = this.terminalManager.write(args.session_id, clientId, args.data || '');
    return {
      success: true,
      ...result
    };
  }

  async terminalWait(args = {}) {
    if (!this.isTerminalEnabled()) {
      return { error: 'Terminal feature is disabled in this deployment profile' };
    }

    const clientId = this.getTerminalClientId(args.client_id);
    const result = await this.terminalManager.waitFor(args.session_id, clientId, {
      waitFor: args.wait_for || '',
      waitForExit: args.wait_for_exit === true,
      timeoutMs: args.timeout_ms,
      maxOutputBytes: args.max_output_bytes
    });

    return {
      success: true,
      ...result
    };
  }

  async terminalResize(args = {}) {
    if (!this.isTerminalEnabled()) {
      return { error: 'Terminal feature is disabled in this deployment profile' };
    }

    const clientId = this.getTerminalClientId(args.client_id);
    const result = this.terminalManager.resize(args.session_id, clientId, args.cols, args.rows);
    return {
      success: true,
      ...result
    };
  }

  async terminalClose(args = {}) {
    if (!this.isTerminalEnabled()) {
      return { error: 'Terminal feature is disabled in this deployment profile' };
    }

    const clientId = this.getTerminalClientId(args.client_id);
    const result = this.terminalManager.closeSession(args.session_id, clientId, {
      force: true,
      reason: 'tool-close'
    });
    return {
      success: true,
      ...result
    };
  }

  async terminalList(args = {}) {
    if (!this.isTerminalEnabled()) {
      return { error: 'Terminal feature is disabled in this deployment profile' };
    }

    const clientId = this.getTerminalClientId(args.client_id);
    const sessions = this.terminalManager.listSessions(clientId);
    return {
      success: true,
      client_id: clientId,
      count: sessions.length,
      sessions
    };
  }

  async runCommand(command) {
    const commandText = String(command || '').trim();
    if (!commandText) {
      return {
        output: '',
        exitCode: 1,
        success: false,
        error: 'Command must be a non-empty string',
        session_id: null,
        truncated: false,
        timedOut: false
      };
    }

    if (this.isTerminalEnabled()) {
      try {
        const result = await this.terminalManager.runCompatibilityCommand({
          clientId: this.getTerminalClientId(),
          cwd: this.cwd,
          command: commandText,
          timeoutMs: 30_000,
          allowedRoot: this.getTerminalAllowedRoot()
        });
        if (result.output) result.output = ToolExecutor.capOutput(result.output);
        return result;
      } catch (error) {
        console.warn('[TOOL] run_terminal PTY fallback to execSync:', error.message);
      }
    }

    try {
      let output = execSync(commandText, {
        cwd: this.cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: { ...process.env }
      });

      const wasTruncated = output.length > 20000;
      output = ToolExecutor.capOutput(output);

      return {
        output,
        exitCode: 0,
        success: true,
        session_id: null,
        truncated: wasTruncated,
        timedOut: false
      };
    } catch (err) {
      let errOutput = err.stdout || err.stderr || '';
      errOutput = ToolExecutor.capOutput(errOutput);
      return {
        output: errOutput,
        exitCode: err.status || 1,
        success: false,
        error: err.message,
        session_id: null,
        truncated: false,
        timedOut: false
      };
    }
  }

  async runTests(command, file) {
    if (file) {
      // Syntax-check a specific file
      const resolved = this.resolveAndValidatePath(file);
      try {
        execSync(`node --check "${resolved}"`, { encoding: 'utf-8', timeout: 10000 });
        return { success: true, file: resolved, message: 'Syntax check passed' };
      } catch (err) {
        return { success: false, file: resolved, error: (err.stderr || err.message).trim() };
      }
    }

    // Run test command (default: npm test)
    const testCmd = command || 'npm test';
    return await this.runCommand(testCmd);
  }

  async progressUpdate(completed, state, nextSteps) {
    const progressPath = this.resolveAndValidatePath('cosmo-progress.md');
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];

    const entry = `## ${timestamp}\n\n**Completed:** ${completed}\n**State:** ${state}${nextSteps ? `\n**Next steps:** ${nextSteps}` : ''}\n\n---\n\n`;

    let existing = '';
    try {
      existing = await fs.readFile(progressPath, 'utf-8');
    } catch {
      // File doesn't exist yet — that's fine
    }

    await fs.writeFile(progressPath, entry + existing, 'utf-8');
    return { success: true, path: progressPath, message: 'Progress updated' };
  }

  // ── Plan Management ──────────────────────────────────────────────────

  planCreate(title, steps) {
    const planId = 'plan-' + Date.now();
    const structuredSteps = (steps || []).map((s, i) => ({
      id: `step-${i + 1}`,
      label: s.label,
      description: s.description || '',
      files: s.files || [],
      status: 'pending'
    }));

    this.activePlan = {
      id: planId,
      title: title || 'Plan',
      steps: structuredSteps,
      state: 'draft',
      createdAt: new Date().toISOString()
    };

    return {
      action: 'plan_created',
      planId,
      title: this.activePlan.title,
      stepCount: structuredSteps.length,
      steps: structuredSteps
    };
  }

  planUpdate(stepId, changes) {
    if (!this.activePlan) return { error: 'No active plan' };
    const step = this.activePlan.steps.find(s => s.id === stepId);
    if (!step) return { error: `Step ${stepId} not found` };

    if (changes.label) step.label = changes.label;
    if (changes.description) step.description = changes.description;
    if (changes.files) step.files = changes.files;

    return {
      action: 'plan_updated',
      stepId,
      step
    };
  }

  planStatus(stepId, status, message) {
    if (!this.activePlan) return { error: 'No active plan' };
    const step = this.activePlan.steps.find(s => s.id === stepId);
    if (!step) return { error: `Step ${stepId} not found` };

    step.status = status;
    if (message) step.message = message;

    // Check if all steps are done
    const allDone = this.activePlan.steps.every(s =>
      s.status === 'done' || s.status === 'skipped' || s.status === 'failed'
    );
    if (allDone) this.activePlan.state = 'complete';

    return {
      action: 'plan_step_status',
      stepId,
      status,
      message: message || null,
      planState: this.activePlan.state
    };
  }

  getPlanState() {
    return this.activePlan || null;
  }

  async deleteFile(filePath) {
    const resolved = this.resolveAndValidatePath(filePath);
    await fs.unlink(resolved);
    return { 
      success: true, 
      path: resolved, 
      message: `Deleted ${path.basename(resolved)}` 
    };
  }

  async createDocx(filePath, content) {
    try {
      const resolved = this.resolveAndValidatePath(filePath);
      const dir = path.dirname(resolved);
      await fs.mkdir(dir, { recursive: true });
      
      const children = [];
      
      // Add title if provided
      if (content.title) {
        children.push(
          new Paragraph({
            text: content.title,
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER
          })
        );
      }
      
      // Process sections
      if (content.sections && Array.isArray(content.sections)) {
        for (const section of content.sections) {
          if (section.type === 'heading1') {
            children.push(
              new Paragraph({
                text: section.text || '',
                heading: HeadingLevel.HEADING_1
              })
            );
          } else if (section.type === 'heading2') {
            children.push(
              new Paragraph({
                text: section.text || '',
                heading: HeadingLevel.HEADING_2
              })
            );
          } else if (section.type === 'heading3') {
            children.push(
              new Paragraph({
                text: section.text || '',
                heading: HeadingLevel.HEADING_3
              })
            );
          } else if (section.type === 'paragraph') {
            children.push(
              new Paragraph({
                text: section.text || ''
              })
            );
          } else if (section.type === 'table' && section.table) {
            const tableRows = [];
            
            // Add headers
            if (section.table.headers) {
              tableRows.push(
                new TableRow({
                  children: section.table.headers.map(header =>
                    new TableCell({
                      children: [new Paragraph({ text: String(header) })],
                      width: { size: 100 / section.table.headers.length, type: WidthType.PERCENTAGE }
                    })
                  )
                })
              );
            }
            
            // Add data rows
            if (section.table.rows) {
              section.table.rows.forEach(row => {
                tableRows.push(
                  new TableRow({
                    children: row.map(cell =>
                      new TableCell({
                        children: [new Paragraph({ text: String(cell || '') })]
                      })
                    )
                  })
                );
              });
            }
            
            children.push(
              new Table({
                rows: tableRows,
                width: { size: 100, type: WidthType.PERCENTAGE }
              })
            );
          }
        }
      }
      
      const doc = new Document({
        sections: [{
          children: children.length > 0 ? children : [
            new Paragraph({ text: 'Empty document' })
          ]
        }]
      });
      
      const buffer = await Packer.toBuffer(doc);
      await fs.writeFile(resolved, buffer);
      
      return {
        success: true,
        path: resolved,
        message: `Created Word document: ${path.basename(resolved)}`,
        size: buffer.length
      };
      
    } catch (error) {
      return {
        error: `Failed to create DOCX file: ${error.message}`,
        path: filePath
      };
    }
  }

  async createXlsx(filePath, sheets) {
    try {
      const resolved = this.resolveAndValidatePath(filePath);
      const dir = path.dirname(resolved);
      await fs.mkdir(dir, { recursive: true });
      
      const workbook = XLSX.utils.book_new();
      
      if (!sheets || sheets.length === 0) {
        // Create empty sheet
        const ws = XLSX.utils.aoa_to_sheet([['Empty Sheet']]);
        XLSX.utils.book_append_sheet(workbook, ws, 'Sheet1');
      } else {
        sheets.forEach((sheet, index) => {
          const sheetName = sheet.name || `Sheet${index + 1}`;
          const sheetData = sheet.data || [['No data']];
          
          const ws = XLSX.utils.aoa_to_sheet(sheetData);
          XLSX.utils.book_append_sheet(workbook, ws, sheetName);
        });
      }
      
      // Write file
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      await fs.writeFile(resolved, buffer);
      
      return {
        success: true,
        path: resolved,
        message: `Created Excel spreadsheet: ${path.basename(resolved)}`,
        sheets: sheets ? sheets.length : 1,
        size: buffer.length
      };
      
    } catch (error) {
      return {
        error: `Failed to create XLSX file: ${error.message}`,
        path: filePath
      };
    }
  }

  async createImage(prompt, filePath, size = 'auto', quality = 'auto') {
    try {
      const resolved = this.resolveAndValidatePath(filePath);
      const dir = path.dirname(resolved);
      await fs.mkdir(dir, { recursive: true });

      // Ensure file has .png extension
      if (!resolved.endsWith('.png')) {
        return {
          error: 'Image file path must end with .png'
        };
      }

      // Use OpenAI client to generate image
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      console.log(`[IMAGE GEN] 🎨 Generating image...`);
      console.log(`[IMAGE GEN] 📝 Prompt: "${prompt}"`);
      console.log(`[IMAGE GEN] 📐 Size: ${size || '1536x1024'}, Quality: ${quality || 'high'}`);
      
      // Use better defaults: high quality and 1536x1024 (landscape, max for gpt-image-1.5)
      const response = await openai.images.generate({
        model: 'gpt-image-1.5',
        prompt: prompt.trim(),
        size: size || '1536x1024',  // Default to landscape HD (max supported)
        quality: quality || 'high',  // Default to high quality
        n: 1
      });

      const image = response?.data?.[0];

      if (!image) {
        return { error: 'No image returned from OpenAI' };
      }

      let imageBuffer;

      if (image.b64_json) {
        // Convert base64 to buffer
        imageBuffer = Buffer.from(image.b64_json, 'base64');
      } else if (image.url) {
        // Download from URL
        const fetch = (await import('node-fetch')).default;
        const imgResponse = await fetch(image.url);
        const arrayBuffer = await imgResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
      } else {
        return { error: 'Image has no URL or base64 data' };
      }

      // Save to file
      await fs.writeFile(resolved, imageBuffer);

      console.log(`[IMAGE GEN] ✅ Saved: ${resolved} (${imageBuffer.length} bytes)`);

      return {
        success: true,
        path: resolved,
        message: `✅ IMAGE CREATED: Successfully generated image and saved to ${path.basename(resolved)}. File size: ${Math.round(imageBuffer.length / 1024)}KB.`,
        size: imageBuffer.length,
        prompt: prompt.substring(0, 100)
      };

    } catch (error) {
      console.error('[IMAGE GEN] Error:', error);
      return {
        error: `Failed to create image: ${error.message}`
      };
    }
  }

  async editImage(prompt, inputImages, outputPath, maskImage = null, inputFidelity = 'high', size = '1536x1024', quality = 'high') {
    try {
      const resolvedOutput = this.resolveAndValidatePath(outputPath);
      const dir = path.dirname(resolvedOutput);
      await fs.mkdir(dir, { recursive: true });

      // Ensure output has .png extension
      if (!resolvedOutput.endsWith('.png')) {
        return { error: 'Output file path must end with .png' };
      }

      // Resolve and validate input image paths
      const resolvedInputs = inputImages.map(img => this.resolveAndValidatePath(img));
      
      // Check if input images exist
      for (const imgPath of resolvedInputs) {
        try {
          await fs.access(imgPath);
        } catch {
          return { error: `Input image not found: ${path.basename(imgPath)}` };
        }
      }

      const OpenAI = require('openai');
      const { toFile } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      console.log(`[IMAGE EDIT] ✏️ Editing image...`);
      console.log(`[IMAGE EDIT] 📝 Prompt: "${prompt}"`);
      console.log(`[IMAGE EDIT] 🖼️  Input images: ${resolvedInputs.map(p => path.basename(p)).join(', ')}`);
      console.log(`[IMAGE EDIT] 📐 Fidelity: ${inputFidelity}, Size: ${size}, Quality: ${quality}`);
      if (maskImage && maskImage.trim() !== '') {
        console.log(`[IMAGE EDIT] 🎭 Mask: ${path.basename(this.resolvePath(maskImage))}`);
      }

      // Prepare image files for OpenAI SDK
      const imageFiles = await Promise.all(resolvedInputs.map(async (imgPath) => {
        const buffer = await fs.readFile(imgPath);
        return toFile(buffer, path.basename(imgPath), { type: 'image/png' });
      }));

      // Prepare parameters
      const params = {
        model: 'gpt-image-1.5',
        prompt: prompt.trim(),
        image: imageFiles,
        input_fidelity: inputFidelity || 'high',
        size: size || '1536x1024',
        quality: quality || 'high'
      };

      // Add mask if provided (treat empty string as no mask)
      if (maskImage && maskImage.trim() !== '') {
        const resolvedMask = this.resolveAndValidatePath(maskImage);
        try {
          await fs.access(resolvedMask);
          const maskBuffer = await fs.readFile(resolvedMask);
          params.mask = toFile(maskBuffer, path.basename(resolvedMask), { type: 'image/png' });
        } catch {
          return { error: `Mask image not found: ${path.basename(maskImage)}` };
        }
      }

      const response = await openai.images.edit(params);

      const image = response?.data?.[0];

      if (!image) {
        return { error: 'No edited image returned from OpenAI' };
      }

      let imageBuffer;

      if (image.b64_json) {
        imageBuffer = Buffer.from(image.b64_json, 'base64');
      } else if (image.url) {
        const fetch = (await import('node-fetch')).default;
        const imgResponse = await fetch(image.url);
        const arrayBuffer = await imgResponse.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuffer);
      } else {
        return { error: 'Image has no URL or base64 data' };
      }

      // Save to file
      await fs.writeFile(resolvedOutput, imageBuffer);

      console.log(`[IMAGE EDIT] ✅ Saved: ${resolvedOutput} (${imageBuffer.length} bytes)`);

      return {
        success: true,
        path: resolvedOutput,
        message: `✅ IMAGE EDIT COMPLETE: Successfully edited image and saved to ${path.basename(resolvedOutput)}. The requested changes have been applied to the image. File size: ${Math.round(imageBuffer.length / 1024)}KB. Used ${inputImages.length} input image(s).`,
        size: imageBuffer.length,
        input_images: inputImages.length,
        used_mask: !!maskImage
      };

    } catch (error) {
      console.error('[IMAGE EDIT] Error:', error);
      return {
        error: `Failed to edit image: ${error.message}`
      };
    }
  }

  // ============================================================================
  // BRAIN TOOLS - Access COSMO brain knowledge
  // ============================================================================

  async brainSearch(query, limit = 15) {
    const qe = getQueryEngine();
    if (!qe) return { error: 'No brain loaded.' };

    const safeLimit = Math.min(Math.max(1, limit || 15), 100);

    try {
      const state = await qe.queryEngine.loadBrainState();
      const results = await qe.queryEngine.queryMemory(state, query, {
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
          concept: (n.concept || '').substring(0, 2000), // Full meaningful context
          connected: n.connected || false
        }))
      };
    } catch (error) {
      console.error('[BRAIN SEARCH] Error:', error);
      return { error: `Brain search failed: ${error.message}` };
    }
  }

  async brainNode(nodeId) {
    const loader = getBrainLoader();
    if (!loader) return { error: 'No brain loaded.' };

    const node = loader.nodes.find(n => String(n.id) === String(nodeId));
    if (!node) return { error: `Node ${nodeId} not found.` };

    // Full content - no truncation for specific node lookup
    const connections = [];
    loader.edges.forEach(e => {
      if (String(e.source) === String(nodeId)) connections.push({ direction: 'outgoing', target: e.target });
      if (String(e.target) === String(nodeId)) connections.push({ direction: 'incoming', source: e.source });
    });

    return {
      success: true,
      node: {
        id: node.id,
        concept: node.concept, // FULL content
        tag: node.tag,
        created: node.created,
        activation: node.activation,
        weight: node.weight
      },
      connections: connections.slice(0, 20),
      total_connections: connections.length
    };
  }

  async brainThoughts(query, limit = 15) {
    const qe = getQueryEngine();
    if (!qe) return { error: 'No brain loaded.' };

    try {
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
    const qe = getQueryEngine();
    if (!qe) return { error: 'No brain loaded.' };

    try {
      const report = await qe.queryEngine.getLatestReport();
      if (!report) return { success: true, has_report: false };

      return {
        success: true,
        has_report: true,
        filename: report.filename,
        content: report.content.substring(0, 8000) // Substantial report context
      };
    } catch (error) {
      console.error('[BRAIN COORDINATOR] Error:', error);
      return { error: `Failed to get coordinator insights: ${error.message}` };
    }
  }

  async brainStats() {
    const loader = getBrainLoader();
    if (!loader) return { error: 'No brain loaded.' };

    const tagCounts = {};
    loader.nodes.forEach(n => {
      const tags = Array.isArray(n.tag) ? n.tag : [n.tag];
      tags.forEach(t => t && (tagCounts[t] = (tagCounts[t] || 0) + 1));
    });

    return {
      success: true,
      nodes: loader.nodes.length,
      edges: loader.edges.length,
      cycles: loader.state.cycleCount || 0,
      domain: loader.state.domain || loader.state.runMetadata?.domain,
      top_tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)
    };
  }
}

// OpenAI-compatible tools (exclude complex Office tools that need optional properties)
const openaiToolDefinitions = toolDefinitions.filter(t =>
  !['create_docx', 'create_xlsx'].includes(t.function.name)
);

module.exports = {
  toolDefinitions,
  openaiToolDefinitions,
  anthropicTools,
  ToolExecutor
};
