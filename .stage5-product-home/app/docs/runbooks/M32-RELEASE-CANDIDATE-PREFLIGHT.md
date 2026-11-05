# M32 release-candidate preflight

This preflight is a deterministic, read-only evidence validator. It does not inspect a live installation, infer a successful journey, mutate a database, deploy, sign, install, activate a capability, or change a feature flag or authority epoch. Its JSON output always includes `liveStateInspected: false` and `stateMutated: false`.

The implementation is anchored to final feature-off Core base `d25ba5fb6f954a8b365d3713f1300a79195208b5`. A manifest must provide full 40-character Core and Apple candidate SHAs, the exact Apple source-base SHA, SHA-256 contract and schema digests, every registered flag set to `false`, feature-off legacy/shadow epoch records, behavior evidence, a zero-P0/P1 receipt, and a digested rollback map and rehearsal.

## Evidence rules

- M14 and M15 each require a separate `live_receipt`; fixtures never count.
- M26 requires real Mac cutover evidence (`controlled_rollout` or `live_receipt`).
- M27 requires `physical_device`; simulator or fixture output never counts.
- M31 requires five passed receipts in exact order: Unread, Activity, Search, Attachments, Channel.
- Rollback rehearsal may be a controlled non-live fixture, but it must be explicitly typed, passed, and digested.
- `missing` and `failed` evidence remain blockers. Do not replace them with inferred success.

## Run

Build first, then validate a reviewed JSON manifest:

```bash
npm run build
npm run coordination:release:preflight -- --manifest /absolute/path/to/reviewed-manifest.json
```

The command writes only JSON to stdout. Exit `0` means the supplied evidence satisfies the validator; exit `1` means `blockers` is non-empty; exit `2` means invocation was unsafe or incomplete. Even a passing fixture manifest is typed `fixture` and is not proof that any live action occurred. Store live/private evidence outside Git and reference only its receipt ID and SHA-256 digest.

## Release review

Review the emitted check matrix, candidate SHAs, and digest. Independently verify referenced artifacts in the controlled evidence store. M32 tooling cannot authorize release or activation; final acceptance remains an explicit jtr decision. Keep capabilities off until the separately authorized rollout changes the relevant flag and creates a new authority epoch.
