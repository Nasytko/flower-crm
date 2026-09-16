import type {
  SupplierListItem,
  SupplierListResult,
} from '@erp/shared';
import { apiFetch } from './client';

export async function listSuppliers(
  params: { page?: number; limit?: number; search?: string; isActive?: string } = {},
): Promise<SupplierListResult> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  if (params.search) query.set('search', params.search);
  if (params.isActive) query.set('isActive', params.isActive);
  const qs = query.toString();
  return apiFetch<SupplierListResult>(`/api/v1/suppliers${qs ? `?${qs}` : ''}`);
}

export async function listSupplierOptions(): Promise<Array<{ id: string; name: string }>> {
  return apiFetch('/api/v1/suppliers/options');
}

export async function createSupplier(input: {
  name: string;
  phone?: string | null;
  comment?: string | null;
}): Promise<SupplierListItem> {
  return apiFetch('/api/v1/suppliers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateSupplier(
  id: string,
  input: Partial<{
    name: string;
    phone: string | null;
    comment: string | null;
    isActive: boolean;
  }>,
): Promise<SupplierListItem> {
  return apiFetch(`/api/v1/suppliers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
