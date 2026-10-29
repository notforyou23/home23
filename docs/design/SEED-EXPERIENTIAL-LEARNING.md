# Seed experiential learning

Seed carries both factual continuity and procedural development. An observation
can update retained context without changing a habit. Conduct feedback and
outcomes need an attributable connection to the earlier choice, and the next
relevant selector must consume the result.

This implementation extends the existing developmental state and receipts.
It creates no parallel memory database, service, or recurring model call.

## Decisions and teaching

Runtime selectors append `LearningDecisionObserved` to the existing event
ledger. Its bounded `home23.learning-decision.v1` payload preserves occurrence
identity, scope, tags, source references and criterion. Seed retains that
original decision as eligibility; later unrelated cell residue is not its
replacement.

`relationship_note` supports authenticated attenuation and positive conduct
feedback. The stored claim must preserve the current owner's words and pass
the existing one-shot ingress check. An agent note cannot mint owner authority.
Learning metadata links the original decision, direction, evidence, scope and
exclusions. A linked lesson retains all original applicability tags; a model
cannot broaden it by omitting tags. A standing instruction can persist within
that linked scope. Unlinked preferences remain contextual knowledge; a model's
choice of a scope name cannot turn them into executable authority.

`relationship_recall({learning:true})` reads recent real decisions and active
lessons from the runtime-bound Seed. It supplies occurrence identities for
later teaching without requiring a large journal scan or another prompt block.

The tool distinguishes an ordinary preference from an explicit instruction
about future conduct. A recognized authenticated conduct instruction cannot
silently succeed as a contextual preference: it asks the model to recall an
actual matching decision and retry through the teaching path. This refusal
does not consume correction authority or convert a note automatically. Conduct
feedback requires the entire current authenticated message, including any
attribution, and a decision identity in its schema. Learning recall exposes the
actual available scopes so a descriptive label is not mistaken for an empty
learning history. Results explicitly identify context-only storage when no
conduct feedback was recorded.

Source projection is separate from Seed application. Relationship entries and
memory objects retain pending projection metadata in their existing stores.
Stable event identities, fsynced append, duplicate/conflict checks and turn-entry
retry preserve delivery across interruption. A projection acknowledgement does
not refresh a fact's observation timestamp. Tool results distinguish stored,
projected and not-yet-confirmed Seed application.

Factual memory promotion preserves its before/after and applicability metadata
as an observation. A new personal fact does not automatically alter alert
thresholds, teacher trust or personality.

## Outcomes and consolidation

New predictions capture their decision-time continuous vector. New resolutions
must cite collected, fresh, relevant outcome references matching the claim's
criterion, with an explicit reason. Model self-description and unrelated later
owner contact are insufficient. Canonical reply links can ground short answers
against their actual retained question. Conservative unique named-subject
matching supports declarative paraphrases as assessments, not verified truth.
Execution receipts prove execution; they cannot
establish task accomplishment or owner value merely because an operation ended.

Prediction learning applies a bounded contribution along the original captured
vector. Each new contribution retains its own evidence and consolidation
status. An unrelated success in the same cell cannot corroborate it. Explicit
owner preferences persist until superseded or limited; silence does not reward
or erase them. Applicable owner teaching takes precedence over empirical
capability scores; a successful handler is not permission to cancel it.
Inferred contributions remain provisional. They age on a bounded
thirty-minute event-time cadence even when continuous sensing prevents a quiet
gap. Legacy quiet-gap semantics remain unchanged. Corroboration needs
a distinct, attributable opportunity and cannot count the same attempt twice.

Natural-language relevance and a cited outcome do not prove logical entailment.
Keep the model's interpretation and the source's observation distinct. A
receipt proves the admitted change, not infallible judgment or subjective
experience.

## Actual consumers

- The existing engine owner-attention policy consumes scoped learning before
  durable outbox admission. Routine suppression is limited to problem-kind,
  machine-measurement-only commentary. Grounded connections, mixed owner or Work
  evidence, direct replies, critical escalation and recovery keep their existing
  authority paths. Reservations retain the exact learning witness across retry.
- Optional background ACT execution consumes target-specific execution learning
  after existing permission, target and rate checks. The background factory
  must establish the runtime origin; explicit allowlist metadata opts a
  capability into this policy. Defaults classify only `refresh_sensor` and
  `write_note`. Direct and agenda execution retain their existing paths.
  Deferral is not an attempt or failure. A real successful retry can change the
  subsequent autonomous decision. Model JSON cannot grant a bypass.
- Foreground optional operational-context selection consumes the same read-only
  learned state. Relevant explicit requests remain eligible. Positive learning
  can change optional context ranking without outranking owed work.
- Seed workspace salience consumes prediction contributions. Failed prediction
  families retain their existing supported-revision requirements.

Decision witnesses commit durably before optional transport or execution. The
existing outbox and action-feedback cursor retain the original witness and retry
projection without re-executing an action. Fresh projections avoid a history
scan; interruption recovery checks the retained exact identity. Optional context
waits if its decision cannot be recorded, while requested information stays
available. Diagnostic logging remains separate from required decision evidence.

The foreground also corrects independent relevance problems. A first turn or
unrelated retrieval cue no longer admits the operational spine by itself.
Carried expectations and thoughts are selected against the conversation's
subject. Explicitly marked optional runtime caches stay recoverable without
dumping their contents into personal conversation; authored workspace maps
retain their delivery contract. Relationship type weights no longer make an
unrelated entry relevant. Trigger readers refresh when the actual memory store
changes and stop firing superseded memories in a long-lived process.

## History and bounded operation

The same Seed and append-only history remain authoritative. New original event
writers stamp prospective learning version 2; old source records and accepted
receipts keep their historical semantics. New development receipts contain only
changed cell projections, while checkpoints preserve the complete state.

After law-2 state is written, recovery needs a reader that understands those
receipts and contributions. An old payload is not a compatible fallback merely
because the coordination database schema is unchanged. Host already fences
post-admission failures instead of automatically rolling software back. This
change does not add a generic minimum-reader floor for future explicit
downgrades; each such operation still needs a compatibility review.

Read-only consumers validate checkpoint state/cursor and contiguous receipt
coverage. They do not instantiate a Seed, replay models, write state or silently
trust a broken tail. Unavailable coverage disables the learned override.

Eligibility and active contributions are bounded. Capacity refusal is explicit;
it must not silently discard an active owner instruction. Recent duplicate
identities and source progress witnesses prevent repeated evidence receiving
new credit. A delayed teaching whose committed decision has not yet arrived
waits for that exact witness rather than inventing a context.

## Causal verification

`npm run test:seed-learning` exercises authenticated source feedback through Seed
and actual selectors. Matched branches hold candidate, facts, episodes and
recorded model behavior fixed, varying only the learned contribution. The
engine test checks the actual outbox transport callback; the foreground test
checks actual selected context after checkpoint/restore. Read-only probes leave
the original history byte-identical.

Existing fixed suppression is a control, not proof of learning. A primary probe
must be eligible under the authored policy. Tests also preserve direct requests,
critical/recovery paths, meaningful mixed-context connections, unrelated scopes,
source recovery, factual updates and old receipt interpretation.

Current views label new natural-language grades as provisional model
assessments. Historical scores retain their recorded values while explicitly
stating that independent verification is unavailable. View changes do not
rewrite old receipts.

These checks establish bounded causal changes in decisions. They do not prove
that every future judgment improves, that a missing historical attachment can
be reconstructed, or that the resident has subjective experience. Source
verification, production activation and behavior observed in continued use
remain separate facts.

## Decision meaning in natural feedback

A retained decision identity is eligibility evidence, but its opaque tags do
not explain what the choice did. Natural feedback needs bounded readback of the
runtime-authored component, actual admission choice and delivery receipt. The
readback joins exact retained witnesses to the resident's original event ledger;
it does not infer delivery from a reused session identity or scan all history.
Missing, conflicting or incomplete evidence remains unavailable.

Context selection and the outward reply are separate choices. An authenticated
standing instruction may teach an actual matching context-selection choice even
when the reply was acceptable. This does not authorize attaching feedback to an
unrelated decision or converting an ambiguous preference into teaching.

Routine operational status and meaningful pursuit context require separate
decisions. AGENCY previously bundled both. Learning to omit queue counts,
operating mode and machinery status must leave substantive pursuits available.
Direct requests retain their exemption. Broad historical agency lessons retain
their original effect; new feedback can name the narrower status component.

Descriptions and delivery joins belong to prospective source events and tool
readback. They do not change the Seed learning-state format, relabel historical
receipts or grant a model authority to manufacture a lesson.

Runtime tags are identifiers, not behavior descriptions. A conduct-writing tool
checks the declared scope, tags and cell against the retained decision before
saving an entry or consuming correction authority. Invalid metadata returns the
actual permitted values for a same-turn retry. The direct-request exclusion is
the selector tag `requested`, not a prose description. Native source projection
and final Seed application remain distinct stages; a projected entry is not an
applied lesson.
