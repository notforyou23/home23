export {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_MAX_FRAME_BYTES,
  MAX_CAPABILITY_LIFETIME_MS,
  RESIDENT_PROTOCOL_VERSION,
  SUPPORTED_RESIDENT_PROTOCOL_VERSIONS,
} from "./constants.js";
export {
  ResidentProtocolError,
  type ResidentProtocolErrorCode,
} from "./errors.js";
export { JsonFrameDecoder, encodeJsonFrame } from "./framing.js";
export {
  createResidentCredential,
  createSignedErrorResponse,
  createSignedRequest,
  createSignedResponse,
  digestResidentPayload,
  verifySignedRequest,
  verifySignedResponse,
} from "./authentication.js";
export type {
  ConsumeNonce,
  JsonPrimitive,
  JsonValue,
  RequestCapability,
  ResidentCredential,
  ResidentErrorEnvelope,
  ResidentErrorResponseFrame,
  ResidentPeerRole,
  ResidentRequestFrame,
  ResidentResponseFrame,
  ResidentSuccessResponseFrame,
  ResponseCapability,
} from "./types.js";
