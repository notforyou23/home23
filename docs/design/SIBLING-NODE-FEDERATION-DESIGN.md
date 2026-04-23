# Sibling Node Federation Design

Status: first slice implemented
Created: 2026-04-23

## Goal

Let a Home23 agent running on another machine, such as a Raspberry Pi, behave as a real sibling instead of a passive sensor box.

The Mac mini remains a strong home node. The Pi can run its own agent/runtime with cloud models, local sensors, local cron, and local APIs. Each side keeps its own identity and brain, then shares selected state over explicit peer channels.

## Existing Pieces

Home23 already has most of the required primitives:

- `agent create` creates a full local identity, workspace, brain, conversations directory, config, and PM2 processes.
- Each harness exposes `GET /health`, `POST /api/chat`, and `GET /__state/public.json` on the bridge port.
- The engine already has a `NeighborChannel` that ingests peer public state as `neighbor_gossip`.
- Evobrew already has a `LocalAgentAdapter` that can call HTTP/SSE agents by URL, despite the local-agent name.
- The old sibling protocol has rate limiting and deduping, but it is message-only and too narrow for full federation.

## Architecture

Separate the concepts that are currently blurred:

- Agent: identity, loop, memory, workspace, channels.
- Node: machine/runtime host, such as `mac-mini` or `jtrpi`.
- Peer: another reachable agent or node, known by URL, token, and capabilities.

A robust Pi sibling should not share the Mac mini's brain directly. It should keep local memory and publish a small public state surface. The Mac mini ingests that state as second-hand observations. Later phases can add bounded task delegation.

## Implemented Slice

The neighbor channel now accepts remote peers in addition to local instance names.

Example:

```yaml
osEngine:
  channels:
    neighbor:
      enabled: true
      poll: 3m
      peers: auto
      remotePeers:
        - name: axiom
          url: http://jtrpi.local:5014
          token: optional-bearer-token
```

Behavior:

- `peers: auto` still discovers local agents from `instances/*/config.yaml`.
- URL strings in `peers` are treated as remote public-state endpoints.
- `remotePeers` appends named remote siblings without disabling local auto-discovery.
- Base URLs are normalized to `/__state/public.json`.
- Bearer tokens and static headers are passed through by `NeighborChannel`.

## Next Slice

To make the Pi a stronger sibling, add a peer registry and capability manifest:

```yaml
peers:
  nodes:
    - name: axiom
      kind: home23-node
      baseUrl: http://jtrpi.local:5014
      tokenRef: peers.axiom.token
      capabilities:
        sensors: true
        cron: true
        feeder: true
        browser: false
        cosmo: false
        heavyIndexing: false
```

Then build:

- `GET /__node/manifest.json` from every node.
- A peer registry in `config/home.yaml` or per-agent config.
- A dispatch tool that can send bounded jobs to a peer and track status.
- Capability-aware routing, so a Pi can ask the Mac mini for browser or heavy indexing, while the Mac mini asks the Pi for edge sensor work.

## Guardrails

- Do not merge full brain graphs across machines by default.
- Do not rely on shared filesystems for federation.
- Do not assume both nodes have equal capabilities.
- Treat sibling observations as `UNCERTIFIED` unless independently verified.
- Keep auth mandatory for mutation or job-dispatch endpoints.
