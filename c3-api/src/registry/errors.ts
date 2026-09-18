/*
 * Registry ingestion errors. A code classifies the failure for validation
 * results and sync diagnostics; the message is safe to persist and to return
 * to an authenticated admin, so it never carries a token, a raw upstream
 * body, or a full response.
 */
type RegistryErrorCode = (
  // configuration or requested source is unusable
  | 'SOURCE_CONFIGURATION_INVALID'
  | 'SOURCE_REF_UNRESOLVED'
  | 'SOURCE_COMMIT_UNREACHABLE'
  // upstream responded, but the response cannot be trusted
  | 'SOURCE_REQUEST_FAILED'
  | 'SOURCE_RESPONSE_INVALID'
  | 'SOURCE_TREE_TRUNCATED'
  | 'SOURCE_CONTENT_TOO_LARGE'
  | 'SOURCE_BLOB_MISMATCH'
  // the pinned content does not describe a registry we can import
  | 'ROOT_PATH_INVALID'
  | 'ROOT_NETWORK_UNSUPPORTED'
  | 'ROOT_DOCUMENT_INVALID'
  | 'ROOT_DUPLICATE'
  // on-chain enrichment could not read what the source declares
  | 'CHAIN_REQUEST_FAILED'
  | 'CHAIN_RESPONSE_INVALID'
  | 'CHAIN_CALL_REVERTED'
  | 'CHAIN_CONTRACT_MISSING'
  | 'CHAIN_MISMATCH'
  // the reviewed overlay is unusable
  | 'OVERLAY_INVALID'
  | 'OVERLAY_MISSING'
  | 'OVERLAY_FEED_UNREADABLE'
  // the stored candidate is not in the state the caller expected
  | 'CANDIDATE_STATE_CONFLICT'
  // the sync fence refused the work
  | 'SYNC_ALREADY_RUNNING'
  | 'SYNC_FENCE_INCONSISTENT'
);

class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly scope: string;

  /*
   * `scope` names what the failure is about, such as a root path or a
   * network key, and matches the scope recorded in validation_results.
   */
  constructor(code: RegistryErrorCode, message: string, scope: string = 'global') {
    super(message);
    this.name  = 'RegistryError';
    this.code  = code;
    this.scope = scope;
  }
}

function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}

export type { RegistryErrorCode };
export { RegistryError, isRegistryError };
