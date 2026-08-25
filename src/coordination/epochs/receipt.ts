import { canonicalJson } from "../import/canonical.js";
import type {
  AuthorityRolloutReceipt,
  UnsignedAuthorityRolloutReceipt,
} from "./types.js";

export function unsignedAuthorityReceipt(
  receipt: AuthorityRolloutReceipt,
): UnsignedAuthorityRolloutReceipt {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

export function authorityReceiptSigningPayload(
  receipt: UnsignedAuthorityRolloutReceipt,
): string {
  return canonicalJson({
    domain: "home23.connected-agents.authority-rollout-receipt.v1",
    receipt,
  });
}
