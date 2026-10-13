# Owned embeddings in an adopted Home23 home

An adopted Host home can enable Home23's owned ONNX encoder without rebirth or
a whole-home move. Adoption preserves the previous encoder by default;
`encoderRequired: false` means Host does not require its owned sidecar.
It does not mean the home has no embeddings.

The owned profile is `owned-nomic-v1.5-onnx-fp32-mean-noprefix`, with 768
dimensions. The memory provider name is `owned-onnx`, and its graph identity is
`owned-onnx:owned-nomic-v1.5-onnx-fp32-mean-noprefix:768`.
That identity differs from `ollama:nomic-embed-text:768` despite equal dimensions.
Never reuse legacy vectors under the owned identity.

Software upgrades, Host adoption, and encoder changes are separate choices.
See [Home23 continuity, updates and portability](../design/HOME-UPDATES-AND-PORTABILITY.md)
and [memory-graph embedder switching](../design/EMBEDDER-SWITCH.md).
This guide describes an explicit operator rollout. Fixture tests of this
implementation do not establish deployment or resident retrieval acceptance.

Run the local regression suite from the source checkout with
`npm run test:adopted-home-semantics`. The tests use temporary homes and fake
providers, process inventories, and readiness probes. They need no live house
or model download.

## Preconditions

- Use an existing adopted home with a valid Host installation and port plan.
  The command does not adopt an arbitrary source directory.
- Install reviewed code through the home's authorized update workflow before
  using these commands. A scratch checkout is not the installed release.
- Retain a recoverable backup and inventory each resident's complete brain
  directory, including its state file, sidecars, and recorded engine PID.
- Stop the home's writers through its lifecycle owner and keep them stopped
  through configuration changes and brain swaps. Host admission checks its
  stopped state and supervisor inventory.
- Allow the first enable operation to download model assets. Re-embedding uses
  the ready local encoder; it does not download models or supervise processes.

Example paths below are placeholders. Replace them with reviewed absolute paths.
Use the home's bundled Node and installed application for rollout commands:

```bash
ADOPTED_HOME="/absolute/path/to/adopted-home"
HOME23_NODE="$ADOPTED_HOME/bin/node"
HOME23_APP="$ADOPTED_HOME/app"
```

## Enable and inspect the encoder

1. Preview the operation while the home is stopped.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/scripts/product/host.mjs" semantic-enable --home "$ADOPTED_HOME" --dry-run
   ```

   Dry-run reports the plan without downloading models, registering a service,
   or changing configuration. Review the allocated embedder port and target
   provider before proceeding.

2. Enable the owned service.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/scripts/product/host.mjs" semantic-enable --home "$ADOPTED_HOME"
   ```

   Host allocates an available embedder port without reassigning existing
   shared or resident ports. It prepares and verifies model assets, then
   registers only `home23-embedder` through `productSupervisorCommand`.
   The supervised process warms the model. Host checks the local readiness
   response before publishing engine settings.
   Those settings select the owned provider and its loopback address in home
   and resident memory configuration. Retain the returned result for rollback.
   The existing Seed encoder configuration remains unchanged.

   Repeating enable keeps the existing allocation and does not register a
   second encoder. Initial activation failures report an error and restore the
   saved configuration and admission state. A failed readiness recheck of an
   already-enabled service retains the enabled configuration; retry enable or
   disable deliberately. Cached model assets remain available for another attempt.

3. Inspect Host status before preparing brain copies.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/scripts/product/host.mjs" status --home "$ADOPTED_HOME"
   ```

   Confirm semantic readiness and the allocated port. Service readiness alone
   does not establish that existing brains use the owned vector space.
   Keep resident writers stopped while the engine settings and brains differ.

## Prepare and swap each resident's brain

Use a separate output for every resident. Supply the complete brain directory
when state has sidecars. Standalone memory JSON files are also supported.
Both output and checkpoint paths must be independent of the source; symbolic
links and hard links to source files are refused.

Create a separate target YAML file, for example
`/absolute/path/to/owned-embedding.yaml`, containing only these settings.
Replace `PORT` with the allocated port from enable:

```yaml
provider: owned-onnx
model: owned-nomic-v1.5-onnx-fp32-mean-noprefix
dimensions: 768
baseUrl: http://127.0.0.1:PORT/v1
fallback: none
batchSize: 32
requestsPerMinute: 60
pricePerMillionTokens: 0
```

The zero price represents local embedding requests; it excludes machine and
download costs. This file needs no provider credentials. Explicit `--config`
makes the target independent of CLI installation paths and ambient defaults.

1. Estimate one resident's migration.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/cli/home23.js" brain re-embed /absolute/path/to/resident/brain --config /absolute/path/to/owned-embedding.yaml --dry-run
   ```

   Check the source and target identities and node counts. Dry-run makes no
   embedding requests and does not modify the source.

2. Prepare an independent copy while the source remains unchanged.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/cli/home23.js" brain re-embed /absolute/path/to/resident/brain --config /absolute/path/to/owned-embedding.yaml --output /absolute/path/to/resident/brain-owned --run
   ```

   The tool replaces embeddings in the copy and records the owned identity
   and recipe provenance. It preserves graph content and nonembedding data,
   incorporates committed sidecar deltas, retires old derived indexes, and
   writes clean sidecars.
   It does not rewrite the resident's append-only Seed history.

3. If interrupted, resume the same source, target configuration, and output.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/cli/home23.js" brain re-embed /absolute/path/to/resident/brain --config /absolute/path/to/owned-embedding.yaml --output /absolute/path/to/resident/brain-owned --run --resume
   ```

   Checkpoints live at `<output>.reembed-work`. A changed source, altered
   output, or different target is refused; prepare a new copy instead.

4. Review the completed receipt before activating the copy.

   Confirm `status: completed`, the expected target identity, and node counts.
   Preserve the receipt and recovery paths. Preparing a copy does not activate it.

5. Swap the completed copy while the affected engine remains stopped.

   ```bash
   "$HOME23_NODE" "$HOME23_APP/cli/home23.js" brain re-embed /absolute/path/to/resident/brain --config /absolute/path/to/owned-embedding.yaml --output /absolute/path/to/resident/brain-owned --swap --engine-pid-file /absolute/path/to/stopped-engine.pid
   ```

   Use the engine's actual recorded PID; do not manufacture stopped-process
   evidence. The PID file contains a number or JSON with a `pid` field.
   Swap checks process inventory, source/output fingerprints, provider identity,
   vector dimensions, and completion. Missing or ambiguous process evidence
   refuses the swap. The result names the retained legacy backup.

6. Repeat for every resident before starting the home.

   Ensure each effective resident setting and active brain select the same
   provider identity. Explicit per-resident configuration overrides home
   defaults, so inspect those overrides when diagnosing a mismatch.
   Start through the normal Host lifecycle after every resident is consistent.
   Verify retrieval and new vector writes for each resident through use.

The memory adapter refuses writes across provider identities. Mixed node
identities are also refused by migration validation. Refusals protect the
brain; they are not proof that retrieval worked after activation.

## Disable and roll back

Before any brain swap, keep writers stopped and preview disable:

```bash
"$HOME23_NODE" "$HOME23_APP/scripts/product/host.mjs" semantic-disable --home "$ADOPTED_HOME" --dry-run
```

Then restore the saved configuration and remove the owned service registration:

```bash
"$HOME23_NODE" "$HOME23_APP/scripts/product/host.mjs" semantic-disable --home "$ADOPTED_HOME"
```

Disable is idempotent. It restores the pre-enable configuration and Host state
instead of inventing legacy settings. Unexpected intervening configuration
changes refuse automatic restoration; review the error and recovery record
before proceeding. Disable does not rewrite a brain or delete model caches.

After a brain swap, stop all affected writers first. Retain each activated
owned brain at a new recovery path, then restore its corresponding legacy
backup to the original brain path. Restore standalone receipt files with their
brains. Only then disable the owned service and restore the previous effective
engine configuration. Confirm the restored provider and active brain identity
match before starting the home.

Restoring a backup returns that brain to its saved state. Work written after
the owned swap remains in the retained owned brain and needs separate
reconciliation. Do not discard either brain to make rollback appear complete.
