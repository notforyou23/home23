# Automatic model discovery

Home23 reads model choices from each configured provider. Catalog reads return
cached choices promptly and coalesce automatic refreshes. A resident process
checks for expired snapshots in the background. Snapshots are fresh for at most
15 minutes; failed refreshes retry after one minute.

The installation stores non-secret metadata in
`instances/.house/model-catalog-cache.json`. Each provider snapshot is keyed by
the provider, endpoint, authentication mode, account, exact credential hash and
provider configuration. A different identity cannot reuse another identity's
snapshot. Tokens and authentication headers are never persisted in this cache
or returned through the model APIs.

A complete, successful snapshot replaces that provider's choices, including
removing omitted or retired models. A failed request, invalid response or partial
pagination retains the prior complete snapshot for the same identity and marks
it stale. Before the first successful snapshot, configured `defaultModels` form
a visibly stale fallback. Disconnected providers have no available choices.

Discovery does not rewrite `home.yaml`, choose another default, change a resident,
alter an encoder, pull local models, or create scheduled Codex automations.
Saved unavailable selections remain saved and appear in `unavailableSelections`.
Compatible custom aliases retain their exact provider/model identity. Automatic
aliases use `provider/model`; identical IDs from two providers remain distinct.
An admitted turn retains the pair it already resolved.

## Provider sources

- OpenAI: authenticated `/v1/models`. This endpoint supplies identities rather
  than a complete capability description. Reviewed text families are eligible;
  unknown, embedding, audio, image and moderation IDs remain diagnostics.
  [API reference](https://developers.openai.com/api/reference/resources/models/methods/list)
- OpenAI Codex: authenticated `/backend-api/codex/models`, using the existing
  Home23 OAuth broker and account headers. API support, visibility, context and
  reasoning metadata come from this separate account catalog.
  [Provider client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs)
- Anthropic: paginated `/v1/models`, including lifecycle and capability metadata.
  [API reference](https://platform.claude.com/docs/en/api/models/list)
- xAI: `/v1/language-models`, which describes input and output modalities.
  [API reference](https://docs.x.ai/developers/rest-api-reference/inference/models)
- MiniMax: `/v1/models` at the configured regional endpoint. Only adapter-supported
  text families or authoritative chat capability metadata enter agent choices.
  [API reference](https://platform.minimax.io/docs/api-reference/models/openai/list-models)
- Ollama Local and Cloud: `/api/tags`, then `/api/show` for completion, tools and
  thinking capabilities. Local discovery reads installed models only.
  [Cloud catalog](https://docs.ollama.com/cloud),
  [thinking metadata](https://github.com/ollama/ollama/blob/main/docs/capabilities/thinking.mdx)

## Client compatibility

Settings `/models` adds `catalog`, `discovery`, `configuredAliases` and
`unavailableSelections`. Provider `defaultModels` in this response describes
effective choices; it does not overwrite the saved lists.

Execution options, the resident catalog and the chat bridge add `modelOptions`,
the complete model array. Each row adds `reasoningEffortOptions` and
`defaultReasoningEffortOption`. New clients prefer these fields. Per-model
capabilities control admission and transport; arbitrary efforts are not granted
to unrelated models. Missing metadata stays unknown:
`reasoningCapabilitiesKnown:false`, empty `reasoningEffortOptions`, and a null
model default. That model inherits the saved runtime defaults without a new
effort override. An explicit negative provider capability can establish `none`.
Provider metadata can introduce new effort IDs without a model-family
allowlist discarding them.

Provider model defaults remain metadata; discovery never inserts them into an
alias's `reasoningEffort`. Existing explicit alias efforts and the absence of an
override are both preserved. Agent aliases deep-merge over house aliases.
The envelope `reasoningEffortOptions` contains the exact advertised option union
and the effective saved default. All additive fields survive the resident and
public execution-options transports. A turn captures its capability/transport
and provider request descriptor once, so later catalog refreshes cannot alter
an admitted tool loop.

In execution rows, `defaultReasoningEffortOption` is the saved alias override,
or null to inherit the envelope's actual agent/home default. It preserves future
effort IDs that cannot appear in the legacy `reasoningEffort` field. The Settings
`catalog` retains the provider's model-default metadata separately. Execution UI
therefore shows the same effort that the runtime resolves.

Legacy `models` contains at most 128 compatible rows, with the current default
included when compatible. Its `reasoningEfforts` contains only supported members
of the original six-value vocabulary and is never empty. A model supporting only
new effort IDs appears exclusively in `modelOptions`. Legacy default fields
retain a decodable value; additive fields preserve the actual configured value.

Query reads the same exact available pairs. A saved retired Query default causes
an explicit unavailable-model error when used, while a current explicit choice
can still run. The dashboard refreshes its resolver at operation boundaries.
