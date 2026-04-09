/**
 * AI Handler - Function Calling with Streaming Events
 * Production-ready, no shortcuts
 */

const { toolDefinitions, anthropicTools, ToolExecutor } = require('./tools');

// OAuth support - needed for Claude Code identity injection
const { getOAuthStatus, prepareSystemPrompt } = require('../engine/src/services/anthropic-oauth-engine');

// Claude message sanitizer - ensures tool_result/tool_use pairing, message alternation
const { sanitizeClaudeMessages } = require('../engine/src/services/claude-message-sanitizer');

// ============================================================================
// SMART TRUNCATION - Keep beginning + end for better context preservation
// ============================================================================

function smartTruncate(text, maxLength = 75000) {
  if (!text || text.length <= maxLength) return text;

  // Reserve space for the middle indicator
  const indicator = '\n\n[... middle section truncated for token limit ...]\n\n';
  const availableLength = maxLength - indicator.length;

  // Split: 60% beginning (usually has imports, declarations, key context)
  // 40% end (usually has recent/relevant code, conclusions)
  const beginLength = Math.floor(availableLength * 0.6);
  const endLength = availableLength - beginLength;

  const beginning = text.substring(0, beginLength);
  const end = text.substring(text.length - endLength);

  return beginning + indicator + end;
}

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
          if (parsed.content && parsed.content.length > 75000) {
            parsed.content = smartTruncate(parsed.content, 75000);
          }
          trimmed.push({ ...msg, content: JSON.stringify(parsed) });
        } catch (e) {
          // If not JSON, use smart truncation (keep beginning + end)
          trimmed.push({ ...msg, content: smartTruncate(content, 75000) });
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
  if (!result || typeof result !== 'object') {
    // Handle primitive values safely
    if (result === undefined) return null;
    return result;
  }

  // Deep clean to ensure JSON serializability
  const deepClean = (obj, seen = new WeakSet()) => {
    // Handle primitives
    if (obj === null || typeof obj !== 'object') {
      if (obj === undefined) return null;
      if (typeof obj === 'function') return '[Function]';
      if (typeof obj === 'symbol') return obj.toString();
      return obj;
    }

    // Detect circular references
    if (seen.has(obj)) {
      return '[Circular Reference]';
    }
    seen.add(obj);

    // Handle arrays
    if (Array.isArray(obj)) {
      const cleanArr = obj.slice(0, 500).map(item => deepClean(item, seen));
      if (obj.length > 500) {
        return {
          _truncated_array: true,
          items: cleanArr,
          original_length: obj.length
        };
      }
      return cleanArr;
    }

    // Handle special object types
    if (obj instanceof Error) {
      return {
        _error: true,
        message: obj.message,
        name: obj.name,
        stack: obj.stack?.substring(0, 500)
      };
    }

    if (obj instanceof Date) {
      return obj.toISOString();
    }

    if (obj instanceof RegExp) {
      return obj.toString();
    }

    // Handle plain objects
    const clean = {};

    // Special-case images: never store base64 in conversation history
    if (obj.type === 'image' && typeof obj.data === 'string') {
      clean.type = 'image';
      clean.mime_type = obj.mime_type;
      clean.data_omitted = true;
      clean.data_length_chars = obj.data.length;
      return clean;
    }

    // Clean all properties
    for (const key of Object.keys(obj)) {
      const val = obj[key];

      // Skip functions and symbols
      if (typeof val === 'function' || typeof val === 'symbol') {
        continue;
      }

      // Handle large strings
      if (typeof val === 'string' && val.length > 75000) {
        clean[key] = smartTruncate(val, 75000);
        clean[`${key}_truncated`] = true;
      } else {
        // Recursively clean nested objects
        clean[key] = deepClean(val, seen);
      }
    }

    return clean;
  };

  return deepClean(result);
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

### read_image
Read and view image files (png, jpg, gif, webp). Use to analyze screenshots, diagrams, mockups, or any visual assets.

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
// BRAIN CONTEXT BUILDER - For auto-injection when brain toggle is enabled
// ============================================================================

function buildBrainContextSection(nodes, loader) {
  const sections = [];

  sections.push('\n\n## 🧠 Brain Knowledge Context\n');
  sections.push(`*${nodes.length} neurons fired from COSMO brain (${loader.nodes.length} total nodes)*\n`);

  // NO artificial limit - include ALL nodes that passed the relevance threshold
  // Consistent content length for all nodes - relevance is already filtered by threshold
  const MAX_NODE_CONTENT = 5000;  // All relevant nodes get full content

  nodes.forEach((node, i) => {
    const score = Math.round(node.score * 100) / 100;
    const tags = Array.isArray(node.tag) ? node.tag.join(', ') : node.tag;

    // All nodes above threshold get the same generous content limit
    // Score already determines inclusion - no need to penalize lower-scored nodes
    const content = (node.concept || '').substring(0, MAX_NODE_CONTENT);

    sections.push(`\n### Finding ${i + 1} (score: ${score}, tags: ${tags})`);
    sections.push(`**Node ID:** ${node.id}`);
    if (node.connected) sections.push(`*(connected to top results)*`);
    sections.push(`\n${content}`);

    if (node.concept && node.concept.length > MAX_NODE_CONTENT) {
      sections.push(`\n*[...${node.concept.length - MAX_NODE_CONTENT} more chars available via brain_node tool]*`);
    }
  });

  sections.push('\n\n---\n');
  sections.push('*Use brain_search, brain_node, brain_thoughts tools for deeper exploration.*\n');

  return sections.join('\n');
}

// ============================================================================
// FUNCTION CALLING HANDLER
// ============================================================================

async function handleFunctionCalling(openai, anthropic, xai, indexer, params, eventEmitter) {
  const {
    message, currentFolder, model = 'gpt-5.2', context = [],
    documentContent, selectedText, fileName, language,
    fileTreeContext, conversationHistory, conversationSummary,
    brainEnabled = false, brainPath = null, allowedRoot
  } = params;

  // DEBUG: Log brain status
  console.log(`[AI] brainEnabled param: ${brainEnabled}, brainPath: ${brainPath}`);
  eventEmitter?.({ type: 'debug', message: `brainEnabled=${brainEnabled}, brainPath=${brainPath}` });

  // Build system prompt
  let systemPrompt = buildSystemPrompt({
    fileName, language, currentFolder, selectedText,
    documentContent, fileTreeContext, message
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BRAIN CONTEXT INJECTION: Auto-inject relevant brain knowledge when enabled
  // ═══════════════════════════════════════════════════════════════════════════
  if (brainEnabled && brainPath) {
    try {
      const fs = require('fs');
      const path = require('path');
      const zlib = require('zlib');
      const { promisify } = require('util');
      const gunzip = promisify(zlib.gunzip);
      const { BrainQueryEngine } = require('../lib/brain-query-engine');

      // Check brain path exists
      const statePath = path.join(brainPath, 'state.json.gz');
      if (!fs.existsSync(statePath)) {
        console.log('[AI] Brain state.json.gz not found at:', statePath);
        eventEmitter?.({ type: 'brain_search', status: 'not_loaded', error: 'state.json.gz not found' });
      } else {
        console.log('[AI] Brain context injection enabled - loading brain from:', brainPath);
        eventEmitter?.({ type: 'brain_search', status: 'searching' });

        // Load brain state directly
        const compressed = await fs.promises.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());
        const nodes = state.memory?.nodes || [];
        const edges = state.memory?.edges || [];

        console.log(`[AI] Brain loaded: ${nodes.length} nodes, ${edges.length} edges`);

        // Create query engine and search - NO artificial limit, let relevance scores decide
        const qe = new BrainQueryEngine(brainPath, process.env.OPENAI_API_KEY);
        const allRelevantNodes = await qe.queryEngine.queryMemory(state, message, {
          limit: 10000,  // High limit - search entire brain thoroughly
          includeConnected: true,
          useSemanticSearch: true
        });

        // Filter by relevance score - include all nodes that "fire" above threshold
        const scoreThreshold = 0.20;  // Low threshold = more neurons fire
        const relevantNodes = allRelevantNodes.filter(n => (n.score || 0) >= scoreThreshold);

        console.log(`[AI] Brain search: ${allRelevantNodes.length} candidates → ${relevantNodes.length} above threshold (${scoreThreshold})`);

        if (relevantNodes.length > 0) {
          const brainContext = buildBrainContextSection(relevantNodes, { nodes, edges, brainPath });
          systemPrompt = systemPrompt + brainContext;

          // Prepare ALL nodes for UI visibility (not just top 10)
          const nodesSummary = relevantNodes.map(n => ({
            id: n.id,
            score: Math.round(n.score * 100) / 100,
            tag: Array.isArray(n.tag) ? n.tag.join(',') : n.tag,
            preview: (n.concept || '').substring(0, 150).replace(/\n/g, ' '),
            connected: n.connected || false
          }));

          console.log(`[AI] Injected ${relevantNodes.length} brain nodes into context`);

          eventEmitter?.({
            type: 'brain_context',
            status: 'injected',
            totalSearched: nodes.length,
            candidatesFound: allRelevantNodes.length,
            nodesInjected: relevantNodes.length,
            scoreThreshold,
            nodes: nodesSummary  // ALL nodes for UI display
          });
        } else {
          console.log('[AI] No relevant brain nodes found for query');
          eventEmitter?.({ type: 'brain_context', status: 'no_results', totalSearched: nodes.length });
        }
      }
    } catch (err) {
      console.error('[AI] Brain context injection failed:', err.message);
      eventEmitter?.({ type: 'brain_search', status: 'error', error: err.message });
    }
  } else if (brainEnabled && !brainPath) {
    console.log('[AI] Brain enabled but no brainPath provided');
    eventEmitter?.({ type: 'brain_search', status: 'not_loaded', error: 'No brainPath provided' });
  }

  // Build messages
  const messages = [{ role: 'system', content: systemPrompt }];

  if (context?.length > 0) {
    // Limit context files to prevent token explosion
    const limitedContext = context.slice(0, 10).map(c => ({
      file: c.file,
      content: c.content.length > 45000 ? smartTruncate(c.content, 45000) : c.content
    }));
    messages.push({
      role: 'system',
      content: `Open Files:\n${limitedContext.map(c => `${c.file}:\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n')}`
    });
  }

  // Include conversation summary if exists (smart context assembly)
  if (conversationSummary && typeof conversationSummary === 'string' && conversationSummary.trim()) {
    console.log(`[AI] Including conversation summary (${Math.ceil(conversationSummary.length / 4)} tokens)`);
    messages.push({
      role: 'system',
      content: `## Previous Conversation Summary\nThe following is a summary of the earlier conversation for context:\n\n${conversationSummary}\n\n---\nRecent messages follow below.`
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
  const toolExecutor = new ToolExecutor(indexer, currentFolder || process.cwd(), brainPath);
  
  // Function calling loop
  const MAX_ITERATIONS = 75;
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
                let parsedInput = {};
                try {
                  parsedInput = JSON.parse(tc.function.arguments || '{}');
                } catch (e) {
                  console.error(`[AI] Failed to parse tool arguments for ${tc.function?.name}:`, e.message);
                  console.error(`[AI] Raw arguments:`, (tc.function.arguments || '').substring(0, 200));
                  parsedInput = {};
                }
                content.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function.name,
                  input: parsedInput
                });
              }
              claudeMessages.push({ role: 'assistant', content });
            } else {
              claudeMessages.push({ role: 'assistant', content: msg.content });
            }
          } else if (msg.role === 'tool') {
            // Parse the tool result (content is guaranteed to be valid JSON string from sanitizeToolResult)
            let toolResultContent;
            try {
              // msg.content is always a JSON string (see line where we store tool results)
              const parsedResult = JSON.parse(msg.content);
              // Format for Anthropic (handles images, etc.)
              toolResultContent = formatToolResultContent(parsedResult, true);

              // Ensure it's a string for Anthropic API
              if (typeof toolResultContent !== 'string') {
                toolResultContent = JSON.stringify(toolResultContent, null, 2);
              }
            } catch (e) {
              // This should never happen since we validate on storage, but handle gracefully
              console.error(`[AI] CRITICAL: Tool result for ${msg.tool_call_id} has invalid JSON:`, e.message);
              console.error(`[AI] Content (first 500 chars):`, msg.content.substring(0, 500));

              // Use content as-is as last resort
              toolResultContent = typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify({ error: 'Invalid tool result', original: String(msg.content).substring(0, 200) }, null, 2);
            }

            // Build and validate the Anthropic message structure
            const toolResultMessage = {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: toolResultContent
              }]
            };

            // Final validation - ensure the entire message serializes correctly
            try {
              JSON.stringify(toolResultMessage);
              claudeMessages.push(toolResultMessage);
            } catch (serializeErr) {
              // This should be impossible now, but log if it happens
              console.error(`[AI] CRITICAL: Failed to serialize tool result message for ${msg.tool_call_id}:`, serializeErr.message);
              throw new Error(`Tool result serialization failed: ${serializeErr.message}`);
            }
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

        console.log(`[AI] Calling Anthropic API with ${sanitizedClaudeMessages.length} messages in iteration ${iterations}`);

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
          console.log(`[AI] OAuth mode active - Claude Code identity injected into system prompt`);
        }

        // DEBUG: Log message structure in iteration 2
        if (iterations >= 2) {
          console.log(`[AI] Iteration ${iterations} message summary:`);
          sanitizedClaudeMessages.forEach((msg, idx) => {
            const contentPreview = typeof msg.content === 'string'
              ? msg.content.substring(0, 100)
              : Array.isArray(msg.content)
                ? `[${msg.content.length} blocks: ${msg.content.map(b => b.type).join(', ')}]`
                : JSON.stringify(msg.content).substring(0, 100);
            console.log(`  [${idx}] ${msg.role}: ${contentPreview}`);
          });
        }

        let stream;
        try {
          stream = await anthropic.messages.stream({
            model: claudeModel,
            max_tokens: 64000,
            temperature: 0.1,
            system: preparedSystemPrompt,
            messages: sanitizedClaudeMessages,
            tools: anthropicTools
          });
        } catch (apiError) {
          console.error(`[AI] Anthropic API call failed:`, apiError.message);
          console.error(`[AI] Error details:`, JSON.stringify(apiError, null, 2).substring(0, 500));
          throw new Error(`Anthropic API error: ${apiError.message}`);
        }

        let textContent = '';
        let currentToolUse = null;
        let lastToolProgressEmit = 0;

        try {
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
              // Emit tool_preparing so frontend knows a tool call is being built
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
              // Validate that the accumulated JSON is complete
              let isValidJSON = false;
              try {
                JSON.parse(currentToolUse.input || '{}');
                isValidJSON = true;
              } catch (e) {
                console.error(`[AI] Invalid tool input JSON for ${currentToolUse.name}:`, e.message);
                console.error(`[AI] Accumulated input (first 200 chars):`, currentToolUse.input.substring(0, 200));
                // Use empty object as fallback to prevent downstream errors
                currentToolUse.input = '{}';
              }

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
          } else if (event.type === 'error') {
            console.error(`[AI] Anthropic stream error event:`, event);
            throw new Error(`Anthropic error: ${event.error?.message || 'Unknown error'}`);
          }
        }
        } catch (streamError) {
          console.error(`[AI] Anthropic stream processing error:`, streamError.message);
          console.error(`[AI] Stream error stack:`, streamError.stack);
          throw new Error(`Stream processing failed: ${streamError.message}`);
        }

        assistantMessage = { content: textContent, tool_calls: toolCalls.length > 0 ? toolCalls : null };
        
      } else if (isGrokModel) {
        // ============ GROK (xAI) ============
        // Trim messages to prevent token explosion
        const trimmedMessages = trimMessages(messages, 200000);
        
        // grok-beta for general use, grok-code-fast-1 for fast code edits
        const response = await xai.chat.completions.create({
          model: model,
          messages: trimmedMessages,
          tools: toolDefinitions,
          tool_choice: 'auto',
          temperature: 0.2  // Low temp for precise code
        });
        
        assistantMessage = response.choices[0].message;
        totalTokens += response.usage?.total_tokens || 0;
        toolCalls = assistantMessage.tool_calls || [];
        
      } else {
        // ============ OPENAI (Responses API) ============
        // GPT-5.2 best practice: use Responses API, keep state with previous_response_id,
        // and rely on truncation='auto' instead of failing hard on context overflow.

        const trimmedMessages = trimMessages(messages, 200000);
        const openaiModel = model;

        const toolsForResponses = buildOpenAIResponsesToolsFromChatTools(toolDefinitions);
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
          max_output_tokens: 64000,
          // Per GPT-5.2 guidance: keep temperature only with minimal reasoning effort.
          // Newer GPT-5.2 supports reasoning.effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'.
          reasoning: String(openaiModel).startsWith('gpt-5.2') ? { effort: 'none' } : undefined,
          // GPT-5.2 verbosity control (SDK types may lag; API accepts this field)
          text: String(openaiModel).startsWith('gpt-5.2') ? { verbosity: 'medium' } : undefined,
          temperature: 0.1
        };

        if (openaiPreviousResponseId) {
          responseParams.previous_response_id = openaiPreviousResponseId;
        }

        const response = await openai.responses.create(responseParams);

        openaiPreviousResponseId = response.id;
        openaiNextInputItems = null;

        const responseToolCalls = (response.output || []).filter(i => i && i.type === 'function_call');
        toolCalls = responseToolCalls.map(tc => ({
          id: tc.call_id,
          function: { name: tc.name, arguments: tc.arguments }
        }));

        assistantMessage = {
          content: response.output_text || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : null
        };

        totalTokens += response.usage?.total_tokens ?? ((response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0));
      }
      
      // Check for tool calls
      if (toolCalls?.length > 0) {
        try {
          console.log(`[AI] ${toolCalls.length} tools: ${toolCalls.map(t => t?.function?.name || 'unknown').join(', ')}`);
          console.log(`[AI] Assistant content: "${assistantMessage.content}"`); // DEBUG

          // NEW: Emit thinking/reasoning text if present
          if (assistantMessage.content && assistantMessage.content.trim()) {
            console.log(`[AI] Emitting thinking event`); // DEBUG
            try {
              eventEmitter?.({
                type: 'thinking',
                content: assistantMessage.content
              });
            } catch (thinkingErr) {
              console.error(`[AI] Failed to emit thinking event:`, thinkingErr.message);
            }
          } else {
            console.log(`[AI] No thinking content to emit`); // DEBUG
          }

          // Safely build tools array with comprehensive error handling
          const safeTools = toolCalls.map(t => {
            if (!t || !t.function) {
              console.error(`[AI] Malformed tool call:`, JSON.stringify(t).substring(0, 200));
              return { name: 'unknown', args: {} };
            }

            let args = {};
            try {
              args = JSON.parse(t.function.arguments || '{}');
            } catch (e) {
              console.error(`[AI] Failed to parse tool arguments for ${t.function.name}:`, e.message);
              console.error(`[AI] Raw arguments:`, (t.function.arguments || '').substring(0, 200));
              // Use safe fallback instead of crashing
              args = { _parse_error: e.message };
            }
            return { name: t.function.name, args };
          });

          try {
            eventEmitter?.({
              type: 'tools_start',
              tools: safeTools
            });
          } catch (toolsStartErr) {
            console.error(`[AI] Failed to emit tools_start event:`, toolsStartErr.message);
          }
        } catch (toolCallsErr) {
          console.error(`[AI] Critical error in tool calls handling:`, toolCallsErr);
          // Continue anyway - don't crash the entire conversation
        }
        
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: toolCalls
        });
        
        // Execute tools in parallel with comprehensive error handling
        const results = await Promise.all(
          toolCalls.map(async (tc, idx) => {
            try {
              if (!tc || !tc.function) {
                console.error(`[AI] Invalid tool call structure at index ${idx}`);
                return { toolCall: tc, result: { error: 'Invalid tool call structure' } };
              }

              const toolName = tc.function.name || 'unknown';
              let args;
              try {
                // Handle null, undefined, or empty arguments
                const argsStr = tc.function.arguments;
                if (!argsStr || argsStr.trim() === '') {
                  args = {};
                } else {
                  args = JSON.parse(argsStr);
                }
              } catch (e) {
                console.error(`[AI] Failed to parse arguments for ${toolName}:`, e.message);
                console.error(`[AI] Raw arguments (first 200 chars):`, (tc.function.arguments || '').substring(0, 200));
                return { toolCall: tc, result: { error: `Failed to parse arguments: ${e.message}` } };
              }

              try {
                eventEmitter?.({ type: 'tool_start', tool: toolName, args, index: idx });
              } catch (emitErr) {
                console.error(`[AI] Failed to emit tool_start:`, emitErr.message);
              }

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
            
            try {
              eventEmitter?.({
                type: 'tool_result',
                tool: toolName,
                success: !result.error,
                summary: summary,
                index: idx
              });
            } catch (emitErr) {
              console.error(`[AI] Failed to emit tool_result:`, emitErr.message);
            }

            return { toolCall: tc, result };
            } catch (toolExecErr) {
              console.error(`[AI] Critical error executing tool at index ${idx}:`, toolExecErr);
              return {
                toolCall: tc,
                result: { error: `Tool execution failed: ${toolExecErr.message}` }
              };
            }
          })
        );
        
        // Add tool results
        // For OpenAI Responses API: capture function_call_output items for next iteration
        const isOpenAIResponses = !isClaudeModel && !isGrokModel;
        const openaiFunctionOutputsForNextTurn = [];

        for (const { toolCall, result } of results) {
          // Store result - will be formatted per-provider when messages are sent
          const safeResult = sanitizeToolResult(result);

          // Ensure JSON serialization works and produces valid output
          let serializedContent;
          try {
            // Use a replacer to handle circular references and non-serializable values
            serializedContent = JSON.stringify(safeResult, (key, value) => {
              // Handle circular references
              if (typeof value === 'object' && value !== null) {
                if (value instanceof Error) {
                  return {
                    _error: true,
                    message: value.message,
                    name: value.name,
                    stack: value.stack?.substring(0, 500)
                  };
                }
                // Handle functions
                if (typeof value === 'function') {
                  return '[Function]';
                }
              }
              // Handle undefined
              if (value === undefined) {
                return null;
              }
              return value;
            }, 2); // Pretty print for debugging

            // Validate that we can parse it back
            JSON.parse(serializedContent);

          } catch (stringifyError) {
            console.error(`[AI] Failed to serialize tool result for ${toolCall.id}:`, stringifyError.message);
            console.error(`[AI] Result type:`, typeof safeResult, Array.isArray(safeResult) ? 'array' : '');

            // Fallback to simple string representation
            serializedContent = JSON.stringify({
              error: 'Failed to serialize tool result',
              message: stringifyError.message,
              resultType: typeof safeResult,
              keys: safeResult && typeof safeResult === 'object' ? Object.keys(safeResult).slice(0, 20) : []
            }, null, 2);
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializedContent,
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
          const MAX_IMAGES = 8; // guardrail
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
