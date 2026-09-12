# home23-embedder

Documented process name: **`home23-embedder`**. Host does **not** register this process yet (`ownedProcessNames()` / `PORT_KEYS` stay unchanged).

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
| port key | `embedder` (versioned Host plan later; not `11435`) |
| cache env | `HOME23_EMBEDDER_CACHE` (Host-selected path; never `~/`) |
| health | `GET /ready` |
| not ready | `GET /api/tags` |
| protocols | `POST /api/embeddings`, `POST /v1/embeddings` |

See `process-contract.json` and `schema/`.

onnxruntime-node may abort during native teardown after a successful warm serve (`mutex lock failed`). That is stop-path noise, not a failed encode. Host should treat listen close as stop.
