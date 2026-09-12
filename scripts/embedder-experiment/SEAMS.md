# Encoder seams (not Stage 3)

Frozen fields Memory/Host can depend on live in `scripts/embedder/schema/`.

| Profile | `recipeId` (sha256 of canonical fingerprint) |
|---|---|
| `legacy-ollama-nomic-unprefixed` | `5128b29c886857aeb89b148d2d9f2edf2c20f63de15a764342c2a18da640f71a` |
| `owned-nomic-v1.5-onnx-fp32-mean-noprefix` | `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9` |

Hashes were computed from `results/recipe-pin.json` (already-measured Stage 1 artifact digests). No new model download. No service.

```sh
node --test seams.test.mjs
```

These tests are **fixtures**. Real Ollama/ONNX numbers stay in `results/stage1-*.json`.
