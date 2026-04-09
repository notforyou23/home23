/**
 * AI Handler - Function Calling with Streaming Events
 * Production-ready, no shortcuts
 */

const { toolDefinitions, openaiToolDefinitions, anthropicTools, ToolExecutor } = require('./tools');

// OAuth support - needed for Claude Code identity injection
const { getOAuthStatus, prepareSystemPrompt } = require('../../src/services/anthropic-oauth-engine');

// Claude message sanitizer - ensures tool_result/tool_use pairing, message alternation
const { sanitizeClaudeMessages } = require('../../src/services/claude-message-sanitizer');

// ============================================================================
// MESSAGE TRIMMING - Prevent token explosion
// ============================================================================

function trimMessages(messages, maxTokenEstimate = 200000) {
  // Rough token estimation: ~4 chars per token
  const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);
  
  // Calculate current size
  let currentTokens = messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return sum + estimateTokens(content);
  }, 0);
  
  if (currentTokens <= maxTokenEstimate) {
    return messages;
  }
  
  console.log(`[TOKEN TRIM] Before: ${currentTokens} tokens, Target: ${maxTokenEstimate}`);
  
  // Strategy: Keep system messages, recent user/assistant, truncate tool results
  const trimmed = [];
  const keepRecent = 6; // Keep last 6 conversation turns
  
  // 1. Keep system messages (but truncate if huge)
  for (const msg of messages) {
    if (msg.role === 'system') {
      const content = msg.content;
      if (estimateTokens(content) > 20000) {
        // Truncate large system prompts
        trimmed.push({ ...msg, content: content.substring(0, 80000) + '\n\n[...truncated for token limit...]' });
      } else {
        trimmed.push(msg);
      }
    }
  }
  
  // 2. Get recent conversation, preserving tool groups (assistant + tool results are indivisible)
  const conversationMsgs = messages.filter(m => m.role !== 'system');

  // Build groups: assistant(tool_calls) + following tool messages form one unit
  const groups = [];
  let currentGroup = [];
  for (const msg of conversationMsgs) {
    if (msg.role === 'assistant') {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [msg];
    } else if (msg.role === 'tool' && currentGroup.length > 0 && currentGroup[0].role === 'assistant') {
      currentGroup.push(msg);
    } else {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [msg];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const keepGroups = keepRecent * 2;
  const recentGroups = groups.slice(-keepGroups);
  const recentMsgs = recentGroups.flat();
  
  // 3. Truncate large tool results
  for (const msg of recentMsgs) {
    if (msg.role === 'tool') {
      const content = msg.content;
      if (estimateTokens(content) > 5000) {
        // Truncate large tool results (e.g., file contents)
        try {
          const parsed = JSON.parse(content);
          // Drop embedded image base64 if present
          if (parsed && typeof parsed === 'object' && typeof parsed.data === 'string' && parsed.data.length > 0) {
            parsed.data = `[...omitted base64 (${parsed.data.length} chars)...]`;
          }
          if (parsed.content && parsed.content.length > 20000) {
            parsed.content = parsed.content.substring(0, 20000) + '\n\n[...truncated for token limit...]';
          }
          trimmed.push({ ...msg, content: JSON.stringify(parsed) });
        } catch (e) {
          // If not JSON, just truncate the string
          trimmed.push({ ...msg, content: content.substring(0, 20000) + '\n\n[...truncated...]' });
        }
      } else {
        trimmed.push(msg);
      }
    } else {
      trimmed.push(msg);
    }
  }
  
  const finalTokens = trimmed.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return sum + estimateTokens(content);
  }, 0);
  
  console.log(`[TOKEN TRIM] After: ${finalTokens} tokens (removed ${currentTokens - finalTokens} tokens)`);
  
  return trimmed;
}

// ============================================================================
// TOOL RESULT SANITIZATION - avoid storing huge payloads in message history
// ============================================================================

function sanitizeToolResult(result) {
  if (!result || typeof result !== 'object') return result;

  // Clone shallowly so we don't mutate upstream references
  const clean = Array.isArray(result) ? [...result] : { ...result };

  // Special-case images: never store base64 in conversation history
  if (clean.type === 'image' && typeof clean.data === 'string') {
    const len = clean.data.length;
    delete clean.data;
    clean.data_omitted = true;
    clean.data_length_chars = len;
  }

  // Cap common large string fields
  for (const key of Object.keys(clean)) {
    const val = clean[key];
    if (typeof val === 'string' && val.length > 50000) {
      clean[key] = val.substring(0, 50000) + '\n\n[...truncated...]';
    }
    if (Array.isArray(val) && val.length > 500) {
      clean[key] = val.slice(0, 500);
      clean[`${key}_truncated`] = true;
      clean[`${key}_original_length`] = val.length;
    }
  }

  return clean;
}

function pruneEphemeralMessages(messages, currentIteration) {
  // Keep only the most recent iteration's image context message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m._cosmo_ephemeral === 'image_context') {
      if (typeof m._iteration === 'number' && m._iteration < currentIteration - 1) {
        messages.splice(i, 1);
      }
    }
  }
}

// ============================================================================
// OPENAI RESPONSES API - helpers
// ============================================================================

function buildOpenAIResponsesToolsFromChatTools(chatToolDefinitions) {
  // Our existing tool definitions are Chat Completions format:
  // { type:'function', function:{ name, description, parameters } }
  // Responses API expects:
  // { type:'function', name, description, parameters, strict }
  return (chatToolDefinitions || [])
    .filter(t => t && t.type === 'function' && t.function && t.function.name)
    .map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description || null,
      parameters: t.function.parameters || null,
      strict: true
    }));
}

function buildOpenAIResponsesInstructionsFromMessages(messageList) {
  const systemMsgs = (messageList || []).filter(m => m?.role === 'system' && typeof m.content === 'string');
  if (!systemMsgs.length) return null;
  return systemMsgs.map(m => m.content).join('\n\n');
}

function buildOpenAIResponsesInputFromMessages(messageList) {
  const input = [];
  for (const msg of messageList || []) {
    if (!msg || msg.role === 'system') continue;

    if (msg.role === 'user') {
      // If this is our legacy image message shape (chat.completions style), convert it.
      if (Array.isArray(msg.content)) {
        const contentList = [];
        for (const part of msg.content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            contentList.push({ type: 'input_text', text: part.text });
          } else if (part?.type === 'image_url' && part.image_url?.url) {
            contentList.push({ type: 'input_image', detail: 'auto', image_url: part.image_url.url });
          }
        }
        input.push({ role: 'user', content: contentList });
      } else {
        input.push({ role: 'user', content: msg.content || '' });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      // If we stored tool calls in chat.completions format, translate them to Responses items
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        if (msg.content) {
          input.push({ role: 'assistant', content: msg.content });
        }
        for (const tc of msg.tool_calls) {
          if (!tc?.id || !tc?.function?.name) continue;
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || '{}'
          });
        }
      } else {
        input.push({ role: 'assistant', content: msg.content || '' });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Tool outputs become function_call_output items
      if (msg.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      }
      continue;
    }
  }
  return input;
}

// ============================================================================
// SYSTEM PROMPT (Complete, from COSMO)
// ============================================================================

function buildSystemPrompt(context) {
  const { fileName, language, currentFolder, selectedText, documentContent, fileTreeContext, message } = context;
  
  const isEditRequest = message?.toLowerCase().match(/improve|fix|rewrite|change|update|edit|modify|enhance/);
  const hasSelection = !!selectedText;

  return `You are an elite AI coding assistant in an IDE. You're an AUTONOMOUS AGENT - explore thoroughly, understand deeply, ship quality code.

## Agent Mindset

- Keep going until COMPLETELY solved
- Don't stop until confident it works
- Explore thoroughly before acting
- Use multiple tools in parallel when possible
- Be autonomous - find answers yourself

**Vibe:** Confident, thorough, results-driven. Ship it. 🚀

## Core Philosophy: Explore → Understand → Act

**NEVER assume. ALWAYS explore first.**

1. **Explore** - Read docs, list directories, search patterns
2. **Understand** - Process what you found
3. **Act** - Respond or implement with full context

## Current Context

File: ${fileName || 'untitled'}
Language: ${language || 'text'}
Folder: ${currentFolder || process.cwd()}
${selectedText ? `Selection: ${selectedText.length} chars selected` : 'No selection'}
${documentContent ? `Document: ${documentContent.length} chars` : 'Empty file'}

## Project Structure
${fileTreeContext || 'Use list_directory to explore'}

## Your Tools

### file_read
Read any file. Use before editing or analyzing.
- **Office files (.docx, .xlsx, .msg)**: Extracts text, formulas, comments
- Shows formula syntax: \`Value [=A1+B1]\` means cell shows Value but formula is =A1+B1
- Comments and annotations noted when present

### read_image
Read and view image files (png, jpg, gif, webp). Use to analyze screenshots, diagrams, mockups, or any visual assets.

### create_image
Generate high-quality images using GPT-Image-1.5. ALWAYS write detailed, specific prompts for best results.
- Saves as PNG file
- Default: 1536x1024 (landscape HD) at high quality
- Sizes: 1536x1024 (landscape), 1024x1536 (portrait), 1024x1024 (square)
- Quality: 'high' (default) or 'standard' (faster)

PROMPT FORMULA - Always include:
1. Subject & main focus
2. Style (photorealistic, digital art, illustration, etc.)
3. Composition/angle/perspective
4. Lighting & atmosphere
5. Colors & mood
6. Quality terms (high detail, professional, 4K, cinematic)

Example: "A cinematic photograph of a modern glass office building at sunset, low angle perspective, golden hour lighting reflecting off windows, dramatic clouds, urban skyline background, professional architectural photography, high detail, vibrant colors"

### edit_image
Edit existing images using GPT-Image-1.5. Perfect for iterative refinements, style changes, combining images, or targeted edits.
- Takes one or more input images as reference
- High input fidelity preserves faces, logos, details
- Optional mask for precise editing (inpainting)
- Can combine multiple images into one
- Examples: "Add sunset sky", "Change car color to red", "Remove background", "Combine these products into a gift basket"

### create_docx
Create or edit Word documents (.docx). Build professional documents with:
- Headings (heading1, heading2, heading3)
- Paragraphs
- Tables with headers and data rows
- Formatted content

Example: Read existing .docx, make changes, save as new file.

### create_xlsx
Create or edit Excel spreadsheets (.xlsx). Build spreadsheets with:
- Multiple sheets
- Data tables
- Formulas (use format: "=A1+B1")
- Headers and structured data

Example: Read data from .xlsx, process it, create new .xlsx with results.

### list_directory
List directory contents. Understand project structure.

### codebase_search
**Semantic search by MEANING** (not exact text). Superpower!
- "Where is authentication handled?"
- "How does error handling work?"
- "Find payment processing logic"

Use when unfamiliar with code. Don't use for exact symbols (use grep_search).

### grep_search
Exact text/pattern search.
- "where is X defined?"
- "how is Y used?"
- Find all occurrences

## File Editing Tools

**PREFER SURGICAL EDITS for targeted changes. Only use edit_file for complete file rewrites.**

### edit_file_range ⭐ PREFERRED
Edit specific line ranges without rewriting entire files.

Usage:
- Read file first to see line numbers
- Specify exact start_line and end_line (1-based, inclusive)
- Provide new_content for just that range
- Brief instructions explaining the change

Example: Change error handling in lines 45-52

### search_replace ⭐ PREFERRED
Find exact text and replace it precisely.

Usage:
- Include ENOUGH surrounding context to be unique
- Old string must match EXACTLY (including whitespace)
- If multiple matches, add more context
- Brief instructions

Example: Replace console.log with logger.info in handleRequest function

### insert_lines
Insert new lines at a specific position.

Usage:
- line_number: Where to insert (1 = start, file_length+1 = end)
- content: What to insert
- Brief instructions

### delete_lines
Delete specific line range.

Usage:
- start_line, end_line: Range to delete (inclusive)
- Brief instructions

### edit_file (Legacy - Use only for complete rewrites)
**Only use when restructuring entire files.**

For edit_file, provide:
- instructions: Brief description of changes
- code_edit: FULL file content with changes applied

The user will review in a diff viewer before accepting.

### create_file
Create new files. Use RELATIVE paths from current folder.

### run_terminal
Execute commands (npm, git, build, test, etc.)

### delete_file
Delete files/directories. Use carefully.

## Parallel Tool Execution

**Use multiple tools at once when they don't depend on each other.**

✅ GOOD: Call file_read for 3 files simultaneously
❌ BAD: Call them one at a time

## Behavioral Rules

### Rule 1: Explore Before Responding

When asked about structure/dependencies/"how does X work":
- DON'T: Guess based on training data
- DO: Use tools to explore first

Example:
\`\`\`
User: "How is this project structured?"

Good:
1. file_read(README.md)
2. file_read(package.json)
3. list_directory(.)
4. list_directory(src/)

Then explain what you FOUND.
\`\`\`

### Rule 2: Discover Project Type

Check for:
- package.json → Node.js/TypeScript
- requirements.txt → Python
- go.mod → Go
- Cargo.toml → Rust

### Rule 3: Search Before Creating

Before creating utilities:
1. list_directory(src/)
2. list_directory(src/utils/)
3. file_read(existing files to match patterns)

Then create following conventions.

### Rule 4: Use Surgical Edits

For small, targeted changes:
1. Use edit_file_range for line-specific changes
2. Use search_replace for find/replace operations
3. Read file first to understand context
4. ONLY use edit_file for complete file rewrites

Example (GOOD):
\`\`\`
User: "Add error handling to the fetch call"
1. file_read(api.js) // See the fetch call
2. search_replace(
   old_string: "const response = await fetch(url);\\nreturn response.json();",
   new_string: "const response = await fetch(url);\\nif (!response.ok) throw new Error('Fetch failed');\\nreturn response.json();"
)
\`\`\`

Example (BAD):
\`\`\`
User: "Add error handling to the fetch call"
1. file_read(api.js) // 300 lines
2. edit_file(api.js, <entire 300 lines with small change>)
\`\`\`

### Rule 5: Show Your Work

Always mention what you explored:
"I explored the project:
- README.md describes it as...
- package.json shows: React 18.2.0
- src/ contains: components/, hooks/, utils/"

## Operating Mode

${isEditRequest && hasSelection ? `
### EDIT MODE
User selected text for improvement.

Before editing:
- Read surrounding context if needed
- Understand what code does
- Plan minimal, surgical changes

**PREFERRED: Use surgical edit tools (search_replace or edit_file_range)**
Only use edit_file if rewriting significant portions.
` : message?.toLowerCase().includes('create') && message?.toLowerCase().includes('file') ? `
### FILE CREATION MODE

Before creating:
1. Explore existing structure (list_directory)
2. Check existing patterns (file_read similar files)
3. Match project style

Current folder: ${currentFolder || process.cwd()}
Use RELATIVE paths (NOT /Users/...)
` : `
### GENERAL MODE

Explore first using tools, then respond with evidence.

For implementation:
1. Explore existing structure
2. Match conventions
3. Generate complete, runnable code
4. Use surgical edits for targeted changes
`}

## Quality Standards

**All code must:**
- Match project's existing style (discover via exploration)
- Include necessary imports (check existing files)
- Be runnable immediately
- Handle errors gracefully

**For web apps:**
- Beautiful, modern UI
- Best UX practices
- Responsive design
- Accessible (ARIA, semantic HTML)

## Key Insight

**You have tools to explore ANY codebase. USE THEM.**

Don't rely on "how projects usually work."
Explore THIS project to see how IT actually works.

This makes you a true IDE assistant, not just a chatbot.

## Style

- **Explorer First**: Use tools to understand before acting
- **Evidence-Based**: Show what you discovered
- **Thorough**: Read files, search patterns, list directories
- **Professional**: IDE assistant demeanor
- **Autonomous**: Act decisively once you understand
- **Direct**: Results over words, grounded in exploration

You are empowered to explore and understand. The user trusts you to discover the truth before acting.`;
}

// ============================================================================
// HELPER: Format tool result content (handle images)
// ============================================================================

function formatToolResultContent(result, isClaudeFormat = false) {
  // Check if result contains an image
  if (result.type === 'image' && result.data && result.mime_type) {
    if (isClaudeFormat) {
      // Claude format: array with text description + image
      return [
        {
          type: 'text',
          text: `Image loaded from ${result.path} (${result.format}, ${Math.round(result.size / 1024)}KB)`
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: result.mime_type,
            data: result.data
          }
        }
      ];
    } else {
      // OpenAI/Grok format: JSON string with metadata (image will be in next iteration)
      // Store image data in a special field for later use
      return JSON.stringify({
        ...result,
        _image_data_note: 'Image data available but not displayed in tool result. Ask for description.'
      });
    }
  }
  
  // Regular non-image result
  return JSON.stringify(result);
}

// ============================================================================
// FUNCTION CALLING HANDLER
// ============================================================================

async function handleFunctionCalling(openai, anthropic, xai, indexer, params, eventEmitter) {
  const { 
    message, currentFolder, model = 'gpt-5.2', context = [],
    documentContent, selectedText, fileName, language, 
    fileTreeContext, conversationHistory 
  } = params;
  
  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    fileName, language, currentFolder, selectedText,
    documentContent, fileTreeContext, message
  });
  
  // Build messages
  const messages = [{ role: 'system', content: systemPrompt }];
  
  if (context?.length > 0) {
    // Limit context files to prevent token explosion
    const limitedContext = context.slice(0, 3).map(c => ({
      file: c.file,
      content: c.content.length > 20000 ? c.content.substring(0, 20000) + '\n\n[...truncated...]' : c.content
    }));
    messages.push({
      role: 'system',
      content: `Open Files:\n${limitedContext.map(c => `${c.file}:\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n')}`
    });
  }
  
  if (conversationHistory) {
    const safeHistory = Array.isArray(conversationHistory)
      ? conversationHistory
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map(m => {
            let c = m.content;
            // Avoid accidentally carrying giant payloads (e.g. pasted files, data URLs)
            if (c.includes('data:image') && c.length > 20000) {
              c = c.substring(0, 20000) + '\n\n[...truncated data URL...]';
            }
            if (c.length > 12000) c = c.substring(0, 12000) + '\n\n[...truncated history...]';
            return { role: m.role, content: c };
          })
      : [];

    messages.push(...safeHistory);
  }
  
  let userMessage = message;
  if (selectedText) {
    // Limit selection to prevent token explosion
    const trimmedSelection = selectedText.length > 50000 ? selectedText.substring(0, 50000) + '\n\n[...truncated...]' : selectedText;
    userMessage = `Selected:\n---\n${trimmedSelection}\n---\n\nRequest: ${message}`;
  } else if (documentContent && documentContent.length < 50000) {
    // Increased limit but still capped to prevent huge documents
    userMessage = `Current document:\n---\n${documentContent}\n---\n\nRequest: ${message}`;
  } else if (documentContent) {
    // Document too large, just mention it
    userMessage = `[Current document: ${documentContent.length} chars - too large to include]\n\nRequest: ${message}`;
  }
  
  messages.push({ role: 'user', content: userMessage });
  
  // Initialize tool executor
  const toolExecutor = new ToolExecutor(indexer, currentFolder || process.cwd());
  
  // Function calling loop
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  let totalTokens = 0;
  let pendingEdits = [];

  // OpenAI Responses API (stateful across tool-calling turns)
  let openaiPreviousResponseId = null;
  let openaiNextInputItems = null;
  
  const isClaudeModel = model.startsWith('claude');
  const isGrokModel = model.startsWith('grok');
  
  console.log(`[AI] Starting ${isClaudeModel ? 'Claude' : 'GPT'} ${model} in ${currentFolder}`);
  
  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Prevent previous iterations' ephemeral blobs from accumulating
      pruneEphemeralMessages(messages, iterations);
      
      eventEmitter?.({ type: 'iteration', iteration: iterations, max: MAX_ITERATIONS });
      eventEmitter?.({ type: 'status', message: iterations === 1 ? 'Calling AI model...' : `Processing (step ${iterations})...` });

      let assistantMessage;
      let toolCalls = [];
      
      if (isClaudeModel) {
        // ============ CLAUDE ============
        // Trim messages to prevent token explosion
        const trimmedMessages = trimMessages(messages, 200000);
        
        const systemMsg = trimmedMessages.find(m => m.role === 'system');
        const userMsgs = trimmedMessages.filter(m => m.role !== 'system');
        
        // Convert to Claude format
        const claudeMessages = [];
        for (const msg of userMsgs) {
          if (msg.role === 'user') {
            claudeMessages.push({ role: 'user', content: msg.content });
          } else if (msg.role === 'assistant') {
            if (msg.tool_calls) {
              const content = [];
              if (msg.content) content.push({ type: 'text', text: msg.content });
              for (const tc of msg.tool_calls) {
                content.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function.name,
                  input: JSON.parse(tc.function.arguments)
                });
              }
              claudeMessages.push({ role: 'assistant', content });
            } else {
              claudeMessages.push({ role: 'assistant', content: msg.content });
            }
          } else if (msg.role === 'tool') {
            // Parse the tool result to check if it contains an image
            let toolResultContent;
            try {
              const parsedResult = JSON.parse(msg.content);
              toolResultContent = formatToolResultContent(parsedResult, true);
            } catch (e) {
              // If parsing fails, use content as-is
              toolResultContent = msg.content;
            }
            
            claudeMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: toolResultContent
              }]
            });
          }
        }
        
        // Sanitize: merge tool_results, validate adjacency, fix alternation
        const sanitizedClaudeMessages = sanitizeClaudeMessages(claudeMessages);

        // Use exact model names from COSMO (tested and working)
        const claudeModel = model === 'claude-opus-4-6'
          ? 'claude-opus-4-6'  // Opus 4.6 - latest
          : model === 'claude-opus-4-5'
          ? 'claude-opus-4-5'  // Opus 4.5
          : 'claude-sonnet-4-5';  // Sonnet 4.5 - default

        // Check if using OAuth mode - requires Claude Code identity injection
        let oauthStatus = { source: 'unknown' };
        try {
          oauthStatus = await getOAuthStatus();
        } catch (e) {
          console.log('[AI] Could not check OAuth status:', e.message);
        }
        const isOAuthMode = oauthStatus.source === 'oauth';

        // Prepare system prompt - inject Claude Code identity for OAuth mode
        const preparedSystemPrompt = prepareSystemPrompt(systemMsg?.content, isOAuthMode);

        if (isOAuthMode) {
          console.log(`[AI] OAuth mode active - Claude Code identity injected`);
        }

        const stream = await anthropic.messages.create({
          model: claudeModel,
          max_tokens: 16000,
          temperature: 0.1,
          system: preparedSystemPrompt,
          messages: sanitizedClaudeMessages,
          tools: anthropicTools,
          stream: true
        });
        
        let textContent = '';
        let currentToolUse = null;
        let lastToolProgressEmit = 0;

        for await (const event of stream) {
          if (event.type === 'message_start') {
            totalTokens += event.message?.usage?.input_tokens || 0;
          } else if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'tool_use') {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                input: ''
              };
              eventEmitter?.({ type: 'tool_preparing', tool: event.content_block.name, id: event.content_block.id });
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
              const chunk = event.delta.text;
              textContent += chunk;
              // Emit chunk for real-time display
              eventEmitter?.({ type: 'response_chunk', chunk });
            } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
              const now = Date.now();
              if (now - lastToolProgressEmit > 200) {
                lastToolProgressEmit = now;
                eventEmitter?.({ type: 'tool_progress', tool: currentToolUse.name, id: currentToolUse.id, bytes: currentToolUse.input.length });
              }
            }
          } else if (event.type === 'content_block_stop') {
            if (currentToolUse) {
              toolCalls.push({
                id: currentToolUse.id,
                function: {
                  name: currentToolUse.name,
                  arguments: currentToolUse.input
                }
              });
              currentToolUse = null;
            }
          } else if (event.type === 'message_delta') {
            totalTokens += event.usage?.output_tokens || 0;
          }
        }
        
        assistantMessage = { content: textContent, tool_calls: toolCalls.length > 0 ? toolCalls : null };
        
      } else if (isGrokModel) {
        // ============ GROK (xAI) ============
        const trimmedMessages = trimMessages(messages, 200000);
        
        const stream = await xai.chat.completions.create({
          model: model,
          messages: trimmedMessages,
          tools: openaiToolDefinitions,
          tool_choice: 'auto',
          temperature: 0.2,
          stream: true
        });
        
        let textContent = '';
        let streamedToolCalls = [];
        
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          
          if (delta?.content) {
            textContent += delta.content;
            eventEmitter?.({ type: 'response_chunk', chunk: delta.content });
          }
          
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!streamedToolCalls[tc.index]) {
                  streamedToolCalls[tc.index] = {
                    id: tc.id || '',
                    function: { name: '', arguments: '' }
                  };
                }
                if (tc.id) streamedToolCalls[tc.index].id = tc.id;
                if (tc.function?.name) streamedToolCalls[tc.index].function.name = tc.function.name;
                if (tc.function?.arguments) streamedToolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
          
          if (chunk.usage) {
            totalTokens += chunk.usage.total_tokens || 0;
          }
        }
        
        assistantMessage = {
          content: textContent,
          tool_calls: streamedToolCalls.length > 0 ? streamedToolCalls : null
        };
        toolCalls = streamedToolCalls;
        
      } else {
        // ============ OPENAI (Responses API) ============
        // GPT-5.2 best practice: use Responses API, keep state with previous_response_id,
        // and rely on truncation='auto' instead of failing hard on context overflow.

        const trimmedMessages = trimMessages(messages, 200000);
        const openaiModel = model;

        const toolsForResponses = buildOpenAIResponsesToolsFromChatTools(openaiToolDefinitions);
        const instructions = buildOpenAIResponsesInstructionsFromMessages(trimmedMessages);

        // If we have pending tool outputs from the previous iteration, only send those.
        // Otherwise, send the initial conversation input.
        const inputItems = Array.isArray(openaiNextInputItems) && openaiNextInputItems.length > 0
          ? openaiNextInputItems
          : buildOpenAIResponsesInputFromMessages(trimmedMessages);

        const responseParams = {
          model: openaiModel,
          instructions,
          input: inputItems,
          tools: toolsForResponses,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          truncation: 'auto',
          max_output_tokens: 16000,
          reasoning: String(openaiModel).startsWith('gpt-5.2') ? { effort: 'none' } : undefined,
          text: String(openaiModel).startsWith('gpt-5.2') ? { verbosity: 'medium' } : undefined,
          temperature: 0.1,
          stream: true
        };

        if (openaiPreviousResponseId) {
          responseParams.previous_response_id = openaiPreviousResponseId;
        }

        const stream = await openai.responses.create(responseParams);

        let textContent = '';
        let responseId = null;
        let outputItems = [];
        
        for await (const chunk of stream) {
          // Debug: log first chunk to verify structure
          if (!textContent && !responseId) {
            console.log('[OPENAI STREAM] First chunk:', JSON.stringify(chunk).substring(0, 300));
          }
          
          if (chunk.id) {
            responseId = chunk.id;
          }
          
          // Collect output items from the stream
          if (chunk.output) {
            outputItems = chunk.output;
          }
          
          // Also collect individual items as they complete (only when done, not added/in_progress)
          if (chunk.type === 'response.output_item.done' && chunk.item && chunk.item.type === 'function_call') {
            // Check if this item is already in outputItems to avoid duplicates
            const existingIndex = outputItems.findIndex(item => item.call_id === chunk.item.call_id);
            if (existingIndex >= 0) {
              // Replace with the completed version
              outputItems[existingIndex] = chunk.item;
            } else {
              // Add new item
              outputItems.push(chunk.item);
            }
          }
          
          // Stream text deltas - check all possible fields
          if (chunk.output_text_delta) {
            textContent += chunk.output_text_delta;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.output_text_delta });
          } else if (chunk.output_text && !textContent) {
            // Fallback if deltas not available
            textContent = chunk.output_text;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.output_text });
          } else if (chunk.delta?.text) {
            // Alternative delta format
            textContent += chunk.delta.text;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta.text });
          } else if (chunk.text) {
            // Direct text field
            textContent += chunk.text;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.text });
          }
          
          if (chunk.usage) {
            totalTokens += chunk.usage.total_tokens ?? ((chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0));
          }
        }
        
        console.log('[OPENAI] Final text content length:', textContent.length, 'tokens:', totalTokens); // DEBUG

        openaiPreviousResponseId = responseId;
        openaiNextInputItems = null;

        const responseToolCalls = (outputItems || []).filter(i => i && i.type === 'function_call');
        toolCalls = responseToolCalls.map(tc => ({
          id: tc.call_id,
          function: { name: tc.name, arguments: tc.arguments }
        }));

        assistantMessage = {
          content: textContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : null
        };
      }
      
      // Check for tool calls
      if (toolCalls?.length > 0) {
        console.log(`[AI] ${toolCalls.length} tools: ${toolCalls.map(t => t.function.name).join(', ')}`);
        console.log(`[AI] Assistant content: "${assistantMessage.content}"`); // DEBUG
        
        // NEW: Emit thinking/reasoning text if present
        if (assistantMessage.content && assistantMessage.content.trim()) {
          console.log(`[AI] Emitting thinking event`); // DEBUG
          eventEmitter?.({
            type: 'thinking',
            content: assistantMessage.content
          });
        } else {
          console.log(`[AI] No thinking content to emit`); // DEBUG
        }
        
        eventEmitter?.({
          type: 'tools_start',
          tools: toolCalls.map(t => ({
            name: t.function.name,
            args: JSON.parse(t.function.arguments)
          }))
        });
        
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: toolCalls
        });
        
        // Execute tools in parallel
        const results = await Promise.all(
          toolCalls.map(async (tc, idx) => {
            const toolName = tc.function.name;
            let args;
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              return { toolCall: tc, result: { error: 'Failed to parse arguments' } };
            }
            
            eventEmitter?.({ type: 'tool_start', tool: toolName, args, index: idx });
            
            const result = await toolExecutor.execute(toolName, args);
            
            if (result.action === 'queue_edit') {
              pendingEdits.push({
                file: result.file_path,
                instructions: result.instructions,
                edit: result.code_edit
              });
            }
            
            eventEmitter?.({ type: 'tool_complete', tool: toolName, result, index: idx });
            
            // Emit tool result summary for visibility
            let summary;
            if (result.error) {
              summary = `Error: ${result.error}`;
            } else if (result.action === 'queue_edit') {
              summary = `Edit queued: ${result.file_path || 'file'}`;
            } else if (toolName === 'file_read' || toolName === 'read_image') {
              const size = result.content ? `${(result.content.length / 1024).toFixed(1)}KB` : '';
              summary = `${args?.file_path || 'file'} ${size ? `(${size})` : ''}`;
            } else if (toolName === 'create_file') {
              summary = `Created: ${args?.file_path || 'file'}`;
            } else if (toolName === 'edit_file' || toolName === 'search_replace') {
              summary = `Edited: ${args?.file_path || 'file'}`;
            } else if (toolName === 'list_directory') {
              summary = `${result.files?.length || 0} items in ${args?.directory_path || 'directory'}`;
            } else if (toolName === 'grep_search' || toolName === 'codebase_search') {
              const matches = result.results?.length || result.matches?.length || 0;
              summary = `${matches} match${matches !== 1 ? 'es' : ''} for "${(args?.query || args?.pattern || '').substring(0, 30)}"`;
            } else if (toolName === 'run_terminal') {
              summary = `Ran: ${(args?.command || '').substring(0, 60)}`;
            } else if (toolName === 'delete_file') {
              summary = `Deleted: ${args?.file_path || 'file'}`;
            } else if (result.files) {
              summary = `${result.files.length} items`;
            } else {
              summary = 'Success';
            }
            
            console.log(`[AI] Tool result for ${toolName}: ${summary}`); // DEBUG
            
            eventEmitter?.({
              type: 'tool_result',
              tool: toolName,
              success: !result.error,
              summary: summary,
              index: idx
            });
            
            return { toolCall: tc, result };
          })
        );
        
        // Add tool results
        // For OpenAI Responses API: capture BOTH function_call AND function_call_output items for next iteration
        const isOpenAIResponses = !isClaudeModel && !isGrokModel;
        const openaiFunctionOutputsForNextTurn = [];

        // First, add all the function_call items
        if (isOpenAIResponses && toolCalls?.length > 0) {
          for (const tc of toolCalls) {
            openaiFunctionOutputsForNextTurn.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments
            });
          }
        }

        // Then add the corresponding function_call_output items
        for (const { toolCall, result } of results) {
          // Store result - will be formatted per-provider when messages are sent
          const safeResult = sanitizeToolResult(result);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(safeResult),
            _raw_result: safeResult  // Keep sanitized result for image detection
          });

          if (isOpenAIResponses && toolCall?.id) {
            openaiFunctionOutputsForNextTurn.push({
              type: 'function_call_output',
              call_id: toolCall.id,
              output: JSON.stringify(safeResult)
            });
          }
        }
        
        // Handle images from tools:
        // - Claude supports images in tool_result (we keep that path).
        // - OpenAI/Grok can accept image inputs, but data URLs are extremely token-heavy.
        //   So we only include images if total base64 size is small; otherwise we include metadata only.
        const imageResults = results.filter(r => r.result?.type === 'image' && r.result?.data && r.result?.mime_type);
        if (!isClaudeModel && imageResults.length > 0) {
          const MAX_IMAGE_BASE64_CHARS = 200_000; // guardrail
          const MAX_IMAGES = 2; // guardrail
          const selectedImages = imageResults.slice(0, MAX_IMAGES);
          const totalChars = selectedImages.reduce((sum, r) => sum + (r.result.data?.length || 0), 0);

          const summaryLines = selectedImages.map(r => `- ${r.result.path || '(unknown)'} (${r.result.format || 'image'}, ~${Math.round((r.result.size || 0) / 1024)}KB)`);
          const summaryText = `[Images loaded from read_image tool calls]\n${summaryLines.join('\n')}\n\n` +
            (totalChars <= MAX_IMAGE_BASE64_CHARS
              ? `[Including up to ${MAX_IMAGES} images inline for vision.]`
              : `[Omitting base64 image payloads to avoid token explosion. If you need visual analysis, ask explicitly and/or switch to Claude vision flow.]`);

          // Always store a light-weight text summary in our internal message history
          messages.push({
            role: 'user',
            content: summaryText,
            _cosmo_ephemeral: 'image_context',
            _iteration: iterations
          });

          // For OpenAI Responses, attach images only if within guardrails
          if (isOpenAIResponses) {
            if (totalChars <= MAX_IMAGE_BASE64_CHARS) {
              const contentList = [{ type: 'input_text', text: summaryText }];
              for (const r of selectedImages) {
                contentList.push({
                  type: 'input_image',
                  detail: 'auto',
                  image_url: `data:${r.result.mime_type};base64,${r.result.data}`
                });
              }
              openaiFunctionOutputsForNextTurn.push({ role: 'user', content: contentList });
            } else {
              openaiFunctionOutputsForNextTurn.push({ role: 'user', content: summaryText });
            }
          }
        }

        if (isOpenAIResponses) {
          openaiNextInputItems = openaiFunctionOutputsForNextTurn;
        }

        eventEmitter?.({ type: 'status', message: `Tools done, AI analyzing results...` });
        continue; // Next iteration
      }

      // No more tools - done!
      const finalResponse = assistantMessage.content || '';
      
      console.log(`[AI] ✅ Complete: ${iterations} iterations, ${totalTokens} tokens`);
      
      return {
        success: true,
        response: finalResponse,
        tokensUsed: totalTokens,
        iterations,
        pendingEdits
      };
    }
    
    // Max iterations
    return {
      success: false,
      error: `Max iterations (${MAX_ITERATIONS}) reached`,
      tokensUsed: totalTokens,
      iterations,
      pendingEdits
    };
    
  } catch (error) {
    console.error('[AI] Error:', error);
    return {
      success: false,
      error: error.message,
      tokensUsed: totalTokens,
      iterations,
      pendingEdits
    };
  }
}

module.exports = { handleFunctionCalling };

