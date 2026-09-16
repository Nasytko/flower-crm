import type { AddressSuggestionDto } from '@erp/shared';
import { apiFetch } from './client';

export async function suggestAddress(q: string, limit = 6): Promise<AddressSuggestionDto[]> {
  const query = new URLSearchParams({ q, limit: String(limit) });
  return apiFetch(`/api/v1/address/suggest?${query}`);
}
