import type { AuthUser, LoginResponse } from '@erp/shared';
import { apiFetch, refreshSession, ApiClientError } from './client';

export async function loginRequest(login: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login, password }),
  });
}

export async function fetchMe(): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/v1/auth/me');
}

export async function logoutRequest(): Promise<void> {
  await apiFetch<void>('/api/v1/auth/logout', { method: 'POST' });
}

export async function refreshRequest(): Promise<LoginResponse> {
  const payload = await refreshSession();
  if (!payload) {
    throw new ApiClientError(401, {
      code: 'UNAUTHORIZED',
      message: 'Session expired',
      details: {},
    });
  }
  return payload;
}
