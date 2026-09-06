# Task context and compaction

Home23 separates the model's active context from retained task evidence. A checkpoint makes the next request smaller; it does not rewrite the canonical conversation. This adopts the useful pattern of notes plus searchable history described in [Codex experimental context management](https://learn.chatgpt.com/docs/config-file/config-reference). It is Home23's implementation, independent of that client experiment, subscription eligibility or experimental flag.

## What survives a window change

- Original conversation JSONL and turn records remain in place. A `.context.json` sidecar identifies the covered prefix by length and SHA-256 and stores the smaller active view. Later appends remain visible. A revision check rejects messages arriving while a summary is being generated.
- `task_context search` finds literal text in retained messages and tool results. Results have immutable `ctx_…` IDs; `read` returns paged source text with offsets. A partial search must continue with its cursor and unchanged query. A changed evidence set requires restarting pagination.
- Tool results are archived before display clipping. Complete older tool exchanges can be replaced in the active request with evidence pointers. Pending calls, user instructions and the most recent four request items are protected. The original result and whether it was an error remain available; a pointer is not a success receipt.
- Up to eight keyed task notes (1,500 characters each, up to eight evidence IDs each) survive compaction and are included in the next turn's prompt. They are model-authored aids, not standing instructions, verified facts or long-term personal memory. Notes written during a turn are available immediately through the tool and enter the system briefing on the next turn.

The tool derives its scope from the current chat; it cannot select another task. Workers require the `context` grant and receive their own notes/evidence, not the parent's history. A parent still supplies an explicit handoff. Shell/filesystem grants are separate and are not restricted by this tool's scoping.

## Triggers and budgets

At turn start, the controller reserves space for the assembled system prompt (including notes), tool schemas, incoming message, output allowance and a safety margin. The remaining history allowance triggers compaction at 80%; successful compaction targets 55%. This gap avoids immediately compacting the same window again. During tool loops, each next request is checked after operator steering; older complete tool exchanges are offloaded when pressure rises.

These are **character-based estimates**, not exact provider token accounting. Binary image transport is replaced only in the estimator with a 16,000-character allowance per image; the actual request keeps the image. Provider and image-resolution differences can still exceed an estimate. Exact configured model context limits can lower the operational budget; an unknown/new model never silently raises it. Provider context-limit errors do not cause blind replay of tools.

Optional settings under `chat.compaction` in local `config/home.yaml`:

```yaml
chat:
  historyBudget: 400000  # total operational request estimate, including reserves
  compaction:
    triggerThreshold: 0.8
    targetFraction: 0.55
    reserveChars: 8192
    keepRecentMessages: 10 # preference; adjusted at whole user exchanges
    maxSummaryChars: 6000
    promoteLongTermMemory: false
    modelContextTokens: {} # exact model or provider/model keys with verified limits
```

Older complete exchanges may move into the checkpoint when the preferred tail cannot fit. The latest exchange stays intact. Long-term memory promotion is opt-in and separate from task continuity. The manual `/compact` command uses the configured history target; it does not invent current request overhead. `task_context status` exposes the last pressure measurement, notes and trigger information.

## Failure and storage boundaries

Empty, oversized or failed summaries preserve original history. Compaction uses bounded chronological segments (32,000 characters, at most 16) and a bounded merge, rather than silently summarizing just the first few characters. If protected context cannot fit, the turn fails visibly. Already attempted tools and an interruption marker are persisted so recovery does not mistake an interrupted turn for an untouched task.

Checkpoint writes use a temporary file, file sync, rename and directory sync. A damaged or mismatched checkpoint fails visibly; canonical history remains available for inspection. An operator can recover the full active view by moving aside only the affected `.context.json` after checking writers and the canonical transcript. This is not an automatic repair, and file-level atomic writes are not a cross-process transaction or protection against arbitrary concurrent external edits.

Private evidence lives under the history directory's `task-context` subtree, separated by installation namespace, chat and reset generation. `/reset` and fresh-session rotation start a new evidence/notes scope while retaining the previous files on disk. Compaction does not delete archives. There is no automatic retention/expiry policy yet: disk usage grows with retained evidence, and privacy-aware retention needs an explicit operator policy. Individual evidence entries are limited to 16 MiB; an archive failure is logged without falsely reporting that a successfully executed tool failed. The visible result is still returned, but full-result recovery is unavailable for that failed archive.

This cannot restore facts already deleted by old compaction. Search is literal, not semantic, and scans bounded pages. Summary fidelity and whether the model chooses the right note or search remain behavioral acceptance questions.

## Verification and activation

`npm run test:context` exercises persistence, isolation, reset, concurrency rejection, corrupt checkpoints, pagination, budget accounting and actual AgentLoop requests using scripted provider replies. The loop tests verify a checkpoint, nine long tool rounds with preserved call/result pairing, note injection, exact-result retrieval, interrupted-turn retention and refusal before a request whose overhead cannot fit. `npm run test:harness` also covers delegation, cancellation and existing tool contracts.

Source tests do not activate the running installation or establish model behavior. After an authorized build/restart, validate a long real task with a late correction, old evidence retrieval, notes across a window change, cancellation and continuation. Compare requests, retained evidence and final actions. Do not enable a Codex client feature or change live model limits as a substitute for this acceptance check.

## Prompt caching

Caching and compaction solve different problems: caching reuses processing of an identical prefix; compaction limits the active request. Cache hits do not make an oversized or misleading context safe. Keep the pressure policy in force even when cache reads are high.

The harness keeps instructions before changing context and tool definitions in stable name order. Refreshing unchanged identity files now produces identical prompt text: build timestamps stay out of the prompt, while timezone and live-clock guidance remain. Cache diagnostics fingerprint full tool definitions, the stable system prefix and dynamic suffix separately, so schema drift is visible.

On Anthropic, an explicit breakpoint follows the real stable system text, including in the OAuth compatibility path. Native automatic caching also covers the growing tool conversation. Defaults use the provider's five-minute lifetime; no pre-warming traffic or longer paid lifetime is introduced. Eligibility still depends on model token minimums. [Anthropic caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

On the public OpenAI chat API, a hashed workspace/model/prompt/tool key supplies a stable cache-routing hint across tool rounds. It contains no raw workspace or chat name, excludes dynamic notes and checkpoints, and changes when the stable prompt or tools change. Keys do not guarantee a hit. Provider defaults govern retention; this pass does not send newer model-specific TTL or breakpoint options indiscriminately. [OpenAI caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching), [Chat API parameters](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Codex OAuth uses its own transport: public API cache controls are not assumed to work there. MiniMax retains its existing explicit system-cache behavior; native Anthropic automatic options and OpenAI routing fields are not sent to MiniMax, Ollama or xAI.

Each completed model call now emits a `cache` event, including tool rounds. Anthropic read/write/input counts and OpenAI/Codex reported cached-token counts are captured. `inputTotal` includes cache reads/writes, while `input` means uncached input when calculable. Missing fields are `null`, not zero; a confirmed zero read is a measured miss. This is an additive telemetry change with nullable counters; consumers must handle unknown values. Tracked turns persist these events. With the existing `CACHE_DIAGNOSTICS` option enabled, usage is also written to the diagnostic log. Failed/incomplete requests can incur charges that are not represented when their transport does not supply a completed usage record; these events are not a billing ledger.

Dynamic system context still precedes history. When it changes between turns, later cached history may be invalidated; stable instructions remain reusable. Moving that context across message roles solely for cache reuse would change authority and needs its own design and acceptance work. Likewise, compaction deliberately changes the history prefix and can cause a cache miss afterward. No live hit-rate or cost-reduction claim follows from source tests.

Run `npm run test:harness` for request-level provider coverage. The focused cache tests check OAuth breakpoints, growing tool requests, stable routing, confirmed misses versus unknown usage, every completed tool round, and exclusion of unsupported fields from compatible providers. After activation, compare cached reads/writes, total input, latency and cost on comparable tasks, including the first call after compaction. Do not use a high cache-read count alone as proof of a cheaper or better run.
