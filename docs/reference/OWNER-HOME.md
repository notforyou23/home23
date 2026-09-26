# Owner home and Home23's runtime home

Under the Home23 Host every Home23 process runs with `HOME=<home>/runtime/user`. That is Home23's private runtime home for its own tools: npm, the managed Chrome profile, Caddy, Python caches and provider-CLI stores. It can be rebuilt and is left out of home backups. The owner's macOS account home is a different directory.

## The rule

- `~` in any path the owner or a resident names means the owner's account home, never `HOME`.
- `productEnvironment()` in `cli/lib/product-environment.js` names the owner home in `HOME23_OWNER_HOME`. The value comes from the passwd entry (`ownerAccountHome()`) and is computed at every launch. The same function sets `HOME23_RUNTIME_HOME` (the same directory as `HOME`) and `CDP_USER_DATA_DIR` (the managed Chrome profile inside it). `HOME`, `USER` and `PM2_HOME` do not change.
- Never write the owner home into a home setting. The update preflight refuses absolute paths outside the home in `.home23-host.json`, `app/.home23-state.json`, `home.yaml`, `targets.yaml` and `secrets.yaml`. Keep `~/...` in those files and expand it where it is read.

## Resolving it in code

- Engine, dashboard, harness and scripts use `shared/owner-home.cjs`; TypeScript uses `src/security/owner-home.ts`.
  - `ownerHome(env)` returns `HOME23_OWNER_HOME`. Outside the Host (no `HOME23_PRODUCT_HOST`) it falls back to `HOME`, so development checkouts and tests can redirect it. Otherwise it falls back to the passwd entry.
  - `expandOwnerPath(p, env)` expands only `~` and `~/x`. It leaves `~user`, relative paths and absolute paths unchanged.
  - `runtimeHome(env)` returns `HOME23_RUNTIME_HOME`, falling back to `HOME`. It is for Home23's own state.
- `cli/lib` uses `ownerAccountHome()` from `product-environment.js`, which applies the same passwd rule. The retained update executor copies only `./` imports, so `cli/lib` never loads `shared/owner-home.cjs`.
- Shell scripts use `${HOME23_OWNER_HOME:-$HOME}`. Python uses `os.environ.get('HOME23_OWNER_HOME') or pwd.getpwuid(os.getuid()).pw_dir`. The owner's own cron has only `HOME`, and these forms keep working there.
- A child process that acts for the owner gets its environment from `ownerChildEnv()` in `shared/child-process-env.cjs`. Under the Host that environment's `HOME` is the owner home, `HOME23_RUNTIME_HOME` still points to Home23's runtime home, and privileged keys are removed.

## Home23's own state

Home23's private state stays on the runtime home, read through `runtimeHome()` or through `HOME` on a line marked `product-private:`. `tests/scripts/repo-hygiene-owner-home.test.mjs` classifies every home read in shipped code as owner rule, product-private or pending. Pending reads stay unchanged until a named decision is made. Any new home read fails the test until it is classified.
