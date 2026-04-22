/**
 * Brain Studio Tools - Read-Only File Operations
 * Adapted from COSMO IDE v2 for brain package exploration
 * 
 * REMOVED: All write operations (edit_file, create_file, delete_file, etc.)
 * KEPT: Read operations (file_read, list_directory, grep_search, codebase_search)
 * 
 * Brain outputs are READ-ONLY - we explore, not edit.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
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
      description: 'Generate high-quality images using GPT-Image-2. Best for photorealistic, artistic, or illustrative images. Always create detailed, specific prompts.',
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
            enum: ['auto', 'low', 'medium', 'high', 'standard'],
            description: 'Image quality - default "high" for best detail. Use "medium" for faster generation.'
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
      description: 'Edit existing images using GPT-Image-2. Can modify images, combine multiple reference images, or use masks for precise editing (inpainting). Perfect for iterative refinements, style changes, or adding/removing elements.',
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
            description: 'Legacy option. GPT-Image-2 always uses high input fidelity automatically, so this can be omitted.'
          },
          size: {
            type: 'string',
            enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
            description: 'Output size - use "1536x1024" for landscape, "1024x1536" for portrait'
          },
          quality: {
            type: 'string',
            enum: ['auto', 'low', 'medium', 'high', 'standard'],
            description: 'Quality - use "high" for best detail'
          }
        },
        required: ['prompt', 'input_images', 'output_path', 'mask_image', 'size', 'quality'],
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
                description: 'Document title (optional)'
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
                      description: 'Text content (for paragraphs and headings)'
                    },
                    table: {
                      type: 'object',
                      description: 'Table data (for type: table)',
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
                      description: 'Cell value (string, number, or formula like "=A1+B1")'
                    }
                  }
                }
              },
              additionalProperties: false
            }
          }
        },
        required: ['file_path', 'sheets'],
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
  constructor(codebaseIndexer, workingDirectory) {
    this.indexer = codebaseIndexer;
    this.cwd = workingDirectory || process.cwd();
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

        case 'create_image':
          return await this.createImage(args.prompt, args.file_path, args.size, args.quality);

        case 'edit_image':
          return await this.editImage(args.prompt, args.input_images, args.output_path, args.mask_image, args.input_fidelity, args.size, args.quality);

        case 'create_docx':
          return await this.createDocx(args.file_path, args.content);
          
        case 'create_xlsx':
          return await this.createXlsx(args.file_path, args.sheets);
          
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
    const ext = path.extname(resolved).toLowerCase();
    
    // Handle Office file formats
    if (ext === '.docx') {
      return await this.readDocx(resolved);
    } else if (ext === '.xlsx' || ext === '.xls') {
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

  async createDocx(filePath, content) {
    try {
      const resolved = this.resolvePath(filePath);
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
      const resolved = this.resolvePath(filePath);
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
      const resolved = this.resolvePath(filePath);
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
      
      // Use better defaults: high quality and 1536x1024 landscape. GPT Image 2 supports larger sizes too.
      const response = await openai.images.generate({
        model: 'gpt-image-2',
        prompt: prompt.trim(),
        size: size || '1536x1024',  // Default to landscape HD (max supported)
        quality: quality === 'standard' ? 'medium' : (quality || 'high'),  // Map legacy "standard" to GPT Image 2's "medium"
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
      const resolvedOutput = this.resolvePath(outputPath);
      const dir = path.dirname(resolvedOutput);
      await fs.mkdir(dir, { recursive: true });

      // Ensure output has .png extension
      if (!resolvedOutput.endsWith('.png')) {
        return { error: 'Output file path must end with .png' };
      }

      // Resolve input image paths
      const resolvedInputs = inputImages.map(img => this.resolvePath(img));
      
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
        model: 'gpt-image-2',
        prompt: prompt.trim(),
        image: imageFiles,
        size: size || '1536x1024',
        quality: quality === 'standard' ? 'medium' : (quality || 'high')
      };

      // Add mask if provided (treat empty string as no mask)
      if (maskImage && maskImage.trim() !== '') {
        const resolvedMask = this.resolvePath(maskImage);
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
