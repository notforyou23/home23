import type { BotProjection } from "../bots/index.js";
import type { AuthorityEpoch } from "../epochs/index.js";
import type { PolicyDecision, PolicyRequest } from "../policy/index.js";

export type BotLifecycleOperation = "create" | "archive" | "restore";
export type BotLifecyclePhase =
  | "authorized"
  | "mailbox_bound"
  | "mailbox_archived"
  | "mailbox_restored";

export interface PersistentBotCreateRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actorPrincipalId: "user_owner";
  readonly displayName: string;
  readonly purpose: string;
  /** Must be resolved at the trusted policy boundary, never from model output. */
  readonly policy: PolicyRequest;
  readonly expectedAuthorityEpoch: number;
}

export interface PersistentBotControlRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actorPrincipalId: "user_owner";
  readonly botId: string;
  readonly operation: "archive" | "restore";
  readonly policy: PolicyRequest;
  readonly expectedAuthorityEpoch: number;
}

/**
 * Canonical directory/channel boundary for a lightweight Bot. Implementations
 * create a durable principal, profile, private mailbox, direct conversation,
 * and membership. They must not provision or control an OS process.
 */
export interface PersistentMailboxBinder {
  bindDurableBot(input: {
    requestId: string;
    correlationId: string;
    actorPrincipalId: "user_owner";
    residentBinding: string;
    displayName: string;
    purpose: string;
    atomicReceipt: Pick<
      BotLifecycleReceipt,
      "requestId" | "requestDigest" | "authorityEpoch" | "policyDecision"
    >;
  }): Promise<BotProjection>;
  getByBotId(botId: string): Promise<BotProjection | null>;
  /** Atomic canonical transition; transcript, mailbox, aliases, and Bot ID remain intact. */
  transitionLifecycle(input: {
    botId: string;
    from: "active" | "archived";
    to: "active" | "archived";
    requestId: string;
    correlationId: string;
    actorPrincipalId: "user_owner";
    changedAt: string;
    atomicReceipt: Pick<
      BotLifecycleReceipt,
      "requestId" | "requestDigest" | "authorityEpoch" | "policyDecision"
    >;
  }): Promise<BotProjection>;
}

export interface BotLifecycleAuthority {
  enabled(): boolean;
  currentEpoch(): Promise<AuthorityEpoch | null>;
  decide(policy: PolicyRequest): PolicyDecision;
}

export interface BotLifecycleReceipt {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly correlationId: string;
  readonly operation: BotLifecycleOperation;
  /** Compatibility projection only. This is derived by Core, never selected by a client. */
  readonly residentBinding: string | null;
  readonly botId: string | null;
  readonly mailboxId: string | null;
  readonly authorityEpoch: number;
  readonly policyDecision: PolicyDecision;
  readonly outcome: "succeeded" | "failed";
  readonly completedPhases: readonly BotLifecyclePhase[];
  readonly failure: null | {
    readonly phase: "mailbox_bind" | "mailbox_transition";
    readonly code: string;
  };
  readonly createdAt: string;
}

export interface BotLifecycleReceiptStore {
  get(requestId: string): Promise<BotLifecycleReceipt | null>;
  putIfAbsent(receipt: BotLifecycleReceipt): Promise<BotLifecycleReceipt>;
}

export interface CreateBotLifecycleServiceOptions {
  readonly authority: BotLifecycleAuthority;
  readonly mailboxBinder: PersistentMailboxBinder;
  readonly receipts: BotLifecycleReceiptStore;
  readonly canonicalWriter: string;
  readonly now?: () => Date;
  /** Core-owned canonical request IDs for durable lifecycle events. */
  readonly eventRequestId?: () => string;
}
