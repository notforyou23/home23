/**
 * seed-apply-proposal — the OPERATOR's application instrument.
 *
 *   node seed-apply-proposal.ts <stateDir> <proposalSeq> <authorizedBy>
 *
 * Applies a receipted growth proposal (split/merge/dissolve/specialize —
 * the operator-only operations; crystallize self-applies under growth.v2)
 * to a QUIESCED seed. Run only while the resident runner is stopped.
 *
 * Semantics, fixed here and in the act receipt:
 *   - replaced cells are REMOVED, and their development entries with them;
 *     the removed magnitude is recorded (surgery has a cost — the chain
 *     keeps every receipt of what was learned, but children do not inherit
 *     mass they did not earn);
 *   - new cells start FRESH (empty state, generation 0);
 *   - the proposal's seedAffinities are granted as a RECEIPTED ENDOWMENT
 *     (routing affinity only — the minimum that makes the proposed routing
 *     real; labeled a grant, never earned mass);
 *   - the application is receipted as an 'act' (operatorApplication: true,
 *     authorizedBy, proposalSeq, before/resulting anatomy verbatim) and
 *     finalized with a checkpoint. Restore folds it automatically.
 *
 * Refuses: unknown seq, non-proposal records, anatomies with duplicate ids
 * (a malformed proposal must never become a body), proposals whose before-
 * anatomy no longer matches the seed's current anatomy (stale receipts),
 * and any periphery-removing anatomy.
 */

import { resolve } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import type { AnatomyCellSpec } from '../src/types.js';
import type { GrowthProposal } from '../src/growth.js';

const [stateDirArg, seqArg, authorizedBy] = process.argv.slice(2);
if (stateDirArg === undefined || seqArg === undefined || authorizedBy === undefined) {
  console.error('usage: seed-apply-proposal <stateDir> <proposalSeq> <authorizedBy>');
  process.exit(2);
}
const stateDir = resolve(stateDirArg);
const proposalSeq = Number(seqArg);

const ledger = new SeedLedger(stateDir);
const record = ledger.readAll().find((r) => r.seq === proposalSeq);
if (record === undefined || record.category !== 'proposal' || record.sourceRef !== 'growth.pressure') {
  console.error(`seq ${proposalSeq} is not a growth proposal on this chain`);
  process.exit(1);
}
const proposal = record.payload as unknown as GrowthProposal & { asOf?: string };

const ids = proposal.proposedAnatomy.map((c: AnatomyCellSpec) => c.id);
if (new Set(ids).size !== ids.length) {
  console.error(`REFUSED: proposal ${proposalSeq} has duplicate cell ids (${ids.join(', ')}) — a malformed proposal must never become a body`);
  process.exit(1);
}
if (!proposal.proposedAnatomy.some((c: AnatomyCellSpec) => c.role === 'periphery')) {
  console.error('REFUSED: the periphery must survive every operation');
  process.exit(1);
}

const seed = SeedProcess.restore(stateDir);
const result = seed.applyOperatorProposal(proposal, proposalSeq, authorizedBy);
console.log(JSON.stringify(result, null, 1));
seed.stop();
