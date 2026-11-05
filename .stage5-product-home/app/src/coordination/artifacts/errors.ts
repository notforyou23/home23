export type ArtifactErrorCode =
  | "artifact_id_conflict"
  | "digest_mismatch"
  | "identity_context_mismatch"
  | "invalid_artifact_id"
  | "invalid_content_type"
  | "invalid_digest"
  | "invalid_filename"
  | "invalid_link"
  | "not_found"
  | "range_invalid"
  | "scope_denied"
  | "size_limit_exceeded"
  | "storage_integrity"
  | "storage_conflict"
  | "storage_unavailable";

const ERROR_POLICY: Readonly<Record<ArtifactErrorCode, {
  httpStatus: number;
  retryable: boolean;
}>> = Object.freeze({
  artifact_id_conflict: { httpStatus: 409, retryable: false },
  digest_mismatch: { httpStatus: 422, retryable: false },
  identity_context_mismatch: { httpStatus: 403, retryable: false },
  invalid_artifact_id: { httpStatus: 400, retryable: false },
  invalid_content_type: { httpStatus: 415, retryable: false },
  invalid_digest: { httpStatus: 400, retryable: false },
  invalid_filename: { httpStatus: 400, retryable: false },
  invalid_link: { httpStatus: 422, retryable: false },
  not_found: { httpStatus: 404, retryable: false },
  range_invalid: { httpStatus: 416, retryable: false },
  scope_denied: { httpStatus: 403, retryable: false },
  size_limit_exceeded: { httpStatus: 413, retryable: false },
  storage_integrity: { httpStatus: 500, retryable: false },
  storage_conflict: { httpStatus: 409, retryable: true },
  storage_unavailable: { httpStatus: 503, retryable: true },
});

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(code: ArtifactErrorCode) {
    super(code);
    this.name = "ArtifactError";
    this.code = code;
    this.httpStatus = ERROR_POLICY[code].httpStatus;
    this.retryable = ERROR_POLICY[code].retryable;
  }
}
