# Connected Agents M14/M15 first-canary preflight

This is preparation tooling for Core candidate
`9ae494591e164b11450323d058b684f7a3dbadd0`. It cannot run a live canary. It
does not call a database, change configuration, activate a resident, append an
authority epoch, or send a Message. Its only input is a fixture assembled from
responses already returned by supported `/api/v1` surfaces.

## Fixture capture contract

Capture and redact these outputs without message bodies, access tokens,
resident keys, or filesystem paths:

1. `GET /api/v1/capabilities`, including advertised message submission and
   event replay.
2. The complete registered feature-flag snapshot from the reviewed runtime
   configuration. M14 requires process, public API, and Jerry. M15 requires
   those plus Forrest and a retained M14 fixture receipt digest.
3. The current append-only `messages` authority epoch through its supported
   authority/operations surface. A captured public exchange must be after the
   signed transition to `canonical`, name exact writer `home23-coordination`,
   and retain its prior legacy rollback target. Flags do not move authority.
4. Stable Bot, principal, direct Channel, Conversation, mailbox, and current
   resident runtime-binding identifiers for Jerry (M14), then Jerry and
   Forrest (M15). Jerry and Forrest values must not alias.
5. A restart/resume tuple chosen before the rehearsal: `Last-Event-ID`, work
   recovery checkpoint, and idempotency key.
6. The `202 Accepted` Message response and the resumed `turn.updated` terminal
   and `message.appended` result events. Their correlation ID and Work ID must
   agree, and the resumed event watermark must advance.
7. An explicit prior legacy rollback epoch, writer, and
   `restore_legacy_authority` action. The tool records this plan; it does not
   execute it.

The TypeScript fixture shape is `FirstCanaryFixture` in
`src/coordination/rollout/first-canary-preflight.ts`. Run:

```bash
npm run build
npm run coordination:canary:fixture -- --fixture /absolute/redacted-fixture.json
```

Use `--out /absolute/new-receipt.json` to create a new mode-0600 receipt. The
runner refuses overwrite and refuses `--live`. Every successful receipt says
`evidenceMode: fixture`, `liveCanary: false`, `residentSuccess: false`, and
`verdict: fixture_ready`. The JSON receipt contract is
`docs/receipts/connected-agents-first-canary-fixture.schema.json`.

## Live gates deliberately left to humans and runtime authority

For M14 Jerry, a human operator must supply the approved maintenance window,
operator principal, reviewed full flag snapshot, current signed messages
authority history, preserved legacy rollback epoch/writer, single-writer
proof, Jerry's stable Bot/direct Conversation/mailbox mapping, a healthy and
authenticated current resident binding, a restart recovery checkpoint,
starting event cursor, unique idempotency key, and authorization to enable the
already-reviewed flags and send exactly one direct canary Message. Drift and a
read-only same-path canary happen while legacy remains authoritative. Public
message submission must remain unavailable in both `legacy` and `shadow`.
After the stopped exclusive writer applies the signed canonical epoch, the
restarted process may advertise message submission and send the authorized
user-path canary. The live system must produce the signed
authority/correlation/watermark/rollback receipt; this fixture receipt is not
a substitute.

For M15 Forrest, retain the accepted M14 live receipt and its final event
watermark, confirm Jerry remains healthy and distinct, then supply the same
human approval and runtime evidence for Forrest's distinct stable Bot/direct
Conversation/mailbox and resident binding. M15 must start from the M14 resume
boundary, use a new idempotency key, preserve the same explicit legacy
rollback authority, and receive separate authorization before its one direct
canary Message.

## Supported M14 operator seam

Build the reviewed checkout before using either command. Discovery is read-only and works even when the coordination database does not yet exist:

```bash
npm run build
npm run coordination:bootstrap:jerry -- --database <COORDINATION_DB>
```

Feature-off bootstrap is the only supported creation path. It requires operator evidence, seeds the legacy `messages` epoch if absent, and idempotently creates Jerry's persistent Bot, runtime binding, mailbox, and direct Conversation. It never starts a process or sends a Message:

```bash
npm run coordination:bootstrap:jerry -- --database <COORDINATION_DB> --apply --confirm APPLY_FEATURE_OFF_JERRY_BOOTSTRAP --authority-evidence <FEATURE_OFF_EVIDENCE_JSON> --server-instance home23-jerry-harness --key-version <JERRY_KEY_VERSION>
```

Validate a signed legacy-to-shadow, shadow-to-canonical, or canonical-to-legacy receipt without mutation by omitting `--apply`. Shadow and rollback receipts must contain all eleven flags as false. The M14 canonical receipt must enable exactly process, public API, and Jerry. Apply is deliberately double-gated and must be separately authorized:

```bash
npm run coordination:m14:authority -- --database <COORDINATION_DB> --evidence <SIGNED_AUTHORITY_EVIDENCE_JSON>
npm run coordination:m14:authority -- --database <COORDINATION_DB> --evidence <SIGNED_AUTHORITY_EVIDENCE_JSON> --apply --confirm APPLY_SIGNED_M14_AUTHORITY
```

The evidence file supplies the Ed25519 public key, append-only receipt, active canonical-writer inventory, request ID, and correlation ID. Private signing keys and resident UDS keys remain outside Git. A successful fixture or preflight is not M14 acceptance; only the separately observed real exchange and jtr-reviewed live receipt can satisfy it.

The coordination database permits one exclusive writer. Stop and drain that
exact isolated writer before an authorized epoch apply, then restart it after
the transition. Never use feature flags, a fixture receipt, or a writable
shadow projection as a substitute for the canonical epoch.
