# Land receipts

`land-receipts.jsonl` is the append-only record of verified fixes that have
landed in maintained Home23 source. Never edit, reorder, or remove an existing
line. Deployment is represented by another appended line, not by changing the
original receipt.

A land receipt is schema version 1 and contains the source commit, repository,
branch, one-line repair summary, verification reference, affected surfaces,
and recorder. It always starts with `deployed:false` and null deployment
fields. A deployment line has `recordType:"deployment"`, `recordedAt`, the full
`commit`, and `releaseId`: a managed release's 40-character content hash or a
signed product package's 64-character packageId, named by `releaseKind` as
`managed-release` or `product-package`. Deployment lines written before product
packages could be recorded carry no `releaseKind` and are managed releases. One
package deploys many commits, so one deployment names one commit and a package
deployment appends one line per receipted commit. Readers fold deployment lines
over earlier land receipts to produce `deployed`, `deployedReleaseId`,
`deployedReleaseKind`, and `deployedAt`.

Every ledger line must be valid JSON and every deployment must reference
an earlier receipt. A malformed or inconsistent line makes the ledger
unavailable; readers must never silently skip it or report zero undeployed
receipts.
