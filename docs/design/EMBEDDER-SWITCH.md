# Switch the memory-graph embedder

The memory graph supports `ollama`, `gemini`, and `owned-onnx`. The unchanged
default is Ollama `nomic-embed-text`, with 768 dimensions and no fallback.
This setting affects the memory graph only. It does not change
`SEED_EMBED_MODEL`, Seed history, contact encoding, or the home's layout.

Configure `architecture.memory.embedding` in `config/home.yaml`. Engine
configuration layers the home setting over `configs/base-engine.yaml`, then
applies per-resident architecture settings. Partial memory settings preserve
the other base memory settings. Explicit Gemini configuration takes precedence
over the legacy embedding environment generated for Seed encoding.

```yaml
architecture:
  memory:
    embedding:
      provider: gemini
      model: gemini-embedding-2
      dimensions: 768
      fallback: none
      batchSize: 100
      timeoutMs: 30000
      maxRetries: 4
      requestsPerMinute: 60
      pricePerMillionTokens: 0.20
```

Put the key in `config/secrets.yaml` as `providers.google.apiKey` or the
top-level `GEMINI_API_KEY`. The `GEMINI_API_KEY` environment variable is also
supported. Keys travel in the `x-goog-api-key` header, never in the request URL.
Errors omit provider response bodies and request credentials.

Gemini uses `batchEmbedContents` with `outputDimensionality: 768` by default.
The adapter validates finite dimensions and defensively L2-normalizes each
vector. It caps batches at 100 inputs and retries HTTP 429 and 5xx responses
with exponential backoff and jitter. Requests have a timeout and support
cancellation. The re-embed tool paces batches using `requestsPerMinute`.

Each graph records `metadata.embedderId`, in the form
`provider:model:dimensions`. New vectors also carry `embedder_id`. A saved graph
without an identity means `ollama:nomic-embed-text:768`. A configured identity
mismatch refuses new vector writes and points to the re-embed command.
Dashboard search excludes incompatible vectors and uses keyword retrieval
when semantic retrieval cannot safely run. Old ANN indexes belong to the old
vector space and are excluded from nonlegacy queries.

## Prepare and inspect a new copy

Re-embedding is an operator action. Use an independent brain snapshot or stop
the affected engine before preparing the copy. A changing source fails resume
or publication checks. For engine brains, pass the brain directory containing
`state.json.gz` and its sidecars. Passing only the state file refuses sidecar
brains. Standalone NetworkMemory JSON files are also supported.

Save the target configuration above in a separate YAML file, for example
`/tmp/target-embedding.yaml`. Keep the running engine's configuration unchanged
until activation. All example brain paths below are placeholders.

1. Estimate the work. Dry-run is the default and makes no embedding requests.

   ```bash
   node cli/home23.js brain re-embed /path/to/brain --config /tmp/target-embedding.yaml
   ```

   The receipt includes node and character counts, characters divided by four
   as estimated input tokens, estimated cost, batch count, and time from the
   configured batch size and request rate. The default price is **$0.20 per
   million input tokens**. These are estimates, not a billing quote or duration
   guarantee. Override the price with `--price-per-million 0.20` and the rate
   with `--requests-per-minute 60`.

2. Build a separate copy with an explicit run.

   ```bash
   node cli/home23.js brain re-embed /path/to/brain --config /tmp/target-embedding.yaml --output /path/to/brain-gemini --run
   ```

   The output must be new and outside the source. The tool removes old vector
   and recipe fields in the copy before generating target vectors. It preserves
   nodes, graph edges, nonembedding metadata, and ancillary brain files.
   Engine sidecars incorporate committed deltas. Old indexes and manifests
   are replaced with a clean sidecar generation.

3. If interrupted, resume the same target and output.

   ```bash
   node cli/home23.js brain re-embed /path/to/brain --config /tmp/target-embedding.yaml --output /path/to/brain-gemini --run --resume
   ```

   Checkpoints live beside the output in `<output>.reembed-work`. Resume checks
   the source fingerprint, target identity, batch size, and saved batch hashes.
   A completed copy receives a receipt. Preparing it never activates it.

## Activate and roll back

1. Stop the affected engine through its normal lifecycle owner.
2. Set its memory-graph configuration to the target identity.
3. Activate the completed copy using the same target configuration.

   ```bash
   node cli/home23.js brain re-embed /path/to/brain --config /tmp/target-embedding.yaml --output /path/to/brain-gemini --swap --engine-pid-file /path/to/stopped-engine.pid
   ```

   The PID file must contain the affected engine's recorded PID, either as a
   number or a JSON object with `pid`. The tool requires that PID to be stopped
   and inspects process commands. Missing or ambiguous evidence refuses swap.
   An engine whose brain cannot be determined from its command also blocks
   swap, including an unrelated engine. Resolve that ambiguity before activation.
   It also checks source and output fingerprints, target identity, completion,
   and vector dimensions. Swap preserves the old brain at the backup path
   returned in the receipt. It never stops or restarts a service itself.

4. Start the engine through its normal lifecycle owner and verify retrieval.

To roll back, stop the engine first. Retain the activated brain at another path,
restore the backup to the original brain path, and restore the old
memory-graph configuration before starting the engine. Rollback restores the
backup's saved state; changes made after activation remain in the retained
new brain and require separate reconciliation.

## Owned ONNX fallback

The existing Host-owned sidecar remains supported. Select `provider: owned-onnx`,
`model: owned-nomic-v1.5-onnx-fp32-mean-noprefix`, and `dimensions: 768`.
Supply its existing loopback `baseUrl`, or use the inherited owned encoder
environment. Host preparation and lifecycle remain in `cli/lib/product-embedder.js`.
This command does not download a model or start another encoder.

`fallback: owned-onnx` can use `ownedBaseUrl` or
`HOME23_OWNED_EMBEDDING_BASE_URL`. It must match both the configured and recorded
identity before requesting a fallback vector. Equal dimensions do not establish
compatibility. A Gemini or Ollama brain therefore refuses an owned fallback
and leaves work pending instead of silently mixing spaces.

See [Home23 continuity, updates and portability](HOME-UPDATES-AND-PORTABILITY.md)
for the independent decisions about software updates, Host adoption, and Seed
encoding. Re-embedding the graph does not authorize a Seed migration.
