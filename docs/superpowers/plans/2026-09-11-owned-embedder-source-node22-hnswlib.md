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
install. Keep it. Rebuild only the native package against this checkout’s
lockfile:

```bash
"$NPM" rebuild hnswlib-node --foreground-scripts
```

If `node_modules` is absent, use the lockfile — still in `$H23_ROOT/source`
only:

```bash
"$NPM" ci --ignore-scripts
"$NPM" rebuild hnswlib-node --foreground-scripts
```

`npm ci` without `--ignore-scripts` would also compile other natives
(`better-sqlite3`). That is unnecessary for these two tests. Do not write
into `$H23_ROOT/home` or `$H23_ROOT/payload`.

## 3. Confirm the addon loads from source

```bash
test -f "$H23_ROOT/source/node_modules/hnswlib-node/build/Release/addon.node"
"$NODE22" -e "
  const resolved = require.resolve('hnswlib-node');
  if (!resolved.startsWith(process.cwd())) {
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
