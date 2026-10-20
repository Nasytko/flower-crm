import type { ProductAttrKind, ProductAttributeValueDto } from '@erp/shared';
import { apiFetch } from './client';

export async function listProductAttributes(params: {
  kind: ProductAttrKind;
  parentId?: string;
  search?: string;
  limit?: number;
}): Promise<ProductAttributeValueDto[]> {
  const query = new URLSearchParams();
  query.set('kind', params.kind);
  if (params.parentId) query.set('parentId', params.parentId);
  if (params.search) query.set('search', params.search);
  if (params.limit) query.set('limit', String(params.limit));
  return apiFetch<ProductAttributeValueDto[]>(`/api/v1/product-attributes?${query.toString()}`);
}
