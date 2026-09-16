import type { ApiErrorBody, LoginResponse } from '@erp/shared';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiClientError';
  }
}

type TokenGetter = () => string | null;
type TokenSetter = (token: string | null) => void;
type UnauthorizedHandler = () => void;

let getAccessToken: TokenGetter = () => null;
let setAccessToken: TokenSetter = () => undefined;
let onUnauthorized: UnauthorizedHandler = () => undefined;

/** Single-flight refresh: rotating refresh cookies must not be requested concurrently. */
let refreshPromise: Promise<LoginResponse | null> | null = null;

export function configureApiClient(options: {
  getAccessToken: TokenGetter;
  setAccessToken: TokenSetter;
  onUnauthorized: UnauthorizedHandler;
}): void {
  getAccessToken = options.getAccessToken;
  setAccessToken = options.setAccessToken;
  onUnauthorized = options.onUnauthorized;
}

async function parseError(response: Response): Promise<ApiClientError> {
  let body: ApiErrorBody = {
    code: 'REQUEST_ERROR',
    message: `HTTP ${response.status}`,
    details: {},
  };

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // keep fallback
  }

  return new ApiClientError(response.status, body);
}

/**
 * Shared session refresh used by AuthProvider bootstrap and 401 retry.
 * Concurrent callers await the same promise so React Strict Mode remounts
 * do not rotate the refresh cookie twice and kick the user to login.
 */
export async function refreshSession(): Promise<LoginResponse | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as LoginResponse;
      setAccessToken(payload.accessToken);
      return payload;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

async function refreshAccessToken(): Promise<string | null> {
  const payload = await refreshSession();
  return payload?.accessToken ?? null;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const token = getAccessToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && retry && !path.startsWith('/api/v1/auth/login')) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, init, false);
    }
    onUnauthorized();
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return null as T;
  }
  return JSON.parse(text) as T;
}

export { API_BASE };
