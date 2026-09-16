import type { SystemSettingsDto } from '@erp/shared';
import { apiFetch } from './client';

export async function getSystemSettings(): Promise<SystemSettingsDto> {
  return apiFetch('/api/v1/settings/system');
}
