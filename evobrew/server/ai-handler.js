/**
 * AI Handler - Function Calling with Streaming Events
 * Production-ready, no shortcuts
 * 
 * Phase 3 Integration: Uses provider abstraction layer for model-agnostic support
 */

const { toolDefinitions, ToolExecutor } = require('./tools');
const { getAnthropicApiKey, prepareSystemPrompt } = require('./services/anthropic-oauth');
const { getDefaultRegistry } = require('./providers');
const { getModelId, qualifyModelSelection } = require('../lib/model-selection');

// ============================================================================
// SESSION MUTEX - Prevent concurrent agent sessions on the same folder
// ============================================================================

const activeSessions = new Map(); // folder path -> { sessionId, startTime }

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
  
  // 2. Get recent conversation (last N user/assistant/tool groups)
  const conversationMsgs = messages.filter(m => m.role !== 'system');
  const recentMsgs = conversationMsgs.slice(-keepRecent * 3); // Keep last few turns
  
  // 3. Truncate large tool results
  for (let i = 0; i < recentMsgs.length; i++) {
    const msg = recentMsgs[i];
    // CRITICAL: Never truncate the very latest tool result, as the AI needs it for the next turn
    const isLatest = i >= recentMsgs.length - 2;

    if (msg.role === 'tool' && !isLatest) {
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

function normalizeUnifiedToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .map((toolCall) => {
      if (!toolCall) return null;

      if (toolCall.function?.name) {
        return toolCall;
      }

      const name = toolCall.name || toolCall.toolName || '';
      const rawArgs = toolCall.arguments;
      let argsText = '{}';

      if (typeof rawArgs === 'string') {
        argsText = rawArgs || '{}';
      } else if (rawArgs && typeof rawArgs === 'object') {
        try {
          argsText = JSON.stringify(rawArgs);
        } catch (_) {
          argsText = '{}';
        }
      }

      return {
        id: toolCall.id || `call_${Date.now()}`,
        type: 'function',
        function: {
          name,
          arguments: argsText
        }
      };
    })
    .filter(Boolean);
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
  function schemaAllowsNull(schema) {
    if (!schema || typeof schema !== 'object') return false;
    if (schema.type === 'null') return true;
    if (Array.isArray(schema.type)) return schema.type.includes('null');
    if (Array.isArray(schema.anyOf)) return schema.anyOf.some(schemaAllowsNull);
    if (Array.isArray(schema.oneOf)) return schema.oneOf.some(schemaAllowsNull);
    return false;
  }

  function makeSchemaNullable(schema) {
    if (!schema || typeof schema !== 'object') return { anyOf: [{ type: 'null' }] };
    if (schemaAllowsNull(schema)) return schema;
    return {
      anyOf: [
        schema,
        { type: 'null' }
      ]
    };
  }

  function normalizeSchemaForOpenAIStrict(schema) {
    if (Array.isArray(schema)) {
      return schema.map((item) => normalizeSchemaForOpenAIStrict(item));
    }

    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const normalized = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' || key === 'required' || key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'not') {
        continue;
      }
      normalized[key] = normalizeSchemaForOpenAIStrict(value);
    }

    if (Array.isArray(schema.anyOf)) {
      normalized.anyOf = schema.anyOf.map((item) => normalizeSchemaForOpenAIStrict(item));
    }
    if (Array.isArray(schema.oneOf)) {
      normalized.oneOf = schema.oneOf.map((item) => normalizeSchemaForOpenAIStrict(item));
    }
    if (Array.isArray(schema.allOf)) {
      normalized.allOf = schema.allOf.map((item) => normalizeSchemaForOpenAIStrict(item));
    }
    if (schema.not && typeof schema.not === 'object') {
      normalized.not = normalizeSchemaForOpenAIStrict(schema.not);
    }

    if (schema.type === 'array' || schema.items !== undefined) {
      normalized.items = normalizeSchemaForOpenAIStrict(schema.items);
    }

    if (schema.type === 'object' || schema.properties !== undefined) {
      const properties = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
      const originalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
      const propertyKeys = Object.keys(properties);
      const normalizedProperties = {};

      for (const key of propertyKeys) {
        const propSchema = normalizeSchemaForOpenAIStrict(properties[key]);
        normalizedProperties[key] = originalRequired.has(key)
          ? propSchema
          : makeSchemaNullable(propSchema);
      }

      normalized.properties = normalizedProperties;
      normalized.required = propertyKeys;

      if (schema.additionalProperties !== undefined) {
        normalized.additionalProperties = schema.additionalProperties;
      } else {
        normalized.additionalProperties = false;
      }
    }

    return normalized;
  }

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
      parameters: normalizeSchemaForOpenAIStrict(t.function.parameters || null),
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
  const { fileName, language, currentFolder, selectedText, documentContent, fileTreeContext, message, runContext } = context;
  
  const isEditRequest = message?.toLowerCase().match(/improve|fix|rewrite|change|update|edit|modify|enhance/);
  const hasSelection = !!selectedText;

  // Domain context block with actual content awareness
  let domainBlock = '';
  if (runContext?.domain) {
    domainBlock = `
═══════════════════════════════════════════════════════════════════════════════
## 🧠 RESEARCH CONTEXT

**Run**: ${runContext.runId || 'runtime'}
**Domain**: ${runContext.domain}
${runContext.context ? `**Focus**: ${runContext.context}` : ''}
${runContext.originalQuestion ? `**Research Question**: ${runContext.originalQuestion}` : ''}

You are helping a human work with research outputs on this domain.
`;
    
    // Add what actually exists
    if (runContext.structure) {
      domainBlock += `
### Research Has Produced:
`;
      if (runContext.structure.outputsCount) {
        domainBlock += `- **${runContext.structure.outputsCount} output folders** in outputs/`;
        if (runContext.structure.outputs?.length) {
          domainBlock += ` (${runContext.structure.outputs.slice(0, 5).join(', ')}${runContext.structure.outputsCount > 5 ? '...' : ''})`;
        }
        domainBlock += '\n';
      }
      if (runContext.structure.agentsCount) {
        domainBlock += `- **${runContext.structure.agentsCount} agent folders** in agents/`;
        if (runContext.structure.agents?.length) {
          domainBlock += ` (${runContext.structure.agents.slice(0, 5).join(', ')}${runContext.structure.agentsCount > 5 ? '...' : ''})`;
        }
        domainBlock += '\n';
      }
    }
    
    if (runContext.recentProgress) {
      domainBlock += `
### Recent Progress:
${runContext.recentProgress}
`;
    }
    
    domainBlock += `═══════════════════════════════════════════════════════════════════════════════
`;
  }

  // NOTE: This prompt is intentionally aligned to the canonical “unified” IDE prompt:
  // /Users/jtr/_JTR23_/Cosmo_Unified_dev/engine/src/ide/ai-handler.js
  // We keep a small identity header so multi-provider switching stays coherent.
  return `You are an elite AI coding assistant in an IDE. You're an AUTONOMOUS AGENT - explore thoroughly, understand deeply, ship quality code.

## Model Identity (important)

- **Provider**: ${context.providerName || 'unknown'}
- **Model**: ${context.model || 'unknown'}

If the user asks what model/provider you are, answer using the values above.
Do **not** claim to be a different assistant/model.

${domainBlock}
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

**File**: ${fileName || 'untitled'}
**Language**: ${language || 'text'}
**Folder**: ${currentFolder || process.cwd()}
${selectedText ? `**Selection**: ${selectedText.length} chars selected` : ''}
${documentContent ? `**Document**: ${documentContent.length} chars loaded` : ''}

## Project Structure
${fileTreeContext || 'Use list_directory to explore'}

## Your Tools

Tool details are in their function definitions. Key tools:
- **file_read** — Read files (text, .docx, .xlsx, .msg). Always read before editing.
- **read_image** / **create_image** / **edit_image** — View, generate (GPT-Image-1.5), or edit images
- **list_directory** — Explore project structure
- **grep_search** — Exact text/pattern search (results capped at 50 — narrow query if truncated)
- **codebase_search** — Semantic search by meaning (use for "how does X work?" style queries)
- **edit_file_range** / **search_replace** — Surgical edits (PREFERRED for targeted changes)
- **insert_lines** / **delete_lines** — Line-level operations
- **edit_file** — Full file rewrite (ONLY for complete restructuring)
- **create_file** — Create new files (auto-validates JS/JSON syntax)
- **delete_file** — Delete files/directories
- **create_docx** / **create_xlsx** — Create Office documents
- **run_tests** — Verify changes: syntax-check a file or run test suite
- **progress_update** — Document session progress for continuity across sessions
- **terminal_open/write/wait/resize/close/list** — PTY terminal sessions
- **run_terminal** — One-shot command execution

## Key Patterns

- **Explore before acting**: Read files, list directories, search — then respond with evidence
- **Surgical edits preferred**: Use edit_file_range or search_replace, not full file rewrites
- **Parallel tool calls**: Use multiple tools at once when independent
- **Verify after editing**: Use run_tests to syntax-check modified files
- **Read before editing**: Always file_read before modifying a file

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

- **Helpful First**: Answer questions, provide information, wait for direction
- **Evidence-Based**: Show what you find, let the human decide
- **Thorough**: When asked, explore comprehensively using tools
- **Professional**: IDE assistant demeanor
- **Patient**: Don't rush to change things - understand what the human wants
- **Transparent**: Explain your findings, propose options

## Brain Directory Structure

When exploring brain research outputs, know the dual structure:
- **agents/** → Agent discoveries, insights, findings
- **outputs/** → Actual deliverables (documents, code, reports)

## Brain Tool Strategy

When the human asks about remembered research, prior findings, coordinator insights, or anything in the connected brain:
- Start with **\`brain_search\`** using a natural-language query.
- Use **\`brain_node\`** with a returned \`node_id\` to read the full node.
- Use **\`brain_thoughts\`** to inspect agent reasoning trails.
- Use **\`brain_coordinator_insights\`** for high-level strategic review.
- Use **\`brain_stats\`** for overview/health of the loaded brain.

Do not claim the brain is unavailable unless these tools fail or no brain is loaded.

## Remember

You are here to HELP the human work with research. Do not take autonomous action.
When asked to explore, do so thoroughly. When asked to edit, do so precisely.
But always wait for the human to direct you.`;
}

// ============================================================================
// BRAIN CONTEXT BUILDER - For auto-injection when brain toggle is enabled
// ============================================================================

function buildBrainContextSection(nodes, loader) {
  let renderNodes = Array.isArray(nodes) ? nodes : [];
  let maxNodeContent = 5000;
  if (typeof arguments[2] === 'object' && arguments[2] !== null) {
    const options = arguments[2];
    if (typeof options.maxNodeContent === 'number' && Number.isFinite(options.maxNodeContent)) {
      maxNodeContent = options.maxNodeContent;
    }
    if (typeof options.maxNodes === 'number' && Number.isFinite(options.maxNodes) && options.maxNodes > 0) {
      renderNodes = renderNodes.slice(0, options.maxNodes);
    }
  }

  const sections = [];

  sections.push('\n\n## Brain Knowledge Context\n');
  sections.push(`*${renderNodes.length} relevant findings from brain (${loader.nodes.length} total nodes)*\n`);

  renderNodes.forEach((node, i) => {
    const score = Math.round(node.score * 100) / 100;
    const tags = Array.isArray(node.tag) ? node.tag.join(', ') : node.tag;

    const content = (node.concept || '').substring(0, maxNodeContent);

    sections.push(`\n### Finding ${i + 1} (score: ${score}, tags: ${tags})`);
    sections.push(`**Node ID:** ${node.id}`);
    if (node.connected) sections.push(`*(connected to top results)*`);
    sections.push(`\n${content}`);

    if (node.concept && node.concept.length > maxNodeContent) {
      sections.push(`\n*[...${node.concept.length - maxNodeContent} more chars available via brain_node tool]*`);
    }
  });

  sections.push('\n\n---\n');
  sections.push('*Use brain_search, brain_node, brain_thoughts tools for deeper exploration.*\n');

  return sections.join('\n');
}

function determineAssistantBrainStrategy({
  message,
  enablePGS,
  pgsMode,
  pgsSessionId,
  pgsConfig,
  planningMode,
  fileName,
  selectedText,
  documentContent,
  loader
}) {
  const manualSweepFraction = Number(pgsConfig?.sweepFraction || 0.25) || 0.25;

  if (enablePGS) {
    return {
      usePGS: true,
      auto: false,
      mode: pgsMode || 'full',
      sessionId: pgsSessionId || 'default',
      sweepFraction: manualSweepFraction,
      reason: 'manual'
    };
  }

  const text = String(message || '').trim().toLowerCase();
  const nodeCount = Number(loader?.nodes?.length || 0);

  if (!text || nodeCount < 250) {
    return { usePGS: false, auto: false, reason: 'brain_too_small_or_empty' };
  }

  if (planningMode || fileName || (selectedText && selectedText.trim()) || (documentContent && documentContent.trim())) {
    return { usePGS: false, auto: false, reason: 'file_or_planning_context' };
  }

  if (/\b(no pgs|don['’]?t sweep|dont sweep|skip pgs|quick answer|fast answer)\b/i.test(text)) {
    return { usePGS: false, auto: false, reason: 'explicit_opt_out' };
  }

  const codeSignals = [
    'code', 'file', 'files', 'folder', 'directory', 'repo', 'workspace', 'implement', 'edit',
    'refactor', 'fix', 'bug', 'test', 'tests', 'terminal', 'command', 'route', 'api', 'component',
    'function', 'class', 'package.json', 'readme', 'server'
  ];
  const researchSignals = [
    'novel', 'novelty', 'synthesis', 'synthesize', 'strategic', 'strategy', 'recommendation',
    'recommendations', 'patterns', 'themes', 'cross-domain', 'across', 'all findings', 'opportunity',
    'opportunities', 'defensible', 'moat', 'market', 'tam', 'sam', 'monetization', 'customers',
    'what did we learn', 'blind spots', 'gaps', 'contradiction', 'contradictions', 'comprehensive',
    'full coverage', 'full graph', 'entire brain', 'across all', 'survey'
  ];

  const scoreSignals = (signals) => signals.reduce((score, signal) => score + (text.includes(signal) ? 1 : 0), 0);
  const codeScore = scoreSignals(codeSignals);
  const researchScore = scoreSignals(researchSignals);

  if (researchScore === 0 || codeScore > researchScore) {
    return { usePGS: false, auto: false, reason: 'not_broad_research' };
  }

  const explicitFull = /\b(full sweep|full coverage|full graph|entire brain|across all|exhaustive|systematic)\b/i.test(text);
  const deepSweep = explicitFull || /\b(comprehensive|everything|all findings|all themes|all patterns)\b/i.test(text);
  const sweepFraction = explicitFull ? 1.0 : deepSweep ? 0.5 : 0.25;
  const mode = explicitFull ? 'full' : 'targeted';
  const brainSlug = String(loader?.brainPath || 'brain').split('/').filter(Boolean).pop() || 'brain';

  return {
    usePGS: true,
    auto: true,
    mode,
    sessionId: `assistant-${brainSlug}`,
    sweepFraction,
    reason: explicitFull ? 'explicit_full_coverage_request' : 'broad_research_query'
  };
}

function determineStandardBrainInjectionProfile({
  message,
  planningMode,
  fileName,
  selectedText,
  documentContent
}) {
  const text = String(message || '').trim().toLowerCase();
  const hasEditorContext = Boolean(planningMode || fileName || (selectedText && selectedText.trim()) || (documentContent && documentContent.trim()));

  const codeSignals = [
    'code', 'file', 'files', 'folder', 'directory', 'repo', 'workspace', 'implement', 'edit',
    'refactor', 'fix', 'bug', 'test', 'tests', 'terminal', 'command', 'route', 'api', 'component',
    'function', 'class', 'package.json', 'readme', 'server', 'endpoint', 'frontend', 'backend'
  ];
  const researchSignals = [
    'novel', 'novelty', 'synthesis', 'synthesize', 'strategic', 'strategy', 'recommendation',
    'recommendations', 'patterns', 'themes', 'cross-domain', 'across', 'all findings', 'opportunity',
    'opportunities', 'defensible', 'moat', 'market', 'tam', 'sam', 'monetization', 'customers',
    'what did we learn', 'blind spots', 'gaps', 'contradiction', 'contradictions', 'comprehensive',
    'full coverage', 'full graph', 'entire brain', 'across all', 'survey'
  ];
  const scoreSignals = (signals) => signals.reduce((score, signal) => score + (text.includes(signal) ? 1 : 0), 0);
  const codeScore = scoreSignals(codeSignals) + (hasEditorContext ? 2 : 0);
  const researchScore = scoreSignals(researchSignals);
  const profile = codeScore > researchScore ? 'task' : (researchScore >= 2 ? 'research' : 'balanced');

  if (profile === 'task') {
    return {
      profile,
      queryLimit: 140,
      includeConnected: false,
      thresholdFloor: 26,
      thresholdShare: 0.72,
      injectLimit: 10,
      maxNodeContent: 700,
      useSourceDiversity: false
    };
  }

  if (profile === 'research') {
    return {
      profile,
      queryLimit: 260,
      includeConnected: true,
      thresholdFloor: 18,
      thresholdShare: 0.5,
      injectLimit: 18,
      maxNodeContent: 1400,
      useSourceDiversity: true
    };
  }

  return {
    profile,
    queryLimit: 180,
    includeConnected: true,
    thresholdFloor: 22,
    thresholdShare: 0.6,
    injectLimit: 14,
    maxNodeContent: 1000,
    useSourceDiversity: true
  };
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

/**
 * Handle function calling with streaming events
 * 
 * @param {Object} openai - OpenAI client (legacy, will be replaced by registry)
 * @param {Object} anthropic - Anthropic client (legacy, will be replaced by registry)
 * @param {Object} xai - xAI client (legacy, will be replaced by registry)
 * @param {Object} indexer - Codebase indexer
 * @param {Object} params - Request parameters
 * @param {Function} eventEmitter - SSE event emitter
 * @param {Object} [options] - Additional options
 * @param {Object} [options.registry] - Provider registry (if not provided, will be created)
 */
async function handleFunctionCalling(openai, anthropic, xai, indexer, params, eventEmitter, options = {}) {
  const {
    message, currentFolder, model = 'gpt-5.2', context = [],
    documentContent, selectedText, fileName, language,
    fileTreeContext, conversationHistory, conversationSummary,
    allowedRoot, brainEnabled = false,
    planningMode = false,
    executePlan = false,
    planState = null,
    enablePGS = false,
    pgsMode = 'full',
    pgsSessionId = 'default',
    pgsConfig = null,
    pgsSweepModel = null,
    allowedToolNames = null,
    disableSpreadsheetParsing = false,
    terminalPolicy = null,
    terminalManager = null
  } = params;
  // Session mutex — prevent concurrent agent sessions on the same folder
  if (currentFolder && activeSessions.has(currentFolder)) {
    const existing = activeSessions.get(currentFolder);
    const elapsed = Date.now() - existing.startTime;
    // Allow if the previous session has been running for more than 10 minutes (likely stale)
    if (elapsed < 600000) {
      return {
        success: false,
        error: `Another agent session is already active on this folder. Wait for it to complete or try again in a moment.`,
        response: '',
        tokensUsed: 0,
        iterations: 0,
        pendingEdits: []
      };
    }
    // Stale session — remove it
    activeSessions.delete(currentFolder);
  }
  const sessionId = require('crypto').randomUUID();
  if (currentFolder) activeSessions.set(currentFolder, { sessionId, startTime: Date.now() });

  const requestedModelSelection = String(model || '').trim() || 'anthropic/latest-sonnet';
  let effectiveModel = getModelId(requestedModelSelection) || 'gpt-5.2';
  let resolvedModelSelection = requestedModelSelection;
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PROVIDER DETECTION: Use registry for model-agnostic provider selection
  // ═══════════════════════════════════════════════════════════════════════════
  let registry = options.registry;
  if (!registry) {
    try {
      registry = await getDefaultRegistry();
    } catch (e) {
      console.warn('[AI] Failed to initialize provider registry, falling back to legacy detection:', e.message);
      registry = null;
    }
  }
  
  // Use registry for provider detection if available, otherwise fall back to legacy heuristics
  let provider = null;
  let providerId = null;
  if (registry) {
    try {
      const resolution = await registry.resolveModelSelection(requestedModelSelection);
      if (resolution?.resolvedModel) {
        effectiveModel = resolution.resolvedModel;
        resolvedModelSelection = resolution.resolvedSelection || qualifyModelSelection(resolution.providerId, resolution.resolvedModel);
        provider = resolution.provider || null;
        providerId = resolution.providerId || null;
        if (resolution.aliasId) {
          console.log(`[AI] Resolved model alias ${requestedModelSelection} -> ${resolvedModelSelection}`);
        }
      }
    } catch (resolutionError) {
      console.warn(`[AI] Failed to resolve model alias ${requestedModelSelection}:`, resolutionError.message);
    }

    provider = provider || registry.getProvider(resolvedModelSelection) || registry.getProvider(requestedModelSelection);
    if (!provider && effectiveModel !== requestedModelSelection) {
      provider = registry.getProvider(effectiveModel);
    }
    providerId = provider?.id;
    if (provider) {
      console.log(`[AI] Provider registry detected: ${provider.name} (${provider.id}) for model ${resolvedModelSelection}`);
    } else {
      console.warn(`[AI] No provider found in registry for model: ${requestedModelSelection}, using legacy detection`);
    }
  }

  // Get performance constraints for this provider
  const perfHints = provider?.getPerformanceHints() || {
    maxConcurrentTools: 10,
    maxToolsPerIteration: 15,
    pollingInterval: 500,
    reducedParallelism: false,
    conservativeTokens: false,
    maxOutputTokens: 4096
  };

  console.log(`[AI] Using provider ${provider?.id || 'legacy'} with constraints:`, {
    maxConcurrent: perfHints.maxConcurrentTools,
    maxPerIteration: perfHints.maxToolsPerIteration,
    reducedParallelism: perfHints.reducedParallelism
  });

  // Filter tools based on provider capabilities
  let availableTools = toolDefinitions;
  if (provider && typeof provider.filterToolsByCapability === 'function') {
    availableTools = provider.filterToolsByCapability(toolDefinitions);
    console.log(`[AI] Using ${availableTools.length}/${toolDefinitions.length} tools for ${provider.id}`);
  }

  if (Array.isArray(allowedToolNames) && allowedToolNames.length > 0) {
    const explicitAllow = new Set(allowedToolNames);
    availableTools = availableTools.filter((tool) => explicitAllow.has(tool.function.name));
    console.log(`[AI] Security policy restricted tools to ${availableTools.length} entries`);
  }

  if (terminalPolicy?.enabled === false) {
    const terminalToolNames = new Set([
      'run_terminal',
      'terminal_open',
      'terminal_write',
      'terminal_wait',
      'terminal_resize',
      'terminal_close',
      'terminal_list'
    ]);
    availableTools = availableTools.filter((tool) => !terminalToolNames.has(tool.function.name));
    console.log(`[AI] Terminal tools disabled by policy; ${availableTools.length} tools remain`);
  }

  // Planning mode: restrict to read-only + plan tools. Execute mode: all tools available.
  const isPlanningMode = !executePlan && (planningMode || (message && message.toLowerCase().startsWith('plan:')));
  if (isPlanningMode) {
    const writeToolNames = new Set([
      'edit_file', 'edit_file_range', 'search_replace', 'insert_lines', 'delete_lines',
      'create_file', 'delete_file', 'create_docx', 'create_xlsx', 'create_image', 'edit_image',
      'terminal_write'
    ]);
    availableTools = availableTools.filter((tool) => !writeToolNames.has(tool.function.name));
    console.log(`[AI] Planning mode: restricted to ${availableTools.length} read-only + plan tools`);
  }

  const availableAnthropicTools = availableTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));

  // Get OAuth credentials info for system prompt preparation
  let isOAuthMode = false;
  try {
    const credentials = await getAnthropicApiKey();
    isOAuthMode = credentials.isOAuth || false;
  } catch (e) {
    console.log('[AI] Could not determine OAuth mode:', e.message);
  }

  // DEBUG: Log brain status
  console.log(`[AI] brainEnabled param: ${brainEnabled} (type: ${typeof brainEnabled})`);
  eventEmitter?.({ type: 'debug', message: `brainEnabled=${brainEnabled}` });
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SITUATIONAL AWARENESS: Load run context for domain-aware assistance
  // ═══════════════════════════════════════════════════════════════════════════
  let runContext = null;
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Find the run root (where run-metadata.json lives)
    let runRoot = null;
    let checkDir = currentFolder || process.cwd();
    
    // Recursive search up for run-metadata.json
    while (checkDir && checkDir !== path.parse(checkDir).root) {
      const metaPath = path.join(checkDir, 'run-metadata.json');
      if (fs.existsSync(metaPath)) {
        runRoot = checkDir;
        break;
      }
      checkDir = path.dirname(checkDir);
    }
    
    if (runRoot) {
      const metadata = JSON.parse(fs.readFileSync(path.join(runRoot, 'run-metadata.json'), 'utf-8'));
      runContext = {
        domain: metadata.domain,
        context: metadata.context || metadata.guidedFocus?.context || '',
        runId: metadata.runId,
        originalQuestion: metadata.originalQuestion || metadata.guidedFocus?.question || ''
      };
      console.log(`[AI] Loaded run context: ${runContext.domain} from ${runRoot}`);
    }
    
    // If we found a run root, load what exists for context
    if (runRoot && runContext) {
      runContext.structure = {};
      
      // Check outputs directory
      const outputsDir = path.join(runRoot, 'outputs');
      if (fs.existsSync(outputsDir)) {
        try {
          const outputFolders = fs.readdirSync(outputsDir).filter(f => !f.startsWith('.'));
          runContext.structure.outputs = outputFolders.slice(0, 10); // First 10
          runContext.structure.outputsCount = outputFolders.length;
        } catch (e) { /* ignore */ }
      }
      
      // Check agents directory  
      const agentsDir = path.join(runRoot, 'agents');
      if (fs.existsSync(agentsDir)) {
        try {
          const agentFolders = fs.readdirSync(agentsDir).filter(f => !f.startsWith('.'));
          runContext.structure.agents = agentFolders.slice(0, 10); // First 10
          runContext.structure.agentsCount = agentFolders.length;
        } catch (e) { /* ignore */ }
      }
      
      // Check for recent progress
      const progressPath = path.join(runRoot, 'cosmo-progress.md');
      if (fs.existsSync(progressPath)) {
        try {
          const progress = fs.readFileSync(progressPath, 'utf-8');
          // Get first 500 chars of progress
          runContext.recentProgress = progress.substring(0, 500) + (progress.length > 500 ? '...' : '');
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    console.log('[AI] No run context available:', e.message);
  }
  
  // Build system prompt with context
  // Build system prompt with context
  // Include provider/model identity so switching providers mid-conversation doesn't cause identity confusion.
  const providerNameForPrompt = provider?.name || providerId || 'unknown';
  let systemPrompt = buildSystemPrompt({
    fileName, language, currentFolder, selectedText,
    documentContent, fileTreeContext, message, runContext,
    providerName: providerNameForPrompt,
    model: effectiveModel
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BRAIN CONTEXT INJECTION: Auto-inject relevant brain knowledge when enabled
  // ═══════════════════════════════════════════════════════════════════════════
  if (brainEnabled) {
    const { getQueryEngine, getBrainLoader } = require('./brain-loader-module');
    const qe = getQueryEngine();
    const loader = getBrainLoader();

    // Inject brain identity into system prompt so local agents can see it
    if (loader?.brainPath) {
      const brainName = String(loader.brainPath).split('/').filter(Boolean).pop() || 'brain';
      const nodeCount = loader.nodes?.length || 0;
      systemPrompt = systemPrompt.replace(
        /(\*\*Folder\*\*:.+)/,
        `$1\n**Brain**: ${brainName} (${nodeCount} nodes, path: ${loader.brainPath})`
      );
    }

    if (qe && loader) {
      const runStandardBrainSearch = async () => {
        console.log('[AI] Brain context injection enabled - searching brain...');
        eventEmitter?.({ type: 'brain_search', status: 'searching' });

        const injectionProfile = determineStandardBrainInjectionProfile({
          message,
          planningMode,
          fileName,
          selectedText,
          documentContent
        });

        const state = await qe.queryEngine.loadBrainState();

        const allRelevantNodes = await qe.queryEngine.queryMemory(state, message, {
          limit: injectionProfile.queryLimit,
          includeConnected: injectionProfile.includeConnected,
          useSemanticSearch: true
        });

        const topScore = Number(allRelevantNodes[0]?.score || 0);
        const scoreThreshold = Math.max(
          injectionProfile.thresholdFloor,
          topScore > 0 ? topScore * injectionProfile.thresholdShare : 0
        );
        let relevantNodes = allRelevantNodes.filter(n => (n.score || 0) >= scoreThreshold);

        if (injectionProfile.useSourceDiversity && typeof qe.queryEngine.getSourceDiverseNodes === 'function') {
          relevantNodes = qe.queryEngine.getSourceDiverseNodes(relevantNodes, injectionProfile.injectLimit);
        } else {
          relevantNodes = relevantNodes.slice(0, injectionProfile.injectLimit);
        }

        console.log(`[AI] Brain search (${injectionProfile.profile}): ${allRelevantNodes.length} candidates → ${relevantNodes.length} injected (threshold ${scoreThreshold.toFixed(2)})`);

        if (relevantNodes.length > 0) {
          const brainContext = buildBrainContextSection(relevantNodes, loader, {
            maxNodes: injectionProfile.injectLimit,
            maxNodeContent: injectionProfile.maxNodeContent
          });
          systemPrompt = systemPrompt + brainContext;
          console.log(`[AI] Injected ${relevantNodes.length} brain nodes into context`);
          eventEmitter?.({
            type: 'brain_search',
            status: 'injected',
            totalSearched: allRelevantNodes.length,
            nodesInjected: relevantNodes.length,
            scoreThreshold,
            message: `${relevantNodes.length} relevant brain findings injected (${injectionProfile.profile})`
          });
        } else {
          console.log('[AI] No relevant brain nodes found for query');
          eventEmitter?.({ type: 'brain_search', status: 'no_results', totalSearched: allRelevantNodes.length });
        }
      };

      try {
        const brainStrategy = determineAssistantBrainStrategy({
          message,
          enablePGS,
          pgsMode,
          pgsSessionId,
          pgsConfig,
          planningMode,
          fileName,
          selectedText,
          documentContent,
          loader
        });

        // PGS path: use Partitioned Graph Synthesis for deep, full-coverage brain search
        if (brainStrategy.usePGS && qe.queryEngine) {
          const resolvedPgsMode = brainStrategy.mode || pgsMode || 'full';
          const resolvedPgsSessionId = brainStrategy.sessionId || pgsSessionId || 'default';
          const resolvedSweepFraction = brainStrategy.sweepFraction || pgsConfig?.sweepFraction || 0.25;

          console.log(`[AI] PGS brain context injection — mode: ${resolvedPgsMode}, session: ${resolvedPgsSessionId}${brainStrategy.auto ? ' (auto)' : ''}`);
          eventEmitter?.({ type: 'brain_search', status: 'searching', pgs: true });
          if (brainStrategy.auto) {
            const modeLabel = resolvedSweepFraction >= 1.0 ? 'full' : resolvedSweepFraction >= 0.5 ? 'deep' : 'targeted';
            eventEmitter?.({
              type: 'brain_search',
              status: 'auto_pgs',
              pgs: true,
              mode: resolvedPgsMode,
              sweepFraction: resolvedSweepFraction,
              reason: brainStrategy.reason,
              message: `Auto-PGS: escalating to a ${modeLabel} graph sweep for this broad research question`
            });
          }
          eventEmitter?.({ type: 'status', message: 'PGS: Running partitioned graph synthesis (this takes longer)...' });

          let pgsResult = null;
          try {
            pgsResult = await qe.queryEngine.executeEnhancedQuery(message, {
              enablePGS: true,
              pgsMode: resolvedPgsMode,
              pgsSessionId: resolvedPgsSessionId,
              pgsFullSweep: resolvedSweepFraction >= 1.0,
              pgsConfig: { sweepFraction: resolvedSweepFraction },
              pgsSweepModel: pgsSweepModel || null,
              model: effectiveModel,
              onChunk: (chunk) => {
                if (chunk.type === 'progress' || chunk.type === 'pgs_phase' || chunk.type === 'pgs_sweep_progress' || chunk.type === 'pgs_session' || chunk.type === 'pgs_routed') {
                  eventEmitter?.({ type: 'status', message: chunk.message || 'PGS processing...' });
                }
              }
            });
          } catch (pgsErr) {
            console.error('[AI] PGS brain context injection failed:', pgsErr.message);
            eventEmitter?.({
              type: 'brain_search',
              status: 'pgs_fallback',
              pgs: true,
              error: pgsErr.message,
              message: 'PGS failed, falling back to standard brain search'
            });
            eventEmitter?.({ type: 'status', message: 'PGS failed, falling back to standard brain search...' });
            await runStandardBrainSearch();
            pgsResult = null;
          }

          // Inject PGS synthesis result as brain context
          if (pgsResult && pgsResult.answer) {
            const pgsMeta = pgsResult.metadata?.pgs || {};
            const pgsContext = `\n\n═══════════════════════════════════════════════════════════════════════════════
## 🧠 BRAIN CONTEXT (PGS — Partitioned Graph Synthesis)

The following is a deep synthesis of relevant knowledge from the brain's knowledge graph,
produced by scanning ${pgsMeta.sweptPartitions || '?'} graph partitions:

${pgsResult.answer.substring(0, 8000)}
═══════════════════════════════════════════════════════════════════════════════`;
            systemPrompt = systemPrompt + pgsContext;
            console.log(`[AI] PGS context injected (${pgsResult.answer.length} chars)`);
            eventEmitter?.({
              type: 'brain_search',
              status: 'injected',
              pgs: true,
              totalSearched: pgsMeta.totalNodes || 0,
              nodesInjected: pgsMeta.sweptPartitions || 0,
              message: `PGS: ${pgsMeta.sweptPartitions || '?'} partitions swept`
            });
          } else if (pgsResult) {
            console.log('[AI] PGS returned no synthesis');
            eventEmitter?.({ type: 'brain_search', status: 'no_results', pgs: true });
          }

        } else {
          await runStandardBrainSearch();
        }
      } catch (err) {
        console.error('[AI] Brain context injection failed:', err.message);
        eventEmitter?.({ type: 'brain_search', status: 'error', error: err.message });
      }
    } else {
      console.log('[AI] Brain not loaded - skipping context injection');
      eventEmitter?.({ type: 'brain_search', status: 'not_loaded' });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLANNING MODE: System prompt guidance (tools already restricted above)
  // ═══════════════════════════════════════════════════════════════════════════
  if (isPlanningMode) {
    systemPrompt += `\n\n## PLANNING MODE ACTIVE

You are in planning mode. Edit and create tools have been removed — you can only use read-only tools plus plan management tools.

**Your workflow:**
1. Analyze the request using read-only tools (file_read, list_directory, grep_search, codebase_search)
2. When you have a clear understanding, call **plan_create** with a title and structured steps
3. Each step should have a clear label, optional description, and the files it will touch
4. After creating the plan, explain it to the user and wait for their feedback
5. If the user wants changes, use **plan_update** to modify specific steps
6. The user will click "Execute Plan" when ready — you do NOT execute until then

**Important:** Do NOT just write a numbered list in chat. You MUST use the plan_create tool so the plan appears in the Plan Dock and can be tracked during execution.`;

    if (brainEnabled) {
      systemPrompt += `\n\nBrain knowledge has been injected into your context. Use it to inform your plan — consider what the brain knows when identifying risks, dependencies, and approach.`;
    }

    console.log('[AI] Planning mode active — write tools restricted, plan tools available' + (brainEnabled ? ' (brain-informed)' : ''));
    eventEmitter?.({ type: 'status', message: 'Planning mode — analyzing and building plan...' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAN EXECUTION MODE: Execute a previously created plan step by step
  // ═══════════════════════════════════════════════════════════════════════════
  if (executePlan && planState) {
    // Restore plan state on the tool executor so plan_status works
    toolExecutor.activePlan = planState;

    const stepsDisplay = planState.steps.map(s =>
      `Step ${s.id} [${s.status}]: ${s.label}${s.description ? ' — ' + s.description : ''}`
    ).join('\n');

    systemPrompt += `\n\n## EXECUTING PLAN: "${planState.title}"

You are executing the plan below. All tools are available. Work through each step in order.

**For each step:**
1. Call plan_status(step_id, "running") BEFORE starting work
2. Do the work using the appropriate tools
3. Call plan_status(step_id, "done") when complete, or plan_status(step_id, "failed", "error message") if it fails
4. Move to the next pending step

**Current Plan State:**
${stepsDisplay}

Execute the pending steps now. Start with the first step that has status "pending".`;

    console.log(`[AI] Plan execution mode — executing "${planState.title}" with ${planState.steps.length} steps`);
    eventEmitter?.({ type: 'status', message: `Executing plan: ${planState.title}` });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROGRESS CONTEXT: Read cosmo-progress.md for session continuity
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    const progressPath = require('path').join(currentFolder, 'cosmo-progress.md');
    const progressContent = await require('fs').promises.readFile(progressPath, 'utf-8');
    if (progressContent && progressContent.trim()) {
      const preview = progressContent.slice(0, 800);
      systemPrompt += `\n\n## Recent Progress\n\n${preview}${progressContent.length > 800 ? '\n\n[... more in cosmo-progress.md]' : ''}`;
    }
  } catch {
    // No progress file — that's fine
  }

  // IMPORTANT:
  // - The Anthropic OAuth flow needs a special system prefix ("You are Claude Code...").
  // - OpenAI/xAI Responses use a separate `instructions` field.
  // So we keep the system message content as a plain STRING for universal downstream handling,
  // and apply `prepareSystemPrompt()` only inside the Claude branch when we actually call Anthropic.
  const messages = [{ role: 'system', content: systemPrompt }];

  // ═══════════════════════════════════════════════════════════════════════════
  // OPEN FILES CONTEXT: Include other open files for IDE awareness
  // ═══════════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATION SUMMARY: Include summary of earlier conversation for context
  // ═══════════════════════════════════════════════════════════════════════════
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
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
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

  // Initialize tool executor with security boundary
  // Admin mode bypasses path restrictions
  const isAdminMode = process.env.COSMO_ADMIN_MODE === 'true';
  const effectiveRoot = isAdminMode ? null : allowedRoot;
  const toolExecutor = new ToolExecutor(indexer, currentFolder || process.cwd(), effectiveRoot, {
    allowedToolNames: availableTools.map((tool) => tool.function.name),
    disableSpreadsheetParsing: disableSpreadsheetParsing === true,
    terminalPolicy,
    terminalManager
  });
  
  // Function calling loop
  const MAX_ITERATIONS = 75;
  let iterations = 0;
  let totalTokens = 0;
  let pendingEdits = [];

  // Responses API state (stateful across tool-calling turns)
  // - OpenAI: openai.responses.create
  // - xAI:    xai.responses.create (OpenAI-compatible)
  let openaiPreviousResponseId = null;
  let openaiNextInputItems = null;
  let xaiPreviousResponseId = null;
  let xaiNextInputItems = null;
  
  // Provider detection: prefer registry, fall back to legacy heuristics
  const isClaudeModel = providerId === 'anthropic' || (!providerId && effectiveModel.startsWith('claude'));
  const isGrokModel = providerId === 'xai' || (!providerId && effectiveModel.startsWith('grok'));
  const isOllamaCloudModel = providerId === 'ollama-cloud';
  const isOllamaModel = providerId === 'ollama' || (!providerId && !isOllamaCloudModel && (
    effectiveModel.startsWith('llama') ||
    effectiveModel.startsWith('mistral') ||
    effectiveModel.startsWith('mixtral') ||
    effectiveModel.startsWith('codellama') ||
    effectiveModel.startsWith('deepseek') ||
    effectiveModel.startsWith('qwen') ||
    effectiveModel.includes(':') // Ollama models typically use format like "llama3.3:70b"
  ));
  const isOpenAIModel = providerId === 'openai' || providerId === 'openai-codex' || (!providerId && !isClaudeModel && !isGrokModel && !isOllamaModel && !isOllamaCloudModel);
  const isLocalAgent = providerId?.startsWith('local:') || requestedModelSelection?.startsWith('local:');

  const providerName = providerId || (isClaudeModel ? 'anthropic' : isGrokModel ? 'xai' : isOllamaModel ? 'ollama' : 'openai');
  console.log(`[AI] Starting ${providerName}/${effectiveModel} in ${currentFolder}`);
  
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

        // Prepare system prompt for Anthropic OAuth if needed (prepends "You are Claude Code...")
        const systemForClaude = prepareSystemPrompt(systemMsg?.content, isOAuthMode);
        
        // First pass: collect all valid tool_use IDs from assistant messages
        const validToolUseIds = new Set();
        for (const msg of userMsgs) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (tc.id) validToolUseIds.add(tc.id);
            }
          }
        }

        // Convert to Claude format, skipping orphaned tool results
        const claudeMessages = [];
        let skippedOrphanedTools = 0;

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
                  console.warn(`[AI] Failed to parse tool arguments for ${tc.function?.name}:`, e.message);
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
            // Skip orphaned tool results (no corresponding tool_use in prior assistant message)
            if (!validToolUseIds.has(msg.tool_call_id)) {
              skippedOrphanedTools++;
              console.warn(`[AI] Skipping orphaned tool_result with id: ${msg.tool_call_id}`);
              continue;
            }

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

        if (skippedOrphanedTools > 0) {
          console.log(`[AI] Cleaned ${skippedOrphanedTools} orphaned tool result(s) from message history`);
        }
        
        // Use the selected model as-is (supports switching mid-conversation).
        // If the model is provider-prefixed (e.g. "anthropic/claude-sonnet-4-5"), strip the prefix.
        const claudeModel = effectiveModel;

        console.log(`[AI] Anthropic model selected="${requestedModelSelection}" effective="${claudeModel}"`);
        console.log(`[AI] Calling Anthropic API with ${claudeMessages.length} messages in iteration ${iterations}`);

        // DEBUG: Log message structure in iteration 2
        if (iterations >= 2) {
          console.log(`[AI] Iteration ${iterations} message summary:`);
          claudeMessages.forEach((msg, idx) => {
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
            system: systemForClaude,
            messages: claudeMessages,
            tools: availableAnthropicTools
          });
        } catch (apiError) {
          console.error(`[AI] Anthropic API call failed:`, apiError.message);
          console.error(`[AI] Error details:`, JSON.stringify(apiError, null, 2).substring(0, 500));
          throw new Error(`Anthropic API error: ${apiError.message}`);
        }

        let textContent = '';
        let currentToolUse = null;
        let lastToolProgressEmit = 0; // Throttle tool_progress events

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
              // Emit progress every 500ms so frontend knows data is flowing
              const now = Date.now();
              if (now - lastToolProgressEmit > 200) {
                lastToolProgressEmit = now;
                eventEmitter?.({
                  type: 'tool_progress',
                  tool: currentToolUse.name,
                  id: currentToolUse.id,
                  bytes: currentToolUse.input.length
                });
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
        // ============ GROK / xAI (Responses API) ============
        // NOTE: xAI does NOT support 'instructions' parameter - system prompt must be
        // included as a message with role:"system" as the first item in the input array.
        // See: https://docs.x.ai/docs/guides/chat
        const trimmedMessages = trimMessages(messages, 200000);
        const xaiModel = effectiveModel;

        const toolsForResponses = buildOpenAIResponsesToolsFromChatTools(availableTools);

        // Build input items (this skips system messages, we'll add it back below)
        let inputItems = Array.isArray(xaiNextInputItems) && xaiNextInputItems.length > 0
          ? xaiNextInputItems
          : buildOpenAIResponsesInputFromMessages(trimmedMessages);

        // xAI requires system prompt as first message in input (NOT as 'instructions' param)
        const systemMsg = trimmedMessages.find(m => m?.role === 'system');
        if (systemMsg && (!inputItems.length || inputItems[0]?.role !== 'system')) {
          inputItems = [{ role: 'system', content: systemMsg.content }, ...inputItems];
        }

        console.log(`[AI] xAI model selected="${requestedModelSelection}" effective="${xaiModel}" api="responses" (system in input, no instructions)`);

        const responseParams = {
          model: xaiModel,
          // NO 'instructions' field - xAI doesn't support it!
          input: inputItems,
          tools: toolsForResponses,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          truncation: 'auto',
          max_output_tokens: 64000,
          temperature: 0.2,
          stream: true
        };

        if (xaiPreviousResponseId) {
          responseParams.previous_response_id = xaiPreviousResponseId;
        }

        const stream = await xai.responses.create(responseParams);

        let textContent = '';
        let reasoningSummary = '';
        let responseId = null;
        let outputItems = [];
        let firstEventLogged = false;
        let finalUsage = null;

        for await (const chunk of stream) {
          // Debug: log first few events to understand the stream format
          if (!firstEventLogged) {
            firstEventLogged = true;
            console.log('[XAI STREAM] First event:', JSON.stringify(chunk).substring(0, 300));
          }
          // Log all event types to diagnose missing text capture
          if (chunk.type && !chunk.type.startsWith('response.created')) {
            console.log('[XAI EVENT]', chunk.type, chunk.delta ? `delta: "${String(chunk.delta).substring(0,50)}"` : '', chunk.text ? `text: "${String(chunk.text).substring(0,50)}"` : '');
          }

          // xAI events commonly nest IDs under chunk.response.id
          if (chunk.response?.id) {
            responseId = chunk.response.id;
          } else if (chunk.id) {
            responseId = chunk.id;
          }

          // Capture final usage when present
          if (chunk.type === 'response.completed' && chunk.response?.usage) {
            finalUsage = chunk.response.usage;
          }

          // Collect output items from the stream
          if (chunk.output) {
            outputItems = chunk.output;
          }

          // Also collect individual items as they complete
          if (chunk.type === 'response.output_item.done' && chunk.item && chunk.item.type === 'function_call') {
            const existingIndex = outputItems.findIndex(item => item.call_id === chunk.item.call_id);
            if (existingIndex >= 0) outputItems[existingIndex] = chunk.item;
            else outputItems.push(chunk.item);
          }

          // Stream text deltas (preferred) - handle multiple event formats
          // xAI Responses API uses: response.output_text.delta with chunk.delta
          // or chunk.output_text_delta for older format
          if (chunk.type === 'response.output_text.delta' && chunk.delta) {
            textContent += chunk.delta;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta });
          } else if (chunk.output_text_delta) {
            textContent += chunk.output_text_delta;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.output_text_delta });
          } else if (chunk.output_text && !textContent) {
            textContent = chunk.output_text;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.output_text });
          } else if (chunk.type === 'response.text.delta' && chunk.delta) {
            // Alternative format
            textContent += chunk.delta;
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta });
          }

          // xAI sometimes emits reasoning_summary_* without any output_text.
          // If so, treat reasoning summary as content (matches Cosmo_Unified_dev unified-client workaround).
          if (chunk.type === 'response.reasoning_summary_text.delta' && chunk.delta) {
            reasoningSummary += chunk.delta;
            // Stream it so the UI doesn't look blank.
            eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta });
          } else if (chunk.type === 'response.reasoning_summary_text.done' && chunk.text) {
            reasoningSummary = chunk.text;
          }

          // Some SDKs provide usage on individual chunks; keep it if present
          if (chunk.usage) {
            totalTokens += chunk.usage.total_tokens ?? ((chunk.usage.input_tokens || 0) + (chunk.usage.output_tokens || 0));
          }
        }

        // Finalize: if no output_text was produced, fall back to reasoning summary
        if ((!textContent || textContent.length === 0) && reasoningSummary) {
          textContent = reasoningSummary;
        }

        // If usage only arrived at response.completed, account for it here
        if (finalUsage && totalTokens === 0) {
          totalTokens += finalUsage.total_tokens ?? ((finalUsage.input_tokens || 0) + (finalUsage.output_tokens || 0));
        }

        console.log('[XAI] Final text content length:', textContent.length, 'tokens:', totalTokens); // DEBUG

        xaiPreviousResponseId = responseId;
        xaiNextInputItems = null;

        const responseToolCalls = (outputItems || []).filter(i => i && i.type === 'function_call');
        toolCalls = responseToolCalls.map(tc => ({
          id: tc.call_id,
          function: { name: tc.name, arguments: tc.arguments }
        }));

        assistantMessage = {
          content: textContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : null
        };

      } else if (isOllamaModel) {
        // ============ OLLAMA (Local Models) ============
        const trimmedMessages = trimMessages(messages, 200000);

        // Get Ollama provider from registry
        const ollamaProvider = provider || registry?.getProviderById('ollama');
        if (!ollamaProvider) {
          throw new Error('Ollama provider not initialized. Make sure Ollama is running.');
        }

        console.log(`[AI] Calling Ollama with model ${effectiveModel}`);

        try {
          // Some local models (e.g., gemma) don't support tool calling reliably.
          // Keep tools enabled for models that can handle them (e.g., qwen), disable for gemma.
          const disableToolsForModel = String(effectiveModel).toLowerCase().startsWith('gemma');
          const ollamaTools = disableToolsForModel ? [] : availableTools;
          if (disableToolsForModel) {
            console.log(`[AI] Disabling tools for Ollama model ${effectiveModel} (tool-calling unsupported)`);
          }

          // Use the provider's streamMessage method with model-appropriate tools
          const stream = ollamaProvider.streamMessage({
            model: effectiveModel,
            messages: trimmedMessages,
            tools: ollamaTools,
            temperature: 0.7
          });

          let textContent = '';

          for await (const chunk of stream) {
            if (chunk.type === 'content_delta' && chunk.delta?.text) {
              textContent += chunk.delta.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta.text });
            }

            // Handle tool calls - Ollama yields them at the end
            if (chunk.type === 'tool_calls' && chunk.tool_calls) {
              toolCalls = chunk.tool_calls;
            }
          }

          assistantMessage = {
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : null
          };

        } catch (ollamaError) {
          console.error('[AI] Ollama error:', ollamaError.message);
          throw new Error(`Ollama error: ${ollamaError.message}`);
        }

      } else if (isLocalAgent) {
        // ============ LOCAL AGENT (HTTP+SSE) ============
        const trimmedMessages = trimMessages(messages, 200000);

        const agentProvider = provider || registry?.getProviderById(providerId);
        if (!agentProvider) {
          throw new Error(`Local agent "${providerId}" not registered. Check config.json providers.local_agents.`);
        }

        console.log(`[AI] Calling local agent ${providerId} (${agentProvider.name})`);

        try {
          const stream = agentProvider.streamMessage({
            model: effectiveModel,
            messages: trimmedMessages,
            tools: availableTools,
            temperature: 0.7,
            maxTokens: 64000,
            systemPrompt: systemPrompt
          });

          let textContent = '';

          for await (const chunk of stream) {
            console.log(`[AI] Local agent chunk:`, JSON.stringify(chunk).substring(0, 200));
            if (chunk.type === 'text' && chunk.text) {
              textContent += chunk.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.text });
            }
            if (chunk.type === 'content_delta' && chunk.delta?.text) {
              textContent += chunk.delta.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta.text });
            }
            if (chunk.type === 'thinking' && chunk.text) {
              eventEmitter?.({ type: 'thinking', content: chunk.text });
            }
            if (chunk.type === 'tool_use_start') {
              eventEmitter?.({ type: 'tool_preparing', toolName: chunk.toolName, toolId: chunk.toolId });
              toolCalls.push({ id: chunk.toolId, name: chunk.toolName, arguments: '' });
            }
            if (chunk.type === 'tool_use_delta' && toolCalls.length > 0) {
              toolCalls[toolCalls.length - 1].arguments += chunk.argumentsDelta || '';
            }
            if (chunk.type === 'tool_use_end' && toolCalls.length > 0) {
              const tc = toolCalls[toolCalls.length - 1];
              if (typeof tc.arguments === 'string') {
                try { tc.arguments = JSON.parse(tc.arguments); } catch (_) {}
              }
            }
            if (chunk.type === 'tool_calls' && chunk.tool_calls) {
              toolCalls = chunk.tool_calls;
            }
          }

          console.log(`[AI] Local agent stream done: ${textContent.length} chars text, ${toolCalls.length} tool calls`);

          assistantMessage = {
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : null
          };

        } catch (agentError) {
          console.error(`[AI] Local agent ${providerId} error:`, agentError.message);
          throw new Error(`Local agent error (${providerId}): ${agentError.message}`);
        }

      } else if (isOllamaCloudModel) {
        // ============ OLLAMA CLOUD (OpenAI-compatible chat completions) ============
        const trimmedMessages = trimMessages(messages, 128000);
        const ollamaCloudProvider = provider || registry?.getProviderById('ollama-cloud');
        if (!ollamaCloudProvider) {
          throw new Error('Ollama Cloud provider not initialized. Check OLLAMA_CLOUD_API_KEY in config.');
        }

        console.log(`[AI] Calling Ollama Cloud with model ${effectiveModel}`);
        try {
          const stream = ollamaCloudProvider.streamMessage({
            model: effectiveModel,
            messages: trimmedMessages,
            tools: availableTools,
            temperature: 0.7
          });

          let textContent = '';
          for await (const chunk of stream) {
            if (chunk.type === 'content_delta' && chunk.delta?.text) {
              textContent += chunk.delta.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta.text });
              continue;
            }

            if (chunk.type === 'text' && chunk.text) {
              textContent += chunk.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.text });
              continue;
            }

            if (chunk.type === 'tool_calls' && chunk.tool_calls) {
              toolCalls = normalizeUnifiedToolCalls(chunk.tool_calls);
              continue;
            }

            if (chunk.type === 'done' && chunk.response) {
              if (!textContent && chunk.response.content) {
                textContent = String(chunk.response.content || '');
              }
              if ((!toolCalls || toolCalls.length === 0) && chunk.response.toolCalls) {
                toolCalls = normalizeUnifiedToolCalls(chunk.response.toolCalls);
              }
            }
          }

          assistantMessage = {
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : null
          };
        } catch (cloudError) {
          console.error('[AI] Ollama Cloud error:', cloudError.message);
          throw new Error(`Ollama Cloud error: ${cloudError.message}`);
        }

      } else {
        // ============ OPENAI (Responses API) ============
        // GPT-5.2 best practice: use Responses API, keep state with previous_response_id,
        // and rely on truncation='auto' instead of failing hard on context overflow.

        const trimmedMessages = trimMessages(messages, 200000);
        const openaiModel = effectiveModel;

        // Reference: /Users/jtr/_JTR23_/Cosmo_Unified_dev/engine/src/ide/ai-handler.js
        // uses toolDefinitions for Responses (Chat Completions tool schema → Responses tool schema).
        const toolsForResponses = buildOpenAIResponsesToolsFromChatTools(availableTools);
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

        // Limit tool calls per iteration based on provider constraints
        const toolCallsToExecute = toolCalls.slice(0, perfHints.maxToolsPerIteration);

        if (toolCalls.length > perfHints.maxToolsPerIteration) {
          console.log(`[AI] Limiting ${toolCalls.length} tool calls to ${perfHints.maxToolsPerIteration} for ${provider?.id || 'unknown'}`);
          eventEmitter?.({
            type: 'info',
            message: `Processing ${perfHints.maxToolsPerIteration} of ${toolCalls.length} tool calls (provider limit)`
          });
        }

        // Execute tools in parallel with comprehensive error handling
        // TODO: Add concurrency limits based on perfHints.maxConcurrentTools
        const results = await Promise.all(
          toolCallsToExecute.map(async (tc, idx) => {
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

              const canonicalToolName = typeof toolExecutor.normalizeToolName === 'function'
                ? toolExecutor.normalizeToolName(toolName)
                : toolName;

              try {
                eventEmitter?.({ type: 'tool_start', tool: canonicalToolName, args, index: idx });
              } catch (emitErr) {
                console.error(`[AI] Failed to emit tool_start:`, emitErr.message);
              }

              const result = await toolExecutor.execute(canonicalToolName, args);
            
            if (result.action === 'queue_edit' || result.action === 'queue_create') {
              pendingEdits.push({
                file: result.file_path,
                instructions: result.instructions || result.message,
                edit: result.code_edit,
                isNew: result.action === 'queue_create'
              });
              if (result.file_path && result.code_edit) {
                toolExecutor.trackPendingEdit(result.file_path, result.code_edit);
              }
            }

            // Plan tool events — emit to frontend for plan dock
            if (result.action === 'plan_created') {
              eventEmitter?.({ type: 'plan', action: 'created', plan: {
                id: result.planId, title: result.title, steps: result.steps
              }});
            } else if (result.action === 'plan_updated') {
              eventEmitter?.({ type: 'plan', action: 'updated', stepId: result.stepId, step: result.step });
            } else if (result.action === 'plan_step_status') {
              eventEmitter?.({ type: 'plan', action: 'step_status', stepId: result.stepId, status: result.status, message: result.message, planState: result.planState });
            }
            
            eventEmitter?.({ type: 'tool_complete', tool: canonicalToolName, result, index: idx });
            
            // Emit tool result summary for visibility
            let summary;
            if (result.error) {
              summary = `Error: ${result.error}`;
            } else if (result.action === 'queue_edit' || result.action === 'queue_create') {
              summary = `${result.action === 'queue_create' ? 'New file' : 'Edit'} queued: ${result.file_path || 'file'}`;
            } else if (canonicalToolName === 'file_read' || canonicalToolName === 'read_image') {
              const size = result.content ? `${(result.content.length / 1024).toFixed(1)}KB` : '';
              summary = `${args?.file_path || 'file'} ${size ? `(${size})` : ''}`;
            } else if (canonicalToolName === 'create_file') {
              summary = `Created: ${args?.file_path || 'file'}`;
            } else if (canonicalToolName === 'edit_file' || canonicalToolName === 'search_replace') {
              summary = `Edited: ${args?.file_path || 'file'}`;
            } else if (canonicalToolName === 'list_directory') {
              summary = `${result.items?.length || result.count || 0} items in ${args?.directory_path || args?.path || 'directory'}`;
            } else if (canonicalToolName === 'grep_search' || canonicalToolName === 'codebase_search') {
              const matches = result.results?.length || result.matches?.length || 0;
              summary = `${matches} match${matches !== 1 ? 'es' : ''} for "${(args?.query || args?.pattern || '').substring(0, 30)}"`;
            } else if (canonicalToolName === 'run_terminal') {
              const commandPreview = (args?.command || '').substring(0, 40);
              const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : '?';
              const status = result.success ? 'ok' : 'failed';
              summary = `Terminal ${status} (exit ${exitCode}): ${commandPreview}`;
            } else if (canonicalToolName === 'terminal_open') {
              summary = `Terminal opened: ${result.session_id || 'session'}`;
            } else if (canonicalToolName === 'terminal_write') {
              summary = `Terminal input sent: ${result.session_id || args?.session_id || 'session'}`;
            } else if (canonicalToolName === 'terminal_wait') {
              const status = result.timed_out ? 'timeout' : (result.matched ? 'matched' : (result.exited ? 'exited' : 'ok'));
              const sessionId = result.session_id || args?.session_id || 'session';
              summary = `Terminal wait (${status}): ${sessionId}`;
            } else if (canonicalToolName === 'terminal_resize') {
              summary = `Terminal resized: ${result.cols || args?.cols}x${result.rows || args?.rows}`;
            } else if (canonicalToolName === 'terminal_close') {
              summary = `Terminal closed: ${result.session_id || args?.session_id || 'session'}`;
            } else if (canonicalToolName === 'terminal_list') {
              summary = `${result.count || 0} terminal session(s)`;
            } else if (canonicalToolName === 'delete_file') {
              summary = `Deleted: ${args?.file_path || 'file'}`;
            } else if (result.files) {
              summary = `${result.files.length} items`;
            } else {
              summary = 'Success';
            }
            
            console.log(`[AI] Tool result for ${canonicalToolName}: ${summary}`); // DEBUG
            
            try {
              eventEmitter?.({
                type: 'tool_result',
                tool: canonicalToolName,
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
        // For Responses API providers (OpenAI + xAI): capture BOTH function_call AND function_call_output items for next iteration
        const isOpenAIResponses = !isClaudeModel && !isGrokModel;
        const isXAIResponses = isGrokModel; // xAI uses OpenAI-compatible Responses API
        const responsesFunctionOutputsForNextTurn = [];

        // First, add all the function_call items
        if ((isOpenAIResponses || isXAIResponses) && toolCalls?.length > 0) {
          for (const tc of toolCalls) {
            responsesFunctionOutputsForNextTurn.push({
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

          if ((isOpenAIResponses || isXAIResponses) && toolCall?.id) {
            responsesFunctionOutputsForNextTurn.push({
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

          // For Responses providers, attach images only if within guardrails
          if (isOpenAIResponses || isXAIResponses) {
            if (totalChars <= MAX_IMAGE_BASE64_CHARS) {
              const contentList = [{ type: 'input_text', text: summaryText }];
              for (const r of selectedImages) {
                contentList.push({
                  type: 'input_image',
                  detail: 'auto',
                  image_url: `data:${r.result.mime_type};base64,${r.result.data}`
                });
              }
              responsesFunctionOutputsForNextTurn.push({ role: 'user', content: contentList });
            } else {
              responsesFunctionOutputsForNextTurn.push({ role: 'user', content: summaryText });
            }
          }
        }

        if (isOpenAIResponses) {
          openaiNextInputItems = responsesFunctionOutputsForNextTurn;
        }
        if (isXAIResponses) {
          xaiNextInputItems = responsesFunctionOutputsForNextTurn;
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
  } finally {
    // Release session mutex
    if (currentFolder) activeSessions.delete(currentFolder);
  }
}

module.exports = { handleFunctionCalling };
