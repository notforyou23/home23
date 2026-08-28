import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { Readable } from "node:stream";
import type { AuthorityEpoch } from "../../../src/coordination/epochs/index.js";

const enabledShellFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
});

const canonicalMessagesAuthority: AuthorityEpoch = Object.freeze({
  capability: "messages",
  epoch: 3,
  mode: "canonical",
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

const canonicalAttachmentsAuthority: AuthorityEpoch = Object.freeze({
  capability: "attachments",
  epoch: 3,
  mode: "canonical",
  writer: "home23-coordination",
  effectiveAtEventSequence: 42,
  rollbackEpoch: 1,
});

const canonicalActivityAuthority: AuthorityEpoch = Object.freeze({
  capability: "activity",
  epoch: 3,
  mode: "canonical",
  writer: "home23-coordination",
  effectiveAtEventSequence: 43,
  rollbackEpoch: 1,
});

const authorityEpochs = (current: AuthorityEpoch | null) => ({
  current: (capability: string) =>
    current?.capability === capability ? current : null,
  listCurrent: async () => ({
    epochs: current ? [current] : [],
    throughEventSequence: current?.effectiveAtEventSequence ?? 0,
  }),
});

test("capability advertisement stays off for every dependency that is absent", () => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: {
        validateAccessToken: async () => {
          throw new Error("unused");
        },
      },
      bootstrap: {
        getBootstrap: async () => {
          throw new Error("unused");
        },
      },
    },
  });

  assert.deepEqual(application.capabilities(), {
    contractVersion: 1,
    apiBase: "/api/v1",
    pairingAvailable: false,
    limits: {
      jsonBodyBytes: 262_144,
      idempotencyKeyMinimum: 16,
      idempotencyKeyMaximum: 128,
    },
    capabilities: {
      bootstrap: true,
      channelsRead: false,
      channelMutation: false,
      conversationsRead: false,
      messagesRead: false,
      unreadRead: false,
      messageSubmission: false,
      modelSelection: false,
      readCursorMutation: false,
      search: false,
      eventReplay: false,
      communicationEvidence: false,
      attachments: false,
      work: false,
      workMutation: false,
      activity: false,
      botLifecycle: false,
      importShadow: false,
    },
  });
});

test("the disabled process advertises no product capability even when a service is injected", () => {
  const application = createCoordinationApplication({
    flags: disabledCoordinationFeatureFlags(),
    services: {
      auth: {
        validateAccessToken: async () => {
          throw new Error("unused");
        },
      },
      bootstrap: {
        getBootstrap: async () => {
          throw new Error("unused");
        },
      },
    },
  });

  assert.equal(application.capabilities().capabilities.bootstrap, false);
  assert.equal(
    Object.values(application.capabilities().capabilities).some(Boolean),
    false,
  );
});

test("canonical search requires both its server flag and its injected domain service", () => {
  const search = {
    search: async () => {
      throw new Error("unused");
    },
  };
  const withoutFlag = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: {
        validateAccessToken: async () => {
          throw new Error("unused");
        },
      },
      search,
    },
  });
  const withFlag = createCoordinationApplication({
    flags: {
      ...enabledShellFlags,
      "coordination.search.canonical": true,
    },
    services: {
      auth: {
        validateAccessToken: async () => {
          throw new Error("unused");
        },
      },
      search,
    },
  });

  assert.equal(withoutFlag.capabilities().capabilities.search, false);
  assert.equal(withFlag.capabilities().capabilities.search, true);
});

test("Channel mutation requires public mutations, its flag, canonical Messages authority, and complete Channel coordination", () => {
  const auth = { validateAccessToken: async () => { throw new Error("unused"); } };
  const channels = {} as any;
  const channelCoordinator = { startFromMessage: async () => ({}) };
  const withoutFlag = createCoordinationApplication({
    flags: enabledShellFlags,
    services: { auth, channels, channelCoordinator },
  });
  const withFlag = createCoordinationApplication({
    flags: {
      ...enabledShellFlags,
      "coordination.channels.enabled": true,
    },
    services: {
      auth,
      channels,
      channelCoordinator,
      authorityEpochs: authorityEpochs(canonicalMessagesAuthority),
    },
  });
  const withoutPublicMutations = createCoordinationApplication({
    flags: {
      ...enabledShellFlags,
      "coordination.public_api.enabled": false,
      "coordination.channels.enabled": true,
    },
    services: {
      auth,
      channels,
      channelCoordinator,
      authorityEpochs: authorityEpochs(canonicalMessagesAuthority),
    },
  });

  assert.equal(withoutFlag.capabilities().capabilities.channelMutation, false);
  assert.equal(createCoordinationApplication({
    flags: { ...enabledShellFlags, "coordination.channels.enabled": true },
    services: { auth, channels },
  }).capabilities().capabilities.channelMutation, false);
  assert.equal(withFlag.capabilities().capabilities.channelMutation, true);
  assert.equal(withoutPublicMutations.capabilities().capabilities.channelMutation, false);
});

test("an appended Messages rollback epoch removes Channel mutation without rebuilding the app", () => {
  let current: AuthorityEpoch = canonicalMessagesAuthority;
  const application = createCoordinationApplication({
    flags: {
      ...enabledShellFlags,
      "coordination.channels.enabled": true,
    },
    services: {
      auth: { validateAccessToken: async () => { throw new Error("unused"); } },
      channels: {} as any,
      channelCoordinator: { startFromMessage: async () => ({}) },
      authorityEpochs: {
        current: (capability) => capability === "messages" ? current : null,
        listCurrent: async () => ({
          epochs: [current],
          throughEventSequence: current.effectiveAtEventSequence ?? 0,
        }),
      },
    },
  });

  assert.equal(application.capabilities().capabilities.channelMutation, true);
  current = Object.freeze({
    capability: "messages",
    epoch: 4,
    mode: "legacy",
    writer: "legacy-conversation-writer",
    effectiveAtEventSequence: 44,
    rollbackEpoch: 3,
  });
  assert.equal(application.capabilities().capabilities.channelMutation, false);
});

test("attachments require public mutation, canonical authority, and one complete service", () => {
  const attachments = {
    create: async () => { throw new Error("unused"); },
    getMetadata: async () => { throw new Error("unused"); },
    openDownload: async () => ({
      status: 200 as const,
      contentType: "text/plain",
      contentLength: 0,
      byteCount: 0,
      sha256: "0".repeat(64),
      range: null,
      content: Readable.from([]),
    }),
  };
  const auth = { validateAccessToken: async () => { throw new Error("unused"); } };
  const disabled = createCoordinationApplication({
    flags: disabledCoordinationFeatureFlags(),
    services: { auth, attachments },
  });
  const enabled = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth,
      attachments,
      authorityEpochs: authorityEpochs(canonicalAttachmentsAuthority),
    },
  });
  const missingAuthority = createCoordinationApplication({
    flags: enabledShellFlags,
    services: { auth, attachments },
  });

  assert.equal(disabled.capabilities().capabilities.attachments, false);
  assert.equal(missingAuthority.capabilities().capabilities.attachments, false);
  assert.equal(enabled.capabilities().capabilities.attachments, true);
});

test("an appended attachment rollback epoch removes admission without rebuilding the app", () => {
  let current: AuthorityEpoch = canonicalAttachmentsAuthority;
  const attachments = {
    create: async () => { throw new Error("unused"); },
    getMetadata: async () => { throw new Error("unused"); },
    openDownload: async () => { throw new Error("unused"); },
  };
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => { throw new Error("unused"); } },
      attachments,
      authorityEpochs: {
        current: (capability) =>
          capability === "attachments" ? current : null,
        listCurrent: async () => ({ epochs: [current], throughEventSequence: 42 }),
      },
    },
  });
  assert.equal(application.capabilities().capabilities.attachments, true);
  current = Object.freeze({
    capability: "attachments",
    epoch: 4,
    mode: "legacy",
    writer: "legacy-attachment-writer",
    effectiveAtEventSequence: 42,
    rollbackEpoch: 1,
  });
  assert.equal(application.capabilities().capabilities.attachments, false);
});

test("Activity requires its complete adapter and independent canonical epoch", () => {
  let current: AuthorityEpoch = canonicalActivityAuthority;
  const activity = {
    list: async () => ({
      entries: [],
      nextBoundary: null,
      throughEventSequence: 43,
    }),
  };
  const auth = { validateAccessToken: async () => { throw new Error("unused"); } };
  const capability = (service: typeof activity | undefined, epoch: AuthorityEpoch | null) =>
    createCoordinationApplication({
      flags: enabledShellFlags,
      services: {
        auth,
        ...(service === undefined ? {} : { activity: service }),
        authorityEpochs: authorityEpochs(epoch),
      },
    }).capabilities().capabilities.activity;

  assert.equal(capability(undefined, canonicalActivityAuthority), false);
  assert.equal(capability(activity, null), false);
  assert.equal(capability(activity, {
    ...canonicalActivityAuthority,
    writer: "label-only-writer",
  }), false);

  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth,
      activity,
      authorityEpochs: {
        current: (requested) => requested === "activity" ? current : null,
        listCurrent: async () => ({ epochs: [current], throughEventSequence: 43 }),
      },
    },
  });
  assert.equal(application.capabilities().capabilities.activity, true);
  current = Object.freeze({
    capability: "activity",
    epoch: 4,
    mode: "legacy",
    writer: "legacy-activity-reader",
    effectiveAtEventSequence: 43,
    rollbackEpoch: 1,
  });
  assert.equal(application.capabilities().capabilities.activity, false);
});

test("read routes without a complete event-boundary contract remain unadvertised", () => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: {
        validateAccessToken: async () => {
          throw new Error("unused");
        },
      },
    },
  });

  assert.equal(application.capabilities().capabilities.channelsRead, false);
  assert.equal(application.capabilities().capabilities.channelMutation, false);
  assert.equal(application.capabilities().capabilities.conversationsRead, false);
  assert.equal(application.capabilities().capabilities.messagesRead, false);
  assert.equal(application.capabilities().capabilities.unreadRead, false);
  assert.equal(application.capabilities().capabilities.messageSubmission, false);
  assert.equal(application.capabilities().capabilities.work, false);
  assert.equal(application.capabilities().capabilities.activity, false);
});

test("unfinished M11 ports cannot activate message or Work capabilities", () => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: {
        validateAccessToken: async () => {
          throw new Error("unused");
        },
      },
      work: {
        create: () => { throw new Error("unused"); },
        cancelQueued: () => { throw new Error("unused"); },
        get: () => null,
      },
      messageSubmission: {
        submitMessage: async () => ({}),
      },
    },
  });

  assert.equal(application.capabilities().capabilities.messageSubmission, false);
  assert.equal(application.capabilities().capabilities.work, false);
  assert.equal(application.capabilities().capabilities.workMutation, false);
});

test("message submission requires the exact persisted canonical writer, not flags", () => {
  const flags = {
    ...enabledShellFlags,
    "coordination.resident.jerry.enabled": true,
  };
  const base = {
    auth: { validateAccessToken: async () => { throw new Error("unused"); } },
    messageSubmission: { submitMessage: async () => ({}) },
    work: {} as any,
    leases: {} as any,
  };
  const capability = (authority: AuthorityEpoch | null) =>
    createCoordinationApplication({
      flags,
      services: { ...base, authorityEpochs: authorityEpochs(authority) },
    }).capabilities().capabilities.messageSubmission;

  assert.equal(capability(null), false);
  assert.equal(capability({
    ...canonicalMessagesAuthority,
    mode: "legacy",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  }), false);
  assert.equal(capability({
    ...canonicalMessagesAuthority,
    mode: "shadow",
    writer: "legacy-conversation-writer",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  }), false);
  assert.equal(capability({
    ...canonicalMessagesAuthority,
    writer: "label-only-writer",
  }), false);
  assert.equal(capability(canonicalMessagesAuthority), true);
});

test("model selection is advertised only with active message submission and a catalog", () => {
  const flags = {
    ...enabledShellFlags,
    "coordination.resident.jerry.enabled": true,
  };
  const base = {
    auth: { validateAccessToken: async () => { throw new Error("unused"); } },
    work: {} as any,
    leases: {} as any,
    authorityEpochs: authorityEpochs(canonicalMessagesAuthority),
  };
  const withoutCatalog = createCoordinationApplication({
    flags,
    services: {
      ...base,
      messageSubmission: { submitMessage: async () => ({}) },
    },
  });
  const withCatalog = createCoordinationApplication({
    flags,
    services: {
      ...base,
      messageSubmission: {
        submitMessage: async () => ({}),
        selectionOptions: async () => ({}),
      },
    },
  });

  assert.equal(withoutCatalog.capabilities().capabilities.messageSubmission, true);
  assert.equal(withoutCatalog.capabilities().capabilities.modelSelection, false);
  assert.equal(withCatalog.capabilities().capabilities.messageSubmission, true);
  assert.equal(withCatalog.capabilities().capabilities.modelSelection, true);
});

test("application construction snapshots dependencies and rejects incoherent limits", () => {
  const services = {
    auth: {
      validateAccessToken: async () => {
        throw new Error("unused");
      },
    },
  };
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services,
  });

  Object.assign(services, {
    bootstrap: {
      getBootstrap: async () => {
        throw new Error("unused");
      },
    },
  });
  assert.equal(application.services.bootstrap, undefined);
  assert.equal(application.capabilities().capabilities.bootstrap, false);

  assert.throws(
    () => createCoordinationApplication({
      flags: enabledShellFlags,
      services,
      limits: {
        jsonBodyBytes: 0,
        idempotencyKeyMinimum: 128,
        idempotencyKeyMaximum: 16,
      },
    }),
    /coordination HTTP limits are invalid/,
  );
});
