# Source-only Node 22 hnswlib-node prep (Grok Bot)

Date: 2026-09-11  
For the isolated source checkout at `/home/box/home23-owned-embedder-test/source`.

Do **not** change `$H23_ROOT/home`, `$H23_ROOT/payload`, or `/usr/bin/node`.
Do **not** `npm install --ignore-scripts` again. That skip is why
`hnswlib-node/build/Release/addon.node` was missing.

Installed Host artifact stays `be625487`. Leave that home stopped.

## 1. Private toolchain only

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
NODE22="$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/node"
NPM="$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/npm"
export PATH="$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin:$PATH"
test "$(command -v node)" = "$NODE22"
test "$("$NODE22" -p process.version)" = "v22.19.0"
test "$(/usr/bin/node -p process.version)" != "v22.19.0"
test -f "$H23_ROOT/source/package-lock.json"
cd "$H23_ROOT/source"
unset NODE_PATH
```

`build-essential` / `python3` already on the box from the original trial.
Do not install Node via apt or nvm.

## 2. Rebuild the addon from the candidate lockfile

Source `node_modules` may already exist from the earlier `--ignore-scripts`
install. Preserve it. The private `PATH` above is required for npm's `env node`
shebang and native-build subprocesses; naming an absolute npm path alone does
not select their Node version. No system runtime or installed payload is changed.

If source dependencies are absent, prepare them from the candidate lockfile:

```bash
if [ ! -d node_modules ]; then
  "$NPM" ci --ignore-scripts
fi
```

Check the actual installed package before rebuilding it. `npm rebuild` does not
itself reconcile an existing dependency tree with the lockfile:

```bash
"$NODE22" - <<'JS'
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const installed = JSON.parse(fs.readFileSync('node_modules/hnswlib-node/package.json', 'utf8'));
const expected = lock.packages?.['node_modules/hnswlib-node']?.version;
if (!expected || installed.version !== expected) {
  throw new Error('Source hnswlib-node differs from candidate lockfile; reconcile dependencies before rebuilding');
}
console.log('Locked native package:', installed.version, 'Node:', process.version);
JS
"$NPM" rebuild hnswlib-node --foreground-scripts
```

Only rebuild the named native package in the source checkout. Do not write into
`$H23_ROOT/home` or `$H23_ROOT/payload`, and do not discard an existing dependency
tree to work around a mismatch.

## 3. Confirm the addon loads from source

```bash
test -f "$H23_ROOT/source/node_modules/hnswlib-node/build/Release/addon.node"
"$NODE22" -e "
  const resolved = require.resolve('hnswlib-node');
  if (!resolved.startsWith(require('node:path').join(process.cwd(), 'node_modules') + require('node:path').sep)) {
    throw new Error('hnswlib-node resolved outside source: ' + resolved);
  }
  require('hnswlib-node');
  console.log('hnswlib-node ok', resolved);
"
```

Stop if that throws. Do not treat payload `NODE_PATH` as a substitute.

## 4. Repeat only the two affected tests

```bash
"$NODE22" --test --test-concurrency=1 \
  --test-name-pattern 'isolated ANN worker survives a corrupt pinned-index replacement|isolated ANN worker clamps the candidate limit' \
  tests/engine/dashboard/memory-search.test.js
```

Do not rerun the full suite, package, create, ingest, or retrieve.
Do not start a live outage on a new install.
