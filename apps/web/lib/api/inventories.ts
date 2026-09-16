import type {
  ActiveInventoryInfo,
  InventoryDetail,
  InventoryItemDto,
  InventoryListResult,
} from '@erp/shared';
import { apiFetch } from './client';

export async function listInventories(
  params: { page?: number; limit?: number } = {},
): Promise<InventoryListResult> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<InventoryListResult>(`/api/v1/inventories${qs ? `?${qs}` : ''}`);
}

export async function getActiveInventory(): Promise<ActiveInventoryInfo | null> {
  return apiFetch<ActiveInventoryInfo | null>('/api/v1/inventories/active');
}

export async function getInventory(id: string): Promise<InventoryDetail> {
  return apiFetch<InventoryDetail>(`/api/v1/inventories/${id}`);
}

export async function createInventory(input: {
  comment?: string | null;
}): Promise<InventoryDetail> {
  return apiFetch<InventoryDetail>('/api/v1/inventories', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function startNewInventory(input: {
  comment?: string | null;
}): Promise<InventoryDetail> {
  return apiFetch<InventoryDetail>('/api/v1/inventories/start-new', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function startInventory(id: string): Promise<InventoryDetail> {
  return apiFetch<InventoryDetail>(`/api/v1/inventories/${id}/start`, { method: 'POST' });
}

export async function updateInventoryItem(
  inventoryId: string,
  itemId: string,
  countedQuantity: number,
): Promise<InventoryItemDto> {
  return apiFetch<InventoryItemDto>(`/api/v1/inventories/${inventoryId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ countedQuantity }),
  });
}

export async function completeInventory(id: string): Promise<InventoryDetail> {
  return apiFetch<InventoryDetail>(`/api/v1/inventories/${id}/complete`, { method: 'POST' });
}

export async function cancelInventory(
  id: string,
  reason?: string | null,
): Promise<InventoryDetail> {
  return apiFetch<InventoryDetail>(`/api/v1/inventories/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason ?? null }),
  });
}
