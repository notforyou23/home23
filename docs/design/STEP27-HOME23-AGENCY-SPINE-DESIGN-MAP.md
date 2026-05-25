# Step 27: Home23 Agency Spine Design Map

Status: first implementation slice.

## Purpose

`evolve.md` is treated as a literal requirement from the in-system conversation: Home23 should not end at memory, reflection, report delivery, or dashboard display. The next structural layer is a resident agency spine that owns attention, pursuit, consequence, and changed future behavior.

Step24 made the engine an OS-observing kernel. Step27 adds the resident actor above it.

## Existing Organs

- Step24 channel bus: authoritative observation intake for machine, OS, domain, build, work, neighbor, and notification signals.
- Good Life: governance evaluation and policy pressure. It is input to agency, not the agency loop itself.
- ThinkingMachine and AgendaStore: cognition and candidate work surface. Agenda rows do not by themselves own long-running pursuit.
- MotorCortex and ActionDispatcher: bounded hands. Agency must route through these or workers, not around them.
- Worker connector: reusable specialist action contexts with receipts.
- Artifact registry: durable output and reuse substrate.
- Chat harness: authority bridge, operator conversation, and correction path.
- Cron scheduler: recurring perception and report generation.
- From The Inside: public/internal diary of lived system change, not a terminal prose factory.
- COSMO23 research tools: outward research organ. COSMO is not the resident agency center.

## Authority Surfaces

- Authoritative current state: PM2/process probes, runtime APIs, verifier receipts, worker receipts, artifact registry records, Step24 observations.
- Advisory state: agenda items, reflection outputs, issue prose, timeline summaries, research synthesis.
- Terminal-before-Step27 surfaces: Telegram digests, field-report cycles, completed research summaries, dashboard status cards.

## Agency Binding

Agency creates a durable chain:

```text
observation/report/correction
  -> agency inbox candidate
  -> route decision: pursue/watch/discard/request-authority
  -> pursuit with desired changed future + stop condition
  -> bounded action proposal or worker route
  -> consequence receipt
  -> changed resident state
```

The first slice is deliberately dry-run-first. It writes state, inbox, pursuits, receipts, and consequences under `instances/<agent>/brain/agency/`, exposes API/tool/context surfaces, and intakes Step24 observations. Higher-risk action remains gated by existing authority boundaries.

## First-Slice Files

- `engine/src/agency/` — resident kernel, pursuit store, router, selector, authority policy, consequence engine.
- `src/home.ts` — bridge API for `/api/agency/*`.
- `engine/src/dashboard/server.js` — dashboard proxy for `/home23/api/agency/*`.
- `src/agent/context-assembly.ts` — active resident pursuits injected into chat context.
- `src/agent/tools/agency.ts` — chat authority tools.
- `config/home.yaml` — `agency.enabled: true`, `agency.mode: dry_run`.

## Non-Negotiables

- Reports must produce intake packets or explicit discards.
- Repeated Good Life drift updates one pursuit, not endless agenda spam.
- L4 action requires explicit approval.
- Agency state is inspectable by receipt, not inferred from prose.
