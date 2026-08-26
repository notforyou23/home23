export {
  AccessTokenVerificationError,
  issueAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type IssueAccessTokenInput,
} from "./access-token.js";
export {
  createOpaqueFamilyId,
  createPairingCodeVerifier,
  createRefreshCredential,
  deriveAuthKey,
  deriveOpaqueId,
  derivePairingCode,
  deriveRefreshCredential,
  digestMutationRequest,
  digestRefreshToken,
  generatePairingCode,
  parseRefreshToken,
  verifyPairingCode,
  type AuthRandomBytes,
  type RefreshCredential,
} from "./crypto.js";
export {
  AUTH_FAILURE_MATRIX,
  AuthError,
  type AuthFailureReasonCode,
} from "./errors.js";
export {
  createAuthService,
  type CreateAuthServiceOptions,
  type AuthAdmissionDecision,
  type AuthAdmissionVerifier,
  type AuthPrincipalContext,
  type PairingIssueResult,
  type PairingSuccessResult,
  type SessionTokenResult,
} from "./service.js";
export { redactAuthDiagnostic } from "./redaction.js";
export { SqliteAuthRepository } from "./sqlite-repository.js";
export {
  createCorsPolicy,
  type CorsEvaluation,
  type CorsEvaluationInput,
  type CorsReasonCode,
} from "./cors-policy.js";
export {
  AUTH_RATE_LIMIT_POLICIES,
  FixedWindowRateLimiter,
  type AuthRateLimitPolicyName,
  type RateLimitResult,
} from "./rate-limit.js";
export {
  AUTH_SCHEMA_DELTA_CANONICAL_JSON,
  AUTH_SCHEMA_DELTA_PROPOSAL,
  AUTH_SCHEMA_DELTA_SHA256,
  computeAuthSchemaDeltaDigest,
} from "./schema-delta.js";
export * from "./types.js";
