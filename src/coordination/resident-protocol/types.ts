import type { RESIDENT_PROTOCOL_VERSION } from "./constants.js";

export type ResidentPeerRole = "resident" | "observer" | "operator";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ResidentCredential {
  residentSlug: string;
  role: ResidentPeerRole;
  instanceId: string;
  keyVersion: number;
  key: Buffer;
}

export interface RequestCapability {
  audience: string;
  residentSlug: string;
  role: ResidentPeerRole;
  instanceId: string;
  keyVersion: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  payloadDigest: string;
  signature: string;
}

export interface ResidentRequestFrame {
  kind: "request";
  protocolVersion: typeof RESIDENT_PROTOCOL_VERSION;
  requestId: string;
  correlationId: string;
  method: string;
  path: string;
  deadlineAt: string;
  fence: string | null;
  payload: JsonValue;
  capability: RequestCapability;
}

export interface ResponseCapability {
  audience: string;
  serverInstanceId: string;
  residentSlug: string;
  role: ResidentPeerRole;
  clientInstanceId: string;
  keyVersion: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  payloadDigest: string;
  signature: string;
}

export interface ResidentErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResidentSuccessResponseFrame {
  kind: "response";
  protocolVersion: typeof RESIDENT_PROTOCOL_VERSION;
  requestId: string;
  correlationId: string;
  status: "ok";
  payload: JsonValue;
  capability: ResponseCapability;
}

export interface ResidentErrorResponseFrame {
  kind: "response";
  protocolVersion: typeof RESIDENT_PROTOCOL_VERSION;
  requestId: string;
  correlationId: string;
  status: "error";
  error: ResidentErrorEnvelope;
  capability: ResponseCapability;
}

export type ResidentResponseFrame =
  | ResidentSuccessResponseFrame
  | ResidentErrorResponseFrame;

export type ConsumeNonce = (
  scope: string,
  nonce: string,
  expiresAtMs: number,
) => boolean;
