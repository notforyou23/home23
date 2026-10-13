# Seed owner contact

New resident births have a dedicated `contact.owner.voice` cell. Its contact
references are separate from house observations, and new owner contact earns
a workspace admission floor. Admission spends that grant. Machine corrections
route to `work.corrections`. Old contact and learned state remain intact.

The lobe may propose `owner.said`, `owner.wants`, and `owner.decided` estimates
only in the owner cell. The Seed checks their message references against
collected owner contact and captures the original evidence in the accepted
receipt. It rejects invented, assistant, peer, and machine evidence. It also
refuses evidence that exceeds the cell's state budget, without truncating it.

RECENT@seed and FACTS@seed label these as reported owner claims: revisable Seed
interpretations, not proof of truth. FACTS requires confidence of at least
0.75 and at least one original owner message. Captured evidence survives the
cell's rolling contact window. Operational fact gates remain unchanged.
Claim expiry uses event time, not checkpoint or shutdown time.

## Existing Seeds

Existing anatomy does not change on update or configuration regeneration.
The explicit operator growth step adds fresh owner and correction cells and
appends an application receipt and checkpoint. It does not move historical
refs, redistribute learned state, rewrite the chain, or change the encoder.

After the owner authorizes growth for that individual:

1. Verify the update and replay behavior on an isolated copy of its state.
2. Stop that individual's runner through its normal lifecycle owner.
3. Confirm the runner lock is released and the checkpoint covers the chain.
4. Apply growth with the authorized actor and explicit event time:

   ```bash
   node --import tsx substrate/bin/seed-enable-owner-voice.ts \
     <stateDir> <authorizedBy> <asOf-ISO-timestamp>
   ```

5. Inspect the `growth.owner-voice-application` receipt and resulting checkpoint.
6. Start the individual's runner through the same lifecycle owner.
7. Verify one new owner turn enters the owner cell and reaches its lived surfaces.

The command accepts UTC ISO timestamps, refuses an occupied lock, and refuses
uncheckpointed receipts. It never removes a stale lock. Repeating a completed
opt-in adds no second growth episode. Conflicting existing cell IDs require
operator review; the command does not rename or delete cells to force growth.

## Conversation contact and house sensing

An agent with `substrate.enabled` receives its own conversation stream.
Declared Seeds read the source paths explicitly configured in their `env`.
See [the configuration example](../../config/home.yaml.example).

The shipper collapses legacy/Core twins by role, text, and timestamp. Negative
Telegram group filenames are excluded because they lack owner attribution.
Legacy direct messages retain their inferred owner attribution. A previously
shipped legacy twin keeps its original provenance when Core arrives later.
Historical duplicate chain records are left intact.

House sensing stays opt-in. Its defaults are 20 events/hour, a five-minute
per-entity cooldown, and a 15-second poll interval. Per-agent
`houseSenseMaxPerHour`, `houseSenseEntityCooldownMs`, and `houseSensePollMs`
override them. The corresponding runner environment variables are
`HOUSE_MAX_PER_HOUR`, `HOUSE_ENTITY_COOLDOWN_MS`, and `HOUSE_POLL_MS`.
