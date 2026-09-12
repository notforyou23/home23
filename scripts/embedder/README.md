# home23-embedder

Process name: **`home23-embedder`**. New Host homes register it in their private supervisor and allocate an `embedder` port. Existing Host v1 homes and source installations keep their configured embedding provider.

Owned recipe only: `owned-nomic-v1.5-onnx-fp32-mean-noprefix`  
Health `recipeId` (hash): `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9`

This is **not** an Ollama drop-in. `nomic-embed-text` is rejected. Product defaults stay legacy.

```sh
HOME23_EMBEDDER_PORT=28765 \
HOME23_EMBEDDER_BIND=127.0.0.1 \
HOME23_EMBEDDER_CACHE=/explicit/cache/dir \
node scripts/embedder/serve.mjs
```

| Item | Frozen value |
|---|---|
| argv | `node scripts/embedder/serve.mjs` |
| bind | `127.0.0.1` |
| port key | `embedder` in the versioned Host v2 plan; not `11435` |
| cache env | `HOME23_EMBEDDER_CACHE` (Host-selected path; never `~/`) |
| health | `GET /ready` |
| not ready | `GET /api/tags` |
| protocols | `POST /api/embeddings`, `POST /v1/embeddings` |

See `process-contract.json` and `schema/`.

onnxruntime-node has previously aborted during native teardown after a successful warm serve (`mutex lock failed`). A successful encode does not establish successful cleanup. Host Stop checks the owned process and confirms that the encoder is no longer answering; retain any failure in the operation receipt.
