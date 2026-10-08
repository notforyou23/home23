# Synthesis publication

Synthesis reads one immutable, operation-authorized brain snapshot. Its result
records that snapshot's `sourceGeneration` and `sourceRevision`, plus the
attempt's `startedAt`. Normal memory appends can continue during provider work.

`publishDerivedState` holds the existing source lock while it verifies the
original pin digest, own-brain operation authority, live generation, and a
nondecreasing live revision. The synthesis worker also verifies the existing
artifact before claiming completion. It refuses to overwrite a higher artifact
revision, or a later attempt at the same revision, within the same generation.
Older verified artifacts without generation metadata retain the conservative
revision check. Malformed artifacts remain untouched.

This is publication of a derived snapshot result, not a change to memory.
`compareAndSwap` and `compareAndSwapSourceRevision` still require the exact live
source revision and descriptor. Generation replacement, cross-brain access,
read-only projections, revoked operations, cancellation and digest mismatch
remain failures. Provider work holds no source lock.

The existing durable completion claim, final deadline check, synchronous rename
and directory sync remain the commit boundary. A later cancellation cannot
replace a completed result. Check both the canonical operation and the verified
artifact; a scheduled handler returning `ok` does not establish freshness.
