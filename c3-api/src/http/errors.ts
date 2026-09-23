/*
 * Typed HTTP errors with one JSON envelope.
 *
 * A handler throws one of these; the router turns it into a response. An
 * error the handler did not anticipate becomes a sanitized 500 instead of the
 * message it carried, so an upstream body, a D1 error, or a secret cannot
 * reach a client through an unhandled throw.
 */
type ApiErrorCode = (
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'REGISTRY_NOT_ACTIVE'
  | 'REGISTRY_VERSION_CHANGED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL'
);

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST:              400,
  UNAUTHORIZED:             401,
  FORBIDDEN:                403,
  NOT_FOUND:                404,
  METHOD_NOT_ALLOWED:       405,
  CONFLICT:                 409,
  UNPROCESSABLE:            422,
  RATE_LIMITED:             429,
  REGISTRY_NOT_ACTIVE:      503,
  REGISTRY_VERSION_CHANGED: 409,
  UPSTREAM_UNAVAILABLE:     503,
  INTERNAL:                 500,
};

class ApiError extends Error {
  readonly code:    ApiErrorCode;
  readonly status:  number;
  readonly details: Record<string, unknown> | undefined;
  /*
   * Headers the response must carry for this error to mean what it says. A
   * 405 without `Allow` tells a client the verb is wrong but not which verb
   * is right, which is half an answer.
   */
  readonly headers: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name    = 'ApiError';
    this.code    = code;
    this.status  = STATUS[code];
    this.details = details;
    this.headers = headers;
  }
}

/*
 * The answer to a request that addressed a real route with the wrong verb.
 */
function methodNotAllowed(method: string, pathname: string, allowed: string[]): ApiError {
  const allow = allowed.join(', ');
  return new ApiError(
    'METHOD_NOT_ALLOWED',
    `${method} is not allowed on ${pathname}`,
    { allowed },
    { 'Allow': allow },
  );
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/*
 * The error envelope. `requestId` lets an operator correlate a client report
 * with the logs; `details` appears only when a handler chose to explain the
 * failure, never from an error it did not construct.
 */
function errorBody(error: ApiError, requestId: string): Record<string, unknown> {
  return {
    error: {
      code:      error.code,
      message:   error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export type { ApiErrorCode };
export { ApiError, STATUS, errorBody, isApiError, methodNotAllowed };
