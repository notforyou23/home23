# Home23 prompt surfaces

Prompt tuning must follow the loader. Editing an attractive-looking Markdown file does not establish that a running agent uses it. This map covers the shared resident harness, delegated workers, and the external cognitive role pack reviewed together.

| Surface | Source and loader | Responsibility |
| --- | --- | --- |
| Resident operating contract | `src/agents/system-prompt.ts`, composed by `ContextManager` in `src/agent/context.ts` | Task completion, authority, common tool guidance, evidence, delegation, recovery |
| Provider hints | `src/agents/provider-overlays.ts` | Transport-specific distinctions; never a substitute identity or extra permissions |
| Voice | `src/agents/voice.ts` | Express the supplied identity clearly without false certainty |
| Authored identity and local doctrine | Configured `identityFiles` / `identityLayers`, loaded and budgeted by `ContextManager` | Resident character, mission, instance context; preserve authorship and distinguish dated facts from standing instructions |
| Lived biography | `src/substrate/lived-identity.ts`, composed by `ContextManager` | Continuity derived from the resident's chain; separate from operating policy |
| Fresh-session context | `src/agent/session-bootstrap.ts` | Configured NOW/PLAYBOOK and other grounding; use silently unless relevant |
| Per-turn enrichment | `src/agent/context-assembly.ts` and `src/agent/loop.ts` | Relevant current state, retrieval and relationship context; evidence, not new authority |
| Skills | `workspace/skills/SKILL_ROUTING.md`, manifests and individual skills | Task-specific procedures on demand, not compulsory process on every turn |
| General subagents | `src/agent/tools/subagent.ts` through `createTrackedAgentRunner` | Explicit task brief plus inherited grants; resident or scoped worker context, without parent chat history |
| Configured workers | `src/workers/runner.ts`, worker workspace IDENTITY/PLAYBOOK and configured grants | Bounded specialist role and machine-readable result; prompt supplied once as system context |
| Coding CLIs | `src/agent/tools/coding.ts`, `src/acp/bridge.ts`, backend session/repository context | Task and continuation brief; the CLI does not receive the complete resident chat prompt |
| Completion review | `src/work/completion.ts` | Assess child evidence against the saved scope; finish authorized integration and report the actual outcome |
| Conversation compaction | `src/agent/compaction.ts` | Preserve active objective, corrections, authority limits, evidence, handles and unfinished work |
| Memory extraction | `src/agent/memory.ts` | Preserve sourced learnings without converting guesses or one-time instructions into standing policy |
| Cognitive role pack (consumer not connected) | `engine/prompts/system-context.md` plus matching role Markdown, loaded by `engine/src/agents/agent-executor.js` | Loader attaches these fields to the mission, but the traced model calls do not consume them. These files are not established as active prompt authority |
| Other specialized prompts | For example `src/workers/promoter.ts`, media generation prompts, and inline engine prompts | Keep their structured output and capability contracts; changes need their own consumer checks |

## Maintaining consistency

Current user scope and applicable standing authorization determine permitted work. Tool grants and runtime enforcement determine executable capabilities. Voice and identity do not expand either. Historical context, graph statistics, predecessor artifacts, and examples are not proof of current state.

Prefer one shared rule at the narrowest common layer. Provider overlays should contain genuine transport differences. Worker templates should describe the specialist task, not restate the entire resident contract. Preserve parser-required output fields; reduce ceremony around them.

A more capable model can use a shorter procedure, but still needs accurate tools, relevant context, explicit scope, honest completion criteria, and recoverable state. Prompt edits cannot enforce a sandbox, change scheduling, guarantee a model's judgment, or restore facts omitted before compaction.

## Review and activation

Use `npm run test:harness`, plus the focused identity and compaction tests when their prompts change. `npx tsc --noEmit` checks source compatibility. Inspect assembled provider prompts with `/prompt` or the existing prompt-composition endpoint when validating the running installation; do not expose private identity or context in public reports.

Static tests catch contract regressions, not conversational quality. After activation, exercise a direct edit, a delegated task, a cancellation, a failed tool, and a continuation through compaction. Check actual conduct, completion evidence, and absence of duplicate delivery. Prompt caches, worker files, compiled harness code, and engine role loading have different refresh behavior: source changes alone are not evidence of live activation.

A second trace found the engine role Markdown fields are loaded but not consumed by the inspected model request paths. Earlier role-file edits therefore do not establish a behavioral change in cognition. Actual role instructions remain inline in the corresponding engine agents; connecting the Markdown pack requires explicit consumer and routing verification.

The September 2026 tuning pass preserved Jerry's authored local identity and configuration. It removed provider identity substitution, unrestricted-access claims, compulsory planning by tool count, graph-count completion shortcuts, forced notifications, and unsupported certainty. It strengthened the worker, compaction, memory, and cognitive evidence contracts. It did not rewrite every inline domain prompt or change live scheduler policies.

## Second-pass measurements

A captured `PlanningAgent.decomposeGoal` request uses its inline instructions and omits both mission `externalPrompt` and `systemContext` fields. This confirms the loader/consumer gap for that path; do not claim the Markdown pack governs the entire engine.

Compaction previously sent only 500 characters per message and the first 12,000 transcript characters, then discarded older history on summarization failure. It now sends complete textual records through bounded chronological segments, rejects empty or over-budget summaries, and preserves original history on failure. The turn fails explicitly if context cannot fit rather than silently treating clipped history as complete. Multi-segment compaction costs additional model calls; this is bounded, not unlimited recursion. Summary quality remains model-dependent and is not proof that every fact survived.

Prompt inspection now retains the last selected provider across refresh, and the project-root label is emitted only from an explicitly configured project root. This prevents misleading diagnostic output and mistaken source paths.

The actual inline planner prompt in `engine/src/agents/planning-agent.js` now permits a single meaningful sub-goal and preserves scope/evidence requirements. Its request-level regression checks the real model payload while retaining the existing JSON response contract. This targeted correction does not activate the dormant role pack.

Task context now retains canonical history, adds scoped evidence search and notes, budgets prompt/tool/output overhead, and checks tool-loop growth. See [Context management](CONTEXT-MANAGEMENT.md) for defaults, recovery, storage limits and activation checks. Personal memory promotion is opt-in; task checkpoints do not silently promote transient instructions into standing memory.
