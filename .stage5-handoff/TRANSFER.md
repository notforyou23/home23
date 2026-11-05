# Transfer this folder to Grok Bot

Do not `git push`. Do not tell Grok Bot to pull GitHub.

Unpack the uploadable archive. `cd` into the unpacked directory
(the one that contains this file) before checking the bundle:

```bash
sha256sum -c home23-owned-embedder-be625487.bundle.sha256
# expect 1ac7adf9972e99fe83b0ea251dd60909935fb6b41e281f62ffa0543c3f23923d
```

The `.sha256` file names only the bundle basename so that check works
after copy. Then follow `2026-09-11-owned-embedder-linux-handoff.md`
against `BASELINE-AND-RETEST.md`.

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"
mkdir -p "$H23_ROOT"
git clone home23-owned-embedder-be625487.bundle "$H23_ROOT/source"
git -C "$H23_ROOT/source" switch --detach \
  be6254879fc8c22a6265e6010ac0284f70f4329b
```

`candidateSha` is `be6254879fc8c22a6265e6010ac0284f70f4329b`.
Do not export `HOME=$HOME_ROOT`. Preserve `/home/box/home23-test`,
Keep/GrokBot, and host Ollama.
