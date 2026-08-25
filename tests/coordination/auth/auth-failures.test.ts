import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_FAILURE_MATRIX,
  AuthError,
} from "../../../src/coordination/auth/index.js";

test("auth failures expose one stable reason-to-status matrix", () => {
  assert.deepEqual(AUTH_FAILURE_MATRIX, {
    request_invalid: { httpStatus: 400, retryable: false },
    pairing_code_invalid: { httpStatus: 401, retryable: true },
    refresh_invalid: { httpStatus: 401, retryable: false },
    refresh_expired: { httpStatus: 401, retryable: false },
    session_inactive: { httpStatus: 401, retryable: false },
    session_revoked: { httpStatus: 401, retryable: false },
    device_revoked: { httpStatus: 401, retryable: false },
    access_invalid: { httpStatus: 401, retryable: false },
    access_expired: { httpStatus: 401, retryable: false },
    access_audience_invalid: { httpStatus: 401, retryable: false },
    operator_auth_required: { httpStatus: 403, retryable: false },
    network_not_allowed: { httpStatus: 403, retryable: false },
    access_scope_denied: { httpStatus: 403, retryable: false },
    pairing_not_found: { httpStatus: 404, retryable: false },
    device_not_found: { httpStatus: 404, retryable: false },
    pairing_already_redeemed: { httpStatus: 409, retryable: false },
    pairing_locked: { httpStatus: 409, retryable: false },
    idempotency_conflict: { httpStatus: 409, retryable: false },
    refresh_replay_family_revoked: { httpStatus: 409, retryable: false },
    pairing_expired: { httpStatus: 410, retryable: false },
    rate_limit_exceeded: { httpStatus: 429, retryable: true },
  });
  for (const [reason, policy] of Object.entries(AUTH_FAILURE_MATRIX)) {
    const error = new AuthError(reason as keyof typeof AUTH_FAILURE_MATRIX);
    assert.equal(error.message, reason);
    assert.equal(error.httpStatus, policy.httpStatus);
    assert.equal(error.retryable, policy.retryable);
  }
});
