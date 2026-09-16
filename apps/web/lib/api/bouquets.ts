import type { BouquetDetail, BouquetListResult } from '@erp/shared';
import { apiFetch } from './client';

export interface BouquetItemInput {
  productId: string;
  quantity: number;
}

export async function listBouquets(
  params: {
    page?: number;
    limit?: number;
    search?: string;
    isActive?: 'true' | 'false' | 'all';
  } = {},
): Promise<BouquetListResult> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  if (params.search) query.set('search', params.search);
  if (params.isActive) query.set('isActive', params.isActive);
  const qs = query.toString();
  return apiFetch<BouquetListResult>(`/api/v1/bouquets${qs ? `?${qs}` : ''}`);
}

export async function getBouquet(id: string): Promise<BouquetDetail> {
  return apiFetch<BouquetDetail>(`/api/v1/bouquets/${id}`);
}

export async function createBouquet(input: {
  name: string;
  description?: string | null;
  salePrice: string;
  items: BouquetItemInput[];
}): Promise<BouquetDetail> {
  return apiFetch<BouquetDetail>('/api/v1/bouquets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateBouquet(
  id: string,
  input: {
    expectedVersion: number;
    name?: string;
    description?: string | null;
    salePrice?: string;
    items?: BouquetItemInput[];
    isActive?: boolean;
  },
): Promise<BouquetDetail> {
  return apiFetch<BouquetDetail>(`/api/v1/bouquets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
