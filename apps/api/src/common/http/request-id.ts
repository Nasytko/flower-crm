import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = 'x-request-id';

export function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === 'string' && REQUEST_ID_PATTERN.test(headerValue)) {
    return headerValue;
  }

  if (Array.isArray(headerValue)) {
    const candidate = headerValue[0];
    if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  return randomUUID();
}
