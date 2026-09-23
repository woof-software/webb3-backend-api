import { ApiError } from './errors.js';

/*
 * Bounded JSON request and response handling.
 *
 * Every administrative body is small, so the reader refuses anything larger
 * rather than buffering whatever a client sends, and it accepts only a JSON
 * object: an array or a bare value is never a valid command.
 */
const MAX_BODY_BYTES = 64 * 1024;

const ENCODER = new TextEncoder();

async function readJsonObject(
  request: Request,
  { maxBytes = MAX_BODY_BYTES }: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType !== '' && !contentType.split(';')[0]!.trim().endsWith('json')) {
    throw new ApiError('BAD_REQUEST', `the request body must be JSON`);
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError('BAD_REQUEST', `the request body exceeds ${maxBytes} bytes`);
  }

  const body = await request.text();
  if (ENCODER.encode(body).byteLength > maxBytes) {
    throw new ApiError('BAD_REQUEST', `the request body exceeds ${maxBytes} bytes`);
  }
  // an absent body is an empty command, which several admin routes accept
  if (body.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError('BAD_REQUEST', `the request body is not valid JSON`);
  }
  if (typeof(parsed) !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('BAD_REQUEST', `the request body must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number, headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export { MAX_BODY_BYTES, jsonResponse, readJsonObject };
