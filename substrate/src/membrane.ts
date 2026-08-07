/**
 * Deterministic Capability Membrane.
 *
 * Owned by Home23 code, never modifiable by ordinary Seed cognition.
 * An explicit allowlist is checked synchronously on every operation.
 * The Seed cannot prompt its way around it.
 *
 * The membrane is smaller and more reliable than the plastic system — Kill Sign
 * from the build contract applies if this relationship inverts.
 */

import type { Capability } from './types.js';
import { CapabilityDeniedError } from './types.js';

// ─── Constitutional membrane ─────────────────────────────────────────────────

const ALLOWED: ReadonlySet<Capability> = new Set<Capability>([
  'local.ledger.append',
  'local.state.read',
  'local.state.write',
  'local.checkpoint.write',
  'local.checkpoint.read',
  'local.source.ingest',
  'local.resource.account',
  // Cut 2: model lobes recruited through the runner-injected transport, which
  // uses Home23's existing provider contracts. The substrate holds no
  // credentials (secret.read stays forbidden) and knows no endpoints.
  'lobe.recruit.model',
]);

const FORBIDDEN: ReadonlySet<Capability> = new Set<Capability>([
  'home23.engine.modify',
  'home23.config.modify',
  'home23.memory.write',
  'home23.identity.modify',
  'home23.relationship.modify',
  'home23.agency.modify',
  'home23.cron.modify',
  'home23.project.modify',
  'net.publish',
  'net.message.external',
  'device.control',
  'script.execute',
  'secret.read',
  'membrane.modify',
  'ledger.trusted.modify',
  'seed.replicate',
  'seed.authority.expand',
]);

/** Deterministic capability membrane. Constructed once; immutable thereafter. */
export class CapabilityMembrane {
  /**
   * Assert the capability is permitted. Throws CapabilityDeniedError immediately
   * if not. Never prompts. Never negotiates. Never logs-and-continues.
   */
  assert(capability: Capability | string): void {
    if (FORBIDDEN.has(capability as Capability)) {
      throw new CapabilityDeniedError(
        capability,
        'explicitly forbidden in Cut 1 constitutional membrane',
      );
    }
    if (!ALLOWED.has(capability as Capability)) {
      throw new CapabilityDeniedError(
        capability,
        'not in the Cut 1 allowlist — unknown capabilities are denied by default',
      );
    }
  }

  /** Check without throwing; for query use. */
  isAllowed(capability: Capability | string): boolean {
    return ALLOWED.has(capability as Capability) && !FORBIDDEN.has(capability as Capability);
  }

  /** Enumerate the currently allowed capabilities. Read-only view. */
  allowedCapabilities(): ReadonlySet<Capability> {
    return ALLOWED;
  }

  /** Enumerate the explicitly forbidden capabilities. Read-only view. */
  forbiddenCapabilities(): ReadonlySet<Capability> {
    return FORBIDDEN;
  }
}
