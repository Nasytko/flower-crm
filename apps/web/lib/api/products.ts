import type {
  ProductListItem,
  ProductListResult,
  ProductType,
  StockMovementListResult,
  StockWriteOffResult,
  Unit,
} from '@erp/shared';
import { apiFetch } from './client';

export interface ProductListParams {
  search?: string;
  type?: ProductType | '';
  isActive?: 'true' | 'false' | 'all';
  page?: number;
  limit?: number;
}

export async function listProducts(params: ProductListParams = {}): Promise<ProductListResult> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.type) query.set('type', params.type);
  if (params.isActive) query.set('isActive', params.isActive);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<ProductListResult>(`/api/v1/products${qs ? `?${qs}` : ''}`);
}

export async function getProduct(id: string): Promise<ProductListItem> {
  return apiFetch<ProductListItem>(`/api/v1/products/${id}`);
}

export async function createProduct(input: {
  name: string;
  sku?: string | null;
  type: ProductType;
  description?: string | null;
  unit: Unit;
  purchasePrice?: string | null;
  salePrice?: string | null;
}): Promise<ProductListItem> {
  return apiFetch<ProductListItem>('/api/v1/products', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateProduct(
  id: string,
  input: Partial<{
    name: string;
    sku: string | null;
    description: string | null;
    purchasePrice: string | null;
    salePrice: string | null;
    isActive: boolean;
  }>,
): Promise<ProductListItem> {
  return apiFetch<ProductListItem>(`/api/v1/products/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function writeOffStock(
  id: string,
  input: { quantity: number; reason: string },
): Promise<StockWriteOffResult> {
  return apiFetch<StockWriteOffResult>(`/api/v1/products/${id}/stock/write-off`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listStockMovements(
  id: string,
  params: { page?: number; limit?: number } = {},
): Promise<StockMovementListResult> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<StockMovementListResult>(
    `/api/v1/products/${id}/stock/movements${qs ? `?${qs}` : ''}`,
  );
}
