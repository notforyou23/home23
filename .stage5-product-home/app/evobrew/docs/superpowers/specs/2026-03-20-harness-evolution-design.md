# Evobrew Harness Evolution — Design Spec

## Context

Evobrew is a mature AI workspace (30 tools, 7 providers, 75-iteration agentic loop, .brain semantic knowledge graphs). It's strong at Layer 7 (execution) of the harness taxonomy, partial at Layers 1 and 6, and absent at Layers 2-5.

The article "The Harness Is Everything" crystallizes the insight: the model is a commodity; the designed environment determines what the model can accomplish. Evobrew's unique advantage is the .brain knowledge graph — no competitor has persistent semantic memory feeding agent context. The evolution makes brain central to every layer, not just query.

Three pillars: close feedback loops, add planning + specs, add orchestration primitives.

---

## Pillar 1: Close the Feedback Loops

### 1A. `create_file` auto-validation

**File:** `server/tools.js` line 1575 (`createFile()`)

Currently writes to disk and returns `{ success: true }`. Add post-write `node --check` for `.js` and `.json` files:

```js
async createFile(filePath, content) {
  const resolved = this.resolveAndValidatePath(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolved, content, 'utf-8');

  // Auto-validate JS/JSON files
  const ext = path.extname(resolved).toLowerCase();
  let validation = null;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    try {
      execSync(`node --check "${resolved}"`, { encoding: 'utf-8', timeout: 5000 });
      validation = { passed: true };
    } catch (err) {
      validation = { passed: false, error: err.stderr || err.message };
    }
  } else if (ext === '.json') {
    try {
      JSON.parse(content);
      validation = { passed: true };
    } catch (err) {
      validation = { passed: false, error: err.message };
    }
  }

  return {
    success: true, path: resolved,
    message: `Created ${path.basename(resolved)}`,
    ...(validation && { syntaxCheck: validation })
  };
}
```

Agent sees `syntaxCheck.passed: false` immediately and can fix.

### 1B. `grep_search` result capping

**File:** `server/tools.js` line 1363 (`grepSearch()`)

The SWE-agent paper's #1 leverage point: cap results at 50 and tell the agent to narrow its query. Currently uses `--max-count 50` per file but no total result cap.

Add after getting output:
```js
const lines = output.split('\n').filter(Boolean);
if (lines.length > 50) {
  return {
    matches: lines.slice(0, 50).join('\n'),
    count: lines.length,
    truncated: true,
    message: `Found ${lines.length} matches (showing first 50). Narrow your search pattern for more specific results.`
  };
}
```

### 1C. `run_tests` tool

**File:** `server/tools.js` — new tool definition + executor

New tool that runs `npm test`, `node --check`, or a custom test command. Agent can verify its own work after creating/editing files.

```js
{
  type: 'function',
  function: {
    name: 'run_tests',
    description: 'Run project tests to verify changes work correctly. Uses npm test by default, or specify a custom command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Custom test command (default: npm test)' },
        file: { type: 'string', description: 'Specific file to syntax-check with node --check' }
      },
      additionalProperties: false
    }
  }
}
```

Implementation delegates to `runCommand()` with a 60s timeout. If `file` is provided, runs `node --check <file>` instead.

### 1D. Terminal output capping

**File:** `server/tools.js` line 1703 (`runCommand()`)

Apply `smartTruncate` (from `ai-handler.js` line 17) to terminal output. Import the function or inline a simpler version:

```js
// After getting output from execSync or runCompatibilityCommand:
if (output && output.length > 20000) {
  const keepStart = Math.floor(20000 * 0.6);
  const keepEnd = 20000 - keepStart;
  output = output.slice(0, keepStart) +
    '\n\n[... truncated ' + (output.length - 20000) + ' chars ...]\n\n' +
    output.slice(-keepEnd);
}
```

### 1E. System prompt trimming

**File:** `server/ai-handler.js` line 490-688 (`buildSystemPrompt()`)

The tool documentation section (lines 490-637) duplicates what's already in the tool JSON schemas passed to the API. This wastes ~2000 tokens per request. Replace with a short reference:

```
## Your Tools

You have access to: file_read, list_directory, grep_search, codebase_search,
edit_file, edit_file_range, search_replace, insert_lines, delete_lines,
create_file, delete_file, create_image, edit_image, read_image, create_docx,
create_xlsx, run_tests, terminal_open, terminal_write, terminal_wait,
terminal_resize, terminal_close, terminal_list, run_terminal.

Tool details are in their function definitions. Key patterns:
- Read files BEFORE editing
- Prefer surgical edits (edit_file_range, search_replace) over full rewrites
- Use multiple tools in parallel when independent
- Use run_tests to verify changes after editing
```

This saves ~1500 tokens while keeping the behavioral guidance.

---

## Pillar 2: Planning Mode + Spec Layer

### 2A. Planning mode (system prompt injection)

**File:** `server/ai-handler.js` around line 1066 (after `buildSystemPrompt()`)

When the user's message starts with `plan:` or a planning mode toggle is active, inject a planning preamble into the system prompt:

```js
const isPlanningMode = message.toLowerCase().startsWith('plan:') ||
                       context.planningMode === true;

if (isPlanningMode) {
  systemPrompt += `\n\n## PLANNING MODE ACTIVE

You are in planning mode. Do NOT execute changes yet. Instead:
1. Analyze the request thoroughly using read-only tools
2. Produce a structured plan with numbered steps
3. For each step: what to do, which files, what to verify
4. Identify risks and dependencies between steps
5. Wait for user approval before executing

Format your plan as a numbered list. The user will approve, modify, or reject before you proceed.`;
}
```

Frontend: Add a "Plan First" toggle button in the AI chat panel. When active, prepends `plan:` to messages. The plan response renders as a card above the chat that persists until dismissed.

### 2B. Harness manifest endpoint

**File:** `server/server.js` — new endpoint

`GET /api/harness/manifest` returns machine-readable self-description:

```js
app.get('/api/harness/manifest', (req, res) => {
  const registry = getDefaultRegistry();
  const providers = registry ? registry.getProviderStatuses() : [];
  const brainLoader = require('./brain-loader-module').getBrainLoader();

  res.json({
    version: require('../package.json').version,
    platform: require('./config/platform').detect(),
    security: process.env.EVOBREW_SECURITY_PROFILE || 'local',
    providers: providers.map(p => ({ id: p.id, name: p.name, models: p.models })),
    tools: toolDefinitions.map(t => t.function.name),
    brain: brainLoader ? {
      loaded: true,
      path: brainLoader.currentBrainPath,
      nodeCount: brainLoader.nodeCount || 0
    } : { loaded: false },
    features: {
      terminal: !!process.env.EVOBREW_TERMINAL_ENABLED !== false,
      brains: !!process.env.COSMO_BRAIN_DIRS,
      functionCalling: true,
      planningMode: true
    }
  });
});
```

Agent can call this on first message to self-orient without burning context reading docs.

### 2C. `progress_update` tool

**File:** `server/tools.js` — new tool

Agents write to `cosmo-progress.md` (or a structured `progress.json`) at end of session:

```js
{
  type: 'function',
  function: {
    name: 'progress_update',
    description: 'Update the project progress file. Call at the end of your work session to document what was accomplished, what state things are in, and what should be done next.',
    parameters: {
      type: 'object',
      properties: {
        completed: { type: 'string', description: 'What was completed this session' },
        state: { type: 'string', description: 'Current state of the project/task' },
        next_steps: { type: 'string', description: 'What should be done next' }
      },
      required: ['completed', 'state'],
      additionalProperties: false
    }
  }
}
```

Writes to `cosmo-progress.md` in the current folder with timestamp. Existing content preserved (prepend new entry). The system prompt's progress injection (line 1050) already reads this file — closing the loop.

### 2D. Brain-informed planning

When planning mode is active AND a brain is loaded, inject brain knowledge into the planning context:

```js
if (isPlanningMode && brainEnabled) {
  // Already have relevantNodes from brain context injection
  systemPrompt += `\n\n## Brain Knowledge for Planning\n`;
  systemPrompt += `Your brain has ${relevantNodes.length} relevant knowledge nodes. `;
  systemPrompt += `Consider this domain knowledge when designing your plan.\n`;
}
```

This makes evobrew's planning mode smarter than any competitor's — it's informed by a persistent knowledge graph, not just the current codebase.

---

## Pillar 3: Orchestration Primitives

### 3A. Session mutex

**File:** `server/ai-handler.js` — at top of `handleFunctionCalling()`

Prevent concurrent agent sessions on the same folder:

```js
const activeSessions = new Map(); // folder -> sessionId

// At start of handleFunctionCalling:
if (activeSessions.has(currentFolder)) {
  throw new Error(`Another agent session is active on ${currentFolder}. Wait for it to complete.`);
}
const sessionId = crypto.randomUUID();
activeSessions.set(currentFolder, sessionId);

// At end (in finally block):
activeSessions.delete(currentFolder);
```

### 3B. Edit queue filesystem consistency

**File:** `server/ai-handler.js` — in the agentic loop where `queue_edit` results are handled

When the agent proposes an edit via the queue, track the proposed content in a shadow map. When `file_read` is called on a file with pending edits, return the proposed content instead of the stale disk content:

```js
// In the agentic loop, after queue_edit:
const pendingFileContents = new Map(); // path -> proposed content

// When handling queue_edit result:
if (result.action === 'queue_edit') {
  pendingFileContents.set(result.path, result.code_edit);
}

// Pass pendingFileContents to ToolExecutor, which checks it in fileRead():
if (this.pendingFileContents?.has(resolved)) {
  return { content: this.pendingFileContents.get(resolved), pending_edit: true };
}
```

### 3C. GitHub Actions CI

**File:** `.github/workflows/ci.yml` — new file

```yaml
name: CI
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '18' }
      - run: npm ci
      - run: node --check server/server.js
      - run: node --check server/ai-handler.js
      - run: node --check server/tools.js
      - run: |
          for f in lib/*.js; do node --check "$f"; done
      - run: node scripts/audit-release-gate.js
```

### 3D. Workspace isolation (git worktrees)

This is the larger architectural piece. Each agent chat session can optionally create a git worktree:

1. `POST /api/workspace/create` — creates a worktree from current branch, returns workspace ID and path
2. Tool executor receives workspace path instead of raw `currentFolder`
3. `POST /api/workspace/merge` — user reviews diff, merges worktree changes back
4. `DELETE /api/workspace/:id` — cleans up worktree

The edit queue becomes simpler with worktrees: edits write directly to the worktree (isolated), and the merge step is the approval gate.

---

## What NOT to Build

- No issue tracker integration
- No complex DAG orchestration
- No ESLint config
- No CLAUDE.md restructuring
- No scheduled/cron agent execution
- No custom linter framework

---

## Verification

After each pillar:

**Pillar 1:** Create a .js file with a syntax error via agent chat. Agent should see `syntaxCheck.passed: false` and auto-fix. Run a grep that returns 100+ matches — should see truncation message. Use `run_tests` to verify a file.

**Pillar 2:** Send a message starting with `plan:` — should get a structured plan, not immediate execution. Check `/api/harness/manifest` returns valid JSON. Use `progress_update` tool, then start a new session and verify the agent reads the progress.

**Pillar 3:** Open two browser tabs, start agent chat on same folder simultaneously — second should be rejected. Propose an edit, then read the same file — should see proposed content, not stale disk.
