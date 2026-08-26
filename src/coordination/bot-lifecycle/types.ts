import type { BotProjection } from "../bots/index.js";
import type { AuthorityEpoch } from "../epochs/index.js";
import type { PolicyDecision, PolicyRequest } from "../policy/index.js";

export type BotLifecycleOperation = "create" | "start" | "stop" | "restart" | "archive" | "restore";
export type BotLifecyclePhase =
  | "authorized"
  | "resident_created"
  | "mailbox_bound"
  | "mailbox_archived"
  | "mailbox_restored"
  | "process_changed";

export interface PersistentBotCreateRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actorPrincipalId: "user_owner";
  readonly residentBinding: string;
  readonly displayName: string;
  readonly purpose: string;
  readonly requiredCapabilities: readonly string[];
  /** Must be resolved at the trusted policy boundary, never from model output. */
  readonly policy: PolicyRequest;
  readonly expectedAuthorityEpoch: number;
}

export interface PersistentBotControlRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actorPrincipalId: "user_owner";
  readonly botId: string;
  readonly operation: Exclude<BotLifecycleOperation, "create">;
  readonly policy: PolicyRequest;
  readonly expectedAuthorityEpoch: number;
}

export interface ResidentCreateSpec {
  readonly residentBinding: string;
  readonly displayName: string;
  readonly purpose: string;
  readonly requiredCapabilities: readonly string[];
  readonly copyPrivateMemory: false;
}

export interface ProvisionedResident {
  readonly kind: "persistent_resident";
  readonly residentBinding: string;
  readonly instancePath: string;
  /** Exact names emitted by the generated ecosystem manifest. */
  readonly processNames: readonly string[];
}

export interface ResidentProvisioner {
  /** Adapter for the existing CLI create contract. It must use an installation root supplied out of band. */
  create(spec: ResidentCreateSpec): Promise<ProvisionedResident>;
  inspect(residentBinding: string): Promise<ProvisionedResident | null>;
  /** Recoverable cleanup only: archive/quarantine; never recursively destroy the resident. */
  archivePartial(resident: ProvisionedResident, reason: string): Promise<void>;
}

export interface PersistentMailboxBinder {
  bindAfterResidentCreated(input: {
    requestId: string;
    correlationId: string;
    actorPrincipalId: "user_owner";
    residentBinding: string;
    displayName: string;
    purpose: string;
    requiredCapabilities: readonly string[];
  }): Promise<BotProjection>;
  getByBotId(botId: string): Promise<BotProjection | null>;
  /** Atomic canonical directory transition. It must not remove transcript, aliases, or resident files. */
  transitionLifecycle(input: {
    botId: string;
    from: "active" | "archived";
    to: "active" | "archived";
    requestId: string;
    correlationId: string;
    actorPrincipalId: "user_owner";
    changedAt: string;
  }): Promise<BotProjection>;
}

export interface ExactNameProcessController {
  startExact(names: readonly string[]): Promise<void>;
  stopExact(names: readonly string[]): Promise<void>;
  restartExact(names: readonly string[]): Promise<void>;
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
  readonly residentBinding: string | null;
  readonly botId: string | null;
  readonly mailboxId: string | null;
  readonly authorityEpoch: number;
  readonly policyDecision: PolicyDecision;
  readonly outcome: "succeeded" | "failed";
  readonly completedPhases: readonly BotLifecyclePhase[];
  readonly processNames: readonly string[];
  readonly failure: null | {
    readonly phase: "resident_create" | "mailbox_bind" | "process_change" | "mailbox_transition";
    readonly code: string;
    readonly partialResidentArchived: boolean;
  };
  readonly createdAt: string;
}

export interface BotLifecycleReceiptStore {
  get(requestId: string): Promise<BotLifecycleReceipt | null>;
  putIfAbsent(receipt: BotLifecycleReceipt): Promise<BotLifecycleReceipt>;
}

export interface CreateBotLifecycleServiceOptions {
  readonly authority: BotLifecycleAuthority;
  readonly provisioner: ResidentProvisioner;
  readonly mailboxBinder: PersistentMailboxBinder;
  readonly processes: ExactNameProcessController;
  readonly receipts: BotLifecycleReceiptStore;
  readonly canonicalWriter: string;
  readonly now?: () => Date;
}
