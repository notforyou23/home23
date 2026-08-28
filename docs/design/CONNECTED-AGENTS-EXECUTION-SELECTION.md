# Connected Agents execution selection extension

Connected Agents may select a resident model alias and reasoning effort for one
message without changing the resident's defaults. This is an additive,
capability-gated extension to the accepted v1 product contract. The canonical v1
contract-pack bytes and digest remain unchanged.

## Discovery

`GET /api/v1/capabilities` advertises `modelSelection: true` only when canonical
message submission, Work/Lease persistence, and the resident catalog boundary are
all composed. A client that does not understand the additive capability continues
to send the original message body. A client must hide the controls when the
capability is false.

An authenticated client obtains choices for the exact direct Channel with:

```text
GET /api/v1/channels/{channelId}/execution-options
```

The response contains request/correlation metadata, the Channel, Conversation,
and target Bot IDs, the resident's current default provider/model/effort, its
configured model aliases, and its supported effort values. Aliases expose only
configuration metadata; credentials are never returned. A failed catalog lookup
is an unavailable control with a request ID, not permission to invent choices.

## Message mutation

The existing message body accepts two optional fields:

```json
{
  "modelAlias": "gpt56",
  "reasoningEffort": "xhigh"
}
```

Omission and explicit `null` both mean “use the resident default.” This preserves
the exact request digest and behavior of clients and idempotency keys created
before the extension. A non-null alias must be present in the target resident's
catalog, and a non-null effort must be in the advertised effort catalog. Core
validates both before committing the owner Message or Work.

The requested pair and its digest commit atomically with the owner Message's
idempotency record, closing the Message-before-Work process-crash window. It is
then persisted immutably with the Work before resident start. Retry creates a
superseding Work with the exact original pair, even if the
conversation preference or resident defaults later change. Restart recovery and
resident reattachment recover that same durable pair.

## Receipt truth

The resident emits one `receipt` communication event with source event type
`turn.selection` after its durable turn start. Its payload distinguishes:

- `requestedModelAlias` and `requestedEffort` from the owner request;
- `resolvedProvider`, `resolvedModel`, and `resolvedEffort` accepted by the
  resident runtime;
- `actualProvider`, `actualModel`, and `actualEffort` persisted on the turn.

`requestedModel` remains nullable for future direct-model requests; an alias is
never placed in that field. The raw receipt remains available in the lossless
Inspector while the calm transcript may show the actual model and effort.

## Compatibility and rollback

- Older clients omit the fields and retain byte-for-byte legacy Work request
  digest semantics.
- A resident that predates selection can still execute default/null requests;
  selected requests require the advertised catalog boundary and fail closed.
- The schema migration is forward-only and additive. Disabling the coordination
  process leaves its database untouched; an older binary must not open a newer
  schema unless its normal compatibility check accepts it.
- No authority epoch, production service, resident default, or legacy Chat route
  changes merely because this extension is present.
