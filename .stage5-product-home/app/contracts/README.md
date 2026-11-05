# Home23 iOS Contract Seed

This folder captures the API surface the iOS app currently depends on. The intended steady state is for the main Home23 repo to own this folder, with the iOS app importing a generated or copied snapshot.

## Source Of Truth

- Main Home23 should own `contracts/`.
- iOS should decode these fixtures in a lightweight contract test target.
- Backend tests should validate representative live responses against these schemas.
- New client-facing fields should land here before app code depends on them.

## Versioning

Use a date-based contract version until release pressure justifies semver:

```text
2026.06.26
```

Compatible changes:

- adding optional fields
- adding enum values when clients already treat unknown strings as display text or fallback states
- adding new endpoints

Breaking changes:

- removing fields marked `required`
- changing field types
- changing selected-agent routing semantics
- moving dashboard vs bridge endpoints between ports without a capability signal

## Recommended Handshake

The dashboard control plane exposes this endpoint:

```http
GET /home23/api/client-capabilities
```

Its schema is in `schemas/client-capabilities.schema.json` and a sample is in `fixtures/client-capabilities.json`.

The iOS app should also include app and contract metadata in device registration so Home23 can identify old clients:

```json
{
  "platform": "ios",
  "appVersion": "1.0.0",
  "build": 1,
  "contractVersion": "2026.06.26"
}
```

## Manifest

`manifest.json` maps every Apple-consumed route family to:

- HTTP method
- dashboard or bridge base
- route and optional live smoke route
- schema file and definition
- fixture
- auth mode
- live validation mode
- Apple consumers

Run static fixture/schema validation with:

```bash
npm run test:contracts
```

Run live read-only validation with:

```bash
npm run test:contracts:live
```

Routes marked `requires-action`, `requires-stream`, or `fixture-only` are intentionally skipped by the read-only live validator.

## Starter Schemas

- `agent-roster.schema.json`
- `chat.schema.json`
- `client-capabilities.schema.json`
- `home-surfaces.schema.json`
- `query.schema.json`
- `sauna.schema.json`
- `settings.schema.json`
- `device.schema.json`
- `worker-agents.schema.json`

These are derived from the Swift wire types in the iOS app. They are deliberately permissive for unknown fields while strict about the fields the app needs to decode.
