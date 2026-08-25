import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";

const enabledShellFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
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
      conversationsRead: false,
      messagesRead: false,
      unreadRead: false,
      messageSubmission: false,
      readCursorMutation: false,
      search: false,
      eventReplay: false,
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
        getWork: async () => ({}),
        cancelWork: async () => ({}),
        retryWork: async () => ({}),
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
