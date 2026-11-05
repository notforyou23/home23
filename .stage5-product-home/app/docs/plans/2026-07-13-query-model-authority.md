# Query and PGS Model Authority

**Date:** 2026-07-13
**Status:** Implemented

## Problem

Home23 Chat and the Query tab currently advertise different provider/model sets.
Chat reads `config/home.yaml` provider `defaultModels`, while Query reads COSMO's
separate model catalog and dynamic discovery output. Dashboard admission and the
COSMO worker can also load different local catalog files. A model may therefore
appear in Query and fail in Direct Query, PGS sweep, or PGS synthesis, while new
Chat models may be missing from Query entirely.

## Authority

`config/home.yaml` provider `defaultModels` is the declaration authority for the
models Home23 offers. The selected agent's Chat pair is the fallback assignment
authority. Query-specific Direct, PGS sweep, and PGS synthesis preferences remain
valid only when their exact provider/model pair belongs to that shared list.

One shared builder produces:

- the exact configured provider/model rows shown by Chat and Query;
- capability-complete execution rows using provider-level transport limits;
- validated Direct, PGS sweep, and PGS synthesis defaults;
- a managed COSMO catalog projection for the protected worker.

No Query or PGS code chooses a literal model name. A missing or stale role
preference falls back to the agent's configured Chat pair. An unconfigured Chat
pair fails closed instead of silently choosing the first model.

## Runtime Flow

1. Query catalog reads the shared Home23 authority and COSMO health/brain state.
2. Direct Query, PGS sweep, and PGS synthesis selectors use the same exact rows.
   The Chat picker also encodes the exact pair, so duplicate model IDs under
   OpenAI and OpenAI Codex cannot silently switch providers.
3. Dashboard operation admission validates the selected exact pair against the
   same capability-complete catalog.
4. Home23's COSMO config seeder writes the same catalog projection into the
   managed COSMO config directory.
5. The protected COSMO worker validates and executes against that projection.

Dynamic discovery may inform diagnostics, but it does not silently add models to
Home23's selectable list.

The earlier `/query`, `/query.html`, `/api/query*`, and `/api/pgs` surface is
retired fail-closed. Its page URLs permanently redirect to `/home23#query`; its
APIs return `410 legacy_query_api_retired` with the canonical durable endpoints.
This prevents bookmarks and older dashboard panels from bypassing exact-pair
validation through the model-only compatibility implementation.

## Verification

- Contract test that Query no longer fetches `/api/providers/models` when the
  Home23 authority is available.
- Unit tests for exact list parity, duplicate model IDs across providers, stale
  preference fallback, and capability completion for newly configured models.
- Unit test that dashboard provider runtime accepts agent-scoped validated
  defaults without consulting legacy global Query defaults.
- Seeder test that the managed COSMO catalog contains the configured list and is
  accepted by COSMO's catalog validator.
- Live readback that Chat and Query expose the same exact pairs.
- Minimal provider acceptance probes and real Direct Query/PGS operations with
  wait-aware completion checks.

## Deployment evidence

- Chat, the Home23 Query tab, and managed COSMO each advertise the same 31 exact
  provider/model pairs. Duplicate model IDs under different providers remain
  distinct choices in both Chat and Query.
- Every advertised pair completed a bounded provider acceptance probe. Six
  provider-retired choices that failed their real provider were removed from
  both the public example and the live authority.
- A real durable Direct Query completed as operation
  `brop_6Kl-dTW7N8KWVWSMxPT4QPZC6AuzBR7h` through the exact configured pair
  `openai-codex / gpt-5.5` in 53.1 seconds, with a healthy `manifest-v1` source,
  fresh ANN, and a non-empty final answer.
- The Codex transport no longer applies Undici's unrelated five-minute header
  and body timeout underneath the operation's provider-stall and hard deadlines.
- PGS request validation preserves exact sweep and synthesis pairs across fresh,
  continue, and targeted modes and skim, sample, deep, and full levels. The live
  default is the previously verified worker pair
  `openai-codex / gpt-5.4-mini` for both sweep and synthesis.
- A real targeted skim PGS operation
  (`brop_jEkr_vDSM64gQkn33ldI3S5kDjDb9icG`) completed against cluster `c-13`
  in 72.6 seconds. It selected and completed one new work unit, recorded the
  exact `openai-codex / gpt-5.4-mini` sweep pair, and returned a non-empty final
  answer from a healthy source with fresh ANN.
- ANN metadata loading now streams the pinned metadata instead of parsing its
  full JSON document into the V8 heap. A 25,000-label oversized-metadata
  regression retained 24,151,048 bytes of heap under a 128 MiB old-space cap;
  a one-million-label amplification stream failed with a typed error while
  retaining only 5,063,248 bytes. Source counts, per-label bytes, suffix bytes,
  scalar fields, and total label cardinality are all checked before retention.
- ANN labels use one shared builder/loader projection contract, so the builder
  cannot publish metadata that the dashboard then refuses. Native HNSW indexes
  run in an isolated child process: load plus search is one exclusive lease, and
  a cross-brain, revision replacement, or cancelled search kills and waits for
  the prior child before the next index loads. A separate 60-second native-search
  watchdog prevents a connected request from holding that lease indefinitely;
  it does not shorten provider, Query, or PGS waits. The OS therefore reclaims
  native HNSW memory even after a native crash. A real valid-to-corrupt-to-valid
  replacement test recovered without crashing the dashboard or pairing an old
  label map with a new index.
- The real anchored 142,231-label Jerry index loaded and searched successfully
  under a 512 MiB dashboard old-space cap. Three forced anchored child-process
  replacements retained approximately 131.7 MiB of dashboard heap; dashboard
  parent RSS ended at 313,229,312, 446,889,984, and 454,361,088 bytes with a
  456,736,768-byte parent peak instead of accumulating native indexes in the
  dashboard. Three consecutive full live brain partition scans also returned
  142,231 nodes and 286 partitions each, with post-GC heap flat at approximately
  5.4 MiB.
- The complete release test command passed, including the controlled
  100,000-node/300,000-edge PGS acceptance with 400 retained sweep outputs.
  Its groups passed 38 pretests with one linked-worktree skip, 244 agent, 433
  COSMO/shared, 12 dashboard, 54 CLI, 1,176 engine, 231 acceptance/script, and 2
  legacy-route tests.
- `npm run build` and the contract suite passed; contracts reported 50 passes
  and one intentional live-only skip.
- After exact dashboard-only restarts, the live contract validator passed and
  both resident memory-search routes returned HTTP 200 with five results,
  `sourceHealth=healthy`, `implementation=manifest-v1`, and fresh revision-pinned
  ANN indexes (Jerry in 4.245 seconds; Forrest in 3.047 seconds). Each dashboard
  retained one isolated ANN worker, while both engines, harnesses, MCP services,
  and COSMO remained online without restart.
