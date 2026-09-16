import type { SupplyDetail, SupplyListResult, SupplyStatus } from '@erp/shared';
import { apiFetch } from './client';

export interface SupplyItemInput {
  productId: string;
  quantity: number;
  unitPurchasePrice: string;
}

export async function listSupplies(
  params: { page?: number; limit?: number } = {},
): Promise<SupplyListResult> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<SupplyListResult>(`/api/v1/supplies${qs ? `?${qs}` : ''}`);
}

export async function getSupply(id: string): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}`);
}

export async function createSupply(input: {
  documentDate: string;
  supplierId: string;
  paymentDueDate?: string | null;
  comment?: string | null;
  items: SupplyItemInput[];
}): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>('/api/v1/supplies', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateSupply(
  id: string,
  input: Partial<{
    documentDate: string;
    supplierId: string;
    paymentDueDate: string | null;
    comment: string | null;
    items: SupplyItemInput[];
  }>,
): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function postSupply(id: string): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}/post`, { method: 'POST' });
}

export async function correctSupply(id: string, reason: string): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}/correct`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function cancelSupply(id: string, reason: string): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function markSupplyPaid(id: string): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}/mark-paid`, { method: 'POST' });
}

export async function markSupplyUnpaid(id: string): Promise<SupplyDetail> {
  return apiFetch<SupplyDetail>(`/api/v1/supplies/${id}/mark-unpaid`, { method: 'POST' });
}

export type { SupplyStatus };
