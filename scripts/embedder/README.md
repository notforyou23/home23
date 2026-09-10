# home23-embedder (schema seams only)

Process name **`home23-embedder`** is documented here for Host Stage 4. This directory does **not** start, stop, or register that process.

- Frozen contracts: `schema/recipes.json`, `schema/http.json`, `schema/health.json`
- Helpers/tests: `../embedder-experiment/lib/`, `../embedder-experiment/seams.test.mjs`
- Stage 1 real-inference evidence: `../embedder-experiment/results/` (already measured; do not treat these schema tests as a replacement)
- **`serve.mjs` is not present.** Stage 3 may add it only after Memory’s first slice lands in source, and only as the new distinct recipe `owned-nomic-v1.5-onnx-fp32-mean-noprefix`.
- Product default flip: NO-GO. Existing-home switch: NO-GO.

`/api/tags` is not health. Health fields (`recipeId`, `dimension`, artifact digests, `warm`) are frozen; the HTTP health path is still unknown.
