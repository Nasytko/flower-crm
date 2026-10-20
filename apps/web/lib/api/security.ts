import type {
  DeviceAccessMode,
  EmployeePinStatusDto,
  PinCandidateDto,
  SecurityPolicyDto,
  TrustedDeviceDto,
  WorkSessionStatusDto,
} from '@erp/shared';
import { apiFetch } from './client';

export function getSecurityPolicy(): Promise<SecurityPolicyDto> {
  return apiFetch('/api/v1/security/policy');
}

export function updateSecurityPolicy(
  patch: Partial<SecurityPolicyDto>,
): Promise<SecurityPolicyDto> {
  return apiFetch('/api/v1/security/policy', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function listTrustedDevices(): Promise<TrustedDeviceDto[]> {
  return apiFetch('/api/v1/security/devices');
}

export function trustCurrentDevice(input: {
  name: string;
  accessMode: DeviceAccessMode;
  allowedUserIds?: string[];
  trustDays?: number;
}): Promise<TrustedDeviceDto> {
  return apiFetch('/api/v1/security/devices/trust-current', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateTrustedDevice(
  id: string,
  input: {
    name?: string;
    accessMode?: DeviceAccessMode;
    allowedUserIds?: string[];
  },
): Promise<TrustedDeviceDto> {
  return apiFetch(`/api/v1/security/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function extendTrustedDevice(id: string, trustDays?: number): Promise<TrustedDeviceDto> {
  return apiFetch(`/api/v1/security/devices/${id}/extend`, {
    method: 'POST',
    body: JSON.stringify({ trustDays }),
  });
}

export function revokeTrustedDevice(id: string): Promise<void> {
  return apiFetch(`/api/v1/security/devices/${id}`, { method: 'DELETE' });
}

export function forceLockDevice(id: string): Promise<void> {
  return apiFetch(`/api/v1/security/devices/${id}/force-lock`, { method: 'POST' });
}

export function getWorkstationStatus(): Promise<WorkSessionStatusDto> {
  return apiFetch('/api/v1/auth/workstation/status');
}

export function openWorkSession(): Promise<WorkSessionStatusDto> {
  return apiFetch('/api/v1/auth/work-session/open', { method: 'POST' });
}

export function closeWorkSession(): Promise<void> {
  return apiFetch('/api/v1/auth/work-session/close', { method: 'POST' });
}

export function lockWorkstation(): Promise<void> {
  return apiFetch('/api/v1/auth/workstation/lock', { method: 'POST' });
}

export function recordUserActivity(): Promise<{ shouldLock: boolean }> {
  return apiFetch('/api/v1/auth/workstation/activity', { method: 'POST' });
}

export function listPinCandidates(): Promise<PinCandidateDto[]> {
  return apiFetch('/api/v1/auth/pin/candidates');
}

export function unlockWithPin(input: {
  userId: string;
  pin: string;
}): Promise<{ accessToken: string; expiresIn: number; user: import('@erp/shared').AuthUser }> {
  return apiFetch('/api/v1/auth/pin/unlock', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function stepUpPassword(password: string): Promise<{ elevatedUntil: string }> {
  return apiFetch('/api/v1/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function getEmployeePin(id: string): Promise<EmployeePinStatusDto> {
  return apiFetch(`/api/v1/employees/${id}/pin`);
}

export function enableEmployeePin(id: string): Promise<EmployeePinStatusDto> {
  return apiFetch(`/api/v1/employees/${id}/pin/enable`, { method: 'POST' });
}

export function disableEmployeePin(id: string): Promise<EmployeePinStatusDto> {
  return apiFetch(`/api/v1/employees/${id}/pin/disable`, { method: 'POST' });
}

export function generateEmployeePin(
  id: string,
): Promise<EmployeePinStatusDto & { pinPlaintext: string }> {
  return apiFetch(`/api/v1/employees/${id}/pin/generate`, { method: 'POST' });
}

export function revokeEmployeePinSessions(id: string): Promise<{ revoked: number }> {
  return apiFetch(`/api/v1/employees/${id}/pin/revoke-sessions`, { method: 'POST' });
}
