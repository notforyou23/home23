# HOME23 Stack Pyramid

Last updated: 2026-04-06
Status: canonical architecture note
Purpose: give a compact visual and verbal model of HOME23 as one solid stack rather than a pile of separate apps.

---

## Core image

HOME23 should be understood as one solid pyramid.

```text
                    ┌──────────────────────────────┐
                    │ Front Door / Operator Layer  │
                    │ onboarding, control plane,   │
                    │ chat, model choice           │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ House Runtime Layer          │
                    │ identity rooms, sessions,    │
                    │ tools, workflows, receipts,  │
                    │ provider/model execution,    │
                    │ security/capability control  │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ Brain Layer                  │
                    │ main cortex, continuity,     │
                    │ substrate, synapses, sleep,  │
                    │ dream, consolidation,        │
                    │ cross-brain access           │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ COSMO Engine Layer           │
                    │ loops, persistence, runtime  │
                    │ truth, objective flow,       │
                    │ governance, orchestration    │
                    └──────────────────────────────┘
```

---

## How to read it

### 1. COSMO engine layer
This is the living process layer.
It keeps the system alive in time.

What lives here:
- loop execution
- persistence
- workflow/objective movement
- governance/executive truth
- receipts/state/runtime history

Without this layer, the stack becomes stateless theater.

### 2. Brain layer
This is the enduring cortex.
It accumulates and reorganizes cognition over time.

What lives here:
- long-range continuity
- substrate and synaptic structure
- memory growth and consolidation
- sleep and dream processing
- access to other brains through the shared standard

Without this layer, the stack becomes shallow and forgetful.

### 3. House runtime layer
This is where the named self actually lives.
It is the inhabited operational layer.

What lives here:
- identity rooms
- sessions
- tools/actions
- workflows
- provider/model execution
- operator relationship
- runtime-facing access to the brain

Without this layer, the stack becomes an abstract engine without a house.

### 4. Front door / operator layer
This is the simplicity layer.
This is what the user touches.

What lives here:
- onboarding
- control plane
- chat
- model choice
- visible state and control

Without this layer, the stack becomes powerful but unusable.

---

## Operator experience rule

The user should not have to think in terms of all four layers during normal use.

The experience should be:
- choose a model
- talk naturally
- let that model act through the full stack

But architectural truth should remain clear internally:
- the model is the current voice
- the engine is the living process
- the brain is the enduring cortex

---

## Canonical warning

Do not let HOME23 collapse upward into “just chat.”
Do not let it collapse sideways into “just dashboards and settings.”
Do not let it collapse downward into “just a raw engine with no humane front door.”

It only works when the pyramid remains whole.
