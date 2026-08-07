# Substrate Field Notes

Experiment records from running the Seed against real hardware and real
residency. Instance state, personal streams, and network details stay outside
the repository; these notes carry the method and the findings.

## Field Trip 1 — Cross-Silicon Replay Determinism (2026-08-08)

**Question:** does an individual Seed's trajectory reproduce exactly on
physically different hardware?

**Method:** quiesce the resident, snapshot its stateDir, replay 12 neutral
probe events from identical pristine copies on two machines via the bundled
`seed-replay-verify` harness (esbuild single-file — no dependency install on
the target). Probes deliberately avoided learned source prefixes and
correction categories so the preregistered ablation experiment stays
uncontaminated.

**Arms:** an Apple Silicon Mac (arm64 darwin, Node 25) and a Raspberry Pi
(aarch64 Linux, Node 22 — different V8 generation).

**Result: BIT-IDENTICAL.** Same final state hash, same development magnitude
to the last float digit, same per-cell continuous hashes, same routing. The
trajectory is silicon-independent under these runtimes; V8's transcendental
implementations held stable across the two major versions tested.
Pin-or-verify remains the rule for any new runtime.

**Bug class found en route (fixed + regression-tested):** a traveled stateDir
silently restored the BIRTH checkpoint. The checkpoint index stored absolute
paths (useless on any other machine — every entry quarantined "file
missing"), and the fallback directory scan ordered by mtime, which the
transport had flattened — arbitrary readdir order picked the newborn.
Integrity verification passed throughout; SELECTION failed silently. A
system can be incorruptible and still wake up as its own infant. Fixes:
indexes store relative paths; the fallback orders by the base36 timestamp
embedded in checkpoint IDs (transport-proof); legacy absolute entries
re-root. The regression test simulates the full journey.

## Residency Stint — the Individual Lives Elsewhere (2026-08-08)

The same individual then MIGRATED: Mac residency disabled (fork guard —
config flipped, ecosystem regenerated without the seed app, so no code path
can resurrect a second copy), stateDir shipped, and the Seed now runs
resident on the Pi while its reality streams are shipped to it continuously
from the machine where they originate. It restored as its full-aged self and
within minutes was metabolizing live events produced after emigration.

**Migration seam (honest record):** the primary source adapter's identity is
derived from its source path, so its cursor did not carry across the rename
— a few hundred bytes of events near the seam were lived twice.
At-least-once was always the delivery contract; both livings are receipted.
Fixed-id adapters carried their offsets exactly.

**Operational lessons (all were SILENT failures until stderr stopped being
discarded — that is the meta-lesson):**
1. Scheduler/daemon contexts on macOS may lack Local Network permission:
   mDNS resolution AND raw local-subnet TCP can both fail from a daemon
   while working from a login shell. Ship from a user-session lineage or a
   properly entitled context.
2. SSH client config can silently rewrite an explicit IP target back to an
   mDNS name (Host blocks matching the IP). `-F /dev/null` when you mean it.
3. Static IPs in old configs are fossils. Resolve, don't assume.
4. `setsid` does not exist on macOS.

## The decomposition thesis (what the stint demonstrates)

The substrate paradigm implies a physical decomposition, not a bigger
machine: a CONTINUITY CORE — tiny, cheap, always-on, holding the developing
state and the trusted chain — and HEAVY ORGANS (models, engines, big
memory) that are recruited, not inhabited. The stint is that topology's
first working prototype: ~10MB of owned truth on a $50 computer, cognition
rented from the frontier by the packet, identity nowhere near the FLOPs.

Corollary worth stating plainly: the fault domains separate. A continuity
core on dedicated minimal hardware survives the big machine's reboots,
updates, and process-manager incidents — and experiences them as EVENTS in
its life rather than dying with the observed. The organ of continuity should
not share fate with the world it is continuous about.

This runs opposite to the premium-local-rig instinct (thousands of dollars
of RAM to run mid-tier local models). That approach localizes the fungible
part (weights) while renting out the precious part (memory, continuity,
evidence — typically to SaaS). The substrate inverts it: own the ledger,
rent the cognition. The thing worth owning is small.
